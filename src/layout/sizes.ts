import type { NodeType } from '../model';

/**
 * Leaf card sizes per shape, matching the label block drawn by the viewer (src/viewer/shapes.ts):
 * `pad` before the type chip, the chip, an 8-unit gap, then the text; `end` after the text
 * (shape ends such as the tube's rim). `font` is the name size; detail lines are 10.5.
 */
export const LEAF: Record<NodeType, { minW: number; h: number; font: number; pad: number; chip: number; end: number }> = {
  department: { minW: 240, h: 120, font: 14, pad: 16, chip: 0, end: 16 },
  domain: { minW: 200, h: 100, font: 14, pad: 16, chip: 0, end: 16 },
  system: { minW: 180, h: 80, font: 13, pad: 16, chip: 0, end: 16 },
  band: { minW: 200, h: 100, font: 14, pad: 16, chip: 0, end: 16 },
  apigroup: { minW: 150, h: 48, font: 12, pad: 10, chip: 20, end: 14 },
  service: { minW: 160, h: 56, font: 13, pad: 12, chip: 24, end: 16 },
  external: { minW: 150, h: 56, font: 13, pad: 14, chip: 24, end: 16 },
  api: { minW: 130, h: 38, font: 12, pad: 9, chip: 20, end: 18 },
  topic: { minW: 140, h: 40, font: 12, pad: 12, chip: 20, end: 22 },
  channel: { minW: 140, h: 40, font: 12, pad: 16, chip: 20, end: 20 },
  datastore: { minW: 120, h: 62, font: 12, pad: 12, chip: 20, end: 14 },
  team: { minW: 240, h: 120, font: 14, pad: 16, chip: 0, end: 16 },
  operation: { minW: 196, h: 26, font: 11, pad: 6, chip: 0, end: 6 },
  schema: { minW: 170, h: 28, font: 11, pad: 6, chip: 18, end: 6 },
};

export const DETAIL_FONT = 10.5;
