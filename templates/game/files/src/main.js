// Starter scene — ask Claude to replace it with your game.
const canvas = document.getElementById('game');
const ctx = canvas.getContext('2d');
let w = 0;
let h = 0;

function resize() {
  const dpr = window.devicePixelRatio || 1;
  w = canvas.clientWidth;
  h = canvas.clientHeight;
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}
window.addEventListener('resize', resize);
resize();

const dots = Array.from({ length: 70 }, () => ({
  x: Math.random(),
  y: Math.random(),
  r: 2 + Math.random() * 5,
  vx: (Math.random() - 0.5) * 0.08,
  vy: (Math.random() - 0.5) * 0.08,
  hue: 70 + Math.random() * 60,
}));

let last = performance.now();
function frame(now) {
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  ctx.fillStyle = '#0b0d12';
  ctx.fillRect(0, 0, w, h);
  for (const d of dots) {
    d.x = (d.x + d.vx * dt + 1) % 1;
    d.y = (d.y + d.vy * dt + 1) % 1;
    ctx.beginPath();
    ctx.fillStyle = `hsla(${d.hue}, 80%, 60%, 0.8)`;
    ctx.arc(d.x * w, d.y * h, d.r, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.fillStyle = '#e6e8ee';
  ctx.font = '600 28px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('Your game starts here', w / 2, h / 2 - 8);
  ctx.fillStyle = '#9aa3b5';
  ctx.font = '16px system-ui, sans-serif';
  ctx.fillText('Describe the game you want in the chat — Claude builds it.', w / 2, h / 2 + 24);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
