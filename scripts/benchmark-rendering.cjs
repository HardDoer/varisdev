/* global process, __dirname, window, document, console */
// Run with Electron: electron scripts/benchmark-rendering.cjs
const {mkdtempSync, rmSync, writeFileSync} = require('node:fs');
const {tmpdir} = require('node:os');
const {join, resolve} = require('node:path');
const {pathToFileURL} = require('node:url');
const {app, BrowserWindow} = require('electron');

const directory = mkdtempSync(join(tmpdir(), 'varisdev-render-benchmark-'));
app.setPath('userData', join(directory, 'profile'));
app.setPath('sessionData', join(directory, 'session'));
let browser;

async function benchmark(moduleUrl) {
  const {createFactoryScene} = await import(moduleUrl);
  let clock = 1000;
  let nextFrame = 0;
  const callbacks = new Map();
  Object.defineProperty(document, 'hidden', {get: () => false});
  window.requestAnimationFrame = callback => {
    callbacks.set(++nextFrame, callback);
    return nextFrame;
  };
  window.cancelAnimationFrame = id => callbacks.delete(id);
  window.ResizeObserver = window.IntersectionObserver = class {
    observe() {}
    disconnect() {}
  };
  const canvas = document.querySelector('canvas');
  const gl = canvas.getContext('webgl');
  if (!gl) throw new Error('WebGL is unavailable');
  let uploads = 0;
  let allocations = 0;
  let paints = 0;
  for (const method of ['bufferData', 'bufferSubData', 'clear']) {
    const original = gl[method].bind(gl);
    gl[method] = (...args) => {
      if (method === 'clear') paints++;
      else {
        if (method === 'bufferData') allocations++;
        const data = args[method === 'bufferData' ? 1 : 2];
        uploads += data?.byteLength || 0;
      }
      return original(...args);
    };
  }
  const advance = (step = 50) => {
    clock += step;
    const pending = [...callbacks.values()];
    callbacks.clear();
    const start = window.performance.now();
    for (const callback of pending) callback(clock);
    const elapsed = window.performance.now() - start;
    // Drain the GPU outside the CPU timer so a busy command queue cannot
    // contaminate the next frame. This measures frame work, not display FPS.
    gl.finish();
    return elapsed;
  };
  const results = [];
  for (const agents of [0, 6, 8]) {
    const scene = createFactoryScene(canvas);
    if (!scene) throw new Error('Scene initialization failed');
    scene.update({
      session: {id: 'benchmark', status: 'running', activity: 'Using tools'},
      agents: Array.from({length: agents}, (_, i) => ({
        id: `agent-${i}`,
        status: 'running',
      })),
    });
    for (let i = 0; i < 90; i++) advance();
    uploads = allocations = paints = 0;
    const samples = Array.from({length: 180}, () => advance()).sort(
      (a, b) => a - b,
    );
    const result = {
      agents,
      medianCpuMs: Number(samples[90].toFixed(3)),
      p95CpuMs: Number(samples[171].toFixed(3)),
      uploadKiBPerPaint: Math.round(uploads / 1024 / paints),
      bufferAllocations: allocations,
    };
    paints = 0;
    for (let i = 0; i < 60; i++) advance(1000 / 60);
    result.paintsPer60Callbacks = paints;
    scene.dispose();
    results.push(result);
  }
  return {userAgent: window.navigator.userAgent, results};
}

app
  .whenReady()
  .then(async () => {
    browser = new BrowserWindow({
      show: false,
      width: 800,
      height: 520,
      webPreferences: {backgroundThrottling: false},
    });
    const page = join(directory, 'scene.html');
    writeFileSync(
      page,
      `<!doctype html><html><head><style>
      html, body { margin: 0; background: #101b20; overflow: hidden; }
      canvas { display: block; width: 800px; height: 520px; }
      </style></head><body><canvas aria-label="Rendering benchmark"></canvas></body></html>`,
    );
    await browser.loadFile(page);
    const moduleUrl = pathToFileURL(
      resolve(__dirname, '../assets/dashboard/factory-scene.js'),
    ).href;
    const result = await browser.webContents.executeJavaScript(
      `(${benchmark.toString()})(${JSON.stringify(moduleUrl)})`,
    );
    console.log(JSON.stringify(result, null, 2));
  })
  .catch(error => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => {
    browser?.destroy();
    rmSync(directory, {recursive: true, force: true});
    app.exit(process.exitCode || 0);
  });
