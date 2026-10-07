import { LAB_DEFAULTS } from "./labDefaults.js";
import { runLab, CONFIGS, LAB_SEEDS, STRATEGY_KEYS, FLEET_SIZES, strategyKey } from "./lab.js";
import { STRATEGIES } from "./dispatch.js";
import { settings } from "./settings.js";
import { formatClock } from "./sim.js";

// --- strategy lab: the same scripted morning simulated off-screen under different policies ---
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const hm = (clock) => formatClock(clock, false);
const num = (v, d = 1) => (v === null || v === undefined || Number.isNaN(v) ? "—" : Number.isInteger(v) && d < 2 ? String(v) : v.toFixed(d));
const pctTxt = (v) => (v === null || v === undefined ? "—" : `${Math.round(v * 100)}%`);

const METRICS = {
  p1Min: { name: "緊急用藥送達", unit: "分", better: "low", fmt: (v) => num(v), desc: "醫囑建立到護理站簽收" },
  avgWaitMin: { name: "平均等候派工", unit: "分", better: "low", fmt: (v) => num(v), desc: "任務建立到機器人開始執行" },
  done: { name: "完成任務", unit: "件", better: "high", fmt: (v) => num(v), desc: "08:00–09:00 完成的任務數" },
  utilization: { name: "機器人使用率", unit: "%", better: null, fmt: (v) => `${Math.round(v * 100)}`, scale: 100, desc: "執行任務的時間比例" },
  km: { name: "車隊行駛里程", unit: "km", better: "low", fmt: (v) => num(v, 2), desc: "所有機器人合計" },
  rides: { name: "電梯搭乘", unit: "次", better: "low", fmt: (v) => num(v), desc: "每次一台" },
  waitShare: { name: "等待時間占比", unit: "%", better: "low", fmt: (v) => `${Math.round(v * 100)}`, scale: 100, desc: "等電梯、等通行區、等人員" },
};

const EVENT_TEXT = { stat: "緊急用藥", peak: "電梯尖峰", fault: "機器人故障", outage: "電梯停用" };

// one tooltip for the whole report
class Tip {
  constructor(host) {
    this.host = host;
    this.el = document.createElement("div");
    this.el.className = "chart-tip";
    this.el.hidden = true;
    this.el.setAttribute("role", "tooltip");
    host.appendChild(this.el);
  }

  show(clientX, clientY, title, rows) {
    const el = this.el;
    el.replaceChildren();
    const h = document.createElement("div");
    h.className = "ct-title";
    h.textContent = title;
    el.appendChild(h);
    for (const [value, label] of rows) {
      const row = document.createElement("div");
      row.className = "ct-row";
      const b = document.createElement("b");
      b.textContent = value;
      const span = document.createElement("span");
      span.textContent = label;
      row.append(b, span);
      el.appendChild(row);
    }
    el.hidden = false;
    const r = this.host.getBoundingClientRect();
    const x = clientX - r.left + this.host.scrollLeft;
    const y = clientY - r.top + this.host.scrollTop;
    const tw = el.offsetWidth;
    const th = el.offsetHeight;
    let px = x + 14;
    if (px + tw > this.host.clientWidth - 6) px = x - tw - 14;
    let py = y - th - 10;
    if (py < this.host.scrollTop + 4) py = y + 16;
    el.style.transform = `translate(${Math.round(px)}px, ${Math.round(py)}px)`;
  }

  hide() {
    this.el.hidden = true;
  }
}

export class LabView {
  constructor(world) {
    this.w = world;
    this.data = LAB_DEFAULTS;
    this.source = { kind: "default" };
    this.el = $("lab");
    this.body = $("lab-body");
    this.items = [];
    this.tip = new Tip(this.body);
    this.running = false;
    this.stop = false;
    this.table = false;
    this.opener = null;
    $("open-lab").addEventListener("click", () => this.open());
    $("lab-close").addEventListener("click", () => this.close());
    $("lab-backdrop").addEventListener("click", () => this.close());
    this.el.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && !this.running) this.close();
    });
    $("lab-run-quick").addEventListener("click", () => this.rerun([1]));
    $("lab-run-full").addEventListener("click", () => this.rerun(LAB_SEEDS));
    $("lab-cancel").addEventListener("click", () => (this.stop = true));
    $("lab-table").addEventListener("click", () => {
      this.table = !this.table;
      $("lab-table").setAttribute("aria-pressed", String(this.table));
      this.render();
    });
    this.body.addEventListener("pointermove", (e) => this.#hover(e));
    this.body.addEventListener("pointerleave", () => this.tip.hide());
    window.addEventListener("resize", () => {
      if (!this.el.hidden) this.render();
    });
  }

  open() {
    this.opener = document.activeElement;
    this.el.hidden = $("lab-backdrop").hidden = false;
    this.render();
    requestAnimationFrame(() => this.el.classList.add("open"));
    $("lab-close").focus();
  }

  close() {
    if (this.running) return;
    this.el.classList.remove("open");
    this.el.hidden = $("lab-backdrop").hidden = true;
    this.tip.hide();
    if (this.opener && this.opener.focus) this.opener.focus();
  }

  get isOpen() {
    return !this.el.hidden;
  }

  // ------------------------------------------------------------- re-run
  async rerun(seeds) {
    if (this.running) return;
    this.running = true;
    this.stop = false;
    const { sim } = this.w;
    const wasPaused = sim.paused;
    sim.paused = true;
    this.w.renderPaused = true;
    this.el.dataset.running = "true";
    const bar = $("lab-progress-bar");
    const label = $("lab-progress-label");
    $("lab-progress").hidden = false;
    const names = { fleet: "車隊規模", strategy: "派工策略", mechanism: "關鍵機制", exceptions: "異常衝擊" };
    const started = performance.now();
    try {
      const res = await runLab({
        base: { ...settings },
        seeds,
        configs: CONFIGS,
        shouldStop: () => this.stop,
        onProgress: (p, cfg, seed) => {
          bar.style.setProperty("--v", p.toFixed(3));
          const left = p > 0.04 ? Math.max(0, ((performance.now() - started) / p) * (1 - p)) / 1000 : null;
          label.textContent = `${names[cfg.group]}：${cfg.robots} 台・${STRATEGIES[cfg.strategy].name}・情境 ${seed}　${Math.round(p * 100)}%${left !== null ? `・約剩 ${Math.ceil(left)} 秒` : ""}`;
        },
      });
      if (res) {
        this.data = res;
        this.source = { kind: "custom", at: sim.clock, seeds };
      }
    } finally {
      this.running = false;
      delete this.el.dataset.running;
      $("lab-progress").hidden = true;
      sim.paused = wasPaused;
      this.w.renderPaused = false;
      this.render();
    }
  }

  // ------------------------------------------------------------- render
  render() {
    if (this.el.hidden) return;
    const d = this.data;
    const C = d.configs;
    this.items = [];
    const src =
      this.source.kind === "default"
        ? `預先計算・預設設定・${d.seeds.length} 個情境平均`
        : `你的設定・${d.seeds.length} 個情境${d.seeds.length > 1 ? "平均" : ""}・${hm(this.source.at)} 重跑・耗時 ${(d.ms / 1000).toFixed(0)} 秒`;
    $("lab-source").textContent = src;
    $("lab-events").innerHTML = d.events
      .map((e) => `<li><time>${hm(e.at)}</time>${esc(e.label || EVENT_TEXT[e.kind])}</li>`)
      .join("");
    if (this.table) {
      this.body.innerHTML = this.#tableView(C);
      return;
    }
    this.body.innerHTML = [this.#hero(C), this.#fleetSection(C), this.#strategySection(C), this.#mechanismSection(C), this.#exceptionSection(C), this.#method(d)].join("");
  }

  #hero(C) {
    const fleet = FLEET_SIZES.map((n) => C[`n${n}`]);
    const knee = this.#knee(fleet);
    const k = C[`n${knee}`].mean;
    const prev = C[`n${knee - 1}`] ? C[`n${knee - 1}`].mean : null;
    const next = C[`n${knee + 1}`] ? C[`n${knee + 1}`].mean : null;
    const cards = [];
    cards.push({
      tag: "車隊規模",
      big: `${knee} 台`,
      title: "甜蜜點",
      text: `${prev ? `${knee - 1} 台 → ${knee} 台：平均等候 ${num(prev.avgWaitMin)} → ${num(k.avgWaitMin)} 分。` : ""}${next ? `再加到 ${knee + 1} 台只再少 ${num(Math.max(0, k.avgWaitMin - next.avgWaitMin))} 分，使用率卻從 ${pctTxt(k.utilization)} 降到 ${pctTxt(next.utilization)}。` : ""}`,
    });
    const on = C.n3.mean;
    const off = C["m-nobatch"].mean;
    const cut = off.avgWaitMin > 0 ? 1 - on.avgWaitMin / off.avgWaitMin : 0;
    cards.push({
      tag: "合併派工",
      big: `−${Math.round(cut * 100)}%`,
      title: "等候時間",
      text: `同樓層配送併成一趟、複測併入巡房：平均等候 ${num(off.avgWaitMin)} → ${num(on.avgWaitMin)} 分，完成任務 ${num(off.done)} → ${num(on.done)} 件（3 台）。`,
    });
    const rows = STRATEGY_KEYS.map((s) => ({ s, m: C[strategyKey(s)].mean }));
    const ok = rows.filter((r) => r.m.p1Min !== null);
    ok.sort((a, b) => a.m.p1Min - b.m.p1Min);
    const best = ok[0];
    const worst = ok[ok.length - 1];
    const slower = best && worst && best.m.p1Min > 0 ? worst.m.p1Min / best.m.p1Min - 1 : 0;
    cards.push({
      tag: "派工策略",
      big: `+${Math.round(slower * 100)}%`,
      title: `${STRATEGIES[worst.s].name}較慢`,
      text: `緊急用藥送達：${STRATEGIES[best.s].name} ${num(best.m.p1Min)} 分，${STRATEGIES[worst.s].name} ${num(worst.m.p1Min)} 分。不看距離的指派，讓緊急任務常由較遠的機器人接手。`,
    });
    return `<section class="lab-hero" aria-label="重點發現">${cards
      .map(
        (c) => `<article class="hero-card"><span class="hero-tag">${esc(c.tag)}</span><p class="hero-fig"><b>${esc(c.big)}</b><span>${esc(c.title)}</span></p><p class="hero-text">${esc(c.text)}</p></article>`,
      )
      .join("")}</section>`;
  }

  // the fleet size after which one more robot buys little: under a minute less waiting and
  // no real gain on urgent deliveries
  #knee(fleet) {
    for (let i = 1; i < fleet.length - 1; i++) {
      const a = fleet[i].mean;
      const b = fleet[i + 1].mean;
      const p1Gain = a.p1Min !== null && b.p1Min !== null ? a.p1Min - b.p1Min : 0;
      if (a.avgWaitMin - b.avgWaitMin < 1 && p1Gain < 0.5) return fleet[i].robots;
    }
    return fleet[fleet.length - 1].robots;
  }

  // width available to a chart inside a section card (body padding + card padding/border)
  #width() {
    return Math.max(260, this.body.clientWidth - 40 - 34);
  }

  #cols(min, most = 4) {
    const W = this.#width();
    const n = Math.max(1, Math.min(most, Math.floor((W + 14) / (min + 14))));
    return { n, w: Math.floor((W - 14 * (n - 1)) / n) };
  }

  // ------------------------------------------------------- fleet sizes
  #fleetSection(C) {
    const fleet = FLEET_SIZES.map((n) => C[`n${n}`]);
    const knee = this.#knee(fleet);
    const { w } = this.#cols(230);
    const charts = ["p1Min", "avgWaitMin", "done", "utilization"].map((k) => this.#sizeChart(fleet, k, knee, w)).join("");
    return `<section class="lab-sec"><header><h3>車隊規模：幾台才夠？</h3><p>綜合評分策略，1–5 台各跑同一個早上。陰影為 ${this.data.seeds.length > 1 ? "不同情境的最小–最大值" : "單一情境"}，虛線標出邊際效益開始遞減的台數。</p></header><div class="sm-grid">${charts}</div></section>`;
  }

  #sizeChart(fleet, key, knee, W) {
    const M = METRICS[key];
    const sc = M.scale || 1;
    const H = 168;
    const L = 34;
    const R = 14;
    const T = 26;
    const B = 24;
    const pw = W - L - R;
    const ph = H - T - B;
    const vals = fleet.flatMap((c) => [c.max[key], c.min[key], c.mean[key]]).filter((v) => v !== null);
    const hi = Math.max(...vals) * sc;
    const step = niceStep(hi / 3);
    const top = Math.max(step, Math.ceil(hi / step) * step);
    const X = (i) => L + (i / (fleet.length - 1)) * pw;
    const Y = (v) => T + (1 - (v * sc) / top) * ph;
    let svg = `<text class="ch-title" x="0" y="13">${esc(M.name)}<tspan class="ch-unit">（${esc(M.unit)}）</tspan></text>`;
    for (let v = 0; v <= top + 1e-9; v += step) svg += `<line class="grid" x1="${L}" x2="${L + pw}" y1="${Y(v / sc).toFixed(1)}" y2="${Y(v / sc).toFixed(1)}"/><text class="tick" x="${L - 6}" y="${(Y(v / sc) + 3.5).toFixed(1)}" text-anchor="end">${fmtTick(v)}</text>`;
    const ki = fleet.findIndex((c) => c.robots === knee);
    if (ki >= 0) svg += `<line class="knee" x1="${X(ki).toFixed(1)}" x2="${X(ki).toFixed(1)}" y1="${T - 4}" y2="${T + ph}"/><text class="knee-label" x="${(X(ki) + 4).toFixed(1)}" y="${T + 6}">甜蜜點</text>`;
    // range band across scenarios, then the mean line with dots
    const band = fleet.map((c, i) => `${X(i).toFixed(1)},${Y(c.max[key] ?? c.mean[key]).toFixed(1)}`).join(" ");
    const bandLow = fleet.map((c, i) => `${X(i).toFixed(1)},${Y(c.min[key] ?? c.mean[key]).toFixed(1)}`).reverse().join(" ");
    if (this.data.seeds.length > 1) svg += `<polygon class="range" points="${band} ${bandLow}"/>`;
    svg += `<polyline class="line accent" points="${fleet.map((c, i) => `${X(i).toFixed(1)},${Y(c.mean[key]).toFixed(1)}`).join(" ")}"/>`;
    fleet.forEach((c, i) => {
      const v = c.mean[key];
      this.items.push({ title: `${c.robots} 台・${M.name}`, rows: [[`${M.fmt(v)} ${M.unit}`, "平均"], ...(this.data.seeds.length > 1 ? [[`${M.fmt(c.min[key])}–${M.fmt(c.max[key])} ${M.unit}`, "不同情境"]] : [])] });
      const k = this.items.length - 1;
      svg += `<g data-k="${k}"><circle cx="${X(i).toFixed(1)}" cy="${Y(v).toFixed(1)}" r="4" class="dot accent"/><circle cx="${X(i).toFixed(1)}" cy="${Y(v).toFixed(1)}" r="13" fill="transparent"/></g>`;
      if (i === 0 || i === fleet.length - 1 || c.robots === knee) svg += `<text class="val" x="${X(i).toFixed(1)}" y="${(Y(v) - 9).toFixed(1)}" text-anchor="middle">${M.fmt(v)}</text>`;
      svg += `<text class="tick" x="${X(i).toFixed(1)}" y="${H - 6}" text-anchor="middle">${c.robots} 台</text>`;
    });
    return `<figure class="sm"><svg class="cs" width="${W}" height="${H}" style="width:${W}px;height:${H}px" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(M.name)}隨車隊規模的變化">${svg}</svg></figure>`;
  }

  // ------------------------------------------------------- strategies
  #strategySection(C) {
    const { w } = this.#cols(250);
    const charts = ["p1Min", "avgWaitMin", "done", "km"].map((k) => this.#strategyBars(C, k, w)).join("");
    const share = this.#workShare(C);
    return `<section class="lab-sec"><header><h3>派工策略：同樣 3 台，誰派得好？</h3><p>四種策略都看得到同一份佇列、電梯與充電狀態，只差在「哪一台接單」。最佳值以強調色標示，細線為不同情境的範圍。</p></header><div class="sm-grid">${charts}</div>${share}</section>`;
  }

  #strategyBars(C, key, W) {
    const M = METRICS[key];
    const sc = M.scale || 1;
    const rows = STRATEGY_KEYS.map((s) => ({ s, c: C[strategyKey(s)] }));
    const means = rows.map((r) => r.c.mean[key]);
    const bestV = M.better === "low" ? Math.min(...means) : Math.max(...means);
    const L = 74;
    const R = 40;
    const T = 26;
    const rowH = 30;
    const H = T + rows.length * rowH + 6;
    const pw = W - L - R;
    const hi = Math.max(...rows.map((r) => r.c.max[key] ?? r.c.mean[key])) * sc;
    const X = (v) => L + ((v * sc) / (hi || 1)) * pw;
    let svg = `<text class="ch-title" x="0" y="13">${esc(M.name)}<tspan class="ch-unit">（${esc(M.unit)}${M.better ? `，${M.better === "low" ? "越低越好" : "越高越好"}` : ""}）</tspan></text>`;
    rows.forEach((r, i) => {
      const y = T + i * rowH;
      const v = r.c.mean[key];
      const best = Math.abs(v - bestV) < 1e-9;
      const bh = 14;
      const by = y + (rowH - bh) / 2;
      svg += `<text class="cat" x="${L - 8}" y="${(by + bh / 2 + 4).toFixed(1)}" text-anchor="end">${esc(STRATEGIES[r.s].name)}</text>`;
      svg += `<path class="br ${best ? "accent" : "muted"}" d="${barPath(L, by, X(v) - L, bh)}"/>`;
      if (this.data.seeds.length > 1 && r.c.min[key] !== null) {
        const y0 = (by + bh / 2).toFixed(1);
        svg += `<line class="whisker" x1="${X(r.c.min[key]).toFixed(1)}" x2="${X(r.c.max[key]).toFixed(1)}" y1="${y0}" y2="${y0}"/>`;
      }
      svg += `<text class="val${best ? " strong" : ""}" x="${(Math.max(X(v), X(r.c.max[key] ?? v)) + 6).toFixed(1)}" y="${(by + bh / 2 + 4).toFixed(1)}">${M.fmt(v)}</text>`;
      this.items.push({ title: `${STRATEGIES[r.s].name}・${M.name}`, rows: [[`${M.fmt(v)} ${M.unit}`, "平均"], ...(this.data.seeds.length > 1 ? [[`${M.fmt(r.c.min[key])}–${M.fmt(r.c.max[key])} ${M.unit}`, "不同情境"]] : []), ["", M.desc]] });
      svg += `<rect x="0" y="${y}" width="${W}" height="${rowH}" fill="transparent" data-k="${this.items.length - 1}"/>`;
    });
    return `<figure class="sm"><svg class="cs" width="${W}" height="${H}" style="width:${W}px;height:${H}px" viewBox="0 0 ${W} ${H}" role="img" aria-label="各策略的${esc(M.name)}">${svg}</svg></figure>`;
  }

  // who did the work: each robot's minutes on tasks, per strategy (robot colours = identity)
  #workShare(C) {
    const W = this.#width();
    const rows = STRATEGY_KEYS.map((s) => ({ s, c: C[strategyKey(s)] }));
    const L = 74;
    const R = 120;
    const T = 6;
    const rowH = 26;
    const H = T + rows.length * rowH + 22;
    const pw = Math.max(120, W - L - R);
    const hi = Math.max(...rows.map((r) => r.c.alloc.reduce((s, a) => s + a.work, 0)));
    const X = (sec) => (sec / hi) * pw;
    let svg = "";
    rows.forEach((r, i) => {
      const y = T + i * rowH + 5;
      svg += `<text class="cat" x="${L - 8}" y="${y + 12}" text-anchor="end">${esc(STRATEGIES[r.s].name)}</text>`;
      let x = L;
      const works = r.c.alloc.map((a) => a.work);
      const spread = Math.max(...works) - Math.min(...works);
      r.c.alloc.forEach((a, j) => {
        const w = Math.max(1, X(a.work) - 2);
        this.items.push({ title: `${STRATEGIES[r.s].name}・${a.id}`, rows: [[`${Math.round(a.work / 60)} 分`, "執行任務"], [`${Math.round(a.wait / 60)} 分`, "等待"], [`${Math.round(a.charge / 60)} 分`, "充電"]] });
        svg += `<rect class="sg" x="${x.toFixed(1)}" y="${y}" width="${w.toFixed(1)}" height="16" rx="${j === r.c.alloc.length - 1 ? 3 : 0}" style="fill:var(--robot-${j + 1})" data-k="${this.items.length - 1}"/>`;
        if (w > 30) svg += `<text class="seg-text dark" x="${(x + 5).toFixed(1)}" y="${y + 12}">${Math.round(a.work / 60)}</text>`;
        x += X(a.work);
      });
      svg += `<text class="note" x="${(x + 8).toFixed(1)}" y="${y + 12}">最多與最少差 ${Math.round(spread / 60)} 分</text>`;
    });
    svg += `<text class="tick" x="${L}" y="${H - 4}">每台執行任務的分鐘數（3 個情境平均）</text>`;
    const legend = [1, 2, 3].map((i) => `<li><i class="sw" style="background:var(--robot-${i})"></i>K${i}</li>`).join("");
    return `<figure class="wide"><figcaption><b>工作量分配</b><ul class="legend">${legend}</ul></figcaption><svg class="cs" width="${W}" height="${H}" style="width:${W}px;height:${H}px" viewBox="0 0 ${W} ${H}" role="img" aria-label="各策略下每台機器人的工作時間">${svg}</svg></figure>`;
  }

  // ------------------------------------------------------- mechanisms
  #mechanismSection(C) {
    const { w } = this.#cols(300, 2);
    const batch = this.#paired("合併派工（3 台）", [
      { key: "avgWaitMin", on: C.n3, off: C["m-nobatch"] },
      { key: "p1Min", on: C.n3, off: C["m-nobatch"] },
      { key: "done", on: C.n3, off: C["m-nobatch"] },
    ], w);
    const pre = this.#paired("P1 插單（2 台，人力最吃緊時）", [
      { key: "p1Min", on: C.n2, off: C["m-nopreempt"] },
      { key: "avgWaitMin", on: C.n2, off: C["m-nopreempt"] },
      { key: "done", on: C.n2, off: C["m-nopreempt"] },
    ], w);
    return `<section class="lab-sec"><header><h3>關鍵機制：開與關差多少？</h3><p>只改一個開關，其餘條件相同。<span class="key on"></span>開啟（預設）<span class="key off"></span>關閉</p></header><div class="sm-grid two">${batch}${pre}</div></section>`;
  }

  #paired(title, rows, W) {
    const L = 96;
    const R = 46;
    const T = 26;
    const rowH = 44;
    const H = T + rows.length * rowH;
    const pw = W - L - R;
    let svg = `<text class="ch-title" x="0" y="13">${esc(title)}</text>`;
    rows.forEach((r, i) => {
      const M = METRICS[r.key];
      const a = r.on.mean[r.key];
      const b = r.off.mean[r.key];
      const hi = Math.max(a, b) || 1;
      const y = T + i * rowH;
      const X = (v) => L + (v / hi) * pw;
      svg += `<text class="cat" x="${L - 8}" y="${y + 16}" text-anchor="end">${esc(M.name)}</text><text class="cat sub" x="${L - 8}" y="${y + 30}" text-anchor="end">${esc(M.unit)}</text>`;
      svg += `<path class="br accent" d="${barPath(L, y + 5, X(a) - L, 12)}"/><text class="val strong" x="${(X(a) + 6).toFixed(1)}" y="${y + 15}">${M.fmt(a)}</text>`;
      svg += `<path class="br muted" d="${barPath(L, y + 21, X(b) - L, 12)}"/><text class="val" x="${(X(b) + 6).toFixed(1)}" y="${y + 31}">${M.fmt(b)}</text>`;
      const diff = M.better === "low" ? b - a : a - b;
      this.items.push({ title: `${title}・${M.name}`, rows: [[`${M.fmt(a)} ${M.unit}`, "開啟"], [`${M.fmt(b)} ${M.unit}`, "關閉"], ["", diff >= 0 ? "開啟較佳" : "關閉較佳"]] });
      svg += `<rect x="0" y="${y}" width="${W}" height="${rowH - 4}" fill="transparent" data-k="${this.items.length - 1}"/>`;
    });
    return `<figure class="sm"><svg class="cs" width="${W}" height="${H}" style="width:${W}px;height:${H}px" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(title)}開啟與關閉的比較">${svg}</svg></figure>`;
  }

  // ------------------------------------------------------- exceptions
  #exceptionSection(C) {
    const base = C.n3;
    const calm = C["x-calm"];
    const { w: cw } = this.#cols(330, 2);
    const lift = this.#overlay("電梯前排隊的機器人", "台", base, calm, 2, cw);
    const work = this.#overlay("正在執行任務的機器人", "台", base, calm, 3, cw);
    const ws = base.mean.waitShare;
    const wc = calm.mean.waitShare;
    return `<section class="lab-sec"><header><h3>異常衝擊：故障＋電梯停用 5 分鐘</h3><p>3 台、綜合評分。<span class="key on"></span>含 08:22 故障與 08:32 電梯停用<span class="key off"></span>同一個早上、沒有這兩個異常。停用期間跨樓層任務在電梯廳排隊，同樓層任務照常；機器人等待時間占比 ${pctTxt(wc)} → ${pctTxt(ws)}，09:00 前完成 ${num(base.mean.done)} 件（無異常 ${num(calm.mean.done)} 件）。</p></header><div class="sm-grid two">${lift}${work}</div></section>`;
  }

  #overlay(title, unit, a, b, j, W) {
    const H = 170;
    const L = 30;
    const R = 12;
    const T = 26;
    const B = 22;
    const pw = W - L - R;
    const ph = H - T - B;
    const sa = a.series;
    const sb = b.series;
    const t0 = sa[0][0];
    const t1 = sa[sa.length - 1][0];
    const hi = Math.max(1, ...sa.map((x) => x[j]), ...sb.map((x) => x[j]));
    const top = Math.ceil(hi);
    const X = (t) => L + ((t - t0) / (t1 - t0)) * pw;
    const Y = (v) => T + (1 - v / top) * ph;
    let svg = `<text class="ch-title" x="0" y="13">${esc(title)}<tspan class="ch-unit">（${esc(unit)}，${this.data.seeds.length > 1 ? "情境平均・" : ""}3 分鐘移動平均）</tspan></text>`;
    const ev = a.events;
    const o1 = ev.find((e) => e[1] === "outage");
    const o2 = ev.find((e) => e[1] === "outage-end");
    if (o1) svg += `<rect class="band" x="${X(o1[0]).toFixed(1)}" y="${T}" width="${(X(o2 ? o2[0] : t1) - X(o1[0])).toFixed(1)}" height="${ph}"/><text class="band-label" x="${(X(o1[0]) + 4).toFixed(1)}" y="${T + 11}">電梯停用</text>`;
    const fault = ev.find((e) => e[1] === "fault");
    if (fault) svg += `<line class="knee" x1="${X(fault[0]).toFixed(1)}" x2="${X(fault[0]).toFixed(1)}" y1="${T}" y2="${T + ph}"/><text class="band-label" x="${(X(fault[0]) - 4).toFixed(1)}" y="${T + 11}" text-anchor="end">故障</text>`;
    for (let v = 0; v <= top; v += top > 4 ? 2 : 1) svg += `<line class="grid" x1="${L}" x2="${L + pw}" y1="${Y(v).toFixed(1)}" y2="${Y(v).toFixed(1)}"/><text class="tick" x="${L - 6}" y="${(Y(v) + 3.5).toFixed(1)}" text-anchor="end">${v}</text>`;
    for (let c = Math.ceil(t0 / 900) * 900; c <= t1; c += 900) svg += `<text class="tick" x="${X(c).toFixed(1)}" y="${H - 5}" text-anchor="middle">${hm(c)}</text>`;
    // a 3-minute moving average keeps the 15 s samples readable
    const avg = (s) =>
      s.map((x, i) => {
        const win = s.slice(Math.max(0, i - 6), Math.min(s.length, i + 7));
        return [x[0], win.reduce((acc, y) => acc + y[j], 0) / win.length];
      });
    const pa = avg(sa);
    const pb = avg(sb);
    svg += `<polyline class="line muted" points="${pb.map(([t, v]) => `${X(t).toFixed(1)},${Y(v).toFixed(1)}`).join(" ")}"/>`;
    svg += `<polyline class="line accent" points="${pa.map(([t, v]) => `${X(t).toFixed(1)},${Y(v).toFixed(1)}`).join(" ")}"/>`;
    // hover columns every 2 minutes
    for (let i = 0; i < pa.length; i += 8) {
      const t = pa[i][0];
      this.items.push({ title: hm(t), rows: [[num(pa[i][1]), "含異常"], [num(pb[i] ? pb[i][1] : 0), "無異常"]] });
      const x = X(t);
      const cw = (pw / pa.length) * 8;
      svg += `<rect x="${(x - cw / 2).toFixed(1)}" y="${T}" width="${cw.toFixed(1)}" height="${ph}" fill="transparent" data-k="${this.items.length - 1}"/>`;
    }
    return `<figure class="sm"><svg class="cs" width="${W}" height="${H}" style="width:${W}px;height:${H}px" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(title)}：含異常與無異常的比較">${svg}</svg></figure>`;
  }

  // ------------------------------------------------------- table + notes
  #tableView(C) {
    const cols = ["p1Min", "avgWaitMin", "done", "utilization", "waitShare", "km", "rides"];
    const label = (c) => {
      if (c.group === "fleet") return `車隊 ${c.robots} 台・綜合評分`;
      if (c.group === "strategy") return `策略：${STRATEGIES[c.strategy].name}（3 台）`;
      if (c.key === "m-nobatch") return "關閉合併派工（3 台）";
      if (c.key === "m-nopreempt") return "關閉 P1 插單（2 台）";
      if (c.key === "x-calm") return "無故障、無電梯停用（3 台）";
      return c.key;
    };
    const head = cols.map((k) => `<th scope="col">${esc(METRICS[k].name)}<small>${esc(METRICS[k].unit)}</small></th>`).join("");
    const body = Object.values(C)
      .map((c) => {
        const cells = cols
          .map((k) => {
            const M = METRICS[k];
            const range = this.data.seeds.length > 1 ? `<small>${M.fmt(c.min[k])}–${M.fmt(c.max[k])}</small>` : "";
            return `<td>${M.fmt(c.mean[k])}${range}</td>`;
          })
          .join("");
        return `<tr><th scope="row">${esc(label(c))}</th>${cells}</tr>`;
      })
      .join("");
    return `<section class="lab-sec"><header><h3>表格檢視</h3><p>每格為 ${this.data.seeds.length} 個情境的平均，小字為範圍。</p></header><div class="lab-table"><table><thead><tr><th scope="col">設定</th>${head}</tr></thead><tbody>${body}</tbody></table></div></section>${this.#method(this.data)}`;
  }

  #method(d) {
    return `<section class="lab-sec lab-method"><header><h3>怎麼算的</h3></header><ul>
      <li>每一格都是一次完整的離屏模擬：同一套派工、雙向車道與通行區、電梯排程、充電與故障交接邏輯，步長 0.05 秒，07:58 開始、09:00 結束。</li>
      <li>腳本事件相同（${d.events.map((e) => `${hm(e.at)} ${e.label || EVENT_TEXT[e.kind]}`).join("、")}），例行巡房、派單與巡視照常排程。</li>
      <li>「情境」改變的是日常隨機性：派單時間 ±45%、配送樓層、藥師備藥與護理師取件的等待、第二輪巡房偶發的異常數值。不同設定使用同一組隨機數，比較才公平。</li>
      <li>等候派工：任務建立到開始執行；09:00 仍在等待的任務以 09:00 計。緊急用藥：醫囑建立到護理站簽收；最後 8 分鐘才建立而尚未送達的不列入。</li>
      <li>電量變化依「示範加速 ${d.settings.batteryBoost}×」設定，與畫面上的模擬一致。</li>
    </ul></section>`;
  }

  #hover(e) {
    const el = e.target.closest("[data-k]");
    const it = el && this.items[Number(el.dataset.k)];
    if (!it) return this.tip.hide();
    this.tip.show(e.clientX, e.clientY, it.title, it.rows);
  }
}

// horizontal bar: square at the baseline, 4px rounded data end
function barPath(x, y, w, h) {
  const r = Math.min(4, h / 2, Math.max(0, w));
  const ww = Math.max(0.5, w);
  return `M${x.toFixed(1)} ${y.toFixed(1)}H${(x + ww - r).toFixed(1)}A${r} ${r} 0 0 1 ${(x + ww).toFixed(1)} ${(y + r).toFixed(1)}V${(y + h - r).toFixed(1)}A${r} ${r} 0 0 1 ${(x + ww - r).toFixed(1)} ${(y + h).toFixed(1)}H${x.toFixed(1)}Z`;
}

function niceStep(raw) {
  const p = Math.pow(10, Math.floor(Math.log10(Math.max(raw, 1e-6))));
  const f = raw / p;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * p;
}

function fmtTick(v) {
  return Number.isInteger(v) ? String(v) : v.toFixed(1);
}
