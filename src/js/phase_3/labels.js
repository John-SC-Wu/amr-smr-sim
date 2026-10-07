import * as THREE from "three";

// --- HTML labels pinned to 3D positions (robot tag, floor names, speech bubbles, vitals) ---
export class Labels {
  constructor(container, camera) {
    this.container = container;
    this.camera = camera;
    this.items = new Set();
    this.bubbles = new Map();
    this.v = new THREE.Vector3();
  }

  add({ className, html, anchor, floor = null, offsetY = 0, dimWhenFaded = false }) {
    const el = document.createElement("div");
    el.className = `lbl ${className}`;
    el.innerHTML = html;
    el.style.opacity = "0";
    this.container.appendChild(el);
    const item = { el, anchor, floor, offsetY, dimWhenFaded, hidden: false, expires: 0 };
    this.items.add(item);
    return item;
  }

  remove(item) {
    item.el.remove();
    this.items.delete(item);
  }

  // one bubble per speaker; a new line replaces the previous one
  bubble(key, { anchor, floor, text, kind, name }) {
    const prev = this.bubbles.get(key);
    if (prev) this.remove(prev);
    const item = this.add({ className: "lbl-bubble", html: `<small>${name}</small>${text}`, anchor, floor, offsetY: -12 });
    item.el.dataset.kind = kind;
    item.expires = performance.now() + Math.max(2800, text.length * 170);
    item.key = key;
    this.bubbles.set(key, item);
  }

  clearBubbles() {
    for (const item of this.bubbles.values()) this.remove(item);
    this.bubbles.clear();
  }

  update(width, height, fadeOf) {
    const now = performance.now();
    const bubbles = [];
    for (const item of this.items) {
      if (item.expires && now > item.expires) {
        this.remove(item);
        if (this.bubbles.get(item.key) === item) this.bubbles.delete(item.key);
        continue;
      }
      item.vis = false;
      if (item.hidden) continue;
      item.anchor(this.v);
      this.v.project(this.camera);
      let x = (this.v.x * 0.5 + 0.5) * width;
      const y = (-this.v.y * 0.5 + 0.5) * height + item.offsetY;
      // keep wide labels (speech bubbles) inside the stage instead of clipping them
      if (item.measureAgain === undefined || now > item.measureAgain) {
        item.halfW = item.el.offsetWidth / 2;
        item.h = item.el.offsetHeight;
        item.measureAgain = now + (item.expires ? 250 : 1000);
      }
      if (item.halfW && width > item.halfW * 2 + 12) x = Math.min(Math.max(x, item.halfW + 6), width - item.halfW - 6);
      const off = this.v.z > 1 || x < -60 || x > width + 60 || y < -20 || y > height + 80;
      const floor = typeof item.floor === "function" ? item.floor() : item.floor;
      item.faded = floor !== null && fadeOf(floor) <= 0.5;
      item.vis = !off && (!item.faded || item.dimWhenFaded);
      item.px = x;
      item.py = y;
      if (item.vis && item.expires) bubbles.push(item);
    }
    // keep bubbles below the stage HUD, then stack overlapping ones upwards
    for (const b of bubbles) b.py = Math.max(b.py, b.h + 58);
    bubbles.sort((a, b) => b.py - a.py);
    for (let i = 1; i < bubbles.length; i++) {
      const a = bubbles[i];
      for (let j = 0; j < i; j++) {
        const b = bubbles[j];
        const overlapX = Math.abs(a.px - b.px) < a.halfW + b.halfW + 4;
        const overlapY = a.py > b.py - b.h - 6 && a.py - a.h < b.py;
        if (overlapX && overlapY) a.py = b.py - b.h - 8;
      }
    }
    for (const item of this.items) {
      const opacity = item.vis ? (item.faded ? "0.45" : "1") : "0";
      if (item.el.style.opacity !== opacity) item.el.style.opacity = opacity;
      if (item.vis) item.el.style.transform = `translate3d(${item.px.toFixed(1)}px, ${item.py.toFixed(1)}px, 0) translate(-50%, -100%)`;
    }
  }
}
