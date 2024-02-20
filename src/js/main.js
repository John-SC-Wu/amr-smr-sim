const canvas = document.getElementById("my-canvas");
canvas.width = 200;

const ctx = canvas.getContext("2d");
const road = new Road(canvas.width / 2, canvas.width * 0.9);
const smr = new SMR(road.getLaneCenter(1), 100, 30, 50);

function animate() {
  smr.update();

  canvas.height = window.innerHeight;

  ctx.save();
  ctx.translate(0, -smr.y + canvas.height * 0.7);

  road.draw(ctx);
  smr.draw(ctx);

  ctx.restore();
  requestAnimationFrame(animate);
}

animate();
