import { beforeAll, describe, expect, it } from 'vitest';
import { buildModel } from '../src/build/build';
import { buildFlowGraph, impact, trace, type FlowGraph } from '../src/lod/paths';
import type { BoardModel, BoardNode } from '../src/model';

let model: BoardModel;
let nodes: Map<string, BoardNode>;
let g: FlowGraph;
beforeAll(async () => {
  model = await buildModel('examples');
  nodes = new Map(model.nodes.map((n) => [n.id, n]));
  g = buildFlowGraph(nodes, model.edges);
});

describe('trace', () => {
  it('follows a call through an API into its hosting service and on', () => {
    const r = trace(g, nodes, 'returns/returns-portal-bff', 'billing/refund-service')!;
    expect(r.directed).toBe(true);
    // Refund API sits inside refund-service, so reaching it is arriving.
    expect(r.path).toEqual(['returns/returns-portal-bff', 'returns/returns-api', 'returns/returns-intake', 'billing/refund-api']);
    expect(r.edges).toEqual(['returns/returns-portal-bff->returns/returns-api', 'returns/returns-intake->billing/refund-api']);
  });

  it('follows events from producer through the topic to a consumer', () => {
    const r = trace(g, nodes, 'billing/refund-service', 'notifications/notify-service')!;
    expect(r.path).toEqual(['billing/refund-service', 'billing/refund-issued', 'notifications/notify-service']);
  });

  it('accepts containers as ends and searches inside them', () => {
    const r = trace(g, nodes, 'shipping', 'returns')!;
    expect(r.directed).toBe(true);
    expect(nodes.get(r.path[0])!.id.startsWith('shipping/')).toBe(true);
    expect(r.path[r.path.length - 1].startsWith('returns/')).toBe(true);
  });

  it('falls back to ignoring direction when nothing flows that way', () => {
    const r = trace(g, nodes, 'ledger/ledger-writer', 'returns/returns-portal-bff')!;
    expect(r.directed).toBe(false);
  });
});

describe('impact', () => {
  it('finds everyone who depends on a service, with hop counts', () => {
    const r = impact(g, nodes, 'billing/refund-service', 'dependents');
    expect(r.hops.get('returns/returns-intake')).toBe(1); // calls Refund API
    expect(r.hops.get('ledger/ledger-writer')).toBe(2); // consumes refund.issued, published by it (topic is 1 hop)
    expect(r.hops.get('returns/returns-portal-bff')).toBe(2); // calls Returns API on returns-intake
  });

  it('finds what a service depends on', () => {
    const r = impact(g, nodes, 'returns/returns-intake', 'dependencies');
    expect(r.hops.get('billing/refund-service')).toBe(1);
    expect(r.hops.get('ext/stripe')).toBe(2);
    expect(r.hops.has('returns/returns-portal-bff')).toBe(false);
  });
});
