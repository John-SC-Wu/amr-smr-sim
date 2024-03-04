// --- fetching the elements ---
const mainCanvas = document.getElementById("my-canvas");
mainCanvas.width = 200;
const networkCanvas = document.getElementById("network-canvas");
networkCanvas.width = 300;

const mainCtx = mainCanvas.getContext("2d");
const networkCtx = networkCanvas.getContext("2d");

const road = new Road(mainCanvas.width / 2, mainCanvas.width * 0.9);

// --- player clone generation ---
const N = 100; // number of clones
const clones = generateSmrClones(N);
let bestSMR = clones[0];
if (localStorage.getItem("bestBrain")) {
  for (let i = 0; i < clones.length; i++) {
    clones[i].brain = JSON.parse(localStorage.getItem("bestBrain"));
    if (i != 0) {
      NeuralNetwork.mutate(clones[i].brain, 0.1);
    }
  }
}

// --- traffic participants (NPC) ---
const traffic = [
  new SMR(road.getLaneCenter(1), -100, 30, 50, "DUMMY", 2, getDummyColor()),
  new SMR(road.getLaneCenter(0), -300, 30, 50, "DUMMY", 1.5, getDummyColor()),
  new SMR(road.getLaneCenter(2), -300, 30, 50, "DUMMY", 1.5, getDummyColor()),
  new SMR(road.getLaneCenter(0), -500, 30, 50, "DUMMY", 2, getDummyColor()),
  new SMR(road.getLaneCenter(1), -500, 30, 50, "DUMMY", 2, getDummyColor()),
  new SMR(road.getLaneCenter(1), -700, 30, 50, "DUMMY", 1.6, getDummyColor()),
  new SMR(road.getLaneCenter(2), -700, 30, 50, "DUMMY", 2, getDummyColor()),
];

animate();

// --- supporting functions ---
function generateSmrClones(N) {
  const clones = [];
  for (let i = 1; i <= N; i++) {
    clones.push(new SMR(road.getLaneCenter(1), 100, 30, 50, "AI"));
  }
  return clones;
}

function animate(time) {
  // --- update participant states ---
  for (let i = 0; i < traffic.length; i++) {
    traffic[i].update(road.borders, []);
  }
  for (let i = 0; i < clones.length; i++) {
    clones[i].update(road.borders, traffic);
  }
  bestSMR = clones.find((c) => c.y == Math.min(...clones.map((c) => c.y)));

  mainCanvas.height = window.innerHeight;
  networkCanvas.height = window.innerHeight;

  // --- canvas rendering ---
  mainCtx.save();
  mainCtx.translate(0, -bestSMR.y + mainCanvas.height * 0.7);

  // --- draw participants ---
  road.draw(mainCtx);
  for (let i = 0; i < traffic.length; i++) {
    traffic[i].draw(mainCtx);
  }
  mainCtx.globalAlpha = 0.2;
  for (let i = 0; i < clones.length; i++) {
    clones[i].draw(mainCtx);
  }
  mainCtx.globalAlpha = 1;
  bestSMR.draw(mainCtx, true);

  mainCtx.restore();

  // --- draw neural network ---
  networkCtx.lineDashOffset = -time / 50;
  Visualizer.drawNetwork(networkCtx, bestSMR.brain);

  requestAnimationFrame(animate);
}
