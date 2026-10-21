import type { ElkNode } from 'elkjs/lib/elk-api';

/** Anything with ELK's `layout` method: the bundled engine in Node, a Web Worker in the browser. */
export interface ElkEngine {
  layout(graph: ElkNode): Promise<ElkNode>;
}
import type { BoardEdge, BoardNode, NodeType } from '../model';
import { textWidth } from './measure';
import { DETAIL_FONT, LEAF } from './sizes';

export { DETAIL_FONT, LEAF };

/** Name band at the top of every container, and side padding. */
export const PAD = { top: 36, side: 20 };



/** Every container is laid out on its own, bottom-up: its children are fixed-size boxes. */
const LAYERED = {
  'elk.algorithm': 'layered',
  'elk.direction': 'RIGHT',
  'elk.randomSeed': '1',
  'elk.separateConnectedComponents': 'true',
  // Unconnected children pack into wide rows instead of one tall column.
  'elk.aspectRatio': '2.6',
  'elk.layered.considerModelOrder.strategy': 'NODES_AND_EDGES',
  'elk.layered.crossingMinimization.strategy': 'LAYER_SWEEP',
  'elk.layered.nodePlacement.strategy': 'NETWORK_SIMPLEX',
  'elk.edgeRouting': 'ORTHOGONAL',
};

/** Gutters are wide enough for a few parallel lines (for routing). */
const CONTAINER_OPTIONS = {
  ...LAYERED,
  'elk.padding': `[top=${PAD.top},left=${PAD.side},bottom=${PAD.side},right=${PAD.side}]`,
  'elk.spacing.nodeNode': '36',
  'elk.layered.spacing.nodeNodeBetweenLayers': '64',
  'elk.spacing.componentComponent': '40',
  'elk.spacing.edgeNode': '18',
  'elk.layered.spacing.edgeNodeBetweenLayers': '20',
};

/** Children of a service (APIs, datastores) sit in a tight column. */
const SERVICE_OPTIONS = {
  ...LAYERED,
  'elk.direction': 'DOWN',
  'elk.aspectRatio': '0.6',
  'elk.padding': `[top=${PAD.top},left=16,bottom=14,right=16]`,
  'elk.spacing.nodeNode': '12',
  'elk.layered.spacing.nodeNodeBetweenLayers': '16',
  'elk.spacing.componentComponent': '12',
};

export function leafSize(n: Pick<BoardNode, 'type' | 'name' | 'detail'>): { w: number; h: number } {
  const spec = LEAF[n.type];
  const text = Math.max(textWidth(n.name, spec.font, 'label'), textWidth(n.detail, DETAIL_FONT, 'body'));
  return { w: Math.ceil(Math.max(spec.minW, spec.pad + spec.chip + 8 + text + spec.end)), h: spec.h };
}

/**
 * Full nested layout, computed once with everything expanded.
 * Mutates x/y/w/h on the nodes to absolute coordinates.
 */
export async function layoutBoard(
  nodes: Map<string, BoardNode>,
  edges: BoardEdge[],
  elk: ElkEngine,
  /** Fixed size for a childless card (e.g. an API reserved from its counts). */
  sizeOf: (n: BoardNode) => { w: number; h: number } | undefined = () => undefined,
): Promise<void> {
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

  const rel = new Map<string, { x: number; y: number }>();
  const layoutContainer = async (n: BoardNode): Promise<void> => {
    for (const c of n.children) {
      const child = nodes.get(c)!;
      if (child.children.length) await layoutContainer(child);
      else Object.assign(child, sizeOf(child) ?? leafSize(child));
    }
    // Connections lifted to this level order the children: one edge per ordered pair.
    const pairs = new Set<string>();
    for (const e of shaping) {
      const a = childUnder(e.from, n.id);
      const b = childUnder(e.to, n.id);
      if (a && b && a !== b) pairs.add(`${a}\u0000${b}`);
    }
    const compact = n.type === 'service' || n.type === 'apigroup';
    const graph: ElkNode = {
      id: n.id,
      layoutOptions: compact ? SERVICE_OPTIONS : CONTAINER_OPTIONS,
      children: n.children.map((c) => ({ id: c, width: nodes.get(c)!.w, height: nodes.get(c)!.h })),
      edges: [...pairs].sort().map((p, i) => {
        const [a, b] = p.split('\u0000');
        return { id: `e${i}`, sources: [a], targets: [b] };
      }),
    };
    const out = await elk.layout(graph);
    for (const c of out.children ?? []) rel.set(c.id, { x: c.x ?? 0, y: c.y ?? 0 });
    const minW = Math.max(LEAF[n.type].minW, textWidth(n.name, 14, 'title') + 2 * PAD.side + 40, textWidth(n.summary, 11, 'body') + 2 * PAD.side);
    n.w = Math.round(Math.max(out.width ?? 0, minW));
    n.h = Math.round(Math.max(out.height ?? 0, 60));
  };

  const roots = [...nodes.values()].filter((n) => n.parent === null).sort((a, b) => a.id.localeCompare(b.id));
  for (const r of roots) {
    if (r.children.length) await layoutContainer(r);
    else Object.assign(r, sizeOf(r) ?? leafSize(r));
  }

  /** Absolute positions from the relative ones. */
  const place = (id: string, x: number, y: number) => {
    const n = nodes.get(id)!;
    n.x = Math.round(x);
    n.y = Math.round(y);
    for (const c of n.children) {
      const p = rel.get(c)!;
      place(c, x + p.x, y + p.y);
    }
  };
  const rootOf = (id: string) => chains.get(id)![chains.get(id)!.length - 1];

  // Top level: order departments so that strongly connected ones sit next to each other,
  // then wrap into rows. The External band stays on the outer (right) edge.
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

  const GAP = 72;
  const items = order.map((id) => nodes.get(id)!);
  const area = items.reduce((a, n) => a + (n.w + GAP) * (n.h + GAP), 0);
  const rowWidth = Math.max(Math.sqrt(area * 1.8), ...items.map((n) => n.w));

  let x = 0;
  let y = 0;
  let rowH = 0;
  let maxX = 0;
  for (const n of items) {
    if (x > 0 && x + n.w > rowWidth) {
      x = 0;
      y += rowH + GAP;
      rowH = 0;
    }
    place(n.id, x, y);
    x += n.w + GAP;
    rowH = Math.max(rowH, n.h);
    maxX = Math.max(maxX, x);
  }
  if (nodes.has('__external')) place('__external', maxX, 0);
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
