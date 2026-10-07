import { FLOORS, PLATE, CORRIDOR, LANES } from "./config.js";
import { fwd } from "./sim.js";

// world extents drawn for every floor (the glass elevator tower sits west of the plate)
const VIEW = { x1: -11.95, x2: 9.25, z1: -5.2, z2: 5.2 };
const VW = VIEW.x2 - VIEW.x1;
const VH = VIEW.z2 - VIEW.z1;
const TOWER = { x1: -11.75, x2: -9.15, z1: -1.35, z2: 1.35 };
const CAB = { x1: -11.6, x2: -9.32, z1: -1.18, z2: 1.18 };
const TITLE = 20;
const PAD = 8;

const cssVar = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const FONT = "PingFang TC, Microsoft JhengHei, Noto Sans TC, Noto Sans CJK TC, system-ui, sans-serif";
const NUM = "'Barlow Semi Condensed', " + FONT;

function hexA(hex, a) {
  const h = hex.replace("#", "");
  const n = parseInt(h.length === 3 ? h.replace(/./g, (c) => c + c) : h, 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

function roundRect(g, x, y, w, h, r) {
  g.beginPath();
  g.roundRect(x, y, w, h, r);
}

// --- live 2D floor plan: every floor at once, zones, elevator, robots and their routes ---
export class FloorPlan {
  constructor(world, el, { onPick = () => {} } = {}) {
    this.w = world;
    this.el = el;
    this.canvas = el.querySelector("canvas");
    this.tip = el.querySelector(".plan-tip");
    this.g = this.canvas.getContext("2d");
    this.onPick = onPick;
    this.solo = null; // floor shown alone (click its title), or null for all floors
    this.cells = [];
    this.hits = [];
    this.titles = [];
    this.dirty = true;
    this.visible = false;
    this.t = 0;
    this.hover = null;
    this.static = document.createElement("canvas");
    new ResizeObserver(() => (this.dirty = true)).observe(el);
    const refresh = () => (this.dirty = true);
    window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", refresh);
    new MutationObserver(refresh).observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    this.canvas.addEventListener("pointermove", (e) => this.#pointer(e));
    this.canvas.addEventListener("pointerleave", () => this.#hideTip());
    this.canvas.addEventListener("click", (e) => this.#click(e));
  }

  // ------------------------------------------------------------ layout
  #layout() {
    const rect = this.el.getBoundingClientRect();
    const W = Math.max(1, rect.width);
    const H = Math.max(1, rect.height);
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.cssW = W;
    this.cssH = H;
    this.dpr = dpr;
    for (const c of [this.canvas, this.static]) {
      c.width = Math.round(W * dpr);
      c.height = Math.round(H * dpr);
    }
    this.canvas.style.width = `${W}px`;
    this.canvas.style.height = `${H}px`;
    const floors = this.solo !== null ? [this.solo] : [3, 2, 1, 0];
    const options = floors.length === 1 ? [[1, 1]] : [[2, 2], [1, 4], [4, 1]];
    let best = null;
    for (const [cols, rows] of options) {
      const cw = (W - PAD * (cols + 1)) / cols;
      const ch = (H - PAD * (rows + 1)) / rows;
      const s = Math.min(cw / VW, (ch - TITLE) / VH);
      if (!best || s > best.s) best = { cols, rows, cw, ch, s };
    }
    const { cols, cw, ch, s } = best;
    this.scale = s;
    this.cells = floors.map((floor, i) => {
      const c = i % cols;
      const r = Math.floor(i / cols);
      const x0 = PAD + c * (cw + PAD);
      const y0 = PAD + r * (ch + PAD);
      const ox = x0 + (cw - VW * s) / 2;
      const oy = y0 + TITLE + (ch - TITLE - VH * s) / 2;
      return { floor, x0, y0, cw, ch, ox, oy, s };
    });
  }

  #colors() {
    const robots = [1, 2, 3, 4, 5].map((i) => cssVar(`--robot-${i}`));
    this.c = {
      surface: cssVar("--surface"),
      plate: cssVar("--surface-2"),
      line: cssVar("--line"),
      ink: cssVar("--ink"),
      ink2: cssVar("--ink-2"),
      ink3: cssVar("--ink-3"),
      axis: cssVar("--axis"),
      accent: cssVar("--accent"),
      crit: cssVar("--crit"),
      warn: cssVar("--warn"),
      ok: cssVar("--ok"),
      fault: cssVar("--st-fault"),
      robots,
    };
  }

  robotColor(r) {
    return this.c.robots[(r.def.slot || 1) - 1];
  }

  // ------------------------------------------------------- static layer
  #drawStatic() {
    const g = this.static.getContext("2d");
    const { c } = this;
    g.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    g.clearRect(0, 0, this.cssW, this.cssH);
    this.titles = [];
    const h = this.w.hospital;
    for (const cell of this.cells) {
      const { floor, s } = cell;
      const X = (x) => cell.ox + (x - VIEW.x1) * s;
      const Y = (z) => cell.oy + (z - VIEW.z1) * s;
      const def = FLOORS[floor];
      const f = h.floors[floor];

      // title: floor chip + name (+ hint when several floors are shown)
      g.font = `700 12px ${NUM}`;
      const chipW = 28;
      roundRect(g, cell.x0, cell.y0 + 2, chipW, 18, 5);
      g.fillStyle = def.css;
      g.fill();
      g.fillStyle = "#ffffff";
      g.textAlign = "center";
      g.textBaseline = "middle";
      g.fillText(def.id, cell.x0 + chipW / 2, cell.y0 + 11.5);
      g.textAlign = "left";
      g.font = `600 12px ${FONT}`;
      g.fillStyle = c.ink2;
      g.fillText(def.name, cell.x0 + chipW + 7, cell.y0 + 11.5);
      const nameW = g.measureText(def.name).width;
      this.titles.push({ floor, x: cell.x0, y: cell.y0, w: chipW + 7 + nameW + 8, h: 22 });

      // plate + corridor
      roundRect(g, X(PLATE.minX), Y(PLATE.minZ), (PLATE.maxX - PLATE.minX) * s, (PLATE.maxZ - PLATE.minZ) * s, 4);
      g.fillStyle = c.plate;
      g.fill();
      g.fillStyle = c.surface;
      g.fillRect(X(-9.25), Y(CORRIDOR.minZ), (PLATE.maxX + 9.25) * s, (CORRIDOR.maxZ - CORRIDOR.minZ) * s);
      // elevator tower
      g.fillStyle = c.surface;
      g.fillRect(X(TOWER.x1), Y(TOWER.z1), (TOWER.x2 - TOWER.x1) * s, (TOWER.z2 - TOWER.z1) * s);
      g.strokeStyle = c.axis;
      g.lineWidth = 1;
      g.strokeRect(X(TOWER.x1) + 0.5, Y(TOWER.z1) + 0.5, (TOWER.x2 - TOWER.x1) * s - 1, (TOWER.z2 - TOWER.z1) * s - 1);

      // furniture footprints
      g.fillStyle = c.line;
      for (const [x1, x2, z1, z2] of f.plan.obstacles) g.fillRect(X(x1), Y(z1), (x2 - x1) * s, (z2 - z1) * s);

      // corridor lanes (keep right): eastbound on the front side, westbound on the room side
      g.strokeStyle = c.axis;
      g.lineWidth = 1;
      for (const [z, dir] of [[LANES.east, 1], [LANES.west, -1]]) {
        g.setLineDash([3, 4]);
        g.beginPath();
        g.moveTo(X(-8.3), Y(z));
        g.lineTo(X(8.7), Y(z));
        g.stroke();
        g.setLineDash([]);
        if (s < 9) continue;
        for (let x = -6; x <= 8; x += 4.5) {
          const px = X(x);
          const py = Y(z);
          g.beginPath();
          g.moveTo(px - dir * 3, py - 3);
          g.lineTo(px + dir * 1, py);
          g.lineTo(px - dir * 3, py + 3);
          g.stroke();
        }
      }

      // walls
      g.strokeStyle = c.ink3;
      g.lineWidth = Math.max(1.2, s * 0.09);
      g.lineCap = "round";
      g.beginPath();
      for (const [x1, z1, x2, z2] of f.plan.walls) {
        g.moveTo(X(x1), Y(z1));
        g.lineTo(X(x2), Y(z2));
      }
      g.stroke();

      // chargers and standby spots
      for (const d of h.docks) {
        if (d.floor !== floor) continue;
        const half = 0.3 * s;
        g.lineWidth = 1;
        g.strokeStyle = c.ink3;
        if (d.charger) {
          g.fillStyle = c.surface;
          g.fillRect(X(d.x) - half, Y(d.z) - half, half * 2, half * 2);
          g.strokeRect(X(d.x) - half + 0.5, Y(d.z) - half + 0.5, half * 2 - 1, half * 2 - 1);
        } else {
          g.setLineDash([2, 2]);
          g.strokeRect(X(d.x) - half + 0.5, Y(d.z) - half + 0.5, half * 2 - 1, half * 2 - 1);
          g.setLineDash([]);
        }
        if (s >= 11) {
          g.font = `600 ${Math.max(9, Math.min(11, s * 0.5))}px ${NUM}`;
          g.fillStyle = c.ink3;
          g.textAlign = "center";
          g.textBaseline = "middle";
          const fw = fwd(d.yaw);
          g.fillText(d.id, X(d.x + fw.x * 0.75), Y(d.z + fw.z * 0.75));
        }
      }

      // room names painted on the floor
      if (s >= 12) {
        g.font = `500 ${Math.max(9, Math.min(11.5, s * 0.46))}px ${FONT}`;
        g.fillStyle = c.ink3;
        g.textAlign = "center";
        g.textBaseline = "middle";
        for (const l of f.plan.labels) {
          if (l.text.startsWith("VS-") || /^C\d|^S\d/.test(l.text)) continue;
          g.fillText(l.text.replace(" ENTRANCE", ""), X(l.x), Y(l.z));
        }
      }
      g.font = `500 ${Math.max(9, Math.min(11, s * 0.45))}px ${FONT}`;
      g.fillStyle = c.ink3;
      g.textAlign = "center";
      if (s >= 9) g.fillText("電梯", X((TOWER.x1 + TOWER.x2) / 2), Y(TOWER.z2) + 9);
    }
  }

  // ----------------------------------------------------------- per frame
  update(realDt) {
    if (!this.visible) return;
    this.t += realDt;
    if (this.dirty) {
      this.dirty = false;
      this.#layout();
      this.#colors();
      this.#drawStatic();
    }
    const g = this.g;
    g.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    g.clearRect(0, 0, this.cssW, this.cssH);
    g.drawImage(this.static, 0, 0, this.cssW, this.cssH);
    this.hits = [];
    for (const cell of this.cells) this.#drawFloor(g, cell);
    if (this.hover) this.#updateTip();
  }

  #drawFloor(g, cell) {
    const { w, c } = this;
    const { floor, s } = cell;
    const X = (x) => cell.ox + (x - VIEW.x1) * s;
    const Y = (z) => cell.oy + (z - VIEW.z1) * s;
    const f = w.fleet;
    const pulse = 0.5 + 0.5 * Math.sin(this.t * 4);

    // zones held right now: tinted with the holder's colour, waiting robots counted
    for (const [id, rect] of w.hospital.zoneRects) {
      if (rect.floor !== floor) continue;
      const holder = w.traffic.holder(id);
      const queue = w.traffic.queueOf(id).length;
      if (!holder && !queue) continue;
      const x = X(rect.x1);
      const y = Y(rect.z1);
      const ww = (rect.x2 - rect.x1) * s;
      const hh = (rect.z2 - rect.z1) * s;
      if (holder) {
        const col = this.robotColor(holder);
        g.fillStyle = hexA(col, 0.13);
        g.fillRect(x, y, ww, hh);
        g.strokeStyle = hexA(col, 0.65);
        g.lineWidth = 1.5;
        g.strokeRect(x + 0.75, y + 0.75, ww - 1.5, hh - 1.5);
      }
      if (queue) this.#badge(g, x + ww - 4, y + (rect.z1 < 0 ? hh - 4 : 4), `等候 ${queue}`, c.warn, rect.z1 < 0 ? "bottom" : "top");
    }

    // residents with an open alert, and the bed being measured
    const open = new Set(f.alerts.filter((a) => !a.closed && !a.resolved).map((a) => a.bed));
    for (const bed of w.hospital.beds.values()) {
      if (bed.floor !== floor || !open.has(bed.id)) continue;
      g.strokeStyle = hexA(c.crit, 0.35 + 0.5 * pulse);
      g.lineWidth = 2;
      g.beginPath();
      g.arc(X(bed.x), Y(bed.z), (0.95 + 0.25 * pulse) * s, 0, Math.PI * 2);
      g.stroke();
      this.#badge(g, X(bed.x), Y(bed.z - 1.15), `${bed.id} 異常`, c.crit, "bottom", true);
      this.hits.push({ kind: "bed", bed, x: X(bed.x), y: Y(bed.z), r: Math.max(12, s) });
    }
    for (const sensor of w.sensorList) {
      const bed = sensor.bed;
      if (!bed || bed.floor !== floor || (sensor.state !== "measure" && sensor.state !== "detect")) continue;
      g.strokeStyle = hexA(c.accent, 0.4 + 0.4 * pulse);
      g.lineWidth = 1.5;
      g.setLineDash([3, 3]);
      g.beginPath();
      g.arc(X(bed.x), Y(bed.z - 0.4), 0.75 * s, 0, Math.PI * 2);
      g.stroke();
      g.setLineDash([]);
    }

    // elevator: cab on the floor it is at, doors, robots queueing in the lobby
    const el = w.elevator;
    const cabFloor = Math.round(el.floorFloat);
    const lift = w.lift;
    if (cabFloor === floor) {
      const near = 1 - Math.min(1, Math.abs(el.floorFloat - floor) * 2);
      g.globalAlpha = 0.45 + 0.55 * near;
      g.fillStyle = c.plate;
      g.fillRect(X(CAB.x1), Y(CAB.z1), (CAB.x2 - CAB.x1) * s, (CAB.z2 - CAB.z1) * s);
      g.strokeStyle = c.ink2;
      g.lineWidth = 1.5;
      g.strokeRect(X(CAB.x1), Y(CAB.z1), (CAB.x2 - CAB.x1) * s, (CAB.z2 - CAB.z1) * s);
      g.globalAlpha = 1;
      if (el.moving) {
        const up = el.targetY > el.cabY;
        const cx = X((CAB.x1 + CAB.x2) / 2);
        const cy = Y(0);
        g.fillStyle = c.ink2;
        g.beginPath();
        const a = Math.max(4, 0.35 * s);
        g.moveTo(cx - a, cy + (up ? a / 2 : -a / 2));
        g.lineTo(cx + a, cy + (up ? a / 2 : -a / 2));
        g.lineTo(cx, cy + (up ? -a / 2 : a / 2));
        g.fill();
      }
    }
    const door = el.doors[floor];
    if (door) {
      const open1 = door.open || 0;
      g.strokeStyle = c.ink2;
      g.lineWidth = Math.max(1.5, s * 0.1);
      const half = 0.62 * (1 - open1);
      g.beginPath();
      g.moveTo(X(-9.2), Y(-0.62));
      g.lineTo(X(-9.2), Y(-0.62 + half));
      g.moveTo(X(-9.2), Y(0.62));
      g.lineTo(X(-9.2), Y(0.62 - half));
      g.stroke();
    }
    if (lift.outOfService) this.#badge(g, X((TOWER.x1 + TOWER.x2) / 2), Y(TOWER.z1) - 3, "停用", c.fault, "bottom", true);
    const waiting = lift.tickets.filter((t) => !t.cancelled && !t.boarded && t.from === floor).length;
    if (waiting) this.#badge(g, X(-8.2), Y(-1.15), `候梯 ${waiting}`, c.warn, "bottom");

    // furniture standing on its own
    const furn = [...Object.values(w.carts), ...w.meds];
    for (const sh of furn) {
      if (sh.robot || sh.floor !== floor) continue;
      const hs = 0.22 * s;
      g.strokeStyle = c.ink3;
      g.lineWidth = 1;
      roundRect(g, X(sh.x) - hs, Y(sh.z) - hs, hs * 2, hs * 2, 2);
      g.stroke();
    }

    // people
    for (const p of w.staffList) {
      if (p.floor !== floor) continue;
      const wander = p.id === "wanderer" && !p.sitting;
      g.fillStyle = wander ? c.warn : c.ink3;
      g.beginPath();
      g.arc(X(p.x), Y(p.z), Math.max(2.2, 0.17 * s), 0, Math.PI * 2);
      g.fill();
    }

    // robots: route ahead first, then the robots on top
    const robots = f.robots;
    const focus = w.camera ? (w.camera.mode === "follow" && w.camera.selected) || w.camera.focusRobot : null;
    const where = (r) => (r.inElevator ? cabFloor : r.floor);
    for (const r of robots) {
      if (where(r) !== floor || r.mode !== "path" || r.inElevator) continue;
      const pts = r.path.slice(r.pathIndex);
      if (!pts.length) continue;
      const col = this.robotColor(r);
      g.strokeStyle = hexA(col, 0.75);
      g.lineWidth = 1.5;
      g.setLineDash([4, 3]);
      g.beginPath();
      g.moveTo(X(r.x), Y(r.z));
      for (const p of pts) g.lineTo(X(p.x), Y(p.z));
      g.stroke();
      g.setLineDash([]);
      const goal = pts[pts.length - 1];
      g.beginPath();
      g.arc(X(goal.x), Y(goal.z), Math.max(3, 0.16 * s), 0, Math.PI * 2);
      g.stroke();
    }
    for (const r of robots) {
      if (where(r) !== floor) continue;
      const col = this.robotColor(r);
      const x = X(r.x);
      const y = Y(r.z);
      const rad = Math.max(5, 0.26 * s);
      if (r === focus) {
        g.strokeStyle = hexA(col, 0.35);
        g.lineWidth = 3;
        g.beginPath();
        g.arc(x, y, rad + 5, 0, Math.PI * 2);
        g.stroke();
      }
      if (r.shelf) {
        g.strokeStyle = c.ink2;
        g.lineWidth = 1.2;
        const hs = rad + 3;
        roundRect(g, x - hs, y - hs, hs * 2, hs * 2, 3);
        g.stroke();
      }
      // surface ring keeps overlapping robots apart
      g.fillStyle = c.surface;
      g.beginPath();
      g.arc(x, y, rad + 2, 0, Math.PI * 2);
      g.fill();
      g.fillStyle = col;
      g.beginPath();
      g.arc(x, y, rad, 0, Math.PI * 2);
      g.fill();
      const d = fwd(r.yaw);
      g.strokeStyle = c.surface;
      g.lineWidth = 2;
      g.beginPath();
      g.moveTo(x, y);
      g.lineTo(x + d.x * rad, y + d.z * rad);
      g.stroke();
      if (r.fault) {
        g.strokeStyle = c.fault;
        g.lineWidth = 2;
        g.beginPath();
        g.arc(x, y, rad + 4 + 2 * pulse, 0, Math.PI * 2);
        g.stroke();
      }
      // ID label in ink with a surface halo (text never wears the series colour)
      g.font = `700 ${Math.max(10, Math.min(12, s * 0.55))}px ${NUM}`;
      g.textAlign = "left";
      g.textBaseline = "middle";
      g.lineWidth = 3;
      g.strokeStyle = c.surface;
      const lx = x + rad + 3;
      const ly = y - rad - 1;
      g.strokeText(r.id, lx, ly);
      g.fillStyle = c.ink;
      g.fillText(r.id, lx, ly);
      if (r.fault) this.#badge(g, x, y + rad + 6, "故障", c.fault, "top", true);
      else if (r.waitInfo) {
        g.fillStyle = c.warn;
        g.beginPath();
        g.arc(x + rad * 0.85, y + rad * 0.85, 3, 0, Math.PI * 2);
        g.fill();
      }
      this.hits.push({ kind: "robot", robot: r, x, y, r: Math.max(14, rad + 8) });
    }
  }

  #badge(g, x, y, text, color, anchor = "bottom", solid = false) {
    g.font = `600 10.5px ${FONT}`;
    const tw = g.measureText(text).width;
    const w = tw + 10;
    const h = 16;
    const bx = Math.min(Math.max(x - w / 2, 2), this.cssW - w - 2);
    const by = anchor === "bottom" ? y - h : y;
    roundRect(g, bx, by, w, h, 4);
    g.fillStyle = solid ? color : this.c.surface;
    g.fill();
    if (!solid) {
      g.strokeStyle = color;
      g.lineWidth = 1.2;
      g.stroke();
    }
    g.fillStyle = solid ? "#ffffff" : this.c.ink;
    g.textAlign = "center";
    g.textBaseline = "middle";
    g.fillText(text, bx + w / 2, by + h / 2 + 0.5);
  }

  // ------------------------------------------------------------ pointer
  #at(e) {
    const r = this.canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  #nearest(p) {
    let best = null;
    let bd = Infinity;
    for (const h of this.hits) {
      const d = Math.hypot(h.x - p.x, h.y - p.y);
      if (d < h.r && d < bd) {
        best = h;
        bd = d;
      }
    }
    return best;
  }

  #pointer(e) {
    const p = this.#at(e);
    const hit = this.#nearest(p);
    const title = this.titles.find((t) => p.x >= t.x && p.x <= t.x + t.w && p.y >= t.y && p.y <= t.y + t.h);
    this.canvas.style.cursor = hit || title ? "pointer" : "default";
    this.hover = hit ? { hit, p } : null;
    if (!hit) this.#hideTip();
    else this.#updateTip();
  }

  #updateTip() {
    const { hit, p } = this.hover;
    const tip = this.tip;
    tip.replaceChildren();
    const row = (strong, text) => {
      const div = document.createElement("div");
      if (strong) {
        const b = document.createElement("b");
        b.textContent = strong;
        div.append(b, " ");
      }
      div.append(text);
      tip.append(div);
    };
    if (hit.kind === "robot") {
      const r = hit.robot;
      const a = r.activity;
      const t = r.task || r.assignment;
      row(r.id, `${a.label}${a.detail ? ` · ${a.detail}` : ""}`);
      if (t) row(t.id, t.title);
      row(`${Math.round(r.battery)}%`, r.onCharger ? "充電中" : "電量");
      if (r.waitInfo) row("", r.waitInfo.label);
      row("", "點選可在 3D 中跟隨");
    } else {
      const a = this.w.fleet.alerts.find((x) => x.bed === hit.bed.id && !x.closed);
      row(hit.bed.id, a ? `${a.flags.join("、")}` : "");
      if (a) row("", a.status);
    }
    tip.hidden = false;
    const W = this.cssW;
    const tw = tip.offsetWidth;
    const th = tip.offsetHeight;
    let x = p.x + 14;
    if (x + tw > W - 4) x = p.x - tw - 14;
    let y = p.y - th - 10;
    if (y < 4) y = p.y + 16;
    tip.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
  }

  #hideTip() {
    this.hover = null;
    this.tip.hidden = true;
  }

  #click(e) {
    const p = this.#at(e);
    const title = this.titles.find((t) => p.x >= t.x && p.x <= t.x + t.w && p.y >= t.y && p.y <= t.y + t.h);
    if (title) {
      this.solo = this.solo === null ? title.floor : null;
      this.dirty = true;
      return;
    }
    const hit = this.#nearest(p);
    if (hit && hit.kind === "robot") this.onPick(hit.robot);
  }

  showFloor(floor) {
    this.solo = floor;
    this.dirty = true;
  }

  setVisible(on) {
    this.visible = on;
    if (on) this.dirty = true;
    else this.#hideTip();
  }
}
