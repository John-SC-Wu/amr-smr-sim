import { FLOORS } from "./config.js";
import { DEFAULTS } from "./settings.js";
import { muteEvents } from "./sim.js";
import { buildWorld, stepWorld } from "./world.js";

const at = (h, m) => h * 3600 + m * 60;
const STEP = 0.05; // same fixed step as the page

// --- one scripted morning, shared by the guided tour and the strategy lab ---
// the routine schedule (rounds, ward orders, patrols) runs as usual; these events come on top
export const SCENARIO = {
  end: at(9, 0),
  events: [
    { at: at(8, 6), kind: "stat", floor: 3, label: "緊急用藥 4F" },
    { at: at(8, 14), kind: "peak", label: "三個樓層同時配送" },
    { at: at(8, 22), kind: "fault", label: "機器人故障" },
    { at: at(8, 32), kind: "outage", seconds: 300, label: "電梯停用 5 分鐘" },
    { at: at(8, 44), kind: "stat", floor: 2, label: "緊急用藥 3F" },
  ],
};
// three different mornings (order times, destinations, who reads high); results are averaged
export const LAB_SEEDS = [1, 2, 3];

export function applyEvent(fleet, e) {
  if (e.kind === "stat") return fleet.addDelivery({ floor: e.floor, priority: 1, by: `${FLOORS[e.floor].id} 護理師・醫囑緊急用藥` });
  if (e.kind === "peak") return fleet.quickAdd("peak");
  if (e.kind === "fault") return fleet.injectFault();
  if (e.kind === "outage") return fleet.elevatorOutage(e.seconds);
  return null;
}

export function scenarioScript(events = SCENARIO.events, onEvent = null) {
  return events.map((e) => ({
    at: e.at,
    run: (fleet) => {
      const res = applyEvent(fleet, e);
      if (onEvent) onEvent(e, res);
    },
  }));
}

// --- experiment configurations; each one runs once per seed ---
export const STRATEGY_KEYS = ["weighted", "nearest", "zone", "roundrobin"];
export const FLEET_SIZES = [1, 2, 3, 4, 5];
const calm = (e) => e.kind !== "fault" && e.kind !== "outage";
export const CONFIGS = [
  ...FLEET_SIZES.map((n) => ({ key: `n${n}`, group: "fleet", robots: n, strategy: "weighted" })),
  ...STRATEGY_KEYS.filter((s) => s !== "weighted").map((s) => ({ key: `s-${s}`, group: "strategy", robots: 3, strategy: s })),
  { key: "m-nobatch", group: "mechanism", robots: 3, strategy: "weighted", base: { batching: false } },
  { key: "m-nopreempt", group: "mechanism", robots: 2, strategy: "weighted", base: { preemption: false } },
  { key: "x-calm", group: "exceptions", robots: 3, strategy: "weighted", events: calm },
];
// the 3-robot weighted fleet doubles as the strategy baseline
export const strategyKey = (s) => (s === "weighted" ? "n3" : `s-${s}`);

const KPIS = ["done", "created", "avgWaitMin", "maxWaitMin", "p1Min", "p1Max", "p1Count", "p1Late", "liftWaitS", "rides", "km", "utilization", "waitShare", "preemptions", "handovers", "merged", "nurseMin", "queued"];

// numbers kept from one simulated morning
function collect(w) {
  const f = w.fleet;
  const m = f.metrics;
  const s = m.summary();
  const alloc = m.allocation();
  const out = {};
  for (const k of KPIS) out[k] = s[k];
  out.series = m.samples.map((x) => [Math.round(x.clock), x.queue, x.lift, x.working]);
  out.events = m.events.filter((e) => e.kind === "fault" || e.kind === "recover" || e.kind === "outage" || e.kind === "outage-end" || e.kind === "p1").map((e) => [Math.round(e.clock), e.kind, e.robot]);
  out.alloc = f.robots.map((r) => {
    const a = alloc[r.id];
    return { id: r.id, work: a.work, wait: a.wait, charge: a.charge, idle: a.idle, fault: a.fault };
  });
  return out;
}

// mean / min / max over the seeds; the time series and per-robot time are averaged
function aggregate(cfg, runs) {
  const mean = {};
  const min = {};
  const max = {};
  for (const k of KPIS) {
    const xs = runs.map((r) => r[k]).filter((v) => v !== null && v !== undefined);
    mean[k] = xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
    min[k] = xs.length ? Math.min(...xs) : null;
    max[k] = xs.length ? Math.max(...xs) : null;
  }
  const len = Math.min(...runs.map((r) => r.series.length));
  const series = [];
  for (let i = 0; i < len; i++) {
    const avg = (j) => +(runs.reduce((a, r) => a + r.series[i][j], 0) / runs.length).toFixed(2);
    series.push([runs[0].series[i][0], avg(1), avg(2), avg(3)]);
  }
  const alloc = runs[0].alloc.map((a, i) => {
    const o = { id: a.id };
    for (const st of ["work", "wait", "charge", "idle", "fault"]) o[st] = Math.round(runs.reduce((s, r) => s + r.alloc[i][st], 0) / runs.length);
    return o;
  });
  const round = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, v === null ? null : +v.toFixed(3)]));
  return {
    key: cfg.key,
    group: cfg.group,
    robots: cfg.robots,
    strategy: cfg.strategy,
    base: cfg.base || null,
    mean: round(mean),
    min: round(min),
    max: round(max),
    perSeed: runs.map((r) => ({ p1Min: r.p1Min, avgWaitMin: r.avgWaitMin, done: r.done })),
    series,
    alloc,
    events: runs[0].events,
  };
}

// hand control back to the page between chunks (a message is not throttled like setTimeout)
let channel = null;
const waiting = [];
function nextFrame() {
  return new Promise((r) => {
    if (typeof MessageChannel !== "function") return setTimeout(r, 0);
    if (!channel) {
      channel = new MessageChannel();
      channel.port1.onmessage = () => waiting.shift()?.();
    }
    waiting.push(r);
    channel.port2.postMessage(0);
  });
}
function closeChannel() {
  if (!channel) return;
  channel.port1.close();
  channel = null;
}

async function simulate(w, end, onStep, shouldStop) {
  const sim = w.sim;
  const t0 = sim.clock;
  let n = 0;
  while (sim.clock < end) {
    stepWorld(w, STEP);
    // let the robots' scripts react within the step they were woken in
    for (let i = 0; i < 24; i++) await null;
    if (++n % 400 === 0) {
      onStep((sim.clock - t0) / (end - t0));
      await nextFrame();
      if (shouldStop()) return false;
    }
  }
  return true;
}

// one simulated morning in an invisible world of its own; the visible demo is untouched
export async function runOne({ base = DEFAULTS, robots, strategy, seed, events = SCENARIO.events, end = SCENARIO.end, onProgress = () => {}, shouldStop = () => false }) {
  const settings = { ...DEFAULTS, ...base, robots, strategy, seed };
  const w = buildWorld({ settings, headless: true });
  w.fleet.start({ seed, script: scenarioScript(events) });
  const ok = await simulate(w, end, onProgress, shouldStop);
  w.fleet.token.cancel();
  w.sim.process();
  return ok ? collect(w) : null;
}

const SETTING_KEYS = Object.keys(DEFAULTS).filter((k) => k !== "robots" && k !== "strategy" && k !== "seed");

// every configuration x every seed; progress is reported per run
export async function runLab({ base = DEFAULTS, seeds = LAB_SEEDS, configs = CONFIGS, onProgress = () => {}, shouldStop = () => false } = {}) {
  const started = performance.now();
  const total = configs.length * seeds.length;
  const out = {};
  let done = 0;
  muteEvents(true);
  try {
    for (const cfg of configs) {
      const runs = [];
      for (const seed of seeds) {
        const events = cfg.events ? SCENARIO.events.filter(cfg.events) : SCENARIO.events;
        const res = await runOne({
          base: { ...base, ...(cfg.base || {}) },
          robots: cfg.robots,
          strategy: cfg.strategy,
          seed,
          events,
          onProgress: (p) => onProgress((done + p) / total, cfg, seed),
          shouldStop,
        });
        if (!res) return null;
        runs.push(res);
        done++;
        onProgress(done / total, cfg, seed);
        await nextFrame();
      }
      out[cfg.key] = aggregate(cfg, runs);
    }
  } finally {
    muteEvents(false);
    closeChannel();
  }
  const settings = {};
  for (const k of SETTING_KEYS) settings[k] = base[k] ?? DEFAULTS[k];
  return { version: 1, seeds, end: SCENARIO.end, events: SCENARIO.events, settings, ms: Math.round(performance.now() - started), configs: out };
}
