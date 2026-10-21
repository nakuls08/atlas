import { describe, expect, it } from 'vitest';
import { buildModel } from '../src/build/build';
import { loadRegistry } from '../src/registry/load';
import { validate } from '../src/registry/validate';

describe('example registry', () => {
  it('is valid', () => {
    expect(validate(loadRegistry('examples'))).toEqual([]);
  });

  it('builds a byte-identical model on every run', async () => {
    const a = JSON.stringify(await buildModel('examples'));
    const b = JSON.stringify(await buildModel('examples'));
    expect(a).toBe(b);
  });

  it('places every child inside its parent with the name band clear', async () => {
    const m = await buildModel('examples');
    const byId = new Map(m.nodes.map((n) => [n.id, n]));
    for (const n of m.nodes) {
      if (!n.parent) continue;
      const p = byId.get(n.parent)!;
      expect(n.x).toBeGreaterThanOrEqual(p.x);
      expect(n.y).toBeGreaterThanOrEqual(p.y + 24);
      expect(n.x + n.w).toBeLessThanOrEqual(p.x + p.w);
      expect(n.y + n.h).toBeLessThanOrEqual(p.y + p.h);
    }
  });

  it('puts topics next to their owner and APIs inside their host (Types table)', async () => {
    const m = await buildModel('examples');
    const byId = new Map(m.nodes.map((n) => [n.id, n]));
    expect(byId.get('returns/returns-api')!.parent).toBe('returns/returns-intake');
    expect(byId.get('returns/returns-created')!.parent).toBe('returns');
    expect(byId.get('shipping/shipment-tracked')!.parent).toBe('shipping/carrier-integration');
    expect(byId.get('ext/dhl')!.parent).toBe('__external');
  });
});
