import * as THREE from "three";
import { MEASURE_SECONDS, FLOOR_GAP, FLOORS } from "./config.js";
import { emit } from "./sim.js";

// early-warning style thresholds (simplified from NEWS2 bands)
function band(value, name, critHi, warnHi, warnLo, critLo) {
  if (value > critHi) return ["crit", `${name} ${value} > ${critHi}`];
  if (value > warnHi) return ["warn", `${name} ${value} 偏快`];
  if (value < critLo) return ["crit", `${name} ${value} < ${critLo}`];
  if (value < warnLo) return ["warn", `${name} ${value} 偏慢`];
  return null;
}

export function classify(hr, rr) {
  const hits = [band(hr, "HR", 110, 100, 55, 50), band(rr, "RR", 24, 20, 12, 10)].filter(Boolean);
  const level = hits.some(([l]) => l === "crit") ? "crit" : hits.length ? "warn" : "ok";
  return { level, flags: hits.map(([, text]) => text), label: { ok: "正常", warn: "注意", crit: "異常" }[level] };
}

const beamVertex = /* glsl */ `
  varying float vD;
  void main() {
    vD = -position.y;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;
const beamFragment = /* glsl */ `
  uniform float uTime;
  uniform vec3 uColor;
  uniform float uOpacity;
  varying float vD;
  void main() {
    float rings = pow(0.5 + 0.5 * sin(vD * 20.0 - uTime * 7.0), 6.0);
    float fade = smoothstep(0.0, 0.1, vD) * (1.0 - smoothstep(0.82, 1.0, vD));
    gl_FragColor = vec4(uColor, (0.14 + 0.62 * rings) * fade * uOpacity);
  }
`;

function hash(n) {
  const s = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return s - Math.floor(s);
}

export class VitalSensor {
  constructor({ cart, sim }) {
    this.cart = cart;
    this.id = cart.id;
    this.floor = cart.home.floor;
    this.sim = sim;
    this.robot = null;
    this.startedAt = -1;
    this.state = "idle";
    this.bed = null;
    this.patient = null;
    this.elapsed = 0;
    this.duration = MEASURE_SECONDS;
    this.hr = null;
    this.rr = null;
    this.sqi = null;
    this.distance = null;
    this.noise = { hr: 0, rr: 0, t: 0 };
    this.t = 0;
    this.last = null;
    this.tmpA = new THREE.Vector3();
    this.tmpB = new THREE.Vector3();

    this.beamUniforms = { uTime: { value: 0 }, uColor: { value: new THREE.Color(0x14b8a6) }, uOpacity: { value: 0 } };
    const geo = new THREE.ConeGeometry(1, 1, 40, 1, true).translate(0, -0.5, 0);
    this.beam = new THREE.Mesh(
      geo,
      new THREE.ShaderMaterial({
        uniforms: this.beamUniforms,
        vertexShader: beamVertex,
        fragmentShader: beamFragment,
        transparent: true,
        depthWrite: false,
        side: THREE.DoubleSide,
      }),
    );
    this.beam.visible = false;
    this.beam.frustumCulled = false;
    this.lockRing = new THREE.Mesh(
      new THREE.RingGeometry(0.1, 0.13, 40).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ color: 0x3ddc74, transparent: true, opacity: 0.8, depthWrite: false }),
    );
    this.lockRing.visible = false;
    this.group = new THREE.Group();
    this.group.add(this.beam, this.lockRing);
  }

  chestWorld(target) {
    const c = this.bed.chest;
    return target.set(c.x, this.bed.floor * FLOOR_GAP + c.y, c.z);
  }

  async measure(bed, patient, token, robot = null) {
    this.bed = bed;
    this.patient = patient;
    this.robot = robot;
    this.startedAt = this.sim.time;
    this.elapsed = 0;
    this.hr = this.rr = this.sqi = null;
    this.state = "detect";
    this.cart.setActive("detect");
    emit("vitals", { phase: "detect", bed, sensor: this });
    await this.sim.wait(2.5, token);
    this.distance = this.cart.radarOrigin(this.tmpA).distanceTo(this.chestWorld(this.tmpB));
    emit("log", { tag: "vitals", robot, html: `${this.id} 鎖定 <b>${bed.id}</b> 胸腔區域，距離 ${this.distance.toFixed(2)} m` });
    this.state = "measure";
    this.cart.setActive("measure");
    emit("vitals", { phase: "measure", bed, sensor: this });
    await this.sim.until(() => this.elapsed >= this.duration, token);

    this.hr = Math.round(patient.hr);
    this.rr = Math.round(patient.rr);
    this.sqi = 0.9 + hash(this.sim.time) * 0.07;
    this.state = "upload";
    emit("vitals", { phase: "upload", bed, sensor: this });
    await this.sim.wait(1.3, token);
    const verdict = classify(this.hr, this.rr);
    const result = {
      bed: bed.id,
      floor: FLOORS[bed.floor].id,
      hr: this.hr,
      rr: this.rr,
      sqi: this.sqi,
      distance: this.distance,
      clock: this.sim.clock,
      patient: patient.data,
      ...verdict,
    };
    this.last = result;
    this.state = "done";
    this.cart.setActive("done");
    emit("vitals", { phase: "done", bed, result, sensor: this });
    return result;
  }

  // sim-time progress of the estimate (values settle as more breaths are observed)
  updateSim(dt) {
    if (this.state !== "measure") return;
    this.elapsed = Math.min(this.duration, this.elapsed + dt);
    const p = this.elapsed / this.duration;
    this.noise.t += dt;
    if (this.noise.t > 1.8) {
      this.noise.t = 0;
      this.noise.hr = Math.random() * 2 - 1;
      this.noise.rr = Math.random() * 2 - 1;
    }
    if (p > 0.18) {
      const k = 1 - p;
      this.hr = Math.round(this.patient.hr + this.noise.hr * (1 + 7 * k));
      this.rr = Math.max(6, Math.round(this.patient.rr + this.noise.rr * (0.6 + 3 * k)));
    }
    this.sqi = Math.min(0.97, 0.52 + 0.43 * Math.min(1, p * 1.6) + this.noise.rr * 0.01);
  }

  // real-time visuals: beam animation, cart display
  updateReal(dt) {
    this.t += dt;
    const active = this.state === "detect" || this.state === "measure";
    const target = active ? 1 : 0;
    const u = this.beamUniforms;
    u.uOpacity.value += (target - u.uOpacity.value) * Math.min(1, dt * 5);
    u.uTime.value = this.t;
    this.beam.visible = u.uOpacity.value > 0.01 && !!this.bed;
    this.lockRing.visible = this.state === "measure" || this.state === "upload";
    if (this.beam.visible) {
      const o = this.cart.radarOrigin(this.tmpA);
      const c = this.chestWorld(this.tmpB);
      const dir = c.clone().sub(o);
      const len = dir.length();
      dir.normalize();
      this.beam.position.copy(o);
      this.beam.quaternion.setFromUnitVectors(new THREE.Vector3(0, -1, 0), dir);
      const r = len * (this.state === "detect" ? 0.3 + 0.08 * Math.sin(this.t * 5) : 0.2);
      this.beam.scale.set(r, len, r);
      u.uColor.value.setHex(this.state === "detect" ? 0xf59e0b : 0x14b8a6);
    }
    if (this.lockRing.visible) {
      this.chestWorld(this.lockRing.position);
      this.lockRing.position.y += 0.03;
      const s = 1 + 0.12 * Math.sin(this.t * 4);
      this.lockRing.scale.set(s, 1, s);
    }
    this.screenTimer = (this.screenTimer || 0) + dt;
    if (this.screenTimer > 0.3) {
      this.screenTimer = 0;
      const key = `${this.state}:${this.hr}:${this.rr}`;
      if (key !== this.screenKey) {
        this.screenKey = key;
        this.cart.drawScreen(this.bed && this.state !== "idle" ? { bed: this.bed.id, hr: this.hr, rr: this.rr } : null);
      }
    }
  }

  reset() {
    this.state = "idle";
    this.bed = null;
    this.patient = null;
    this.robot = null;
    this.last = null;
    this.startedAt = -1;
    this.hr = this.rr = this.sqi = this.distance = null;
    this.elapsed = 0;
    this.beamUniforms.uOpacity.value = 0;
    this.beam.visible = false;
    this.lockRing.visible = false;
    this.cart.setActive("idle");
  }
}
