import { FLOORS } from "./config.js";
import { Sim } from "./sim.js";
import { Hospital } from "./hospital.js";
import { Elevator } from "./elevator.js";
import { LiftScheduler } from "./lift.js";
import { Traffic } from "./traffic.js";
import { VitalCart, MedShelf } from "./furniture.js";
import { VitalSensor } from "./vitals.js";
import { Person, BedPatient } from "./people.js";
import { Fleet } from "./fleet.js";
import { setGeometry } from "./builders.js";

// stand-ins for a world nobody looks at (the strategy lab runs one in the background)
const NO_SCENE = { add() {}, remove() {} };
const NO_LABELS = { add: () => null, remove() {}, bubble() {}, clearBubbles() {} };

// --- everything that takes part in the simulation; the page adds camera, labels and panels ---
export function buildWorld({ settings, scene = NO_SCENE, labels = NO_LABELS, headless = false }) {
  const sim = new Sim();
  setGeometry(!headless);
  const hospital = new Hospital();
  const elevator = new Elevator();
  setGeometry(true);
  scene.add(hospital.root, elevator.group);
  const traffic = new Traffic({ sim, settings });
  for (const [id, name] of hospital.zones) traffic.define(id, name);
  const lift = new LiftScheduler({ elevator, sim, settings });

  // furniture: one vital-sign cart per care floor, two medicine cabinets in the pharmacy
  const carts = {};
  const sensors = {};
  for (const [floor, home] of Object.entries(hospital.carts)) {
    const fid = FLOORS[floor].id;
    carts[floor] = new VitalCart({ id: `VS-${fid}`, name: `生理量測車 VS-${fid}`, home });
    sensors[floor] = new VitalSensor({ cart: carts[floor], sim });
    scene.add(carts[floor].group, sensors[floor].group);
  }
  const meds = hospital.medHomes.map((m) => new MedShelf({ id: m.id, name: `藥品櫃 ${m.id}`, home: m.home, loadSpot: m.load }));
  for (const m of meds) scene.add(m.group);

  const S = hospital.staffSpots;
  const A = hospital.activitySeats;
  const staff = {
    pharmacist: new Person({ id: "pharmacist", role: "pharmacist", name: "藥師 志明", ...S.pharmacist, pose: "type" }),
    reception: new Person({ id: "reception", role: "reception", name: "服務台 小美", ...S.reception, skin: 1 }),
    doctor: new Person({ id: "doctor", role: "doctor", name: "醫務室 黃醫師", ...S.doctor, pose: "check", skin: 1 }),
    visitor1: new Person({ id: "visitor1", role: "visitor", name: "", ...hospital.seats[0], sitting: true, skin: 1 }),
    visitor2: new Person({ id: "visitor2", role: "visitor2", name: "", ...hospital.seats[1], sitting: true, skin: 2 }),
    "2F-carer": new Person({ id: "2F-carer", role: "carer", name: "照服員 阿芳", ...S["2F-staffA"], pose: "type", skin: 2 }),
    wanderer: new Person({ id: "wanderer", role: "resident", name: "住民 陳伯伯", ...A[0], sitting: true }),
    "2F-resident2": new Person({ id: "2F-resident2", role: "resident2", name: "", ...A[1], sitting: true, skin: 1 }),
    "2F-resident3": new Person({ id: "2F-resident3", role: "resident", name: "", ...A[2], sitting: true, skin: 2 }),
    "3F-nurseA": new Person({ id: "3F-nurseA", role: "nurse", name: "護理師 雅婷", ...S["3F-staffA"], pose: "type" }),
    "3F-nurseB": new Person({ id: "3F-nurseB", role: "nurseB", name: "護理師 佩珊", ...S["3F-staffB"], pose: "type", skin: 2 }),
    "4F-nurseA": new Person({ id: "4F-nurseA", role: "nurse", name: "護理師 怡君", ...S["4F-staffA"], pose: "type", skin: 1 }),
    "4F-nurseB": new Person({ id: "4F-nurseB", role: "nurseB", name: "護理師 淑芬", ...S["4F-staffB"], pose: "type" }),
  };
  const staffList = Object.values(staff);
  for (const p of staffList) scene.add(p.group);

  const patients = new Map();
  let skin = 0;
  for (const bed of hospital.beds.values()) {
    if (!bed.patient) continue;
    const p = new BedPatient(bed, skin++);
    patients.set(bed.id, p);
    scene.add(p.group);
  }

  const world = {
    sim,
    settings,
    scene,
    hospital,
    elevator,
    lift,
    traffic,
    carts,
    sensors,
    sensorList: Object.values(sensors),
    meds,
    staff,
    staffList,
    patients,
    labels,
    headless,
  };
  world.fleet = new Fleet(world);
  return world;
}

// one fixed simulation step (seconds); the same sequence of steps replays the same day
export function stepWorld(w, h) {
  w.sim.time += h;
  w.elevator.update(h);
  const robots = w.fleet.robots;
  for (const r of robots) r.update(h);
  for (const p of w.staffList) p.update(h, robots);
  for (const s of w.sensorList) s.updateSim(h);
  w.sim.process();
}
