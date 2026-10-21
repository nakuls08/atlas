/**
 * Orthogonal edge router.
 *
 * Each edge leaves its source through a port on one side, runs in horizontal and vertical
 * segments around the cards in its way, and enters the target through a port. Routing is a
 * shortest path with a bend penalty over a sparse grid built from the obstacle faces and the
 * gutters between them. After all edges are routed, parallel segments that would sit on top
 * of each other are spread apart ("nudging").
 */

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}
export type Side = 'l' | 'r' | 't' | 'b';
export type Pt = [number, number];

export interface RouteRequest {
  key: string;
  /** Ids of the two end cards, used to share out ports along a side. */
  from: string;
  to: string;
  a: Rect;
  b: Rect;
  /** Cards to go around. The two end cards are added automatically. */
  obstacles: Rect[];
  /** Identifies the obstacle set, so a route can be reused while nothing around it changes. */
  obstacleKey?: string;
  /** Lower routes first (e.g. 0 = on screen). */
  priority?: number;
}

export interface RouteContext {
  /** Routes from earlier calls, keyed by request, ports and obstacle set. */
  cache?: Map<string, Pt[]>;
  /** Stop routing after this many ms; the rest get simple elbows and `complete` is false. */
  budgetMs?: number;
  /** Filled in with counters, for tuning. */
  stats?: { routed: number; cached: number; maxMs: number; maxCells: number; totalMs: number };
}

let lastCells = 0;

export interface RouteOptions {
  /** Clearance kept from every card. */
  margin: number;
  /** Straight run out of a port before the first turn. */
  stub: number;
  /** Cost of one turn, in world units of length. */
  bend: number;
  /** Preferred distance between parallel lines sharing a gutter. */
  nudge: number;
}

// Stub length equals the clearance, so a port's stub ends exactly on the card's clearance line.
const DEFAULTS: RouteOptions = { margin: 14, stub: 14, bend: 90, nudge: 6 };

export function chooseSides(a: Rect, b: Rect): [Side, Side] {
  const dx = b.x + b.w / 2 - (a.x + a.w / 2);
  const dy = b.y + b.h / 2 - (a.y + a.h / 2);
  const gapX = Math.max(b.x - (a.x + a.w), a.x - (b.x + b.w));
  const gapY = Math.max(b.y - (a.y + a.h), a.y - (b.y + b.h));
  if (gapX >= gapY) return dx >= 0 ? ['r', 'l'] : ['l', 'r'];
  return dy >= 0 ? ['b', 't'] : ['t', 'b'];
}

const NORMAL: Record<Side, Pt> = { l: [-1, 0], r: [1, 0], t: [0, -1], b: [0, 1] };
const isHorizontalSide = (s: Side) => s === 'l' || s === 'r';

/** Routes every request; returns the polyline for each key. Deterministic for a given input order. */
export function routeAll(
  requests: RouteRequest[],
  options: Partial<RouteOptions> = {},
  ctx: RouteContext = {},
): { routes: Map<string, Pt[]>; complete: boolean } {
  const opts = { ...DEFAULTS, ...options };
  const sides = requests.map((r) => chooseSides(r.a, r.b));
  const ports = assignPorts(requests, sides);
  const start = performance.now();
  let complete = true;

  const routes = new Map<string, Pt[]>();
  // On-screen first; then short edges, which have the fewest options.
  const order = requests
    .map((_, i) => i)
    .sort((i, j) => (requests[i].priority ?? 0) - (requests[j].priority ?? 0) || span(requests[i]) - span(requests[j]) || requests[i].key.localeCompare(requests[j].key));
  for (const i of order) {
    const r = requests[i];
    const [pa, pb] = ports[i];
    const [sa, sb] = sides[i];
    const s0: Pt = [pa[0] + NORMAL[sa][0] * opts.stub, pa[1] + NORMAL[sa][1] * opts.stub];
    const s1: Pt = [pb[0] + NORMAL[sb][0] * opts.stub, pb[1] + NORMAL[sb][1] * opts.stub];
    const cacheKey = r.obstacleKey !== undefined ? `${r.key}|${pa}|${pb}|${r.obstacleKey}` : undefined;
    const hit = cacheKey ? ctx.cache?.get(cacheKey) : undefined;
    if (hit) {
      if (ctx.stats) ctx.stats.cached++;
      routes.set(r.key, hit.map((p) => [p[0], p[1]]));
      continue;
    }
    if (ctx.budgetMs !== undefined && performance.now() - start > ctx.budgetMs) {
      complete = false;
      routes.set(r.key, simplify([pa, ...elbow(s0, s1, sa), pb]));
      continue;
    }
    const all = [r.a, r.b, ...r.obstacles];
    const t0 = performance.now();
    const mid =
      shortestPath(s0, s1, isHorizontalSide(sa) ? 0 : 1, isHorizontalSide(sb) ? 0 : 1, nearby(all, s0, s1), opts) ??
      shortestPath(s0, s1, isHorizontalSide(sa) ? 0 : 1, isHorizontalSide(sb) ? 0 : 1, all, opts);
    if (ctx.stats) {
      const ms = performance.now() - t0;
      ctx.stats.routed++;
      ctx.stats.totalMs += ms;
      ctx.stats.maxMs = Math.max(ctx.stats.maxMs, ms);
      ctx.stats.maxCells = Math.max(ctx.stats.maxCells, lastCells);
    }
    const route = simplify([pa, ...(mid ?? elbow(s0, s1, sa)), pb]);
    if (cacheKey && ctx.cache) ctx.cache.set(cacheKey, route.map((p) => [p[0], p[1]]));
    routes.set(r.key, route);
  }
  nudge(routes, opts);
  return { routes, complete };
}

/** Obstacles near the straight line between the ends; a detour rarely needs more. */
function nearby(rects: Rect[], s0: Pt, s1: Pt): Rect[] {
  const pad = Math.max(160, 0.4 * (Math.abs(s0[0] - s1[0]) + Math.abs(s0[1] - s1[1])));
  const x0 = Math.min(s0[0], s1[0]) - pad;
  const x1 = Math.max(s0[0], s1[0]) + pad;
  const y0 = Math.min(s0[1], s1[1]) - pad;
  const y1 = Math.max(s0[1], s1[1]) + pad;
  return rects.filter((r) => r.x < x1 && r.x + r.w > x0 && r.y < y1 && r.y + r.h > y0);
}

function span(r: RouteRequest) {
  return Math.abs(r.a.x + r.a.w / 2 - (r.b.x + r.b.w / 2)) + Math.abs(r.a.y + r.a.h / 2 - (r.b.y + r.b.h / 2));
}

/** Shares out ports along each side, ordered by where the other end lies, so lines don't cross at the card. */
function assignPorts(requests: RouteRequest[], sides: Array<[Side, Side]>): Array<[Pt, Pt]> {
  const groups = new Map<string, Array<{ i: number; end: 0 | 1; rect: Rect; side: Side; other: Rect }>>();
  requests.forEach((r, i) => {
    for (const end of [0, 1] as const) {
      const id = end === 0 ? r.from : r.to;
      const side = sides[i][end];
      const key = `${id}\u0000${side}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push({ i, end, rect: end === 0 ? r.a : r.b, side, other: end === 0 ? r.b : r.a });
    }
  });
  const out: Array<[Pt, Pt]> = requests.map(() => [[0, 0], [0, 0]]);
  for (const list of groups.values()) {
    const { rect, side } = list[0];
    const along = isHorizontalSide(side);
    list.sort((p, q) => {
      const c = along ? p.other.y + p.other.h / 2 - (q.other.y + q.other.h / 2) : p.other.x + p.other.w / 2 - (q.other.x + q.other.w / 2);
      return c || requests[p.i].key.localeCompare(requests[q.i].key);
    });
    const len = along ? rect.h : rect.w;
    const inset = Math.min(14, len / 4);
    list.forEach((p, k) => {
      const t = inset + ((len - 2 * inset) * (k + 1)) / (list.length + 1);
      const pt: Pt = along
        ? [side === 'r' ? rect.x + rect.w : rect.x, rect.y + t]
        : [rect.x + t, side === 'b' ? rect.y + rect.h : rect.y];
      out[p.i][p.end] = pt;
    });
  }
  return out;
}

function elbow(s0: Pt, s1: Pt, side: Side): Pt[] {
  if (isHorizontalSide(side)) {
    const mx = (s0[0] + s1[0]) / 2;
    return [s0, [mx, s0[1]], [mx, s1[1]], s1];
  }
  const my = (s0[1] + s1[1]) / 2;
  return [s0, [s0[0], my], [s1[0], my], s1];
}

function lowerBound(xs: number[], v: number): number {
  let lo = 0;
  let hi = xs.length;
  while (lo < hi) {
    const m = (lo + hi) >> 1;
    if (xs[m] < v) lo = m + 1;
    else hi = m;
  }
  return lo;
}

/**
 * Sorted grid coordinates. Values closer than a few units are merged (keeping `keep` values,
 * the stub ends, exactly), since near-duplicate lines make routes jog by a few pixels.
 */
function gridLines(values: number[], margin: number, keep: number[]): number[] {
  // Exact values: rounding would put stub ends a fraction off their grid line and tilt segments.
  const pinned = new Set(keep);
  const raw = [...new Set(values)].sort((a, b) => a - b);
  const sorted: number[] = [];
  for (const v of raw) {
    const last = sorted[sorted.length - 1];
    if (last !== undefined && v - last < 4) {
      if (pinned.has(v) && !pinned.has(last)) sorted[sorted.length - 1] = v;
      else if (pinned.has(v)) sorted.push(v);
      continue;
    }
    sorted.push(v);
  }
  const out: number[] = [];
  for (let i = 0; i < sorted.length; i++) {
    out.push(sorted[i]);
    // A line down the middle of each gutter keeps routes centred between cards.
    if (i + 1 < sorted.length && sorted[i + 1] - sorted[i] > margin) out.push((sorted[i] + sorted[i + 1]) / 2);
  }
  return out;
}

/**
 * A* over the orthogonal visibility grid. State = grid point × arrival orientation
 * (0 = moving horizontally, 1 = vertically); a change of orientation costs `bend`.
 */
function shortestPath(s0: Pt, s1: Pt, startO: 0 | 1, endO: 0 | 1, rects: Rect[], opts: RouteOptions): Pt[] | null {
  const M = opts.margin;
  const xv: number[] = [s0[0], s1[0]];
  const yv: number[] = [s0[1], s1[1]];
  let minX = Math.min(s0[0], s1[0]);
  let maxX = Math.max(s0[0], s1[0]);
  let minY = Math.min(s0[1], s1[1]);
  let maxY = Math.max(s0[1], s1[1]);
  for (const r of rects) {
    xv.push(r.x - M, r.x + r.w + M);
    yv.push(r.y - M, r.y + r.h + M);
    minX = Math.min(minX, r.x);
    maxX = Math.max(maxX, r.x + r.w);
    minY = Math.min(minY, r.y);
    maxY = Math.max(maxY, r.y + r.h);
  }
  xv.push(minX - 3 * M, maxX + 3 * M);
  yv.push(minY - 3 * M, maxY + 3 * M);
  const xs = gridLines(xv, M, [s0[0], s1[0]]);
  const ys = gridLines(yv, M, [s0[1], s1[1]]);
  const nx = xs.length;
  const ny = ys.length;
  const N = nx * ny;
  lastCells = N;

  const blocked = new Uint8Array(N);
  const hBlocked = new Uint8Array(N); // segment (i,j) → (i+1,j)
  const vBlocked = new Uint8Array(N); // segment (i,j) → (i,j+1)
  const e = 0.25;
  for (const r of rects) {
    const x0 = r.x - M + e;
    const x1 = r.x + r.w + M - e;
    const y0 = r.y - M + e;
    const y1 = r.y + r.h + M - e;
    const i0 = lowerBound(xs, x0);
    const i1 = lowerBound(xs, x1); // exclusive: xs[i] < x1
    const j0 = lowerBound(ys, y0);
    const j1 = lowerBound(ys, y1);
    for (let j = j0; j < j1; j++) {
      for (let i = i0; i < i1; i++) blocked[j * nx + i] = 1;
      // Horizontal segments on this row that pass through the rect.
      for (let i = Math.max(0, i0 - 1); i < Math.min(nx - 1, i1); i++) hBlocked[j * nx + i] = 1;
    }
    for (let i = i0; i < i1; i++) {
      for (let j = Math.max(0, j0 - 1); j < Math.min(ny - 1, j1); j++) vBlocked[j * nx + i] = 1;
    }
  }

  const si = lowerBound(xs, s0[0]);
  const sj = lowerBound(ys, s0[1]);
  const ti = lowerBound(xs, s1[0]);
  const tj = lowerBound(ys, s1[1]);
  const start = sj * nx + si;
  const goal = tj * nx + ti;
  // Stub ends may sit inside a crowded gutter; always let the route start and finish.
  blocked[start] = 0;
  blocked[goal] = 0;

  const g = new Float64Array(N * 2).fill(Infinity);
  const prev = new Int32Array(N * 2).fill(-1);
  const heap = new MinHeap();
  const h = (idx: number) => Math.abs(xs[idx % nx] - xs[ti]) + Math.abs(ys[(idx / nx) | 0] - ys[tj]);

  const s = start * 2 + startO;
  g[s] = 0;
  heap.push(s, h(start));
  const closed = new Uint8Array(N * 2);

  let found = -1;
  while (heap.size) {
    const st = heap.pop();
    if (closed[st]) continue;
    closed[st] = 1;
    const idx = st >> 1;
    const o = st & 1;
    if (idx === goal) {
      found = st;
      break;
    }
    const i = idx % nx;
    const j = (idx / nx) | 0;
    const gc = g[st];
    const relax = (nIdx: number, no: 0 | 1, len: number) => {
      if (blocked[nIdx] && nIdx !== goal) return;
      let cost = gc + len + (no !== o ? opts.bend : 0);
      if (nIdx === goal && no !== endO) cost += opts.bend;
      const ns = nIdx * 2 + no;
      if (cost < g[ns]) {
        g[ns] = cost;
        prev[ns] = st;
        heap.push(ns, cost + h(nIdx));
      }
    };
    if (i + 1 < nx && !hBlocked[idx]) relax(idx + 1, 0, xs[i + 1] - xs[i]);
    if (i > 0 && !hBlocked[idx - 1]) relax(idx - 1, 0, xs[i] - xs[i - 1]);
    if (j + 1 < ny && !vBlocked[idx]) relax(idx + nx, 1, ys[j + 1] - ys[j]);
    if (j > 0 && !vBlocked[idx - nx]) relax(idx - nx, 1, ys[j] - ys[j - 1]);
  }
  if (found < 0) return null;

  const path: Pt[] = [];
  for (let st = found; st >= 0; st = prev[st]) {
    const idx = st >> 1;
    path.push([xs[idx % nx], ys[(idx / nx) | 0]]);
  }
  path.reverse();
  return path;
}

/** Drops repeated and collinear points. */
export function simplify(points: Pt[]): Pt[] {
  const out: Pt[] = [];
  for (const p of points) {
    const last = out[out.length - 1];
    if (last && Math.abs(last[0] - p[0]) < 0.01 && Math.abs(last[1] - p[1]) < 0.01) continue;
    out.push([p[0], p[1]]);
    while (out.length >= 3) {
      const [a, b, c] = out.slice(-3);
      const collinear = (Math.abs(a[0] - b[0]) < 0.01 && Math.abs(b[0] - c[0]) < 0.01) || (Math.abs(a[1] - b[1]) < 0.01 && Math.abs(b[1] - c[1]) < 0.01);
      if (!collinear) break;
      out.splice(out.length - 2, 1);
    }
  }
  return out;
}

interface Seg {
  route: Pt[];
  k: number; // segment from route[k] to route[k+1]
  at: number; // fixed coordinate
  lo: number;
  hi: number;
  key: string;
}

/**
 * Spreads parallel segments that share a line and overlap, so lines run side by side instead of
 * on top of each other. Port stubs (first and last segments) are never moved; moving the
 * segment next to a stub only lengthens or shortens the stub.
 */
function nudge(routes: Map<string, Pt[]>, opts: RouteOptions) {
  const vertical: Seg[] = [];
  const horizontal: Seg[] = [];
  for (const [key, r] of routes) {
    for (let k = 1; k < r.length - 2; k++) {
      const [a, b] = [r[k], r[k + 1]];
      if (Math.abs(a[0] - b[0]) < 0.01) vertical.push({ route: r, k, at: a[0], lo: Math.min(a[1], b[1]), hi: Math.max(a[1], b[1]), key });
      else horizontal.push({ route: r, k, at: a[1], lo: Math.min(a[0], b[0]), hi: Math.max(a[0], b[0]), key });
    }
  }
  const maxSpread = 2 * opts.margin - 6;
  const spread = (segs: Seg[], axis: 0 | 1) => {
    segs.sort((p, q) => p.at - q.at || p.lo - q.lo || p.key.localeCompare(q.key));
    let i = 0;
    while (i < segs.length) {
      // Segments on the same line…
      let j = i;
      while (j < segs.length && Math.abs(segs[j].at - segs[i].at) < 0.6) j++;
      const line = segs.slice(i, j);
      // …grouped into clusters of overlapping spans.
      line.sort((p, q) => p.lo - q.lo || p.key.localeCompare(q.key));
      let c = 0;
      while (c < line.length) {
        let end = line[c].hi;
        let d = c + 1;
        while (d < line.length && line[d].lo < end - 0.5) {
          end = Math.max(end, line[d].hi);
          d++;
        }
        const cluster = line.slice(c, d);
        if (cluster.length > 1) {
          const gap = Math.min(opts.nudge, maxSpread / (cluster.length - 1));
          orderToAvoidCrossings(cluster, axis);
          cluster.forEach((s, n) => {
            const off = (n - (cluster.length - 1) / 2) * gap;
            s.route[s.k][axis] += off;
            s.route[s.k + 1][axis] += off;
          });
        }
        c = d;
      }
      i = j;
    }
  };
  spread(vertical, 0);
  spread(horizontal, 1);
}

/**
 * Orders the segments of one bundle (low offset first) so that the segments joined to their ends
 * cross as few of the bundle's lines as possible. For a pair A, B: if A sits on the low side,
 * every joint of B that leaves towards the low side inside A's span crosses A, and every joint
 * of A that leaves towards the high side inside B's span crosses B.
 */
function orderToAvoidCrossings(cluster: Seg[], axis: 0 | 1) {
  const other = axis === 0 ? 1 : 0;
  const joints = (s: Seg) => {
    const r = s.route;
    const a = r[s.k];
    const b = r[s.k + 1];
    // Direction (along `axis`) in which the neighbouring segments leave this one.
    return [
      { at: a[other], dir: Math.sign(r[s.k - 1][axis] - a[axis]) },
      { at: b[other], dir: Math.sign(r[s.k + 2][axis] - b[axis]) },
    ];
  };
  const within = (v: number, s: Seg) => v > s.lo + 0.5 && v < s.hi - 0.5;
  const cost = (low: Seg, high: Seg) =>
    joints(high).filter((j) => j.dir < 0 && within(j.at, low)).length + joints(low).filter((j) => j.dir > 0 && within(j.at, high)).length;
  // Insertion sort with the pairwise preference; bundles are small.
  const out: Seg[] = [];
  for (const s of [...cluster].sort((p, q) => p.key.localeCompare(q.key))) {
    let i = out.length;
    while (i > 0 && cost(s, out[i - 1]) < cost(out[i - 1], s)) i--;
    out.splice(i, 0, s);
  }
  cluster.splice(0, cluster.length, ...out);
}

class MinHeap {
  private ids: number[] = [];
  private keys: number[] = [];
  get size() {
    return this.ids.length;
  }
  push(id: number, key: number) {
    const ids = this.ids;
    const keys = this.keys;
    let i = ids.length;
    ids.push(id);
    keys.push(key);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (keys[p] <= key) break;
      ids[i] = ids[p];
      keys[i] = keys[p];
      i = p;
    }
    ids[i] = id;
    keys[i] = key;
  }
  pop(): number {
    const ids = this.ids;
    const keys = this.keys;
    const top = ids[0];
    const lastId = ids.pop()!;
    const lastKey = keys.pop()!;
    if (ids.length) {
      let i = 0;
      const n = ids.length;
      while (true) {
        const l = 2 * i + 1;
        if (l >= n) break;
        const r = l + 1;
        const m = r < n && keys[r] < keys[l] ? r : l;
        if (keys[m] >= lastKey) break;
        ids[i] = ids[m];
        keys[i] = keys[m];
        i = m;
      }
      ids[i] = lastId;
      keys[i] = lastKey;
    }
    return top;
  }
}

/** SVG path for a polyline with rounded corners. */
export function roundedPath(points: Pt[], radius = 8): string {
  if (points.length < 2) return '';
  let d = `M${fmt(points[0][0])},${fmt(points[0][1])}`;
  for (let k = 1; k < points.length - 1; k++) {
    const [px, py] = points[k - 1];
    const [cx, cy] = points[k];
    const [nx, ny] = points[k + 1];
    const r = Math.min(radius, Math.hypot(cx - px, cy - py) / 2, Math.hypot(nx - cx, ny - cy) / 2);
    const ax = cx - Math.sign(cx - px) * r;
    const ay = cy - Math.sign(cy - py) * r;
    const bx = cx + Math.sign(nx - cx) * r;
    const by = cy + Math.sign(ny - cy) * r;
    d += ` L${fmt(ax)},${fmt(ay)} Q${fmt(cx)},${fmt(cy)} ${fmt(bx)},${fmt(by)}`;
  }
  const last = points[points.length - 1];
  return `${d} L${fmt(last[0])},${fmt(last[1])}`;
}

const fmt = (n: number) => (Math.round(n * 10) / 10).toString();
