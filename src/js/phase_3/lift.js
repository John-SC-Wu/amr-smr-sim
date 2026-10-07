import { FLOORS, ELEVATOR, LANES } from "./config.js";
import { emit } from "./sim.js";

// waiting spots in each elevator lobby, along the back wall so both corridor lanes stay free
export const LIFT_SPOTS = [
  [-7.75, -0.84],
  [-5.65, -0.84],
  [-4.85, -0.84],
  [-4.05, -0.84],
];
const STARVE_SECONDS = 120;

// --- elevator system integration: one robot per ride, served from a request queue ---
export class LiftScheduler {
  constructor({ elevator, sim, settings }) {
    this.el = elevator;
    this.sim = sim;
    this.settings = settings;
    this.tickets = [];
    this.current = null;
    this.seq = 0;
    this.version = 0;
    this.stats = { rides: 0, waitSum: 0 };
  }

  request(robot, from, to) {
    const t = {
      id: ++this.seq,
      robot,
      from,
      to,
      t0: this.sim.time,
      readyAt: null,
      calledAt: null,
      spot: this.#spotFor(robot, from),
      ready: false,
      called: false,
      boarded: false,
      arrived: false,
      done: false,
      cancelled: false,
    };
    this.tickets.push(t);
    this.bump();
    emit("log", {
      tag: "lift",
      robot,
      html: `電梯系統串接：登記 <b>${FLOORS[from].id} → ${FLOORS[to].id}</b>，等候點 #${t.spot + 1}`,
    });
    return t;
  }

  spotLoc(floor, i) {
    const [x, z] = LIFT_SPOTS[i];
    return { id: `${FLOORS[floor].id}-lift-q${i + 1}`, floor, name: `${FLOORS[floor].id} 電梯等候點 ${i + 1}`, x, z, yaw: Math.PI, via: [], zone: null };
  }

  // from a waiting spot to the landing in front of the doors (stays clear of the other spots)
  boardingPath(i) {
    const [x] = LIFT_SPOTS[i];
    const landing = [ELEVATOR.landingX, 0];
    if (i === 0) return [landing];
    return [[x - 0.45, LANES.west], [-8.0, LANES.west], landing];
  }

  #spotFor(robot, floor) {
    const used = new Set(this.tickets.filter((t) => t.from === floor && !t.boarded && !t.cancelled).map((t) => t.spot));
    const free = LIFT_SPOTS.map((_, i) => i).filter((i) => !used.has(i));
    if (!free.length) return LIFT_SPOTS.length - 1;
    // a spot west of the robot keeps it on the westbound lane
    const west = free.filter((i) => robot.floor !== floor || LIFT_SPOTS[i][0] <= robot.x + 0.05);
    return (west.length ? west : free)[0];
  }

  markReady(t) {
    t.ready = true;
    t.readyAt = this.sim.time;
    this.bump();
  }

  cancel(t) {
    if (!t || t.cancelled || t.boarded) return;
    t.cancelled = true;
    this.tickets = this.tickets.filter((x) => x !== t);
    this.bump();
  }

  bump() {
    this.version++;
    for (let i = 0; i < this.el.calls.length; i++) this.el.calls[i] = this.tickets.some((t) => !t.boarded && !t.cancelled && t.from === i);
    emit("lift");
  }

  // service order under the current policy (for the queue display and the ETA estimate)
  order() {
    const waiting = this.tickets.filter((t) => !t.cancelled && !t.boarded && t !== this.current);
    const ready = waiting.filter((t) => t.ready);
    const rest = waiting.filter((t) => !t.ready).sort((a, b) => a.t0 - b.t0);
    const sorted = [];
    let pool = ready.slice();
    while (pool.length) {
      const next = this.#pick(pool);
      sorted.push(next);
      pool = pool.filter((t) => t !== next);
    }
    return [...(this.current ? [this.current] : []), ...sorted, ...rest];
  }

  queueLength() {
    return this.tickets.filter((t) => !t.cancelled && !t.done).length;
  }

  position(t) {
    return this.order().indexOf(t) + 1;
  }

  #pick(ready) {
    const now = this.sim.time;
    const starving = ready.filter((t) => now - t.readyAt > STARVE_SECONDS);
    const pool = starving.length ? starving : ready;
    const pol = this.settings.elevatorPolicy;
    const cab = this.el.floorFloat;
    let best = null;
    for (const t of pool) {
      if (!best) {
        best = t;
        continue;
      }
      if (!starving.length && pol === "priority" && t.robot.priority !== best.robot.priority) {
        if (t.robot.priority < best.robot.priority) best = t;
        continue;
      }
      if (!starving.length && pol === "nearest") {
        const d = Math.abs(t.from - cab) - Math.abs(best.from - cab);
        if (Math.abs(d) > 0.01) {
          if (d < 0) best = t;
          continue;
        }
      }
      if (t.readyAt < best.readyAt) best = t;
    }
    return best;
  }

  why(t) {
    const pol = this.settings.elevatorPolicy;
    if (this.sim.time - t.readyAt > STARVE_SECONDS) return "等候逾 2 分鐘優先";
    return { fifo: "先到先服務", priority: `任務優先級 P${t.robot.priority}`, nearest: "離車廂最近" }[pol];
  }

  async run(token) {
    const { sim, el } = this;
    for (;;) {
      const ready = this.tickets.filter((t) => t.ready && !t.cancelled);
      if (!ready.length) {
        if (el.anyDoorOpen()) {
          await el.closeDoors(el.floor, sim, token);
          continue;
        }
        // pre-position the cab while the next robot is still driving to the lobby
        const pending = this.tickets.find((t) => !t.cancelled);
        if (pending && el.floor !== pending.from) {
          await el.moveTo(pending.from, sim, token);
          continue;
        }
        const v = this.version;
        await sim.until(() => this.version !== v, token);
        continue;
      }
      const t = this.#pick(ready);
      this.current = t;
      if (el.floor !== t.from || el.moving) {
        await el.closeDoors(el.floor, sim, token);
        await el.moveTo(t.from, sim, token);
      }
      await el.openDoors(t.from, sim, token);
      if (t.cancelled) {
        this.current = null;
        continue;
      }
      t.called = true;
      t.calledAt = sim.time;
      const others = ready.length - 1;
      emit("log", {
        tag: "lift",
        robot: t.robot,
        html: `電梯抵達 <b>${FLOORS[t.from].id}</b>，請 ${t.robot.id} 進入${others ? `（${this.why(t)}，另有 ${others} 台排隊）` : ""}`,
      });
      this.bump();
      await sim.until(() => t.boarded || t.cancelled, token);
      if (t.cancelled) {
        this.current = null;
        continue;
      }
      this.stats.rides++;
      this.stats.waitSum += t.calledAt - t.readyAt;
      el.occupied = true;
      this.bump();
      await el.closeDoors(t.from, sim, token);
      await el.moveTo(t.to, sim, token);
      await el.openDoors(t.to, sim, token);
      t.arrived = true;
      await sim.until(() => t.done, token);
      el.occupied = false;
      this.tickets = this.tickets.filter((x) => x !== t);
      this.current = null;
      this.bump();
      emit("ride", { robot: t.robot, from: t.from, to: t.to });
    }
  }

  reset() {
    this.tickets = [];
    this.current = null;
    this.version++;
    this.stats = { rides: 0, waitSum: 0 };
  }
}
