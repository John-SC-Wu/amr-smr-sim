import { FLOORS, NURSE_MINUTES } from "./config.js";
import { Token, CancelError, ignoreCancel, emit, formatClock, yawTo } from "./sim.js";

export const TASKS = [
  { id: "rounds", icon: "i-heart", name: "生命徵象巡房", route: "1F→3F→4F→1F", at: [8, 0] },
  { id: "delivery", icon: "i-box", name: "藥品配送", route: "1F→3F→1F", at: [9, 30] },
  { id: "patrol", icon: "i-shield", name: "失智專區巡視", route: "1F→2F→1F", at: [10, 40] },
  { id: "charge", icon: "i-battery", name: "回充待命", route: "1F 充電座", at: [11, 20] },
];

const ROUND_BEDS = ["301-A", "301-B", "302-A", "302-B", "401-A", "401-B", "402-A"];

// an earlier (simulated) night round, so the record table is not empty on load
const INITIAL_HISTORY = [
  { clock: 6 * 3600 + 18 * 60, bed: "402-B", floor: "4F", hr: 70, rr: 16, level: "ok", label: "正常" },
  { clock: 6 * 3600 + 14 * 60, bed: "402-A", floor: "4F", hr: 104, rr: 20, level: "warn", label: "注意" },
  { clock: 6 * 3600 + 10 * 60, bed: "401-B", floor: "4F", hr: 73, rr: 17, level: "ok", label: "正常" },
  { clock: 6 * 3600 + 6 * 60, bed: "401-A", floor: "4F", hr: 79, rr: 18, level: "ok", label: "正常" },
];

export class Missions {
  constructor(world) {
    this.w = world;
    this.cycle = 1;
    this.index = 0;
    this.token = null;
    this.states = TASKS.map(() => ({ state: "queued", progress: 0, step: "" }));
    this.kpi = { beds: 4, alerts: 0, deliveries: 1, rides: 3, patrols: 1, minutes: 4 * NURSE_MINUTES.vitals + NURSE_MINUTES.delivery + NURSE_MINUTES.patrol };
    this.history = INITIAL_HISTORY.map((h) => ({ ...h }));
    this.alert = null;
  }

  start() {
    this.#run(0);
  }

  timeFor(i, cycle = this.cycle) {
    const [hh, mm] = TASKS[i].at;
    return [hh + (cycle - 1) * 6, mm];
  }

  clockText() {
    return formatClock(this.w.sim.clock, false);
  }

  jumpTo(i) {
    if (this.token) this.token.cancel();
    this.w.sim.process();
    this.#resetWorld(i);
    const [hh, mm] = this.timeFor(i);
    this.w.sim.setClock(hh * 3600 + mm * 60);
    emit("log", { tag: "sep", html: `切換情境：${TASKS[i].name}` });
    this.#run(i, true);
  }

  async #run(start, jumped = false) {
    const token = (this.token = new Token());
    let i = start;
    try {
      for (;;) {
        this.index = i;
        this.states.forEach((s, k) => {
          s.state = k < i ? "done" : k === i ? "active" : "queued";
          s.progress = k < i ? 1 : 0;
          s.step = k === i ? "準備中" : k < i ? s.step || "已完成" : "";
        });
        emit("tasks");
        if (!jumped) {
          const [hh, mm] = this.timeFor(i);
          this.w.sim.skipClockTo(hh, mm);
          emit("log", { tag: "sep", html: `${formatClock(this.w.sim.clock, false)} 開始：${TASKS[i].name}` });
        }
        jumped = false;
        await this[TASKS[i].id](token);
        this.states[i].state = "done";
        this.states[i].progress = 1;
        this.states[i].step = "已完成";
        emit("tasks");
        i++;
        if (i >= TASKS.length) {
          i = 0;
          this.cycle++;
          this.#newCycle();
        }
      }
    } catch (err) {
      if (!(err instanceof CancelError)) console.error(err);
    }
  }

  step(text, progress = null) {
    const s = this.states[this.index];
    s.step = text;
    if (progress !== null) s.progress = progress;
    emit("tasks");
  }

  say(person, text) {
    const label = person.name || person.roleDef.label;
    emit("speech", { who: person.id, name: label, text });
    emit("log", { tag: "staff", html: `${label}：「${text}」` });
  }

  // ---------------------------------------------------------- tasks
  async rounds(token) {
    const { robot, shelves, hospital, staff } = this.w;
    this.step("自 1F 充電座出發", 0.02);
    robot.setActivity("move", "出發", "1F 機器人站");
    this.say(staff.reception, "小幫手早安，今天也麻煩你了！");
    await robot.departFromCharger(token);
    this.step("對接生理量測車 VS-01", 0.05);
    await robot.dockShelf(shelves.vs, token);
    await robot.speak(`開始 ${this.clockText()} 生命徵象巡房。`, token);
    for (let k = 0; k < ROUND_BEDS.length; k++) {
      const bed = hospital.beds.get(ROUND_BEDS[k]);
      const fid = FLOORS[bed.floor].id;
      this.step(`前往 ${fid} ${bed.id} 床邊`, 0.08 + 0.82 * (k / ROUND_BEDS.length));
      robot.setActivity("move", "前往床邊", `${fid} ${bed.id}`);
      await robot.goTo(bed.bedside, token, { label: `${bed.id} 床邊` });
      this.step(`${fid} ${bed.id} 非接觸量測呼吸與心跳`);
      await this.#measureBed(bed, token);
    }
    this.step("巡房完成，歸還生理量測車", 0.92);
    await robot.returnShelf(shelves.vs, token);
  }

  async #measureBed(bed, token) {
    const { robot, sensor } = this.w;
    const patient = this.w.patients.get(bed.id);
    robot.setActivity("measure", "量測中", bed.id);
    await robot.speak(`${patient.data.title}您好，我幫您量呼吸和心跳，躺著放輕鬆就好。`, token);
    const res = await sensor.measure(bed, patient, token);
    this.#record(res);
    if (res.level === "crit") {
      robot.setActivity("alert", "異常通報", bed.id);
      await robot.speak("數值偏高，已通知護理師過來。", token);
      await this.#nurseResponds(bed, patient, res, token);
      await robot.speak("護理師到了，我先去下一床。", token);
    } else {
      if (Math.random() < 0.5) emit("speech", { who: `patient-${bed.id}`, name: patient.data.title, text: "好，謝謝你喔。" });
      await robot.speak(res.level === "warn" ? "量好了，數值我會請護理師留意。" : "量好了，謝謝您！", token);
    }
  }

  #record(res) {
    this.kpi.beds++;
    this.kpi.minutes += NURSE_MINUTES.vitals;
    const row = { clock: res.clock, bed: res.bed, floor: res.floor, hr: res.hr, rr: res.rr, level: res.level, label: res.label, fresh: true };
    this.history.unshift(row);
    this.history.length = Math.min(this.history.length, 30);
    const topic = `ward/${res.floor}/${res.bed}/vitals`;
    emit("log", {
      tag: "vitals",
      html: `${res.bed} HR <b>${res.hr}</b> · RR <b>${res.rr}</b> · SQI ${Math.round(res.sqi * 100)}% → MQTT <code>${topic}</code>，已寫入護理紀錄`,
    });
    if (res.level === "crit") {
      this.kpi.alerts++;
      this.alert = { ...res, status: "已推播護理站與 LINE 群組", resolved: false };
      emit("log", { tag: "alert", html: `${res.floor} ${res.bed} ${res.flags.join("、")} → 推播 ${res.floor} 護理站與 LINE 群組` });
    } else if (res.level === "warn") {
      emit("log", { tag: "vitals", html: `${res.bed} ${res.flags.join("、")}，已標記「注意」供護理師覆核` });
    }
    emit("measurement", row);
    emit("kpi");
    emit("alert", this.alert);
  }

  async #nurseResponds(bed, patient, res, token) {
    const { sim } = this.w;
    const fid = FLOORS[bed.floor].id;
    const nurse = this.w.staff[`${fid}-nurseA`];
    const roomX = bed.id.endsWith("A") ? bed.x + 1.1 : bed.x - 1.1;
    const path = [[-0.2, 2.75], [-0.2, 1.75], [-0.2, 0.55], [roomX, 0.55], [roomX, -1.1], [roomX, -2.15], [bed.nurseSpot.x, bed.nurseSpot.z]];
    nurse.pose = "idle";
    this.say(nurse, `收到 ${bed.id} ${res.flags[0]} 的通知，我過去看看。`);
    this.#alertStatus("護理師前往床邊");
    this.w.camera.focus = nurse;
    await nurse.walkTo(path, sim, token, bed.nurseSpot.yaw);
    nurse.pose = "check";
    this.#alertStatus("護理師已到床邊處置");
    const line = res.flags[0].startsWith("RR")
      ? `${patient.data.title}，我幫您把床頭搖高一點，呼吸會比較順。`
      : `${patient.data.title}，心跳有點快，我幫您量個血壓，再跟醫務室醫師報告。`;
    this.say(nurse, line);
    sim.wait(5, token).then(() => (this.w.camera.focus = null)).catch(ignoreCancel);
    // follow-up continues while the robot moves on
    (async () => {
      await sim.wait(16, token);
      if (res.flags[0].startsWith("RR")) patient.rr = Math.max(19, patient.rr - 6);
      else patient.hr = Math.max(92, patient.hr - 14);
      this.say(nurse, "狀況穩定了，30 分鐘後再請小幫手複測。");
      this.#alertStatus("已處置・30 分鐘後複測", true);
      await sim.wait(4, token);
      nurse.pose = "idle";
      const back = path.slice(0, -1).reverse();
      back.push([nurse.home.x, nurse.home.z]);
      await nurse.walkTo(back, sim, token, nurse.home.yaw);
      nurse.pose = nurse.home.pose;
    })().catch(ignoreCancel);
  }

  #alertStatus(status, resolved = false) {
    if (!this.alert) return;
    this.alert = { ...this.alert, status, resolved };
    emit("alert", this.alert);
  }

  async delivery(token) {
    const { robot, shelves, staff, sim, hospital } = this.w;
    const nurse = staff["3F-nurseB"];
    const ph = staff.pharmacist;
    this.step("3F 護理站以平板派送任務", 0.03);
    nurse.pose = "check";
    this.say(nurse, "小幫手，麻煩到醫務室幫 302-B 張伯伯領藥。");
    emit("log", { tag: "staff", html: "3F 護理站派送任務：<b>藥品配送</b> 1F 醫務室藥局 → 3F 護理站" });
    await sim.wait(2.5, token);
    nurse.pose = "type";
    robot.startCommand("move_shelf", 'target_shelf_id="MED-01", destination_location_id="3F-station", undock_on_destination=False');
    this.step("前往 1F 醫務室藥局", 0.1);
    robot.setActivity("move", "前往藥局", "1F 醫務室");
    const appr = robot.shelfApproach(shelves.med.pose());
    await robot.goTo(appr, token, { label: "1F 醫務室藥局" });

    this.step("藥師備藥並放入藥品櫃", 0.24);
    robot.setActivity("handoff", "等待備藥", "1F 醫務室");
    await robot.speak("藥局您好，我來領 3F 302-B 張伯伯的藥。", token);
    ph.pose = "idle";
    this.w.camera.focus = ph;
    await ph.walkTo([[-6.3, -3.85], [-5.3, -3.05]], sim, token, -Math.PI / 2);
    ph.pose = "carry";
    for (let k = 1; k <= 3; k++) {
      await sim.wait(0.9, token);
      shelves.med.load(k);
    }
    this.say(ph, "張伯伯的藥備好了，抽屜已上鎖。");
    this.w.camera.focus = null;
    ph.pose = "idle";
    ph.walkTo([[-6.3, -3.85], [ph.home.x, ph.home.z]], sim, token, ph.home.yaw).then(() => (ph.pose = ph.home.pose)).catch(ignoreCancel);
    await sim.wait(1.5, token);

    this.step("對接藥品櫃 MED-01", 0.34);
    await robot.dockShelf(shelves.med, token);
    this.step("搭電梯送往 3F 護理站", 0.44);
    robot.setActivity("move", "藥品配送中", "→ 3F 護理站");
    await robot.goTo(hospital.location("3F-station"), token, { label: "3F 護理站" });

    this.step("護理師取件簽收", 0.72);
    robot.setActivity("handoff", "等待取件", "3F 護理站");
    await robot.speak("3F 護理站您好，302-B 張伯伯的藥送到了，請取件。", token);
    const pick = hospital.staffSpots["3F-pickup"];
    nurse.pose = "idle";
    this.w.camera.focus = nurse;
    await nurse.walkTo([[-0.45, 3.0], [pick.x, pick.z]], sim, token, pick.yaw);
    nurse.pose = "hand";
    for (let k = 0; k < 3; k++) {
      await sim.wait(0.9, token);
      shelves.med.unloadOne();
    }
    this.say(nurse, "收到，謝謝小幫手！");
    this.w.camera.focus = null;
    this.kpi.deliveries++;
    this.kpi.minutes += NURSE_MINUTES.delivery;
    emit("kpi");
    emit("log", { tag: "staff", html: "3F 護理站已簽收 MED-01（3 項藥品）" });
    nurse.pose = "carry";
    nurse
      .walkTo([[-0.45, 3.0], [nurse.home.x, nurse.home.z]], sim, token, nurse.home.yaw)
      .then(() => (nurse.pose = nurse.home.pose))
      .catch(ignoreCancel);
    await sim.wait(1.5, token);

    this.step("歸還藥品櫃至 1F 醫務室", 0.8);
    await robot.returnShelf(shelves.med, token);
  }

  async patrol(token) {
    const { robot, hospital } = this.w;
    const cps = hospital.patrol;
    robot.startCommand("start_shortcut_command", 'target_shortcut_id="patrol-2F-dementia"');
    for (let k = 0; k < cps.length; k++) {
      const cp = cps[k];
      this.step(`巡檢點 ${k + 1}/${cps.length}：${cp.name}`, 0.08 + 0.78 * (k / cps.length));
      robot.setActivity("move", "巡視中", cp.name);
      if (cp.id === "2F-cp-activity") await this.#wanderingResident(cp, token);
      else await robot.goTo(cp, token);
      robot.setActivity("patrol", "巡檢掃描", cp.name);
      await robot.rotateInPlace(0.7, token);
      await robot.rotateInPlace(-1.4, token);
      await robot.rotateInPlace(0.7, token);
      const people = robot.detections.filter((d) => d.label === "PERSON").length;
      emit("log", { tag: "nav", html: `${cp.name}：DOOR 關閉 ✓・PERSON ×${people}` });
    }
    this.kpi.patrols++;
    this.kpi.minutes += NURSE_MINUTES.patrol;
    emit("kpi");
    this.step("巡視完成，返回 1F 充電座", 0.9);
    await robot.speak("2F 巡視完成，返回充電座。", token);
    await robot.returnHome(hospital.location("1F-charger"), hospital.charger, token);
  }

  // a resident heads for the controlled exit: the robot stops to talk and calls the care attendant
  async #wanderingResident(cp, token) {
    const { robot, staff, sim, hospital } = this.w;
    const res = staff.wanderer;
    const carer = staff["2F-carer"];
    const seat = res.home;
    const lane = hospital.exitPoint.z;
    const move = robot.goTo(cp, token);
    res.walkTo([[seat.x, 1.4], [seat.x - 0.9, lane], [hospital.exitPoint.x, lane]], sim, token, Math.PI).catch(ignoreCancel);
    const near = sim.until(() => !res.sitting && Math.hypot(res.x - robot.x, res.z - robot.z) < 3.0, token);
    if ((await Promise.race([move.then(() => "arrived"), near.then(() => "near")])) === "arrived") return;

    robot.hold = true;
    this.w.camera.focus = res;
    res.stop();
    res.finalYaw = yawTo(robot.x - res.x, robot.z - res.z);
    robot.setActivity("alert", "住民遊走提醒", "2F 往出入口");
    this.step("偵測到住民往出入口移動，通知照服員", null);
    emit("log", { tag: "nav", html: "前鏡頭偵測 PERSON：住民 陳伯伯 往出入口方向移動" });
    emit("log", { tag: "alert", html: "2F 失智照顧專區：住民往出入口移動 → 通知 2F 照服站與 LINE 群組" });
    this.kpi.alerts++;
    emit("kpi");
    await robot.speak("陳伯伯午安，要去哪裡呀？我請照服員來陪您喔。", token);
    this.say(res, "我要回家……");
    this.say(carer, "收到，我來陪陳伯伯。");
    carer.pose = "idle";
    const meet = [res.x - 0.75, res.z + 0.15];
    await carer.walkTo([[-0.2, 2.75], [-0.2, 1.1], [meet[0], 1.1], meet], sim, token, yawTo(res.x - meet[0], res.z - meet[1]));
    res.finalYaw = yawTo(carer.x - res.x, carer.z - res.z);
    this.say(carer, "陳伯伯，我們回活動室喝茶好嗎？");
    await sim.wait(2.5, token);
    this.say(res, "好啊，好啊。");
    emit("log", { tag: "staff", html: "照服員 阿芳 陪同住民 陳伯伯 返回活動室" });
    // they walk back together while the robot carries on
    (async () => {
      await Promise.all([
        res.walkTo([[seat.x, 1.4], [seat.x, seat.z]], sim, token, seat.yaw),
        carer.walkTo([[seat.x - 0.75, 1.45], [seat.x - 0.75, 2.1]], sim, token, 0),
      ]);
      res.sitting = true;
      carer.pose = "check";
      await sim.wait(6, token);
      carer.pose = "idle";
      await carer.walkTo([[1.6, 1.3], [-0.2, 1.3], [-0.2, 2.75], [carer.home.x, carer.home.z]], sim, token, carer.home.yaw);
      carer.pose = carer.home.pose;
    })().catch(ignoreCancel);
    await sim.wait(1.2, token);
    await robot.speak("謝謝阿芳，我繼續巡視。", token);
    this.w.camera.focus = null;
    robot.hold = false;
    robot.setActivity("move", "巡視中", cp.name);
    robot.startCommand("move_to_location", `target_location_id="${cp.id}"`, false);
    await move;
    emit("log", { tag: "nav", html: "活動室：住民 陳伯伯 已由照服員陪同返回 ✓" });
  }

  async charge(token) {
    const { robot, hospital, sim } = this.w;
    this.step("回到充電座", 0.2);
    if (!robot.onCharger) await robot.returnHome(hospital.location("1F-charger"), hospital.charger, token);
    robot.setActivity("charge", "充電中", "1F 充電座");
    robot.startCommand("get_battery_info");
    await sim.wait(12, token);
    const [hh, mm] = this.timeFor(0, this.cycle + 1);
    this.step("充電完成，等待下一輪巡房", 0.75);
    emit("log", { tag: "sep", html: `時間快轉至 ${String(hh % 24).padStart(2, "0")}:${String(mm).padStart(2, "0")}（充電至 100%）` });
    robot.battery = 100;
    await sim.wait(3, token);
  }

  // ---------------------------------------------------------- resets
  #newCycle() {
    const odd = this.cycle % 2 === 1;
    for (const p of this.w.patients.values()) {
      p.hr = p.data.hr + Math.round(Math.random() * 8 - 4);
      p.rr = p.data.rr + Math.round(Math.random() * 2 - 1);
    }
    const set = (id, v) => Object.assign(this.w.patients.get(id), v);
    set("302-B", odd ? { hr: 98, rr: 27 } : { hr: 92, rr: 22 });
    set("402-A", odd ? { hr: 113, rr: 22 } : { hr: 116, rr: 20 });
    emit("log", { tag: "sep", html: `第 ${this.cycle} 輪任務開始` });
  }

  #resetWorld(i) {
    const { robot, elevator, shelves, staff, sensor, hospital, labels } = this.w;
    sensor.reset();
    labels.clearBubbles();
    shelves.vs.resetHome();
    shelves.med.resetHome();
    for (const p of Object.values(staff)) {
      p.resetHome();
      p.pose = p.home.pose;
      p.onAvoid = null;
    }
    elevator.reset(0);
    this.w.camera.focus = null;
    robot.shelf = null;
    robot.pin = 0;
    robot.lastLoc = null;
    if (i === 1) {
      const a = robot.shelfApproach(shelves.vs.home);
      robot.teleport(0, a.x, a.z, a.yaw);
      robot.exitVia = [...shelves.vs.home.via].reverse();
    } else if (i === 2) {
      const a = robot.shelfApproach(shelves.med.home);
      robot.teleport(0, a.x, a.z, a.yaw);
      robot.exitVia = [...shelves.med.home.via].reverse();
    } else {
      const c = hospital.charger;
      robot.teleport(0, c.x, c.z, c.yaw, { onCharger: true });
      robot.exitVia = [...hospital.location("1F-charger").via].reverse();
    }
    robot.setActivity(i === 0 || i === 3 ? "charge" : "idle", i === 0 || i === 3 ? "充電中" : "待命", "1F");
    robot.endCommand();
    this.alert = null;
    emit("alert", null);
  }
}
