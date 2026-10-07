// --- shared constants for the hospital AMR scene (meters, seconds) ---

export const FLOOR_GAP = 4.2; // slab-to-slab distance; floors are drawn as a cut-away stack

export const PLATE = { minX: -9, maxX: 9, minZ: -5, maxZ: 5 };
export const CORRIDOR = { minZ: -1.1, maxZ: 1.1, laneZ: 0 };
export const ROOM_CENTERS = [-6.75, -2.25, 2.25, 6.75]; // back rooms, 4.5 m wide each

export const WALL_LOW = 1.3; // cut-away interior wall height
export const WALL_HIGH = 2.9; // back facade
export const WALL_T = 0.12;

// Wayfinding colour per floor (hospital floors are colour-coded)
export const FLOORS = [
  { id: "1F", map: "hosp-1f-lobby", name: "門診大廳・藥局", tint: 0xece3d4, accent: 0xc9893a, css: "#c9893a" },
  { id: "2F", map: "hosp-2f-lab", name: "檢驗科・中央供應", tint: 0xe6e3ef, accent: 0x7c6fb4, css: "#7c6fb4" },
  { id: "3F", map: "hosp-3f-ward-a", name: "內科病房 A", tint: 0xdcece5, accent: 0x2e9a7b, css: "#2e9a7b" },
  { id: "4F", map: "hosp-4f-rcw", name: "呼吸照護病房", tint: 0xdde9f2, accent: 0x3b7fb9, css: "#3b7fb9" },
];

// Kachaka Pro, from pf-robotics/kachaka-api (URDF + python/kachaka_api/base.py)
export const KACHAKA = {
  length: 0.387,
  width: 0.24,
  height: 0.125,
  massKg: 10,
  maxLinear: 0.3, // MAX_LINEAR_VELOCITY [m/s]
  maxAngular: 1.57, // MAX_ANGULAR_VELOCITY [rad/s]
  shelfLinear: 0.24, // slower while carrying furniture (ShelfSpeedMode)
  wheelRadius: 0.045,
  wheelTrack: 0.2,
  lidar: { x: 0.156, y: 0.1049, fov: (270 * Math.PI) / 180, rays: 120, range: 8 },
  dockDepth: 0.65, // drive-under distance used for docking
  pinTravel: 0.012, // docking_joint prismatic upper limit
};

export const ELEVATOR = {
  shaftX: -10.45, // cab centre
  doorX: -9.2,
  landingX: -8.3, // robot waits here, facing the doors
  speed: 1.1,
  accel: 0.7,
  doorTime: 1.8,
};

export const SIM_SPEEDS = [1, 6, 12];
export const DEFAULT_SPEED = 6;
export const MEASURE_SECONDS = 30; // radar acquisition window per bed
export const START_CLOCK = 7 * 3600 + 58 * 60; // 07:58:00

// minutes of nursing time a robot task replaces (shown as an estimate)
export const NURSE_MINUTES = { vitals: 6, delivery: 20, patrol: 10 };
