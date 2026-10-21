import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { apiCardSize, apiCells } from '../src/spec0/apiGrid';
import { HttpSource } from '../src/spec0/source';
import type { GraphSnapshot } from '../src/spec0/types';

const snap = JSON.parse(readFileSync('examples/spec0/snapshot.json', 'utf8')) as GraphSnapshot;

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
