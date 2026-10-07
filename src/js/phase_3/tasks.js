import { FLOORS } from "./config.js";
import { emit, ignoreCancel, yawTo } from "./sim.js";

// task types; rounds and patrols can be paused at a safe point and resumed by any robot
export const TASK_TYPES = {
  rounds: { icon: "i-heart", name: "生命徵象巡房", preemptible: true },
  remeasure: { icon: "i-heart", name: "異常複測", preemptible: false },
  delivery: { icon: "i-box", name: "藥品配送", preemptible: false },
  patrol: { icon: "i-shield", name: "失智專區巡視", preemptible: true },
};

export function say(person, text) {
  const label = person.name || person.roleDef.label;
  emit("speech", { who: person.id, name: label, text });
  emit("log", { tag: "staff", html: `${label}：「${text}」` });
}

// one robot at a time per staff member
async function claim(ctx, person, owner, token) {
  if (person.busy && person.busy !== owner) {
    owner.waitInfo = { kind: "person", label: `等候 ${person.name || person.roleDef.label}` };
    await ctx.sim.until(() => !person.busy, token);
    owner.waitInfo = null;
  }
  person.busy = owner;
}

function release(person, owner) {
  if (person.busy === owner) person.busy = null;
}

function walkHome(ctx, person, owner, path, token) {
  person.pose = "idle";
  return person
    .walkTo([...path, [person.home.x, person.home.z]], ctx.sim, token, person.home.yaw)
    .then(() => {
      person.pose = person.home.pose;
      release(person, owner);
    })
    .catch(ignoreCancel);
}

const receiverOf = (fid) => ({ "2F": "2F-carer", "3F": "3F-nurseB", "4F": "4F-nurseB" })[fid];

// ------------------------------------------------------------------- rounds
export async function rounds(ctx, r, task, token) {
  const { fleet, hospital } = ctx;
  const fid = FLOORS[task.floor].id;
  const cart = ctx.carts[task.floor];
  const sensor = ctx.sensors[task.floor];
  if (r.shelf !== cart) {
    fleet.step(task, `前往 ${fid} 被服室對接 ${cart.id}`, 0.04);
    r.setActivity("move", "前往量測車", `${fid} 被服室`);
    await r.dockShelf(cart, token);
    await r.speak(task.doneBeds.length ? `接手 ${fid} 巡房，剩 ${task.beds.length} 床。` : `開始 ${fid} 生命徵象巡房。`, token);
  }
  while (task.beds.length) {
    const stop = fleet.interruptReason(r, task);
    if (stop) {
      fleet.step(task, stop === "battery" ? "電量過低：歸還量測車，交接給其他機器人" : "接獲 P1 緊急任務：歸還量測車後前往");
      await r.returnShelf(cart, token);
      return { interrupted: stop };
    }
    const bed = hospital.beds.get(task.beds[0]);
    const total = task.doneBeds.length + task.beds.length;
    fleet.step(task, `前往 ${bed.id} 床邊（${task.doneBeds.length + 1}/${total}）`, 0.08 + 0.84 * (task.doneBeds.length / total));
    r.setActivity("move", "前往床邊", `${fid} ${bed.id}`);
    await r.goTo(bed.bedside, token, { label: `${bed.id} 床邊` });
    fleet.step(task, `${bed.id} 非接觸量測呼吸與心跳`);
    await measureBed(ctx, r, task, bed, sensor, token);
    task.doneBeds.push(task.beds.shift());
    fleet.bedMeasured(task, bed.id);
  }
  fleet.step(task, "巡房完成，歸還量測車", 0.95);
  await r.returnShelf(cart, token);
}

// --------------------------------------------------------------- re-measure
export async function remeasure(ctx, r, task, token) {
  const { fleet, hospital } = ctx;
  const fid = FLOORS[task.floor].id;
  const cart = ctx.carts[task.floor];
  const bed = hospital.beds.get(task.bed);
  if (r.shelf !== cart) {
    fleet.step(task, `前往 ${fid} 被服室對接 ${cart.id}`, 0.1);
    r.setActivity("move", "前往量測車", `${fid} 被服室`);
    await r.dockShelf(cart, token);
  }
  fleet.step(task, `前往 ${bed.id} 複測`, 0.35);
  r.setActivity("move", "前往複測", `${fid} ${bed.id}`);
  await r.goTo(bed.bedside, token, { label: `${bed.id} 床邊` });
  fleet.step(task, `${bed.id} 複測呼吸與心跳`, 0.5);
  await measureBed(ctx, r, task, bed, ctx.sensors[task.floor], token);
  fleet.step(task, "複測完成，歸還量測車", 0.9);
  await r.returnShelf(cart, token);
}

async function measureBed(ctx, r, task, bed, sensor, token) {
  const { fleet } = ctx;
  const patient = ctx.patients.get(bed.id);
  const again = task.type === "remeasure" || fleet.isRemeasure(task, bed.id);
  r.setActivity("measure", again ? "複測中" : "量測中", bed.id);
  await r.speak(again ? `${patient.data.title}，我再幫您量一次呼吸和心跳喔。` : `${patient.data.title}您好，我幫您量呼吸和心跳，躺著放輕鬆就好。`, token);
  const res = await sensor.measure(bed, patient, token, r);
  fleet.record(res, r, again);
  if (res.level === "crit") {
    r.setActivity("alert", "異常通報", bed.id);
    await r.speak("數值偏高，已通知護理師過來。", token);
    await nurseResponds(ctx, r, bed, patient, res, token);
    await r.speak("護理師到了，我先繼續下一項工作。", token);
  } else {
    if (ctx.sim.rand() < 0.5) emit("speech", { who: `patient-${bed.id}`, name: patient.data.title, text: "好，謝謝你喔。" });
    const line = again
      ? res.level === "ok"
        ? "複測正常了，已更新護理紀錄。"
        : "複測已改善，數值我會請護理師留意。"
      : res.level === "warn"
        ? "量好了，數值我會請護理師留意。"
        : "量好了，謝謝您！";
    await r.speak(line, token);
  }
}

// the floor nurse walks to the bed; follow-up care continues while the robot moves on
async function nurseResponds(ctx, r, bed, patient, res, token) {
  const { sim, fleet } = ctx;
  const fid = FLOORS[bed.floor].id;
  const nurse = ctx.staff[`${fid}-nurseA`];
  const owner = { id: `alert-${bed.id}` };
  await claim(ctx, nurse, owner, token);
  const roomX = bed.id.endsWith("A") ? bed.x + 1.1 : bed.x - 1.1;
  const path = [[-0.2, 2.75], [-0.2, 1.75], [-0.2, 0.55], [roomX, 0.55], [roomX, -1.1], [roomX, -2.15], [bed.nurseSpot.x, bed.nurseSpot.z]];
  nurse.pose = "idle";
  say(nurse, `收到 ${bed.id} ${res.flags[0]} 的通知，我過去看看。`);
  fleet.alertStatus(bed.id, "護理師前往床邊");
  r.focusPerson = nurse;
  await nurse.walkTo(path, sim, token, bed.nurseSpot.yaw);
  nurse.pose = "check";
  fleet.alertStatus(bed.id, "護理師已到床邊處置");
  const hrAlarm = res.flags[0].startsWith("HR");
  say(
    nurse,
    hrAlarm
      ? `${patient.data.title}，心跳有點快，我先幫您量血壓；已請醫師開緊急用藥，請機器人送上來。`
      : `${patient.data.title}，我幫您把床頭搖高一點，呼吸會比較順。`,
  );
  if (hrAlarm) fleet.requestStat(bed, patient);
  const bg = fleet.token; // follow-up care outlives this robot's task
  sim.wait(5, bg).then(() => {
    if (r.focusPerson === nurse) r.focusPerson = null;
  }, ignoreCancel);
  (async () => {
    await sim.wait(16, bg);
    if (hrAlarm) patient.hr = Math.max(92, patient.hr - 14);
    else patient.rr = Math.max(19, patient.rr - 6);
    say(nurse, `狀況穩定了，${fleet.settings.remeasureAfter} 分鐘後請機器人複測。`);
    fleet.alertStatus(bed.id, `已處置・${fleet.settings.remeasureAfter} 分鐘後複測`, true);
    await sim.wait(4, bg);
    await walkHome(ctx, nurse, owner, path.slice(0, -1).reverse(), bg);
  })().catch(ignoreCancel);
}

// ----------------------------------------------------------------- delivery
export async function delivery(ctx, r, task, token) {
  const { fleet, hospital, staff, sim } = ctx;
  const fid = FLOORS[task.floor].id;
  const shelf = task.shelf;
  const ph = staff.pharmacist;
  const who = () => task.items.map((it) => `${it.bed} ${it.title}`).join("、");
  task.stage = "pickup";
  fleet.step(task, "前往 1F 醫務室藥局", 0.06);
  r.setActivity("move", task.priority === 1 ? "緊急取藥" : "前往藥局", "1F 醫務室");
  r.startCommand("move_shelf", `target_shelf_id="${shelf.id}", destination_location_id="${fid}-station"`);
  await r.goTo(r.shelfApproach(shelf.pose()), token, { label: "1F 藥局" });

  fleet.step(task, `藥師備藥並上鎖（${task.items.length} 份）`, 0.22);
  r.setActivity("handoff", "等待備藥", "1F 藥局");
  await claim(ctx, ph, r, token);
  task.loading = true; // late orders for the same floor can no longer join
  await r.speak(`藥局您好，我來領 ${fid} ${who()} 的藥。`, token);
  r.focusPerson = ph;
  // preparing the order takes a little longer some days
  await sim.wait(3 + 12 * sim.keyed(Math.round(task.createdClock), task.floor, "prep"), token);
  ph.pose = "idle";
  const spot = shelf.loadSpot;
  await ph.walkTo(spot.path, sim, token, spot.yaw);
  ph.pose = "carry";
  for (let k = 1; k <= Math.min(3, task.items.length + 1); k++) {
    await sim.wait(0.9, token);
    shelf.load(k);
  }
  say(ph, `${task.priority === 1 ? "緊急用藥" : `${task.items[0].title}的藥`}備好了，抽屜已上鎖。`);
  r.focusPerson = null;
  walkHome(ctx, ph, r, spot.path.slice(0, -1).reverse(), fleet.token);
  await sim.wait(1.2, token);

  fleet.step(task, `對接 ${shelf.id}`, 0.32);
  await r.dockShelf(shelf, token);
  task.loaded = true;
  task.stage = "deliver";
  fleet.step(task, `${task.priority === 1 ? "緊急" : ""}送往 ${fid} 護理站`, 0.42);
  r.setActivity("move", task.priority === 1 ? "緊急配送中" : "藥品配送中", `→ ${fid}`);
  const station = hospital.location(`${fid}-station`);
  await r.goTo(station, token, { label: station.name });

  fleet.step(task, "護理人員取件簽收", 0.72);
  r.setActivity("handoff", "等待取件", station.name);
  const nurse = staff[receiverOf(fid)];
  await claim(ctx, nurse, r, token);
  await r.speak(`${fid} 您好，${who()} 的藥送到了，請取件。`, token);
  const pick = hospital.staffSpots[`${fid}-pickup`];
  const lane = [-0.45, Math.min(nurse.home.z, 3.0)];
  r.focusPerson = nurse;
  // the nurse finishes what she is doing first
  await sim.wait(2 + 10 * sim.keyed(Math.round(task.createdClock), task.floor, "pickup"), token);
  nurse.pose = "idle";
  await nurse.walkTo([lane, [pick.x, pick.z]], sim, token, pick.yaw);
  nurse.pose = "hand";
  while (shelf.loaded) {
    await sim.wait(0.9, token);
    shelf.unloadOne();
  }
  say(nurse, task.priority === 1 ? "收到緊急用藥，謝謝！我馬上給藥。" : "收到，謝謝小幫手！");
  r.focusPerson = null;
  fleet.delivered(task, r);
  walkHome(ctx, nurse, r, [lane], fleet.token);
  nurse.pose = "carry";
  await sim.wait(1.2, token);

  task.stage = "return";
  fleet.step(task, `歸還 ${shelf.id} 至 1F 藥局`, 0.82);
  await r.returnShelf(shelf, token);
}

// ------------------------------------------------------------------- patrol
export async function patrol(ctx, r, task, token) {
  const { fleet, hospital } = ctx;
  r.startCommand("start_shortcut_command", 'target_shortcut_id="patrol-2F-dementia"');
  const total = hospital.patrol.length;
  while (task.points.length) {
    const stop = fleet.interruptReason(r, task);
    if (stop) {
      fleet.step(task, stop === "battery" ? "電量過低，巡視交接" : "接獲 P1 緊急任務，巡視暫停");
      return { interrupted: stop };
    }
    const cp = hospital.location(task.points[0]);
    const k = total - task.points.length;
    fleet.step(task, `巡檢點 ${k + 1}/${total}：${cp.name}`, 0.08 + 0.84 * (k / total));
    r.setActivity("move", "巡視中", cp.name);
    if (cp.id === "2F-cp-activity" && task.wander) await wanderingResident(ctx, r, task, cp, token);
    else await r.goTo(cp, token);
    r.setActivity("patrol", "巡檢掃描", cp.name);
    await r.rotateInPlace(0.7, token);
    await r.rotateInPlace(-1.4, token);
    await r.rotateInPlace(0.7, token);
    const people = r.detections.filter((d) => d.label === "PERSON").length;
    emit("log", { tag: "nav", robot: r, html: `${cp.name}：DOOR 關閉 ✓・PERSON ×${people}` });
    task.points.shift();
  }
  fleet.patrolled(task);
  await r.speak("2F 巡視完成。", token);
}

// a resident heads for the controlled exit: the robot stops to talk and calls the care attendant
async function wanderingResident(ctx, r, task, cp, token) {
  const { fleet, staff, sim, hospital } = ctx;
  const res = staff.wanderer;
  const carer = staff["2F-carer"];
  if (!res.sitting || carer.busy) {
    await r.goTo(cp, token);
    return;
  }
  task.wander = false;
  const seat = res.home;
  const lane = hospital.exitPoint.z;
  const bg = fleet.token;
  const move = r.goTo(cp, token);
  res.walkTo([[seat.x, 1.4], [seat.x - 0.9, lane], [hospital.exitPoint.x, lane]], sim, bg, Math.PI).catch(ignoreCancel);
  // if this robot is pulled away (fault), the resident still goes back to the activity room
  sim.wait(120, bg).then(() => {
    if (!res.sitting && !res.walking && !carer.busy) res.walkTo([[seat.x, 1.4], [seat.x, seat.z]], sim, bg, seat.yaw).then(() => (res.sitting = true), ignoreCancel);
  }, ignoreCancel);
  const near = sim.until(() => !res.sitting && Math.hypot(res.x - r.x, res.z - r.z) < 3.0, token);
  if ((await Promise.race([move.then(() => "arrived"), near.then(() => "near")])) === "arrived") {
    res.stop();
    res.walkTo([[seat.x, 1.4], [seat.x, seat.z]], sim, bg, seat.yaw).then(() => (res.sitting = true), ignoreCancel);
    return;
  }
  await claim(ctx, carer, r, token);
  r.hold = true;
  r.focusPerson = res;
  res.stop();
  res.finalYaw = yawTo(r.x - res.x, r.z - res.z);
  r.setActivity("alert", "住民遊走提醒", "2F 往出入口");
  fleet.step(task, "偵測到住民往出入口移動，通知照服員");
  emit("log", { tag: "nav", robot: r, html: "前鏡頭偵測 PERSON：住民 陳伯伯 往出入口方向移動" });
  emit("log", { tag: "alert", robot: r, html: "2F 失智照顧專區：住民往出入口移動 → 通知 2F 照服站與 LINE 群組" });
  fleet.kpi.alerts++;
  emit("kpi");
  await r.speak("陳伯伯午安，要去哪裡呀？我請照服員來陪您喔。", token);
  say(res, "我要回家……");
  say(carer, "收到，我來陪陳伯伯。");
  carer.pose = "idle";
  const meet = [res.x - 0.75, res.z + 0.15];
  await carer.walkTo([[-0.2, 2.75], [-0.2, 1.1], [meet[0], 1.1], meet], sim, token, yawTo(res.x - meet[0], res.z - meet[1]));
  res.finalYaw = yawTo(carer.x - res.x, carer.z - res.z);
  say(carer, "陳伯伯，我們回活動室喝茶好嗎？");
  await sim.wait(2.5, token);
  say(res, "好啊，好啊。");
  emit("log", { tag: "staff", html: "照服員 阿芳 陪同住民 陳伯伯 返回活動室" });
  (async () => {
    await Promise.all([
      res.walkTo([[seat.x, 1.4], [seat.x, seat.z]], sim, bg, seat.yaw),
      carer.walkTo([[seat.x - 0.75, 1.45], [seat.x - 0.75, 2.1]], sim, bg, 0),
    ]);
    res.sitting = true;
    carer.pose = "check";
    await sim.wait(6, bg);
    await walkHome(ctx, carer, r, [[1.6, 1.3], [-0.2, 1.3], [-0.2, 2.75]], bg);
  })().catch(ignoreCancel);
  await sim.wait(1.2, token);
  await r.speak("謝謝阿芳，我繼續巡視。", token);
  r.focusPerson = null;
  r.hold = false;
  r.setActivity("move", "巡視中", cp.name);
  await move;
  emit("log", { tag: "nav", robot: r, html: "活動室：住民 陳伯伯 已由照服員陪同返回 ✓" });
}

export const EXECUTORS = { rounds, remeasure, delivery, patrol };
