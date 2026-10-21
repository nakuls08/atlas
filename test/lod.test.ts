import { describe, expect, it } from 'vitest';
import { computeVisible, type LodNode } from '../src/lod/visibility';
import { ancestorChains, describeKinds, liftEdges, type LeafEdge } from '../src/lod/lift';

/** dept-a{dom-a{svc-a1, svc-a2}}, dept-b{dom-b{svc-b1, topic-b}} */
function tree(widths: Record<string, number> = {}) {
  const spec: Array<[string, string | null, number]> = [
    ['dept-a', null, 0],
    ['dom-a', 'dept-a', 1],
    ['svc-a1', 'dom-a', 3],
    ['svc-a2', 'dom-a', 3],
    ['dept-b', null, 0],
    ['dom-b', 'dept-b', 1],
    ['svc-b1', 'dom-b', 3],
    ['topic-b', 'dom-b', 4],
  ];
  const nodes = new Map<string, LodNode>();
  for (const [id, parent, level] of spec) nodes.set(id, { id, parent, level, w: widths[id] ?? 1000, children: [] });
  for (const n of nodes.values()) if (n.parent) nodes.get(n.parent)!.children.push(n.id);
  return nodes;
}
const opts = { expandAt: 320, collapseAt: 260 };
const roots = ['dept-a', 'dept-b'];

describe('computeVisible', () => {
  it('opens a container at expandAt and keeps it open down to collapseAt', () => {
    const nodes = tree({ 'dept-a': 100, 'dom-a': 10, 'dept-b': 100, 'dom-b': 10 });
    const closed = computeVisible(nodes, roots, 3, new Set(), opts); // 300px < 320
    expect(closed.expanded.has('dept-a')).toBe(false);
    const opened = computeVisible(nodes, roots, 3.3, closed.expanded, opts); // 330px
    expect(opened.expanded.has('dept-a')).toBe(true);
    const held = computeVisible(nodes, roots, 2.8, opened.expanded, opts); // 280px, in the gap
    expect(held.expanded.has('dept-a')).toBe(true);
    const fresh = computeVisible(nodes, roots, 2.8, new Set(), opts);
    expect(fresh.expanded.has('dept-a')).toBe(false);
    const dropped = computeVisible(nodes, roots, 2.5, held.expanded, opts); // 250px
    expect(dropped.expanded.has('dept-a')).toBe(false);
  });

  it('a big container opens before a small one at the same zoom', () => {
    const s = computeVisible(tree({ 'dept-a': 400, 'dept-b': 200 }), roots, 1, new Set(), opts);
    expect(s.expanded.has('dept-a')).toBe(true);
    expect(s.expanded.has('dept-b')).toBe(false);
  });

  it('children of a closed container are not visible', () => {
    const s = computeVisible(tree({ 'dept-b': 10 }), roots, 1, new Set(), opts);
    expect(s.visible.has('dom-a')).toBe(true);
    expect(s.visible.has('dom-b')).toBe(false);
  });

  it('the level override ignores zoom', () => {
    const s = computeVisible(tree(), roots, 0.001, new Set(), { ...opts, levelOverride: 1 });
    expect([...s.visible].sort()).toEqual(['dept-a', 'dept-b', 'dom-a', 'dom-b']);
  });

  it('pins win over zoom and the override', () => {
    const pins = new Map([['dept-a', false]]);
    const s = computeVisible(tree(), roots, 10, new Set(), { ...opts, pins });
    expect(s.visible.has('dom-a')).toBe(false);
    expect(s.visible.has('dom-b')).toBe(true);
  });
});

describe('liftEdges', () => {
  const nodes = tree();
  const chains = ancestorChains(new Map([...nodes.values()].map((n) => [n.id, n.parent])));
  const e = (from: string, to: string, kind: LeafEdge['kind'] = 'calls'): LeafEdge => ({ id: `${from}->${to}`, from, to, kind });
  const all = new Set(nodes.keys());

  it('a sibling call stays between the two services when they are visible', () => {
    expect(liftEdges([e('svc-a1', 'svc-a2')], chains, all)).toMatchObject([{ from: 'svc-a1', to: 'svc-a2', count: 1 }]);
  });

  it('a cross-department call lifts to the departments when zoomed out', () => {
    const l = liftEdges([e('svc-a1', 'svc-b1')], chains, new Set(['dept-a', 'dept-b']));
    expect(l).toMatchObject([{ from: 'dept-a', to: 'dept-b', count: 1, leaves: ['svc-a1->svc-b1'] }]);
  });

  it('a connection inside a collapsed container is hidden', () => {
    expect(liftEdges([e('svc-a1', 'svc-a2')], chains, new Set(['dept-a', 'dom-a', 'dept-b']))).toEqual([]);
  });

  it('three connections landing on the same pair merge with counts by kind', () => {
    const l = liftEdges(
      [e('svc-a1', 'svc-b1'), e('svc-a2', 'svc-b1'), e('svc-a1', 'topic-b', 'publishes')],
      chains,
      new Set(['dept-a', 'dom-a', 'dept-b', 'dom-b']),
    );
    expect(l).toHaveLength(1);
    expect(l[0]).toMatchObject({ from: 'dom-a', to: 'dom-b', count: 3, kinds: { calls: 2, publishes: 1 } });
    expect(describeKinds(l[0].kinds)).toBe('2 calls · 1 publish');
  });

  it('a topic with 30 consumers lifts to one edge per visible consumer container', () => {
    const big = new Map(nodes);
    const parents = new Map([...nodes.values()].map((n) => [n.id, n.parent]));
    const edges: LeafEdge[] = [];
    for (let i = 0; i < 30; i++) {
      parents.set(`c${i}`, 'dom-a');
      big.set(`c${i}`, { id: `c${i}`, parent: 'dom-a', level: 3, w: 100, children: [] });
      edges.push(e('topic-b', `c${i}`, 'consumes'));
    }
    const ch = ancestorChains(parents);
    expect(liftEdges(edges, ch, new Set([...big.keys()]))).toHaveLength(30);
    const out = liftEdges(edges, ch, new Set(['dept-a', 'dom-a', 'dept-b', 'dom-b', 'topic-b']));
    expect(out).toMatchObject([{ from: 'topic-b', to: 'dom-a', count: 30, kinds: { consumes: 30 } }]);
  });

  it('an edge is gap-only when every leaf is an unknown-API call', () => {
    const l = liftEdges([e('svc-a1', 'svc-b1', 'calls-unknown')], chains, new Set(['dept-a', 'dept-b']));
    expect(l[0].gapOnly).toBe(true);
  });
});

describe('regroup (edge level of detail)', () => {
  it('matches lifting the leaf edges directly onto the coarser set', async () => {
    const { regroup } = await import('../src/lod/lift');
    const nodes = tree();
    const chains = ancestorChains(new Map([...nodes.values()].map((n) => [n.id, n.parent])));
    const edges: LeafEdge[] = [
      { id: '1', from: 'svc-a1', to: 'svc-b1', kind: 'calls' },
      { id: '2', from: 'svc-a2', to: 'topic-b', kind: 'publishes' },
      { id: '3', from: 'svc-a1', to: 'svc-a2', kind: 'calls' },
    ];
    const fine = liftEdges(edges, chains, new Set(nodes.keys()));
    const coarse = new Set(['dept-a', 'dom-a', 'dept-b', 'dom-b']);
    expect(regroup(fine, chains, coarse)).toEqual(liftEdges(edges, chains, coarse));
  });
});

describe('computeVisible with openK (children readable)', () => {
  it('keeps a wide container closed until its children are readable, with hysteresis', () => {
    const nodes = tree({ 'dept-a': 2000 });
    nodes.set('dept-a', { ...nodes.get('dept-a')!, openK: 0.6 });
    const roots = ['dept-a', 'dept-b'];
    const wideButSmall = computeVisible(nodes, roots, 0.5, new Set(), opts); // 1000px wide, k < 0.6
    expect(wideButSmall.expanded.has('dept-a')).toBe(false);
    const opened = computeVisible(nodes, roots, 0.62, new Set(), opts);
    expect(opened.expanded.has('dept-a')).toBe(true);
    const held = computeVisible(nodes, roots, 0.55, opened.expanded, opts); // ≥ 0.85 × 0.6
    expect(held.expanded.has('dept-a')).toBe(true);
    const closed = computeVisible(nodes, roots, 0.45, held.expanded, opts);
    expect(closed.expanded.has('dept-a')).toBe(false);
  });
});
