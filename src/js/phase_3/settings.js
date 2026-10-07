import { emit } from "./sim.js";

// --- adjustable fleet policies (persisted per viewer; the page works without storage) ---
const KEY = "kachaka-ltc-fleet-v1";

export const DEFAULTS = {
  robots: 3,
  seed: 1, // scenario number: the same number replays the same day
  // dispatch
  strategy: "weighted", // weighted | nearest | zone | roundrobin
  wTravel: 1.0,
  wBattery: 0.6,
  wFloor: 0.5,
  zoneFallback: true,
  preemption: true,
  batching: true,
  agingMin: 10,
  reserveStat: true,
  // traffic
  elevatorPolicy: "priority", // fifo | priority | nearest
  rightOfWay: "fifo", // fifo | priority
  followGap: 0.9,
  // charging
  lowBattery: 30,
  criticalBattery: 15,
  resumeBattery: 80,
  minDispatch: 40,
  chargerPolicy: "nearest", // nearest | home
  opportunity: true,
  batteryBoost: 8,
  // task generation (sim minutes)
  deliveryEvery: 8,
  patrolEvery: 20,
  roundsEvery: 45,
  remeasureAfter: 10,
};

function load() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return {};
    const data = JSON.parse(raw);
    const out = {};
    for (const k of Object.keys(DEFAULTS)) if (typeof data[k] === typeof DEFAULTS[k]) out[k] = data[k];
    return out;
  } catch {
    return {};
  }
}

export const settings = { ...DEFAULTS, ...load() };
normalize();

function save() {
  try {
    localStorage.setItem(KEY, JSON.stringify(settings));
  } catch {
    /* private mode / blocked storage: settings still apply for this visit */
  }
}

// keep the battery thresholds ordered: critical < low < resume, dispatch floor above critical
function normalize(changed = null) {
  const s = settings;
  s.robots = Math.min(5, Math.max(1, Math.round(s.robots)));
  s.seed = Math.min(5, Math.max(1, Math.round(s.seed)));
  if (changed === "criticalBattery") s.lowBattery = Math.max(s.lowBattery, s.criticalBattery + 5);
  else s.criticalBattery = Math.min(s.criticalBattery, s.lowBattery - 5);
  s.resumeBattery = Math.max(s.resumeBattery, s.lowBattery + 10);
  if (changed === "resumeBattery") s.lowBattery = Math.min(s.lowBattery, s.resumeBattery - 10);
  s.minDispatch = Math.max(s.minDispatch, s.criticalBattery + 10);
}

export function setSetting(key, value) {
  if (!(key in DEFAULTS)) return;
  settings[key] = value;
  normalize(key);
  save();
  emit("settings", { key });
}

export function resetSettings() {
  const robots = settings.robots;
  Object.assign(settings, DEFAULTS);
  save();
  emit("settings", { key: null, robotsChanged: robots !== settings.robots });
}

// --- form description for the settings drawer ---
export const SETTINGS_SCHEMA = [
  {
    id: "dispatch",
    title: "派工策略",
    items: [
      {
        key: "strategy",
        type: "seg",
        label: "派工方式",
        options: [
          ["weighted", "綜合評分"],
          ["nearest", "最近優先"],
          ["zone", "樓層責任區"],
          ["roundrobin", "輪流指派"],
        ],
      },
      { key: "wTravel", type: "range", label: "行程時間權重", min: 0, max: 2, step: 0.1, show: (s) => s.strategy === "weighted" },
      { key: "wBattery", type: "range", label: "電量權重", min: 0, max: 2, step: 0.1, show: (s) => s.strategy === "weighted" },
      { key: "wFloor", type: "range", label: "換樓層（搭電梯）權重", min: 0, max: 2, step: 0.1, show: (s) => s.strategy === "weighted" },
      { key: "zoneFallback", type: "switch", label: "責任區機器人忙碌時，改派最近的機器人", show: (s) => s.strategy === "zone" },
      { key: "preemption", type: "switch", label: "P1 緊急任務可中斷執行中的 P3／P4 任務" },
      { key: "batching", type: "switch", label: "合併派工：複測併入同樓層巡房、同目的地配送併單" },
      { key: "agingMin", type: "range", label: "優先級老化：每等候 N 分鐘升一級", min: 0, max: 30, step: 5, unit: "分", zero: "關閉" },
      { key: "reserveStat", type: "switch", label: "保留一個藥品櫃給 P1 緊急用藥（一般配送不可用掉最後一櫃）" },
    ],
  },
  {
    id: "traffic",
    title: "交通管制",
    items: [
      {
        key: "elevatorPolicy",
        type: "seg",
        label: "電梯排程",
        options: [
          ["fifo", "先到先服務"],
          ["priority", "任務優先級"],
          ["nearest", "最近樓層"],
        ],
      },
      {
        key: "rightOfWay",
        type: "seg",
        label: "房門／取件點通行權",
        options: [
          ["fifo", "先到先過"],
          ["priority", "優先級高者先"],
        ],
      },
      { key: "followGap", type: "range", label: "同向跟車距離（中心距）", min: 0.6, max: 1.6, step: 0.1, unit: "m" },
    ],
  },
  {
    id: "charge",
    title: "充電管理",
    items: [
      { key: "lowBattery", type: "range", label: "回充門檻（閒置時低於此值去充電）", min: 15, max: 50, step: 5, unit: "%" },
      { key: "criticalBattery", type: "range", label: "強制回充（任務在安全點交接）", min: 5, max: 25, step: 5, unit: "%" },
      { key: "resumeBattery", type: "range", label: "回充後充到多少才再接任務", min: 50, max: 100, step: 5, unit: "%" },
      { key: "minDispatch", type: "range", label: "可派工最低電量", min: 20, max: 70, step: 5, unit: "%" },
      {
        key: "chargerPolicy",
        type: "seg",
        label: "充電座分配",
        options: [
          ["nearest", "最近可用"],
          ["home", "固定歸屬"],
        ],
      },
      { key: "opportunity", type: "switch", label: "閒置時停靠充電座補充電（機會充電）" },
      { key: "batteryBoost", type: "range", label: "電量變化加速（示範用）", min: 1, max: 20, step: 1, unit: "×" },
    ],
  },
  {
    id: "tasks",
    title: "任務產生",
    items: [
      { key: "deliveryEvery", type: "range", label: "藥品配送：每 N 分鐘一筆", min: 0, max: 60, step: 5, unit: "分", zero: "不自動" },
      { key: "patrolEvery", type: "range", label: "失智專區巡視間隔", min: 10, max: 90, step: 5, unit: "分" },
      { key: "roundsEvery", type: "range", label: "生命徵象巡房間隔", min: 30, max: 180, step: 15, unit: "分" },
      { key: "remeasureAfter", type: "range", label: "異常後幾分鐘複測", min: 5, max: 30, step: 5, unit: "分" },
    ],
  },
  {
    id: "fleet",
    title: "車隊規模",
    items: [
      {
        key: "robots",
        type: "seg",
        label: "機器人數量（變更後從 07:58 重新開始）",
        options: [1, 2, 3, 4, 5].map((n) => [n, `${n} 台`]),
      },
      {
        key: "seed",
        type: "seg",
        label: "情境編號（同一編號＝同一天的任務與數值，可重播比較）",
        options: [1, 2, 3, 4, 5].map((n) => [n, `情境 ${n}`]),
      },
    ],
  },
];
