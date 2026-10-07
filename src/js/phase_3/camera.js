import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { FLOORS, FLOOR_GAP, ELEVATOR } from "./config.js";
import { damp } from "./sim.js";

const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

// how much a robot's current activity is worth watching (auto-director)
function interest(r) {
  if (r.focusPerson) return 92;
  const k = r.activity.kind;
  if (k === "alert" || k === "fault") return 100;
  if (k === "handoff") return 72;
  if (k === "measure") return 66;
  if (r.inElevator) return 58;
  if (k === "dock") return 46;
  if (k === "patrol") return 42;
  if (k === "lift") return 30;
  if (k === "move") return r.shelf ? 40 : 34;
  if (k === "charge") return 6;
  return 2;
}

// --- auto-director: frames the most interesting robot, the elevator ride and bedside work ---
export class CameraDirector {
  constructor(camera, dom, { fleet, elevator }) {
    this.camera = camera;
    this.fleet = fleet;
    this.elevator = elevator;
    this.mode = "auto"; // auto | follow | overview | free
    this.selected = null; // robot picked by the user (follow mode)
    this.focusRobot = null; // robot currently framed
    this.hold = 0;
    this.intro = 2.6; // seconds of establishing shot before the first robot
    this.t = 0;
    this.cur = { target: new THREE.Vector3(-1.2, 6.4, 0), dist: 34, azim: 0.5, elev: 0.36 };
    this.want = { target: new THREE.Vector3(), dist: 0, azim: 0, elev: 0 };
    this.tmp = new THREE.Vector3();
    this.onModeChange = () => {};
    this.onFocusChange = () => {};

    this.controls = new OrbitControls(camera, dom);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.minDistance = 1.6;
    this.controls.maxDistance = 60;
    this.controls.maxPolarAngle = 1.48;
    this.controls.addEventListener("start", () => {
      if (this.mode !== "free") this.setMode("free");
    });
    this.#apply();
  }

  setMode(mode) {
    if (this.mode === mode) return;
    if (mode === "follow" && !this.selected) this.selected = this.focusRobot;
    this.mode = mode;
    this.intro = 0;
    if (mode === "auto") this.selected = null;
    if (mode !== "free") this.#syncFromCamera();
    this.onModeChange(mode);
  }

  follow(robot) {
    this.selected = robot;
    this.hold = 0;
    if (this.mode === "follow") this.onModeChange(this.mode);
    else this.setMode("follow");
    if (this.focusRobot !== robot) {
      this.focusRobot = robot;
      this.onFocusChange(robot);
    }
  }

  // keep the spherical state continuous when leaving free mode
  #syncFromCamera() {
    const off = this.tmp.copy(this.camera.position).sub(this.controls.target);
    this.cur.target.copy(this.controls.target);
    this.cur.dist = off.length();
    this.cur.elev = Math.asin(THREE.MathUtils.clamp(off.y / this.cur.dist, -1, 1));
    this.cur.azim = Math.atan2(off.x, off.z);
  }

  get aspectFactor() {
    const a = this.camera.aspect;
    return a < 1 ? Math.min(1.9, Math.pow(1 / a, 0.85)) : a > 2.1 ? 0.92 : 1;
  }

  #pick(realDt) {
    const robots = this.fleet.robots;
    if (!robots.length) return null;
    if (this.selected && !robots.includes(this.selected)) this.selected = null;
    if (this.mode === "follow" && this.selected) return this.selected;
    const cur = robots.includes(this.focusRobot) ? this.focusRobot : null;
    this.hold += realDt;
    let best = null;
    let bestScore = -1;
    for (const r of robots) {
      const s = interest(r);
      if (s > bestScore) {
        best = r;
        bestScore = s;
      }
    }
    if (!cur) {
      this.hold = 0;
      return best;
    }
    const mine = interest(cur);
    if (best !== cur && bestScore >= mine + 30) {
      this.hold = 0;
      return best;
    }
    // when nothing stands out, move on to another busy robot now and then
    if (this.hold > 14 && mine < 60) {
      const busy = robots.filter((r) => r !== cur && interest(r) >= 30);
      if (busy.length) {
        this.hold = 0;
        busy.sort((a, b) => interest(b) - interest(a));
        return busy[0];
      }
    }
    return cur;
  }

  #shot() {
    const w = this.want;
    const r = this.focusRobot;
    const drift = reducedMotion ? 0 : Math.sin(this.t * 0.045) * 0.12;
    // nothing worth a close-up (everyone parked): show the whole building and fleet
    const quiet = this.mode === "auto" && r && interest(r) < 20;
    const mode = this.intro > 0 || !r || quiet ? "overview" : this.mode;
    this.closeUp = mode !== "overview" && !r.inElevator;
    if (mode === "overview") {
      w.target.set(-1.3, 6.3, 0);
      w.dist = 33 * this.aspectFactor;
      w.azim = 0.5 + drift * 0.5;
      w.elev = 0.34;
      return;
    }
    if (r.inElevator) {
      w.target.set(ELEVATOR.shaftX + 1.6, this.elevator.cabY + 0.9, 0.4);
      w.dist = 9.5 * this.aspectFactor;
      w.azim = 0.42;
      w.elev = 0.3;
      return;
    }
    const f = r.focusPerson;
    if (f && f.floor === r.floor) {
      // look across the robot-person line so neither hides the other
      const d = Math.hypot(f.x - r.x, f.z - r.z);
      const line = Math.atan2(f.x - r.x, f.z - r.z);
      const near = (a) => Math.abs(Math.atan2(Math.sin(a - 0.4), Math.cos(a - 0.4)));
      w.target.set((r.x + f.x) / 2, r.y + 0.6, (r.z + f.z) / 2);
      w.dist = THREE.MathUtils.clamp(4.6 + d * 1.1, 5.6, 12) * this.aspectFactor;
      w.azim = near(line + Math.PI / 2) < near(line - Math.PI / 2) ? line + Math.PI / 2 : line - Math.PI / 2;
      w.elev = 0.8;
      return;
    }
    const s = this.fleet.sensorOf ? this.fleet.sensorOf(r) : null;
    if (r.activity.kind === "measure" && s && s.bed && s.state !== "idle") {
      const c = s.chestWorld(this.tmp);
      w.target.set((r.x + c.x) / 2, r.y + 0.7, (r.z + c.z) / 2 + 0.3);
      w.dist = 4.6 * this.aspectFactor;
      w.azim = 0.22 + drift * 0.4;
      w.elev = 0.62;
      return;
    }
    r.anchor(w.target);
    w.target.y = r.y + 0.45;
    const close = r.activity.kind === "dock" || r.activity.kind === "handoff" || !r.shelf;
    w.dist = (close ? 5.8 : 7.6) * this.aspectFactor;
    w.azim = 0.55 + drift;
    w.elev = 0.62;
  }

  // jump straight to the current shot (used after restarts / for screenshots)
  snap() {
    this.intro = 0;
    const r = this.#pick(0);
    if (r !== this.focusRobot) {
      this.focusRobot = r;
      this.onFocusChange(r);
    }
    this.#shot();
    this.cur.target.copy(this.want.target);
    this.cur.dist = this.want.dist;
    this.cur.azim = this.want.azim;
    this.cur.elev = this.want.elev;
    this.#apply();
  }

  update(realDt) {
    this.t += realDt;
    if (this.intro > 0) this.intro -= realDt;
    const r = this.#pick(realDt);
    if (r !== this.focusRobot) {
      this.focusRobot = r;
      this.onFocusChange(r);
    }
    if (this.mode === "free") {
      this.controls.update();
      return;
    }
    this.#shot();
    const k = 2.0;
    this.cur.target.x = damp(this.cur.target.x, this.want.target.x, k, realDt);
    this.cur.target.y = damp(this.cur.target.y, this.want.target.y, k * 1.2, realDt);
    this.cur.target.z = damp(this.cur.target.z, this.want.target.z, k, realDt);
    this.cur.dist = damp(this.cur.dist, this.want.dist, k * 0.8, realDt);
    let da = this.want.azim - this.cur.azim;
    da = Math.atan2(Math.sin(da), Math.cos(da));
    this.cur.azim += da * (1 - Math.exp(-k * 0.8 * realDt));
    this.cur.elev = damp(this.cur.elev, this.want.elev, k * 0.8, realDt);
    this.#apply();
  }

  #apply() {
    const { target, dist, azim, elev } = this.cur;
    this.camera.position.set(
      target.x + Math.sin(azim) * Math.cos(elev) * dist,
      target.y + Math.sin(elev) * dist,
      target.z + Math.cos(azim) * Math.cos(elev) * dist,
    );
    this.camera.lookAt(target);
    this.controls.target.copy(target);
  }

  // floor whose slab hides everything below it in the current close-up (-1: nothing hidden)
  get occludeBelow() {
    const r = this.focusRobot;
    if (this.mode === "free" || !this.closeUp || !r) return -1;
    return r.floor;
  }

  // cut-away: floors above the framed robot fade out so its floor stays visible
  floorFadeTargets() {
    const r = this.focusRobot;
    const overview = this.mode === "overview" || this.intro > 0 || !r;
    if (!r) return FLOORS.map(() => 1);
    let active = r.floor;
    if (r.inElevator) active = Math.max(Math.ceil(this.elevator.floorFloat - 0.05), Math.round(this.elevator.targetY / FLOOR_GAP));
    return FLOORS.map((_, i) => (i <= active ? 1 : overview ? 0.32 : 0.06));
  }
}
