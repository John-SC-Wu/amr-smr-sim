const canvas = document.getElementById('my-canvas');
canvas.width = 200;

const ctx = canvas.getContext('2d');
const smr = new SMR(100, 100, 30, 50);

function animate ()
{
  smr.update();

  canvas.height = window.innerHeight;
  smr.draw(ctx);
  requestAnimationFrame(animate);
}

animate();
