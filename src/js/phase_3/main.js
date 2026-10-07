import * as THREE from "three";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";
import { FLOORS } from "./config.js";
import { damp } from "./sim.js";
import { settings } from "./settings.js";
import { Labels } from "./labels.js";
import { CameraDirector } from "./camera.js";
import { Dashboard } from "./dashboard.js";
import { buildWorld, stepWorld } from "./world.js";
import { FloorPlan } from "./plan.js";
import { LabView } from "./labView.js";
import { Tour } from "./tour.js";

document.documentElement.lang = "zh-Hant";
// canvas textures (signage, floor decals) need the local fonts before they are drawn
const fontFaces = ["700 20px 'Barlow Semi Condensed'", "600 20px 'Barlow Semi Condensed'", "400 12px 'JetBrains Mono'"];
await Promise.race([Promise.all(fontFaces.map((f) => document.fonts.load(f))).catch(() => {}), new Promise((r) => setTimeout(r, 1500))]);

const stage = document.getElementById("stage");
const pane3d = document.getElementById("pane-3d");
const canvas = document.getElementById("scene");
const isDark = () => {
  const t = document.documentElement.dataset.theme;
  return t ? t === "dark" : window.matchMedia("(prefers-color-scheme: dark)").matches;
};

// --- renderer (the simulation keeps running even without WebGL) ---
let renderer = null;
try {
  renderer = new THREE.WebGLRenderer({ canvas, antialias: (window.devicePixelRatio || 1) < 2, alpha: true, powerPreference: "high-performance" });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, window.innerWidth < 700 ? 1.5 : 2));
  renderer.setClearColor(0x000000, 0);
  renderer.toneMapping = THREE.NeutralToneMapping;
  renderer.toneMappingExposure = 1.0;
} catch (err) {
  console.warn("WebGL unavailable", err);
  document.getElementById("fallback").hidden = false;
}

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(40, 1.6, 0.1, 250);
if (renderer) {
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  pmrem.dispose();
}
const hemi = new THREE.HemisphereLight(0xffffff, 0xc5d3cf, 0.85);
const sun = new THREE.DirectionalLight(0xffffff, 1.5);
sun.position.set(8, 22, 14);
scene.add(hemi, sun);

// soft ground disc that fades into the stage background
const groundTex = (() => {
  const c = document.createElement("canvas");
  c.width = c.height = 256;
  const g = c.getContext("2d");
  const grad = g.createRadialGradient(128, 128, 20, 128, 128, 128);
  grad.addColorStop(0, "rgba(255,255,255,1)");
  grad.addColorStop(0.6, "rgba(255,255,255,0.75)");
  grad.addColorStop(1, "rgba(255,255,255,0)");
  g.fillStyle = grad;
  g.fillRect(0, 0, 256, 256);
  return new THREE.CanvasTexture(c);
})();
const groundMat = new THREE.MeshBasicMaterial({ map: groundTex, transparent: true, depthWrite: false });
const ground = new THREE.Mesh(new THREE.PlaneGeometry(64, 64).rotateX(-Math.PI / 2), groundMat);
ground.position.set(-1, -0.28, 0);
scene.add(ground);

function applyTheme() {
  const dark = isDark();
  groundMat.color.set(getComputedStyle(document.documentElement).getPropertyValue("--ground").trim() || "#dfe9e6");
  hemi.intensity = dark ? 0.6 : 0.85;
  sun.intensity = dark ? 1.15 : 1.5;
  scene.environmentIntensity = dark ? 0.45 : 0.6;
}
applyTheme();
window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", applyTheme);
new MutationObserver(applyTheme).observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });

// --- world ---
const labels = new Labels(document.getElementById("labels"), camera);
const world = buildWorld({ settings, scene, labels });
const { sim, hospital, elevator, carts, sensors, meds, staffList, patients, fleet } = world;
const director = new CameraDirector(camera, canvas, { fleet, elevator });
world.camera = director;
world.renderer = renderer;
world.plan = new FloorPlan(world, document.getElementById("plan-body"), { onPick: (r) => director.follow(r) });
const dashboard = new Dashboard(world);
world.dashboard = dashboard;
world.lab = new LabView(world);
world.tour = new Tour(world);

// --- sizing ---
let viewW = 1;
let viewH = 1;
function resize() {
  const r = pane3d.getBoundingClientRect();
  if (r.width < 2 || r.height < 2) return;
  viewW = Math.max(1, r.width);
  viewH = Math.max(1, r.height);
  camera.aspect = viewW / viewH;
  camera.updateProjectionMatrix();
  if (renderer) renderer.setSize(viewW, viewH, false);
}
new ResizeObserver(resize).observe(pane3d);
resize();

let stageVisible = true;
new IntersectionObserver((entries) => (stageVisible = entries[0].isIntersecting)).observe(stage);

// --- per-frame helpers ---
const fades = FLOORS.map(() => 1);
const fadeOf = (i) => fades[i] ?? 1;
const furniture = [...Object.values(carts), ...meds];

// LiDAR world for the robot being inspected: walls, parked furniture, closed landing doors
function lidarSegments(robot) {
  if (robot.inElevator) return elevator.cabWalls(elevator.floor);
  const segs = hospital.floors[robot.floor].walls.slice();
  for (const s of furniture) if (!s.robot && s.floor === robot.floor) segs.push(...s.segments());
  if (elevator.doors[robot.floor].open < 0.5) segs.push([-9.2, -0.62, -9.2, 0.62]);
  return segs;
}

function updateFades(realDt) {
  const targets = director.floorFadeTargets();
  for (let i = 0; i < fades.length; i++) {
    fades[i] = damp(fades[i], targets[i], 5, realDt);
    if (Math.abs(fades[i] - targets[i]) < 0.01) fades[i] = targets[i];
    hospital.setFloorFade(i, Math.round(fades[i] * 50) / 50);
  }
  const q = (i) => Math.round(fadeOf(i) * 50) / 50;
  for (const p of staffList) p.setFade(q(p.floor));
  for (const p of patients.values()) p.setFade(q(p.floor));
  for (const s of furniture) s.setFade(s.robot ? (s.robot.inElevator ? 1 : q(s.robot.floor)) : q(s.floor));
  for (const r of fleet.robots) r.setFade(r.inElevator ? 1 : q(r.floor));
}

const STEP = 0.05;
const stepSim = (h) => stepWorld(world, h);

let last = performance.now();
function frame(now) {
  const realDt = Math.min(0.1, (now - last) / 1000);
  last = now;
  const simDt = sim.scaled(realDt);
  if (simDt > 0) {
    const n = Math.max(1, Math.ceil(simDt / STEP));
    for (let i = 0; i < n; i++) stepSim(simDt / n);
  }
  for (const p of patients.values()) p.update(realDt);
  for (const s of Object.values(sensors)) s.updateReal(realDt);
  for (const r of fleet.robots) r.updateSensors(realDt, lidarSegments);
  const show3d = world.view !== "plan";
  director.update(realDt);
  updateFades(realDt);
  if (show3d) labels.update(viewW, viewH, fadeOf, director.occludeBelow);
  dashboard.update(realDt);
  world.tour.update();
  if (stageVisible && !world.renderPaused) world.plan.update(realDt);
  if (renderer && stageVisible && show3d && !world.renderPaused) renderer.render(scene, camera);
  requestAnimationFrame(frame);
}

fleet.start();
requestAnimationFrame(frame);

// handy for poking at the scene from the console, e.g. hospitalDemo.advance(120)
world.advance = async (seconds) => {
  const end = sim.time + seconds;
  world.renderPaused = true;
  while (sim.time < end) {
    for (let i = 0; i < 10 && sim.time < end; i++) stepSim(STEP);
    await new Promise((r) => setTimeout(r, 0));
  }
  world.renderPaused = false;
};
window.hospitalDemo = world;
