/**
 * Geometry inside an API card: operations in columns on the left, schemas on the right.
 * The card is sized from the counts in the snapshot, before any details are loaded, and the
 * children are later placed into exactly that box. If a newer spec has more items than the
 * snapshot counted, they are drawn smaller rather than pushing the card out, so nothing on
 * the board moves when details arrive.
 */

export const API_GRID = {
  band: 32,
  pad: 12,
  gap: 6,
  zoneGap: 18,
  rows: 10,
  op: { w: 196, h: 26 },
  schema: { w: 170, h: 28 },
  min: { w: 180, h: 64 },
};

interface Zone {
  cols: number;
  rows: number;
  w: number;
  h: number;
}

function zone(n: number, cell: { w: number; h: number }, rows = API_GRID.rows): Zone {
  if (!n) return { cols: 0, rows: 0, w: 0, h: 0 };
  const cols = Math.ceil(n / rows);
  const r = Math.min(n, rows);
  return { cols, rows: r, w: cols * cell.w + (cols - 1) * API_GRID.gap, h: r * cell.h + (r - 1) * API_GRID.gap };
}

export function apiCardSize(operations: number, schemas: number): { w: number; h: number } {
  const o = zone(operations, API_GRID.op);
  const s = zone(schemas, API_GRID.schema);
  const inner = o.w + s.w + (o.w && s.w ? API_GRID.zoneGap : 0);
  return {
    w: Math.max(API_GRID.min.w, Math.ceil(inner + 2 * API_GRID.pad)),
    h: Math.max(API_GRID.min.h, Math.ceil(API_GRID.band + API_GRID.pad + Math.max(o.h, s.h) + API_GRID.pad)),
  };
}

export interface Cell {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Cells for the loaded operations and schemas inside a card of size `box`. Column-major. */
export function apiCells(box: { w: number; h: number }, actual: { operations: number; schemas: number }): { operations: Cell[]; schemas: Cell[] } {
  const zones = (ops: number, schs: number) => {
    const o = zone(ops, API_GRID.op);
    const s = zone(schs, API_GRID.schema);
    return { o, s, w: o.w + s.w + (o.w && s.w ? API_GRID.zoneGap : 0), h: Math.max(o.h, s.h) };
  };
  const want = zones(actual.operations, actual.schemas);
  const avail = { w: box.w - 2 * API_GRID.pad, h: box.h - API_GRID.band - 2 * API_GRID.pad };
  // Fit, don't grow: scale everything down if the new spec has more items than reserved.
  const scale = Math.min(1, avail.w / Math.max(1, want.w), avail.h / Math.max(1, want.h));
  const x0 = API_GRID.pad;
  const y0 = API_GRID.band + API_GRID.pad;
  const cells = (n: number, cell: { w: number; h: number }, dx: number): Cell[] =>
    Array.from({ length: n }, (_, i) => {
      const c = Math.floor(i / API_GRID.rows);
      const r = i % API_GRID.rows;
      return {
        x: x0 + (dx + c * (cell.w + API_GRID.gap)) * scale,
        y: y0 + r * (cell.h + API_GRID.gap) * scale,
        w: cell.w * scale,
        h: cell.h * scale,
      };
    });
  return {
    operations: cells(actual.operations, API_GRID.op, 0),
    schemas: cells(actual.schemas, API_GRID.schema, want.o.w ? want.o.w + API_GRID.zoneGap : 0),
  };
}
