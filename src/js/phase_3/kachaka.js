import * as THREE from "three";
import { toCreasedNormals } from "three/addons/utils/BufferGeometryUtils.js";
import { KACHAKA_MESHES } from "./kachakaMeshData.js";
import { KACHAKA, FLOOR_GAP, FLOORS, ELEVATOR, CORRIDOR } from "./config.js";
import { std, shadowMaterial } from "./builders.js";
import { emit, fwd, yawTo, wrapAngle, approach } from "./sim.js";

const LINEAR_ACC = 0.45; // m/s^2
const ANGULAR_ACC = 2.6; // rad/s^2
const LANE = CORRIDOR.laneZ;

// --- decode the embedded STL-derived meshes (see kachakaMeshData.js) ---
function b64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function decodePart(part) {
  const q = new Int16Array(b64ToBytes(part.positions).buffer);
  const idx = new Uint16Array(b64ToBytes(part.indices).buffer);
  const pos = new Float32Array(q.length);
  for (let i = 0; i < q.length; i++) {
    const axis = i % 3;
    const t = (q[i] + 32768) / 65535;
    pos[i] = part.min[axis] + t * (part.max[axis] - part.min[axis]);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  g.setIndex(new THREE.BufferAttribute(idx, 1));
  return toCreasedNormals(g, THREE.MathUtils.degToRad(32));
}

export class Kachaka {
  constructor({ sim, elevator }) {
    this.sim = sim;
    this.elevator = elevator;
    this.name = "Kachaka Pro";
    this.serial = "KCK-PRO-0427";
    this.floor = 0;
    this.x = -1.4;
    this.z = -4.45;
    this.yaw = -Math.PI / 2;
    this.y = 0;
    this.v = 0;
    this.w = 0;
    this.mode = "idle";
    this.path = [];
    this.pathIndex = 0;
    this.finalYaw = null;
    this.rotateTarget = 0;
    this.forwardRemaining = 0;
    this.forwardSpeed = 0.2;
    this.shelf = null;
    this.pin = 0;
    this.battery = 86;
    this.onCharger = true;
    this.odometer = 412;
    this.inElevator = false;
    this.rideTarget = null;
    this.mutedSensors = false;
    this.lastLoc = null;
    this.exitVia = [[-1.4, -3.0], [-2.25, -2.4], [-2.25, CORRIDOR.minZ]];
    this.activity = { kind: "charge", label: "充電中", detail: "1F 充電座" };
    this.command = { name: "get_battery_info", args: "", state: "PENDING" };
    this.blocked = false;
    this.blockedSince = 0;
    this.lastYieldSpeech = -99;
    this.detections = [];
    this.scanTimer = 0;
    this.people = [];
    this.obstacleFn = () => [];

    const rays = KACHAKA.lidar.rays;
    this.scan = { ranges: new Float32Array(rays).fill(KACHAKA.lidar.range), nearest: KACHAKA.lidar.range, ox: 0, oz: 0, yaw: 0 };

    this.group = new THREE.Group();
    this.group.name = "kachaka";
    this.#buildModel();
    this.#buildOverlays();
    this.#sync();
  }

  // ------------------------------------------------------------- visuals
  #buildModel() {
    const bodyMat = std(0x383c3f, { roughness: 0.48, metalness: 0.12 });
    const tireMat = std(0x26292b, { roughness: 0.9 });
    const pinMat = std(0xb6bec2, { roughness: 0.3, metalness: 0.8 });
    this.body = new THREE.Mesh(decodePart(KACHAKA_MESHES.body), bodyMat);
    this.group.add(this.body);

    // wheel joints: base_[l|r]_drive_wheel_joint at (0, +/-0.100, 0.045) in ROS -> three (0, 0.045, -/+0.100)
    this.wheels = [
      { mesh: new THREE.Mesh(decodePart(KACHAKA_MESHES.leftTire), tireMat), z: -0.1 },
      { mesh: new THREE.Mesh(decodePart(KACHAKA_MESHES.rightTire), tireMat), z: 0.1 },
    ];
    for (const wh of this.wheels) {
      wh.pivot = new THREE.Group();
      wh.pivot.position.set(0, KACHAKA.wheelRadius, wh.z);
      wh.pivot.add(wh.mesh);
      this.group.add(wh.pivot);
    }
    this.solenoid = new THREE.Mesh(decodePart(KACHAKA_MESHES.solenoid), pinMat);
    this.solenoid.position.y = 0.074;
    this.group.add(this.solenoid);

    // status light strip on the front face
    this.ledMat = new THREE.MeshBasicMaterial({ color: 0x4ee08b });
    const led = new THREE.Mesh(new THREE.BoxGeometry(0.006, 0.012, 0.11), this.ledMat);
    led.position.set(0.237, 0.088, 0);
    this.group.add(led);

    const shadow = new THREE.Mesh(new THREE.PlaneGeometry(0.72, 0.5).rotateX(-Math.PI / 2), shadowMaterial(0.42));
    shadow.position.set(0.045, 0.006, 0);
    this.group.add(shadow);

    // locator ring so the robot stays easy to find from far away
    this.ringMat = new THREE.MeshBasicMaterial({ color: 0x2bd4b8, transparent: true, opacity: 0.55, depthWrite: false });
    this.ring = new THREE.Mesh(new THREE.RingGeometry(0.36, 0.4, 48).rotateX(-Math.PI / 2), this.ringMat);
    this.ring.position.set(0.045, 0.012, 0);
    this.group.add(this.ring);
  }

  #buildOverlays() {
    const n = KACHAKA.lidar.rays;
    // LiDAR hit points
    this.scanGeo = new THREE.BufferGeometry();
    this.scanGeo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(n * 3), 3));
    this.scanPoints = new THREE.Points(
      this.scanGeo,
      new THREE.PointsMaterial({ color: 0xff4d4d, size: 0.055, sizeAttenuation: true, depthWrite: false, transparent: true, opacity: 0.95 }),
    );
    this.scanPoints.frustumCulled = false;
    // free-space fan
    this.fanGeo = new THREE.BufferGeometry();
    this.fanGeo.setAttribute("position", new THREE.BufferAttribute(new Float32Array((n + 1) * 3), 3));
    const idx = [];
    for (let i = 0; i < n - 1; i++) idx.push(0, i + 1, i + 2);
    this.fanGeo.setIndex(idx);
    this.scanFan = new THREE.Mesh(
      this.fanGeo,
      new THREE.MeshBasicMaterial({ color: 0xff6b5b, transparent: true, opacity: 0.08, depthWrite: false, side: THREE.DoubleSide }),
    );
    this.scanFan.frustumCulled = false;

    // planned path ribbon with flowing dashes
    const c = document.createElement("canvas");
    c.width = 64;
    c.height = 8;
    const g = c.getContext("2d");
    g.fillStyle = "rgba(43,212,184,1)";
    g.fillRect(0, 0, 36, 8);
    this.dashTex = new THREE.CanvasTexture(c);
    this.dashTex.wrapS = THREE.RepeatWrapping;
    this.pathGeo = new THREE.BufferGeometry();
    const maxSeg = 40;
    this.pathGeo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(maxSeg * 4 * 3), 3));
    this.pathGeo.setAttribute("uv", new THREE.BufferAttribute(new Float32Array(maxSeg * 4 * 2), 2));
    const pIdx = [];
    for (let i = 0; i < maxSeg; i++) pIdx.push(4 * i, 4 * i + 1, 4 * i + 2, 4 * i + 1, 4 * i + 3, 4 * i + 2);
    this.pathGeo.setIndex(pIdx);
    this.pathMaxSeg = maxSeg;
    this.pathMesh = new THREE.Mesh(
      this.pathGeo,
      new THREE.MeshBasicMaterial({ map: this.dashTex, transparent: true, opacity: 0.9, depthWrite: false, side: THREE.DoubleSide }),
    );
    this.pathMesh.frustumCulled = false;
    this.goalMarker = new THREE.Mesh(
      new THREE.RingGeometry(0.16, 0.22, 40).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ color: 0x2bd4b8, transparent: true, opacity: 0.85, depthWrite: false }),
    );
    this.goalMarker.visible = false;
    this.overlays = new THREE.Group();
    this.overlays.add(this.scanPoints, this.scanFan, this.pathMesh, this.goalMarker);
  }

  // ---------------------------------------------------------- state/UI
  setActivity(kind, label, detail = "") {
    this.activity = { kind, label, detail };
    emit("activity", this.activity);
  }

  startCommand(name, args = "", log = true) {
    this.command = { name, args, state: "RUNNING" };
    emit("command", this.command);
    if (log) emit("log", { tag: "api", html: `<code>${name}(${args})</code>` });
  }

  endCommand() {
    this.command = { ...this.command, state: "PENDING" };
    emit("command", this.command);
  }

  say(text) {
    emit("speech", { who: "robot", name: "Kachaka", text });
  }

  async speak(text, token) {
    this.startCommand("speak", `"${text}"`, false);
    emit("log", { tag: "api", html: `<code>speak</code> 「${text}」` });
    this.say(text);
    await this.sim.wait(Math.max(2.2, text.length * 0.16), token);
    this.endCommand();
  }

  get mapId() {
    return FLOORS[this.floor].map;
  }

  get speedLimit() {
    return this.shelf ? KACHAKA.shelfLinear : KACHAKA.maxLinear;
  }

  // ------------------------------------------------------- motion API
  moveAlong(points, finalYaw, token) {
    this.path = points.map(([x, z]) => ({ x, z }));
    this.pathIndex = 0;
    this.finalYaw = finalYaw;
    this.mode = this.path.length ? "path" : finalYaw !== null && finalYaw !== undefined ? "rotate" : "idle";
    if (this.mode === "rotate") this.rotateTarget = finalYaw;
    this.#updatePathMesh(true);
    return this.sim.until(() => this.mode === "idle", token);
  }

  rotateTo(yaw, token) {
    this.rotateTarget = wrapAngle(yaw);
    this.mode = "rotate";
    return this.sim.until(() => this.mode === "idle", token);
  }

  rotateInPlace(angle, token) {
    this.startCommand("rotate_in_place", `angle_radian=${angle.toFixed(2)}`, false);
    return this.rotateTo(this.yaw + angle, token).then(() => this.endCommand());
  }

  moveForward(distance, speed, token, mute = false) {
    this.forwardRemaining = distance;
    this.forwardSpeed = speed;
    this.mutedSensors = mute;
    this.mode = "forward";
    return this.sim.until(() => this.mode === "idle", token).then(() => {
      this.mutedSensors = false;
    });
  }

  // route on the current floor: leave the current room, run the corridor lane, enter the target
  route(loc) {
    const pts = [];
    const same = this.lastLoc && this.lastLoc.floor === loc.floor && loc.via.length > 0 && JSON.stringify(loc.via) === JSON.stringify(this.lastLoc.via);
    const door = this.exitVia.length ? this.exitVia[this.exitVia.length - 1] : null;
    const sameDoor = !same && door && loc.via.length > 0 && loc.via[0][0] === door[0] && loc.via[0][1] === door[1];
    if (sameDoor) {
      // both places are behind the same door: stay inside the room
      for (const p of this.exitVia.slice(0, -1)) pts.push(p);
      for (const p of loc.via.slice(1)) pts.push(p);
    } else if (!same) {
      for (const p of this.exitVia) pts.push(p);
      const start = pts.length ? pts[pts.length - 1] : [this.x, this.z];
      const entry = loc.via.length ? loc.via[0] : [loc.x, loc.z];
      pts.push([start[0], LANE], [entry[0], LANE]);
      for (const p of loc.via) pts.push(p);
    }
    pts.push([loc.x, loc.z]);
    // drop duplicates and points we are already standing on
    const out = [];
    let px = this.x;
    let pz = this.z;
    for (const p of pts) {
      if (Math.hypot(p[0] - px, p[1] - pz) > 0.04) {
        out.push(p);
        px = p[0];
        pz = p[1];
      }
    }
    return out;
  }

  async goTo(loc, token, { label } = {}) {
    if (loc.floor !== this.floor) await this.rideElevator(loc.floor, token);
    const name = label || loc.name;
    this.startCommand("move_to_location", `target_location_id="${loc.id}"`);
    emit("nav", { floor: loc.floor, x: loc.x, z: loc.z, name });
    await this.moveAlong(this.route(loc), loc.yaw, token);
    this.#arrive(loc);
    this.endCommand();
  }

  #arrive(loc) {
    this.lastLoc = loc;
    this.exitVia = [...loc.via].reverse();
  }

  async departFromCharger(token) {
    if (!this.onCharger) return;
    this.startCommand("depart_from_charger");
    this.onCharger = false;
    await this.moveForward(0.7, 0.15, token);
    this.lastLoc = null;
    this.endCommand();
  }

  // shelf approach pose: robot stands dockDepth in front of the shelf, facing it
  shelfApproach(home) {
    const f = fwd(home.yaw);
    return {
      id: `${FLOORS[home.floor].id}-${home.id || "shelf"}-approach`,
      floor: home.floor,
      name: home.name,
      x: home.x - f.x * KACHAKA.dockDepth,
      z: home.z - f.z * KACHAKA.dockDepth,
      yaw: home.yaw,
      via: home.via,
    };
  }

  async dockShelf(shelf, token) {
    const appr = this.shelfApproach(shelf.pose());
    if (Math.hypot(this.x - appr.x, this.z - appr.z) > 0.05 || this.floor !== appr.floor) {
      await this.goTo(appr, token, { label: shelf.name });
    }
    this.setActivity("dock", "對接家具", shelf.name);
    this.startCommand("dock_shelf");
    await this.rotateTo(appr.yaw, token);
    await this.moveForward(KACHAKA.dockDepth, 0.1, token, true);
    this.shelf = shelf;
    shelf.dockTo(this);
    await this.sim.wait(1.2, token);
    emit("log", { tag: "api", html: `已對接 <b>${shelf.name}</b>（docking pin 上升 12 mm）` });
    this.endCommand();
  }

  async undockShelf(token, backOut = true) {
    if (!this.shelf) return;
    const shelf = this.shelf;
    this.startCommand("undock_shelf", `target_shelf_id="${shelf.id}"`);
    shelf.release(this.floor, this.x, this.z, this.yaw);
    this.shelf = null;
    await this.sim.wait(1.0, token);
    if (backOut) await this.moveForward(-KACHAKA.dockDepth, 0.12, token, true);
    this.endCommand();
  }

  async returnShelf(shelf, token) {
    const home = shelf.home;
    const appr = this.shelfApproach(home);
    this.setActivity("move", "歸還家具", shelf.name);
    this.startCommand("return_shelf", `target_shelf_id="${shelf.id}"`);
    if (this.floor !== home.floor) await this.rideElevator(home.floor, token);
    this.startCommand("return_shelf", `target_shelf_id="${shelf.id}"`, false);
    await this.moveAlong(this.route(appr), appr.yaw, token);
    this.#arrive(appr);
    await this.moveForward(KACHAKA.dockDepth, 0.1, token, true);
    await this.undockShelf(token, true);
    emit("log", { tag: "api", html: `<b>${shelf.name}</b> 已歸位` });
    this.endCommand();
  }

  async returnHome(chargerLoc, charger, token) {
    this.setActivity("move", "返回充電座", "1F 機器人站");
    this.startCommand("return_home");
    if (this.floor !== chargerLoc.floor) await this.rideElevator(chargerLoc.floor, token);
    this.startCommand("return_home", "", false);
    await this.moveAlong(this.route(chargerLoc), chargerLoc.yaw, token);
    this.#arrive(chargerLoc);
    await this.moveForward(-Math.hypot(chargerLoc.x - charger.x, chargerLoc.z - charger.z), 0.12, token, true);
    this.onCharger = true;
    this.setActivity("charge", "充電中", "1F 充電座");
    this.endCommand();
  }

  // --- cross-floor travel: elevator IoT call + map switch on arrival ---
  async rideElevator(target, token) {
    const el = this.elevator;
    const from = this.floor;
    const fromId = FLOORS[from].id;
    const toId = FLOORS[target].id;
    const landing = { id: `${fromId}-elevator`, floor: from, name: `${fromId} 電梯廳`, x: ELEVATOR.landingX, z: 0, yaw: Math.PI, via: [] };
    this.rideTarget = target;
    this.setActivity("move", "前往電梯", `${fromId} → ${toId}`);
    emit("log", { tag: "nav", html: `跨樓層路徑 ${fromId} → 電梯 → ${toId}` });
    this.startCommand("move_to_location", `target_location_id="${landing.id}"`);
    await this.moveAlong(this.route(landing), Math.PI, token);
    this.#arrive(landing);

    this.setActivity("lift", "等待電梯", `呼叫至 ${fromId}`);
    this.startCommand("elevator.call", `floor="${fromId}"`, false);
    emit("log", { tag: "lift", html: `電梯 IoT API：呼叫至 <b>${fromId}</b>` });
    await el.callTo(from, this.sim, token);
    this.say("機器人進入電梯，請稍候。");
    this.setActivity("lift", "進入電梯", `${fromId} → ${toId}`);
    this.startCommand("move_forward", `distance_meter=${(ELEVATOR.landingX - ELEVATOR.shaftX).toFixed(2)}, mute_sensors=True`);
    await this.moveForward(ELEVATOR.landingX - ELEVATOR.shaftX, 0.2, token, true);
    this.inElevator = true;
    el.occupied = true;
    await this.rotateInPlace(Math.PI, token);

    this.setActivity("lift", "搭乘電梯", `${fromId} → ${toId}`);
    emit("log", { tag: "lift", html: `電梯門關閉，前往 <b>${toId}</b>` });
    await el.travel(target, this.sim, token);
    this.floor = target;
    this.startCommand("switch_map", `map_id="${FLOORS[target].map}", inherit_docking_state_and_docked_shelf=True`);
    await this.sim.wait(1.4, token);
    emit("log", { tag: "lift", html: `抵達 <b>${toId}</b>，切換樓層地圖 <code>${FLOORS[target].map}</code>` });
    this.startCommand("move_forward", `distance_meter=${(ELEVATOR.landingX - ELEVATOR.shaftX).toFixed(2)}, mute_sensors=True`);
    await this.moveForward(ELEVATOR.landingX - ELEVATOR.shaftX, 0.2, token, true);
    this.inElevator = false;
    el.occupied = false;
    el.closeDoors(target, this.sim, token).catch(() => {});
    this.lastLoc = null;
    this.exitVia = [];
    this.endCommand();
    this.rideTarget = null;
    emit("ride", { from, to: target });
  }

  // ------------------------------------------------------------ update
  update(dt) {
    switch (this.mode) {
      case "path":
        this.#followPath(dt);
        break;
      case "rotate":
        this.#rotate(dt);
        break;
      case "forward":
        this.#forward(dt);
        break;
      default:
        this.v = approach(this.v, 0, LINEAR_ACC * dt);
        this.w = approach(this.w, 0, ANGULAR_ACC * dt);
    }
    this.yaw = wrapAngle(this.yaw + this.w * dt);
    const f = fwd(this.yaw);
    const step = this.v * dt;
    this.x += f.x * step;
    this.z += f.z * step;
    if (this.mode === "forward") this.forwardRemaining -= step;
    this.odometer += Math.abs(step);

    // battery (discharge while active, charge on the dock)
    if (this.onCharger) this.battery = Math.min(100, this.battery + dt * (6 / 60));
    else this.battery = Math.max(5, this.battery - dt * ((Math.abs(this.v) > 0.01 ? 7 : 2) / 3600) * (this.shelf ? 1.25 : 1));

    // wheels: v +/- w*track/2
    for (const wh of this.wheels) {
      const side = wh.z < 0 ? -1 : 1;
      const vw = this.v + side * this.w * (KACHAKA.wheelTrack / 2);
      wh.pivot.rotation.z -= (vw / KACHAKA.wheelRadius) * dt;
    }
    this.pin = approach(this.pin, this.shelf ? 1 : 0, dt / 0.8);
    this.y = this.inElevator ? this.elevator.cabY : this.floor * FLOOR_GAP;
    if (this.shelf) this.shelf.follow(this);
    this.#sync();
  }

  #sync() {
    this.group.position.set(this.x, this.y, this.z);
    this.group.rotation.y = this.yaw;
    this.solenoid.position.y = 0.074 + this.pin * KACHAKA.pinTravel;
  }

  // distance along the path to the next waypoint where the robot has to stop and turn
  #stopDistance() {
    let dist = 0;
    let px = this.x;
    let pz = this.z;
    let prevYaw = this.yaw;
    for (let i = this.pathIndex; i < this.path.length; i++) {
      const p = this.path[i];
      const segYaw = yawTo(p.x - px, p.z - pz);
      if (i > this.pathIndex && Math.abs(wrapAngle(segYaw - prevYaw)) > 0.55) return dist;
      dist += Math.hypot(p.x - px, p.z - pz);
      prevYaw = segYaw;
      px = p.x;
      pz = p.z;
    }
    return dist;
  }

  #followPath(dt) {
    const p = this.path[this.pathIndex];
    if (!p) {
      this.path = [];
      this.v = 0;
      if (this.finalYaw !== null && this.finalYaw !== undefined) {
        this.rotateTarget = this.finalYaw;
        this.mode = "rotate";
      } else {
        this.mode = "idle";
      }
      this.#updatePathMesh(true);
      return;
    }
    const dx = p.x - this.x;
    const dz = p.z - this.z;
    const d = Math.hypot(dx, dz);
    const last = this.pathIndex === this.path.length - 1;
    if (d < (last ? 0.012 : 0.06)) {
      if (last) {
        this.x = p.x;
        this.z = p.z;
      }
      this.pathIndex++;
      return;
    }
    const err = wrapAngle(yawTo(dx, dz) - this.yaw);
    if (Math.abs(err) > 0.4) {
      this.v = approach(this.v, 0, LINEAR_ACC * 2 * dt);
      const wt = Math.sign(err) * Math.min(KACHAKA.maxAngular * 0.85, Math.sqrt(2 * ANGULAR_ACC * Math.abs(err)));
      this.w = Math.abs(this.v) < 0.03 ? approach(this.w, wt, ANGULAR_ACC * dt) : 0;
      return;
    }
    const stop = this.#stopDistance();
    const vAllow = Math.sqrt(2 * LINEAR_ACC * 0.8 * Math.max(0, stop)) + 0.015;
    let vt = Math.min(this.speedLimit, vAllow) * (1 - Math.abs(err) / 0.8);
    vt *= this.#yieldFactor();
    this.v = approach(this.v, vt, LINEAR_ACC * dt);
    if (this.v * dt > d) this.v = d / dt;
    this.w = THREE.MathUtils.clamp(3.2 * err, -KACHAKA.maxAngular, KACHAKA.maxAngular);
  }

  #rotate(dt) {
    const err = wrapAngle(this.rotateTarget - this.yaw);
    this.v = approach(this.v, 0, LINEAR_ACC * 2 * dt);
    if (Math.abs(err) < Math.max(0.006, Math.abs(this.w) * dt * 1.2)) {
      this.yaw = this.rotateTarget;
      this.w = 0;
      this.mode = "idle";
      return;
    }
    const wt = Math.sign(err) * Math.min(KACHAKA.maxAngular * 0.8, Math.sqrt(2 * ANGULAR_ACC * Math.abs(err)) + 0.05);
    this.w = approach(this.w, wt, ANGULAR_ACC * dt);
  }

  #forward(dt) {
    const rem = this.forwardRemaining;
    if (Math.abs(rem) < 0.003) {
      this.v = 0;
      this.mode = "idle";
      return;
    }
    const dir = Math.sign(rem);
    const vt = dir * Math.min(this.forwardSpeed, Math.sqrt(2 * LINEAR_ACC * Math.abs(rem)) + 0.01);
    this.v = approach(this.v, vt, LINEAR_ACC * dt);
    if (Math.abs(this.v * dt) >= Math.abs(rem)) {
      this.v = rem / dt;
    }
    this.w = 0;
  }

  // slow down / stop for people in front (camera + LiDAR person detection)
  #yieldFactor() {
    if (this.mutedSensors || this.inElevator) return 1;
    const f = fwd(this.yaw);
    let factor = 1;
    let blocker = null;
    for (const p of this.people) {
      if (p.floor !== this.floor || p.sitting) continue;
      const rx = p.x - this.x;
      const rz = p.z - this.z;
      const along = rx * f.x + rz * f.z;
      const lat = Math.abs(rx * -f.z + rz * f.x);
      if (along > 0.1 && along < 1.45 && lat < 0.5) {
        const k = THREE.MathUtils.clamp((along - 0.75) / 0.6, 0, 1);
        if (k < factor) {
          factor = k;
          blocker = p;
        }
      }
    }
    const blocked = factor < 0.05;
    if (blocked && !this.blocked) {
      this.blockedSince = this.sim.time;
      emit("log", { tag: "nav", html: `偵測到 PERSON（${blocker.roleDef.label}）於前方 ${(Math.hypot(blocker.x - this.x, blocker.z - this.z)).toFixed(1)} m，減速禮讓` });
      if (this.sim.time - this.lastYieldSpeech > 12) {
        this.lastYieldSpeech = this.sim.time;
        this.say("不好意思，借過一下。");
      }
    }
    this.blocked = blocked;
    return factor;
  }

  // ---------------------------------------------------------- sensors
  updateSensors(realDt, segments) {
    this.scanTimer += realDt;
    this.dashTex.offset.x -= realDt * 1.6;
    this.ring.scale.setScalar(1 + 0.08 * Math.sin(performance.now() / 300));
    if (this.scanTimer < 1 / 15) return;
    this.scanTimer = 0;
    this.#updatePathMesh(false);
    this.#lidar(segments);
    this.#detect();
  }

  #lidar(segments) {
    const L = KACHAKA.lidar;
    const f = fwd(this.yaw);
    const ox = this.x + f.x * L.x;
    const oz = this.z + f.z * L.x;
    const y = this.y + L.y;
    const pos = this.scanGeo.attributes.position.array;
    const fan = this.fanGeo.attributes.position.array;
    fan[0] = ox;
    fan[1] = y - 0.06;
    fan[2] = oz;
    let nearest = L.range;
    const circles = this.people.filter((p) => p.floor === this.floor).map((p) => [p.x, p.z, 0.2]);
    for (let i = 0; i < L.rays; i++) {
      const a = this.yaw - L.fov / 2 + (i * L.fov) / (L.rays - 1);
      const dx = Math.cos(a);
      const dz = -Math.sin(a);
      let t = L.range;
      for (const s of segments) {
        const hit = raySeg(ox, oz, dx, dz, s[0], s[1], s[2], s[3]);
        if (hit > 0.02 && hit < t) t = hit;
      }
      for (const c of circles) {
        const hit = rayCircle(ox, oz, dx, dz, c[0], c[1], c[2]);
        if (hit > 0.02 && hit < t) t = hit;
      }
      this.scan.ranges[i] = t;
      nearest = Math.min(nearest, t);
      const hx = ox + dx * t;
      const hz = oz + dz * t;
      if (t < L.range) {
        pos[i * 3] = hx;
        pos[i * 3 + 1] = y;
        pos[i * 3 + 2] = hz;
      } else {
        pos[i * 3] = ox;
        pos[i * 3 + 1] = y - 0.08;
        pos[i * 3 + 2] = oz;
      }
      fan[(i + 1) * 3] = hx;
      fan[(i + 1) * 3 + 1] = y - 0.06;
      fan[(i + 1) * 3 + 2] = hz;
    }
    this.scan.nearest = nearest;
    this.scan.yaw = this.yaw;
    this.scanGeo.attributes.position.needsUpdate = true;
    this.fanGeo.attributes.position.needsUpdate = true;
    const visible = !this.mutedSensors || this.inElevator;
    this.scanPoints.material.opacity = visible ? 0.95 : 0.35;
  }

  // object detection on the front camera (labels mirror kachaka-api ObjectLabel)
  #detect() {
    const f = fwd(this.yaw);
    const out = [];
    const consider = (label, x, z, extra = "") => {
      const rx = x - this.x;
      const rz = z - this.z;
      const d = Math.hypot(rx, rz);
      if (d > 4.2 || d < 0.2) return;
      const cos = (rx * f.x + rz * f.z) / d;
      if (cos < Math.cos(THREE.MathUtils.degToRad(48))) return;
      out.push({ label, distance: d, score: Math.max(0.62, 0.98 - d * 0.06), extra });
    };
    if (!this.inElevator) {
      for (const p of this.people) if (p.floor === this.floor) consider("PERSON", p.x, p.z, p.roleDef.label);
      for (const s of this.obstacleFn()) if (s.floor === this.floor && s !== this.shelf) consider("SHELF", s.x, s.z, s.id);
      if (this.floor === 0) consider("CHARGER", -1.4, -4.8);
      for (const x of [-6.75, -2.25, 2.25, 6.75]) consider("DOOR", x, CORRIDOR.minZ);
    }
    out.sort((a, b) => a.distance - b.distance);
    this.detections = out.slice(0, 4);
  }

  #updatePathMesh(force) {
    const remaining = this.mode === "path" ? this.path.slice(this.pathIndex) : [];
    if (!remaining.length) {
      if (this.pathMesh.visible || force) {
        this.pathMesh.visible = false;
        this.goalMarker.visible = false;
      }
      return;
    }
    const pts = [{ x: this.x, z: this.z }, ...remaining];
    const y = this.floor * FLOOR_GAP + 0.03;
    const pos = this.pathGeo.attributes.position.array;
    const uv = this.pathGeo.attributes.uv.array;
    const hw = 0.035;
    let u = 0;
    let n = 0;
    for (let i = 0; i < pts.length - 1 && n < this.pathMaxSeg; i++) {
      const a = pts[i];
      const b = pts[i + 1];
      const len = Math.hypot(b.x - a.x, b.z - a.z);
      if (len < 1e-4) continue;
      const nx = (-(b.z - a.z) / len) * hw;
      const nz = ((b.x - a.x) / len) * hw;
      pos.set([a.x + nx, y, a.z + nz, a.x - nx, y, a.z - nz, b.x + nx, y, b.z + nz, b.x - nx, y, b.z - nz], n * 12);
      const u2 = u + len / 0.22;
      uv.set([u, 0, u, 1, u2, 0, u2, 1], n * 8);
      u = u2;
      n++;
    }
    this.pathGeo.attributes.position.needsUpdate = true;
    this.pathGeo.attributes.uv.needsUpdate = true;
    this.pathGeo.setDrawRange(0, n * 6);
    this.pathMesh.visible = n > 0;
    const goal = pts[pts.length - 1];
    this.goalMarker.position.set(goal.x, y + 0.002, goal.z);
    this.goalMarker.visible = true;
  }

  // ------------------------------------------------------------ reset
  teleport(floor, x, z, yaw, { onCharger = false } = {}) {
    this.floor = floor;
    this.x = x;
    this.z = z;
    this.yaw = yaw;
    this.v = 0;
    this.w = 0;
    this.mode = "idle";
    this.path = [];
    this.inElevator = false;
    this.rideTarget = null;
    this.mutedSensors = false;
    this.onCharger = onCharger;
    this.blocked = false;
    this.y = floor * FLOOR_GAP;
    this.#updatePathMesh(true);
    this.#sync();
  }

  anchor(target) {
    return target.set(this.x, this.y + (this.shelf ? 1.25 : 0.55), this.z);
  }
}

// ray (o + t*d) vs segment; returns t or Infinity
function raySeg(ox, oz, dx, dz, x1, z1, x2, z2) {
  const ex = x2 - x1;
  const ez = z2 - z1;
  const den = dx * ez - dz * ex;
  if (Math.abs(den) < 1e-9) return Infinity;
  const wx = x1 - ox;
  const wz = z1 - oz;
  const t = (wx * ez - wz * ex) / den;
  const s = (wx * dz - wz * dx) / den;
  if (t < 0 || s < 0 || s > 1) return Infinity;
  return t;
}

function rayCircle(ox, oz, dx, dz, cx, cz, r) {
  const fx = ox - cx;
  const fz = oz - cz;
  const b = fx * dx + fz * dz;
  const c = fx * fx + fz * fz - r * r;
  const disc = b * b - c;
  if (disc < 0) return Infinity;
  const t = -b - Math.sqrt(disc);
  return t >= 0 ? t : Infinity;
}
