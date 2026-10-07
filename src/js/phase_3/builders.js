import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { RoundedBoxGeometry } from "three/addons/geometries/RoundedBoxGeometry.js";

// --- merge static geometry per material key: one draw call per material per floor ---
export class Batcher {
  constructor() {
    this.parts = new Map();
  }

  add(key, geometry, matrix) {
    let g = geometry.index ? geometry.toNonIndexed() : geometry.clone();
    if (!g.attributes.uv) {
      g.setAttribute("uv", new THREE.Float32BufferAttribute(new Float32Array(g.attributes.position.count * 2), 2));
    }
    if (!g.attributes.normal) g.computeVertexNormals();
    for (const name of Object.keys(g.attributes)) {
      if (name !== "position" && name !== "normal" && name !== "uv") g.deleteAttribute(name);
    }
    if (matrix) g.applyMatrix4(matrix);
    if (!this.parts.has(key)) this.parts.set(key, []);
    this.parts.get(key).push(g);
  }

  build(materials) {
    const group = new THREE.Group();
    for (const [key, list] of this.parts) {
      const merged = mergeGeometries(list, false);
      list.forEach((g) => g.dispose());
      const mesh = new THREE.Mesh(merged, materials[key]);
      mesh.name = key;
      mesh.matrixAutoUpdate = false;
      group.add(mesh);
    }
    this.parts.clear();
    return group;
  }
}

const tmpM = new THREE.Matrix4();
const tmpQ = new THREE.Quaternion();
const tmpS = new THREE.Vector3();
const tmpP = new THREE.Vector3();
const tmpE = new THREE.Euler();

export function place(x, y, z, rotY = 0, sx = 1, sy = 1, sz = 1, rotX = 0, rotZ = 0) {
  tmpE.set(rotX, rotY, rotZ);
  tmpQ.setFromEuler(tmpE);
  tmpP.set(x, y, z);
  tmpS.set(sx, sy, sz);
  return tmpM.clone().compose(tmpP, tmpQ, tmpS);
}

const geoCache = new Map();
function cached(key, make) {
  if (!geoCache.has(key)) geoCache.set(key, make());
  return geoCache.get(key);
}

export const geo = {
  box: () => cached("box", () => new THREE.BoxGeometry(1, 1, 1)),
  rbox: (r = 0.08) => cached(`rbox${r}`, () => new RoundedBoxGeometry(1, 1, 1, 1, r)),
  cyl: (seg = 16) => cached(`cyl${seg}`, () => new THREE.CylinderGeometry(0.5, 0.5, 1, seg)),
  cone: (seg = 16) => cached(`cone${seg}`, () => new THREE.CylinderGeometry(0.32, 0.5, 1, seg)),
  sphere: (seg = 14) => cached(`sph${seg}`, () => new THREE.SphereGeometry(0.5, seg, Math.round(seg * 0.7))),
  plane: () => cached("plane", () => new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2)),
};

// box from min/max extents
export function addBox(batch, key, x1, x2, y1, y2, z1, z2) {
  batch.add(key, geo.box(), place((x1 + x2) / 2, (y1 + y2) / 2, (z1 + z2) / 2, 0, x2 - x1, y2 - y1, z2 - z1));
}

// rounded box centered at x,z standing on y0, rotated around y
export function addRBox(batch, key, x, y0, z, w, h, d, rotY = 0, r = 0.08) {
  batch.add(key, geo.rbox(r), place(x, y0 + h / 2, z, rotY, w, h, d));
}

// --- canvas textures ---
export const CANVAS_FONT = "'Barlow Semi Condensed', 'PingFang TC', 'Microsoft JhengHei', 'Noto Sans TC', 'Noto Sans CJK TC', sans-serif";

export function contactShadowTexture() {
  const c = document.createElement("canvas");
  c.width = c.height = 128;
  const g = c.getContext("2d");
  const grad = g.createRadialGradient(64, 64, 8, 64, 64, 64);
  grad.addColorStop(0, "rgba(0,0,0,0.55)");
  grad.addColorStop(0.55, "rgba(0,0,0,0.22)");
  grad.addColorStop(1, "rgba(0,0,0,0)");
  g.fillStyle = grad;
  g.fillRect(0, 0, 128, 128);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export function textTexture(text, { w = 256, h = 128, color = "#1d2b29", bg = null, font = `700 72px ${CANVAS_FONT}`, align = "center" } = {}) {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const g = c.getContext("2d");
  if (bg) {
    g.fillStyle = bg;
    g.fillRect(0, 0, w, h);
  }
  g.fillStyle = color;
  g.font = font;
  g.textAlign = align;
  g.textBaseline = "middle";
  g.fillText(text, align === "center" ? w / 2 : 12, h / 2 + 4);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

let shadowTex = null;
export function shadowMaterial(opacity = 0.32) {
  if (!shadowTex) shadowTex = contactShadowTexture();
  return new THREE.MeshBasicMaterial({
    map: shadowTex,
    color: 0x0b1a17,
    transparent: true,
    opacity,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -2,
  });
}

// --- opacity fading for cut-away floors ---
export function registerFade(material) {
  material.userData.baseOpacity = material.opacity;
  material.userData.baseTransparent = material.transparent;
  material.userData.baseDepthWrite = material.depthWrite;
  return material;
}

export function applyFade(materials, alpha) {
  for (const m of materials) {
    if (m.userData.baseOpacity === undefined) registerFade(m);
    const base = m.userData.baseOpacity;
    const wantTransparent = m.userData.baseTransparent || alpha < 0.999;
    if (m.transparent !== wantTransparent) {
      m.transparent = wantTransparent;
      m.needsUpdate = true;
    }
    m.opacity = base * alpha;
    m.depthWrite = alpha > 0.6 ? m.userData.baseDepthWrite : false;
  }
}

export function std(color, opts = {}) {
  return new THREE.MeshStandardMaterial({ color, roughness: 0.82, metalness: 0, ...opts });
}
