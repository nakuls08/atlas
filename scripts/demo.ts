/**
 * Drives the presentation tools in headless Chrome and saves a screenshot per step.
 *   tsx scripts/demo.ts <index.html> <out-dir>
 */
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright-core';

const [file, out] = process.argv.slice(2);
mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ executablePath: process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors: string[] = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.goto(`file://${resolve(file)}`);
await page.waitForSelector('svg.board');
await page.waitForTimeout(800);
const shot = async (name: string, wait = 900) => {
  await page.waitForTimeout(wait);
  await page.screenshot({ path: join(out, `${name}.png`) });
};

await shot('01-overview', 200);

// Tour: checkout. Steps 3 (trace) and 5 (impact).
await page.click('button[title="Guided tours"]');
await shot('02-tours-menu', 300);
await page.click('.tour-list .tour:first-child button');
await shot('03-tour-step1', 1300);
await page.keyboard.press('ArrowRight');
await page.keyboard.press('ArrowRight');
await shot('04-tour-trace', 1400);
await page.keyboard.press('ArrowRight');
await page.keyboard.press('ArrowRight');
await shot('05-tour-impact', 1400);
await page.keyboard.press('ArrowRight');
await shot('06-tour-fanout', 1400);
await page.keyboard.press('Escape');
await page.waitForTimeout(400);

// Laser: sweep across the board.
await page.keyboard.press('f');
await page.waitForTimeout(1200);
await page.keyboard.press('l');
for (let i = 0; i <= 24; i++) await page.mouse.move(500 + i * 18, 420 + Math.sin(i / 3) * 60, { steps: 2 });
await shot('07-laser', 30);

// Spotlight on the centre.
await page.keyboard.press('s');
await page.mouse.move(760, 470);
await shot('08-spotlight', 200);

// Pen: circle something.
await page.keyboard.press('p');
await page.mouse.move(700, 380);
await page.mouse.down();
for (let a = 0; a <= 62; a++) await page.mouse.move(760 + 120 * Math.cos(a / 10), 450 + 70 * Math.sin(a / 10));
await page.mouse.up();
await shot('09-pen', 200);

// Review note on a card.
await page.keyboard.press('Escape');
await page.keyboard.press('n');
const box = await page.locator('[data-id="payments-risk"]').boundingBox();
if (box) await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
await page.keyboard.type('Single point of failure? Ask about PSP failover and idempotency keys.');
await shot('10-note-editor', 300);
await page.keyboard.press('Meta+Enter');
await page.click('button[title="Review notes"]');
await shot('11-notes-drawer', 400);

// Presenter mode.
await page.click('button[title="Review notes"]');
await page.keyboard.press('Escape');
await page.keyboard.press('Shift+P');
await shot('12-presenter', 900);

await browser.close();
if (errors.length) console.error('page errors:\n' + errors.join('\n'));
else console.log('ok');
