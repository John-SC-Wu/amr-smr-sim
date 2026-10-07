import { formatClock } from "./sim.js";
import { stepWorld } from "./world.js";
import { SCENARIO, scenarioScript } from "./lab.js";
import { STRATEGIES } from "./dispatch.js";

// --- guided tour: the scripted morning with captions, camera moves and fast-forward jumps ---
const $ = (id) => document.getElementById(id);
const at = (h, m, s = 0) => h * 3600 + m * 60 + s;
const hm = (clock) => formatClock(clock, false);
const TOUR_SEED = 1;
const PLAY_SPEED = 6;

// each chapter: when it starts (clock), what to show, and when it is done
const CHAPTERS = [
  {
    id: "intro",
    title: "車隊待命",
    at: at(7, 58),
    view: "3d",
    tab: "board",
    cam: "overview",
    text: (c) =>
      `${c.n} 台 Kachaka 停在各樓層的充電座。08:00 起，3F／4F 生命徵象巡房、護理站派藥與 2F 失智專區巡視會自動排進佇列；這個早上還會遇到緊急用藥、電梯尖峰、機器人故障與電梯停用。`,
    until: (c) => c.clock >= at(8, 0, 2),
  },
  {
    id: "dispatch",
    title: "早班派工：誰接單？",
    at: at(8, 0),
    view: "3d",
    tab: "board",
    cam: "auto",
    text: (c) =>
      `巡房任務一進佇列，系統用「${STRATEGIES[c.w.settings.strategy].name}」挑機器人：預估行程時間、缺電量、要不要搭電梯，各自加權後分數最低者接單。下方任務卡寫出了每一筆的理由與分數。`,
    until: (c) => c.clock >= at(8, 2, 30),
  },
  {
    id: "lift",
    title: "跨樓層：一次一台的電梯",
    at: at(8, 2, 30),
    view: "split",
    tab: "board",
    cam: "auto",
    text: () =>
      "配送要先到 1F 藥局領藥再上樓。電梯系統一次只載一台：機器人沿電梯廳的牆邊排隊，由電梯依任務優先級叫號。右側平面圖同步顯示每台機器人的位置、規劃路線與正在使用的房間（著色）。",
    until: (c) => !!c.ev.alert || c.clock >= at(8, 6),
  },
  {
    id: "alert",
    title: "生理異常 → 醫囑緊急用藥",
    at: at(8, 4, 30),
    view: "split",
    tab: "board",
    cam: "follow",
    focus: (c) => c.robot(c.ev.alert && c.ev.alert.robot),
    text: (c) => {
      const a = c.ev.alert;
      return `${a ? `${a.robot} 在 ${a.text.split(" ").slice(0, 2).join(" ")} 量到 ${a.text.split(" ").slice(2).join(" ")}` : "量測車量到異常數值"}（門檻 HR > 110、RR > 24）：立即推播護理站與 LINE 群組，護理師到床邊處置，醫師開立的緊急用藥（P1）進入佇列。`;
    },
    until: (c) => c.clock >= at(8, 6, 50),
  },
  {
    id: "merge",
    title: "P1 插單與合併派工",
    at: at(8, 6, 50),
    view: "split",
    tab: "board",
    cam: "follow",
    focus: (c) => c.p1Robot(),
    text: (c) => {
      const r = c.p1Robot();
      return `08:06 又有一筆 4F 緊急用藥。沒有空閒機器人時，系統比較「等某台歸還藥品櫃」與「中斷一台巡房」哪個快；${r ? `${r.id} 一空下來就接手，` : ""}同一樓層的緊急用藥與例行配送併成同一趟，一次送達。`;
    },
    until: (c) => c.p1Delivered() || c.clock >= at(8, 11),
  },
  {
    id: "peak",
    title: "電梯尖峰",
    at: at(8, 13, 55),
    view: "plan",
    tab: "board",
    cam: "auto",
    text: () =>
      "08:14 三個樓層同時下單。配送依序排進佇列，搭電梯的機器人在電梯廳等候點排隊（平面圖上的「候梯」）；藥局保留一個藥品櫃給 P1，避免緊急用藥沒有櫃子可用。",
    until: (c) => c.clock >= at(8, 18, 30),
  },
  {
    id: "fault",
    title: "機器人故障與改派",
    at: at(8, 21, 55),
    view: "split",
    tab: "timeline",
    cam: "follow",
    focus: (c) => c.robot(c.ev.fault && c.ev.fault.robot),
    text: (c) => {
      const f = c.ev.fault;
      const h = c.ev.handover;
      if (!f) return "08:22 下一台行進中的機器人會回報「前方障礙卡住」（模擬）……";
      return `${f.robot} 停在原地並通知人員協助，所在房間的通行權先保留。${h ? `20 秒後它的任務改派給其他機器人（${h.text}）。` : "車上若沒有家具，20 秒後任務會改派；載著量測車或藥品櫃時則等人員排除後由它繼續。"}時間軸上的紅色段就是故障時間。`;
    },
    until: (c) => (c.ev.fault && c.clock >= Math.max(c.ev.fault.clock + 40, (c.ev.handover?.clock ?? 0) + 15)) || c.clock >= at(8, 26),
  },
  {
    id: "outage",
    title: "電梯停用 5 分鐘",
    at: at(8, 31, 55),
    view: "plan",
    tab: "timeline",
    cam: "auto",
    text: () =>
      "電梯系統回報維護停用：正在搭乘的那一趟會完成，新的跨樓層任務在電梯廳等候，同樓層任務照常進行，派工也暫停把跨樓層任務交給其他樓層的機器人。注意時間軸上黃色（等待）變多。",
    until: (c) => c.clock >= at(8, 37, 15),
  },
  {
    id: "recover",
    title: "恢復與消化",
    at: at(8, 37),
    view: "split",
    tab: "charts",
    cam: "auto",
    text: () =>
      "電梯恢復服務，依優先級與「等候逾 2 分鐘優先」消化排隊的機器人。即時數據顯示佇列與電梯排隊的起伏，以及每台機器人的電量與時間分配。",
    until: (c) => c.clock >= at(8, 40),
  },
  {
    id: "data",
    title: "看數據：幾台才夠？哪種派工最好？",
    at: at(8, 40),
    view: "split",
    tab: "timeline",
    cam: "auto",
    text: () =>
      "時間軸記錄每台機器人每一刻在做什麼。「策略實驗室」在背景把這個早上用不同車隊規模、派工策略與開關各模擬數次，直接比較緊急用藥送達、等候與完成件數。",
    action: { label: "開啟策略實驗室", run: (w) => w.lab.open() },
    until: () => false,
  },
];

// let promise continuations of the visible world run between fast-forward steps
const channel = typeof MessageChannel === "function" ? new MessageChannel() : null;
const queue = [];
if (channel) channel.port1.onmessage = () => queue.shift()?.();
const yieldPage = () =>
  new Promise((r) => {
    if (!channel) return setTimeout(r, 0);
    queue.push(r);
    channel.port2.postMessage(0);
  });

export class Tour {
  constructor(world) {
    this.w = world;
    this.active = false;
    this.index = -1;
    this.busy = false;
    this.ev = {};
    this.p1Tasks = [];
    this.seen = 0;
    this.card = $("tour-card");
    $("open-tour").addEventListener("click", () => (this.active ? this.stop() : this.start()));
    $("tour-close").addEventListener("click", () => this.stop());
    $("tour-next").addEventListener("click", () => {
      const ch = CHAPTERS[this.index];
      if (ch && ch.action && this.index === CHAPTERS.length - 1) ch.action.run(this.w);
      else this.go(this.index + 1);
    });
    $("tour-prev").addEventListener("click", () => this.go(Math.max(0, this.index - 1), true));
    $("tour-dots").innerHTML = CHAPTERS.map(() => "<li></li>").join("");
  }

  #ctx() {
    const { w } = this;
    const f = w.fleet;
    return {
      w,
      n: f.robots.length,
      clock: w.sim.clock,
      ev: this.ev,
      robot: (id) => f.robots.find((r) => r.id === id) || null,
      p1Robot: () => {
        const t = this.p1Tasks.find((x) => x.robot) || null;
        return t ? (t.parent ? t.parent.robot : t.robot) : null;
      },
      p1Delivered: () => this.p1Tasks.length > 0 && this.p1Tasks.every((t) => t.deliveredAt !== undefined),
    };
  }

  async start() {
    if (this.busy) return;
    const { w } = this;
    if (w.lab.isOpen) w.lab.close();
    this.active = true;
    $("open-tour").setAttribute("aria-pressed", "true");
    $("open-tour").querySelector("span").textContent = "結束導覽";
    $("stage").dataset.tour = "true";
    this.card.hidden = false;
    await this.#restart();
    this.go(0);
  }

  stop() {
    this.active = false;
    this.index = -1;
    $("open-tour").setAttribute("aria-pressed", "false");
    $("open-tour").querySelector("span").textContent = "導覽";
    delete $("stage").dataset.tour;
    this.card.hidden = true;
  }

  // the same morning every time: tour seed + the scripted events
  async #restart() {
    const { w } = this;
    this.ev = {};
    this.p1Tasks = [];
    this.seen = 0;
    const script = scenarioScript(SCENARIO.events, (e, res) => {
      if (e.kind === "stat" && res && res.id) this.p1Tasks.push(res);
    });
    await w.fleet.restart({ seed: TOUR_SEED, script });
    w.sim.paused = false;
    w.sim.speed = PLAY_SPEED;
    w.dashboard.syncSpeed();
  }

  async go(i, rewind = false) {
    if (!this.active || this.busy || i < 0 || i >= CHAPTERS.length) return;
    const ch = CHAPTERS[i];
    const { w } = this;
    if (rewind || i < this.index) {
      // time only runs forward: replay the morning up to that chapter
      this.busy = true;
      try {
        await this.#restart();
      } finally {
        this.busy = false;
      }
    }
    if (ch.at > w.sim.clock + 15) await this.#fastForward(ch.at);
    if (!this.active) return;
    this.index = i;
    w.dashboard.setView(window.innerWidth <= 640 && ch.view === "split" ? "3d" : ch.view);
    w.dashboard.setTab(ch.tab);
    w.sim.paused = false;
    w.sim.speed = PLAY_SPEED;
    w.dashboard.syncSpeed();
    this.focused = null;
    if (ch.cam === "overview") w.camera.setMode("overview");
    else if (ch.cam === "auto") w.camera.setMode("auto");
    this.#render();
  }

  async #fastForward(toClock) {
    const { w } = this;
    const sim = w.sim;
    this.busy = true;
    const veil = document.createElement("div");
    veil.className = "ff-veil";
    $("stage").appendChild(veil);
    $("tour-next").dataset.busy = "true";
    const wasPaused = sim.paused;
    sim.paused = true;
    w.renderPaused = true;
    try {
      while (sim.clock < toClock && this.active) {
        for (let k = 0; k < 160 && sim.clock < toClock; k++) {
          stepWorld(w, 0.05);
          for (let i = 0; i < 24; i++) await null;
        }
        this.#watch();
        veil.textContent = `快轉至 ${hm(toClock)}　目前 ${formatClock(sim.clock)}`;
        await yieldPage();
      }
    } finally {
      veil.remove();
      delete $("tour-next").dataset.busy;
      sim.paused = wasPaused;
      w.renderPaused = false;
      this.busy = false;
    }
  }

  // record the moments the captions talk about
  #watch() {
    const evs = this.w.fleet.metrics.events;
    for (; this.seen < evs.length; this.seen++) {
      const e = evs[this.seen];
      if (["alert", "fault", "outage", "outage-end"].includes(e.kind) && !this.ev[e.kind]) this.ev[e.kind] = e;
      if (e.kind === "handover" && this.ev.fault && !this.ev.handover && e.robot === this.ev.fault.robot) this.ev.handover = e;
    }
  }

  #render() {
    const ch = CHAPTERS[this.index];
    if (!ch) return;
    const c = this.#ctx();
    $("tour-step").textContent = `${this.index + 1} / ${CHAPTERS.length}`;
    $("tour-title").textContent = ch.title;
    $("tour-text").textContent = ch.text(c);
    const last = this.index === CHAPTERS.length - 1;
    $("tour-next").querySelector("span").textContent = last && ch.action ? ch.action.label : "下一章";
    $("tour-prev").disabled = this.index === 0;
    [...$("tour-dots").children].forEach((li, i) => (li.dataset.on = i < this.index ? "done" : i === this.index ? "now" : ""));
    this.text = $("tour-text").textContent;
    this.#measure();
  }

  // the plan view leaves room under it for the caption card
  #measure() {
    requestAnimationFrame(() => $("stage").style.setProperty("--tour-h", `${this.card.offsetHeight}px`));
  }

  // per frame: keep captions current, follow the robot of the moment, move on when done
  update() {
    if (!this.active || this.busy) return;
    this.#watch();
    const ch = CHAPTERS[this.index];
    if (!ch) return;
    const c = this.#ctx();
    $("tour-clock").textContent = formatClock(c.clock);
    const span = Math.max(1, (CHAPTERS[this.index + 1]?.at ?? c.clock + 60) - ch.at);
    $("tour-prog").style.setProperty("--v", Math.min(1, Math.max(0, (c.clock - ch.at) / span)).toFixed(3));
    const text = ch.text(c);
    if (text !== this.text) {
      this.text = text;
      $("tour-text").textContent = text;
      this.#measure();
    }
    if (ch.focus) {
      const r = ch.focus(c);
      if (r && r !== this.focused) {
        this.focused = r;
        this.w.camera.follow(r);
      }
    }
    if (ch.until(c) && this.index < CHAPTERS.length - 1) this.go(this.index + 1);
  }
}
