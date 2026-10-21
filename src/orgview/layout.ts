import { orderByAffinity } from '../layout/affinity';
import { groupOf, within, type Card, type CardKind, type OrgGraph } from './graph';

/**
 * Geometry of the board. Every card is a fixed tile in its own units; a container's children sit
 * on a grid inside it, shrunk to fit below its header. Siblings are the same size, so the board
 * reads as an even grid at every level, and nothing moves when a card opens: its inside fills in.
 */

export const TILE: Record<CardKind, { w: number; h: number }> = {
  group: { w: 720, h: 372 },
  service: { w: 300, h: 240 },
  api: { w: 260, h: 150 },
};
/** Header band of an open container, and the padding around its grid, in its own units. */
export const HEAD: Record<CardKind, number> = { group: 56, service: 34, api: 0 };
const PAD: Record<CardKind, number> = { group: 24, service: 12, api: 0 };

/** An open API: header, operation rows on the left, schemas on the right. Its own units. */
export const API_OPEN = { w: 640, head: 76, row: 32, opsW: 400, gap: 24, pad: 18, maxRows: 40 };

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Geo {
  /** Position inside the parent's interior (world position for top-level cards), own units. */
  x: number;
  y: number;
  w: number;
  h: number;
  /** World units per own unit. */
  ws: number;
  /** Where the card sits on the board. */
  abs: Rect;
  /** Containers: where the children's grid sits, and how much it is shrunk. */
  interior?: { x: number; y: number; scale: number; w: number; h: number };
}

/** Best grid for `n` equal tiles in an area: the one that lets them be largest. */
function grid(n: number, tile: { w: number; h: number }, area: { w: number; h: number }, gap: { x: number; y: number }) {
  let best = { cols: 1, rows: n, scale: 0, w: 0, h: 0 };
  for (let cols = 1; cols <= n; cols++) {
    const rows = Math.ceil(n / cols);
    const w = cols * tile.w + (cols - 1) * gap.x;
    const h = rows * tile.h + (rows - 1) * gap.y;
    const scale = Math.min(area.w / w, area.h / h);
    if (scale > best.scale + 1e-9) best = { cols, rows, scale, w, h };
  }
  return best;
}

/** Interior size of an open API, from its operation and schema counts. */
export function apiInterior(ops: number, schemas: number): { w: number; h: number; scale: number } {
  const rows = Math.min(API_OPEN.maxRows, Math.max(ops, schemas, 1));
  const w = API_OPEN.w;
  const h = API_OPEN.head + (rows + 1) * API_OPEN.row + API_OPEN.pad;
  const t = TILE.api;
  return { w, h, scale: Math.min(1, (t.w - 12) / w, (t.h - 12) / h) };
}

export function layoutOrg(graph: OrgGraph): Map<string, Geo> {
  const geo = new Map<string, Geo>();

  const place = (id: string, x: number, y: number, abs: Rect, ws: number) => {
    const c = graph.cards.get(id)!;
    const t = TILE[c.kind];
    const g: Geo = { x, y, w: t.w, h: t.h, ws, abs };
    geo.set(id, g);
    if (!c.children.length) return;
    const kids = order.get(id) ?? c.children.map((k) => graph.cards.get(k)!);
    const tile = { w: Math.max(...kids.map((k) => TILE[k.kind].w)), h: Math.max(...kids.map((k) => TILE[k.kind].h)) };
    const gap = { x: Math.round(tile.w * 0.14), y: Math.round(tile.h * 0.3) };
    const area = { w: t.w - 2 * PAD[c.kind], h: t.h - HEAD[c.kind] - PAD[c.kind] };
    const best = grid(kids.length, tile, area, gap);
    const scale = Math.min(1, best.scale);
    const ix = PAD[c.kind] + (area.w - best.w * scale) / 2;
    const iy = HEAD[c.kind] + (area.h - best.h * scale) / 2;
    g.interior = { x: ix, y: iy, scale, w: best.w, h: best.h };
    // Column by column, so what is called from outside sits on the left and what calls out on the right.
    kids.forEach((k, i) => {
      const kx = Math.floor(i / best.rows) * (tile.w + gap.x);
      const ky = (i % best.rows) * (tile.h + gap.y);
      const kws = ws * scale;
      place(k.id, kx, ky, { x: abs.x + (ix + kx * scale) * ws, y: abs.y + (iy + ky * scale) * ws, w: TILE[k.kind].w * kws, h: TILE[k.kind].h * kws }, kws);
    });
  };

  // Inside a card: called from outside first, calling out last; lines then stay short.
  const order = new Map<string, Card[]>();
  for (const c of graph.cards.values()) {
    if (!c.children.length) continue;
    const called = new Set<string>();
    const calls = new Set<string>();
    for (const g of graph.grants) {
      const consumer = graph.consumerCard(g);
      const apiIn = within(graph, g.api, c.id);
      const consumerIn = within(graph, consumer, c.id);
      if (apiIn === consumerIn) continue;
      const kid = c.children.find((k) => within(graph, apiIn ? g.api : consumer, k));
      if (kid) (apiIn ? called : calls).add(kid);
    }
    const rank = (id: string) => (called.has(id) ? 0 : calls.has(id) ? 2 : 1);
    order.set(
      c.id,
      c.children.map((k) => graph.cards.get(k)!).sort((a, b) => rank(a.id) - rank(b.id) || a.name.localeCompare(b.name)),
    );
  }

  // Top level: strongly connected groups next to each other, on a grid about twice as wide as tall.
  const weight = new Map<string, number>();
  for (const gr of graph.grants) {
    const a = groupOf(graph, graph.consumerCard(gr), gr.consumer);
    const b = groupOf(graph, gr.api, gr.api);
    if (a === b || a.startsWith('ext:')) continue;
    const key = a < b ? `${a}|${b}` : `${b}|${a}`;
    weight.set(key, (weight.get(key) ?? 0) + 1);
  }
  const w = (a: string, b: string) => weight.get(a < b ? `${a}|${b}` : `${b}|${a}`) ?? 0;
  const bands = graph.roots.filter((r) => r.startsWith('__'));
  const rootOrder = [...orderByAffinity(graph.roots.filter((r) => !r.startsWith('__')), w), ...bands.sort()];
  const t = TILE.group;
  const gx = Math.round(t.w * 0.23);
  const gy = Math.round(t.h * 0.45);
  const cols = Math.max(1, Math.min(rootOrder.length, Math.round(Math.sqrt((rootOrder.length * 2.2 * (t.h + gy)) / (t.w + gx)))));
  rootOrder.forEach((id, i) => {
    const x = (i % cols) * (t.w + gx);
    const y = Math.floor(i / cols) * (t.h + gy);
    place(id, x, y, { x, y, w: t.w, h: t.h }, 1);
  });
  return geo;
}

/** Bounds of the top-level cards. */
export function boardBounds(graph: OrgGraph, geo: Map<string, Geo>): Rect {
  const rs = graph.roots.map((r) => geo.get(r)!.abs);
  const x = Math.min(...rs.map((r) => r.x));
  const y = Math.min(...rs.map((r) => r.y));
  return { x, y, w: Math.max(...rs.map((r) => r.x + r.w)) - x, h: Math.max(...rs.map((r) => r.y + r.h)) - y };
}
