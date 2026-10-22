import type { ConnectionKind } from '../registry/types';

export interface LeafEdge {
  id: string;
  from: string;
  to: string;
  kind: ConnectionKind;
  gap?: string;
}

export interface LiftedEdge {
  key: string;
  from: string;
  to: string;
  count: number;
  kinds: Partial<Record<ConnectionKind, number>>;
  /** Ids of the leaf edges merged into this one. */
  leaves: string[];
  /** True when every leaf is an unknown-API call (drawn dashed). */
  gapOnly: boolean;
}

/** Precomputed ancestor chains, node first: [node, parent, grandparent, ...]. */
export function ancestorChains(parents: ReadonlyMap<string, string | null>): Map<string, string[]> {
  const chains = new Map<string, string[]>();
  const chainOf = (id: string): string[] => {
    const hit = chains.get(id);
    if (hit) return hit;
    const p = parents.get(id);
    const chain = [id, ...(p ? chainOf(p) : [])];
    chains.set(id, chain);
    return chain;
  };
  for (const id of parents.keys()) chainOf(id);
  return chains;
}

/**
 * Edge lifting: each edge is drawn between the deepest visible ancestors of its ends.
 * Edges landing on the same ordered pair merge; edges inside one collapsed card disappear.
 */
export function liftEdges(
  edges: readonly LeafEdge[],
  chains: ReadonlyMap<string, readonly string[]>,
  visible: ReadonlySet<string>,
): LiftedEdge[] {
  const deepestVisible = (id: string) => chains.get(id)?.find((a) => visible.has(a));
  const out = new Map<string, LiftedEdge>();

  for (const e of edges) {
    const a = deepestVisible(e.from);
    const b = deepestVisible(e.to);
    if (!a || !b || a === b) continue;
    const key = `${a}->${b}`;
    let l = out.get(key);
    if (!l) {
      l = { key, from: a, to: b, count: 0, kinds: {}, leaves: [], gapOnly: true };
      out.set(key, l);
    }
    l.count++;
    l.kinds[e.kind] = (l.kinds[e.kind] ?? 0) + 1;
    l.leaves.push(e.id);
    if (e.kind !== 'calls-unknown') l.gapOnly = false;
  }
  return [...out.values()];
}

const KIND_LABEL: Record<ConnectionKind, [string, string]> = {
  calls: ['call', 'calls'],
  publishes: ['publish', 'publishes'],
  consumes: ['consume', 'consumes'],
  'reads-writes': ['datastore access', 'datastore accesses'],
  'calls-unknown': ['unknown-API call', 'unknown-API calls'],
  requests: ['pending grant', 'pending grants'],
  uses: ['schema use', 'schema uses'],
  references: ['reference', 'references'],
  twin: ['identical schema', 'identical schemas'],
};

/** "12 calls · 3 publishes". */
export function describeKinds(kinds: LiftedEdge['kinds']): string {
  return (Object.entries(kinds) as Array<[ConnectionKind, number]>)
    .map(([k, n]) => `${n} ${KIND_LABEL[k][n === 1 ? 0 : 1]}`)
    .join(' · ');
}

/**
 * Re-groups already lifted edges by mapping each end to another card (usually a coarser
 * ancestor). Cheaper than lifting the leaf edges again, since there are far fewer lifted edges.
 */
export function regroupBy(lifted: readonly LiftedEdge[], map: (id: string) => string | undefined): LiftedEdge[] {
  const out = new Map<string, LiftedEdge>();
  for (const e of lifted) {
    const a = map(e.from);
    const b = map(e.to);
    if (!a || !b || a === b) continue;
    const key = `${a}->${b}`;
    let l = out.get(key);
    if (!l) {
      l = { key, from: a, to: b, count: 0, kinds: {}, leaves: [], gapOnly: true };
      out.set(key, l);
    }
    l.count += e.count;
    for (const [k, n] of Object.entries(e.kinds) as Array<[ConnectionKind, number]>) l.kinds[k] = (l.kinds[k] ?? 0) + n;
    l.leaves.push(...e.leaves);
    if (!e.gapOnly) l.gapOnly = false;
  }
  return [...out.values()];
}

/** Re-groups lifted edges onto a smaller visible set (a coarser edge level). */
export function regroup(
  lifted: readonly LiftedEdge[],
  chains: ReadonlyMap<string, readonly string[]>,
  visible: ReadonlySet<string>,
): LiftedEdge[] {
  return regroupBy(lifted, (id) => chains.get(id)?.find((a) => visible.has(a)));
}
