/**
 * Writes src/layout/metrics.json: advance widths (per 1 px of font size) for the embedded fonts,
 * so build-time layout measures text exactly as the browser will draw it (D-4).
 * Re-run after changing the font set: tsx scripts/gen-metrics.ts
 */
import { writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import * as fontkit from 'fontkit';
import { FACES } from '../src/build/fonts';

const require = createRequire(import.meta.url);
const out: Record<string, { def: number; adv: Record<string, number> }> = {};
for (const face of FACES) {
  const font = fontkit.openSync(require.resolve(face.file));
  const adv: Record<string, number> = {};
  let sum = 0;
  let n = 0;
  for (let c = 32; c < 0x250; c++) {
    if (c >= 127 && c < 160) continue;
    const ch = String.fromCodePoint(c);
    if (!font.hasGlyphForCodePoint(c)) continue;
    const w = font.layout(ch).advanceWidth / font.unitsPerEm;
    adv[ch] = Math.round(w * 1000) / 1000;
    if (c >= 97 && c <= 122) {
      sum += w;
      n++;
    }
  }
  out[face.key] = { def: Math.round((sum / n) * 1000) / 1000, adv };
}
writeFileSync(new URL('../src/layout/metrics.json', import.meta.url), `${JSON.stringify(out)}\n`);
console.log(`wrote metrics for ${Object.keys(out).join(', ')}`);
