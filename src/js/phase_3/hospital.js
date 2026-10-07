import * as THREE from "three";
import { Batcher, addBox, addRBox, place, geo, std, textTexture, shadowMaterial, applyFade } from "./builders.js";
import { FLOORS, FLOOR_GAP, PLATE, CORRIDOR, ROOM_CENTERS, WALL_LOW, WALL_HIGH, WALL_T, LANES } from "./config.js";
import { fwd } from "./sim.js";

const UTILITY_DOOR = -5.4; // front-left utility room door, offset from room 1's door so crossings never meet head-on

// --- per-floor material set (each floor fades independently in the cut-away view) ---
function floorMaterials(def) {
  const accent = new THREE.Color(def.accent);
  return {
    slab: std(0xc9d3d1, { roughness: 0.9 }),
    floor: std(def.tint, { roughness: 0.95 }),
    corridor: std(0xf5f7f6, { roughness: 0.9 }),
    stripe: std(accent, { roughness: 0.6 }),
    wall: std(0xf4f6f5, { roughness: 0.92 }),
    cap: std(0x2f3b3a, { roughness: 0.7 }),
    white: std(0xfbfcfc, { roughness: 0.6 }),
    frame: std(0xd5dddc, { roughness: 0.5, metalness: 0.2 }),
    sheet: std(0xe3eef6, { roughness: 0.95 }),
    wood: std(0xc9a47c, { roughness: 0.75 }),
    metal: std(0x9ba6a9, { roughness: 0.35, metalness: 0.65 }),
    dark: std(0x263033, { roughness: 0.4 }),
    screen: std(0x10302c, { roughness: 0.3, emissive: new THREE.Color(0x1d6f62), emissiveIntensity: 0.55 }),
    seat: std(0x3b8d84, { roughness: 0.85 }),
    seat2: std(0xd6a648, { roughness: 0.85 }),
    accentSoft: std(accent.clone().lerp(new THREE.Color(0xffffff), 0.55), { roughness: 0.85 }),
    leaf: std(0x5f9b62, { roughness: 0.9 }),
    boxA: std(0xe7eef8, { roughness: 0.8 }),
    boxB: std(0xf3d9ab, { roughness: 0.8 }),
    boxC: std(0xcfe7d6, { roughness: 0.8 }),
    glass: std(0xcde9f0, { roughness: 0.08, transparent: true, opacity: 0.14, depthWrite: false }),
    window: std(0xbfe0ea, { roughness: 0.1, metalness: 0.1, transparent: true, opacity: 0.38, depthWrite: false }),
    shadow: shadowMaterial(0.3),
  };
}

export class Hospital {
  constructor() {
    this.root = new THREE.Group();
    this.root.name = "hospital";
    this.floors = [];
    this.locations = new Map();
    this.beds = new Map();
    this.staffSpots = {};
    this.zones = new Map(); // zone id -> display name (one robot at a time)
    this.docks = []; // chargers + parking spots
    this.carts = {}; // floor index -> vital-sign cart home
    this.medHomes = [];
    FLOORS.forEach((def, i) => this.floors.push(this.#buildFloor(i, def)));
  }

  floorY(i) {
    return i * FLOOR_GAP;
  }

  location(id) {
    const loc = this.locations.get(id);
    if (!loc) throw new Error(`unknown location ${id}`);
    return loc;
  }

  setFloorFade(i, alpha) {
    const f = this.floors[i];
    if (Math.abs(f.fade - alpha) < 0.002) return;
    f.fade = alpha;
    applyFade(f.materials, alpha);
    f.group.visible = alpha > 0.02;
  }

  // ---------------------------------------------------------------- floors
  #buildFloor(index, def) {
    const mats = floorMaterials(def);
    const f = {
      index,
      def,
      id: def.id,
      y: index * FLOOR_GAP,
      group: new THREE.Group(),
      batch: new Batcher(),
      walls: [], // 2D segments for the LiDAR
      materials: Object.values(mats),
      mats,
      fade: 1,
    };
    f.group.name = def.id;
    f.group.position.y = f.y;

    this.#shell(f);
    [this.#floor1, this.#floor2, this.#floorCare, this.#floorCare][index].call(this, f);

    f.group.add(f.batch.build(mats));
    f.batch = null;
    this.root.add(f.group);
    return f;
  }

  #wall(f, x1, z1, x2, z2, h = WALL_LOW, key = "wall") {
    const len = Math.hypot(x2 - x1, z2 - z1);
    if (len < 0.01) return;
    const rot = Math.atan2(-(z2 - z1), x2 - x1);
    const cx = (x1 + x2) / 2;
    const cz = (z1 + z2) / 2;
    f.batch.add(key, geo.box(), place(cx, h / 2, cz, rot, len + WALL_T, h, WALL_T));
    f.batch.add("cap", geo.box(), place(cx, h + 0.012, cz, rot, len + WALL_T + 0.004, 0.024, WALL_T + 0.006));
    f.walls.push([x1, z1, x2, z2]);
  }

  // wall along x (fixed z) or z (fixed x) with door gaps [[center, width], ...]
  #wallRun(f, axis, fixed, from, to, gaps = [], h = WALL_LOW) {
    const cuts = gaps.map(([c, w]) => [c - w / 2, c + w / 2]).sort((a, b) => a[0] - b[0]);
    let start = from;
    for (const [a, b] of cuts) {
      if (a > start) this.#seg(f, axis, fixed, start, a, h);
      start = Math.max(start, b);
    }
    if (to > start) this.#seg(f, axis, fixed, start, to, h);
  }

  #seg(f, axis, fixed, a, b, h) {
    if (axis === "x") this.#wall(f, a, fixed, b, fixed, h);
    else this.#wall(f, fixed, a, fixed, b, h);
  }

  // obstacle rectangle for the LiDAR (axis aligned, in floor coordinates)
  #obstacle(f, x1, x2, z1, z2) {
    f.walls.push([x1, z1, x2, z1], [x2, z1, x2, z2], [x2, z2, x1, z2], [x1, z2, x1, z1]);
  }

  #shadow(f, x, z, w, d, rot = 0) {
    f.batch.add("shadow", geo.plane(), place(x, 0.016, z, rot, w, 1, d));
  }

  #shell(f) {
    const b = f.batch;
    const { minX, maxX, minZ, maxZ } = PLATE;
    // slab + floor finishes
    addBox(b, "slab", minX - 0.1, maxX + 0.1, -0.26, 0, minZ - 0.1, maxZ + 0.1);
    addBox(b, "slab", -9.25, minX - 0.1, -0.26, 0, -1.0, 1.0); // elevator threshold
    addBox(b, "floor", minX, maxX, 0, 0.012, minZ, CORRIDOR.minZ);
    addBox(b, "floor", minX, maxX, 0, 0.012, CORRIDOR.maxZ, maxZ);
    addBox(b, "corridor", -9.25, maxX, 0, 0.013, CORRIDOR.minZ, CORRIDOR.maxZ);
    addBox(b, "stripe", -8.7, 8.7, 0.013, 0.016, 0.8, 0.88);

    // back facade with one window per room
    const winH = [0.95, 2.3];
    this.#wall(f, minX, minZ, maxX, minZ, winH[0]);
    addBox(b, "wall", minX - 0.06, maxX + 0.06, winH[1], WALL_HIGH, minZ - 0.06, minZ + 0.06);
    addBox(b, "cap", minX - 0.06, maxX + 0.06, WALL_HIGH, WALL_HIGH + 0.024, minZ - 0.065, minZ + 0.065);
    for (let i = 0; i <= 4; i++) {
      const x = minX + i * 4.5;
      const w = i === 0 || i === 4 ? 0.61 : 1.1;
      const x1 = i === 0 ? x - 0.06 : i === 4 ? x - w + 0.06 : x - w / 2;
      addBox(b, "wall", x1, x1 + w, winH[0], winH[1], minZ - 0.06, minZ + 0.06);
    }
    for (const cx of ROOM_CENTERS) {
      addBox(b, "window", cx - 1.7, cx + 1.7, winH[0], winH[1], minZ - 0.02, minZ + 0.02);
      addBox(b, "frame", cx - 1.72, cx + 1.72, winH[0] - 0.03, winH[0], minZ - 0.08, minZ + 0.1);
    }

    // ends + front parapet
    this.#wallRun(f, "z", minX, minZ, maxZ, [[0, 2.0]]);
    // elevator portal
    addBox(b, "frame", minX - 0.08, minX + 0.08, 0, 2.45, -1.12, -1.0);
    addBox(b, "frame", minX - 0.08, minX + 0.08, 0, 2.45, 1.0, 1.12);
    addBox(b, "frame", minX - 0.08, minX + 0.08, 2.35, 2.5, -1.12, 1.12);
    this.#wallRun(f, "z", maxX, minZ, maxZ, [], 1.0);
    if (f.index !== 0) {
      this.#wallRun(f, "x", maxZ, minX, maxX, [], 0.9);
      addBox(b, "glass", minX, maxX, 0.92, WALL_HIGH, maxZ - 0.02, maxZ + 0.02);
    }

    // corridor back wall with one door per room + partitions between rooms
    this.#wallRun(f, "x", CORRIDOR.minZ, minX, maxX, ROOM_CENTERS.map((c) => [c, 1.3]));
    for (const x of [-4.5, 0, 4.5]) this.#wall(f, x, minZ, x, CORRIDOR.minZ);
  }

  // room number painted on the corridor floor in front of each door
  #floorDecal(f, text, x, z, w = 0.9) {
    const mat = new THREE.MeshBasicMaterial({
      map: textTexture(text, { color: "#24423d", w: 256, h: 112 }),
      transparent: true,
      opacity: 0.82,
      depthWrite: false,
    });
    f.materials.push(mat);
    const m = new THREE.Mesh(geo.plane(), mat);
    m.scale.set(w, 1, w * 0.44);
    m.position.set(x, 0.02, z);
    f.group.add(m);
  }

  #loc(f, id, name, x, z, yaw, via = [], zone = null) {
    const loc = { id: `${f.id}-${id}`, floor: f.index, name, x, z, yaw, via, zone };
    this.locations.set(loc.id, loc);
    return loc;
  }

  #zone(id, name) {
    this.zones.set(id, name);
    return id;
  }

  // charger or parking spot: the robot reverses onto (x, z) from an approach point in front of it
  #dock(f, id, name, x, z, yaw, via, zone, charger, decal = null) {
    const fw = fwd(yaw);
    const approach = { id: `${f.id}-${id}-approach`, floor: f.index, name, x: x + fw.x * 0.7, z: z + fw.z * 0.7, yaw, via, zone };
    const dock = { id, name, floor: f.index, x, z, yaw, charger, zone, approach, occupant: null, reservedBy: null };
    this.docks.push(dock);
    const b = f.batch;
    if (charger) {
      // charging base against the wall behind the parked robot, contacts facing it
      const bx = x - fw.x * 0.41;
      const bz = z - fw.z * 0.41;
      addRBox(b, "dark", bx, 0, bz, 0.34, 0.16, 0.16, 0, 0.03);
      const sz = bz + fw.z * 0.085;
      addBox(b, "screen", bx - 0.1, bx + 0.1, 0.1, 0.13, sz - 0.005, sz + 0.005);
    }
    addBox(b, "accentSoft", x - 0.3, x + 0.3, 0.013, 0.017, z - 0.33, z + 0.33);
    const [dx, dz] = decal || [x + fw.x * 1.2, z + fw.z * 1.2];
    this.#floorDecal(f, id, dx, dz, 0.5);
    return dock;
  }

  // ------------------------------------------------------------- furniture
  #bed(f, x, z) {
    const b = f.batch;
    // frame, mattress, head/foot boards, pillow; head against the back wall (-z)
    addRBox(b, "frame", x, 0.18, z, 0.95, 0.32, 2.05, 0, 0.04);
    addRBox(b, "sheet", x, 0.5, z + 0.02, 0.9, 0.12, 1.98, 0, 0.05);
    addRBox(b, "white", x, 0.3, z - 1.0, 0.98, 0.72, 0.06, 0, 0.025);
    addRBox(b, "white", x, 0.3, z + 1.0, 0.98, 0.48, 0.06, 0, 0.025);
    addRBox(b, "white", x, 0.62, z - 0.78, 0.56, 0.1, 0.32, 0, 0.045);
    for (const [dx, dz] of [[-0.4, -0.9], [0.4, -0.9], [-0.4, 0.9], [0.4, 0.9]]) {
      addBox(b, "metal", x + dx - 0.03, x + dx + 0.03, 0, 0.2, z + dz - 0.03, z + dz + 0.03);
    }
    addBox(b, "metal", x - 0.5, x - 0.47, 0.55, 0.8, z - 0.55, z + 0.1); // side rails
    addBox(b, "metal", x + 0.47, x + 0.5, 0.55, 0.8, z - 0.55, z + 0.1);
    this.#shadow(f, x, z, 1.35, 2.45);
    this.#obstacle(f, x - 0.48, x + 0.48, z - 1.03, z + 1.03);
  }

  #cabinet(f, x, z) {
    addRBox(f.batch, "white", x, 0, z, 0.44, 0.74, 0.44, 0, 0.03);
    addBox(f.batch, "accentSoft", x - 0.2, x + 0.2, 0.42, 0.44, z + 0.2, z + 0.225);
    this.#obstacle(f, x - 0.22, x + 0.22, z - 0.22, z + 0.22);
  }

  #chair(f, x, z, rotY = 0, key = "seat") {
    const b = f.batch;
    addRBox(b, key, x, 0.4, z, 0.46, 0.08, 0.46, rotY, 0.03);
    const back = place(x, 0, z, rotY);
    const offset = new THREE.Vector3(-0.21, 0, 0).applyMatrix4(new THREE.Matrix4().extractRotation(back));
    addRBox(b, key, x + offset.x, 0.45, z + offset.z, 0.07, 0.45, 0.46, rotY, 0.03);
    addBox(b, "metal", x - 0.02, x + 0.02, 0, 0.4, z - 0.02, z + 0.02);
    this.#shadow(f, x, z, 0.7, 0.7);
  }

  #counter(f, x1, x2, z1, z2, h = 1.05, top = "wood") {
    addBox(f.batch, "white", x1, x2, 0, h - 0.04, z1, z2);
    addBox(f.batch, top, x1 - 0.03, x2 + 0.03, h - 0.04, h, z1 - 0.03, z2 + 0.03);
    this.#shadow(f, (x1 + x2) / 2, (z1 + z2) / 2, x2 - x1 + 0.5, z2 - z1 + 0.5);
    this.#obstacle(f, x1, x2, z1, z2);
  }

  #monitor(f, x, y, z, rotY = 0) {
    addRBox(f.batch, "dark", x, y, z, 0.05, 0.3, 0.48, rotY, 0.015);
    f.batch.add("screen", geo.box(), place(x, y + 0.155, z, rotY, 0.056, 0.24, 0.42));
    addBox(f.batch, "dark", x - 0.02, x + 0.02, y - 0.12, y, z - 0.02, z + 0.02);
  }

  #rack(f, x, z, w, d, h, rotY = 0, levels = 4, fill = ["boxA", "boxB", "boxC"]) {
    const b = f.batch;
    const m = place(x, 0, z, rotY);
    const local = (lx, ly, lz) => new THREE.Vector3(lx, ly, lz).applyMatrix4(m);
    for (const [lx, lz] of [[-w / 2, -d / 2], [w / 2, -d / 2], [-w / 2, d / 2], [w / 2, d / 2]]) {
      const p = local(lx, 0, lz);
      b.add("metal", geo.box(), place(p.x, h / 2, p.z, rotY, 0.03, h, 0.03));
    }
    for (let i = 0; i < levels; i++) {
      const y = 0.12 + (i * (h - 0.2)) / (levels - 1);
      const p = local(0, y, 0);
      b.add("frame", geo.box(), place(p.x, y, p.z, rotY, w, 0.025, d));
      if (i === levels - 1) continue;
      const n = Math.max(2, Math.round(w / 0.24));
      for (let k = 0; k < n; k++) {
        const bw = (w / n) * 0.82;
        const bh = 0.12 + ((k * 7 + i * 3) % 5) * 0.025;
        const q = local(-w / 2 + (k + 0.5) * (w / n), y, 0);
        b.add(fill[(k + i) % fill.length], geo.box(), place(q.x, y + 0.012 + bh / 2, q.z, rotY, bw, bh, d * 0.8));
      }
    }
    this.#shadow(f, x, z, w + 0.4, d + 0.4, rotY);
    const c = Math.abs(Math.cos(rotY));
    const hw = (c * w + (1 - c) * d) / 2;
    const hd = (c * d + (1 - c) * w) / 2;
    this.#obstacle(f, x - hw, x + hw, z - hd, z + hd);
  }

  #plant(f, x, z, s = 1) {
    f.batch.add("white", geo.cone(14), place(x, 0.2 * s, z, 0, 0.36 * s, 0.4 * s, 0.36 * s));
    f.batch.add("leaf", geo.sphere(10), place(x, 0.62 * s, z, 0, 0.62 * s, 0.7 * s, 0.62 * s));
    f.batch.add("leaf", geo.sphere(10), place(x + 0.1 * s, 0.88 * s, z - 0.05 * s, 0, 0.42 * s, 0.5 * s, 0.42 * s));
    this.#shadow(f, x, z, 0.8 * s, 0.8 * s);
  }

  #desk(f, x, z, rotY = 0) {
    addRBox(f.batch, "wood", x, 0.72, z, 1.2, 0.04, 0.62, rotY, 0.015);
    addBox(f.batch, "metal", x - 0.56, x - 0.52, 0, 0.72, z - 0.26, z + 0.26);
    addBox(f.batch, "metal", x + 0.52, x + 0.56, 0, 0.72, z - 0.26, z + 0.26);
    this.#shadow(f, x, z, 1.5, 0.95, rotY);
    this.#obstacle(f, x - 0.6, x + 0.6, z - 0.31, z + 0.31);
  }

  #sofa(f, x, z, w, rotY = 0) {
    addRBox(f.batch, "seat2", x, 0.15, z, w, 0.3, 0.8, rotY, 0.08);
    const m = place(x, 0, z, rotY);
    const back = new THREE.Vector3(0, 0, -0.32).applyMatrix4(m);
    addRBox(f.batch, "seat2", back.x, 0.3, back.z, w, 0.5, 0.18, rotY, 0.07);
    this.#shadow(f, x, z, w + 0.4, 1.2, rotY);
  }

  #headwall(f, cx) {
    // nurse-call rail behind each pair of beds
    addBox(f.batch, "accentSoft", cx - 2.0, cx + 2.0, 1.12, 1.3, -4.95, -4.9);
    for (const bx of [cx - 1.1, cx + 1.1]) {
      for (const dx of [-0.24, -0.08, 0.08, 0.24]) {
        addBox(f.batch, dx > 0.2 ? "screen" : "frame", bx + dx - 0.04, bx + dx + 0.04, 1.16, 1.25, -4.9, -4.87);
      }
    }
  }

  #wardrobe(f, x, z) {
    addRBox(f.batch, "wood", x, 0, z, 0.56, 1.8, 0.5, 0, 0.02);
    addBox(f.batch, "metal", x - 0.012, x + 0.012, 0.9, 1.12, z + 0.25, z + 0.27);
    this.#shadow(f, x, z, 0.85, 0.8);
    this.#obstacle(f, x - 0.28, x + 0.28, z - 0.25, z + 0.25);
  }

  #wheelchair(f, x, z, rotY = 0) {
    const b = f.batch;
    const m = place(x, 0, z, rotY);
    const at = (lx, lz) => new THREE.Vector3(lx, 0, lz).applyMatrix4(m);
    const seat = at(0, 0);
    b.add("seat", geo.box(), place(seat.x, 0.48, seat.z, rotY, 0.44, 0.06, 0.44));
    const back = at(-0.2, 0);
    b.add("seat", geo.box(), place(back.x, 0.75, back.z, rotY, 0.05, 0.48, 0.44));
    for (const side of [-1, 1]) {
      const w = at(-0.05, side * 0.26);
      b.add("dark", geo.cyl(20), place(w.x, 0.3, w.z, rotY, 0.6, 0.035, 0.6, Math.PI / 2));
      const c = at(0.2, side * 0.2);
      b.add("dark", geo.cyl(10), place(c.x, 0.07, c.z, rotY, 0.14, 0.03, 0.14, Math.PI / 2));
    }
    this.#shadow(f, x, z, 0.9, 0.9, rotY);
    this.#obstacle(f, x - 0.32, x + 0.32, z - 0.32, z + 0.32);
  }

  #table(f, x, z, w, d, chairs = []) {
    addRBox(f.batch, "wood", x, 0.72, z, w, 0.05, d, 0, 0.02);
    for (const [dx, dz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
      const lx = x + dx * (w / 2 - 0.08);
      const lz = z + dz * (d / 2 - 0.08);
      addBox(f.batch, "metal", lx - 0.02, lx + 0.02, 0, 0.72, lz - 0.02, lz + 0.02);
    }
    this.#shadow(f, x, z, w + 0.5, d + 0.5);
    this.#obstacle(f, x - w / 2, x + w / 2, z - d / 2, z + d / 2);
    for (const [cx, cz, rotY] of chairs) this.#chair(f, cx, cz, rotY);
  }

  // counter with a pass-through gap + back desk (nurse station / care station)
  #station(f, label) {
    this.#counter(f, -4.1, -0.62, 1.58, 2.12, 1.08);
    this.#counter(f, 0.22, 1.25, 1.58, 2.12, 1.08);
    this.#counter(f, -4.1, 1.25, 3.95, 4.5, 0.76);
    for (const x of [-3.3, -1.9, 0.5]) this.#monitor(f, x, 0.76, 4.3, -Math.PI / 2);
    this.#monitor(f, -2.6, 1.08, 1.9, Math.PI / 2);
    this.#chair(f, -3.3, 3.45, Math.PI / 2);
    this.#chair(f, -1.9, 3.45, Math.PI / 2);
    this.#floorDecal(f, label, -2.4, 2.75, 1.0);
    this.staffSpots[`${f.id}-staffA`] = { floor: f.index, x: -2.6, z: 2.8, yaw: Math.PI / 2 };
    this.staffSpots[`${f.id}-staffB`] = { floor: f.index, x: -1.2, z: 3.35, yaw: -Math.PI / 2 };
    this.staffSpots[`${f.id}-pickup`] = { floor: f.index, x: -0.2, z: 2.05, yaw: Math.PI / 2 };
    const zone = this.#zone(`${f.id}-ST`, `${f.id} ${label}取件點`);
    this.#loc(f, "station", `${f.id} ${label}`, -0.2, 1.3, -Math.PI / 2, [], zone);
  }

  // four residents' rooms on the back side, two care beds each
  #residentRooms(f, wheelchairs = []) {
    const n = f.index + 1; // room numbers 2xx / 3xx / 4xx
    const residents = RESIDENTS[f.id] || {};
    ROOM_CENTERS.forEach((cx, r) => {
      const room = `${n}0${r + 1}`;
      const zone = this.#zone(`${f.id}-R${r}`, `${f.id} ${room} 房`);
      this.#floorDecal(f, room, cx, -0.55, 0.8);
      this.#headwall(f, cx);
      if (wheelchairs.includes(r)) this.#wheelchair(f, cx + 1.95, -2.35, Math.PI);
      ["A", "B"].forEach((side, s) => {
        const bx = cx + (s === 0 ? -1.1 : 1.1);
        const bz = -3.9;
        this.#bed(f, bx, bz);
        this.#cabinet(f, bx + (s === 0 ? -0.78 : 0.78), -4.62);
        this.#wardrobe(f, cx + (s === 0 ? -1.85 : 1.85), -1.45);
        const id = `${room}-${side}`;
        const data = residents[id] || null;
        this.beds.set(id, {
          id,
          room,
          floor: f.index,
          x: bx,
          z: bz,
          chest: { x: bx, y: 0.76, z: -4.28 },
          patient: data ? { ...data, bed: id } : null,
          bedside: this.#loc(f, `${room}${side}-bedside`, `${id} 床邊`, cx + (s === 0 ? -0.12 : 0.12), -4.25, s === 0 ? Math.PI : 0, [[cx, CORRIDOR.minZ], [cx, -2.3]], zone),
          nurseSpot: { x: bx, z: -2.48, yaw: Math.PI / 2 },
        });
      });
    });
  }

  // utility room on the front-left, behind a wall with a door; on care floors it also
  // keeps the floor's vital-sign cart and a charger
  #utility(f, label, equipped = false) {
    const D = UTILITY_DOOR;
    this.#wallRun(f, "x", CORRIDOR.maxZ, PLATE.minX, -4.5, [[D, 1.2]]);
    this.#wall(f, -4.5, CORRIDOR.maxZ, -4.5, PLATE.maxZ);
    this.#rack(f, -8.0, 4.55, 1.3, 0.5, 1.5, 0, 4, ["sheet", "boxA"]);
    this.#floorDecal(f, label, D - 1.35, 1.6, 0.9);
    const zone = this.#zone(`${f.id}-U`, `${f.id} ${label}`);
    if (!equipped) return;
    const via = [[D, CORRIDOR.maxZ], [D, 1.85]];
    this.#dock(f, f.index === 2 ? "C3" : "C4", `${f.id} 充電座`, -5.2, 4.45, Math.PI / 2, [...via, [-5.2, 3.0]], zone, true);
    this.carts[f.index] = { floor: f.index, x: -7.4, z: 3.5, yaw: -Math.PI / 2, via: [...via, [-7.4, 2.2]], zone };
    this.#floorDecal(f, `VS-${f.id}`, -7.4, 2.45, 0.62);
  }

  // ------------------------------------------------------------------ 1F
  #floor1(f) {
    const b = f.batch;
    const [c1, c2, c3, c4] = ROOM_CENTERS;
    this.#floorDecal(f, "醫務室藥局", c1, -0.55, 1.25);
    this.#floorDecal(f, "機器人站", c2, -0.55, 1.2);
    this.#floorDecal(f, "醫務室", c3, -0.55, 1.0);
    this.#floorDecal(f, "復健室", c4, -0.55, 1.0);

    // dispensary: racks on the back and left walls, island counter
    for (const x of [-8.15, -6.95, -5.75]) this.#rack(f, x, -4.72, 1.05, 0.38, 1.85, 0, 5);
    this.#rack(f, -8.72, -3.3, 1.1, 0.38, 1.85, Math.PI / 2, 5);
    this.#counter(f, -7.9, -6.6, -3.45, -2.95, 0.95);
    this.#monitor(f, -7.25, 0.95, -3.2, Math.PI / 2);
    this.staffSpots.pharmacist = { floor: 0, x: -7.25, z: -3.85, yaw: -Math.PI / 2 };
    // three medicine cabinets along the east wall; one is normally kept free for P1 orders
    const pharmacy = this.#zone("1F-R0", "1F 藥局");
    const door = [[c1, CORRIDOR.minZ], [c1, -1.6]];
    const toCounter = [[-7.25, -3.85], [-6.35, -3.85]];
    this.medHomes = [
      {
        id: "MED-01",
        home: { floor: 0, x: -4.9, z: -1.85, yaw: 0, via: door, zone: pharmacy },
        load: { x: -4.9, z: -2.35, yaw: -Math.PI / 2, path: [toCounter[1], [-6.2, -2.35], [-4.9, -2.35]] },
      },
      {
        id: "MED-02",
        home: { floor: 0, x: -4.9, z: -2.85, yaw: 0, via: [...door, [-6.2, -2.35]], zone: pharmacy },
        load: { x: -4.9, z: -2.35, yaw: Math.PI / 2, path: [toCounter[1], [-6.2, -2.35], [-4.9, -2.35]] },
      },
      {
        id: "MED-03",
        home: { floor: 0, x: -4.9, z: -3.85, yaw: 0, via: [...door, [-6.2, -2.4], [-6.2, -3.35]], zone: pharmacy },
        load: { x: -4.9, z: -3.35, yaw: Math.PI / 2, path: [toCounter[1], [-6.2, -3.35], [-4.9, -3.35]] },
      },
    ];
    // robot station: two chargers along the back wall
    this.#zone("1F-R1", "1F 機器人站");
    this.#zone("1F-R2", "1F 醫務室");
    this.#zone("1F-R3", "1F 復健室");
    addBox(b, "accentSoft", -4.3, -0.2, 0.012, 0.0135, -4.98, -2.7);
    const station = [[c2, CORRIDOR.minZ], [c2, -2.4]];
    this.#dock(f, "C1", "1F 充電座 C1", -3.2, -4.45, -Math.PI / 2, [...station, [-3.2, -3.1]], "1F-R1", true);
    this.#dock(f, "C2", "1F 充電座 C2", -1.3, -4.45, -Math.PI / 2, [...station, [-1.3, -3.1]], "1F-R1", true);
    // standby spot in the lobby for a robot that finds every charger taken
    this.#dock(f, "S1", "1F 大廳待命點 S1", 0.4, 2.0, Math.PI / 2, [[0.4, CORRIDOR.maxZ]], null, false, [0.4, 2.75]);
    this.#dock(f, "S2", "1F 大廳待命點 S2", -0.75, 2.0, Math.PI / 2, [[-0.75, CORRIDOR.maxZ]], null, false, [-0.75, 2.75]);
    // clinic: desk, exam bed, cabinet
    this.#desk(f, c3 - 0.9, -4.3);
    this.#monitor(f, c3 - 0.9, 0.76, -4.45, Math.PI / 2);
    this.#chair(f, c3 - 0.9, -3.65, -Math.PI / 2);
    addRBox(b, "sheet", c3 + 1.05, 0, -3.5, 0.75, 0.62, 1.9, 0, 0.06);
    this.#obstacle(f, c3 + 0.67, c3 + 1.43, -4.45, -2.55);
    this.#cabinet(f, c3 + 1.7, -4.7);
    this.staffSpots.doctor = { floor: 0, x: c3 + 0.1, z: -3.3, yaw: Math.PI };
    // rehab room: parallel bars, treatment table, exercise bike
    for (const z of [-3.25, -2.65]) {
      addBox(b, "metal", c4 - 1.6, c4 + 0.6, 0.88, 0.92, z - 0.02, z + 0.02);
      for (const x of [c4 - 1.6, c4 + 0.6]) addBox(b, "metal", x - 0.025, x + 0.025, 0, 0.9, z - 0.025, z + 0.025);
    }
    addBox(b, "accentSoft", c4 - 1.7, c4 + 0.7, 0.012, 0.03, -3.4, -2.5);
    this.#obstacle(f, c4 - 1.6, c4 + 0.6, -3.27, -2.63);
    addRBox(b, "sheet", c4 + 1.3, 0, -4.15, 0.85, 0.5, 1.8, 0, 0.05);
    this.#obstacle(f, c4 + 0.87, c4 + 1.73, -5.0, -3.25);
    addRBox(b, "dark", c4 - 1.3, 0, -4.45, 0.9, 0.55, 0.38, 0, 0.05);
    addRBox(b, "dark", c4 - 0.95, 0.55, -4.45, 0.12, 0.6, 0.3, 0, 0.03);
    this.#obstacle(f, c4 - 1.75, c4 - 0.85, -4.64, -4.26);
    // lobby: information desk, family lounge, dining room, entrance
    this.#counter(f, -3.6, -1.2, 2.55, 3.15, 1.05);
    this.#monitor(f, -2.4, 1.05, 2.95, -Math.PI / 2);
    this.staffSpots.reception = { floor: 0, x: -2.4, z: 3.75, yaw: Math.PI / 2 };
    this.#sofa(f, 2.1, 2.95, 1.9);
    this.#sofa(f, 2.1, 4.5, 1.9, Math.PI);
    addRBox(b, "wood", 2.1, 0.38, 3.75, 1.0, 0.05, 0.45, 0, 0.02);
    this.#obstacle(f, 1.15, 3.05, 2.55, 4.9);
    this.seats = [
      { floor: 0, x: 1.65, z: 3.0, yaw: -Math.PI / 2 },
      { floor: 0, x: 2.5, z: 4.45, yaw: Math.PI / 2 },
    ];
    this.#floorDecal(f, "家屬會客區", 2.1, 1.7, 1.3);
    this.#table(f, -7.5, 2.65, 1.1, 0.75, [
      [-7.8, 2.1, -Math.PI / 2], [-7.2, 2.1, -Math.PI / 2], [-7.8, 3.2, Math.PI / 2], [-7.2, 3.2, Math.PI / 2],
    ]);
    this.#table(f, -5.8, 3.95, 1.1, 0.75, [
      [-6.1, 3.4, -Math.PI / 2], [-5.5, 3.4, -Math.PI / 2], [-6.1, 4.5, Math.PI / 2], [-5.5, 4.5, Math.PI / 2],
    ]);
    this.#floorDecal(f, "餐廳", -6.4, 1.65, 0.8);
    this.#plant(f, 8.4, 1.6);
    this.#plant(f, -4.9, 4.5);
    this.#plant(f, 4.4, 4.5, 0.85);
    this.#wallRun(f, "x", PLATE.maxZ, PLATE.minX, PLATE.maxX, [[7.4, 2.2]], 0.9);
    addBox(b, "glass", PLATE.minX, 6.3, 0.92, WALL_HIGH, PLATE.maxZ - 0.02, PLATE.maxZ + 0.02);
    addBox(b, "glass", 8.5, PLATE.maxX, 0.92, WALL_HIGH, PLATE.maxZ - 0.02, PLATE.maxZ + 0.02);
    addBox(b, "frame", 6.25, 8.55, 2.6, 2.75, 4.95, 6.2); // entrance canopy
    addBox(b, "glass", 6.4, 7.35, 0, 2.4, 4.98, 5.02);
    addBox(b, "glass", 7.45, 8.4, 0, 2.4, 4.98, 5.02);
    this.#floorDecal(f, "入口 ENTRANCE", 7.4, 4.3, 1.5);
    this.#wall(f, -4.5, CORRIDOR.maxZ, -4.5, 2.0);
  }

  // ------------------------------------------------------------------ 2F
  #floor2(f) {
    const b = f.batch;
    this.#residentRooms(f, [1]);
    this.#utility(f, "沐浴間", false);
    this.#station(f, "照服站");
    // activity room, open to the corridor
    this.#table(f, 3.8, 3.0, 1.4, 0.8, [
      [3.3, 2.45, -Math.PI / 2], [4.3, 2.45, -Math.PI / 2], [3.3, 3.55, Math.PI / 2], [4.3, 3.55, Math.PI / 2],
    ]);
    this.#table(f, 6.6, 3.0, 1.4, 0.8, [
      [6.1, 2.45, -Math.PI / 2], [7.1, 2.45, -Math.PI / 2], [6.1, 3.55, Math.PI / 2], [7.1, 3.55, Math.PI / 2],
    ]);
    addRBox(b, "dark", 8.9, 0.9, 3.2, 0.06, 0.65, 1.15, 0, 0.02);
    this.#plant(f, 2.0, 4.5, 0.85);
    this.#plant(f, 8.4, 4.5, 0.85);
    this.#floorDecal(f, "活動室", 5.2, 1.7, 0.9);
    this.activitySeats = [
      { floor: 1, x: 3.3, z: 2.45, yaw: -Math.PI / 2 },
      { floor: 1, x: 4.3, z: 3.55, yaw: Math.PI / 2 },
      { floor: 1, x: 7.1, z: 3.55, yaw: Math.PI / 2 },
    ];
    // controlled exit next to the elevator lobby
    this.#floorDecal(f, "出入管制", -7.75, -0.55, 0.95);
    addBox(b, "dark", -8.95, -8.9, 1.05, 1.35, -1.42, -1.26);
    addBox(b, "screen", -8.9, -8.88, 1.22, 1.3, -1.38, -1.3);
    this.exitPoint = { x: -6.9, z: 0.65 };
    // checkpoints sit on the eastbound lane, the direction the patrol runs
    this.patrol = [
      this.#loc(f, "cp-201", "2F 201 室門口", ROOM_CENTERS[0], LANES.east, Math.PI / 2),
      this.#loc(f, "cp-202", "2F 202 室門口", ROOM_CENTERS[1], LANES.east, Math.PI / 2),
      this.#loc(f, "cp-activity", "2F 活動室", 5.2, LANES.east, -Math.PI / 2),
      this.#loc(f, "cp-east", "2F 東側走廊端", 8.1, LANES.east, Math.PI),
    ];
  }

  // ----------------------------------------------------------- 3F / 4F
  #floorCare(f) {
    const b = f.batch;
    this.#residentRooms(f, f.index === 2 ? [0, 2] : [1]);
    this.#utility(f, "被服室", true);
    this.#station(f, "護理站");
    this.#wallRun(f, "x", CORRIDOR.maxZ, 1.5, 5, [[3.25, 1.2]]);
    this.#wall(f, 1.5, CORRIDOR.maxZ, 1.5, PLATE.maxZ);
    this.#wall(f, 5, CORRIDOR.maxZ, 5, PLATE.maxZ);
    this.#rack(f, 2.2, 4.6, 1.1, 0.42, 1.8, 0, 5);
    this.#rack(f, 3.5, 4.6, 1.1, 0.42, 1.8, 0, 5);
    addRBox(b, "white", 4.3, 0, 2.6, 0.55, 0.95, 0.75, 0, 0.04);
    this.#obstacle(f, 4.02, 4.58, 2.22, 2.98);
    this.#floorDecal(f, "備藥室", 3.25, 1.75, 0.9);
    this.#sofa(f, 7.0, 4.35, 2.4);
    addRBox(b, "wood", 7.0, 0.42, 3.2, 1.2, 0.05, 0.6, 0, 0.02);
    addRBox(b, "dark", 8.9, 0.9, 3.2, 0.06, 0.65, 1.15, 0, 0.02);
    this.#plant(f, 5.5, 4.5, 0.85);
    this.#floorDecal(f, "交誼廳", 7.0, 1.9, 0.9);
  }
}

// fictional, de-identified residents (simulated data)
const RESIDENTS = {
  "2F": {
    "201-A": { name: "劉○清", title: "劉伯伯", age: 89, sex: "男", hr: 70, rr: 16 },
    "202-B": { name: "孫○蘭", title: "孫奶奶", age: 84, sex: "女", hr: 76, rr: 17 },
    "204-A": { name: "高○福", title: "高伯伯", age: 92, sex: "男", hr: 68, rr: 15 },
  },
  "3F": {
    "301-A": { name: "林○明", title: "林伯伯", age: 88, sex: "男", hr: 72, rr: 16 },
    "301-B": { name: "陳○德", title: "陳伯伯", age: 91, sex: "男", hr: 81, rr: 18 },
    "302-A": { name: "王○山", title: "王伯伯", age: 86, sex: "男", hr: 67, rr: 15 },
    "302-B": { name: "張○華", title: "張伯伯", age: 93, sex: "男", hr: 98, rr: 27 },
    "303-A": { name: "李○生", title: "李伯伯", age: 84, sex: "男", hr: 76, rr: 17 },
    "304-A": { name: "吳○雄", title: "吳伯伯", age: 89, sex: "男", hr: 70, rr: 16 },
    "304-B": { name: "趙○玉", title: "趙奶奶", age: 87, sex: "女", hr: 88, rr: 19 },
  },
  "4F": {
    "401-A": { name: "黃○雄", title: "黃爺爺", age: 95, sex: "男", hr: 78, rr: 18 },
    "401-B": { name: "周○英", title: "周奶奶", age: 86, sex: "女", hr: 74, rr: 17 },
    "402-A": { name: "許○昌", title: "許伯伯", age: 90, sex: "男", hr: 113, rr: 22 },
    "402-B": { name: "蔡○珠", title: "蔡奶奶", age: 92, sex: "女", hr: 69, rr: 16 },
    "403-A": { name: "謝○輝", title: "謝伯伯", age: 85, sex: "男", hr: 75, rr: 18 },
    "403-B": { name: "楊○雲", title: "楊奶奶", age: 88, sex: "女", hr: 83, rr: 19 },
    "404-A": { name: "賴○德", title: "賴伯伯", age: 87, sex: "男", hr: 66, rr: 15 },
  },
};
