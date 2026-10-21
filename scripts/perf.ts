/**
 * Measures frame rate during pan and zoom, and visibility + edge-lifting time,
 * on a built board, driving the locally installed Chrome.
 *
 *   tsx scripts/perf.ts dist/bench/index.html
 */
import { resolve } from 'node:path';
import { chromium } from 'playwright-core';

const file = resolve(process.argv[2] ?? 'dist/bench/index.html');
const executablePath = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const browser = await chromium.launch({ executablePath, headless: true, args: ['--enable-gpu', '--ignore-gpu-blocklist', '--use-angle=metal'] });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const t0 = Date.now();
await page.goto(`file://${file}`);
await page.waitForSelector('.node');
const firstRender = Date.now() - t0;

// In-page code is passed as strings: tsx's helper injection breaks serialised functions.
await page.evaluate(`(() => {
  const p = window.__atlasPerf;
  p.lodMs.length = 0;
  p.frameMs.length = 0;
  p.edgeMs.length = 0;
  p.classMs.length = 0;
  p.routeMs.length = 0;
  const frames = [];
  window.__frames = frames;
  const tick = (t) => { frames.push(t); requestAnimationFrame(tick); };
  requestAnimationFrame(tick);
})()`);

const cx = 720;
const cy = 470;
await page.mouse.move(cx, cy);
await page.keyboard.down('Control');
for (let i = 0; i < 60; i++) {
  await page.mouse.wheel(0, -12); // pinch in
  await page.waitForTimeout(16);
}
await page.keyboard.up('Control');
for (let i = 0; i < 40; i++) {
  await page.mouse.wheel(18, 10); // two-finger pan
  await page.waitForTimeout(16);
}
await page.keyboard.down('Control');
for (let i = 0; i < 60; i++) {
  await page.mouse.wheel(0, 12); // pinch out
  await page.waitForTimeout(16);
}
await page.keyboard.up('Control');

const result = (await page.evaluate(`(() => {
  const p = window.__atlasPerf;
  const frames = window.__frames;
  const gaps = frames.slice(1).map((t, i) => t - frames[i]);
  const q = (xs, f) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(xs.length * f))] ?? 0;
  return {
    fps: gaps.length ? 1000 / (gaps.reduce((a, b) => a + b, 0) / gaps.length) : 0,
    frameGapP95: q(gaps, 0.95),
    lodP50: q(p.lodMs, 0.5),
    lodP95: q(p.lodMs, 0.95),
    lodMax: Math.max(0, ...p.lodMs),
    updateP95: q(p.frameMs, 0.95),
    edgeP95: q(p.edgeMs, 0.95),
    edgeN: p.edgeMs.length,
    classP95: q(p.classMs, 0.95),
    routeP95: q(p.routeMs, 0.95),
    routeMax: Math.max(0, ...p.routeMs),
    edges: document.querySelectorAll('.edge').length,
    updates: p.lodMs.length,
    nodes: document.querySelectorAll('.node').length,
  };
})()`)) as Record<string, number>;
const stats = await page.evaluate(`JSON.stringify(window.__atlasPerf.stages.map(s => Object.fromEntries(Object.entries(s).map(([k,v]) => [k, Math.round(v*10)/10]))).sort((a,b) => (b.lift+b.prep+b.route+b.build+b.attach)-(a.lift+a.prep+a.route+a.build+a.attach)).slice(0,6))`);
if (process.env.STAGES) console.log('slowest edge redraws:', stats);
await browser.close();

const fmt = (n: number) => n.toFixed(1);
console.log(`first render        ${firstRender} ms        (target ≤ 1500)`);
console.log(`frame rate          ${fmt(result.fps)} fps   (target ≥ 50; p95 frame gap ${fmt(result.frameGapP95)} ms)`);
console.log(`visibility + lift   p50 ${fmt(result.lodP50)} ms · p95 ${fmt(result.lodP95)} ms · max ${fmt(result.lodMax)} ms  (target ≤ 16)`);
console.log(`full update incl. DOM p95 ${fmt(result.updateP95)} ms over ${result.updates} updates, ${result.nodes} cards`);
console.log(`  card classes p95 ${fmt(result.classP95)} ms · edge redraw p95 ${fmt(result.edgeP95)} ms (${result.edgeN} redraws) · routing p95 ${fmt(result.routeP95)} max ${fmt(result.routeMax)} ms · ${result.edges} edges drawn at end`);
