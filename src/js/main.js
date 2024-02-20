const mainCanvas = document.getElementById("my-canvas");
mainCanvas.width = 200;
const networkCanvas = document.getElementById("network-canvas");
networkCanvas.width = 300;

const mainCtx = mainCanvas.getContext("2d");
const networkCtx = networkCanvas.getContext("2d");

const road = new Road(mainCanvas.width / 2, mainCanvas.width * 0.9);
const smr = new SMR(road.getLaneCenter(1), 100, 30, 50, "AI");
const traffic = [new SMR(road.getLaneCenter(1), -100, 30, 50, "DUMMY", 2)];

function animate(time) {
  for (let i = 0; i < traffic.length; i++) {
    traffic[i].update(road.borders, []);
  }
  smr.update(road.borders, traffic);

  mainCanvas.height = window.innerHeight;
  networkCanvas.height = window.innerHeight;

  mainCtx.save();
  mainCtx.translate(0, -smr.y + mainCanvas.height * 0.7);

  road.draw(mainCtx);
  for (let i = 0; i < traffic.length; i++) {
    traffic[i].draw(mainCtx, "red");
  }
  smr.draw(mainCtx, "blue");

  mainCtx.restore();

  networkCtx.lineDashOffset = -time / 50;
  Visualizer.drawNetwork(networkCtx, smr.brain);

  requestAnimationFrame(animate);
}

animate();
