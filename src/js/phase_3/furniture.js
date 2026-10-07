import * as THREE from "three";
import { RoundedBoxGeometry } from "three/addons/geometries/RoundedBoxGeometry.js";
import { std, shadowMaterial, applyFade } from "./builders.js";
import { FLOOR_GAP } from "./config.js";

const W = 0.42; // Kachaka shelf footprint (m)

// --- furniture that Kachaka docks under and carries (smart-furniture platform) ---
class DockableShelf {
  constructor({ id, name, home }) {
    this.id = id;
    this.name = name;
    this.home = { ...home, id, name };
    this.floor = home.floor;
    this.x = home.x;
    this.z = home.z;
    this.yaw = home.yaw;
    this.robot = null;
    this.materials = [];
    this.group = new THREE.Group();
    this.group.name = id;
  }

  mat(color, opts) {
    const m = std(color, { roughness: 0.6, ...opts });
    this.materials.push(m);
    return m;
  }

  add(geo, mat, x, y, z, parent = this.group) {
    const m = new THREE.Mesh(geo, mat);
    m.position.set(x, y, z);
    parent.add(m);
    return m;
  }

  frame(height) {
    const post = new THREE.BoxGeometry(0.028, height, 0.028);
    const caster = new THREE.SphereGeometry(0.022, 10, 8);
    const white = this.mat(0xf6f8f8, { roughness: 0.5 });
    const dark = this.mat(0x2b3133, { roughness: 0.7 });
    for (const sx of [-1, 1]) {
      for (const sz of [-1, 1]) {
        this.add(post, white, sx * (W / 2 - 0.014), 0.04 + height / 2, sz * (W / 2 - 0.014));
        this.add(caster, dark, sx * (W / 2 - 0.02), 0.022, sz * (W / 2 - 0.02));
      }
    }
    const sh = new THREE.Mesh(new THREE.PlaneGeometry(0.7, 0.7).rotateX(-Math.PI / 2), shadowMaterial(0.32));
    sh.position.y = 0.008;
    this.materials.push(sh.material);
    this.group.add(sh);
    return white;
  }

  pose() {
    return { floor: this.floor, x: this.x, z: this.z, yaw: this.yaw, via: this.atHome() ? this.home.via : [], id: this.id, name: this.name };
  }

  atHome() {
    return !this.robot && this.floor === this.home.floor && Math.hypot(this.x - this.home.x, this.z - this.home.z) < 0.05;
  }

  dockTo(robot) {
    this.robot = robot;
  }

  release(floor, x, z, yaw) {
    this.robot = null;
    this.place(floor, x, z, yaw);
  }

  follow(robot) {
    this.floor = robot.floor;
    this.x = robot.x;
    this.z = robot.z;
    this.yaw = robot.yaw;
    this.group.position.set(robot.x, robot.y, robot.z);
    this.group.rotation.y = robot.yaw;
  }

  place(floor, x, z, yaw) {
    this.floor = floor;
    this.x = x;
    this.z = z;
    this.yaw = yaw;
    this.group.position.set(x, floor * FLOOR_GAP, z);
    this.group.rotation.y = yaw;
  }

  resetHome() {
    this.robot = null;
    this.place(this.home.floor, this.home.x, this.home.z, this.home.yaw);
  }

  setFade(alpha) {
    if (this.fade === alpha) return;
    this.fade = alpha;
    applyFade(this.materials, alpha);
  }

  // LiDAR footprint while parked (rotated square)
  segments() {
    const c = Math.cos(this.yaw);
    const s = Math.sin(this.yaw);
    const h = W / 2;
    const pts = [[-h, -h], [h, -h], [h, h], [-h, h]].map(([lx, lz]) => [this.x + lx * c + lz * s, this.z - lx * s + lz * c]);
    return pts.map((p, i) => [...p, ...pts[(i + 1) % 4]]);
  }
}

// --- vital-sign cart: BestShape VS radar head on a mast, with a small bedside display ---
export class VitalCart extends DockableShelf {
  constructor(opts) {
    super(opts);
    const white = this.frame(0.16);
    const deck = this.add(new RoundedBoxGeometry(W, 0.04, W, 2, 0.015), white, 0, 0.2, 0);
    deck.castShadow = false;
    const basket = this.mat(0xd9e3e2, { roughness: 0.7 });
    this.add(new THREE.BoxGeometry(0.3, 0.07, 0.3), basket, -0.04, 0.255, 0);
    const mastMat = this.mat(0xc8d1d3, { roughness: 0.3, metalness: 0.6 });
    this.add(new THREE.CylinderGeometry(0.02, 0.022, 0.72, 12), mastMat, 0.11, 0.58, 0);

    // display facing back/up so staff can read it
    this.screenCanvas = document.createElement("canvas");
    this.screenCanvas.width = 160;
    this.screenCanvas.height = 100;
    this.screenTex = new THREE.CanvasTexture(this.screenCanvas);
    this.screenTex.colorSpace = THREE.SRGBColorSpace;
    const screenHolder = new THREE.Group();
    screenHolder.position.set(0.07, 0.74, 0);
    screenHolder.rotation.z = -0.55;
    this.group.add(screenHolder);
    this.add(new RoundedBoxGeometry(0.03, 0.13, 0.19, 2, 0.01), this.mat(0x22292b, { roughness: 0.4 }), 0, 0, 0, screenHolder);
    const screenMat = new THREE.MeshBasicMaterial({ map: this.screenTex });
    this.materials.push(screenMat);
    const screen = new THREE.Mesh(new THREE.PlaneGeometry(0.17, 0.11), screenMat);
    screen.rotation.y = -Math.PI / 2;
    screen.position.x = -0.0165;
    screenHolder.add(screen);

    // radar head, pitched down toward the patient's chest
    this.head = new THREE.Group();
    this.head.position.set(0.15, 0.96, 0);
    this.head.rotation.z = -0.24;
    this.group.add(this.head);
    this.add(new RoundedBoxGeometry(0.085, 0.13, 0.21, 3, 0.03), white, 0, 0, 0, this.head);
    this.windowMat = this.mat(0x0c2b27, { roughness: 0.2, emissive: new THREE.Color(0x0f5e52), emissiveIntensity: 0.4 });
    this.add(new THREE.BoxGeometry(0.008, 0.09, 0.16), this.windowMat, 0.042, 0, 0, this.head);
    this.ledMat = new THREE.MeshBasicMaterial({ color: 0x6a7a77 });
    this.materials.push(this.ledMat);
    this.add(new THREE.BoxGeometry(0.03, 0.012, 0.12), this.ledMat, 0.0, 0.07, 0, this.head);
    this.drawScreen(null);
    this.resetHome();
  }

  // world position of the radar aperture + its pointing direction
  radarOrigin(target) {
    this.group.updateMatrixWorld(true);
    return target.set(0.046, 0, 0).applyMatrix4(this.head.matrixWorld);
  }

  setActive(state) {
    const colors = { idle: 0x6a7a77, detect: 0xffb547, measure: 0x3ddc74, done: 0x2bd4b8 };
    this.ledMat.color.setHex(colors[state] ?? colors.idle);
    this.windowMat.emissiveIntensity = state === "measure" ? 1.2 : state === "detect" ? 0.8 : 0.4;
  }

  drawScreen(v) {
    const g = this.screenCanvas.getContext("2d");
    g.fillStyle = "#08110f";
    g.fillRect(0, 0, 160, 100);
    g.textBaseline = "middle";
    g.font = "600 13px 'Barlow Semi Condensed', sans-serif";
    g.fillStyle = "#6d8a83";
    g.fillText(v ? v.bed : "BestShape VS", 10, 15);
    g.font = "700 38px 'Barlow Semi Condensed', sans-serif";
    g.fillStyle = "#3ddc74";
    g.fillText(v && v.hr ? String(v.hr) : "--", 10, 58);
    g.fillStyle = "#f5cf3a";
    g.fillText(v && v.rr ? String(v.rr) : "--", 88, 58);
    g.font = "600 12px 'Barlow Semi Condensed', sans-serif";
    g.fillStyle = "#6d8a83";
    g.fillText("HR", 10, 88);
    g.fillText("RR", 88, 88);
    this.screenTex.needsUpdate = true;
  }
}

// --- three-drawer medicine cabinet (Kachaka shelf style) ---
export class MedShelf extends DockableShelf {
  constructor(opts) {
    super(opts);
    const white = this.frame(0.78);
    this.add(new RoundedBoxGeometry(W - 0.01, 0.62, W - 0.01, 2, 0.02), white, 0, 0.5, 0);
    const front = this.mat(0x2a9d8f, { roughness: 0.55 });
    const handle = this.mat(0xdfe6e6, { roughness: 0.3, metalness: 0.7 });
    [0.29, 0.49, 0.69].forEach((y) => {
      this.add(new RoundedBoxGeometry(0.02, 0.17, W - 0.06, 2, 0.008), front, W / 2 - 0.004, y, 0);
      this.add(new THREE.BoxGeometry(0.02, 0.018, 0.12), handle, W / 2 + 0.01, y + 0.05, 0);
    });
    this.add(new THREE.BoxGeometry(W, 0.02, W), white, 0, 0.82, 0);
    // green pharmacy cross on both sides
    const cross = this.mat(0x2f9a59, { roughness: 0.5 });
    for (const side of [-1, 1]) {
      this.add(new THREE.BoxGeometry(0.12, 0.035, 0.004), cross, 0, 0.6, side * (W / 2 + 0.003));
      this.add(new THREE.BoxGeometry(0.035, 0.12, 0.004), cross, 0, 0.6, side * (W / 2 + 0.003));
    }
    this.lockMat = this.mat(0x6a7a77, { roughness: 0.4, emissive: new THREE.Color(0x000000) });
    this.add(new THREE.SphereGeometry(0.014, 10, 8), this.lockMat, W / 2, 0.79, 0.15);

    // items placed on the top tray by the pharmacist
    this.items = [
      [0xf3f6fb, 0.13, 0.07, 0.09, -0.08, -0.08],
      [0xf6d9a8, 0.1, 0.09, 0.08, 0.07, -0.1],
      [0xcfe7d6, 0.16, 0.05, 0.11, 0.0, 0.1],
    ].map(([c, w, h, d, x, z]) => {
      const m = this.add(new THREE.BoxGeometry(w, h, d), this.mat(c, { roughness: 0.7 }), x, 0.83 + h / 2, z);
      m.visible = false;
      return m;
    });
    this.resetHome();
  }

  load(count = this.items.length) {
    this.items.forEach((m, i) => (m.visible = i < count));
    this.lockMat.color.setHex(0x3ddc74);
    this.lockMat.emissive.setHex(0x1b6b3d);
  }

  unloadOne() {
    const m = [...this.items].reverse().find((it) => it.visible);
    if (m) m.visible = false;
    if (!this.items.some((it) => it.visible)) {
      this.lockMat.color.setHex(0x6a7a77);
      this.lockMat.emissive.setHex(0x000000);
    }
  }

  get loaded() {
    return this.items.filter((m) => m.visible).length;
  }

  resetHome() {
    super.resetHome();
    if (this.items) this.items.forEach((m) => (m.visible = false));
    if (this.lockMat) {
      this.lockMat.color.setHex(0x6a7a77);
      this.lockMat.emissive.setHex(0x000000);
    }
  }
}
