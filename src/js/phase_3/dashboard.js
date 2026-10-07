import { FLOORS, FLOOR_GAP, KACHAKA, MEASURE_SECONDS } from "./config.js";
import { on, formatClock } from "./sim.js";
import { TASKS } from "./missions.js";

const $ = (id) => document.getElementById(id);
const WEEK = ["日", "一", "二", "三", "四", "五", "六"];
const TAGS = { api: "API", lift: "電梯", vitals: "量測", alert: "通報", staff: "人員", nav: "導航" };
const ICONS = { measure: "i-heart", lift: "i-lift", alert: "i-alert", charge: "i-battery", dock: "i-box", handoff: "i-box", patrol: "i-shield", move: "i-pin", idle: "i-robot" };
const STATE_KIND = { move: "move", dock: "dock", handoff: "dock", measure: "measure", lift: "lift", alert: "alert", charge: "charge", patrol: "move", idle: "idle" };

function css(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

// --- bedside-monitor style sweep: the trace is redrawn left to right with an erase gap ---
class Sweep {
  constructor(canvas, colorVar) {
    this.canvas = canvas;
    this.colorVar = colorVar;
    this.x = 0;
    this.acc = 0;
    this.lastY = null;
    this.speed = 62;
    this.resize();
  }

  resize() {
    const r = this.canvas.getBoundingClientRect();
    if (r.width < 4) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.canvas.width = Math.round(r.width * dpr);
    this.canvas.height = Math.round(r.height * dpr);
    this.w = r.width;
    this.h = r.height;
    this.ctx = this.canvas.getContext("2d");
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.colors();
    this.ctx.fillStyle = this.bg;
    this.ctx.fillRect(0, 0, this.w, this.h);
    this.x = 0;
    this.lastY = null;
  }

  colors() {
    this.bg = css("--monitor-bg");
    this.fg = css(this.colorVar);
    this.dim = css("--monitor-grid");
  }

  step(dt, t, sample) {
    if (!this.ctx) return;
    this.acc += this.speed * dt;
    const n = Math.min(Math.floor(this.acc), 40);
    this.acc -= Math.floor(this.acc);
    const g = this.ctx;
    for (let i = 0; i < n; i++) {
      const v = sample(t - (n - 1 - i) / this.speed);
      const y = v === null ? this.h * 0.5 : this.h * 0.5 - v * this.h * 0.4;
      g.fillStyle = this.bg;
      g.fillRect(this.x, 0, 12, this.h);
      if (this.x + 12 > this.w) g.fillRect(0, 0, this.x + 12 - this.w, this.h);
      g.strokeStyle = v === null ? this.dim : this.fg;
      g.lineWidth = v === null ? 1 : 1.7;
      g.beginPath();
      g.moveTo(this.x - 1, this.lastY ?? y);
      g.lineTo(this.x, y);
      g.stroke();
      this.lastY = y;
      this.x++;
      if (this.x >= this.w) {
        this.x = 0;
        this.lastY = null;
      }
    }
  }
}

export class Dashboard {
  constructor(world) {
    this.w = world;
    this.timer = 0;
    this.t = 0;
    this.logCount = 0;
    this.floorLabels = [];
    this.vitalsLabel = null;
    this.alertLabel = null;
    this.vitalsHold = 0;

    this.waves = { hr: new Sweep($("wave-hr"), "--hr"), rr: new Sweep($("wave-rr"), "--rr") };
    this.lidarCanvas = $("lidar");
    this.#bindControls();
    this.#buildTasks();
    this.#renderHistory();
    this.#bindEvents();
    this.#buildLabels();
    this.#themeWatch();
    const ro = new ResizeObserver(() => {
      this.waves.hr.resize();
      this.waves.rr.resize();
      this.lidarSize = null;
    });
    ro.observe($("wave-hr"));
    ro.observe(this.lidarCanvas);
    this.refresh();
  }

  // ------------------------------------------------------------ controls
  #bindControls() {
    const { sim } = this.w;
    const speedButtons = [...document.querySelectorAll("[data-speed]")];
    const setSpeed = (v) => {
      if (v === 0) sim.paused = !sim.paused;
      else {
        sim.paused = false;
        sim.speed = v;
      }
      for (const b of speedButtons) {
        const s = Number(b.dataset.speed);
        b.setAttribute("aria-pressed", String(s === 0 ? sim.paused : !sim.paused && s === sim.speed));
      }
    };
    for (const b of speedButtons) b.addEventListener("click", () => setSpeed(Number(b.dataset.speed)));

    const camButtons = [...document.querySelectorAll("[data-cam]")];
    const reflect = (mode) => camButtons.forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.cam === mode)));
    for (const b of camButtons) b.addEventListener("click", () => this.w.camera.setMode(b.dataset.cam));
    this.w.camera.onModeChange = (mode) => {
      reflect(mode);
      if (mode === "free") $("hud-hint").dataset.hide = "true";
    };
    reflect("auto");
    setTimeout(() => ($("hud-hint").dataset.hide = "true"), 9000);
  }

  #buildTasks() {
    const ol = $("tasks");
    ol.innerHTML = "";
    this.taskEls = TASKS.map((t, i) => {
      const li = document.createElement("li");
      li.innerHTML = `<button type="button" class="task" id="task-${t.id}" data-state="queued">
        <span class="t-ic"><svg><use href="#${t.icon}"></use></svg></span>
        <span class="t-main"><b>${t.name}</b><small data-time></small></span>
        <span class="t-prog"><i></i></span>
        <span class="t-step"></span>
      </button>`;
      const btn = li.firstElementChild;
      btn.addEventListener("click", () => this.w.missions.jumpTo(i));
      ol.appendChild(li);
      return {
        btn,
        time: btn.querySelector("[data-time]"),
        bar: btn.querySelector(".t-prog i"),
        step: btn.querySelector(".t-step"),
      };
    });
    this.#renderTasks();
  }

  #renderTasks() {
    const m = this.w.missions;
    TASKS.forEach((t, i) => {
      const el = this.taskEls[i];
      const s = m.states[i];
      const [hh, mm] = m.timeFor(i);
      el.btn.dataset.state = s.state;
      el.btn.setAttribute("aria-current", s.state === "active" ? "step" : "false");
      el.time.textContent = `${String(hh % 24).padStart(2, "0")}:${String(mm).padStart(2, "0")} · ${t.route}`;
      el.bar.style.setProperty("--v", s.progress.toFixed(3));
      el.step.textContent = s.state === "queued" ? "排程中" : s.step;
    });
    $("cycle").textContent = `第 ${m.cycle} 輪`;
  }

  // ------------------------------------------------------------- events
  #bindEvents() {
    on("log", (e) => this.#log(e));
    on("tasks", () => this.#renderTasks());
    on("kpi", () => this.#renderKpi());
    on("measurement", () => this.#renderHistory());
    on("alert", (a) => this.#renderAlert(a));
    on("ride", () => {
      this.w.missions.kpi.rides++;
      this.#renderKpi();
    });
    on("speech", (s) => this.#speech(s));
    on("activity", () => this.#robotTag());
    on("vitals", (v) => {
      if (v.phase === "done") this.vitalsHold = 5;
    });
  }

  #log({ tag, html }) {
    const ol = $("log");
    const li = document.createElement("li");
    li.dataset.tag = tag;
    li.dataset.new = "true";
    if (tag === "sep") li.innerHTML = `<span>— ${html} —</span>`;
    else
      li.innerHTML = `<time>${formatClock(this.w.sim.clock)}</time><span class="tag" data-tag="${tag}">${TAGS[tag] || tag}</span><span class="msg">${html}</span>`;
    ol.prepend(li);
    setTimeout(() => (li.dataset.new = "false"), 600);
    while (ol.children.length > 80) ol.lastElementChild.remove();
  }

  #renderKpi() {
    const k = this.w.missions.kpi;
    $("kpi-beds").textContent = k.beds;
    $("kpi-alerts").textContent = k.alerts;
    $("kpi-deliveries").textContent = k.deliveries;
    $("kpi-rides").textContent = k.rides;
    $("kpi-minutes").textContent = k.minutes;
  }

  #renderHistory() {
    const rows = this.w.missions.history.slice(0, 14);
    $("vs-history").innerHTML = rows
      .map(
        (r) => `<tr data-new="${r.fresh ? "true" : "false"}"><td>${formatClock(r.clock, false)}</td><td>${r.floor} ${r.bed}</td>
        <td><b>${r.hr}</b></td><td><b>${r.rr}</b></td><td><span class="chip" data-level="${r.level}">${r.label}</span></td></tr>`,
      )
      .join("");
    for (const r of rows) r.fresh = false;
  }

  #renderAlert(a) {
    const box = $("vs-alert");
    if (!a) {
      box.hidden = true;
      if (this.alertLabel) this.alertLabel.hidden = true;
      return;
    }
    box.hidden = false;
    box.style.borderLeftColor = a.resolved ? "var(--ok)" : "";
    $("alert-title").textContent = `${a.floor} ${a.bed} ${a.flags.join("、")}`;
    $("alert-detail").textContent = `${formatClock(a.clock, false)} · ${a.status}`;
    if (this.alertLabel) {
      this.alertLabel.hidden = a.resolved;
      this.alertLabel.el.innerHTML = `<svg><use href="#i-alert"></use></svg>${a.bed} ${a.flags[0]}`;
      const bed = this.w.hospital.beds.get(a.bed);
      this.alertBed = bed;
    }
  }

  #speech({ who, name, text }) {
    const { robot, staff, patients, labels } = this.w;
    if (who === "robot") {
      labels.bubble("robot", { anchor: (v) => robot.anchor(v).setY(robot.y + (robot.shelf ? 1.45 : 0.75)), floor: null, text, kind: "robot", name });
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
  #buildLabels() {
    const { labels, robot, hospital, sensor } = this.w;
    this.robotLabel = labels.add({
      className: "lbl-robot",
      html: "<i></i><span>Kachaka</span>",
      anchor: (v) => robot.anchor(v).setY(robot.y + (robot.shelf ? 1.18 : 0.42)),
      offsetY: -4,
    });
    FLOORS.forEach((f, i) => {
      this.floorLabels.push(
        labels.add({
          className: "lbl-floor",
          html: `<b style="background:${f.css}">${f.id}</b><span>${f.name}</span>`,
          anchor: (v) => v.set(9.3, i * FLOOR_GAP + 0.05, 5.25),
          floor: i,
          dimWhenFaded: true,
        }),
      );
    });
    this.vitalsLabel = labels.add({
      className: "lbl-vitals",
      html: "",
      anchor: (v) => (sensor.bed ? sensor.chestWorld(v).setY(sensor.bed.floor * FLOOR_GAP + 1.25) : v.set(0, -99, 0)),
      floor: () => (sensor.bed ? sensor.bed.floor : 0),
    });
    this.vitalsLabel.hidden = true;
    this.alertLabel = labels.add({
      className: "lbl-alert",
      html: "",
      anchor: (v) => (this.alertBed ? v.set(this.alertBed.x, this.alertBed.floor * FLOOR_GAP + 1.55, this.alertBed.z - 0.4) : v.set(0, -99, 0)),
      floor: () => (this.alertBed ? this.alertBed.floor : 0),
    });
    this.alertLabel.hidden = true;
    this.#robotTag();
  }

  #robotTag() {
    const a = this.w.robot.activity;
    if (!this.robotLabel) return;
    this.robotLabel.el.dataset.kind = a.kind;
    this.robotLabel.el.innerHTML = `<i></i><span>Kachaka · ${a.label}</span>`;
  }

  #themeWatch() {
    const refresh = () => {
      this.waves.hr.colors();
      this.waves.rr.colors();
      this.lidarColors = null;
    };
    window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", refresh);
    new MutationObserver(refresh).observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
  }

  // ------------------------------------------------------------- frame
  update(realDt) {
    this.t += realDt;
    const { sensor } = this.w;
    this.waves.hr.step(realDt, this.t, (t) => {
      const s = sensor.waveform(t);
      return s ? s.hr : null;
    });
    this.waves.rr.step(realDt, this.t, (t) => {
      const s = sensor.waveform(t);
      return s ? s.rr : null;
    });
    this.vitalsHold = Math.max(0, this.vitalsHold - realDt);
    this.timer += realDt;
    if (this.timer > 0.12) {
      this.timer = 0;
      this.refresh();
      this.#drawLidar();
    }
  }

  refresh() {
    const { robot, sensor, elevator, missions, sim } = this.w;
    // clock
    const clock = sim.clock;
    $("clock").textContent = formatClock(clock);
    $("hud-clock").textContent = `${formatClock(clock, false)} · ${sim.paused ? "暫停" : `${sim.speed}× 模擬`}`;
    const d = new Date();
    $("date").textContent = `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, "0")}/${String(d.getDate()).padStart(2, "0")}（${WEEK[d.getDay()]}）`;

    // robot panel
    const a = robot.activity;
    const pill = $("robot-state");
    pill.textContent = a.label;
    pill.dataset.kind = STATE_KIND[a.kind] || "idle";
    const pct = Math.round(robot.battery);
    $("bat-pct").textContent = `${pct}%`;
    $("bat-bar").style.setProperty("--v", (robot.battery / 100).toFixed(3));
    $("bat-mode").textContent = robot.onCharger ? (pct >= 100 ? "已充飽" : "充電中") : `放電中・約 ${Math.max(1, (robot.battery / 10).toFixed(1))} h`;
    $("t-speed").textContent = Math.abs(robot.v).toFixed(2);
    const floor = robot.inElevator ? elevator.floor : robot.floor;
    $("t-floor").textContent = FLOORS[floor].id;
    $("t-map").textContent = FLOORS[robot.floor].map;
    const deg = Math.round(((robot.yaw * 180) / Math.PI + 360) % 360);
    $("t-pose").textContent = `${robot.x.toFixed(2)}, ${(-robot.z).toFixed(2)}, ${deg}°`;
    $("t-shelf").textContent = robot.shelf ? `${robot.shelf.name}` : "—";
    $("t-odo").textContent = Math.round(robot.odometer);
    $("cmd-text").textContent = `${robot.command.name}(${robot.command.args})`;
    $("cmd-state").textContent = robot.command.state;
    $("cmd-state").dataset.state = robot.command.state;
    $("lidar-near").textContent = robot.scan.nearest.toFixed(2);
    $("detect-list").innerHTML = robot.detections.length
      ? robot.detections.map((o) => `<li data-label="${o.label}">${o.label} ${o.distance.toFixed(1)} m · ${o.score.toFixed(2)}</li>`).join("")
      : '<li class="muted">無</li>';
    this.#renderElevator();

    // KPIs that change continuously
    $("kpi-km").textContent = (robot.odometer / 1000).toFixed(2);

    // vitals panel
    this.#renderVitals();

    // stage HUD
    const f = FLOORS[floor];
    $("hud-floor").textContent = f.id;
    $("hud-floor-name").textContent = f.name;
    $("floor-badge").style.setProperty("--floor-color", f.css);
    this.#renderNow();
  }

  #renderElevator() {
    const el = this.w.elevator;
    const target = Math.round(el.targetY / FLOOR_GAP);
    for (const li of $("elev-floors").children) {
      const i = Number(li.dataset.floor);
      li.dataset.cab = String(i === el.floor);
      li.dataset.target = String(el.moving && i === target);
    }
    const door = { open: "門開啟", closed: "門關閉", opening: "開門中", closing: "關門中" }[el.doorState()];
    const dir = el.direction > 0 ? "↑ 上行" : el.direction < 0 ? "↓ 下行" : "";
    $("elev-state").textContent = `${FLOORS[el.floor].id} · ${dir || door}${el.occupied ? " · 機器人搭乘中" : ""}`;
  }

  #renderVitals() {
    const s = this.w.sensor;
    const state = s.state;
    const pill = $("vs-state");
    const labels = { idle: "待命", detect: "偵測目標", measure: "量測中", upload: "上傳中", done: "已上傳" };
    pill.textContent = labels[state];
    pill.dataset.kind = { idle: "idle", detect: "detect", measure: "measure", upload: "move", done: "ok" }[state];
    if (state === "done" && s.last) pill.dataset.kind = s.last.level;
    if (s.bed && s.patient) {
      const p = s.patient.data;
      $("vs-bed").textContent = s.bed.id;
      $("vs-floor").textContent = FLOORS[s.bed.floor].id;
      $("vs-name").textContent = `${p.name}・${p.sex}・${p.age} 歲`;
      $("vs-meta").textContent = state === "done" && s.last ? `判讀：${s.last.label}${s.last.flags.length ? `（${s.last.flags.join("、")}）` : ""}` : "去識別化床位資料（模擬）";
    }
    $("vs-hr").textContent = s.hr ?? "--";
    $("vs-rr").textContent = s.rr ?? "--";
    $("vs-dist").textContent = s.distance ? s.distance.toFixed(2) : "--";
    $("vs-sqi").textContent = s.sqi ? `${Math.round(s.sqi * 100)}%` : "--";
    const prog = state === "measure" ? s.elapsed / s.duration : state === "upload" || state === "done" ? 1 : 0;
    $("vs-time").textContent = `${Math.round(state === "done" || state === "upload" ? MEASURE_SECONDS : s.elapsed)} / ${MEASURE_SECONDS} s`;
    $("vs-prog").style.setProperty("--v", prog.toFixed(3));

    // vitals tag above the bed
    const show = state === "measure" || state === "upload" || (state === "done" && this.vitalsHold > 0);
    this.vitalsLabel.hidden = !show;
    if (show) this.vitalsLabel.el.innerHTML = `<span class="hr">♥ ${s.hr ?? "--"}</span><span class="rr">RR ${s.rr ?? "--"}</span>`;
  }

  #renderNow() {
    const { robot, sensor, elevator, missions } = this.w;
    const a = robot.activity;
    const ic = $("now-ic");
    ic.dataset.kind = a.kind;
    const use = ic.querySelector("use");
    const icon = ICONS[a.kind] || "i-robot";
    if (use.getAttribute("href") !== `#${icon}`) use.setAttribute("href", `#${icon}`);
    $("now-title").textContent = a.detail ? `${a.label} · ${a.detail}` : a.label;
    const st = missions.states[missions.index];
    let detail = `${TASKS[missions.index].name}：${st.step}`;
    let metric = "";
    let progress = st.progress;
    if (robot.inElevator && robot.rideTarget !== null) {
      const arrow = elevator.direction > 0 ? "↑ 上行" : elevator.direction < 0 ? "↓ 下行" : "停靠";
      detail = `電梯 ${FLOORS[elevator.floor].id} ${arrow} · 目的地 ${FLOORS[robot.rideTarget].id}`;
    }
    const measuring = sensor.bed && (sensor.state === "measure" || sensor.state === "upload" || sensor.state === "detect");
    if (measuring || (a.kind === "alert" && sensor.last)) {
      metric = `<span class="hr">♥ ${sensor.hr ?? "--"}<small>bpm</small></span><span class="rr">${sensor.rr ?? "--"}<small>次/分</small></span>`;
      if (sensor.state === "measure") progress = sensor.elapsed / sensor.duration;
    } else if (Math.abs(robot.v) > 0.02) {
      metric = `<span>${Math.abs(robot.v).toFixed(2)}<small>m/s</small></span>`;
    } else if (a.kind === "charge") {
      metric = `<span>${Math.round(robot.battery)}<small>%</small></span>`;
    }
    $("now-detail").textContent = detail;
    const m = $("now-metric");
    if (m.innerHTML !== metric) m.innerHTML = metric;
    $("now-prog").style.setProperty("--v", Math.min(1, progress).toFixed(3));
  }

  #drawLidar() {
    const c = this.lidarCanvas;
    const r = c.getBoundingClientRect();
    if (r.width < 4) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    if (!this.lidarSize || this.lidarSize !== `${r.width}x${r.height}`) {
      this.lidarSize = `${r.width}x${r.height}`;
      c.width = Math.round(r.width * dpr);
      c.height = Math.round(r.height * dpr);
    }
    if (!this.lidarColors) this.lidarColors = { bg: css("--surface-2"), line: css("--line"), robot: css("--robot"), hit: css("--crit"), ink: css("--ink-3"), fan: css("--accent") };
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
    const robot = this.w.robot;
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
