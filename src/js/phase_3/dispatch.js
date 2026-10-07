import { ELEVATOR, FLOORS, BATTERY } from "./config.js";

// --- dispatch strategies: which available robot gets a task, and why ---
const V = 0.24; // average speed incl. turns and docking (m/s)
const LANDING = { x: ELEVATOR.landingX, z: 0 };

export const STRATEGIES = {
  weighted: {
    name: "綜合評分",
    desc: "成本＝行程時間 × 權重 ＋ 缺電量 × 1.5 × 權重 ＋ 搭電梯 × (40 ＋ 25 × 排隊數) × 權重，成本最低者得。兼顧快、電量與電梯負載。",
  },
  nearest: {
    name: "最近優先",
    desc: "只看預估到達任務起點的時間（含電梯排隊），最快到的機器人接單。反應最快，但電量低的機器人容易被連續派工。",
  },
  zone: {
    name: "樓層責任區",
    desc: "每台機器人負責固定樓層，任務交給該樓層的負責機器人；忙碌時可改派最近者。減少跨樓層與電梯使用，適合樓層分工明確的機構。",
  },
  roundrobin: {
    name: "輪流指派",
    desc: "依 K1→K2→K3… 順序輪流接單，跳過忙碌或電量不足者。工作量平均，但不考慮距離，作為比較基準。",
  },
};

// responsibility floors per fleet size (floor indices); the last robot of a 5-robot fleet floats
export function zoneMap(n) {
  return (
    {
      1: [[0, 1, 2, 3]],
      2: [[0, 1], [2, 3]],
      3: [[0, 1], [2], [3]],
      4: [[0], [1], [2], [3]],
      5: [[0], [1], [2], [3], []],
    }[n] || [[0, 1, 2, 3]]
  );
}

export function zoneOwner(robots, floor) {
  const map = zoneMap(robots.length);
  const i = map.findIndex((floors) => floors.includes(floor));
  return i >= 0 ? robots[i] : null;
}

function floorDist(ax, az, bx, bz) {
  if (Math.abs(az) < 1.15 && Math.abs(bz) < 1.15) return Math.abs(ax - bx) + Math.abs(az - bz);
  return Math.abs(az) + Math.abs(ax - bx) + Math.abs(bz);
}

// rough travel time between two poses, routed through the corridor and the elevator queue
export function travelSeconds(lift, from, to) {
  if (from.floor === to.floor) return floorDist(from.x, from.z, to.x, to.z) / V + 4;
  const queue = lift.queueLength();
  return (
    floorDist(from.x, from.z, LANDING.x, LANDING.z) / V +
    32 +
    queue * 50 +
    Math.abs(from.floor - to.floor) * 5 +
    floorDist(LANDING.x, LANDING.z, to.x, to.z) / V
  );
}

export function robotPose(r) {
  if (r.inElevator && r.rideTarget !== null) return { floor: r.rideTarget, x: LANDING.x, z: 0 };
  return { floor: r.floor, x: r.x, z: r.z };
}

// estimated task length (s) and battery use (%), for the energy check
export function taskSeconds(task) {
  switch (task.type) {
    case "rounds":
      return 100 + task.beds.length * 85;
    case "remeasure":
      return 210;
    case "delivery":
      return 380;
    case "patrol":
      return 70 + task.points.length * 55;
    default:
      return 300;
  }
}

export function taskEnergy(task, settings, eta) {
  const secs = eta + taskSeconds(task) + 150; // + getting back to a charger
  return (secs * BATTERY.drainMove * BATTERY.loadFactor * settings.batteryBoost) / 3600;
}

const fmtS = (s) => (s < 90 ? `${Math.round(s)} 秒` : `${(s / 60).toFixed(1)} 分`);

// score every candidate; returns { robot, text, rows }
export function chooseRobot({ lift, robots, settings, rrLast }, task, candidates) {
  const S = settings;
  const rows = candidates.map((r) => {
    const eta = travelSeconds(lift, robotPose(r), task.start) + (r.parked ? 8 : 0);
    const energy = taskEnergy(task, S, eta);
    const feasible = r.battery - energy >= S.criticalBattery + 5;
    const rides = r.floor !== task.start.floor || r.inElevator ? 1 : 0;
    const stranded = rides > 0 && lift.outOfService;
    const parts = {
      travel: eta * S.wTravel,
      battery: (100 - r.battery) * 1.5 * S.wBattery,
      floor: rides * (40 + 25 * lift.queueLength()) * S.wFloor,
    };
    return { robot: r, eta, energy, feasible: feasible && !stranded, stranded, rides, parts, cost: parts.travel + parts.battery + parts.floor };
  });
  const ok = rows.filter((x) => x.feasible);
  const lacking = rows.filter((x) => !x.feasible).map((x) => (x.stranded ? `${x.robot.id} 在其他樓層（電梯停用）` : `${x.robot.id} 電量不足以完成`));
  const tail = (list) => (list.length ? ` · ${list.join(" · ")}` : "");
  if (!ok.length) return { robot: null, rows, text: lacking.join(" · ") || "無可用機器人" };

  if (S.strategy === "nearest") {
    ok.sort((a, b) => a.eta - b.eta);
    const [best, ...rest] = ok;
    return {
      robot: best.robot,
      rows,
      text: `最近優先：${best.robot.id} 約 ${fmtS(best.eta)}到達${tail([...rest.slice(0, 2).map((x) => `${x.robot.id} ${fmtS(x.eta)}`), ...lacking])}`,
    };
  }

  if (S.strategy === "zone") {
    const owner = zoneOwner(robots, task.floor);
    const fid = FLOORS[task.floor].id;
    const mine = owner && ok.find((x) => x.robot === owner);
    if (mine) return { robot: owner, rows, text: `${fid} 責任區：${owner.id}（約 ${fmtS(mine.eta)}到達）` };
    const why = !owner ? `${fid} 無負責機器人` : candidates.includes(owner) ? `${fid} 責任區 ${owner.id} 電量不足` : `${fid} 責任區 ${owner.id} 忙碌`;
    if (!S.zoneFallback) return { robot: null, rows, text: `${why}，等待其完成（未開啟改派）` };
    ok.sort((a, b) => a.eta - b.eta);
    return { robot: ok[0].robot, rows, text: `${why} → 改派最近的 ${ok[0].robot.id}（約 ${fmtS(ok[0].eta)}）` };
  }

  if (S.strategy === "roundrobin") {
    const n = robots.length;
    const start = rrLast === null ? 0 : (robots.indexOf(rrLast) + 1) % n;
    for (let k = 0; k < n; k++) {
      const r = robots[(start + k) % n];
      const row = ok.find((x) => x.robot === r);
      if (row) {
        const skipped = [];
        for (let j = 0; j < k; j++) skipped.push(robots[(start + j) % n].id);
        return {
          robot: r,
          rows,
          text: `輪流指派：輪到 ${r.id}${skipped.length ? `（${skipped.join("、")} 忙碌或電量不足，跳過）` : ""}${rrLast ? `，上一筆 ${rrLast.id}` : ""}`,
        };
      }
    }
  }

  ok.sort((a, b) => a.cost - b.cost);
  const [best, ...rest] = ok;
  const p = best.parts;
  return {
    robot: best.robot,
    rows,
    text:
      `綜合評分最低：${best.robot.id} ${Math.round(best.cost)}（行程 ${Math.round(p.travel)}＋電量 ${Math.round(p.battery)}＋換樓層 ${Math.round(p.floor)}）` +
      tail([...rest.slice(0, 2).map((x) => `${x.robot.id} ${Math.round(x.cost)}`), ...lacking]),
  };
}
