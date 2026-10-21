import { describe, expect, it } from 'vitest';
import { roundedPath, routeAll, simplify, type Pt, type Rect } from '../src/route/orthogonal';

const segs = (pts: Pt[]) => pts.slice(1).map((p, i) => [pts[i], p] as const);

/** True if the open segment passes through the rect's interior. */
function crosses([a, b]: readonly [Pt, Pt], r: Rect) {
  const [x0, x1] = [Math.min(a[0], b[0]), Math.max(a[0], b[0])];
  const [y0, y1] = [Math.min(a[1], b[1]), Math.max(a[1], b[1])];
  return x0 < r.x + r.w && x1 > r.x && y0 < r.y + r.h && y1 > r.y;
}

const box = (x: number, y: number, w = 100, h = 50): Rect => ({ x, y, w, h });

describe('orthogonal router', () => {
  it('routes around a card in the way, with only horizontal and vertical segments', () => {
    const a = box(0, 0);
    const b = box(400, 0);
    const wall = box(180, -100, 60, 250);
    const { routes } = routeAll([{ key: 'e', from: 'a', to: 'b', a, b, obstacles: [wall] }]);
    const pts = routes.get('e')!;
    for (const s of segs(pts)) {
      expect(s[0][0] === s[1][0] || s[0][1] === s[1][1]).toBe(true);
      expect(crosses(s, wall)).toBe(false);
    }
    expect(pts[0]).toEqual([100, 25]);
    expect(pts[pts.length - 1]).toEqual([400, 25]);
  });

  it('takes a straight line when nothing is in the way', () => {
    const { routes } = routeAll([{ key: 'e', from: 'a', to: 'b', a: box(0, 0), b: box(300, 0), obstacles: [] }]);
    expect(routes.get('e')).toEqual([
      [100, 25],
      [300, 25],
    ]);
  });

  it('spreads ports along a shared side', () => {
    const a = box(0, 0, 100, 100);
    const { routes } = routeAll([
      { key: 'e1', from: 'a', to: 'b', a, b: box(300, -200), obstacles: [] },
      { key: 'e2', from: 'a', to: 'c', a, b: box(300, 250), obstacles: [] },
    ]);
    const y1 = routes.get('e1')![0][1];
    const y2 = routes.get('e2')![0][1];
    expect(y1).toBeLessThan(y2); // the edge going up leaves from higher up, so they don't cross
  });

  it('separates parallel segments that would overlap', () => {
    const a = box(0, 0, 100, 40);
    const b = box(0, 300, 100, 40);
    const c = box(400, 0, 100, 40);
    const d = box(400, 300, 100, 40);
    const wall = box(150, 60, 200, 200);
    const { routes } = routeAll([
      { key: 'ad', from: 'a', to: 'd', a, b: d, obstacles: [wall, b, c] },
      { key: 'bc', from: 'b', to: 'c', a: b, b: c, obstacles: [wall, a, d] },
    ]);
    const verticalXs = [...routes.values()].flatMap((pts) => segs(pts).filter(([p, q]) => p[0] === q[0] && Math.abs(p[1] - q[1]) > 20).map(([p]) => p[0]));
    expect(new Set(verticalXs).size).toBe(verticalXs.length);
  });

  it('is deterministic and reuses cached routes', () => {
    const req = { key: 'e', from: 'a', to: 'b', a: box(0, 0), b: box(400, 0), obstacles: [box(180, -100, 60, 250)], obstacleKey: 'w' };
    const cache = new Map<string, Pt[]>();
    const stats = { routed: 0, cached: 0, maxMs: 0, maxCells: 0, totalMs: 0 };
    const first = routeAll([req], {}, { cache, stats }).routes.get('e');
    const second = routeAll([req], {}, { cache, stats }).routes.get('e');
    expect(second).toEqual(first);
    expect(stats).toMatchObject({ routed: 1, cached: 1 });
  });

  it('falls back to elbows when the time budget runs out', () => {
    const reqs = Array.from({ length: 5 }, (_, i) => ({ key: `e${i}`, from: `a${i}`, to: `b${i}`, a: box(0, i * 100), b: box(400, i * 100 + 30), obstacles: [] }));
    const { routes, complete } = routeAll(reqs, {}, { budgetMs: -1 });
    expect(complete).toBe(false);
    expect(routes.size).toBe(5);
  });
});

describe('path helpers', () => {
  it('drops collinear and repeated points', () => {
    expect(simplify([[0, 0], [5, 0], [5, 0], [10, 0], [10, 10]])).toEqual([[0, 0], [10, 0], [10, 10]]);
  });
  it('rounds corners', () => {
    expect(roundedPath([[0, 0], [20, 0], [20, 20]], 5)).toBe('M0,0 L15,0 Q20,0 20,5 L20,20');
  });
});
