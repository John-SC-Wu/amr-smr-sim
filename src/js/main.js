const mainCanvas = document.getElementById("my-canvas");
mainCanvas.width = 200;
const networkCanvas = document.getElementById("network-canvas");
networkCanvas.width = 300;

const mainCtx = mainCanvas.getContext("2d");
const networkCtx = networkCanvas.getContext("2d");

const road = new Road(mainCanvas.width / 2, mainCanvas.width * 0.9);

const N = 100;
const smrs = generateSMRs(N);
let bestSMR = smrs[0];
if (localStorage.getItem("bestBrain")) {
  for (let i = 0; i < smrs.length; i++) {
    smrs[i].brain = JSON.parse(localStorage.getItem("bestBrain"));
    if (i != 0) {
      NeuralNetwork.mutate(smrs[i].brain, 0.1);
    }
  }
}

const traffic = [
  new SMR(road.getLaneCenter(1), -100, 30, 50, "DUMMY", 2, getRandomColor()),
  new SMR(road.getLaneCenter(0), -300, 30, 50, "DUMMY", 1.5, getRandomColor()),
  new SMR(road.getLaneCenter(2), -300, 30, 50, "DUMMY", 1.5, getRandomColor()),
  new SMR(road.getLaneCenter(0), -500, 30, 50, "DUMMY", 2, getRandomColor()),
  new SMR(road.getLaneCenter(1), -500, 30, 50, "DUMMY", 2, getRandomColor()),
  new SMR(road.getLaneCenter(1), -700, 30, 50, "DUMMY", 1.6, getRandomColor()),
  new SMR(road.getLaneCenter(2), -700, 30, 50, "DUMMY", 2, getRandomColor()),
];

animate();

function save() {
  localStorage.setItem("bestBrain", JSON.stringify(bestSMR.brain));
}

function discard() {
  localStorage.removeItem("bestBrain");
}

function generateSMRs(N) {
  const smrs = [];
  for (let i = 1; i <= N; i++) {
    smrs.push(new SMR(road.getLaneCenter(1), 100, 30, 50, "AI"));
  }
  return smrs;
}

function animate(time) {
  for (let i = 0; i < traffic.length; i++) {
    traffic[i].update(road.borders, []);
  }
  for (let i = 0; i < smrs.length; i++) {
    smrs[i].update(road.borders, traffic);
  }
  bestSMR = smrs.find((c) => c.y == Math.min(...smrs.map((c) => c.y)));

  mainCanvas.height = window.innerHeight;
  networkCanvas.height = window.innerHeight;

  mainCtx.save();
  mainCtx.translate(0, -bestSMR.y + mainCanvas.height * 0.7);

  road.draw(mainCtx);
  for (let i = 0; i < traffic.length; i++) {
    traffic[i].draw(mainCtx);
  }
  mainCtx.globalAlpha = 0.2;
  for (let i = 0; i < smrs.length; i++) {
    smrs[i].draw(mainCtx);
  }
  mainCtx.globalAlpha = 1;
  bestSMR.draw(mainCtx, true);

  mainCtx.restore();

  networkCtx.lineDashOffset = -time / 50;
  Visualizer.drawNetwork(networkCtx, bestSMR.brain);
  requestAnimationFrame(animate);
}
