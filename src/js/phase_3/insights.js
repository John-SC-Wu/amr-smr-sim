import { formatClock } from "./sim.js";
import { STATES, STATE_ORDER } from "./metrics.js";

// --- live charts for the bottom panel: robot timeline (Gantt), battery, queues, time split ---
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const hm = (clock) => formatClock(clock, false);
const mins = (s) => (s < 60 ? `${Math.round(s)} 秒` : s < 3600 ? `${(s / 60).toFixed(1)} 分` : `${(s / 3600).toFixed(1)} 小時`);
const TICKS = [60, 120, 300, 600, 900, 1800, 3600, 7200];

function timeTicks(t0, t1, width, off, minGap = 64) {
  const span = t1 - t0;
  const step = TICKS.find((s) => (s / span) * width >= minGap) || 7200;
  const out = [];
  const c0 = Math.ceil((t0 + off) / step) * step;
  for (let c = c0; c <= t1 + off; c += step) out.push(c - off);
  return out;
}

// one tooltip per chart host; rows are [value, label, colorToken?]
class Tip {
  constructor(host) {
    this.host = host;
    this.el = document.createElement("div");
    this.el.className = "chart-tip";
    this.el.hidden = true;
    this.el.setAttribute("role", "tooltip");
    host.appendChild(this.el);
  }

  show(x, y, title, rows) {
    const el = this.el;
    el.replaceChildren();
    if (title) {
      const h = document.createElement("div");
      h.className = "ct-title";
      h.textContent = title;
      el.appendChild(h);
    }
    for (const [value, label, color] of rows) {
      const row = document.createElement("div");
      row.className = "ct-row";
      if (color) {
        const key = document.createElement("i");
        key.style.background = color;
        row.appendChild(key);
      }
      const b = document.createElement("b");
      b.textContent = value;
      const span = document.createElement("span");
      span.textContent = label;
      row.append(b, span);
      el.appendChild(row);
    }
    el.hidden = false;
    const W = this.host.clientWidth;
    const tw = el.offsetWidth;
    const th = el.offsetHeight;
    let px = x + 14;
    if (px + tw > W - 4) px = x - tw - 14;
    let py = y - th - 8;
    if (py < 2) py = y + 14;
    el.style.transform = `translate(${Math.max(2, Math.round(px))}px, ${Math.round(py)}px)`;
  }

  hide() {
    this.el.hidden = true;
  }
}

function outageBands(events) {
  const bands = [];
  let open = null;
  for (const e of events) {
    if (e.kind === "outage") open = e.t;
    if (e.kind === "outage-end" && open !== null) {
      bands.push([open, e.t]);
      open = null;
    }
  }
  if (open !== null) bands.push([open, Infinity]);
  return bands;
}

const EVENT_LOOK = {
  p1: { label: "P1 緊急插單", shape: "tri", color: "var(--st-fault)" },
  alert: { label: "生理異常通報", shape: "bang", color: "var(--st-fault)" },
  fault: { label: "機器人故障", shape: "x", color: "var(--st-fault)" },
  recover: { label: "故障復歸", shape: "dot", color: "var(--st-charge)" },
  preempt: { label: "安全點交接給 P1", shape: "ring", color: "var(--ink-2)" },
  handover: { label: "任務改派", shape: "ring", color: "var(--ink-2)" },
};

function marker(shape, x, y, color) {
  switch (shape) {
    case "tri":
      return `<path d="M${x} ${y - 5}L${x + 5} ${y + 4}H${x - 5}Z" style="fill:${color}"/>`;
    case "x":
      return `<path d="M${x - 4} ${y - 4}L${x + 4} ${y + 4}M${x + 4} ${y - 4}L${x - 4} ${y + 4}" style="stroke:${color}" stroke-width="2.2" stroke-linecap="round"/>`;
    case "bang":
      return `<circle cx="${x}" cy="${y}" r="5" style="fill:${color}"/><path d="M${x} ${y - 2.6}V${y + 0.6}M${x} ${y + 2.4}v0.1" style="stroke:var(--surface)" stroke-width="1.6" stroke-linecap="round"/>`;
    case "dot":
      return `<circle cx="${x}" cy="${y}" r="4" style="fill:${color}"/>`;
    default:
      return `<circle cx="${x}" cy="${y}" r="4" fill="none" style="stroke:${color}" stroke-width="1.8"/>`;
  }
}

// ------------------------------------------------------------ timeline
export class Timeline {
  constructor(world, host) {
    this.w = world;
    this.host = host;
    this.body = host.querySelector(".tl-body");
    this.range = "30";
    this.items = [];
    this.tip = new Tip(host);
    for (const b of host.querySelectorAll("[data-range]")) {
      b.addEventListener("click", () => {
        this.range = b.dataset.range;
        for (const x of host.querySelectorAll("[data-range]")) x.setAttribute("aria-pressed", String(x === b));
        this.render();
      });
    }
    this.body.addEventListener("pointermove", (e) => this.#hover(e));
    this.body.addEventListener("pointerleave", () => this.tip.hide());
    this.#legend();
  }

  #legend() {
    const ul = this.host.querySelector(".legend");
    const states = STATE_ORDER.map((k) => `<li><i class="sw st-${k}"></i>${esc(STATES[k].short)}</li>`).join("");
    const ev = ["p1", "fault", "handover"]
      .map((k) => {
        const l = EVENT_LOOK[k];
        return `<li><svg class="cs" viewBox="-7 -7 14 14" aria-hidden="true">${marker(l.shape, 0, 0, l.color)}</svg>${esc(l.label)}</li>`;
      })
      .join("");
    ul.innerHTML = `${states}<li><i class="sw band"></i>電梯停用</li>${ev}`;
  }

  render() {
    const W = this.body.clientWidth;
    if (W < 80) return;
    const { sim, fleet } = this.w;
    const m = fleet.metrics;
    const off = sim.clockOffset;
    const now = sim.time;
    const win = this.range === "all" ? Infinity : Number(this.range) * 60;
    let t0 = Math.max(m.t0, now - win);
    const t1 = Math.max(now, t0 + 60);
    if (t1 - t0 < 60) t0 = t1 - 60;
    const robots = fleet.robots;
    const L = 40;
    const R = 10;
    const lane = 20;
    const rowH = 18;
    const gap = 7;
    const axis = 18;
    const H = lane + robots.length * (rowH + gap) + axis;
    const pw = W - L - R;
    const X = (t) => L + ((Math.min(Math.max(t, t0), t1) - t0) / (t1 - t0)) * pw;
    const items = [];
    let svg = "";

    // gridlines + time axis
    for (const t of timeTicks(t0, t1, pw, off)) {
      const x = X(t).toFixed(1);
      svg += `<line class="grid" x1="${x}" x2="${x}" y1="${lane - 4}" y2="${H - axis}"/><text class="tick" x="${x}" y="${H - 4}" text-anchor="middle">${hm(t + off)}</text>`;
    }
    // elevator outages behind everything
    for (const [a, b] of outageBands(m.events)) {
      if (b < t0 || a > t1) continue;
      const x1 = X(a);
      const x2 = X(Math.min(b, t1));
      items.push({ title: "電梯停用", rows: [[`${hm(a + off)}–${b === Infinity ? "進行中" : hm(b + off)}`, "跨樓層任務暫停"]] });
      svg += `<rect class="band" x="${x1.toFixed(1)}" y="${lane - 4}" width="${Math.max(2, x2 - x1).toFixed(1)}" height="${H - axis - lane + 4}" data-k="${items.length - 1}"/>`;
    }
    // robot rows
    robots.forEach((r, i) => {
      const y = lane + i * (rowH + gap);
      svg += `<circle cx="7" cy="${y + rowH / 2}" r="4.5" style="fill:${r.css}"/><text class="rlabel" x="16" y="${y + rowH / 2 + 4}">${esc(r.id)}</text>`;
      svg += `<rect class="track" x="${L}" y="${y}" width="${pw}" height="${rowH}" rx="3"/>`;
      for (const s of m.segs.get(r.id) || []) {
        if (s.b < t0 || s.a > t1 || s.b - s.a < 0.5) continue;
        const x1 = X(s.a);
        const x2 = X(s.b);
        const w = x2 - x1 - (s.b < now - 0.5 ? 2 : 0);
        if (w < 0.6) continue;
        items.push({
          title: `${r.id} · ${STATES[s.st].label}`,
          rows: [[mins(s.b - s.a), `${hm(s.a + off)}–${s.b >= now - 0.5 ? "現在" : hm(s.b + off)}`], ["", s.label]],
        });
        svg += `<rect class="sg st-${s.st}" x="${x1.toFixed(1)}" y="${y}" width="${w.toFixed(1)}" height="${rowH}" rx="3" data-k="${items.length - 1}"/>`;
        if (s.st === "work" && w > 44 && s.task) svg += `<text class="seg-text" x="${(x1 + 5).toFixed(1)}" y="${y + rowH / 2 + 4}">${esc(s.task)}</text>`;
      }
    });
    // what happened, on the lane above the rows
    let lastX = -99;
    for (const e of m.events) {
      const look = EVENT_LOOK[e.kind];
      if (!look || e.t < t0 || e.t > t1) continue;
      let x = X(e.t);
      if (x - lastX < 9) x = lastX + 9;
      lastX = x;
      items.push({ title: look.label, rows: [[hm(e.clock), e.text || ""]] });
      svg += `<g class="ev" data-k="${items.length - 1}">${marker(look.shape, x.toFixed(1), lane / 2 - 1, look.color)}<circle cx="${x.toFixed(1)}" cy="${lane / 2 - 1}" r="10" fill="transparent"/></g>`;
    }
    const xn = X(t1).toFixed(1);
    svg += `<line class="now" x1="${xn}" x2="${xn}" y1="${lane - 6}" y2="${H - axis}"/>`;
    this.items = items;
    this.body.innerHTML = `<svg class="cs" width="${W}" height="${H}" style="width:${W}px;height:${H}px" viewBox="0 0 ${W} ${H}" role="img" aria-label="各機器人狀態時間軸：${esc(hm(t0 + off))} 至 ${esc(hm(t1 + off))}">${svg}</svg>`;
  }

  #hover(e) {
    const el = e.target.closest("[data-k]");
    if (!el) return this.tip.hide();
    const it = this.items[Number(el.dataset.k)];
    if (!it) return this.tip.hide();
    const r = this.host.getBoundingClientRect();
    this.tip.show(e.clientX - r.left, e.clientY - r.top, it.title, it.rows);
  }
}

// ---------------------------------------------------------- live charts
export class LiveCharts {
  constructor(world, host) {
    this.w = world;
    this.host = host;
    this.battery = host.querySelector("#ch-battery .ch-body");
    this.queue = host.querySelector("#ch-queue .ch-body");
    this.alloc = host.querySelector("#ch-alloc .ch-body");
    this.tips = {
      battery: new Tip(host.querySelector("#ch-battery")),
      queue: new Tip(host.querySelector("#ch-queue")),
      alloc: new Tip(host.querySelector("#ch-alloc")),
    };
    this.cross = { battery: null, queue: null };
    for (const key of ["battery", "queue"]) {
      const body = this[key];
      body.addEventListener("pointermove", (e) => this.#crosshair(key, e));
      body.addEventListener("pointerleave", () => {
        this.cross[key] = null;
        this.tips[key].hide();
        this.render();
      });
    }
    this.alloc.addEventListener("pointermove", (e) => {
      const el = e.target.closest("[data-k]");
      const it = el && this.allocItems[Number(el.dataset.k)];
      if (!it) return this.tips.alloc.hide();
      const r = this.alloc.parentElement.getBoundingClientRect();
      this.tips.alloc.show(e.clientX - r.left, e.clientY - r.top, it.title, it.rows);
    });
    this.alloc.addEventListener("pointerleave", () => this.tips.alloc.hide());
    this.allocItems = [];
  }

  render() {
    this.#battery();
    this.#queue();
    this.#alloc();
  }

  #frame(body) {
    const W = body.clientWidth;
    const H = body.clientHeight;
    return W > 60 && H > 40 ? { W, H } : null;
  }

  #window() {
    const { sim, fleet } = this.w;
    const samples = fleet.metrics.samples;
    const t1 = Math.max(sim.time, fleet.metrics.t0 + 120);
    return { samples, t0: fleet.metrics.t0, t1, off: sim.clockOffset };
  }

  #battery() {
    const fr = this.#frame(this.battery);
    if (!fr) return;
    const { W, H } = fr;
    const { samples, t0, t1, off } = this.#window();
    const S = this.w.settings;
    const robots = this.w.fleet.robots;
    const L = 30;
    const R = 46;
    const T = 6;
    const B = 18;
    const pw = W - L - R;
    const ph = H - T - B;
    const X = (t) => L + ((t - t0) / (t1 - t0)) * pw;
    const Y = (v) => T + (1 - v / 100) * ph;
    let svg = "";
    for (const v of [0, 50, 100]) svg += `<line class="grid" x1="${L}" x2="${L + pw}" y1="${Y(v).toFixed(1)}" y2="${Y(v).toFixed(1)}"/><text class="tick" x="${L - 5}" y="${(Y(v) + 3.5).toFixed(1)}" text-anchor="end">${v}</text>`;
    for (const t of timeTicks(t0, t1, pw, off, 70)) svg += `<text class="tick" x="${X(t).toFixed(1)}" y="${H - 4}" text-anchor="middle">${hm(t + off)}</text>`;
    // policy thresholds: hairlines with their names at the right edge
    for (const [v, name] of [[S.resumeBattery, "恢復"], [S.lowBattery, "回充"], [S.criticalBattery, "強制"]]) {
      const y = Y(v).toFixed(1);
      svg += `<line class="thr" x1="${L}" x2="${L + pw}" y1="${y}" y2="${y}"/><text class="thr-label" x="${L + pw + 4}" y="${(+y + 3.5).toFixed(1)}">${name} ${v}%</text>`;
    }
    const now = robots.map((r) => r.battery);
    robots.forEach((r, i) => {
      const pts = samples.filter((s) => s.battery.length > i).map((s) => `${X(s.t).toFixed(1)},${Y(s.battery[i]).toFixed(1)}`);
      pts.push(`${X(t1).toFixed(1)},${Y(now[i]).toFixed(1)}`);
      svg += `<polyline class="line" points="${pts.join(" ")}" style="stroke:${r.css}"/>`;
    });
    // end dots (surface ring) at the current value
    robots.forEach((r, i) => {
      svg += `<circle cx="${X(t1).toFixed(1)}" cy="${Y(now[i]).toFixed(1)}" r="4" style="fill:${r.css};stroke:var(--surface)" stroke-width="2"/>`;
    });
    const c = this.cross.battery;
    if (c && samples.length) {
      const s = this.#nearest(samples, c.t, t1, () => ({ t: t1, battery: now }));
      const x = X(s.t).toFixed(1);
      svg += `<line class="cross" x1="${x}" x2="${x}" y1="${T}" y2="${T + ph}"/>`;
      robots.forEach((r, i) => {
        if (s.battery.length > i) svg += `<circle cx="${x}" cy="${Y(s.battery[i]).toFixed(1)}" r="4" style="fill:${r.css};stroke:var(--surface)" stroke-width="2"/>`;
      });
      const rows = robots.map((r, i) => [`${Math.round(s.battery[i] ?? 0)}%`, r.id, r.css]).sort((a, b) => parseFloat(b[0]) - parseFloat(a[0]));
      this.tips.battery.show(Number(x), c.y, hm(s.t + off), rows);
    }
    this.battery.innerHTML = `<svg class="cs" width="${W}" height="${H}" style="width:${W}px;height:${H}px" viewBox="0 0 ${W} ${H}" role="img" aria-label="各機器人電量走勢">${svg}</svg>`;
    this.bGeom = { L, pw, t0, t1 };
  }

  #queue() {
    const fr = this.#frame(this.queue);
    if (!fr) return;
    const { W, H } = fr;
    const { samples, t0, t1, off } = this.#window();
    const f = this.w.fleet;
    const lift = this.w.lift;
    const nowQ = f.tasks.filter((x) => x.state === "queued").length;
    const nowL = lift.tickets.filter((x) => !x.cancelled && !x.boarded).length;
    const L = 30;
    const R = 10;
    const B = 18;
    const gapY = 16;
    const pw = W - L - R;
    const ph = (H - B - gapY * 2) / 2;
    const X = (t) => L + ((t - t0) / (t1 - t0)) * pw;
    const series = [
      { key: "queue", name: "待派任務", unit: "件", now: nowQ, top: gapY },
      { key: "lift", name: "電梯排隊", unit: "台", now: nowL, top: gapY * 2 + ph },
    ];
    let svg = "";
    const bands = outageBands(f.metrics.events);
    for (const sr of series) {
      const vals = samples.map((s) => s[sr.key]);
      const max = Math.max(2, sr.now, ...vals);
      const top = Math.ceil(max / 2) * 2;
      const Y = (v) => sr.top + (1 - v / top) * ph;
      for (const [a, b] of bands) {
        if (b < t0 || a > t1) continue;
        svg += `<rect class="band" x="${X(Math.max(a, t0)).toFixed(1)}" y="${sr.top}" width="${Math.max(2, X(Math.min(b, t1)) - X(Math.max(a, t0))).toFixed(1)}" height="${ph.toFixed(1)}"/>`;
      }
      svg += `<text class="ch-sub" x="${L}" y="${sr.top - 4}">${sr.name}（${sr.unit}）</text>`;
      for (const v of [0, top]) svg += `<line class="grid" x1="${L}" x2="${L + pw}" y1="${Y(v).toFixed(1)}" y2="${Y(v).toFixed(1)}"/><text class="tick" x="${L - 5}" y="${(Y(v) + 3.5).toFixed(1)}" text-anchor="end">${v}</text>`;
      const pts = samples.map((s) => [X(s.t), Y(s[sr.key])]);
      pts.push([X(t1), Y(sr.now)]);
      // step line: counts change in jumps
      let d = "";
      pts.forEach(([x, y], i) => {
        d += i === 0 ? `M${x.toFixed(1)} ${y.toFixed(1)}` : `H${x.toFixed(1)}V${y.toFixed(1)}`;
      });
      const base = Y(0).toFixed(1);
      svg += `<path class="area" d="${d}V${base}H${pts[0][0].toFixed(1)}Z"/><path class="line ink" d="${d}"/>`;
      svg += `<circle cx="${X(t1).toFixed(1)}" cy="${Y(sr.now).toFixed(1)}" r="4" class="dot-ink"/>`;
      svg += `<text class="end-label" x="${(X(t1) - 7).toFixed(1)}" y="${(Y(sr.now) - 7).toFixed(1)}" text-anchor="end">${sr.now}</text>`;
    }
    for (const t of timeTicks(t0, t1, pw, off, 70)) svg += `<text class="tick" x="${X(t).toFixed(1)}" y="${H - 4}" text-anchor="middle">${hm(t + off)}</text>`;
    const c = this.cross.queue;
    if (c && samples.length) {
      const s = this.#nearest(samples, c.t, t1, () => ({ t: t1, queue: nowQ, lift: nowL }));
      const x = X(s.t).toFixed(1);
      svg += `<line class="cross" x1="${x}" x2="${x}" y1="${gapY}" y2="${H - B}"/>`;
      this.tips.queue.show(Number(x), c.y, hm(s.t + off), [[`${s.queue} 件`, "待派任務"], [`${s.lift} 台`, "電梯排隊"]]);
    }
    this.queue.innerHTML = `<svg class="cs" width="${W}" height="${H}" style="width:${W}px;height:${H}px" viewBox="0 0 ${W} ${H}" role="img" aria-label="待派任務數與電梯排隊數走勢">${svg}</svg>`;
    this.qGeom = { L, pw, t0, t1 };
  }

  #nearest(samples, t, t1, current) {
    if (t >= (samples[samples.length - 1]?.t ?? 0) + 7) return current();
    let best = samples[0];
    for (const s of samples) if (Math.abs(s.t - t) < Math.abs(best.t - t)) best = s;
    return best;
  }

  #crosshair(key, e) {
    const g = key === "battery" ? this.bGeom : this.qGeom;
    if (!g) return;
    const body = this[key];
    const r = body.getBoundingClientRect();
    const px = e.clientX - r.left;
    const t = g.t0 + ((px - g.L) / g.pw) * (g.t1 - g.t0);
    this.cross[key] = { t: Math.min(Math.max(t, g.t0), g.t1), y: e.clientY - r.top };
    if (key === "battery") this.#battery();
    else this.#queue();
  }

  #alloc() {
    const fr = this.#frame(this.alloc);
    if (!fr) return;
    const { W, H } = fr;
    const f = this.w.fleet;
    const robots = f.robots;
    const a = f.metrics.allocation();
    const L = 30;
    const R = 8;
    const pw = W - L - R;
    const bar = Math.min(16, Math.max(9, (H - 8) / robots.length - 8));
    const step = Math.min((H - 4) / Math.max(1, robots.length), bar + 12);
    const items = [];
    let svg = "";
    robots.forEach((r, i) => {
      const y = 4 + i * step;
      const acc = a[r.id];
      const total = STATE_ORDER.reduce((s, k) => s + acc[k], 0) || 1;
      svg += `<circle cx="6" cy="${(y + bar / 2).toFixed(1)}" r="4" style="fill:${r.css}"/><text class="rlabel" x="14" y="${(y + bar / 2 + 4).toFixed(1)}">${esc(r.id)}</text>`;
      let x = L;
      for (const k of STATE_ORDER) {
        const v = acc[k];
        if (v <= 0) continue;
        const w = (v / total) * pw;
        const ww = Math.max(0.5, w - 2);
        items.push({ title: `${r.id} · ${STATES[k].label}`, rows: [[`${Math.round((v / total) * 100)}%`, mins(v)]] });
        svg += `<rect class="sg st-${k}" x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${ww.toFixed(1)}" height="${bar.toFixed(1)}" rx="2" data-k="${items.length - 1}"/>`;
        if (k === "work" && ww > 34) svg += `<text class="seg-text" x="${(x + 5).toFixed(1)}" y="${(y + bar / 2 + 3.8).toFixed(1)}">${Math.round((v / total) * 100)}%</text>`;
        x += w;
      }
    });
    this.allocItems = items;
    this.alloc.innerHTML = `<svg class="cs" width="${W}" height="${H}" style="width:${W}px;height:${H}px" viewBox="0 0 ${W} ${H}" role="img" aria-label="各機器人時間分配">${svg}</svg>`;
  }
}

// legend markup shared by the time-allocation chart and the lab report
export function stateLegend() {
  return STATE_ORDER.map((k) => `<li><i class="sw st-${k}"></i>${esc(STATES[k].short)}</li>`).join("");
}
