/**
 * Screenshots a built board for visual checks.
 *   tsx scripts/shot.ts <index.html> <out.png> [hash] [width] [height]
 */
import { resolve } from 'node:path';
import { chromium } from 'playwright-core';

const [file, out, hash = '', width = '1440', height = '900'] = process.argv.slice(2);
const executablePath = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const browser = await chromium.launch({ executablePath, headless: true });
const page = await browser.newPage({ viewport: { width: Number(width), height: Number(height) }, deviceScaleFactor: 1 });
const errors: string[] = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
await page.goto(`file://${resolve(file)}${hash ? `#${hash}` : ''}`);
await page.waitForSelector('svg.board');
await page.waitForTimeout(700);
// Optional clicks after load, e.g. CLICK="button:has-text('Legend')"
for (const sel of (process.env.CLICK ?? '').split('||').filter(Boolean)) {
  await page.click(sel);
  await page.waitForTimeout(300);
}
await page.screenshot({ path: out });
await browser.close();
if (errors.length) console.error(errors.join('\n'));
