import * as THREE from "three";
import { Batcher, addBox, std } from "./builders.js";
import { FLOORS, FLOOR_GAP, ELEVATOR } from "./config.js";
import { emit } from "./sim.js";

const TOWER = { x1: -11.75, x2: -9.15, z1: -1.35, z2: 1.35 };
const CAB = { x1: -11.6, x2: -9.32, z1: -1.18, z2: 1.18, h: 2.45 };
const TOP = (FLOORS.length - 1) * FLOOR_GAP + 3.3;

export class Elevator {
  constructor() {
    this.group = new THREE.Group();
    this.group.name = "elevator";
    this.cabY = 0;
    this.v = 0;
    this.targetY = 0;
    this.moving = false;
    this.doors = FLOORS.map(() => ({ open: 0, target: 0, panels: [] }));
    this.calls = FLOORS.map(() => false);
    this.trips = 0;
    this.occupied = false;
    this.#build();
    this.#updateIndicator(true);
  }

  get floorFloat() {
    return this.cabY / FLOOR_GAP;
  }

  get floor() {
    return Math.round(this.floorFloat);
  }

  get direction() {
    if (!this.moving) return 0;
    return this.targetY > this.cabY ? 1 : -1;
  }

  doorState(floor = this.floor) {
    const d = this.doors[floor];
    if (d.open > 0.98 && d.target === 1) return "open";
    if (d.open < 0.02 && d.target === 0) return "closed";
    return d.target === 1 ? "opening" : "closing";
  }

  // --- geometry ---
  #build() {
    const glass = std(0xbfe4ee, { roughness: 0.05, metalness: 0.1, transparent: true, opacity: 0.16, depthWrite: false });
    const mats = {
      post: std(0x33403f, { roughness: 0.5, metalness: 0.4 }),
      band: std(0x55625f, { roughness: 0.6, metalness: 0.2 }),
      glass,
      machine: std(0x46524f, { roughness: 0.7 }),
      roof: std(0xdde5e3, { roughness: 0.8 }),
    };
    const b = new Batcher();
    const { x1, x2, z1, z2 } = TOWER;
    for (const [x, z] of [[x1, z1], [x1, z2], [x2, z1], [x2, z2]]) {
      addBox(b, "post", x - 0.06, x + 0.06, -0.26, TOP + 0.9, z - 0.06, z + 0.06);
    }
    for (let i = 0; i < FLOORS.length; i++) {
      const y = i * FLOOR_GAP;
      addBox(b, "band", x1 - 0.05, x2 + 0.05, y - 0.26, y, z1 - 0.05, z1 + 0.05);
      addBox(b, "band", x1 - 0.05, x2 + 0.05, y - 0.26, y, z2 - 0.05, z2 + 0.05);
      addBox(b, "band", x1 - 0.05, x1 + 0.05, y - 0.26, y, z1, z2);
      // landing door frame on the building side
      addBox(b, "band", x2 - 0.05, x2 + 0.05, y + 2.25, y + 2.4, -0.7, 0.7);
      addBox(b, "glass", x2 - 0.02, x2 + 0.02, y, y + 2.25, z1, -0.66);
      addBox(b, "glass", x2 - 0.02, x2 + 0.02, y, y + 2.25, 0.66, z2);
      addBox(b, "glass", x2 - 0.02, x2 + 0.02, y + 2.4, y + FLOOR_GAP - 0.26, z1, z2);
    }
    addBox(b, "glass", x1, x2, -0.26, TOP, z2 - 0.015, z2 + 0.015);
    addBox(b, "glass", x1, x2, -0.26, TOP, z1 - 0.015, z1 + 0.015);
    addBox(b, "glass", x1 - 0.015, x1 + 0.015, -0.26, TOP, z1, z2);
    addBox(b, "machine", x1 - 0.08, x2 + 0.08, TOP, TOP + 0.85, z1 - 0.08, z2 + 0.08);
    addBox(b, "roof", x1 - 0.14, x2 + 0.14, TOP + 0.85, TOP + 0.95, z1 - 0.14, z2 + 0.14);
    this.group.add(b.build(mats));

    // hospital "H" sign on the machine room (generic wayfinding symbol)
    const sign = new THREE.Mesh(
      new THREE.PlaneGeometry(0.62, 0.62),
      new THREE.MeshBasicMaterial({ map: signTexture(), transparent: true }),
    );
    sign.position.set((x1 + x2) / 2, TOP + 0.43, z2 + 0.09);
    this.group.add(sign);

    // landing doors (two sliding panels per floor)
    const doorMat = std(0xb9c3c4, { roughness: 0.28, metalness: 0.75 });
    const doorGeo = new THREE.BoxGeometry(0.04, 2.2, 0.62);
    this.doors.forEach((d, i) => {
      for (const side of [-1, 1]) {
        const m = new THREE.Mesh(doorGeo, doorMat);
        m.position.set(ELEVATOR.doorX, i * FLOOR_GAP + 1.11, side * 0.31);
        m.userData.side = side;
        this.group.add(m);
        d.panels.push(m);
      }
    });

    // floor indicator (shared canvas) + call buttons
    this.indicatorCanvas = document.createElement("canvas");
    this.indicatorCanvas.width = 192;
    this.indicatorCanvas.height = 72;
    this.indicatorTex = new THREE.CanvasTexture(this.indicatorCanvas);
    this.indicatorTex.colorSpace = THREE.SRGBColorSpace;
    const indMat = new THREE.MeshBasicMaterial({ map: this.indicatorTex });
    this.callLights = [];
    for (let i = 0; i < FLOORS.length; i++) {
      const ind = new THREE.Mesh(new THREE.PlaneGeometry(0.62, 0.23), indMat);
      ind.rotation.y = Math.PI / 2;
      ind.position.set(-8.9, i * FLOOR_GAP + 2.66, 0);
      this.group.add(ind);
      const plate = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.22, 0.12), std(0x9aa5a8, { metalness: 0.6, roughness: 0.3 }));
      plate.position.set(-8.92, i * FLOOR_GAP + 1.12, 1.26);
      this.group.add(plate);
      const light = new THREE.Mesh(
        new THREE.CircleGeometry(0.03, 16),
        new THREE.MeshBasicMaterial({ color: 0x5b6a68 }),
      );
      light.rotation.y = Math.PI / 2;
      light.position.set(-8.9, i * FLOOR_GAP + 1.15, 1.26);
      this.group.add(light);
      this.callLights.push(light);
    }

    // cab
    this.cab = new THREE.Group();
    const cb = new Batcher();
    const cabMats = {
      floor: std(0x8f9c9a, { roughness: 0.6 }),
      panel: std(0xe9eeec, { roughness: 0.55 }),
      side: std(0xd8e6e8, { roughness: 0.2, transparent: true, opacity: 0.32, depthWrite: false }),
      rail: std(0xaab4b6, { roughness: 0.25, metalness: 0.8 }),
      light: new THREE.MeshBasicMaterial({ color: 0xfdfbf2 }),
    };
    addBox(cb, "floor", CAB.x1, CAB.x2, -0.1, 0, CAB.z1, CAB.z2);
    addBox(cb, "side", CAB.x1, CAB.x1 + 0.04, 0, CAB.h, CAB.z1, CAB.z2);
    addBox(cb, "panel", CAB.x1, CAB.x1 + 0.06, 0, 0.12, CAB.z1, CAB.z2);
    addBox(cb, "side", CAB.x1, CAB.x2, 0, CAB.h, CAB.z1, CAB.z1 + 0.04);
    addBox(cb, "side", CAB.x1, CAB.x2, 0, CAB.h, CAB.z2 - 0.04, CAB.z2);
    addBox(cb, "panel", CAB.x1, CAB.x2, CAB.h, CAB.h + 0.1, CAB.z1, CAB.z2);
    addBox(cb, "light", CAB.x1 + 0.4, CAB.x2 - 0.4, CAB.h - 0.012, CAB.h, CAB.z1 + 0.4, CAB.z2 - 0.4);
    addBox(cb, "rail", CAB.x1 + 0.06, CAB.x1 + 0.1, 0.88, 0.92, CAB.z1 + 0.2, CAB.z2 - 0.2);
    this.cab.add(cb.build(cabMats));
    this.group.add(this.cab);

    // cables + counterweight
    const cableMat = std(0x2c3433, { roughness: 0.4, metalness: 0.6 });
    this.cables = [-0.16, 0.16].map((z) => {
      const c = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.012, 1, 6), cableMat);
      c.position.set(-10.45, 0, z);
      this.group.add(c);
      return c;
    });
    this.counterweight = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.9, 0.5), std(0x56605e, { roughness: 0.6 }));
    this.counterweight.position.set(-11.68, 0, 0.75);
    this.group.add(this.counterweight);
    this.#syncCab();
  }

  #syncCab() {
    this.cab.position.y = this.cabY;
    const top = this.cabY + CAB.h + 0.1;
    for (const c of this.cables) {
      c.scale.y = Math.max(0.01, TOP - top);
      c.position.y = (TOP + top) / 2;
    }
    this.counterweight.position.y = TOP - 1.1 - this.cabY * 0.92;
  }

  #updateIndicator(force = false) {
    const key = `${this.floor}:${this.direction}`;
    if (!force && key === this.indicatorKey) return;
    this.indicatorKey = key;
    const g = this.indicatorCanvas.getContext("2d");
    g.fillStyle = "#0e1716";
    g.fillRect(0, 0, 192, 72);
    g.fillStyle = "#ffb547";
    g.font = "700 48px 'Barlow Semi Condensed', sans-serif";
    g.textAlign = "center";
    g.textBaseline = "middle";
    const arrow = this.direction > 0 ? "▲" : this.direction < 0 ? "▼" : "";
    g.fillText(`${FLOORS[this.floor].id} ${arrow}`, 96, 39);
    this.indicatorTex.needsUpdate = true;
  }

  // --- simulation ---
  update(dt) {
    if (this.moving) {
      const dist = this.targetY - this.cabY;
      const dir = Math.sign(dist);
      const vAllowed = Math.min(ELEVATOR.speed, Math.sqrt(2 * ELEVATOR.accel * Math.abs(dist)));
      const vt = dir * vAllowed;
      const dv = ELEVATOR.accel * dt;
      this.v = this.v < vt ? Math.min(this.v + dv, vt) : Math.max(this.v - dv, vt);
      let step = this.v * dt;
      if (Math.abs(step) >= Math.abs(dist) || Math.abs(dist) < 0.003) {
        step = dist;
        this.v = 0;
        this.moving = false;
      }
      this.cabY += step;
      this.#syncCab();
    }
    for (const d of this.doors) {
      const rate = dt / ELEVATOR.doorTime;
      d.open = d.target > d.open ? Math.min(d.target, d.open + rate) : Math.max(d.target, d.open - rate);
      const ease = d.open * d.open * (3 - 2 * d.open);
      for (const p of d.panels) p.position.z = p.userData.side * (0.31 + ease * 0.64);
    }
    this.callLights.forEach((l, i) => l.material.color.setHex(this.calls[i] ? 0xffb547 : 0x5b6a68));
    this.#updateIndicator();
  }

  async openDoors(floor, sim, token) {
    this.doors[floor].target = 1;
    await sim.until(() => this.doors[floor].open >= 1, token);
  }

  async closeDoors(floor, sim, token) {
    this.doors[floor].target = 0;
    await sim.until(() => this.doors[floor].open <= 0, token);
  }

  // the cab only moves with every landing door shut (see LiftScheduler)
  async moveTo(floor, sim, token) {
    this.targetY = floor * FLOOR_GAP;
    if (Math.abs(this.targetY - this.cabY) < 0.003 && !this.moving) return;
    this.moving = true;
    emit("elevator", { kind: "depart", from: this.floor, to: floor });
    await sim.until(() => !this.moving, token);
    this.trips++;
    emit("elevator", { kind: "arrive", floor });
  }

  anyDoorOpen() {
    return this.doors.some((d) => d.open > 0.001 || d.target > 0);
  }

  reset(floor = 0) {
    this.cabY = floor * FLOOR_GAP;
    this.targetY = this.cabY;
    this.v = 0;
    this.moving = false;
    this.occupied = false;
    this.calls.fill(false);
    for (const d of this.doors) {
      d.open = 0;
      d.target = 0;
    }
    this.#syncCab();
    this.#updateIndicator(true);
  }

  // LiDAR segments while the robot is inside the cab
  cabWalls(floor) {
    const segs = [
      [CAB.x1, CAB.z1, CAB.x2, CAB.z1],
      [CAB.x1, CAB.z2, CAB.x2, CAB.z2],
      [CAB.x1, CAB.z1, CAB.x1, CAB.z2],
    ];
    if (this.doors[floor] && this.doors[floor].open < 0.5) segs.push([ELEVATOR.doorX, -0.62, ELEVATOR.doorX, 0.62]);
    return segs;
  }
}

function signTexture() {
  const c = document.createElement("canvas");
  c.width = c.height = 128;
  const g = c.getContext("2d");
  g.fillStyle = "#1f5fa8";
  g.beginPath();
  g.roundRect(4, 4, 120, 120, 18);
  g.fill();
  g.fillStyle = "#ffffff";
  g.font = "700 92px 'Barlow Semi Condensed', sans-serif";
  g.textAlign = "center";
  g.textBaseline = "middle";
  g.fillText("H", 64, 70);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
