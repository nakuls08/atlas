/**
 * Browses a Spec0 org graph like a person would (zoom into a few areas, pan around) and
 * reports the requests the page made, from the network meter.
 *   tsx scripts/session.ts <index.html> [screenshot.png]
 */
import { resolve } from 'node:path';
import { chromium } from 'playwright-core';

const [file, png] = process.argv.slice(2);
const browser = await chromium.launch({ executablePath: process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await page.goto(`file://${resolve(file)}`);
await page.waitForSelector('svg.board');
await page.waitForTimeout(600);
const zoomAt = async (x: number, y: number, steps: number, dir: 1 | -1) => {
  await page.mouse.move(x, y);
  await page.keyboard.down('Control');
  for (let i = 0; i < steps; i++) {
    await page.mouse.wheel(0, -12 * dir);
    await page.waitForTimeout(16);
  }
  await page.keyboard.up('Control');
  await page.waitForTimeout(500);
};
const pan = async (dx: number, dy: number) => {
  for (let i = 0; i < 20; i++) {
    await page.mouse.wheel(dx / 20, dy / 20);
    await page.waitForTimeout(16);
  }
  await page.waitForTimeout(500);
};
for (const [x, y] of [[500, 300], [900, 500], [700, 650]] as const) {
  await zoomAt(x, y, 70, 1);
  await pan(500, 200);
  await pan(-300, 300);
  await zoomAt(720, 450, 70, -1);
}
await zoomAt(720, 450, 90, 1);
await pan(800, 0);
await page.waitForTimeout(800);
const meter = await page.evaluate(`document.querySelector('.netmeter')?.textContent ?? ''`);
const cards = await page.evaluate(`document.querySelectorAll('.t-operation, .t-schema').length`);
if (png) await page.screenshot({ path: png });
await browser.close();
console.log(`${meter}\nloaded operation and schema cards: ${cards}`);
