import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { FLOORS, FLOOR_GAP, ELEVATOR } from "./config.js";
import { damp } from "./sim.js";

const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

// --- auto-director: follows the robot, frames the elevator ride and bedside measurements ---
export class CameraDirector {
  constructor(camera, dom, { robot, elevator, sensor }) {
    this.camera = camera;
    this.robot = robot;
    this.elevator = elevator;
    this.sensor = sensor;
    this.mode = "auto";
    this.intro = 2.6; // seconds of establishing shot before following the robot
    this.t = 0;
    this.cur = { target: new THREE.Vector3(-1.2, 6.4, 0), dist: 34, azim: 0.5, elev: 0.36 };
    this.want = { target: new THREE.Vector3(), dist: 0, azim: 0, elev: 0 };
    this.tmp = new THREE.Vector3();
    this.tmp2 = new THREE.Vector3();
    this.focus = null; // a person the robot is interacting with; framed together with the robot
    this.onModeChange = () => {};

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
    this.mode = mode;
    this.intro = 0;
    if (mode !== "free") this.#syncFromCamera();
    this.onModeChange(mode);
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

  #shot() {
    const w = this.want;
    const r = this.robot;
    const drift = reducedMotion ? 0 : Math.sin(this.t * 0.045) * 0.12;
    const mode = this.intro > 0 ? "overview" : this.mode;
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
    const f = this.focus;
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
    const s = this.sensor;
    if (r.activity.kind === "measure" && s.bed && s.state !== "idle") {
      const c = s.chestWorld(this.tmp2);
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

  // jump straight to the current shot (used after scenario jumps / for screenshots)
  snap() {
    this.intro = 0;
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

  // cut-away: floors above the robot fade out so its floor stays visible
  floorFadeTargets() {
    const r = this.robot;
    let active = r.floor;
    if (r.inElevator) active = Math.max(Math.ceil(this.elevator.floorFloat - 0.05), Math.round(this.elevator.targetY / FLOOR_GAP));
    const overview = this.mode === "overview" || this.intro > 0;
    return FLOORS.map((_, i) => (i <= active ? 1 : overview ? 0.32 : 0.06));
  }
}
