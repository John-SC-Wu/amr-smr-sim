import { FLOORS, ROBOT_DEFS, NURSE_MINUTES, START_CLOCK } from "./config.js";
import { Token, CancelError, emit, ignoreCancel, formatClock } from "./sim.js";
import { Kachaka } from "./kachaka.js";
import { chooseRobot, travelSeconds, robotPose } from "./dispatch.js";
import { EXECUTORS, TASK_TYPES } from "./tasks.js";
import { Metrics } from "./metrics.js";

// starting dock per fleet size; floor chargers put robots next to the care floors' work
const HOMES = {
  1: ["C1"],
  2: ["C1", "C3"],
  3: ["C1", "C3", "C4"],
  4: ["C1", "C2", "C3", "C4"],
  5: ["C1", "C2", "C3", "C4", "S1"],
};

const ROUND_GROUPS = {
  2: [
    ["301-A", "301-B", "302-A", "302-B"],
    ["303-A", "304-A", "304-B"],
  ],
  3: [
    ["401-A", "401-B", "402-A", "402-B"],
    ["403-A", "403-B", "404-A"],
  ],
};

// an earlier (simulated) night round, so the record table is not empty on load
const INITIAL_HISTORY = [
  { clock: 6 * 3600 + 18 * 60, bed: "402-B", floor: "4F", hr: 70, rr: 16, level: "ok", label: "正常" },
  { clock: 6 * 3600 + 14 * 60, bed: "402-A", floor: "4F", hr: 104, rr: 20, level: "warn", label: "注意" },
  { clock: 6 * 3600 + 10 * 60, bed: "401-B", floor: "4F", hr: 73, rr: 17, level: "ok", label: "正常" },
  { clock: 6 * 3600 + 6 * 60, bed: "401-A", floor: "4F", hr: 79, rr: 18, level: "ok", label: "正常" },
];

const fmtS = (s) => (s < 90 ? `${Math.round(s)} 秒` : `${(s / 60).toFixed(1)} 分`);
const pct = (r) => `${Math.round(r.battery)}%`;

export class Fleet {
  constructor(world) {
    this.w = world;
    this.sim = world.sim;
    this.settings = world.settings;
    this.lift = world.lift;
    this.traffic = world.traffic;
    this.hospital = world.hospital;
    this.robots = [];
    this.tasks = [];
    this.alerts = [];
    this.history = [];
    this.version = 0;
    this.token = null;
    this.restarting = false;
    this.ctx = {
      fleet: this,
      sim: world.sim,
      hospital: world.hospital,
      staff: world.staff,
      patients: world.patients,
      carts: world.carts,
      sensors: world.sensors,
    };
    this.metrics = new Metrics(this);
  }

  // ------------------------------------------------------------ lifecycle
  // seed: the same number replays the same day; script: extra timed events [{ at: clockSec, run(fleet) }]
  start({ seed = this.settings.seed, script = [] } = {}) {
    const token = (this.token = new Token());
    this.sim.reseed(seed);
    this.script = script.map((s) => ({ ...s, done: false }));
    this.seq = 0;
    this.rrLast = null;
    this.faultArmed = false;
    this.patrolCount = 0;
    this.deliveryTurn = 0;
    this.roundTurn = { 2: 0, 3: 0 };
    this.tasks = [];
    this.alerts = [];
    this.history = INITIAL_HISTORY.map((h) => ({ ...h }));
    this.kpi = {
      done: 0,
      waitSum: 0,
      waitN: 0,
      beds: 4,
      alerts: 0,
      deliveries: 0,
      patrols: 0,
      minutes: 4 * NURSE_MINUTES.vitals,
      preemptions: 0,
      handovers: 0,
      merged: 0,
      faults: 0,
    };
    this.#spawn(this.settings.robots);
    this.metrics.reset();
    this.#initSchedule();
    this.lift.run(token).catch(ignoreCancel);
    for (const r of this.robots) this.#robotLoop(r, token);
    this.#loop(token, 1, () => {
      this.dispatch();
      this.metrics.tick();
    });
    this.#loop(token, 2, () => this.#schedule());
    emit("log", { tag: "api", html: `已連線 ${this.robots.length} 台 Kachaka（gRPC :26400）・電梯系統・護理資訊系統 MQTT` });
    emit("fleet", { kind: "start" });
    this.#bump();
  }

  async restart(opts = {}) {
    if (this.restarting) return;
    this.restarting = true;
    this.token.cancel();
    this.sim.process();
    // let every cancelled script unwind before the world is reset under it
    await new Promise((r) => setTimeout(r, 0));
    const w = this.w;
    for (const r of this.robots) {
      w.scene.remove(r.group, r.overlays);
      r.dispose();
    }
    this.robots = [];
    w.elevator.reset(0);
    this.lift.reset();
    this.traffic.reset();
    for (const d of this.hospital.docks) d.occupant = d.reservedBy = null;
    for (const c of Object.values(w.carts)) c.resetHome();
    for (const m of w.meds) m.resetHome();
    for (const s of Object.values(w.sensors)) s.reset();
    for (const p of Object.values(w.staff)) {
      p.resetHome();
      p.onAvoid = null;
    }
    for (const p of w.patients.values()) {
      p.hr = p.data.hr;
      p.rr = p.data.rr;
    }
    w.labels.clearBubbles();
    this.sim.setClock(START_CLOCK);
    this.start(opts);
    emit("log", { tag: "sep", html: `重新開始：${this.robots.length} 台機器人` });
    this.restarting = false;
  }

  #spawn(n) {
    const w = this.w;
    const ids = HOMES[n] || HOMES[3];
    this.robots = ROBOT_DEFS.slice(0, n).map((def, i) => {
      const r = new Kachaka({ def, index: i, sim: this.sim, elevator: w.elevator, lift: this.lift, traffic: this.traffic, settings: this.settings });
      r.people = w.staffList;
      r.obstacleFn = () => [...Object.values(w.carts), ...w.meds];
      const dock = this.hospital.docks.find((d) => d.id === ids[i]);
      r.homeDock = dock.charger ? dock : null;
      r.placeAt(dock);
      dock.occupant = r;
      r.setActivity(dock.charger ? "charge" : "idle", dock.charger ? "充電待命" : "待命", dock.name);
      w.scene.add(r.group, r.overlays);
      return r;
    });
    for (const r of this.robots) r.others = this.robots;
  }

  async #loop(token, every, fn) {
    try {
      for (;;) {
        fn();
        await this.sim.wait(every, token);
      }
    } catch (err) {
      ignoreCancel(err);
    }
  }

  #bump() {
    this.version++;
    emit("tasks");
  }

  // -------------------------------------------------------------- tasks
  #newTask(type, fields) {
    const t = {
      id: `T-${String(++this.seq).padStart(3, "0")}`,
      type,
      state: "queued",
      robot: null,
      createdAt: this.sim.time,
      createdClock: this.sim.clock,
      explain: "",
      block: "",
      note: "",
      step: "",
      progress: 0,
      merged: [],
      parent: null,
      ...fields,
    };
    this.tasks.push(t);
    const keepDone = 12;
    const done = this.tasks.filter((x) => x.state === "done" || x.state === "merged-done");
    if (done.length > keepDone) {
      const drop = new Set(done.slice(0, done.length - keepDone));
      this.tasks = this.tasks.filter((x) => !drop.has(x));
    }
    emit("log", { tag: "dispatch", html: `新任務 <b>${t.id}</b>「${t.title}」P${t.priority}${t.by ? `・${t.by}` : ""}` });
    this.metrics.taskCreated(t);
    if (t.priority === 1) {
      t.urgent = true;
      this.metrics.event("p1", null, `${t.id} ${t.title}`);
    }
    this.#bump();
    if (!this.restarting) this.dispatch();
    return t;
  }

  addRounds(floor) {
    const k = this.roundTurn[floor]++ % 2;
    const beds = ROUND_GROUPS[floor][k].filter((id) => this.w.patients.has(id));
    this.#refreshVitals(beds, this.roundTurn[floor]);
    const cart = this.w.carts[floor];
    const fid = FLOORS[floor].id;
    return this.#newTask("rounds", {
      title: `${fid} 生命徵象巡房`,
      sub: `${beds.length} 床・${cart.id}`,
      floor,
      priority: 3,
      beds: [...beds],
      doneBeds: [],
      remeasureBeds: new Set(),
      start: { floor, x: cart.home.x, z: cart.home.z },
    });
  }

  addRemeasure(bedId, by = "") {
    const bed = this.hospital.beds.get(bedId);
    const cart = this.w.carts[bed.floor];
    return this.#newTask("remeasure", {
      title: `${bedId} 異常複測`,
      sub: `${FLOORS[bed.floor].id}・${this.w.patients.get(bedId).data.title}`,
      floor: bed.floor,
      priority: 2,
      bed: bedId,
      by,
      start: { floor: bed.floor, x: cart.home.x, z: cart.home.z },
    });
  }

  addDelivery({ floor, priority = 3, items = null, by = "" }) {
    const fid = FLOORS[floor].id;
    if (!items) {
      const beds = [...this.w.patients.values()].filter((p) => p.floor === floor);
      const p = beds[Math.floor(this.sim.next("orders") * beds.length)];
      items = [{ bed: p.bed.id, title: p.data.title }];
    }
    const med = this.w.meds[0].home;
    return this.#newTask("delivery", {
      title: priority === 1 ? `緊急用藥 → ${fid}` : `藥品配送 → ${fid}`,
      sub: items.map((it) => `${it.bed} ${it.title}`).join("、"),
      floor,
      priority,
      items,
      by,
      shelf: null,
      stage: "queued",
      loaded: false,
      loading: false,
      start: { floor: 0, x: med.x, z: med.z },
    });
  }

  addPatrol() {
    const cp = this.hospital.patrol;
    return this.#newTask("patrol", {
      title: "2F 失智專區巡視",
      sub: `${cp.length} 個巡檢點`,
      floor: 1,
      priority: 4,
      points: cp.map((c) => c.id),
      wander: this.patrolCount++ % 2 === 0,
      start: { floor: 1, x: cp[0].x, z: cp[0].z },
    });
  }

  // console + UI shortcuts for presenters
  quickAdd(kind) {
    if (kind === "delivery") return this.addDelivery({ floor: [3, 1, 2][this.deliveryTurn++ % 3], by: "手動新增" });
    if (kind === "stat") return this.addDelivery({ floor: this.sim.rand() < 0.5 ? 2 : 3, priority: 1, by: "手動新增・緊急" });
    if (kind === "patrol") return this.addPatrol();
    if (kind === "rounds") return this.addRounds(this.roundTurn[2] <= this.roundTurn[3] ? 2 : 3);
    if (kind === "peak") {
      for (const f of [1, 2, 3]) this.addDelivery({ floor: f, by: "尖峰情境" });
      return null;
    }
    if (kind === "battery") return this.drainDemo();
    if (kind === "fault") return this.injectFault();
    if (kind === "outage") return this.elevatorOutage();
    return null;
  }

  // ------------------------------------------------------------ exceptions
  // a robot stops on its route (obstacle / bumper / lost localisation) and waits for staff
  #faultCandidate(handoverOnly = false) {
    const staff = Object.values(this.w.staff);
    const ok = this.robots.filter(
      (r) =>
        !r.fault &&
        r.mode === "path" &&
        !r.ticket &&
        !r.inElevator &&
        (r.activity.kind === "move" || r.activity.kind === "patrol") &&
        !staff.some((p) => p.busy === r),
    );
    // prefer a robot whose job can be handed over (no furniture on board): that is the case worth showing
    const rank = (r) => (r.task ? (r.shelf ? 1 : 2) : 0);
    ok.sort((a, b) => rank(b) - rank(a) || a.index - b.index);
    if (handoverOnly && ok[0] && rank(ok[0]) < 2) return null;
    return ok[0] || null;
  }

  // with no robot on the move right now, the fault is armed for the next one that is
  injectFault(target = null, seconds = 150) {
    const r = target || this.#faultCandidate(true);
    if (r) return this.#fault(r, seconds);
    if (this.faultArmed) return null;
    this.faultArmed = true;
    emit("log", { tag: "alert", html: "已排定故障示範：下一台行進中的機器人將回報故障" });
    const token = this.token;
    const armedAt = this.sim.time;
    // wait (up to 2 min) for a robot whose job can be handed over, then take any moving robot
    const pick = () => this.#faultCandidate(this.sim.time - armedAt < 120);
    this.sim.until(pick, token).then(() => {
      this.faultArmed = false;
      const c = pick() || this.#faultCandidate();
      if (c) this.#fault(c, seconds);
    }, ignoreCancel);
    return null;
  }

  #fault(r, seconds) {
    r.fault = { since: this.sim.time, until: this.sim.time + seconds, prev: r.activity };
    r.hold = true;
    r.setFault(true);
    r.setActivity("fault", "故障・待人員協助", "前方障礙卡住（模擬）");
    this.kpi.faults++;
    this.metrics.event("fault", r, `${r.id} 故障停止`);
    emit("log", { tag: "alert", robot: r, html: `${r.id} 回報故障（前方障礙卡住，模擬）→ 通知 ${FLOORS[r.floor].id} 人員協助，暫停派工給 ${r.id}` });
    // after a short diagnosis window its work goes back to the fleet
    this.sim.wait(20, this.token).then(() => this.#faultHandover(r), ignoreCancel);
    this.sim.wait(seconds, this.token).then(() => this.#faultRecover(r), ignoreCancel);
    this.emitFault = r;
    this.#bump();
    emit("fault", { robot: r });
    return r;
  }

  #faultHandover(r) {
    if (!r.fault || !r.task) return;
    const t = r.task;
    if (r.shelf) {
      t.note = `${r.id} 故障，${r.shelf.id} 在車上，人員協助後由 ${r.id} 繼續`;
      emit("log", { tag: "dispatch", robot: r, html: `${t.id} 無法改派：${r.shelf.name} 在 ${r.id} 上，等待人員協助後繼續` });
      this.#bump();
      return;
    }
    if (r.taskToken) r.taskToken.cancel();
  }

  #faultRecover(r) {
    if (!r.fault) return;
    const prev = r.fault.prev;
    r.fault = null;
    r.hold = false;
    r.setFault(false);
    if (r.task) r.task.note = "";
    if (r.task) r.setActivity(prev.kind, prev.label, prev.detail);
    else r.setActivity("idle", "已復歸", "回到可派工狀態");
    this.metrics.event("recover", r, `${r.id} 復歸`);
    emit("log", { tag: "staff", robot: r, html: `${FLOORS[r.floor].id} 人員排除障礙，${r.id} 恢復運作` });
    this.#bump();
  }

  // the elevator goes into maintenance: the ride in progress finishes, new calls wait
  elevatorOutage(seconds = 240) {
    if (this.lift.outOfService) return null;
    this.lift.outageUntil = this.sim.time + seconds;
    this.lift.bump();
    this.metrics.event("outage", null, `電梯停用 ${Math.round(seconds / 60)} 分鐘`);
    emit("log", { tag: "alert", html: `電梯系統回報：維護停用 ${Math.round(seconds / 60)} 分鐘 → 跨樓層任務暫停，同樓層任務照常` });
    this.sim.wait(seconds, this.token).then(() => {
      this.metrics.event("outage-end", null, "電梯恢復");
      emit("log", { tag: "lift", html: "電梯恢復服務，依排程策略消化等候中的機器人" });
      this.lift.bump();
    }, ignoreCancel);
    this.#bump();
    return true;
  }

  // demo: drop a working robot below the critical threshold to show the hand-over
  drainDemo() {
    const S = this.settings;
    const busy = this.robots.filter((r) => r.task && !r.preemptFor && TASK_TYPES[r.task.type].preemptible);
    const pool = busy.length ? busy : this.robots.filter((r) => r.task);
    const r = (pool.length ? pool : this.robots).slice().sort((a, b) => b.battery - a.battery)[0];
    if (!r) return null;
    r.battery = Math.max(3, S.criticalBattery - 2);
    emit("log", { tag: "charge", robot: r, html: `示範：${r.id} 電量降至 ${pct(r)}（低於強制回充 ${S.criticalBattery}%）` });
    return r;
  }

  #refreshVitals(beds, turn) {
    for (const id of beds) {
      const p = this.w.patients.get(id);
      p.hr = p.data.hr + Math.round(this.sim.keyed(id, turn, "hr") * 6 - 3);
      p.rr = p.data.rr + Math.round(this.sim.keyed(id, turn, "rr") * 2 - 1);
    }
    const odd = turn % 2 === 1;
    const set = (id, v) => beds.includes(id) && Object.assign(this.w.patients.get(id), v);
    set("302-B", odd ? { hr: 98, rr: 27 } : { hr: 92, rr: 22 });
    set("402-A", odd ? { hr: 113, rr: 22 } : { hr: 106, rr: 20 });
    // later rounds: now and then another resident reads high (varies with the scenario seed)
    if (turn > 1) {
      for (const id of beds) {
        if (id === "302-B" || id === "402-A" || this.sim.keyed(id, turn, "high") > 0.08) continue;
        const p = this.w.patients.get(id);
        const v = this.sim.keyed(id, turn, "value");
        if (this.sim.keyed(id, turn, "sign") < 0.5) p.hr = 111 + Math.round(v * 7);
        else p.rr = 25 + Math.round(v * 3);
      }
    }
  }

  #initSchedule() {
    const at = (h, m) => h * 3600 + m * 60;
    this.plan = [
      { next: at(8, 0), every: () => this.settings.roundsEvery, run: () => (this.#scheduled("rounds", 2), this.#scheduled("rounds", 3)) },
      {
        next: at(8, 1),
        once: true,
        run: () => this.addDelivery({ floor: 2, items: [{ bed: "302-B", title: "張伯伯" }], by: "3F 護理站派單" }),
      },
      {
        next: at(8, 3),
        once: true,
        run: () => this.addDelivery({ floor: 3, items: [{ bed: "403-B", title: "楊奶奶" }], by: "4F 護理站派單" }),
      },
      // ward orders arrive irregularly around the configured interval; the seed decides the day
      { key: "delivery", next: at(8, 3) + this.settings.deliveryEvery * 60, every: () => this.settings.deliveryEvery, jitter: 0.45, run: () => this.addDelivery({ floor: this.#orderFloor(), by: "護理站派單" }) },
      { key: "patrol", next: at(8, 12), every: () => this.settings.patrolEvery, jitter: 0.2, run: () => this.#scheduled("patrol", 1) },
    ];
  }

  // care floors order more than the dementia unit
  #orderFloor() {
    const x = this.sim.next("orders");
    return x < 0.2 ? 1 : x < 0.6 ? 2 : 3;
  }

  // a periodic job whose previous run has not even started yet is not queued twice
  #scheduled(type, floor) {
    const waiting = this.tasks.find((t) => t.type === type && t.floor === floor && t.state === "queued");
    if (waiting) {
      emit("log", { tag: "dispatch", html: `排程略過：<b>${waiting.id}</b>「${waiting.title}」尚未開始，不重複建立` });
      return null;
    }
    return type === "rounds" ? this.addRounds(floor) : this.addPatrol();
  }

  #schedule() {
    const now = this.sim.clock;
    for (const s of this.script) {
      if (s.done || now < s.at) continue;
      s.done = true;
      s.run(this);
    }
    for (const s of this.plan) {
      if (s.done || now < s.next) continue;
      if (s.once) {
        s.done = true;
        s.run();
        continue;
      }
      const every = s.every();
      if (every > 0) s.run();
      const spread = s.jitter ? 1 - s.jitter + 2 * s.jitter * this.sim.next(`plan-${s.key}`) : 1;
      s.next += Math.max(5, every || 30) * 60 * spread;
    }
  }

  // ----------------------------------------------------------- dispatch
  effPriority(t) {
    const S = this.settings;
    if (!S.agingMin || t.priority <= 2) return t.priority;
    const waited = (this.sim.time - t.createdAt) / 60;
    return Math.max(2, t.priority - Math.floor(waited / S.agingMin));
  }

  available(r) {
    const S = this.settings;
    return !r.fault && !r.task && !r.assignment && !r.preemptFor && !r.needCharge && !r.vacate && r.battery >= S.minDispatch;
  }

  #dctx() {
    return { lift: this.lift, robots: this.robots, settings: this.settings, rrLast: this.rrLast };
  }

  dispatch() {
    if (this.restarting) return;
    const S = this.settings;
    // a P1 reserved for a robot that has not reached a safe point yet goes to whoever frees up first
    for (const t of this.tasks) {
      if (t.state !== "assigned" || !t.preempting) continue;
      const free = this.robots.filter((r) => this.available(r));
      if (!free.length) break;
      const pick = chooseRobot(this.#dctx(), t, free);
      if (!pick.robot) continue;
      const victim = t.robot;
      victim.preemptFor = null;
      t.preempting = false;
      this.#assign(t, pick.robot, `${pick.text}（${victim.id} 不必中斷）`, null);
    }
    const queue = this.tasks
      .filter((t) => t.state === "queued")
      .sort((a, b) => this.effPriority(a) - this.effPriority(b) || a.createdAt - b.createdAt);
    for (const task of queue) {
      // an earlier pick in this pass may already have merged or taken this one
      if (task.state !== "queued") continue;
      task.block = "";
      if (S.batching && this.#tryBatch(task)) continue;
      const res = this.#resources(task);
      if (!res.ok) {
        task.block = res.why;
        continue;
      }
      const free = this.robots.filter((r) => this.available(r));
      if (free.length) {
        const pick = chooseRobot(this.#dctx(), task, free);
        if (pick.robot) {
          this.#assign(task, pick.robot, pick.text, res);
          continue;
        }
        task.block = pick.text;
      } else task.block = this.#busyText();
      if (task.priority === 1 && S.preemption) this.#tryPreempt(task, res);
    }
  }

  #busyText() {
    const charging = this.robots.filter((r) => r.needCharge).length;
    return charging ? `所有機器人忙碌（${charging} 台低電量充電中）` : "所有機器人忙碌中";
  }

  #resources(task) {
    if (task.type === "rounds" || task.type === "remeasure") {
      const cart = this.w.carts[task.floor];
      if (cart.reservedBy && cart.reservedBy !== task) return { ok: false, why: `等待 ${cart.id}（${cart.reservedBy.id} 使用中）` };
      return { ok: true, cart };
    }
    if (task.type === "delivery") {
      if (task.shelf) return { ok: true, shelf: task.shelf };
      const free = this.w.meds.filter((m) => !m.reservedBy && m.atHome());
      if (!free.length) return { ok: false, why: `等待藥品櫃歸還（${this.w.meds.map((m) => m.id).join("、")} 皆外出）` };
      // the last cabinet in the pharmacy stays free for urgent (P1) orders
      if (this.settings.reserveStat && task.priority > 1 && free.length < 2) {
        return { ok: false, why: `保留 ${free[0].id} 給 P1 緊急用藥，等待其他藥品櫃歸還` };
      }
      return { ok: true, shelf: free[0] };
    }
    return { ok: true };
  }

  #reserve(task, res) {
    if (!res) return;
    if (res.cart) res.cart.reservedBy = task;
    if (res.shelf) {
      res.shelf.reservedBy = task;
      task.shelf = res.shelf;
    }
  }

  #assign(task, r, text, res) {
    task.state = "assigned";
    task.robot = r;
    task.assignedAt = this.sim.time;
    task.explain = task.handovers ? `接手（${task.note}）· ${text}` : text;
    task.note = "";
    task.block = "";
    this.#reserve(task, res);
    r.assignment = task;
    this.rrLast = r;
    emit("log", { tag: "dispatch", robot: r, html: `派工 <b>${task.id}</b>「${task.title}」→ <b>${r.id}</b>：${text}` });
    this.#absorb(task);
    this.#bump();
  }

  // a delivery that just got its robot takes along the other orders for the same floor,
  // including an urgent one still waiting for another robot to reach a safe point
  #absorb(host) {
    if (host.type !== "delivery" || !this.settings.batching) return;
    for (const other of this.tasks) {
      if (other === host || other.type !== "delivery" || other.floor !== host.floor) continue;
      if (other.state === "queued") this.#mergeDelivery(other, host);
      else if (other.state === "assigned" && other.preempting && other.robot && other.robot.preemptFor === other) {
        if (host.items.length >= 3 || host.loading) continue;
        const victim = other.robot;
        victim.preemptFor = null;
        other.preempting = false;
        if (other.shelf && other.shelf.reservedBy === other) other.shelf.reservedBy = null;
        other.shelf = null;
        this.#mergeDelivery(other, host);
        emit("log", { tag: "dispatch", robot: victim, html: `${victim.id} 不必中斷：<b>${other.id}</b> 併入 ${host.id} 同一趟` });
      }
    }
  }

  // re-measures ride along with a round on the same floor; same-floor deliveries share a trip
  #tryBatch(task) {
    if (task.type === "remeasure") {
      const host = this.tasks.find(
        (t) => t.type === "rounds" && t.floor === task.floor && (t.state === "assigned" || t.state === "active") && t.beds.length > 0,
      );
      if (!host) return false;
      if (!host.beds.includes(task.bed)) host.beds.push(task.bed);
      host.remeasureBeds.add(task.bed);
      host.sub = `${host.beds.length + host.doneBeds.length} 床（含複測 ${[...host.remeasureBeds].join("、")}）・${this.w.carts[host.floor].id}`;
      this.#merge(task, host, `併入 ${host.id}（${host.robot.id} 正在 ${FLOORS[host.floor].id} 巡房）`);
      return true;
    }
    if (task.type === "delivery") {
      const host = this.tasks.find(
        (t) =>
          t !== task &&
          t.type === "delivery" &&
          t.floor === task.floor &&
          (t.state === "assigned" || t.state === "active") &&
          !t.loading &&
          !t.preempting &&
          t.items.length < 3,
      );
      if (!host) return false;
      this.#mergeDelivery(task, host);
      return true;
    }
    return false;
  }

  #mergeDelivery(task, host) {
    if (host.items.length >= 3 || host.loading) return;
    host.items.push(...task.items);
    host.sub = host.items.map((it) => `${it.bed} ${it.title}`).join("、");
    if (task.priority < host.priority) {
      host.priority = task.priority;
      host.title = `緊急用藥 → ${FLOORS[host.floor].id}`;
    }
    this.#merge(task, host, `併入 ${host.id} 同一趟（${host.robot ? host.robot.id : "待派工"}）`);
  }

  #merge(task, host, text) {
    task.state = "merged";
    task.parent = host;
    task.explain = text;
    task.block = "";
    task.robot = host.robot;
    host.merged.push(task);
    this.kpi.merged++;
    this.metrics.event("merge", host.robot, `${task.id} 併入 ${host.id}`);
    emit("log", { tag: "dispatch", robot: host.robot, html: `合併派工：<b>${task.id}</b> ${text}` });
    this.#bump();
  }

  #tryPreempt(task, res) {
    const S = this.settings;
    // someone about to finish (bringing a cabinet back) may beat interrupting another job
    let soon = null;
    for (const r of this.robots) {
      const t = r.task;
      if (!t || r.preemptFor || t.type !== "delivery" || t.stage !== "return") continue;
      const eta = travelSeconds(this.lift, robotPose(r), t.shelf.home) + 25 + travelSeconds(this.lift, t.shelf.home, task.start);
      if (!soon || eta < soon.eta) soon = { r, eta };
    }
    let victim = null;
    for (const r of this.robots) {
      const t = r.task;
      if (!t || r.fault || r.preemptFor || r.needCharge || t.priority < 3 || !TASK_TYPES[t.type].preemptible) continue;
      if (r.battery < S.minDispatch) continue;
      // finishing the bed in progress (or waiting for the nurse at an alert) comes first
      const k = r.activity.kind;
      const bed = k === "alert" ? 180 : k === "measure" ? 45 : 0;
      const wrap = (t.type === "rounds" && r.shelf ? 75 : 10) + bed;
      const eta = wrap + travelSeconds(this.lift, robotPose(r), task.start);
      if (!victim || eta < victim.eta) victim = { r, eta };
    }
    if (soon && (!victim || soon.eta <= victim.eta + 30)) {
      task.block = `等待 ${soon.r.id} 歸還藥品櫃後接手（約 ${fmtS(soon.eta)}，比中斷其他任務快）`;
      return;
    }
    if (!victim) return;
    const r = victim.r;
    r.preemptFor = task;
    task.state = "assigned";
    task.robot = r;
    task.preempting = true;
    task.assignedAt = this.sim.time;
    task.explain = `無空閒機器人 → 中斷 ${r.id} 的「${r.task.title}」(P${r.task.priority})，安全點交接後約 ${fmtS(victim.eta)}到達`;
    task.block = "";
    this.#reserve(task, res);
    emit("log", { tag: "dispatch", robot: r, html: `P1 插單 <b>${task.id}</b>：${task.explain}` });
    this.#bump();
  }

  // checked by task scripts between steps
  interruptReason(r) {
    // a robot that is about to run flat hands over first; its pending P1 goes to someone else
    if (r.battery < this.settings.criticalBattery) return "battery";
    if (r.preemptFor) return "preempt";
    return null;
  }

  // -------------------------------------------------------- robot loop
  async #robotLoop(r, token) {
    for (;;) {
      try {
        if (r.fault) {
          await this.sim.until(() => !r.fault, token);
          continue;
        }
        if (r.assignment) await this.#runTask(r, token);
        else if (r.needCharge || (!r.onCharger && r.battery < this.settings.lowBattery)) await this.#chargeCycle(r, token);
        else await this.#idleCycle(r, token);
      } catch (err) {
        if (err instanceof CancelError || token.cancelled) return;
        console.error(err);
        try {
          await this.sim.wait(2, token);
        } catch {
          return;
        }
      }
    }
  }

  async #runTask(r, token) {
    const task = r.assignment;
    task.state = "active";
    task.robot = r;
    task.preempting = false;
    if (task.startedAt === undefined) {
      task.startedAt = this.sim.time;
      this.kpi.waitSum += task.startedAt - task.createdAt;
      this.kpi.waitN++;
    }
    r.task = task;
    for (const m of task.merged) m.robot = r;
    this.#bump();
    // a task can be aborted on its own (robot fault) without touching the rest of the fleet
    const tt = (r.taskToken = new Token(token));
    try {
      if (r.parked) await this.#unparkFrom(r, tt);
      const res = await EXECUTORS[task.type](this.ctx, r, task, tt);
      if (res && res.interrupted) this.#requeue(task, r, res.interrupted);
      else this.#complete(task, r);
    } catch (err) {
      if (token.cancelled) throw err;
      if (err instanceof CancelError && tt.cancelled) {
        r.halt();
        this.#requeue(task, r, "fault");
      } else {
        console.error(err);
        this.#requeue(task, r, "error");
      }
    } finally {
      r.task = null;
      r.taskToken = null;
      r.focusPerson = null;
      if (r.assignment === task) r.assignment = null;
      this.#bump();
    }
  }

  #release(task) {
    const cart = this.w.carts[task.floor];
    if (cart && cart.reservedBy === task) cart.reservedBy = null;
    if (task.shelf && task.shelf.reservedBy === task) task.shelf.reservedBy = null;
  }

  #requeue(task, r, reason) {
    const left = task.type === "rounds" ? `剩 ${task.beds.length} 床` : task.type === "patrol" ? `剩 ${task.points.length} 個巡檢點` : "";
    this.#release(task);
    if (task.type !== "delivery") task.shelf = null;
    task.state = "queued";
    task.robot = null;
    task.explain = "";
    task.progress = Math.min(task.progress, 0.9);
    task.handovers = (task.handovers || 0) + 1;
    if (reason === "preempt" && !r.preemptFor) {
      // the P1 went to a robot that freed up first while this one was wrapping up
      task.note = `P1 已由其他機器人接手，${left}，等待重新派工`;
      task.step = "暫停・等待重新派工";
    } else if (reason === "preempt") {
      const next = r.preemptFor;
      task.note = `被 ${next.id}（P1）中斷，${left}，等待重新派工`;
      task.step = "暫停・等待重新派工";
      this.kpi.preemptions++;
      r.preemptFor = null;
      next.preempting = false;
      next.state = "assigned";
      next.robot = r;
      r.assignment = next;
      this.#absorb(next);
      this.metrics.event("preempt", r, `${task.id} 暫停 → ${next.id}`);
      emit("log", { tag: "dispatch", robot: r, html: `${r.id} 於安全點暫停 <b>${task.id}</b>（${left}），改執行 <b>${next.id}</b>` });
    } else if (reason === "battery" || reason === "fault") {
      task.note = reason === "fault" ? `${r.id} 故障，改派其他機器人${left ? `（${left}）` : ""}` : `${r.id} 電量 ${pct(r)} 交接，${left}`;
      task.step = "交接・等待其他機器人";
      this.kpi.handovers++;
      if (reason === "battery") r.needCharge = true;
      this.metrics.event("handover", r, `${task.id} ${reason === "fault" ? "故障改派" : "低電量交接"}`);
      if (reason === "fault") emit("log", { tag: "dispatch", robot: r, html: `${r.id} 故障：<b>${task.id}</b>「${task.title}」改派其他機器人${left ? `（${left}）` : ""}` });
      if (r.preemptFor) {
        const p = r.preemptFor;
        r.preemptFor = null;
        p.preempting = false;
        p.state = "queued";
        p.robot = null;
        p.explain = "";
        p.note = `${r.id} ${reason === "fault" ? "故障" : "電量不足"}無法接手，重新派工`;
      }
      emit("log", { tag: "charge", robot: r, html: `${r.id} 電量 ${pct(r)} 低於 ${this.settings.criticalBattery}%：<b>${task.id}</b> 交接（${left}），先回充` });
    } else {
      task.note = "執行中斷，重新排入佇列";
    }
    for (const m of task.merged) m.robot = null;
    this.#bump();
    this.dispatch();
  }

  #complete(task, r) {
    task.state = "done";
    task.doneAt = this.sim.time;
    task.progress = 1;
    task.step = "已完成";
    task.note = "";
    this.#release(task);
    this.kpi.done++;
    this.metrics.taskDone(task, r);
    for (const m of task.merged) {
      if (m.state !== "merged") continue;
      m.state = "merged-done";
      m.doneAt = this.sim.time;
      m.robot = r;
      this.kpi.done++;
      this.metrics.taskDone(m, r);
    }
    const wait = task.startedAt - task.createdAt;
    emit("log", { tag: "dispatch", robot: r, html: `<b>${task.id}</b>「${task.title}」完成・等候 ${fmtS(wait)}・執行 ${fmtS(task.doneAt - task.startedAt)}` });
    this.#bump();
  }

  step(task, text, progress = null) {
    task.step = text;
    if (progress !== null) task.progress = progress;
    this.#bump();
  }

  isRemeasure(task, bedId) {
    return !!(task.remeasureBeds && task.remeasureBeds.has(bedId));
  }

  bedMeasured(task, bedId) {
    for (const m of task.merged) {
      if (m.type === "remeasure" && m.bed === bedId && m.state === "merged") {
        m.state = "merged-done";
        m.doneAt = this.sim.time;
        m.robot = task.robot;
        this.kpi.done++;
        this.metrics.taskDone(m, task.robot);
      }
    }
    this.#bump();
  }

  delivered(task, r) {
    task.deliveredAt = this.sim.time;
    for (const m of task.merged) m.deliveredAt = this.sim.time;
    this.kpi.deliveries += task.items.length;
    this.kpi.minutes += NURSE_MINUTES.delivery;
    emit("log", { tag: "staff", robot: r, html: `${FLOORS[task.floor].id} 已簽收 ${task.shelf.id}（${task.sub}）` });
    emit("kpi");
  }

  patrolled() {
    this.kpi.patrols++;
    this.kpi.minutes += NURSE_MINUTES.patrol;
    emit("kpi");
  }

  // ------------------------------------------------------------ records
  record(res, r, again) {
    const S = this.settings;
    this.kpi.beds++;
    this.kpi.minutes += again ? NURSE_MINUTES.remeasure : NURSE_MINUTES.vitals;
    const row = { clock: res.clock, bed: res.bed, floor: res.floor, hr: res.hr, rr: res.rr, level: res.level, label: res.label, robot: r.id, again, fresh: true };
    this.history.unshift(row);
    this.history.length = Math.min(this.history.length, 40);
    emit("log", {
      tag: "vitals",
      robot: r,
      html: `${again ? "複測 " : ""}${res.bed} HR <b>${res.hr}</b> · RR <b>${res.rr}</b> · SQI ${Math.round(res.sqi * 100)}% → MQTT <code>ward/${res.floor}/${res.bed}/vitals</code>`,
    });
    const prev = this.alerts.find((a) => a.bed === res.bed && !a.closed);
    if (res.level === "crit") {
      this.kpi.alerts++;
      if (prev) prev.closed = true;
      const alert = { ...res, robot: r.id, status: "已推播護理站與 LINE 群組", resolved: false, closed: false, at: this.sim.time };
      this.alerts.unshift(alert);
      this.alerts.length = Math.min(this.alerts.length, 8);
      this.metrics.event("alert", r, `${res.floor} ${res.bed} ${res.flags[0]}`);
      emit("log", { tag: "alert", robot: r, html: `${res.floor} ${res.bed} ${res.flags.join("、")} → 推播 ${res.floor} 護理站與 LINE 群組` });
      const token = this.token;
      this.sim
        .wait(S.remeasureAfter * 60, token)
        .then(() => this.addRemeasure(res.bed, `${res.floor} 護理師・異常後 ${S.remeasureAfter} 分鐘`), ignoreCancel);
    } else if (prev && again) {
      prev.status = `複測 HR ${res.hr}・RR ${res.rr}（${res.label}），已改善`;
      prev.resolved = true;
      prev.closed = true;
    } else if (res.level === "warn") {
      emit("log", { tag: "vitals", robot: r, html: `${res.bed} ${res.flags.join("、")}，已標記「注意」供護理師覆核` });
    }
    emit("measurement", row);
    emit("kpi");
    emit("alert", this.alerts[0] || null);
  }

  alertStatus(bedId, status, resolved = false) {
    const a = this.alerts.find((x) => x.bed === bedId && !x.closed);
    if (!a) return;
    a.status = status;
    a.resolved = resolved;
    emit("alert", this.alerts[0]);
  }

  requestStat(bed, patient) {
    const fid = FLOORS[bed.floor].id;
    this.addDelivery({ floor: bed.floor, priority: 1, items: [{ bed: bed.id, title: patient.data.title }], by: `${fid} 護理師・醫囑緊急用藥` });
  }

  // ------------------------------------------------------------ charging
  #dockFree(d, r) {
    return (!d.occupant || d.occupant === r) && (!d.reservedBy || d.reservedBy === r);
  }

  bestCharger(r) {
    const free = this.hospital.docks.filter((d) => d.charger && this.#dockFree(d, r));
    if (!free.length) return null;
    if (this.settings.chargerPolicy === "home" && r.homeDock && free.includes(r.homeDock)) return r.homeDock;
    let best = null;
    let bestT = Infinity;
    for (const d of free) {
      const t = travelSeconds(this.lift, robotPose(r), d.approach);
      if (t < bestT) {
        bestT = t;
        best = d;
      }
    }
    return best;
  }

  #standby(r) {
    return this.hospital.docks.find((d) => !d.charger && this.#dockFree(d, r)) || null;
  }

  async #unparkFrom(r, token) {
    const d = r.parked;
    if (!d) return;
    await r.unpark(token);
    if (d.occupant === r) d.occupant = null;
  }

  async #moveDock(r, dock, token, abort) {
    dock.reservedBy = r;
    try {
      await this.#unparkFrom(r, token);
      const ok = await r.parkAt(dock, token, abort);
      if (ok) dock.occupant = r;
      return ok;
    } finally {
      if (dock.reservedBy === r) dock.reservedBy = null;
    }
  }

  async #idleCycle(r, token) {
    const S = this.settings;
    if (!r.parked) {
      const dock = this.bestCharger(r) || this.#standby(r);
      if (!dock) {
        r.setActivity("idle", "待命", "停靠點皆已使用");
        await this.sim.until(() => r.assignment || this.bestCharger(r) || this.#standby(r), token);
        return;
      }
      r.setActivity("move", dock.charger ? "返回充電座" : "前往待命點", dock.name);
      const ok = await this.#moveDock(r, dock, token, () => !!r.assignment);
      if (ok) r.setActivity(dock.charger ? "charge" : "idle", dock.charger ? "充電待命" : "待命", dock.name);
      return;
    }
    const dock = r.parked;
    r.setActivity(dock.charger ? "charge" : "idle", dock.charger ? "充電待命" : "待命", dock.name);
    await this.sim.until(() => r.assignment || r.vacate || (!dock.charger && (r.battery < S.lowBattery || this.bestCharger(r))), token);
    if (r.assignment) return;
    if (r.vacate) {
      r.vacate = false;
      const spot = this.#standby(r);
      if (!spot) return;
      emit("log", { tag: "charge", robot: r, html: `${r.id} 已充至 ${pct(r)}，讓出 ${dock.name} 給低電量機器人` });
      r.setActivity("move", "讓出充電座", spot.name);
      const ok = await this.#moveDock(r, spot, token, () => !!r.assignment);
      if (ok) r.setActivity("idle", "待命", spot.name);
      return;
    }
    if (!dock.charger && r.battery >= S.lowBattery) {
      const ch = this.bestCharger(r);
      if (ch) {
        r.setActivity("move", "移往空出的充電座", ch.name);
        await this.#moveDock(r, ch, token, () => !!r.assignment);
      }
    }
  }

  // ask an idle, well-charged robot to give its charger to one that needs it
  #askToVacate(needy) {
    if (this.robots.some((r) => r.vacate)) return;
    const donors = this.robots.filter(
      (r) => r !== needy && r.parked && r.parked.charger && !r.task && !r.assignment && !r.needCharge && r.battery >= this.settings.resumeBattery,
    );
    if (!donors.length || !this.#standby(donors[0])) return;
    donors.sort((a, b) => b.battery - a.battery);
    donors[0].vacate = true;
  }

  async #chargeCycle(r, token) {
    const S = this.settings;
    if (!r.needCharge) {
      r.needCharge = true;
      emit("log", { tag: "charge", robot: r, html: `${r.id} 電量 ${pct(r)} 低於回充門檻 ${S.lowBattery}% → 回充` });
    }
    while (!(r.parked && r.parked.charger)) {
      const ch = this.bestCharger(r);
      if (ch) {
        r.setActivity("move", "低電量回充", ch.name);
        await this.#moveDock(r, ch, token, null);
        continue;
      }
      this.#askToVacate(r);
      const spot = r.parked ? null : this.#standby(r);
      if (spot) {
        r.setActivity("move", "前往待命點等充電座", spot.name);
        await this.#moveDock(r, spot, token, () => !!this.bestCharger(r));
        continue;
      }
      r.setActivity("idle", "等候充電座", "充電座皆使用中");
      r.waitInfo = { kind: "charger", label: "等候充電座" };
      await this.sim.until(() => {
        this.#askToVacate(r);
        return this.bestCharger(r);
      }, token);
      r.waitInfo = null;
    }
    r.setActivity("charge", "低電量充電", `${r.parked.name}・充到 ${S.resumeBattery}%`);
    await this.sim.until(() => r.battery >= S.resumeBattery, token);
    r.needCharge = false;
    emit("log", { tag: "charge", robot: r, html: `${r.id} 已充至 ${pct(r)}，恢復可派工` });
  }

  // the BestShape VS unit riding on this robot, if any
  sensorOf(r) {
    if (!r || !r.shelf) return null;
    return Object.values(this.w.sensors).find((s) => s.cart === r.shelf) || null;
  }

  // -------------------------------------------------------------- stats
  get waitAvgMin() {
    return this.kpi.waitN ? this.kpi.waitSum / this.kpi.waitN / 60 : 0;
  }

  clockText(t) {
    return formatClock(t, false);
  }
}
