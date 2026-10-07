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

export class Token {
  constructor() {
    this.cancelled = false;
  }
  cancel() {
    this.cancelled = true;
  }
  check() {
    if (this.cancelled) throw new CancelError();
  }
}

// --- simulation clock + awaitable waits driven by sim time ---
export class Sim {
  constructor() {
    this.time = 0; // sim seconds since page load
    this.clockOffset = START_CLOCK; // wall-clock seconds shown in the UI = time + offset
    this.speed = DEFAULT_SPEED;
    this.paused = false;
    this.waiters = [];
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

export function emit(type, detail = {}) {
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
