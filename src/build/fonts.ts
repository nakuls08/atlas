import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

/**
 * Fonts embedded in the board (it must work offline from file://). Latin subsets only.
 *   Fraunces  display serif: department and domain titles (Studio style)
 *   Inter     labels, body text and UI
 *   JetBrains Mono  ids and technical fields
 *   Caveat    handwriting: titles and labels in the Sketch style
 */
export const FACES = [
  { key: 'fraunces-600', family: 'Atlas Display', weight: 600, file: '@fontsource/fraunces/files/fraunces-latin-600-normal.woff2' },
  { key: 'inter-400', family: 'Atlas Sans', weight: 400, file: '@fontsource/inter/files/inter-latin-400-normal.woff2' },
  { key: 'inter-500', family: 'Atlas Sans', weight: 500, file: '@fontsource/inter/files/inter-latin-500-normal.woff2' },
  { key: 'inter-600', family: 'Atlas Sans', weight: 600, file: '@fontsource/inter/files/inter-latin-600-normal.woff2' },
  { key: 'inter-700', family: 'Atlas Sans', weight: 700, file: '@fontsource/inter/files/inter-latin-700-normal.woff2' },
  { key: 'mono-400', family: 'Atlas Mono', weight: 400, file: '@fontsource/jetbrains-mono/files/jetbrains-mono-latin-400-normal.woff2' },
  { key: 'caveat-500', family: 'Atlas Hand', weight: 500, file: '@fontsource/caveat/files/caveat-latin-500-normal.woff2' },
  { key: 'caveat-700', family: 'Atlas Hand', weight: 700, file: '@fontsource/caveat/files/caveat-latin-700-normal.woff2' },
] as const;

/** Geist, for the org graph board. */
export const ORG_FACES = [
  { key: 'geist-400', family: 'Geist', weight: 400, file: '@fontsource/geist-sans/files/geist-sans-latin-400-normal.woff2' },
  { key: 'geist-500', family: 'Geist', weight: 500, file: '@fontsource/geist-sans/files/geist-sans-latin-500-normal.woff2' },
  { key: 'geist-600', family: 'Geist', weight: 600, file: '@fontsource/geist-sans/files/geist-sans-latin-600-normal.woff2' },
  { key: 'geist-mono-400', family: 'Geist Mono', weight: 400, file: '@fontsource/geist-mono/files/geist-mono-latin-400-normal.woff2' },
  { key: 'geist-mono-500', family: 'Geist Mono', weight: 500, file: '@fontsource/geist-mono/files/geist-mono-latin-500-normal.woff2' },
] as const;

export function fontFaceCss(faces: ReadonlyArray<{ family: string; weight: number; file: string }> = FACES): string {
  return faces.map(
    (f) =>
      `@font-face{font-family:'${f.family}';font-weight:${f.weight};font-style:normal;font-display:block;` +
      `src:url(data:font/woff2;base64,${readFileSync(require.resolve(f.file)).toString('base64')}) format('woff2')}`,
  ).join('\n');
}
