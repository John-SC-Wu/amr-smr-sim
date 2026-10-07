import * as THREE from "three";
import { RoundedBoxGeometry } from "three/addons/geometries/RoundedBoxGeometry.js";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { std, shadowMaterial, applyFade, place as placeMatrix } from "./builders.js";
import { FLOOR_GAP, CORRIDOR } from "./config.js";
import { yawTo, wrapAngle, fwd } from "./sim.js";

// shared geometry (people face +x, right hand side is +z)
const G = {
  thigh: new THREE.CapsuleGeometry(0.066, 0.3, 4, 10).translate(0, -0.215, 0),
  shin: new THREE.CapsuleGeometry(0.055, 0.31, 4, 10).translate(0, -0.205, 0),
  shoe: new THREE.BoxGeometry(0.21, 0.07, 0.1).translate(0.04, -0.4, 0),
  arm: new THREE.CapsuleGeometry(0.047, 0.48, 4, 8).translate(0, -0.28, 0),
  hand: new THREE.SphereGeometry(0.045, 10, 8).translate(0, -0.56, 0),
  torso: new THREE.CapsuleGeometry(0.15, 0.34, 4, 14),
  coat: new THREE.CylinderGeometry(0.168, 0.25, 0.84, 18),
  neck: new THREE.CylinderGeometry(0.045, 0.05, 0.1, 10),
  head: new THREE.SphereGeometry(0.105, 18, 14),
  hair: new THREE.SphereGeometry(0.113, 18, 10, 0, Math.PI * 2, 0, Math.PI * 0.56),
  bun: new THREE.SphereGeometry(0.055, 10, 8),
  tablet: new THREE.BoxGeometry(0.018, 0.2, 0.15),
  shadow: new THREE.PlaneGeometry(0.62, 0.62).rotateX(-Math.PI / 2),
  blanket: new RoundedBoxGeometry(0.7, 0.16, 1.45, 3, 0.07).translate(0, 0.08, 0),
  limb: new THREE.CapsuleGeometry(0.045, 0.42, 4, 8).rotateX(Math.PI / 2),
};

const SKIN = [0xf0c8a4, 0xe2b089, 0xd39f78];

// bake a part's transform + colour so several parts share one vertex-coloured draw call
function part(geometry, color, matrix = null) {
  const g = geometry.index ? geometry.toNonIndexed() : geometry.clone();
  if (matrix) g.applyMatrix4(matrix);
  const c = new THREE.Color(color);
  const n = g.attributes.position.count;
  const cols = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) cols.set([c.r, c.g, c.b], i * 3);
  g.setAttribute("color", new THREE.BufferAttribute(cols, 3));
  return g;
}

export const ROLES = {
  nurse: { label: "護理師", top: 0x8cc9dc, bottom: 0x8cc9dc, coat: null, hair: 0x2a2220, bun: true, tablet: true },
  nurseB: { label: "護理師", top: 0xe9a9bd, bottom: 0xe9a9bd, coat: null, hair: 0x3a2a24, bun: true },
  carer: { label: "照服員", top: 0x93c98f, bottom: 0x3f4b5a, coat: null, hair: 0x2b2421, bun: true },
  doctor: { label: "醫師", top: 0x5f83aa, bottom: 0x39434f, coat: 0xf7f9f9, hair: 0x1f1d1c, tablet: true },
  pharmacist: { label: "藥師", top: 0x6aa384, bottom: 0x44505a, coat: 0xf7f9f9, hair: 0x2b2421 },
  reception: { label: "服務台", top: 0x2f6f8f, bottom: 0x2d3a46, coat: null, hair: 0x231d1b, bun: true },
  resident: { label: "住民", top: 0xb9c6d3, bottom: 0x5b6068, coat: null, hair: 0xd8d4cc, speed: 0.45 },
  resident2: { label: "住民", top: 0xd8c3a5, bottom: 0x4f555c, coat: null, hair: 0xe2ded7, speed: 0.45 },
  visitor: { label: "家屬", top: 0xd9a441, bottom: 0x3f4b5a, coat: null, hair: 0x5b4636 },
  visitor2: { label: "家屬", top: 0x6b8f71, bottom: 0x55575d, coat: null, hair: 0x3a302a },
};

export class Person {
  constructor({ id, role, name, floor, x, z, yaw = 0, skin = 0, sitting = false, pose = "idle" }) {
    this.id = id;
    this.role = role;
    this.roleDef = ROLES[role];
    this.name = name;
    this.floor = floor;
    this.x = x;
    this.z = z;
    this.yaw = yaw;
    this.home = { x, z, yaw, sitting, pose };
    this.sitting = sitting;
    this.busy = null; // robot / task this person is attending to
    this.onAvoid = null;
    this.path = [];
    this.finalYaw = null;
    this.speed = this.roleDef.speed ?? 1.05;
    this.walking = false;
    this.phase = Math.random() * 6;
    this.idleT = Math.random() * 10;
    this.pose = pose;
    this.avoidCooldown = 0;
    this.materials = [];
    this.group = new THREE.Group();
    this.group.name = id;
    this.#build(SKIN[skin % SKIN.length]);
    this.#sync();
  }

  #build(skinColor) {
    const r = this.roleDef;
    const mat = std(0xffffff, { vertexColors: true, roughness: 0.74 });
    this.materials.push(mat);
    const mesh = (parts, parent) => {
      const m = new THREE.Mesh(mergeGeometries(parts), mat);
      parent.add(m);
      return m;
    };

    this.body = new THREE.Group();
    this.group.add(this.body);

    this.legs = [-1, 1].map((side) => {
      const hip = new THREE.Group();
      hip.position.set(0, 0.86, side * 0.085);
      this.body.add(hip);
      mesh([part(G.thigh, r.bottom)], hip);
      const knee = new THREE.Group();
      knee.position.y = -0.43;
      hip.add(knee);
      mesh([part(G.shin, r.bottom), part(G.shoe, 0xf2f4f4)], knee);
      return { hip, knee };
    });

    const torso = [part(G.torso, r.top, placeMatrix(0, 1.14, 0, 0, 0.72, 1, 1.12)), part(G.neck, skinColor, placeMatrix(0, 1.49, 0))];
    if (r.coat) torso.push(part(G.coat, r.coat, placeMatrix(0, 1.0, 0, 0, 0.82, 1, 1.12)));
    mesh(torso, this.body);

    this.arms = [-1, 1].map((side) => {
      const shoulder = new THREE.Group();
      shoulder.position.set(0, 1.37, side * 0.205);
      this.body.add(shoulder);
      const parts = [part(G.arm, r.coat || r.top), part(G.hand, skinColor)];
      if (r.tablet && side > 0) parts.push(part(G.tablet, 0x22292b, placeMatrix(0.06, -0.52, -0.02, 0, 1, 1, 1, 0, 0.2)));
      mesh(parts, shoulder);
      return shoulder;
    });

    this.head = new THREE.Group();
    this.head.position.y = 1.6;
    this.body.add(this.head);
    const head = [part(G.head, skinColor), part(G.hair, r.hair, placeMatrix(0, 0, 0, 0, 1, 1, 1, 0, 0.35))];
    if (r.bun) head.push(part(G.bun, r.hair, placeMatrix(-0.1, 0.04, 0)));
    mesh(head, this.head);

    const sh = new THREE.Mesh(G.shadow, shadowMaterial(0.28));
    sh.position.y = 0.02;
    this.materials.push(sh.material);
    this.group.add(sh);
  }

  get floorY() {
    return this.floor * FLOOR_GAP;
  }

  setFade(alpha) {
    if (this.fade === alpha) return;
    this.fade = alpha;
    applyFade(this.materials, alpha);
    this.group.visible = alpha > 0.02;
  }

  place(x, z, yaw = this.yaw) {
    this.x = x;
    this.z = z;
    this.yaw = yaw;
    this.#sync();
  }

  resetHome() {
    this.busy = null;
    this.path = [];
    this.walking = false;
    this.finalYaw = null;
    this.pose = this.home.pose;
    this.sitting = this.home.sitting;
    this.place(this.home.x, this.home.z, this.home.yaw);
  }

  // walk through floor points [[x, z], ...]; resolves on arrival
  walkTo(points, sim, token, finalYaw = null) {
    this.sitting = false;
    this.path = points.map(([x, z]) => ({ x, z }));
    this.finalYaw = finalYaw;
    this.walking = true;
    this.pose = "idle";
    return sim.until(() => !this.walking && this.finalYaw === null, token);
  }

  // stop walking where the person is (resolves a pending walkTo)
  stop() {
    this.path = [];
    this.walking = false;
    this.finalYaw = null;
  }

  turnTo(yaw, sim, token) {
    this.finalYaw = yaw;
    return sim.until(() => this.finalYaw === null, token);
  }

  update(dt, robots) {
    this.idleT += dt;
    this.avoidCooldown = Math.max(0, this.avoidCooldown - dt);
    let moving = false;
    if (this.walking && this.path.length) {
      for (const r of robots) this.#avoidRobot(r);
      const t = this.path[0];
      const dx = t.x - this.x;
      const dz = t.z - this.z;
      const d = Math.hypot(dx, dz);
      if (d < 0.04) {
        this.path.shift();
        if (!this.path.length) this.walking = false;
      } else {
        const want = yawTo(dx, dz);
        const err = wrapAngle(want - this.yaw);
        const turn = Math.sign(err) * Math.min(Math.abs(err), 5 * dt);
        this.yaw += turn;
        if (Math.abs(err) < 1.0) {
          const step = Math.min(d, this.speed * dt * (1 - Math.abs(err) / 1.4));
          this.x += (dx / d) * step;
          this.z += (dz / d) * step;
          moving = step > 0;
          this.phase += step * 7.2;
        }
      }
    } else if (this.walking) {
      this.walking = false;
    }
    if (!this.walking && this.finalYaw !== null) {
      const err = wrapAngle(this.finalYaw - this.yaw);
      if (Math.abs(err) < 0.02) {
        this.yaw = this.finalYaw;
        this.finalYaw = null;
      } else {
        this.yaw += Math.sign(err) * Math.min(Math.abs(err), 4 * dt);
      }
    }
    this.#animate(moving, dt);
    this.#sync();
  }

  // people in the corridor step aside for the robot instead of walking into it
  #avoidRobot(robot) {
    if (!robot || robot.floor !== this.floor || robot.inElevator || this.avoidCooldown > 0) return;
    if (Math.abs(this.z) > CORRIDOR.maxZ) return;
    const f = fwd(this.yaw);
    const rx = robot.x - this.x;
    const rz = robot.z - this.z;
    const along = rx * f.x + rz * f.z;
    const lateral = rx * -f.z + rz * f.x;
    if (along > 0 && along < 1.5 && Math.abs(lateral) < 0.55) {
      const side = this.z <= robot.z ? -1 : 1;
      const laneZ = THREE.MathUtils.clamp(robot.z + side * 0.78, CORRIDOR.minZ + 0.25, CORRIDOR.maxZ - 0.25);
      const dir = Math.sign(f.x) || 1;
      const pass = { x: robot.x + dir * 0.9, z: laneZ };
      const side1 = { x: this.x + dir * 0.35, z: laneZ };
      this.path.unshift(side1, pass);
      this.avoidCooldown = 3;
      if (this.onAvoid) {
        const cb = this.onAvoid;
        this.onAvoid = null;
        cb();
      }
    }
  }

  #animate(moving, dt) {
    const [L, R] = this.legs;
    const [aL, aR] = this.arms;
    const s = Math.sin(this.phase);
    if (this.sitting) {
      this.body.position.y = -0.38;
      for (const leg of this.legs) {
        leg.hip.rotation.z = 1.5;
        leg.knee.rotation.z = -1.5;
      }
      aL.rotation.set(0, 0, 0.5);
      aR.rotation.set(0, 0, 0.5);
      this.head.rotation.set(0, 0, 0.04 * Math.sin(this.idleT * 0.6));
      return;
    }
    const amp = moving ? 1 : 0;
    this.body.position.y = moving ? Math.abs(Math.cos(this.phase)) * 0.025 : 0;
    L.hip.rotation.z = s * 0.42 * amp;
    R.hip.rotation.z = -s * 0.42 * amp;
    L.knee.rotation.z = -Math.max(0, -s) * 0.55 * amp;
    R.knee.rotation.z = -Math.max(0, s) * 0.55 * amp;
    const breathe = Math.sin(this.idleT * 1.6) * 0.02;
    let la = -s * 0.32 * amp + breathe;
    let ra = s * 0.32 * amp + breathe;
    let rx = 0;
    let headTilt = 0;
    if (!moving) {
      switch (this.pose) {
        case "hand":
          la = 1.15;
          ra = 1.15;
          break;
        case "carry":
          la = 0.75;
          ra = 0.75;
          break;
        case "type":
          la = 0.95 + Math.sin(this.idleT * 9) * 0.04;
          ra = 0.95 + Math.cos(this.idleT * 8) * 0.04;
          headTilt = -0.25;
          break;
        case "check":
          la = 0.45;
          ra = 0.95;
          headTilt = -0.35;
          break;
        case "wave":
          ra = 0.2;
          rx = -2.5 + Math.sin(this.idleT * 7) * 0.28;
          break;
      }
    }
    aL.rotation.set(0, 0, la);
    aR.rotation.set(rx, 0, ra);
    this.head.rotation.set(0, 0, headTilt);
  }

  #sync() {
    this.group.position.set(this.x, this.floorY, this.z);
    this.group.rotation.y = this.yaw;
  }

  // position of the person's head for speech bubbles
  anchor(target) {
    return target.set(this.x, this.floorY + (this.sitting ? 1.35 : 1.82), this.z);
  }
}

// --- patient lying in bed, chest rises at the patient's actual respiration rate ---
export class BedPatient {
  constructor(bed, skin = 0) {
    this.bed = bed;
    this.data = bed.patient;
    this.floor = bed.floor;
    this.hr = this.data.hr;
    this.rr = this.data.rr;
    this.breath = Math.random() * 6;
    this.materials = [];
    this.group = new THREE.Group();
    this.group.position.set(bed.x, bed.floor * FLOOR_GAP, bed.z);

    const mat = std(0xffffff, { vertexColors: true, roughness: 0.82 });
    this.materials.push(mat);
    const skinC = SKIN[skin % SKIN.length];
    const gown = 0xa9c9e6;
    const hairC = this.data.age > 80 ? 0xd9d6d0 : 0x6b5d52;
    const still = new THREE.Mesh(
      mergeGeometries([
        part(G.head, skinC, placeMatrix(0, 0.73, -0.76)),
        part(G.hair, hairC, placeMatrix(0, 0.73, -0.76, 0, 1, 1, 1, -1.2)),
        part(G.torso, gown, placeMatrix(0, 0.66, -0.55, 0, 1.15, 0.55, 0.45, Math.PI / 2)),
      ]),
      mat,
    );
    this.group.add(still);

    this.chest = new THREE.Group();
    this.chest.position.set(0, 0.56, 0.16);
    this.group.add(this.chest);
    this.blanket = new THREE.Mesh(
      mergeGeometries([
        part(G.blanket, 0xf4f6f6),
        part(G.limb, gown, placeMatrix(-0.24, 0.2, -0.35)),
        part(G.limb, gown, placeMatrix(0.24, 0.2, -0.35)),
      ]),
      mat,
    );
    this.chest.add(this.blanket);
  }

  setFade(alpha) {
    if (this.fade === alpha) return;
    this.fade = alpha;
    applyFade(this.materials, alpha);
    this.group.visible = alpha > 0.02;
  }

  update(realDt) {
    this.breath += realDt * 2 * Math.PI * (this.rr / 60);
    const b = Math.sin(this.breath);
    this.blanket.scale.y = 1 + 0.09 * b;
    this.blanket.position.y = 0.004 * b;
  }

  anchor(target) {
    return target.set(this.bed.x, this.floor * FLOOR_GAP + 1.15, this.bed.z - 0.6);
  }
}
