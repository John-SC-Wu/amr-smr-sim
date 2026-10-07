import { START_CLOCK, DEFAULT_SPEED } from "./config.js";

// --- cancellation for scripted tasks (scenario jumps abort running scripts) ---
export class CancelError extends Error {
  constructor() {
    super("cancelled");
    this.name = "CancelError";
  }
}

export function ignoreCancel(err) {
  if (!(err instanceof CancelError)) console.error(err);
}

// a child token is cancelled with its parent (fleet reset) or on its own (one task aborted)
export class Token {
  constructor(parent = null) {
    this.parent = parent;
    this.own = false;
  }
  get cancelled() {
    return this.own || (this.parent !== null && this.parent.cancelled);
  }
  cancel() {
    this.own = true;
  }
  check() {
    if (this.cancelled) throw new CancelError();
  }
}

// small seeded PRNG (mulberry32): the same seed replays the same day
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hashKey(seed, parts) {
  let h = (2166136261 ^ seed) >>> 0;
  const text = parts.join("|");
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h;
}

// --- simulation clock + awaitable waits driven by sim time ---
export class Sim {
  constructor() {
    this.time = 0; // sim seconds since page load
    this.clockOffset = START_CLOCK; // wall-clock seconds shown in the UI = time + offset
    this.speed = DEFAULT_SPEED;
    this.paused = false;
    this.waiters = [];
    this.reseed(1);
  }

  reseed(seed) {
    this.seed = seed;
    this.rand = mulberry32(seed);
    this.streams = new Map();
  }

  // draws tied to what they decide (not to the order things happen in): two runs of the same
  // scenario see the same day even when their robots are dispatched differently
  keyed(...parts) {
    return mulberry32(hashKey(this.seed, parts))();
  }

  next(stream) {
    let r = this.streams.get(stream);
    if (!r) this.streams.set(stream, (r = mulberry32(hashKey(this.seed, [stream]))));
    return r();
  }

  get clock() {
    return this.time + this.clockOffset;
  }

  // jump the displayed clock forward (idle time between scheduled tasks)
  skipClockTo(hh, mm) {
    const target = hh * 3600 + mm * 60;
    if (target > this.clock) this.clockOffset += target - this.clock;
  }

  setClock(seconds) {
    this.clockOffset = seconds - this.time;
  }

  scaled(realDt) {
    return this.paused ? 0 : Math.min(realDt, 0.1) * this.speed;
  }

  wait(seconds, token) {
    return this.until(null, token, this.time + seconds);
  }

  until(predicate, token, deadline = Infinity) {
    return new Promise((resolve, reject) => {
      this.waiters.push({ predicate, deadline, token, resolve, reject });
    });
  }

  process() {
    if (this.waiters.length === 0) return;
    const pending = [];
    for (const w of this.waiters) {
      if (w.token && w.token.cancelled) {
        w.reject(new CancelError());
      } else if (this.time >= w.deadline || (w.predicate && w.predicate())) {
        w.resolve();
      } else {
        pending.push(w);
      }
    }
    this.waiters = pending;
  }
}

export function formatClock(seconds, withSeconds = true) {
  const s = Math.floor(seconds) % 86400;
  const hh = String(Math.floor(s / 3600)).padStart(2, "0");
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, "0");
  const ss = String(s % 60).padStart(2, "0");
  return withSeconds ? `${hh}:${mm}:${ss}` : `${hh}:${mm}`;
}

// --- tiny event bus shared by the scene and the dashboard ---
export const bus = new EventTarget();

let muted = false;
// batch experiments run a second, invisible world; its events must not reach the page
export function muteEvents(on) {
  muted = on;
}

export function emit(type, detail = {}) {
  if (muted) return;
  bus.dispatchEvent(new CustomEvent(type, { detail }));
}

export function on(type, handler) {
  bus.addEventListener(type, (e) => handler(e.detail));
}

// --- small math helpers for the floor plane (x, z); yaw = rotation.y ---
export function fwd(yaw) {
  return { x: Math.cos(yaw), z: -Math.sin(yaw) };
}

export function yawTo(dx, dz) {
  return Math.atan2(-dz, dx);
}

export function wrapAngle(a) {
  while (a > Math.PI) a -= 2 * Math.PI;
  while (a < -Math.PI) a += 2 * Math.PI;
  return a;
}

export function approach(value, target, maxDelta) {
  if (value < target) return Math.min(value + maxDelta, target);
  return Math.max(value - maxDelta, target);
}

export function damp(current, target, lambda, dt) {
  return current + (target - current) * (1 - Math.exp(-lambda * dt));
}
