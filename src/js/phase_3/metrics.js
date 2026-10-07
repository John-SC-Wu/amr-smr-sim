import { TASK_TYPES } from "./tasks.js";

// robot state shown in the timeline and the time-allocation bars
export const STATES = {
  work: { label: "執行任務", short: "任務", token: "--st-work" },
  wait: { label: "等待（電梯／通行區／人員）", short: "等待", token: "--st-wait" },
  charge: { label: "充電", short: "充電", token: "--st-charge" },
  idle: { label: "待命・回停靠點", short: "待命", token: "--st-idle" },
  fault: { label: "故障", short: "故障", token: "--st-fault" },
};
export const STATE_ORDER = ["work", "wait", "charge", "idle", "fault"];

export function robotState(r) {
  if (r.fault) return "fault";
  if (r.onCharger) return "charge";
  if (r.waitInfo) return "wait";
  if (r.task) return "work";
  return "idle";
}

function segLabel(r, st) {
  if (st === "work") return `${r.task.id} ${TASK_TYPES[r.task.type].name}`;
  if (st === "wait") return r.waitInfo.label;
  if (st === "charge") return r.parked ? `${r.parked.name}` : "充電";
  if (st === "fault") return "故障・等待人員協助";
  return r.parked ? `待命・${r.parked.name}` : "回停靠點／移動";
}

// --- what happened, when: drives the timeline, the live charts and the strategy lab ---
export class Metrics {
  constructor(fleet) {
    this.fleet = fleet;
    this.reset();
  }

  reset() {
    this.t0 = this.fleet.sim.time;
    this.samples = [];
    this.segs = new Map();
    this.events = [];
    this.records = [];
    this.created = [];
    this.lastSample = -1e9;
  }

  get sim() {
    return this.fleet.sim;
  }

  // once per simulated second
  tick() {
    const t = this.sim.time;
    const f = this.fleet;
    for (const r of f.robots) {
      const st = robotState(r);
      const key = st === "work" ? `work:${r.task.id}` : st;
      let list = this.segs.get(r.id);
      if (!list) this.segs.set(r.id, (list = []));
      const last = list[list.length - 1];
      if (last && last.key === key) {
        last.b = t;
        continue;
      }
      if (last) last.b = t;
      list.push({ key, st, a: t, b: t, task: r.task ? r.task.id : null, type: r.task ? r.task.type : null, label: segLabel(r, st) });
      if (list.length > 3000) list.shift();
    }
    if (t - this.lastSample >= 15) {
      this.lastSample = t;
      this.samples.push({
        t,
        clock: this.sim.clock,
        queue: f.tasks.filter((x) => x.state === "queued").length,
        lift: f.lift.tickets.filter((x) => !x.cancelled && !x.boarded).length,
        battery: f.robots.map((r) => r.battery),
        working: f.robots.filter((r) => robotState(r) === "work").length,
      });
      if (this.samples.length > 2000) this.samples.shift();
    }
  }

  event(kind, robot, text) {
    this.events.push({ t: this.sim.time, clock: this.sim.clock, kind, robot: robot ? robot.id : null, text });
    if (this.events.length > 600) this.events.shift();
  }

  taskCreated(task) {
    this.created.push(task);
  }

  taskDone(task, robot) {
    this.records.push({
      id: task.id,
      type: task.type,
      priority: task.priority,
      created: task.createdAt,
      started: task.startedAt ?? null,
      done: task.doneAt,
      delivered: task.deliveredAt ?? null,
      robot: robot ? robot.id : null,
      handovers: task.handovers || 0,
    });
  }

  // seconds spent per state by each robot inside [from, to]
  allocation(from = this.t0, to = this.sim.time) {
    const out = {};
    for (const r of this.fleet.robots) {
      const acc = { work: 0, wait: 0, charge: 0, idle: 0, fault: 0 };
      for (const s of this.segs.get(r.id) || []) {
        const a = Math.max(from, s.a);
        const b = Math.min(to, s.b);
        if (b > a) acc[s.st] += b - a;
      }
      out[r.id] = acc;
    }
    return out;
  }

  // headline numbers for one run (strategy lab)
  summary() {
    const f = this.fleet;
    const k = f.kpi;
    const span = Math.max(1, this.sim.time - this.t0);
    const alloc = this.allocation();
    let work = 0;
    let wait = 0;
    for (const a of Object.values(alloc)) {
      work += a.work;
      wait += a.wait;
    }
    const now = this.sim.time;
    const mean = (xs) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : null);
    // waiting counts until a robot starts the job; jobs still waiting at the end count up to now
    const own = this.created.filter((t) => t.state !== "merged" && t.state !== "merged-done");
    const waits = own.map((t) => ((t.startedAt ?? now) - t.createdAt) / 60);
    // urgent orders: created -> handed to the nurse; one still on its way counts up to now,
    // unless it came in during the last minutes (no strategy could have delivered it yet)
    const stat = this.created.filter((t) => t.urgent && (t.deliveredAt !== undefined || now - t.createdAt > 8 * 60));
    const p1 = stat.map((t) => ((t.deliveredAt ?? now) - t.createdAt) / 60);
    return {
      robots: f.robots.length,
      minutes: span / 60,
      done: k.done,
      created: this.created.length,
      avgWaitMin: mean(waits) ?? 0,
      maxWaitMin: waits.length ? Math.max(...waits) : 0,
      p1Min: mean(p1),
      p1Max: p1.length ? Math.max(...p1) : null,
      p1Count: stat.length,
      p1Late: stat.filter((t) => t.deliveredAt === undefined).length,
      liftWaitS: f.lift.stats.rides ? f.lift.stats.waitSum / f.lift.stats.rides : 0,
      rides: f.lift.stats.rides,
      km: f.robots.reduce((s, r) => s + r.odometer, 0) / 1000,
      utilization: work / (span * f.robots.length),
      waitShare: wait / (span * f.robots.length),
      preemptions: k.preemptions,
      handovers: k.handovers,
      faults: k.faults || 0,
      merged: k.merged,
      nurseMin: k.minutes,
      queued: f.tasks.filter((x) => x.state === "queued").length,
      queueSeries: this.samples.map((s) => [Math.round(s.clock), s.queue]),
    };
  }
}
