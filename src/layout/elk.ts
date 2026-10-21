import type { ElkNode } from 'elkjs/lib/elk-api';

/** Anything with ELK's `layout` method: the bundled engine in Node, a Web Worker in the browser. */
export interface ElkEngine {
  layout(graph: ElkNode): Promise<ElkNode>;
}
import type { BoardEdge, BoardNode, NodeType } from '../model';
import { textWidth } from './measure';
import { DETAIL_FONT, LEAF } from './sizes';

export { DETAIL_FONT, LEAF };

/** Name band at the top of every container, in the container's own (unscaled) units. */
export const PAD = { top: 36, side: 32 };

/** Every container is laid out on its own, bottom-up: its children are fixed-size boxes. */
const LAYERED = {
  'elk.algorithm': 'layered',
  'elk.direction': 'RIGHT',
  'elk.randomSeed': '1',
  'elk.separateConnectedComponents': 'true',
  'elk.layered.considerModelOrder.strategy': 'NODES_AND_EDGES',
  'elk.layered.crossingMinimization.strategy': 'LAYER_SWEEP',
  'elk.layered.nodePlacement.strategy': 'NETWORK_SIMPLEX',
  'elk.edgeRouting': 'ORTHOGONAL',
};

/** Cards drawn as boxes that can hold other cards. They share one tile size with their siblings. */
const BOX_TYPES = new Set<NodeType>(['department', 'domain', 'system', 'team', 'band', 'service', 'apigroup']);
/** Box cards drawn with a type chip and a left-aligned name rather than a centred title. */
const CHIP_BOXES = new Set<NodeType>(['service', 'apigroup', 'api']);

const isBox = (n: BoardNode) => BOX_TYPES.has(n.type) || n.children.length > 0 || !!n.lazy;

/**
 * Tile a box card would like on its own: room for its name at the closed-card size, about 5:3.
 * Siblings take the largest of theirs, so every box at a level is the same size.
 */
function boxTile(n: BoardNode): { w: number; h: number } {
  if (CHIP_BOXES.has(n.type)) {
    const w = Math.max(220, Math.ceil(12 + 26 + 8 + textWidth(n.name, 17, 'label') + 18));
    return { w, h: Math.max(96, Math.round(w * 0.45)) };
  }
  const w = Math.max(280, Math.ceil(textWidth(n.name, 24, 'title') + 2 * 44));
  return { w, h: Math.max(170, Math.round(w * 0.6)) };
}

export function leafSize(n: Pick<BoardNode, 'type' | 'name' | 'detail'>): { w: number; h: number } {
  const spec = LEAF[n.type];
  const text = Math.max(textWidth(n.name, spec.font, 'label'), textWidth(n.detail, DETAIL_FONT, 'body'));
  return { w: Math.ceil(Math.max(spec.minW, spec.pad + spec.chip + 8 + text + spec.end)), h: spec.h };
}

/** Equal sizes within a group of siblings: boxes together, other leaves by type. */
function equalise(children: BoardNode[]): Map<string, { w: number; h: number }> {
  const groups = new Map<string, Array<{ id: string; w: number; h: number }>>();
  for (const c of children) {
    const key = isBox(c) ? 'box' : c.type;
    const size = isBox(c) ? boxTile(c) : leafSize(c);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push({ id: c.id, ...size });
  }
  const out = new Map<string, { w: number; h: number }>();
  for (const list of groups.values()) {
    const w = Math.max(...list.map((x) => x.w));
    const h = Math.max(...list.map((x) => x.h));
    for (const x of list) out.set(x.id, { w, h });
  }
  return out;
}

const round = (v: number) => Math.round(v * 1e4) / 1e4;

/**
 * Full nested layout, computed once with everything expanded. Mutates x/y/w/h/s on the nodes to
 * absolute coordinates.
 *
 * Siblings are equal tiles. A container's children are laid out in their own space and then
 * shrunk to fit inside its tile, below its name band, so a department with forty domains is the
 * same size as one with four; its contents are simply drawn smaller and come into view as you
 * zoom in. `s` records how much a card is shrunk: it is drawn at w/s × h/s and scaled by s.
 */
export async function layoutBoard(nodes: Map<string, BoardNode>, edges: BoardEdge[], elk: ElkEngine): Promise<void> {
  const chain = (id: string): string[] => {
    const out: string[] = [];
    for (let cur: string | null = id; cur; cur = nodes.get(cur)!.parent) out.push(cur);
    return out;
  };
  const chains = new Map([...nodes.keys()].map((id) => [id, chain(id)]));

  // Platform links are hidden by default, so they must not pull the layout around.
  const shaping = edges.filter((e) => !e.platform);

  /** Child of `container` that contains `id`, or undefined if `id` is outside it. */
  const childUnder = (id: string, container: string): string | undefined => {
    const c = chains.get(id)!;
    const i = c.indexOf(container);
    return i > 0 ? c[i - 1] : undefined;
  };

  /** Natural (unscaled) tile of each card, and its children's positions within its content. */
  const tile = new Map<string, { w: number; h: number }>();
  const content = new Map<string, { w: number; h: number }>();
  const rel = new Map<string, { x: number; y: number }>();

  const layoutContainer = async (n: BoardNode): Promise<void> => {
    const kids = n.children.map((c) => nodes.get(c)!);
    for (const c of kids) if (c.children.length) await layoutContainer(c);
    const sizes = equalise(kids);
    for (const [id, s] of sizes) tile.set(id, s);

    // Connections lifted to this level order the children: one edge per ordered pair.
    const pairs = new Set<string>();
    for (const e of shaping) {
      const a = childUnder(e.from, n.id);
      const b = childUnder(e.to, n.id);
      if (a && b && a !== b) pairs.add(`${a}\u0000${b}`);
    }
    // Room between cards in proportion to them: wide enough for lines, arrowheads and counts.
    const big = [...sizes.values()].reduce((m, s) => (s.w * s.h > m.w * m.h ? s : m), { w: 0, h: 0 });
    const gap = Math.round(Math.max(24, big.h * 0.7));
    const own = boxTile(n);
    const options = {
      ...LAYERED,
      ...(CHIP_BOXES.has(n.type) ? { 'elk.direction': 'DOWN' } : {}),
      // Fill the container's own tile, so its contents are shrunk as little as possible.
      'elk.aspectRatio': (own.w / (own.h - PAD.top)).toFixed(2),
      'elk.padding': `[top=${gap * 0.6},left=${gap * 0.6},bottom=${gap * 0.6},right=${gap * 0.6}]`,
      'elk.spacing.nodeNode': String(gap),
      'elk.layered.spacing.nodeNodeBetweenLayers': String(Math.round(Math.max(gap, big.w * 0.45))),
      'elk.spacing.componentComponent': String(gap),
      'elk.spacing.edgeNode': String(Math.round(gap * 0.4)),
      'elk.layered.spacing.edgeNodeBetweenLayers': String(Math.round(gap * 0.4)),
    };
    const graph: ElkNode = {
      id: n.id,
      layoutOptions: options,
      children: kids.map((c) => ({ id: c.id, width: sizes.get(c.id)!.w, height: sizes.get(c.id)!.h })),
      edges: [...pairs].sort().map((p, i) => {
        const [a, b] = p.split('\u0000');
        return { id: `e${i}`, sources: [a], targets: [b] };
      }),
    };
    const out = await elk.layout(graph);
    for (const c of out.children ?? []) rel.set(c.id, { x: c.x ?? 0, y: c.y ?? 0 });
    content.set(n.id, { w: out.width ?? 0, h: out.height ?? 0 });
  };

  const roots = [...nodes.values()].filter((n) => n.parent === null).sort((a, b) => a.id.localeCompare(b.id));
  for (const r of roots) if (r.children.length) await layoutContainer(r);
  // Top-level cards are one size too, whatever they hold.
  const rootTile = { w: Math.max(...roots.map((r) => boxTile(r).w)), h: Math.max(...roots.map((r) => boxTile(r).h)) };
  for (const r of roots) tile.set(r.id, rootTile);

  /** Absolute positions: each container's contents are shrunk to fit below its name band. */
  const place = (id: string, x: number, y: number, s: number) => {
    const n = nodes.get(id)!;
    const t = tile.get(id)!;
    Object.assign(n, { x: round(x), y: round(y), w: round(t.w * s), h: round(t.h * s), s: round(s) });
    if (!n.children.length) return;
    const c = content.get(id)!;
    const room = { w: t.w, h: t.h - PAD.top };
    const k = Math.min(1, room.w / Math.max(1, c.w), room.h / Math.max(1, c.h));
    const ox = (room.w - c.w * k) / 2;
    const oy = PAD.top + (room.h - c.h * k) / 2;
    for (const cid of n.children) {
      const p = rel.get(cid)!;
      place(cid, x + (ox + p.x * k) * s, y + (oy + p.y * k) * s, s * k);
    }
  };
  const rootOf = (id: string) => chains.get(id)![chains.get(id)!.length - 1];

  // Top level: order departments so that strongly connected ones sit next to each other,
  // then lay them out on a grid. The External band stays on the outer (right) edge.
  const weight = new Map<string, number>();
  for (const e of shaping) {
    const a = rootOf(e.from);
    const b = rootOf(e.to);
    if (a === b) continue;
    const key = a < b ? `${a}|${b}` : `${b}|${a}`;
    weight.set(key, (weight.get(key) ?? 0) + 1);
  }
  const w = (a: string, b: string) => weight.get(a < b ? `${a}|${b}` : `${b}|${a}`) ?? 0;
  // Real groups first, chained by affinity; catch-all bands (teams list, "No domain") after them.
  const isBand = (r: BoardNode) => r.type === 'band';
  const order = [
    ...orderByAffinity(roots.filter((r) => !isBand(r)).map((r) => r.id), w),
    ...roots.filter((r) => isBand(r) && r.id !== '__external').map((r) => r.id).sort(),
  ];

  const gapX = Math.round(rootTile.h * 0.6);
  const gapY = Math.round(rootTile.h * 0.6);
  // About twice as wide as tall, like a screen.
  const cols = Math.max(1, Math.round(Math.sqrt((order.length * 2 * (rootTile.h + gapY)) / (rootTile.w + gapX))));
  order.forEach((id, i) => place(id, (i % cols) * (rootTile.w + gapX), Math.floor(i / cols) * (rootTile.h + gapY), 1));
  if (nodes.has('__external')) place('__external', Math.min(cols, order.length) * (rootTile.w + gapX), 0, 1);
}

/**
 * Greedy chain: start from the most connected, then repeatedly append the one most connected
 * to the last placed (ties: to anything placed, then by id). Deterministic.
 */
export function orderByAffinity(ids: string[], w: (a: string, b: string) => number): string[] {
  const rest = [...ids].sort();
  if (!rest.length) return [];
  const total = (id: string) => rest.reduce((s, o) => s + (o === id ? 0 : w(id, o)), 0);
  rest.sort((a, b) => total(b) - total(a) || a.localeCompare(b));
  const out = [rest.shift()!];
  while (rest.length) {
    const last = out[out.length - 1];
    const score = (id: string) => w(last, id) * 1000 + out.reduce((s, o) => s + w(o, id), 0);
    rest.sort((a, b) => score(b) - score(a) || a.localeCompare(b));
    out.push(rest.shift()!);
  }
  return out;
}
