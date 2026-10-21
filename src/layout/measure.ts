import metrics from './metrics.json';

type Face = keyof typeof metrics;

/**
 * Text roles and the faces that may draw them, with the size factor each style applies.
 * Studio draws titles in Fraunces and labels in Inter; Sketch draws both in Caveat at 1.3×.
 * Layout measures with the widest, so a card fits its text in either style.
 */
export const ROLES = {
  title: [
    ['fraunces-600', 1],
    ['caveat-700', 1.3],
  ],
  label: [
    ['inter-600', 1],
    ['caveat-700', 1.3],
  ],
  body: [['inter-400', 1]],
  mono: [['mono-400', 1]],
  tag: [['inter-700', 1]],
} as const satisfies Record<string, ReadonlyArray<readonly [Face, number]>>;

export type Role = keyof typeof ROLES;

/** Exact width from the embedded fonts' advance widths (D-4). */
export function faceWidth(text: string, size: number, face: Face): number {
  const m = metrics[face] as { def: number; adv: Record<string, number> };
  let units = 0;
  for (const ch of text) units += m.adv[ch] ?? m.def;
  return units * size;
}

export function textWidth(text: string, size: number, role: Role = 'label'): number {
  let w = 0;
  for (const [face, scale] of ROLES[role]) w = Math.max(w, faceWidth(text, size * scale, face));
  return Math.ceil(w);
}
