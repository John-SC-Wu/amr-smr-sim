import { emit } from "./sim.js";

// --- zone reservation: rooms, the pharmacy and pickup points take one robot at a time ---
// A robot asks for a zone at a gate on its corridor lane, while holding no other zone
// (no hold-and-wait, so zone waits cannot deadlock). Parked robots (on a charger) release
// the zone they stand in and ask again before they drive off.
export class Traffic {
  constructor({ sim, settings }) {
    this.sim = sim;
    this.settings = settings;
    this.zones = new Map();
    this.names = new Map();
    this.waitsServed = 0;
  }

  define(id, name) {
    this.names.set(id, name);
  }

  name(id) {
    return this.names.get(id) || id;
  }

  #zone(id) {
    let z = this.zones.get(id);
    if (!z) {
      z = { id, holder: null, since: 0, queue: [] };
      this.zones.set(id, z);
    }
    return z;
  }

  holder(id) {
    return this.zones.get(id)?.holder || null;
  }

  queueOf(id) {
    return this.zones.get(id)?.queue || [];
  }

  // non-blocking: registers the robot in the zone's queue; true once it holds the zone
  tryAcquire(id, robot) {
    const z = this.#zone(id);
    if (z.holder === robot) return true;
    let w = z.queue.find((q) => q.robot === robot);
    if (!w) {
      w = { robot, t: this.sim.time };
      z.queue.push(w);
    }
    if (z.holder) return false;
    if (this.#next(z) !== w) return false;
    z.queue.splice(z.queue.indexOf(w), 1);
    z.holder = robot;
    z.since = this.sim.time;
    if (this.sim.time - w.t > 2) {
      this.waitsServed++;
      emit("log", { tag: "traffic", robot, html: `取得 <b>${this.name(id)}</b> 通行權（等候 ${Math.round(this.sim.time - w.t)} s）` });
    }
    return true;
  }

  // would the robot get the zone right now? (does not join the queue)
  canTake(id, robot) {
    const z = this.zones.get(id);
    if (!z) return true;
    if (z.holder && z.holder !== robot) return false;
    const next = this.#next(z);
    return !next || next.robot === robot;
  }

  // the holder steps back for a robot already waiting at the door; it is served right after
  handOver(id, from, to) {
    const z = this.zones.get(id);
    if (!z || z.holder !== from) return false;
    const i = z.queue.findIndex((q) => q.robot === to);
    if (i >= 0) z.queue.splice(i, 1);
    const first = z.queue.reduce((m, q) => Math.min(m, q.t), this.sim.time);
    z.queue.push({ robot: from, t: first - 1 });
    z.holder = to;
    z.since = this.sim.time;
    return true;
  }

  // blocking variant for robots standing still (e.g. parked on a charger inside the zone)
  acquire(id, robot, token) {
    return this.sim.until(() => this.tryAcquire(id, robot), token);
  }

  #next(z) {
    if (!z.queue.length) return null;
    const byPriority = this.settings.rightOfWay === "priority";
    let best = z.queue[0];
    for (const w of z.queue) {
      if (byPriority && w.robot.priority !== best.robot.priority) {
        if (w.robot.priority < best.robot.priority) best = w;
      } else if (w.t < best.t) best = w;
    }
    return best;
  }

  release(id, robot) {
    const z = this.zones.get(id);
    if (z && z.holder === robot) z.holder = null;
  }

  // stop waiting anywhere (route aborted / robot reassigned)
  cancelWaits(robot) {
    for (const z of this.zones.values()) {
      const i = z.queue.findIndex((q) => q.robot === robot);
      if (i >= 0) z.queue.splice(i, 1);
    }
  }

  heldBy(robot) {
    const out = [];
    for (const z of this.zones.values()) if (z.holder === robot) out.push(z.id);
    return out;
  }

  reset() {
    this.zones.clear();
    this.waitsServed = 0;
  }
}
