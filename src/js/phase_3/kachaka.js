import * as THREE from "three";
import { toCreasedNormals } from "three/addons/utils/BufferGeometryUtils.js";
import { KACHAKA_MESHES } from "./kachakaMeshData.js";
import { KACHAKA, FLOOR_GAP, FLOORS, ELEVATOR, CORRIDOR, LANES, BATTERY } from "./config.js";
import { std, shadowMaterial, applyFade } from "./builders.js";
import { emit, fwd, yawTo, wrapAngle, approach } from "./sim.js";

const LINEAR_ACC = 0.45; // m/s^2
const ANGULAR_ACC = 2.6; // rad/s^2
const GATE_BACK = 1.0; // robots wait for a zone this far before its door, on their own lane
const LOBBY_EDGE = -7.3; // gates never sit inside the elevator lobby
const DOCK_BACK = 0.7; // reverse distance onto a charger / parking spot

// --- decode the embedded STL-derived meshes once; every robot shares the geometry ---
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

let SHARED = null;
function shared() {
  if (SHARED) return SHARED;
  SHARED = {
    body: decodePart(KACHAKA_MESHES.body),
    leftTire: decodePart(KACHAKA_MESHES.leftTire),
    rightTire: decodePart(KACHAKA_MESHES.rightTire),
    solenoid: decodePart(KACHAKA_MESHES.solenoid),
    bodyMat: std(0x383c3f, { roughness: 0.48, metalness: 0.12 }),
    tireMat: std(0x26292b, { roughness: 0.9 }),
    pinMat: std(0xb6bec2, { roughness: 0.3, metalness: 0.8 }),
    led: new THREE.BoxGeometry(0.006, 0.012, 0.11),
    flag: new THREE.BoxGeometry(0.004, 0.05, 0.16),
    shadow: new THREE.PlaneGeometry(0.72, 0.5).rotateX(-Math.PI / 2),
    ring: new THREE.RingGeometry(0.36, 0.4, 48).rotateX(-Math.PI / 2),
    goal: new THREE.RingGeometry(0.16, 0.22, 40).rotateX(-Math.PI / 2),
  };
  return SHARED;
}

// merge hooks of waypoints that collapse onto each other
function cleanPath(pts, x0, z0) {
  const out = [];
  let px = x0;
  let pz = z0;
  for (const p of pts) {
    const near = Math.hypot(p.x - px, p.z - pz) < 0.04;
    if (near && out.length) {
      const q = out[out.length - 1];
      if (p.pass) {
        const a = q.pass;
        const b = p.pass;
        q.pass = a ? () => (a(), b()) : b;
      }
      if (p.gate) {
        q.gate = p.gate;
        q.gateZone = p.gateZone;
      }
      q.safe = q.safe || p.safe;
      continue;
    }
    if (near && !p.pass && !p.gate && !p.safe) continue;
    out.push(p);
    px = p.x;
    pz = p.z;
  }
  return out;
}

export class Kachaka {
  constructor({ def, index, sim, elevator, lift, traffic, settings }) {
    this.def = def;
    this.id = def.id;
    this.index = index;
    this.color = def.color; // 3D / canvas
    this.css = `var(--robot-${def.slot})`; // page elements (theme-aware step)
    this.name = `Kachaka ${def.id}`;
    this.serial = def.serial;
    this.sim = sim;
    this.elevator = elevator;
    this.lift = lift;
    this.traffic = traffic;
    this.settings = settings;

    this.floor = 0;
    this.x = 0;
    this.z = 0;
    this.yaw = 0;
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
    this.abortFn = null;
    this.aborted = false;
    this.shelf = null;
    this.pin = 0;
    this.battery = def.battery;
    this.onCharger = false;
    this.odometer = 0;
    this.inElevator = false;
    this.rideTarget = null;
    this.ticket = null;
    this.mutedSensors = false;
    this.lastLoc = null;
    this.enterLoc = null;

    // where the robot is in the building's zone system
    this.insideZone = null;
    this.zoneVia = [];
    this.zoneViaPassed = 0;
    this.parked = null; // dock it is standing on
    this.homeDock = null;

    // fleet bookkeeping (owned by Fleet)
    this.task = null;
    this.assignment = null;
    this.preemptFor = null;
    this.needCharge = false;
    this.vacate = false;

    this.activity = { kind: "charge", label: "充電中", detail: "" };
    this.command = { name: "get_battery_info", args: "", state: "PENDING" };
    this.hold = false; // pause the current route (e.g. to talk to someone) without cancelling it
    this.waitInfo = null; // waiting for a zone / the elevator / a charger
    this.yieldInfo = null; // slowing for a person or another robot
    this.blockedBy = null;
    this.blockedRobot = null;
    this.blockedRobotSince = 0;
    this.blockedPerson = false;
    this.lastYieldSpeech = -99;
    this.lastFollowLog = -99;
    this.detections = [];
    this.scanTimer = Math.random() / 15;
    this.people = [];
    this.others = [];
    this.obstacleFn = null;
    this.focusPerson = null;
    this.detailed = false;

    const rays = KACHAKA.lidar.rays;
    this.scan = { ranges: new Float32Array(rays).fill(KACHAKA.lidar.range), nearest: KACHAKA.lidar.range };

    this.group = new THREE.Group();
    this.group.name = `kachaka-${this.id}`;
    this.#buildModel();
    this.#buildOverlays();
    this.#sync();
  }

  // ------------------------------------------------------------- visuals
  #buildModel() {
    const S = shared();
    // geometry is shared; materials are per robot so each one fades with its own floor
    const bodyMat = S.bodyMat.clone();
    const tireMat = S.tireMat.clone();
    const pinMat = S.pinMat.clone();
    this.materials = [bodyMat, tireMat, pinMat];
    this.group.add(new THREE.Mesh(S.body, bodyMat));
    // wheel joints: base_[l|r]_drive_wheel_joint at (0, +/-0.100, 0.045) in ROS -> three (0, 0.045, -/+0.100)
    this.wheels = [
      { mesh: new THREE.Mesh(S.leftTire, tireMat), z: -0.1 },
      { mesh: new THREE.Mesh(S.rightTire, tireMat), z: 0.1 },
    ];
    for (const wh of this.wheels) {
      wh.pivot = new THREE.Group();
      wh.pivot.position.set(0, KACHAKA.wheelRadius, wh.z);
      wh.pivot.add(wh.mesh);
      this.group.add(wh.pivot);
    }
    this.solenoid = new THREE.Mesh(S.solenoid, pinMat);
    this.solenoid.position.y = 0.074;
    this.group.add(this.solenoid);

    // status light strip on the front face
    this.ledMat = new THREE.MeshBasicMaterial({ color: 0x4ee08b });
    const led = new THREE.Mesh(S.led, this.ledMat);
    led.position.set(0.237, 0.088, 0);
    this.group.add(led);
    // fleet colour tag on the back, so robots can be told apart from any side
    const tag = new THREE.Mesh(S.flag, new THREE.MeshBasicMaterial({ color: new THREE.Color(this.color) }));
    tag.position.set(-0.152, 0.085, 0);
    this.group.add(tag);

    const shadow = new THREE.Mesh(S.shadow, shadowMaterial(0.42));
    shadow.position.set(0.045, 0.006, 0);
    this.group.add(shadow);

    // locator ring in the robot's fleet colour
    this.ringMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(this.color), transparent: true, opacity: 0.6, depthWrite: false });
    this.ring = new THREE.Mesh(S.ring, this.ringMat);
    this.ring.position.set(0.045, 0.012, 0);
    this.group.add(this.ring);
    this.materials.push(this.ledMat, tag.material, shadow.material, this.ringMat);
    this.fade = 1;
  }

  // cut-away view: a robot on a faded floor fades with it (its label stays, dimmed)
  setFade(alpha) {
    if (this.fade === alpha) return;
    this.fade = alpha;
    applyFade(this.materials, alpha);
    this.group.visible = alpha > 0.02;
    this.overlays.visible = alpha > 0.5;
  }

  #buildOverlays() {
    const n = KACHAKA.lidar.rays;
    // LiDAR hit points (drawn for the robot being inspected)
    this.scanGeo = new THREE.BufferGeometry();
    this.scanGeo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(n * 3), 3));
    this.scanPoints = new THREE.Points(
      this.scanGeo,
      new THREE.PointsMaterial({ color: 0xff4d4d, size: 0.055, sizeAttenuation: true, depthWrite: false, transparent: true, opacity: 0.95 }),
    );
    this.scanPoints.frustumCulled = false;
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
    this.scanPoints.visible = this.scanFan.visible = false;

    // planned path ribbon with flowing dashes, in the robot's colour
    const c = document.createElement("canvas");
    c.width = 64;
    c.height = 8;
    const g = c.getContext("2d");
    g.fillStyle = "#ffffff";
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
    const col = new THREE.Color(this.color);
    this.pathMesh = new THREE.Mesh(
      this.pathGeo,
      new THREE.MeshBasicMaterial({ map: this.dashTex, color: col, transparent: true, opacity: 0.9, depthWrite: false, side: THREE.DoubleSide }),
    );
    this.pathMesh.frustumCulled = false;
    this.goalMarker = new THREE.Mesh(shared().goal, new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: 0.85, depthWrite: false }));
    this.goalMarker.visible = false;
    this.overlays = new THREE.Group();
    this.overlays.add(this.scanPoints, this.scanFan, this.pathMesh, this.goalMarker);
  }

  // ---------------------------------------------------------- state/UI
  get priority() {
    if (this.task) return this.task.priority;
    return this.needCharge ? 3 : 5;
  }

  get halfWidth() {
    return this.shelf ? 0.21 : 0.12;
  }

  get radius() {
    return this.shelf ? 0.27 : 0.22;
  }

  get mapId() {
    return FLOORS[this.floor].map;
  }

  get speedLimit() {
    return this.shelf ? KACHAKA.shelfLinear : KACHAKA.maxLinear;
  }

  setActivity(kind, label, detail = "") {
    this.activity = { kind, label, detail };
    emit("activity", { robot: this });
  }

  startCommand(name, args = "", log = true) {
    this.command = { name, args, state: "RUNNING" };
    if (log) emit("log", { tag: "api", robot: this, html: `<code>${name}(${args})</code>` });
  }

  endCommand() {
    this.command = { ...this.command, state: "PENDING" };
  }

  say(text) {
    emit("speech", { who: `robot-${this.id}`, robot: this, name: this.id, text });
  }

  async speak(text, token) {
    this.startCommand("speak", `"${text}"`, false);
    emit("log", { tag: "api", robot: this, html: `<code>speak</code> 「${text}」` });
    this.say(text);
    await this.sim.wait(Math.max(2.2, text.length * 0.16), token);
    this.endCommand();
  }

  // ------------------------------------------------------- motion API
  // points: [[x, z]] or {x, z, gate?, gateZone?, pass?, safe?}; resolves true on arrival, false if aborted
  moveAlong(points, finalYaw, token, abort = null) {
    this.path = points.map((p) => (Array.isArray(p) ? { x: p[0], z: p[1] } : p));
    this.pathIndex = 0;
    this.finalYaw = finalYaw;
    this.abortFn = abort;
    this.aborted = false;
    this.mode = this.path.length ? "path" : finalYaw !== null && finalYaw !== undefined ? "rotate" : "idle";
    if (this.mode === "rotate") this.rotateTarget = finalYaw;
    this.#updatePathMesh(true);
    return this.sim.until(() => this.mode === "idle", token).then(() => !this.aborted);
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

  // ------------------------------------------------------- routing
  #exitPath() {
    return this.zoneVia.slice(0, this.zoneViaPassed).reverse();
  }

  // back on a corridor lane: hand the room we came from to the next robot
  #leaveZone(id) {
    this.traffic.release(id, this);
    if (this.insideZone !== id) return;
    this.insideZone = null;
    this.zoneVia = [];
    this.zoneViaPassed = 0;
  }

  #tryEnter(loc) {
    if (!this.traffic.tryAcquire(loc.zone, this)) return false;
    this.insideZone = loc.zone;
    this.zoneVia = loc.via;
    this.zoneViaPassed = 0;
    this.enterLoc = loc;
    return true;
  }

  // we hold a room we have not driven into yet, and the robot in our way waits for that same
  // room at its door: let it go first and queue right behind it (breaks the standoff)
  #yieldZoneTo(o) {
    const zone = this.insideZone;
    const loc = this.enterLoc;
    if (!zone || this.zoneViaPassed > 0 || !loc || loc.zone !== zone) return false;
    const g = o.path[o.pathIndex];
    if (!o.waitInfo || o.waitInfo.kind !== "zone" || !g || g.gateZone !== zone) return false;
    if (!this.traffic.handOver(zone, this, o)) return false;
    this.insideZone = null;
    this.zoneVia = [];
    this.zoneViaPassed = 0;
    this.path.splice(this.pathIndex, 0, { x: this.x, z: this.z, gate: () => this.#tryEnter(loc), gateZone: zone });
    this.blockedRobot = null;
    emit("log", { tag: "traffic", robot: this, html: `${o.id} 已在 ${this.traffic.name(zone)} 門口等候 → 讓出通行權，排在 ${o.id} 之後` });
    return true;
  }

  // one floor: leave the current zone, join the lane for the travel direction (keep right),
  // wait for the target zone at a gate short of its door, then drive in
  #plan(loc) {
    const pts = [];
    const P = (x, z, o = {}) => pts.push({ x, z, ...o });
    const cur = this.insideZone;
    if (cur && loc.zone === cur) {
      const exit = this.#exitPath();
      for (const p of exit.slice(0, -1)) P(p[0], p[1]);
      for (const p of loc.via.slice(1)) P(p[0], p[1]);
      P(loc.x, loc.z);
      this.zoneVia = loc.via;
      this.zoneViaPassed = loc.via.length;
      return cleanPath(pts, this.x, this.z);
    }
    let sx = this.x;
    if (cur) {
      const exit = this.#exitPath();
      for (const p of exit) P(p[0], p[1]);
      if (exit.length) sx = exit[exit.length - 1][0];
    }
    const entry = loc.via.length ? loc.via[0] : [loc.x, loc.z];
    const east = entry[0] >= sx - 0.01;
    const laneZ = east ? LANES.east : LANES.west;
    const dir = east ? 1 : -1;
    const join = { x: sx, z: laneZ, safe: true };
    if (cur) join.pass = () => this.#leaveZone(cur);
    pts.push(join);
    let inLane = laneZ;
    if (loc.zone) {
      const gate = () => this.#tryEnter(loc);
      let wx = entry[0] - dir * GATE_BACK;
      if (east) wx = Math.max(wx, LOBBY_EDGE);
      const behind = east ? wx <= sx + 0.05 : wx >= sx - 0.05;
      if (behind && Math.abs(sx - entry[0]) < GATE_BACK - 0.05 && !this.traffic.canTake(loc.zone, this)) {
        // already at the door but the room is taken: never wait in its doorway; go round to the
        // gate of the opposite approach (one lane over) and come back from there
        const ox = east ? entry[0] + GATE_BACK : Math.max(entry[0] - GATE_BACK, LOBBY_EDGE);
        inLane = east ? LANES.west : LANES.east;
        P(ox, laneZ);
        P(ox, inLane, { safe: true, gate, gateZone: loc.zone });
      } else if (behind) {
        join.gate = gate;
        join.gateZone = loc.zone;
      } else P(wx, laneZ, { safe: true, gate, gateZone: loc.zone });
    }
    P(entry[0], inLane);
    loc.via.forEach((p, i) => P(p[0], p[1], loc.zone ? { pass: () => (this.zoneViaPassed = i + 1) } : {}));
    P(loc.x, loc.z);
    return cleanPath(pts, this.x, this.z);
  }

  #arrive(loc) {
    this.lastLoc = loc;
    if (loc.zone) {
      this.insideZone = loc.zone;
      this.zoneVia = loc.via;
      this.zoneViaPassed = loc.via.length;
    }
  }

  async goTo(loc, token, { label, abort = null, api = null } = {}) {
    if (loc.floor !== this.floor) {
      const ok = await this.rideElevator(loc.floor, token, abort);
      if (!ok) return false;
    }
    const name = label || loc.name;
    if (api) this.startCommand(api[0], api[1]);
    else this.startCommand("move_to_location", `target_location_id="${loc.id}"`, false);
    emit("nav", { robot: this, floor: loc.floor, x: loc.x, z: loc.z, name });
    const arrived = await this.moveAlong(this.#plan(loc), loc.yaw, token, abort);
    if (arrived) this.#arrive(loc);
    this.endCommand();
    return arrived;
  }

  // stop where it stands (task aborted); zones it physically occupies stay held
  halt() {
    this.#abortPath();
    this.v = 0;
    this.w = 0;
  }

  setFault(on) {
    this.ledMat.color.setHex(on ? 0xff3b30 : 0x4ee08b);
    this.ringMat.color.set(on ? "#ff3b30" : this.color);
    this.ringMat.opacity = on ? 0.85 : 0.6;
  }

  #abortPath() {
    // a zone taken early (look-ahead) but not entered yet is handed back
    for (let i = this.pathIndex; i < this.path.length; i++) {
      const p = this.path[i];
      if (p.gate && p.open && this.insideZone === p.gateZone && this.zoneViaPassed === 0) {
        this.traffic.release(p.gateZone, this);
        this.insideZone = null;
        this.zoneVia = [];
      }
    }
    this.traffic.cancelWaits(this);
    this.path = [];
    this.finalYaw = null;
    this.aborted = true;
    this.mode = "idle";
    this.waitInfo = null;
    this.#updatePathMesh(true);
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
      via: home.via || [],
      zone: home.zone || null,
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
    emit("log", { tag: "api", robot: this, html: `已對接 <b>${shelf.name}</b>（docking pin 上升 12 mm）` });
    this.endCommand();
  }

  async undockShelf(token, backOut = true) {
    if (!this.shelf) return;
    const shelf = this.shelf;
    this.startCommand("undock_shelf", `target_shelf_id="${shelf.id}"`, false);
    shelf.release(this.floor, this.x, this.z, this.yaw);
    this.shelf = null;
    await this.sim.wait(1.0, token);
    if (backOut) await this.moveForward(-KACHAKA.dockDepth, 0.12, token, true);
    this.endCommand();
  }

  async returnShelf(shelf, token) {
    const appr = this.shelfApproach(shelf.home);
    this.setActivity("move", "歸還家具", shelf.name);
    await this.goTo(appr, token, { label: shelf.name, api: ["return_shelf", `target_shelf_id="${shelf.id}"`] });
    await this.rotateTo(appr.yaw, token);
    await this.moveForward(KACHAKA.dockDepth, 0.1, token, true);
    await this.undockShelf(token, true);
    emit("log", { tag: "api", robot: this, html: `<b>${shelf.name}</b> 已歸位` });
  }

  // --- docks: chargers and parking spots ---
  placeAt(dock) {
    this.teleport(dock.floor, dock.x, dock.z, dock.yaw, { onCharger: dock.charger });
    this.parked = dock;
    this.insideZone = dock.zone;
    this.zoneVia = dock.approach.via;
    this.zoneViaPassed = dock.approach.via.length;
  }

  // drive to the dock and reverse onto it; false if aborted on the way (only at corridor safe points)
  async parkAt(dock, token, abort = null) {
    const api = dock.charger ? ["return_home", ""] : null;
    const ok = await this.goTo(dock.approach, token, { label: dock.name, abort, api });
    if (!ok) return false;
    this.startCommand(dock.charger ? "return_home" : "move_forward", dock.charger ? "" : `distance_meter=-${DOCK_BACK}`, false);
    await this.rotateTo(dock.yaw, token);
    await this.moveForward(-DOCK_BACK, 0.12, token, true);
    this.parked = dock;
    this.onCharger = dock.charger;
    // a parked robot leaves the zone's aisle free for others
    if (dock.zone) this.traffic.release(dock.zone, this);
    this.endCommand();
    return true;
  }

  async unpark(token) {
    const dock = this.parked;
    if (!dock) return;
    if (dock.zone && !this.traffic.tryAcquire(dock.zone, this)) {
      this.waitInfo = { kind: "zone", label: `等待 ${this.traffic.name(dock.zone)} 淨空` };
      await this.traffic.acquire(dock.zone, this, token);
      this.waitInfo = null;
    }
    if (dock.zone) {
      this.insideZone = dock.zone;
      this.zoneVia = dock.approach.via;
      this.zoneViaPassed = dock.approach.via.length;
    }
    this.startCommand(dock.charger ? "depart_from_charger" : "move_forward", dock.charger ? "" : `distance_meter=${DOCK_BACK}`, dock.charger);
    this.onCharger = false;
    await this.moveForward(DOCK_BACK, 0.15, token);
    this.parked = null;
    this.endCommand();
  }

  // --- cross-floor travel: queue through the elevator system, switch maps on arrival ---
  async rideElevator(target, token, abort = null) {
    const lift = this.lift;
    const from = this.floor;
    const fromId = FLOORS[from].id;
    const toId = FLOORS[target].id;
    const before = this.activity;
    const ticket = lift.request(this, from, target);
    this.ticket = ticket;
    try {
      this.setActivity("move", before.kind === "charge" || before.kind === "idle" ? "前往電梯" : before.label, `${fromId} → ${toId}`);
      const spot = lift.spotLoc(from, ticket.spot);
      const ok = await this.goTo(spot, token, { label: spot.name, abort });
      if (!ok) return false;
      lift.markReady(ticket);
      this.setActivity("lift", "電梯排隊", `${fromId} → ${toId}`);
      this.waitInfo = { kind: "lift", label: "電梯排隊" };
      await this.sim.until(() => ticket.called || (abort && abort()), token);
      this.waitInfo = null;
      if (!ticket.called) return false;

      this.setActivity("lift", "進入電梯", `${fromId} → ${toId}`);
      // spots further back cross the westbound lane: wait for robots heading down it
      if (ticket.spot > 0) await this.sim.until(() => this.#laneClear(lift.spotLoc(from, ticket.spot).x), token);
      this.say("機器人進入電梯，請稍候。");
      await this.moveAlong(lift.boardingPath(ticket.spot), Math.PI, token);
      this.startCommand("move_forward", `distance_meter=${(ELEVATOR.landingX - ELEVATOR.shaftX).toFixed(2)}, mute_sensors=True`, false);
      await this.moveForward(ELEVATOR.landingX - ELEVATOR.shaftX, 0.2, token, true);
      this.inElevator = true;
      this.rideTarget = target;
      await this.rotateInPlace(Math.PI, token);
      ticket.boarded = true;
      lift.bump();

      this.setActivity("lift", "搭乘電梯", `${fromId} → ${toId}`);
      await this.sim.until(() => ticket.arrived, token);
      this.floor = target;
      this.startCommand("switch_map", `map_id="${FLOORS[target].map}", inherit_docking_state_and_docked_shelf=True`, false);
      emit("log", { tag: "lift", robot: this, html: `抵達 <b>${toId}</b>，<code>switch_map("${FLOORS[target].map}")</code>` });
      await this.sim.wait(1.4, token);
      this.startCommand("move_forward", `distance_meter=${(ELEVATOR.landingX - ELEVATOR.shaftX).toFixed(2)}, mute_sensors=True`, false);
      await this.moveForward(ELEVATOR.landingX - ELEVATOR.shaftX, 0.2, token, true);
      this.inElevator = false;
      this.rideTarget = null;
      // clear the landing onto the eastbound lane before the next robot is called
      await this.moveAlong([[ELEVATOR.landingX + 0.75, LANES.east]], null, token);
      ticket.done = true;
      lift.bump();
      this.endCommand();
      this.lastLoc = null;
      this.setActivity(before.kind, before.label, before.detail);
      return true;
    } finally {
      this.waitInfo = null;
      this.ticket = null;
      if (!ticket.boarded) lift.cancel(ticket);
    }
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
        this.v = approach(this.v, 0, LINEAR_ACC * 2 * dt);
        this.w = approach(this.w, 0, ANGULAR_ACC * dt);
    }
    this.yaw = wrapAngle(this.yaw + this.w * dt);
    const f = fwd(this.yaw);
    const step = this.v * dt;
    this.x += f.x * step;
    this.z += f.z * step;
    if (this.mode === "forward") this.forwardRemaining -= step;
    this.odometer += Math.abs(step);

    // battery: the demo boost speeds up both charging and discharging
    const boost = this.settings.batteryBoost;
    if (this.onCharger) this.battery = Math.min(100, this.battery + (dt * BATTERY.chargeRate * boost) / 3600);
    else {
      const moving = Math.abs(this.v) > 0.01 || Math.abs(this.w) > 0.05;
      const rate = (moving ? BATTERY.drainMove : BATTERY.drainIdle) * (this.shelf ? BATTERY.loadFactor : 1);
      this.battery = Math.max(2, this.battery - (dt * rate * boost) / 3600);
    }

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

  // waypoint bookkeeping: run pass hooks once, abort at safe points, hold at closed gates
  #atWaypoint(p) {
    if (!p.reached) {
      p.reached = true;
      if (p.pass) p.pass();
    }
    if (p.safe && !p.open && this.abortFn && this.abortFn()) {
      this.#abortPath();
      return false;
    }
    if (p.gate && !p.open) {
      if (p.gate()) {
        p.open = true;
        this.waitInfo = null;
      } else {
        this.waitInfo = { kind: "zone", label: `等待 ${this.traffic.name(p.gateZone)} 淨空` };
        return false;
      }
    }
    return true;
  }

  // look ahead for a closed gate: try it early (no stop if the zone is free), else plan to stop there
  #gateDistance(dFirst) {
    let acc = dFirst;
    let px = this.path[this.pathIndex].x;
    let pz = this.path[this.pathIndex].z;
    for (let i = this.pathIndex; i < this.path.length && acc < 3.2; i++) {
      const q = this.path[i];
      if (i > this.pathIndex) {
        acc += Math.hypot(q.x - px, q.z - pz);
        px = q.x;
        pz = q.z;
      }
      if (!q.gate || q.open) continue;
      if (!(this.abortFn && this.abortFn()) && q.gate()) {
        q.open = true;
        continue;
      }
      return acc;
    }
    return Infinity;
  }

  #followPath(dt) {
    if (this.hold) {
      this.v = approach(this.v, 0, LINEAR_ACC * 2 * dt);
      this.w = approach(this.w, 0, ANGULAR_ACC * dt);
      return;
    }
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
      if (!this.#atWaypoint(p)) {
        this.v = approach(this.v, 0, LINEAR_ACC * 2 * dt);
        this.w = approach(this.w, 0, ANGULAR_ACC * dt);
        return;
      }
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
    const stop = Math.min(this.#stopDistance(), this.#gateDistance(d));
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

  #laneClear(spotX) {
    for (const o of this.others) {
      if (o === this || o.floor !== this.floor || o.inElevator || Math.abs(o.v) < 0.03) continue;
      if (Math.abs(o.z - LANES.west) > 0.3 || o.x < ELEVATOR.landingX - 0.2 || o.x > spotX + 2.2) continue;
      if (fwd(o.yaw).x < -0.5) return false;
    }
    return true;
  }

  // driving along a corridor lane (has right of way over robots crossing it)
  #onLane() {
    const f = fwd(this.yaw);
    if (Math.abs(f.x) < 0.9) return false;
    return Math.abs(this.z - (f.x > 0 ? LANES.east : LANES.west)) < 0.12;
  }

  // who keeps going when two robots block each other
  #outranks(o) {
    const a = this.#onLane();
    const b = o.#onLane();
    if (a !== b) return a;
    if (this.priority !== o.priority) return this.priority < o.priority;
    return this.index < o.index;
  }

  // distance along the remaining route to the point closest to (x, z), if that point is within
  // `clear` of the route and `reach` of the robot; null otherwise
  #onRoute(x, z, clear, reach) {
    let px = this.x;
    let pz = this.z;
    let s = 0;
    for (let i = this.pathIndex; i < this.path.length && s < reach; i++) {
      const q = this.path[i];
      const dx = q.x - px;
      const dz = q.z - pz;
      const len = Math.hypot(dx, dz);
      if (len > 1e-6) {
        const t = THREE.MathUtils.clamp(((x - px) * dx + (z - pz) * dz) / (len * len), 0, 1);
        const d = Math.hypot(px + dx * t - x, pz + dz * t - z);
        if (d <= clear && s + t * len <= reach) return s + t * len;
      }
      s += len;
      px = q.x;
      pz = q.z;
    }
    return null;
  }

  // slow down / stop for people and robots ahead (camera + LiDAR detection)
  #yieldFactor() {
    if (this.mutedSensors || this.inElevator) return 1;
    const f = fwd(this.yaw);
    let factor = 1;
    let person = null;
    let robot = null;
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
          person = p;
          robot = null;
        }
      }
    }
    const gap = this.settings.followGap;
    for (const o of this.others) {
      if (o === this || o.floor !== this.floor || o.inElevator) continue;
      const rx = o.x - this.x;
      const rz = o.z - this.z;
      if (rx * f.x + rz * f.z < 0.05) continue;
      // only a robot on the route still ahead counts (one past the next turn is not in the way)
      const along = this.#onRoute(o.x, o.z, this.halfWidth + o.radius + 0.03, gap + 0.9);
      if (along === null) continue;
      if (o.blockedBy === this && this.#outranks(o)) continue;
      // a stationary robot we have waited on for a while sits beside our planned line: creep past
      if (o.mode === "idle" && this.blockedRobot === o && this.sim.time - this.blockedRobotSince > 6) continue;
      const k = THREE.MathUtils.clamp((along - gap) / 0.7, 0, 1);
      if (k < factor) {
        factor = k;
        robot = o;
        person = null;
      }
    }
    // crossing or joining a lane: let lane traffic that is about to pass go first
    if (!this.#onLane() && Math.abs(f.z) > 0.5) {
      for (const o of this.others) {
        if (o === this || o.floor !== this.floor || o.inElevator || o.v < 0.05 || !o.#onLane()) continue;
        const dz = o.z - this.z;
        if (dz * f.z <= 0 || Math.abs(dz) > 1.6) continue;
        if (Math.abs(dz) < this.radius + o.radius + 0.02) continue; // already in its lane: committed
        const ahead = (this.x - o.x) * Math.sign(fwd(o.yaw).x);
        if (ahead > -0.6 && ahead < 1.8) {
          factor = 0;
          robot = o;
          person = null;
        }
      }
    }
    const blocked = factor < 0.05;
    if (robot && blocked) {
      if (this.blockedRobot !== robot) {
        this.blockedRobot = robot;
        this.blockedRobotSince = this.sim.time;
      } else if (this.sim.time - this.blockedRobotSince > 4 && this.#yieldZoneTo(robot)) return 0;
      if (this.sim.time - this.lastFollowLog > 20) {
        this.lastFollowLog = this.sim.time;
        emit("log", { tag: "traffic", robot: this, html: `前方 ${robot.id} 距離 ${Math.hypot(robot.x - this.x, robot.z - this.z).toFixed(1)} m，跟車禮讓` });
      }
    } else if (!blocked) this.blockedRobot = null;
    if (person && blocked && !this.blockedPerson) {
      emit("log", { tag: "nav", robot: this, html: `偵測到 PERSON（${person.roleDef.label}）於前方 ${Math.hypot(person.x - this.x, person.z - this.z).toFixed(1)} m，減速禮讓` });
      if (this.sim.time - this.lastYieldSpeech > 12) {
        this.lastYieldSpeech = this.sim.time;
        this.say("不好意思，借過一下。");
      }
    }
    this.blockedPerson = !!(person && blocked);
    this.blockedBy = blocked ? robot : null;
    this.yieldInfo = factor < 0.6 ? (robot ? { kind: "follow", label: `禮讓 ${robot.id}` } : person ? { kind: "person", label: "禮讓行人" } : null) : null;
    return factor;
  }

  // ---------------------------------------------------------- sensors
  // every robot animates its path; the one being inspected also runs the LiDAR + detector
  updateSensors(realDt, segmentsFn) {
    this.dashTex.offset.x -= realDt * 1.6;
    this.ring.scale.setScalar(1 + 0.08 * Math.sin(performance.now() / 300 + this.index));
    this.scanTimer += realDt;
    if (this.scanTimer < 1 / 15) return;
    this.scanTimer = 0;
    this.#updatePathMesh(false);
    this.scanPoints.visible = this.scanFan.visible = this.detailed;
    if (!this.detailed) return;
    this.#lidar(segmentsFn(this));
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
    const circles = [];
    if (!this.inElevator) {
      for (const p of this.people) if (p.floor === this.floor) circles.push([p.x, p.z, 0.2]);
      for (const o of this.others) if (o !== this && o.floor === this.floor && !o.inElevator) circles.push([o.x, o.z, o.radius - 0.04]);
    }
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
      for (const o of this.others) if (o !== this && o.floor === this.floor && !o.inElevator) consider("ROBOT", o.x, o.z, o.id);
      for (const s of this.obstacleFn ? this.obstacleFn() : []) if (s.floor === this.floor && s !== this.shelf && !s.robot) consider("SHELF", s.x, s.z, s.id);
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
    const y = this.floor * FLOOR_GAP + 0.03 + this.index * 0.002;
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
    this.hold = false;
    this.mutedSensors = false;
    this.onCharger = onCharger;
    this.blockedBy = null;
    this.blockedRobot = null;
    this.waitInfo = null;
    this.yieldInfo = null;
    this.insideZone = null;
    this.zoneVia = [];
    this.zoneViaPassed = 0;
    this.parked = null;
    this.y = floor * FLOOR_GAP;
    this.#updatePathMesh(true);
    this.#sync();
  }

  anchor(target) {
    return target.set(this.x, this.y + (this.shelf ? 1.25 : 0.55), this.z);
  }

  dispose() {
    this.dashTex.dispose();
    this.pathGeo.dispose();
    this.scanGeo.dispose();
    this.fanGeo.dispose();
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
