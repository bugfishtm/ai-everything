#!/usr/bin/env node
'use strict';
// Renders a .glb from 4 views (perspective, front, side, top) into one PNG with
// headless Chromium + three.js. Usage: node render.js <model.glb> <out.png> [size] [camera-json]
const fs = require('fs');
const http = require('http');
const path = require('path');

const [, , modelPath, outPath, sizeArg, cameraJson] = process.argv;
const SIZE = Number(sizeArg) || 512;
const THREE_DIR = path.join(__dirname, '..', 'vendor', 'node_modules', 'three');

const PAGE = `<!doctype html><html><head><meta charset="utf-8">
<style>body{margin:0;background:#0d1016;font:13px system-ui,sans-serif;color:#a2abbd}
#grid{display:grid;grid-template-columns:repeat(2,${SIZE}px);gap:6px;padding:6px;width:max-content}
figure{margin:0;position:relative}figcaption{position:absolute;left:8px;top:6px;color:#e7e9ee;text-shadow:0 1px 2px #000}
#info{padding:2px 8px 8px;color:#a2abbd}</style>
<script type="importmap">{"imports":{"three":"/three/build/three.module.js","three/addons/":"/three/examples/jsm/"}}</script>
</head><body><div id="grid"></div><div id="info"></div>
<script type="module">
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
const S = ${SIZE};
const cam = ${cameraJson && cameraJson !== '-' ? cameraJson : 'null'};
const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
renderer.setSize(S, S); renderer.outputColorSpace = THREE.SRGBColorSpace; renderer.toneMapping = THREE.NeutralToneMapping;
const scene = new THREE.Scene(); scene.background = new THREE.Color('#1a1f2a');
const pmrem = new THREE.PMREMGenerator(renderer); scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture; scene.environmentIntensity = 0.5;
const sun = new THREE.DirectionalLight(0xffffff, 1.5); sun.position.set(4, 8, 6); scene.add(sun);
scene.add(new THREE.HemisphereLight(0xffffff, 0x334155, 0.4));
try {
  const gltf = await new GLTFLoader().loadAsync('/model.glb');
  scene.add(gltf.scene);
  const box = new THREE.Box3().setFromObject(gltf.scene);
  const size = box.getSize(new THREE.Vector3()), center = box.getCenter(new THREE.Vector3());
  const maxDim = Math.max(size.x, size.y, size.z) || 1;
  const grid = new THREE.GridHelper(Math.ceil(maxDim * 2), Math.max(2, Math.ceil(maxDim * 2)), 0x55607a, 0x2a3242);
  grid.position.set(center.x, box.min.y, center.z); scene.add(grid);
  const camera = new THREE.PerspectiveCamera(40, 1, maxDim / 500, maxDim * 100);
  const dist = (maxDim / (2 * Math.tan((40 * Math.PI) / 360))) * 1.35;
  const views = [
    ['perspective', cam && cam.position ? null : [1, 0.75, 1.25]],
    ['front (+z)', [0, 0.12, 1]], ['side (+x)', [1, 0.12, 0]], ['top (+y)', [0, 1, 0.0001]],
  ];
  const g = document.getElementById('grid');
  for (const [name, dir] of views) {
    if (dir) {
      const d = new THREE.Vector3(...dir).normalize();
      camera.position.copy(center).addScaledVector(d, dist);
      camera.lookAt(center);
    } else {
      camera.position.set(...cam.position);
      camera.lookAt(new THREE.Vector3(...(cam.target || [center.x, center.y, center.z])));
    }
    camera.updateProjectionMatrix();
    renderer.render(scene, camera);
    const fig = document.createElement('figure');
    fig.innerHTML = '<img width="' + S + '" height="' + S + '"><figcaption>' + name + '</figcaption>';
    fig.querySelector('img').src = renderer.domElement.toDataURL('image/png');
    g.appendChild(fig);
  }
  document.getElementById('info').textContent = 'size ' + size.x.toFixed(2) + ' x ' + size.y.toFixed(2) + ' x ' + size.z.toFixed(2) + ' m (x y z), grid = 1 m';
} catch (e) { document.body.textContent = 'ERROR ' + e.message; }
window.__done = true;
</script></body></html>`;

const server = http.createServer((req, res) => {
  const url = decodeURIComponent(req.url.split('?')[0]);
  let file = null;
  let type = 'application/octet-stream';
  if (url === '/') { res.writeHead(200, { 'content-type': 'text/html' }); res.end(PAGE); return; }
  if (url === '/model.glb') { file = modelPath; type = 'model/gltf-binary'; }
  else if (url.startsWith('/three/')) { file = path.join(THREE_DIR, url.slice(7)); type = 'text/javascript'; }
  if (!file || (url.startsWith('/three/') && !path.resolve(file).startsWith(THREE_DIR))) { res.writeHead(404); res.end(); return; }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'content-type': type }); res.end(data);
  });
});

(async () => {
  const { chromium } = require('playwright');
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  // the image's Chromium wrapper (software WebGL); falls back to Playwright's own lookup
  const exe = [process.env.CHROMIUM_PATH, '/usr/local/bin/chromium'].find((p) => p && fs.existsSync(p));
  const browser = await chromium.launch({ headless: true, executablePath: exe, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  try {
    const page = await browser.newPage({ viewport: { width: SIZE * 2 + 24, height: SIZE * 2 + 60 } });
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    await page.waitForFunction('window.__done === true', null, { timeout: 60000 });
    const text = await page.textContent('body');
    if (text.startsWith('ERROR')) throw new Error(text);
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    await (await page.$('body')).screenshot({ path: outPath });
  } finally {
    await browser.close();
    server.close();
  }
})().catch((e) => { console.error(e.message || e); process.exit(1); });
