import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { apiCardSize, apiCells } from '../src/spec0/apiGrid';
import { buildFromSnapshot, expandApi } from '../src/spec0/board';
import { HttpSource } from '../src/spec0/source';
import type { ApiDetails, GraphSnapshot } from '../src/spec0/types';

const snap = JSON.parse(readFileSync('examples/spec0/snapshot.json', 'utf8')) as GraphSnapshot;
const withServices = JSON.parse(readFileSync('examples/spec0/snapshot-with-services.json', 'utf8')) as GraphSnapshot;
const details = JSON.parse(readFileSync('examples/spec0/details.json', 'utf8')) as Record<string, ApiDetails>;

describe('buildFromSnapshot', () => {
  it('by team: teams on top, services and APIs inside their owning team', () => {
    const b = buildFromSnapshot(snap, 'team');
    const roots = [...b.nodes.values()].filter((n) => !n.parent);
    expect(roots.every((n) => n.type === 'team' || n.type === 'band')).toBe(true);
    const api = b.nodes.get('a:orders-order-api-v2')!;
    expect(api.parent).toBe('t:team-orders');
    expect(api.lazy).toMatchObject({ operations: details['orders-order-api-v2'].operations.length });
    expect(b.nodes.get('s:order-service')!.parent).toBe('t:team-orders');
  });

  it('nests APIs under their exposing service once Spec0 records it', () => {
    const b = buildFromSnapshot(withServices, 'team');
    expect(b.nodes.get('a:orders-order-api-v2')!.parent).toBe('s:order-service');
  });

  it('by domain: APIs under the domain holding most of their schemas, teams in a side band', () => {
    const b = buildFromSnapshot(snap, 'domain');
    const api = snap.apis.find((a) => a.id === 'orders-order-api-v2')!;
    const top = Object.entries(api.domains!).sort((x, y) => y[1] - x[1] || x[0].localeCompare(y[0]))[0][0];
    expect(b.nodes.get('a:orders-order-api-v2')!.parent).toBe(`d:${top}`);
    expect(b.nodes.get('t:team-orders')!.parent).toBe('__teams');
  });

  it('turns grants into connections: pending ones as requests, rejected ones dropped', () => {
    const b = buildFromSnapshot(snap, 'team');
    const live = snap.grants.filter((g) => g.status !== 'REJECTED');
    expect(b.edges).toHaveLength(live.length);
    expect(b.edges.filter((e) => e.kind === 'requests')).toHaveLength(live.filter((g) => g.status === 'PENDING').length);
    expect(b.edges.every((e) => b.nodes.has(e.from) && b.nodes.has(e.to))).toBe(true);
  });

  it('draws a grant from the kind of consumer the server names', () => {
    const b = buildFromSnapshot(snap, 'team');
    for (const g of snap.grants.filter((x) => x.status !== 'REJECTED')) {
      const from = `${g.consumerKind === 'SERVICE' ? 's' : 't'}:${g.consumer}`;
      expect(b.edges.some((e) => e.from === from && e.to === `a:${g.api}`)).toBe(true);
    }
  });

  it('tolerates the nullable fields being null or absent', () => {
    const lean: GraphSnapshot = {
      ...snap,
      services: snap.services.map((s, i) => (i === 0 ? { id: s.id, name: s.name } : { ...s, team: null })),
      apis: snap.apis.map(({ specVersion: _v, source: _s, updatedAt: _u, ...a }) => ({ ...a, service: null })),
    };
    const b = buildFromSnapshot(lean, 'team');
    expect(b.nodes.get('a:orders-order-api-v2')!.lazy).toMatchObject({ specVersion: undefined });
    expect(b.nodes.has('__noteam')).toBe(true);
  });

  it('is deterministic', () => {
    const a = buildFromSnapshot(snap, 'team');
    const b = buildFromSnapshot(snap, 'team');
    expect(JSON.stringify([...a.nodes.values()])).toBe(JSON.stringify([...b.nodes.values()]));
  });
});

describe('API card grid', () => {
  it('fits the loaded items in the box reserved from the counts', () => {
    const box = apiCardSize(14, 9);
    const cells = apiCells(box, { operations: 14, schemas: 9 });
    for (const c of [...cells.operations, ...cells.schemas]) {
      expect(c.x).toBeGreaterThanOrEqual(0);
      expect(c.y).toBeGreaterThanOrEqual(32);
      expect(c.x + c.w).toBeLessThanOrEqual(box.w);
      expect(c.y + c.h).toBeLessThanOrEqual(box.h);
    }
  });

  it('draws more items smaller instead of growing the card', () => {
    const box = apiCardSize(5, 4);
    const cells = apiCells(box, { operations: 25, schemas: 12 });
    const last = [...cells.operations, ...cells.schemas].reduce((m, c) => Math.max(m, c.x + c.w), 0);
    expect(last).toBeLessThanOrEqual(box.w + 0.01);
    expect(cells.operations[0].w).toBeLessThan(196);
  });
});

describe('expandApi', () => {
  it('adds operations and schemas inside the card, links and refined grants', () => {
    const b = buildFromSnapshot(snap, 'team');
    const scoped = snap.grants.find((g) => g.operationScoped && g.status !== 'REJECTED')!;
    const api = b.nodes.get(`a:${scoped.api}`)!;
    Object.assign(api, { x: 1000, y: 500 });
    const d = details[scoped.api];
    const r = expandApi(api, d, { nodes: b.nodes, edges: b.edges, hashes: new Map() });
    expect(r.nodes).toHaveLength(d.operations.length + d.schemas.length);
    for (const n of r.nodes) {
      expect(n.parent).toBe(api.id);
      expect(n.x).toBeGreaterThanOrEqual(api.x);
      expect(n.x + n.w).toBeLessThanOrEqual(api.x + api.w + 0.1);
    }
    // Each operation-scoped grant on this API: consumer → API becomes consumer → operations.
    const scopedHere = d.grantOperations.filter((g) => g.operations.length && b.edges.some((e) => e.to === api.id && e.from.endsWith(`:${g.consumer}`)));
    expect(r.remove.size).toBe(scopedHere.length);
    expect(r.add.filter((e) => e.id.startsWith('g:')).every((e) => e.to.startsWith(`${api.id}/op/`))).toBe(true);
    expect(r.add.some((e) => e.kind === 'uses')).toBe(true);
  });

  it('links identical schemas across loaded APIs by structural hash', () => {
    const b = buildFromSnapshot(snap, 'team');
    const hashes = new Map<string, string[]>();
    const withError = Object.values(details).filter((d) => d.schemas.some((s) => s.name === 'Error')).slice(0, 2);
    const [r1, r2] = withError.map((d) => expandApi(b.nodes.get(`a:${d.id}`)!, d, { nodes: b.nodes, edges: b.edges, hashes }));
    expect(r1.add.some((e) => e.kind === 'twin')).toBe(false);
    expect(r2.add.some((e) => e.kind === 'twin' && e.id.includes('/schema/Error'))).toBe(true);
  });

  it('labels schema domains by name, not id', () => {
    const b = buildFromSnapshot(snap, 'team');
    const d = Object.values(details).find((x) => x.schemas.some((s) => s.domain))!;
    const domainName = new Map(snap.domains.map((x) => [x.id, x.name]));
    const r = expandApi(b.nodes.get(`a:${d.id}`)!, d, { nodes: b.nodes, edges: b.edges, hashes: new Map(), domainName });
    const tagged = r.nodes.filter((n) => n.tags.length);
    expect(tagged.length).toBeGreaterThan(0);
    expect(tagged.every((n) => [...domainName.values()].includes(n.tags[0]))).toBe(true);
  });
});

describe('HttpSource', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('revalidates the snapshot with its ETag and reuses it on 304', async () => {
    const calls: Array<Record<string, string>> = [];
    vi.stubGlobal('fetch', async (_url: string, init: { headers: Record<string, string> }) => {
      calls.push(init.headers);
      return init.headers['If-None-Match'] === '"abc"'
        ? new Response(null, { status: 304 })
        : new Response(JSON.stringify(snap), { status: 200, headers: { ETag: '"abc"' } });
    });
    const src = new HttpSource('https://bff.example/');
    const first = await src.snapshot();
    const second = await src.snapshot();
    expect(second).toBe(first);
    expect(calls[1]['If-None-Match']).toBe('"abc"');
    expect(src.stats.requests.map((r) => r.bytes > 0)).toEqual([true, false]);
  });

  it('asks for details in batches of 50, with the version when known', async () => {
    const urls: string[] = [];
    vi.stubGlobal('fetch', async (url: string) => {
      urls.push(url);
      return new Response(JSON.stringify({ apis: [] }), { status: 200 });
    });
    const keys = Array.from({ length: 120 }, (_, i) => ({ id: `api-${i}`, specVersion: i % 2 ? '1.0.0' : null }));
    await new HttpSource('https://bff.example').details(keys);
    expect(urls).toHaveLength(3);
    const q = decodeURIComponent(new URL(urls[0]).searchParams.get('apis')!).split(',');
    expect(q).toHaveLength(50);
    expect(q.slice(0, 2)).toEqual(['api-0', 'api-1@1.0.0']);
  });
});
