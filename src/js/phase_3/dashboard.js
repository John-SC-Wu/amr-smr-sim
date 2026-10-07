import { FLOORS, FLOOR_GAP, KACHAKA, MEASURE_SECONDS, PRIORITY } from "./config.js";
import { on, formatClock } from "./sim.js";
import { settings, setSetting, resetSettings, SETTINGS_SCHEMA } from "./settings.js";
import { STRATEGIES, zoneMap } from "./dispatch.js";
import { TASK_TYPES } from "./tasks.js";
import { Timeline, LiveCharts, stateLegend } from "./insights.js";

const $ = (id) => document.getElementById(id);
const TAGS = { api: "API", lift: "電梯", vitals: "量測", alert: "通報", staff: "人員", nav: "導航", dispatch: "派工", traffic: "交通", charge: "充電" };
const CATS = { dispatch: "dispatch", traffic: "traffic", lift: "traffic", nav: "traffic", charge: "charge", vitals: "care", alert: "care", staff: "care" };
const ICONS = { measure: "i-heart", lift: "i-lift", alert: "i-alert", fault: "i-alert", charge: "i-battery", dock: "i-box", handoff: "i-box", patrol: "i-shield", move: "i-pin", idle: "i-robot" };
const STATE_KIND = { move: "move", dock: "dock", handoff: "dock", measure: "measure", lift: "lift", alert: "alert", fault: "alert", charge: "charge", patrol: "move", idle: "idle" };
const SENSOR_STATE = { idle: "待命", detect: "偵測目標", measure: "量測中", upload: "上傳中", done: "已上傳" };

function css(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const chip = (r) => (r ? `<span class="rchip" style="--rc:${r.css}">${r.id}</span>` : "");
const mmss = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

export class Dashboard {
  constructor(world) {
    this.w = world;
    this.fleet = world.fleet;
    this.timer = 0;
    this.slow = 0;
    this.tasksDirty = true;
    this.floorLabels = [];
    this.robotLabels = new Map();
    this.sensorLabels = new Map();
    this.alertLabels = new Map();
    this.vitalsHold = new Map();
    this.cards = new Map();
    this.detailRobot = null;

    this.lidarCanvas = $("lidar");
    this.timeline = new Timeline(world, $("bp-timeline"));
    this.charts = new LiveCharts(world, $("bp-charts"));
    this.btab = "board";
    this.chartTimer = 0;
    $("alloc-legend").innerHTML = stateLegend();
    this.#bindControls();
    this.#bindViews();
    this.#buildSettings();
    this.#bindEvents();
    this.#buildStaticLabels();
    this.#themeWatch();
    if (window.innerWidth <= 640) $("rdetail").open = false;
    new ResizeObserver(() => (this.lidarSize = null)).observe(this.lidarCanvas);
    this.#onFleetStart();
  }

  // ------------------------------------------------------------ controls
  #bindControls() {
    const { sim } = this.w;
    const speedButtons = [...document.querySelectorAll("[data-speed]")];
    this.syncSpeed = () => {
      for (const b of speedButtons) {
        const s = Number(b.dataset.speed);
        b.setAttribute("aria-pressed", String(s === 0 ? sim.paused : !sim.paused && s === sim.speed));
      }
    };
    const setSpeed = (v) => {
      if (v === 0) sim.paused = !sim.paused;
      else {
        sim.paused = false;
        sim.speed = v;
      }
      this.syncSpeed();
    };
    for (const b of speedButtons) b.addEventListener("click", () => setSpeed(Number(b.dataset.speed)));

    const cam = this.w.camera;
    const camButtons = [...document.querySelectorAll("[data-cam]")];
    const reflect = (mode) => camButtons.forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.cam === mode)));
    for (const b of camButtons) b.addEventListener("click", () => cam.setMode(b.dataset.cam));
    cam.onModeChange = (mode) => {
      reflect(mode);
      if (mode === "free") $("hud-hint").dataset.hide = "true";
      this.#renderFleet(true);
    };
    cam.onFocusChange = () => this.#renderFleet(true);
    reflect(cam.mode);
    setTimeout(() => ($("hud-hint").dataset.hide = "true"), 9000);

    // quick-add tasks (presenter shortcuts)
    for (const b of document.querySelectorAll("[data-add]")) {
      b.addEventListener("click", () => {
        const r = this.fleet.quickAdd(b.dataset.add);
        if ((b.dataset.add === "battery" || b.dataset.add === "fault") && r && r.id) cam.follow(r);
        const menu = b.closest("details");
        if (menu) menu.open = false;
      });
    }
    document.addEventListener("click", (e) => {
      const menu = $("demo-menu");
      if (menu.open && !menu.contains(e.target)) menu.open = false;
    });

    // log filter
    const filters = [...document.querySelectorAll("[data-filter]")];
    for (const b of filters) {
      b.addEventListener("click", () => {
        $("log").dataset.filter = b.dataset.filter;
        filters.forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
      });
    }

    // settings drawer
    const drawer = $("drawer");
    const backdrop = $("drawer-backdrop");
    let opener = null;
    const open = (tab = "settings") => {
      opener = document.activeElement;
      drawer.hidden = backdrop.hidden = false;
      this.#tab(tab);
      this.#syncSettings();
      requestAnimationFrame(() => drawer.classList.add("open"));
      $("close-settings").focus();
    };
    const close = () => {
      drawer.classList.remove("open");
      drawer.hidden = backdrop.hidden = true;
      if (opener && opener.focus) opener.focus();
    };
    $("open-settings").addEventListener("click", () => open());
    $("strategy-pill").addEventListener("click", () => open());
    $("close-settings").addEventListener("click", close);
    backdrop.addEventListener("click", close);
    drawer.addEventListener("keydown", (e) => {
      if (e.key === "Escape") close();
    });
    for (const b of drawer.querySelectorAll("[data-tab]")) b.addEventListener("click", () => this.#tab(b.dataset.tab));
    $("reset-settings").addEventListener("click", () => {
      const before = `${settings.robots}:${settings.seed}`;
      resetSettings();
      this.#syncSettings();
      if (`${settings.robots}:${settings.seed}` !== before) this.fleet.restart();
    });
    $("restart-sim").addEventListener("click", () => {
      close();
      this.fleet.restart();
    });
  }

  // ------------------------------------------------- stage view + bottom tabs
  #bindViews() {
    for (const b of document.querySelectorAll("[data-view]")) b.addEventListener("click", () => this.setView(b.dataset.view));
    for (const b of document.querySelectorAll("[data-btab]")) b.addEventListener("click", () => this.setTab(b.dataset.btab));
    let view = "3d";
    try {
      view = localStorage.getItem("kachaka-ltc-view") || "3d";
    } catch {
      /* storage blocked: start in 3D */
    }
    if (!this.w.renderer) view = "plan";
    if (view === "split" && window.innerWidth <= 640) view = "3d";
    this.setView(view, false);
  }

  setView(view, remember = true) {
    const stage = $("stage");
    stage.dataset.view = view;
    // one switch, parked where it is visible: over the 3D view, or in the plan's header
    const seg = $("view-seg");
    const home = view === "3d" ? $("hud-right") : stage.querySelector(".plan-head");
    if (seg.parentElement !== home) home.appendChild(seg);
    for (const b of document.querySelectorAll("[data-view]")) b.setAttribute("aria-pressed", String(b.dataset.view === view));
    this.w.view = view;
    if (this.w.plan) this.w.plan.setVisible(view !== "3d");
    if (remember) {
      try {
        localStorage.setItem("kachaka-ltc-view", view);
      } catch {
        /* per-visit only */
      }
    }
  }

  setTab(name) {
    this.btab = name;
    for (const b of document.querySelectorAll("[data-btab]")) {
      const on = b.dataset.btab === name;
      b.setAttribute("aria-selected", String(on));
      b.setAttribute("aria-pressed", String(on));
    }
    $("bp-board").hidden = name !== "board";
    $("bp-timeline").hidden = name !== "timeline";
    $("bp-charts").hidden = name !== "charts";
    this.chartTimer = 99;
  }

  #tab(name) {
    for (const b of $("drawer").querySelectorAll("[data-tab]")) {
      const on = b.dataset.tab === name;
      b.setAttribute("aria-selected", String(on));
      b.setAttribute("aria-pressed", String(on));
    }
    for (const p of $("drawer").querySelectorAll("[data-panel]")) p.hidden = p.dataset.panel !== name;
  }

  // ------------------------------------------------------------ settings form
  #buildSettings() {
    const form = $("settings-form");
    form.innerHTML = SETTINGS_SCHEMA.map((sec) => {
      const items = sec.items
        .map((it) => {
          if (it.type === "seg") {
            const buttons = it.options.map(([v, label]) => `<button type="button" data-value="${v}" aria-pressed="false">${label}</button>`).join("");
            return `<div class="set-row" data-item="${it.key}"><span class="set-label">${it.label}</span><div class="seg set-seg" role="group" aria-label="${it.label}" data-key="${it.key}">${buttons}</div></div>`;
          }
          if (it.type === "range") {
            return `<label class="set-row" data-item="${it.key}"><span class="set-label">${it.label}<output data-out="${it.key}"></output></span><input type="range" min="${it.min}" max="${it.max}" step="${it.step}" data-key="${it.key}" /></label>`;
          }
          return `<label class="set-row set-switch" data-item="${it.key}"><input type="checkbox" role="switch" data-key="${it.key}" /><span>${it.label}</span></label>`;
        })
        .join("");
      const extra =
        sec.id === "dispatch"
          ? `<p class="set-desc" id="strategy-desc"></p><p class="set-desc" id="zone-desc" hidden></p>`
          : sec.id === "fleet"
            ? `<p class="set-desc">機器人愈多，電梯與充電座愈容易成為瓶頸；5 台時充電座（4 個）少於機器人數，可觀察讓位與待命排隊。</p>`
            : "";
      return `<section class="set-sec" data-sec="${sec.id}"><h3>${sec.title}</h3>${extra}${items}</section>`;
    }).join("");

    const schema = new Map(SETTINGS_SCHEMA.flatMap((s) => s.items).map((it) => [it.key, it]));
    form.addEventListener("click", (e) => {
      const b = e.target.closest(".set-seg button");
      if (!b) return;
      const key = b.parentElement.dataset.key;
      const raw = b.dataset.value;
      const value = typeof settings[key] === "number" ? Number(raw) : raw;
      if (settings[key] === value) return;
      setSetting(key, value);
      this.#syncSettings();
      if (key === "robots" || key === "seed") this.fleet.restart();
    });
    form.addEventListener("input", (e) => {
      const el = e.target;
      const key = el.dataset.key;
      if (!key) return;
      const it = schema.get(key);
      setSetting(key, it.type === "switch" ? el.checked : Number(el.value));
      this.#syncSettings();
    });
    this.schema = schema;
    this.#syncSettings();
  }

  #syncSettings() {
    const form = $("settings-form");
    for (const [key, it] of this.schema) {
      const row = form.querySelector(`[data-item="${key}"]`);
      if (it.show) row.hidden = !it.show(settings);
      if (it.type === "seg") {
        for (const b of row.querySelectorAll("button")) b.setAttribute("aria-pressed", String(b.dataset.value === String(settings[key])));
      } else if (it.type === "range") {
        const input = row.querySelector("input");
        if (Number(input.value) !== settings[key]) input.value = settings[key];
        const v = settings[key];
        row.querySelector("output").textContent = v === 0 && it.zero ? it.zero : `${it.step < 1 ? v.toFixed(1) : v}${it.unit ? ` ${it.unit}` : ""}`;
      } else {
        row.querySelector("input").checked = !!settings[key];
      }
    }
    $("strategy-desc").textContent = STRATEGIES[settings.strategy].desc;
    const zoneDesc = $("zone-desc");
    zoneDesc.hidden = settings.strategy !== "zone";
    if (!zoneDesc.hidden) {
      const robots = this.fleet.robots;
      zoneDesc.textContent = `目前分區：${zoneMap(robots.length)
        .map((floors, i) => `${robots[i] ? robots[i].id : `K${i + 1}`} ${floors.length ? floors.map((f) => FLOORS[f].id).join("、") : "機動支援"}`)
        .join("｜")}`;
    }
    $("strategy-pill").textContent = `策略：${STRATEGIES[settings.strategy].name}`;
  }

  // ------------------------------------------------------------- events
  #bindEvents() {
    on("log", (e) => this.#log(e));
    on("tasks", () => (this.tasksDirty = true));
    on("kpi", () => this.#renderKpi());
    on("measurement", () => this.#renderHistory());
    on("alert", () => this.#renderAlert());
    on("speech", (s) => this.#speech(s));
    on("activity", ({ robot }) => this.#robotTag(robot));
    on("vitals", ({ phase, sensor }) => {
      if (phase === "done") this.vitalsHold.set(sensor, 5);
    });
    on("fleet", ({ kind }) => {
      if (kind === "start") this.#onFleetStart();
    });
    on("settings", () => {
      this.#syncSettings();
      this.tasksDirty = true;
    });
  }

  #onFleetStart() {
    const { labels } = this.w;
    for (const item of this.robotLabels.values()) labels.remove(item);
    this.robotLabels.clear();
    for (const item of this.alertLabels.values()) labels.remove(item);
    this.alertLabels.clear();
    for (const r of this.fleet.robots) {
      const item = labels.add({
        className: "lbl-robot",
        html: "",
        anchor: (v) => r.anchor(v).setY(r.y + (r.shelf ? 1.18 : 0.42)),
        floor: () => (r.inElevator ? null : r.floor),
        offsetY: -4,
        dimWhenFaded: true,
      });
      item.el.style.setProperty("--rc", r.css);
      this.robotLabels.set(r, item);
      this.#robotTag(r);
    }
    this.#buildFleetList();
    $("battery-legend").innerHTML = this.fleet.robots.map((r) => `<li><i class="key-line" style="background:${r.css}"></i>${r.id}</li>`).join("");
    this.chartTimer = 99;
    this.#renderHistory();
    this.#renderKpi();
    this.#renderAlert();
    this.#syncSettings();
    this.tasksDirty = true;
  }

  #log({ tag, html, robot }) {
    const ol = $("log");
    const li = document.createElement("li");
    li.dataset.tag = tag;
    li.dataset.cat = CATS[tag] || "other";
    li.dataset.new = "true";
    if (tag === "sep") li.innerHTML = `<span>— ${html} —</span>`;
    else
      li.innerHTML = `<time>${formatClock(this.w.sim.clock)}</time><span class="tag" data-tag="${tag}">${TAGS[tag] || tag}</span><span class="msg">${chip(robot)}${html}</span>`;
    ol.prepend(li);
    setTimeout(() => (li.dataset.new = "false"), 600);
    while (ol.children.length > 120) ol.lastElementChild.remove();
  }

  #renderKpi() {
    const f = this.fleet;
    const k = f.kpi;
    if (!k) return;
    $("kpi-done").textContent = k.done;
    $("kpi-wait").textContent = f.waitAvgMin.toFixed(1);
    $("kpi-beds").textContent = k.beds;
    $("kpi-alerts").textContent = k.alerts;
    $("kpi-rides").textContent = this.w.lift.stats.rides;
    const q = this.w.lift.order().filter((t) => !t.boarded).length;
    $("kpi-queue").textContent = q ? `次・候梯 ${q}` : "次";
    $("kpi-minutes").textContent = k.minutes;
  }

  #renderHistory() {
    const rows = this.fleet.history.slice(0, 14);
    $("vs-history").innerHTML = rows
      .map(
        (r) => `<tr data-new="${r.fresh ? "true" : "false"}"><td>${formatClock(r.clock, false)}</td><td>${r.floor} ${r.bed}${r.again ? '<small class="again">複測</small>' : ""}</td>
        <td><b>${r.hr}</b></td><td><b>${r.rr}</b></td><td><span class="chip" data-level="${r.level}">${r.label}</span></td></tr>`,
      )
      .join("");
    for (const r of rows) r.fresh = false;
  }

  #renderAlert() {
    const a = this.fleet.alerts.find((x) => !x.closed) || this.fleet.alerts[0];
    const box = $("vs-alert");
    const fresh = a && (!a.closed || this.w.sim.time - a.at < 600);
    box.hidden = !fresh;
    if (fresh) {
      box.style.borderLeftColor = a.resolved ? "var(--ok)" : "";
      $("alert-title").textContent = `${a.floor} ${a.bed} ${a.flags.join("、")}`;
      $("alert-detail").textContent = `${formatClock(a.clock, false)} · ${a.robot} 通報 · ${a.status}`;
    }
    // red tags above beds with an open, untreated alert
    const open = new Set(this.fleet.alerts.filter((x) => !x.closed && !x.resolved).map((x) => x.bed));
    for (const [bed, item] of this.alertLabels) {
      if (!open.has(bed)) {
        this.w.labels.remove(item);
        this.alertLabels.delete(bed);
      }
    }
    for (const x of this.fleet.alerts) {
      if (!open.has(x.bed) || this.alertLabels.has(x.bed)) continue;
      const bed = this.w.hospital.beds.get(x.bed);
      const item = this.w.labels.add({
        className: "lbl-alert",
        html: `<svg><use href="#i-alert"></use></svg>${x.bed} ${x.flags[0]}`,
        anchor: (v) => v.set(bed.x, bed.floor * FLOOR_GAP + 1.55, bed.z - 0.4),
        floor: bed.floor,
      });
      this.alertLabels.set(x.bed, item);
    }
  }

  #speech({ who, name, text, robot }) {
    const { staff, patients, labels } = this.w;
    if (robot) {
      const r = robot;
      labels.bubble(who, {
        anchor: (v) => r.anchor(v).setY(r.y + (r.shelf ? 1.45 : 0.75)),
        floor: () => (r.inElevator ? null : r.floor),
        text,
        kind: "robot",
        name,
        color: r.css,
      });
      return;
    }
    if (who.startsWith("patient-")) {
      const p = patients.get(who.slice(8));
      if (p) labels.bubble(who, { anchor: (v) => p.anchor(v), floor: p.floor, text, kind: "patient", name });
      return;
    }
    const person = staff[who];
    if (person) labels.bubble(who, { anchor: (v) => person.anchor(v), floor: () => person.floor, text, kind: "staff", name });
  }

  // ------------------------------------------------------------- labels
  #buildStaticLabels() {
    const { labels } = this.w;
    FLOORS.forEach((f, i) => {
      this.floorLabels.push(
        labels.add({
          className: "lbl-floor",
          html: `<b style="background:${f.css}">${f.id}</b><span>${f.name}</span>`,
          anchor: (v) => v.set(9.3, i * FLOOR_GAP + 0.05, 5.25),
          floor: i,
          dimWhenFaded: true,
          occlude: false,
        }),
      );
    });
    for (const s of Object.values(this.w.sensors)) {
      const item = labels.add({
        className: "lbl-vitals",
        html: "",
        anchor: (v) => (s.bed ? s.chestWorld(v).setY(s.bed.floor * FLOOR_GAP + 1.25) : v.set(0, -99, 0)),
        floor: () => (s.bed ? s.bed.floor : s.floor),
      });
      item.hidden = true;
      this.sensorLabels.set(s, item);
    }
  }

  #robotTag(r) {
    const item = this.robotLabels.get(r);
    if (!item) return;
    const a = r.activity;
    item.el.dataset.kind = a.kind;
    item.el.innerHTML = `<i></i><b>${r.id}</b><span>${a.label}</span>`;
  }

  #themeWatch() {
    const refresh = () => (this.lidarColors = null);
    window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", refresh);
    new MutationObserver(refresh).observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
  }

  // -------------------------------------------------------------- fleet
  #buildFleetList() {
    const ul = $("fleet-list");
    ul.innerHTML = "";
    this.cards.clear();
    for (const r of this.fleet.robots) {
      const li = document.createElement("li");
      li.innerHTML = `<button type="button" class="rcard" style="--rc:${r.css}" aria-pressed="false">
        <span class="rc-id">${r.id}</span>
        <span class="rc-main"><b class="rc-state"></b><small class="rc-task"></small></span>
        <span class="rc-bat"><b></b><i class="rc-bar"><i></i></i></span>
        <span class="rc-wait" hidden></span>
      </button>`;
      const btn = li.firstElementChild;
      btn.addEventListener("click", () => this.w.camera.follow(r));
      ul.appendChild(li);
      this.cards.set(r, {
        btn,
        state: btn.querySelector(".rc-state"),
        task: btn.querySelector(".rc-task"),
        bat: btn.querySelector(".rc-bat b"),
        bar: btn.querySelector(".rc-bar i"),
        wait: btn.querySelector(".rc-wait"),
        key: "",
      });
    }
    $("fleet-count").textContent = `${this.fleet.robots.length} 台`;
  }

  #renderFleet(force = false) {
    const cam = this.w.camera;
    const sel = cam.mode === "follow" ? cam.selected : null;
    let km = 0;
    for (const [r, c] of this.cards) {
      km += r.odometer;
      const a = r.activity;
      const fid = FLOORS[r.inElevator ? this.w.elevator.floor : r.floor].id;
      const state = `${a.label}${a.detail ? ` · ${a.detail}` : ""}`;
      const t = r.task || r.assignment;
      const task = t ? `${t.id} ${t.title}${t.type === "rounds" ? ` · ${t.doneBeds.length}/${t.doneBeds.length + t.beds.length} 床` : ""}` : r.needCharge ? `低電量：充到 ${settings.resumeBattery}% 後再接單` : `${fid} · 可派工`;
      const wait = r.waitInfo || r.yieldInfo;
      const pct = Math.round(r.battery);
      const key = `${state}|${task}|${wait ? wait.label : ""}|${pct}|${r === sel}|${r === cam.focusRobot}|${r.onCharger}`;
      if (!force && key === c.key) continue;
      c.key = key;
      c.btn.dataset.kind = STATE_KIND[a.kind] || "idle";
      c.btn.setAttribute("aria-pressed", String(r === sel));
      c.btn.dataset.focus = String(r === cam.focusRobot);
      c.state.textContent = state;
      c.task.textContent = task;
      c.bat.textContent = `${pct}%${r.onCharger ? "⚡" : ""}`;
      c.bar.style.setProperty("--v", (r.battery / 100).toFixed(3));
      c.bar.dataset.level = pct < settings.criticalBattery ? "crit" : pct < settings.lowBattery ? "warn" : "ok";
      c.wait.hidden = !wait;
      if (wait) {
        c.wait.textContent = wait.label;
        c.wait.dataset.kind = wait.kind;
      }
    }
    $("fleet-km").textContent = `車隊里程 ${(km / 1000).toFixed(2)} km`;
  }

  // ------------------------------------------------------------- tasks
  #renderTasks() {
    const f = this.fleet;
    const now = this.w.sim.time;
    const robotOf = (t) => t.robot;
    const card = (t) => {
      const eff = t.state === "queued" ? f.effPriority(t) : t.priority;
      const p = t.priority;
      const aged = eff < p ? `<span class="prio aged" data-p="${eff}" title="等候老化升級">→P${eff}</span>` : "";
      const type = TASK_TYPES[t.type];
      let status;
      let why = "";
      if (t.state === "queued") {
        status = `等候 ${mmss(now - t.createdAt)}`;
        why = t.block || t.note || "等待派工";
      } else if (t.state === "assigned") {
        status = t.preempting ? "等待安全點交接" : "已指派・前往中";
        why = t.explain;
      } else if (t.state === "active") {
        status = t.step || "執行中";
        why = t.explain;
      } else if (t.state === "merged") {
        status = "已合併";
        why = t.explain;
      } else {
        const dur = t.doneAt - (t.startedAt ?? t.createdAt);
        status = t.state === "merged-done" ? `隨 ${t.parent ? t.parent.id : ""} 完成` : `完成 · 等候 ${mmss((t.startedAt ?? t.doneAt) - t.createdAt)} · 執行 ${mmss(dur)}`;
        why = t.state === "merged-done" ? t.explain : "";
      }
      const prog = t.state === "active" ? `<div class="tc-prog"><i style="--v:${t.progress.toFixed(3)}"></i></div>` : "";
      return `<li class="tcard" data-state="${t.state}" data-p="${p}">
        <div class="tc-top"><span class="prio" data-p="${p}" title="${PRIORITY[p].name}">P${p}</span>${aged}<svg><use href="#${type.icon}"></use></svg><b>${esc(t.title)}</b><span class="tc-id">${t.id}</span></div>
        <div class="tc-sub">${esc(t.sub)}${t.by ? ` · ${esc(t.by)}` : ""}</div>
        <div class="tc-meta">${chip(robotOf(t))}<span>${esc(status)}</span></div>
        ${prog}${why ? `<p class="tc-why" title="${esc(why)}">${esc(why)}</p>` : ""}
      </li>`;
    };
    const queued = f.tasks
      .filter((t) => t.state === "queued" || (t.state === "merged" && !t.parent?.robot))
      .sort((a, b) => f.effPriority(a) - f.effPriority(b) || a.createdAt - b.createdAt);
    const active = f.tasks.filter((t) => t.state === "assigned" || t.state === "active" || (t.state === "merged" && t.parent?.robot));
    const done = f.tasks.filter((t) => t.state === "done" || t.state === "merged-done").sort((a, b) => b.doneAt - a.doneAt);
    const fill = (id, list, empty) => {
      $(id).innerHTML = list.length ? list.map(card).join("") : `<li class="tc-empty">${empty}</li>`;
    };
    fill("col-queue", queued, "佇列淨空");
    fill("col-active", active, "目前沒有執行中的任務");
    fill("col-done", done.slice(0, 10), "尚無完成任務");
    $("n-queue").textContent = queued.length;
    $("n-active").textContent = active.length;
    $("n-done").textContent = f.kpi ? f.kpi.done : 0;
  }

  // ------------------------------------------------------------- frame
  update(realDt) {
    for (const [s, t] of this.vitalsHold) this.vitalsHold.set(s, Math.max(0, t - realDt));
    this.chartTimer += realDt;
    if (this.chartTimer > 1 && this.btab !== "board") {
      this.chartTimer = 0;
      if (this.btab === "timeline") this.timeline.render();
      else this.charts.render();
    }
    this.timer += realDt;
    this.slow += realDt;
    if (this.timer > 0.12) {
      this.timer = 0;
      this.refresh();
      this.#drawLidar();
    }
    if (this.tasksDirty || this.slow > 1) {
      if (this.slow > 0.25) {
        this.slow = 0;
        this.tasksDirty = false;
        this.#renderTasks();
        this.#renderKpi();
        this.#renderAlert();
      }
    }
  }

  refresh() {
    const { sim, elevator, camera } = this.w;
    const robots = this.fleet.robots;
    if (!robots.length) return;
    // clock
    const clock = sim.clock;
    $("clock").textContent = formatClock(clock);
    $("hud-clock").textContent = `${formatClock(clock, false)} · ${sim.paused ? "暫停" : `${sim.speed}× 模擬`}`;

    this.#renderFleet();
    const robot = (camera.mode === "follow" && camera.selected) || camera.focusRobot || robots[0];
    for (const r of robots) r.detailed = r === robot;
    this.#renderDetail(robot);
    this.#renderElevator();
    this.#renderVitals(robot);
    this.#renderNow(camera.focusRobot || robot);
  }

  #renderDetail(robot) {
    if (this.detailRobot !== robot) {
      this.detailRobot = robot;
      $("rd-chip").textContent = robot.id;
      $("rd-chip").style.setProperty("--rc", robot.css);
      $("rd-title").textContent = `${robot.name} · ${robot.serial}`;
      this.lidarColors = null;
    }
    const a = robot.activity;
    const pill = $("robot-state");
    pill.textContent = a.label;
    pill.dataset.kind = STATE_KIND[a.kind] || "idle";
    const pct = Math.round(robot.battery);
    $("bat-pct").textContent = `${pct}%`;
    $("bat-bar").style.setProperty("--v", (robot.battery / 100).toFixed(3));
    const boost = settings.batteryBoost;
    $("bat-mode").textContent = robot.onCharger
      ? pct >= 100
        ? "已充飽"
        : `充電中${robot.needCharge ? `・充到 ${settings.resumeBattery}%` : ""}`
      : `放電中・示範加速 ×${boost}`;
    $("t-speed").textContent = Math.abs(robot.v).toFixed(2);
    const floor = robot.inElevator ? this.w.elevator.floor : robot.floor;
    $("t-floor").textContent = FLOORS[floor].id;
    $("t-map").textContent = FLOORS[robot.floor].map;
    const deg = Math.round(((robot.yaw * 180) / Math.PI + 360) % 360);
    $("t-pose").textContent = `${robot.x.toFixed(2)}, ${(-robot.z).toFixed(2)}, ${deg}°`;
    $("t-shelf").textContent = robot.shelf ? robot.shelf.name : "—";
    $("t-odo").textContent = Math.round(robot.odometer);
    $("cmd-text").textContent = `${robot.command.name}(${robot.command.args})`;
    $("cmd-state").textContent = robot.command.state;
    $("cmd-state").dataset.state = robot.command.state;
    $("lidar-near").textContent = robot.scan.nearest.toFixed(2);
    const det = robot.detections.length
      ? robot.detections.map((o) => `<li data-label="${o.label}">${o.label}${o.label === "ROBOT" ? ` ${o.extra}` : ""} ${o.distance.toFixed(1)} m · ${o.score.toFixed(2)}</li>`).join("")
      : '<li class="muted">無</li>';
    if (det !== this.lastDet) {
      this.lastDet = det;
      $("detect-list").innerHTML = det;
    }
  }

  #renderElevator() {
    const { elevator: el, lift } = this.w;
    const target = Math.round(el.targetY / FLOOR_GAP);
    for (const li of $("elev-floors").children) {
      const i = Number(li.dataset.floor);
      li.dataset.cab = String(i === el.floor);
      li.dataset.target = String(el.moving && i === target);
      li.dataset.call = String(el.calls[i]);
    }
    const door = { open: "門開啟", closed: "門關閉", opening: "開門中", closing: "關門中" }[el.doorState()];
    const dir = el.direction > 0 ? "↑ 上行" : el.direction < 0 ? "↓ 下行" : "";
    const rider = lift.current && lift.current.boarded && !lift.current.done ? lift.current.robot : null;
    $("elev-state").innerHTML = `${FLOORS[el.floor].id} · ${dir || door}${rider ? ` · ${chip(rider)}搭乘中` : ""}`;
    const order = lift.order();
    const now = this.w.sim.time;
    const html = order.length
      ? order
          .map((t, i) => {
            const serving = t === lift.current;
            const state = serving ? (t.boarded ? "搭乘中" : "請進入") : t.ready ? `等候點 #${t.spot + 1}・${mmss(now - t.readyAt)}` : "前往電梯廳";
            return `<li data-serving="${serving}"><span class="q-n">${serving ? "▶" : i + 1}</span>${chip(t.robot)}<b>${FLOORS[t.from].id}→${FLOORS[t.to].id}</b><small>P${t.robot.priority > 4 ? "-" : t.robot.priority} · ${state}</small></li>`;
          })
          .join("")
      : '<li class="muted">無排隊</li>';
    if (html !== this.lastQueue) {
      this.lastQueue = html;
      $("elev-queue").innerHTML = html;
    }
  }

  // the sensor worth showing: the one on the inspected robot, else the latest active one
  #displaySensor(robot) {
    const sensors = Object.values(this.w.sensors);
    const own = sensors.find((s) => s.cart === robot.shelf && s.state !== "idle");
    if (own) return own;
    const active = sensors.filter((s) => s.state !== "idle" && s.bed).sort((a, b) => b.startedAt - a.startedAt);
    return active[0] || this.lastSensor || sensors[0];
  }

  #renderVitals(robot) {
    const s = this.#displaySensor(robot);
    this.lastSensor = s;
    const state = s.state;
    const pill = $("vs-state");
    pill.textContent = `${s.id} ${SENSOR_STATE[state]}`;
    pill.dataset.kind = { idle: "idle", detect: "detect", measure: "measure", upload: "move", done: "ok" }[state];
    if (state === "done" && s.last) pill.dataset.kind = s.last.level;
    if (s.bed && s.patient) {
      const p = s.patient.data;
      $("vs-bed").textContent = s.bed.id;
      $("vs-floor").textContent = FLOORS[s.bed.floor].id;
      $("vs-name").textContent = `${p.name}・${p.sex}・${p.age} 歲`;
      $("vs-meta").textContent =
        state === "done" && s.last ? `判讀：${s.last.label}${s.last.flags.length ? `（${s.last.flags.join("、")}）` : ""}` : `${s.robot ? s.robot.id : ""} 量測中・去識別化住民資料（模擬）`;
    }
    $("vs-hr").textContent = s.hr ?? "--";
    $("vs-rr").textContent = s.rr ?? "--";
    $("vs-dist").textContent = s.distance ? s.distance.toFixed(2) : "--";
    $("vs-sqi").textContent = s.sqi ? `${Math.round(s.sqi * 100)}%` : "--";
    const prog = state === "measure" ? s.elapsed / s.duration : state === "upload" || state === "done" ? 1 : 0;
    $("vs-time").textContent = `${Math.round(state === "done" || state === "upload" ? MEASURE_SECONDS : s.elapsed)} / ${MEASURE_SECONDS} s`;
    $("vs-prog").style.setProperty("--v", prog.toFixed(3));

    // one compact row per cart
    const units = Object.values(this.w.sensors)
      .map((x) => {
        const carrier = x.cart.robot;
        const where = x.bed && x.state !== "idle" ? `${x.bed.id} ${SENSOR_STATE[x.state]}${x.state === "measure" ? ` ${Math.round(x.elapsed)}/${MEASURE_SECONDS}s` : ""}` : carrier ? "隨車移動" : `${FLOORS[x.floor].id} 被服室待命`;
        const vals = x.hr || x.rr ? `<span class="u-val"><b class="hr">${x.hr ?? "--"}</b><b class="rr">${x.rr ?? "--"}</b></span>` : "";
        return `<li data-state="${x.state}" data-on="${x === s}"><b>${x.id}</b>${chip(carrier)}<span class="u-where">${where}</span>${vals}</li>`;
      })
      .join("");
    if (units !== this.lastUnits) {
      this.lastUnits = units;
      $("vs-units").innerHTML = units;
    }

    // vitals tags above the beds being measured
    for (const [x, item] of this.sensorLabels) {
      const show = x.bed && (x.state === "measure" || x.state === "upload" || (x.state === "done" && (this.vitalsHold.get(x) || 0) > 0));
      item.hidden = !show;
      if (show) {
        const html = `<span class="hr">♥ ${x.hr ?? "--"}</span><span class="rr">RR ${x.rr ?? "--"}</span>`;
        if (item.html !== html) {
          item.html = html;
          item.el.innerHTML = html;
        }
      }
    }
  }

  #renderNow(robot) {
    const { elevator } = this.w;
    if (!robot) return;
    const a = robot.activity;
    const ic = $("now-ic");
    ic.dataset.kind = a.kind;
    const use = ic.querySelector("use");
    const icon = ICONS[a.kind] || "i-robot";
    if (use.getAttribute("href") !== `#${icon}`) use.setAttribute("href", `#${icon}`);
    if (this.nowRobot !== robot) {
      this.nowRobot = robot;
      const c = $("now-chip");
      c.textContent = robot.id;
      c.style.setProperty("--rc", robot.css);
    }
    $("now-title").textContent = a.detail ? `${a.label} · ${a.detail}` : a.label;
    const t = robot.task || robot.assignment;
    const wait = robot.waitInfo || robot.yieldInfo;
    let detail = t ? `${t.title}：${t.step || "準備中"}` : robot.needCharge ? `低電量充電，充到 ${settings.resumeBattery}% 後再接單` : "待命中，可隨時派工";
    if (wait) detail = `${wait.label} · ${detail}`;
    let metric = "";
    let progress = t ? t.progress : robot.battery / 100;
    if (robot.inElevator && robot.rideTarget !== null) {
      const arrow = elevator.direction > 0 ? "↑ 上行" : elevator.direction < 0 ? "↓ 下行" : "停靠";
      detail = `電梯 ${FLOORS[elevator.floor].id} ${arrow} · 目的地 ${FLOORS[robot.rideTarget].id}`;
    }
    const s = this.fleet.sensorOf(robot);
    const measuring = s && s.bed && (s.state === "measure" || s.state === "upload" || s.state === "detect");
    if (measuring || (a.kind === "alert" && s && s.last)) {
      metric = `<span class="hr">♥ ${s.hr ?? "--"}<small>bpm</small></span><span class="rr">${s.rr ?? "--"}<small>次/分</small></span>`;
      if (s.state === "measure") progress = s.elapsed / s.duration;
    } else if (Math.abs(robot.v) > 0.02) {
      metric = `<span>${Math.abs(robot.v).toFixed(2)}<small>m/s</small></span>`;
    } else if (a.kind === "charge" || robot.onCharger) {
      metric = `<span>${Math.round(robot.battery)}<small>%</small></span>`;
    }
    $("now-detail").textContent = detail;
    const m = $("now-metric");
    if (m.innerHTML !== metric) m.innerHTML = metric;
    $("now-prog").style.setProperty("--v", Math.min(1, progress).toFixed(3));

    // stage HUD: floor of the framed robot
    const floor = robot.inElevator ? elevator.floor : robot.floor;
    const f = FLOORS[floor];
    $("hud-floor").textContent = f.id;
    $("hud-floor-name").textContent = f.name;
    $("floor-badge").style.setProperty("--floor-color", f.css);
  }

  #drawLidar() {
    const robot = this.detailRobot;
    if (!robot) return;
    const c = this.lidarCanvas;
    const r = c.getBoundingClientRect();
    if (r.width < 4) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    if (!this.lidarSize || this.lidarSize !== `${r.width}x${r.height}`) {
      this.lidarSize = `${r.width}x${r.height}`;
      c.width = Math.round(r.width * dpr);
      c.height = Math.round(r.height * dpr);
    }
    if (!this.lidarColors) this.lidarColors = { line: css("--line"), robot: css(`--robot-${robot.def.slot}`), hit: css("--crit"), ink: css("--ink-3"), fan: css("--accent") };
    const col = this.lidarColors;
    const g = c.getContext("2d");
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    const w = r.width;
    const h = r.height;
    g.clearRect(0, 0, w, h);
    const cx = w / 2;
    const cy = h * 0.66;
    const scale = (h * 0.6) / 3;
    g.strokeStyle = col.line;
    g.lineWidth = 1;
    g.setLineDash([3, 4]);
    g.fillStyle = col.ink;
    g.font = "10px 'JetBrains Mono', monospace";
    for (const m of [1, 2, 3]) {
      g.beginPath();
      g.arc(cx, cy, m * scale, 0, Math.PI * 2);
      g.stroke();
      g.fillText(`${m}m`, cx + 3, cy - m * scale + 11);
    }
    g.setLineDash([]);
    const L = KACHAKA.lidar;
    const ranges = robot.scan.ranges;
    // free-space polygon + hits (robot frame, forward = up)
    const ox = cx;
    const oy = cy - L.x * scale;
    g.beginPath();
    g.moveTo(ox, oy);
    for (let i = 0; i < L.rays; i++) {
      const ang = -L.fov / 2 + (i * L.fov) / (L.rays - 1);
      const d = ranges[i];
      g.lineTo(ox - Math.sin(ang) * d * scale, oy - Math.cos(ang) * d * scale);
    }
    g.closePath();
    g.globalAlpha = 0.12;
    g.fillStyle = col.fan;
    g.fill();
    g.globalAlpha = 1;
    g.fillStyle = col.hit;
    for (let i = 0; i < L.rays; i++) {
      const d = ranges[i];
      if (d >= L.range) continue;
      const ang = -L.fov / 2 + (i * L.fov) / (L.rays - 1);
      g.fillRect(ox - Math.sin(ang) * d * scale - 1.2, oy - Math.cos(ang) * d * scale - 1.2, 2.4, 2.4);
    }
    // robot footprint (387 x 240 mm, origin 148 mm from the rear)
    g.fillStyle = col.robot;
    g.beginPath();
    g.roundRect(cx - 0.12 * scale, cy - 0.24 * scale, 0.24 * scale, 0.388 * scale, 3);
    g.fill();
    if (robot.shelf) {
      g.strokeStyle = col.robot;
      g.lineWidth = 1.2;
      g.strokeRect(cx - 0.21 * scale, cy - 0.21 * scale, 0.42 * scale, 0.42 * scale);
    }
  }
}
