import type { BoardEdge, BoardNode } from '../model';

/**
 * Graph questions asked during architecture reviews:
 *   trace   how does a request or event get from A to B?
 *   impact  if X fails, who is affected (dependents)? What does X need (dependencies)?
 *
 * Both run on the leaf connections plus implicit links the registry implies but doesn't store:
 * an API belongs to its hosting service, a datastore and its owner go together.
 */

interface Arc {
  to: string;
  /** Leaf connection behind this arc; undefined for implicit links. */
  edge?: string;
  /** Implicit links cost no hop: an API and its host count as one stop. */
  weight: 0 | 1;
}

export interface FlowGraph {
  /** Direction requests and data travel: caller → API → host, producer → topic → consumer. */
  flow: Map<string, Arc[]>;
  /** "A depends on B": caller → callee, consumer → topic → producer. */
  deps: Map<string, Arc[]>;
  /** Reverse of `deps`: B → everyone that depends on B. */
  dependents: Map<string, Arc[]>;
}

export function buildFlowGraph(nodes: ReadonlyMap<string, BoardNode>, edges: readonly BoardEdge[]): FlowGraph {
  const flow = new Map<string, Arc[]>();
  const deps = new Map<string, Arc[]>();
  const dependents = new Map<string, Arc[]>();
  const add = (m: Map<string, Arc[]>, a: string, arc: Arc) => {
    if (!m.has(a)) m.set(a, []);
    m.get(a)!.push(arc);
  };
  const dep = (a: string, b: string, edge: string | undefined, weight: 0 | 1) => {
    add(deps, a, { to: b, edge, weight });
    add(dependents, b, { to: a, edge, weight });
  };

  const hostOf = (id: string): string | undefined => {
    for (let p = nodes.get(id)?.parent; p; p = nodes.get(p)?.parent ?? null) if (nodes.get(p)!.type === 'service') return p;
    return undefined;
  };
  /** Where a request to an API lands: its service, or (Spec0, no service yet) its owning team. */
  const landing = (id: string): string | undefined => {
    for (let p = nodes.get(id)?.parent; p; p = nodes.get(p)?.parent ?? null) {
      const t = nodes.get(p)!.type;
      if (t === 'service' || t === 'team') return p;
    }
    return undefined;
  };
  for (const n of nodes.values()) {
    if (n.type === 'operation' && n.parent) {
      // An operation belongs to its API, which counts as the same stop.
      add(flow, n.id, { to: n.parent, weight: 0 });
      dep(n.id, n.parent, undefined, 0);
    }
    if (n.type === 'api') {
      const host = landing(n.id);
      if (!host) continue;
      add(flow, n.id, { to: host, weight: 0 });
      dep(n.id, host, undefined, 0);
    }
    if (n.type === 'datastore') {
      const owner = hostOf(n.id);
      if (!owner) continue;
      add(flow, owner, { to: n.id, weight: 0 });
      dep(owner, n.id, undefined, 0);
    }
  }
  for (const e of edges) {
    add(flow, e.from, { to: e.to, edge: e.id, weight: 1 });
    switch (e.kind) {
      case 'calls':
      case 'calls-unknown':
      case 'reads-writes':
        dep(e.from, e.to, e.id, 1);
        break;
      case 'publishes': // the topic depends on its producer
        dep(e.to, e.from, e.id, 1);
        break;
      case 'consumes': // the consumer depends on the topic
        dep(e.to, e.from, e.id, 1);
        break;
    }
  }
  for (const m of [flow, deps, dependents]) for (const arcs of m.values()) arcs.sort((a, b) => a.to.localeCompare(b.to));
  return { flow, deps, dependents };
}

/** Every card in the subtree of `id` (inclusive). */
export function subtree(nodes: ReadonlyMap<string, BoardNode>, id: string): string[] {
  const out: string[] = [];
  const walk = (x: string) => {
    out.push(x);
    nodes.get(x)?.children.forEach(walk);
  };
  walk(id);
  return out;
}

export interface TraceResult {
  /** Cards along the path, in order. */
  path: string[];
  /** Leaf connections used, in order. */
  edges: string[];
  /** False when no path exists in the direction of travel and the result ignores direction. */
  directed: boolean;
}

/**
 * Shortest path from anything inside `from` to anything inside `to`, by number of hops
 * (implicit API→host links are free). Falls back to ignoring direction if needed.
 */
export function trace(g: FlowGraph, nodes: ReadonlyMap<string, BoardNode>, from: string, to: string): TraceResult | null {
  const sources = subtree(nodes, from);
  const targets = new Set(subtree(nodes, to));
  const directed = search(sources, targets, (id) => g.flow.get(id) ?? []);
  if (directed) return { ...directed, directed: true };
  const both = (id: string) => [...(g.flow.get(id) ?? []), ...reverse(g.flow, id)];
  const loose = search(sources, targets, both);
  return loose ? { ...loose, directed: false } : null;
}

const reverseIndex = new WeakMap<Map<string, Arc[]>, Map<string, Arc[]>>();
function reverse(m: Map<string, Arc[]>, id: string): Arc[] {
  let r = reverseIndex.get(m);
  if (!r) {
    r = new Map();
    for (const [a, arcs] of m) {
      for (const arc of arcs) {
        if (!r.has(arc.to)) r.set(arc.to, []);
        r.get(arc.to)!.push({ to: a, edge: arc.edge, weight: arc.weight });
      }
    }
    reverseIndex.set(m, r);
  }
  return r.get(id) ?? [];
}

/** 0-1 BFS from many sources to the first target reached. */
function search(sources: string[], targets: Set<string>, next: (id: string) => Arc[]): { path: string[]; edges: string[] } | null {
  const dist = new Map<string, number>();
  const prev = new Map<string, { from: string; edge?: string }>();
  const deque: string[] = [];
  for (const s of sources) {
    dist.set(s, 0);
    deque.push(s);
  }
  if (sources.some((s) => targets.has(s))) {
    const hit = sources.find((s) => targets.has(s))!;
    return { path: [hit], edges: [] };
  }
  let head = 0;
  // A plain array as deque: weight-0 arcs are unshifted ahead of the head.
  const front: string[] = [];
  while (front.length || head < deque.length) {
    const cur = front.length ? front.pop()! : deque[head++];
    const d = dist.get(cur)!;
    if (targets.has(cur)) {
      const path = [cur];
      const edges: string[] = [];
      for (let x = cur; prev.has(x); ) {
        const p = prev.get(x)!;
        if (p.edge) edges.push(p.edge);
        x = p.from;
        path.push(x);
      }
      return { path: path.reverse(), edges: edges.reverse() };
    }
    for (const arc of next(cur)) {
      const nd = d + arc.weight;
      if (nd < (dist.get(arc.to) ?? Infinity)) {
        dist.set(arc.to, nd);
        prev.set(arc.to, { from: cur, edge: arc.edge });
        if (arc.weight === 0) front.push(arc.to);
        else deque.push(arc.to);
      }
    }
  }
  return null;
}

export interface ImpactResult {
  /** Card → hops from the start (start cards are 0). */
  hops: Map<string, number>;
  /** Leaf connections between reached cards, in the direction of the question. */
  edges: Set<string>;
}

/**
 * Everything reachable from `id` over dependents ("who is affected if it fails") or
 * dependencies ("what it needs"), up to `maxHops` service-level hops.
 */
export function impact(g: FlowGraph, nodes: ReadonlyMap<string, BoardNode>, id: string, direction: 'dependents' | 'dependencies', maxHops = 6): ImpactResult {
  const m = direction === 'dependents' ? g.dependents : g.deps;
  const hops = new Map<string, number>();
  const edges = new Set<string>();
  const front: string[] = [];
  const queue: string[] = [];
  for (const s of subtree(nodes, id)) {
    hops.set(s, 0);
    queue.push(s);
  }
  let head = 0;
  while (front.length || head < queue.length) {
    const cur = front.length ? front.pop()! : queue[head++];
    const d = hops.get(cur)!;
    for (const arc of m.get(cur) ?? []) {
      const nd = d + arc.weight;
      if (nd > maxHops) continue;
      if (arc.edge) edges.add(arc.edge);
      if (nd < (hops.get(arc.to) ?? Infinity)) {
        hops.set(arc.to, nd);
        if (arc.weight === 0) front.push(arc.to);
        else queue.push(arc.to);
      }
    }
  }
  return { hops, edges };
}
