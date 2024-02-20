const canvas = document.getElementById("my-canvas");
canvas.width = 200;

const ctx = canvas.getContext("2d");
const road = new Road(canvas.width / 2, canvas.width * 0.9);
const smr = new SMR(road.getLaneCenter(1), 100, 30, 50, "KEYS");
const traffic = [new SMR(road.getLaneCenter(1), -100, 30, 50, "DUMMY", 2)];

function animate() {
  for (let i = 0; i < traffic.length; i++) {
    traffic[i].update(road.borders, []);
  }
  smr.update(road.borders, traffic);

  canvas.height = window.innerHeight;

  ctx.save();
  ctx.translate(0, -smr.y + canvas.height * 0.7);

  road.draw(ctx);
  for (let i = 0; i < traffic.length; i++) {
    traffic[i].draw(ctx, "red");
  }
  smr.draw(ctx, "blue");

  ctx.restore();
  requestAnimationFrame(animate);
}

animate();
