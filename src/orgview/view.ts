import { interpolateZoom } from 'd3-interpolate';
import type { ApiDetails, GraphSource } from '../spec0/types';
import { el, svgEl } from '../viewer/dom';
import {
  ancestors,
  compact,
  connections,
  dependents,
  methodMix,
  tracePath,
  within,
  type Card,
  type Grant,
  type Hierarchy,
  type OrgGraph,
} from './graph';
import { API_OPEN, apiInterior, boardBounds, HEAD as HEAD_OF, TILE, type Geo, type Rect } from './layout';
import './style.css';

/**
 * The org graph board. Cards are HTML, nested the way the org is: a team holds its services, a
 * service its APIs, an API its operations. Each card is a fixed tile; what it shows depends on how
 * large it is on screen (a summary, then its children, then their insides). Lines are drawn only
 * for the focused card, in screen space, every frame, so they never lag or flicker; ends that are
 * off screen become portals at the edge you can click to fly to.
 */

export interface OrgViewHooks {
  /** Switch between "by team" and "by domain". */
  setHierarchy?(h: Hierarchy): void;
  /** URL of an API's spec in the host app, if there is one. */
  specUrl?(apiId: string): string | null;
}

type Theme = 'dark' | 'light';
type Focus = { card: string; op?: number } | null;
type Mode = { kind: 'trace'; from: string; to: string; cards: string[]; grants: Grant[] } | { kind: 'impact'; of: string; cards: Set<string> } | null;

const MIN_PX = 9;
const SOURCES: Record<string, string> = { GITHUB: 'GitHub', MANUAL_UPLOAD: 'Manual upload', RUNTIME_DETECTED: 'Runtime', API_SPEC_CRD: 'Kubernetes CRD' };
const OP_FONT = 13;
const API_NAME_FONT = 15;
const LEVELS: Record<Hierarchy, string[]> = { team: ['Org', 'Team', 'Service', 'API', 'Op'], domain: ['Org', 'Domain', 'API', 'Op'] };

export function mountOrgView(app: HTMLElement, graph: OrgGraph, geo: Map<string, Geo>, source: GraphSource, hooks: OrgViewHooks = {}) {
  const cards = graph.cards;
  const card = (id: string) => cards.get(id)!;
  const details = new Map<string, ApiDetails>();
  const maxTraffic = Math.max(1, ...[...cards.values()].filter((c) => c.kind === 'api').map((c) => c.traffic));
  const orgSlug = graph.org.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const label = (id: string) => {
    const c = card(id);
    return c.kind === 'group' && c.slug ? c.slug.replace(/^team-/, '') : c.name;
  };

  // ── shell ─────────────────────────────────────────────────────────────────
  app.classList.add('ov');
  let theme: Theme = 'dark';
  try {
    theme = (localStorage.getItem('atlas-theme') as Theme) || 'dark';
  } catch {
    /* default */
  }
  app.dataset.theme = theme;

  const icon = (name: keyof typeof ICONS, cls = '') => {
    const s = svgEl<SVGSVGElement>('svg', { viewBox: '0 0 16 16', class: `ic ${cls}`.trim() });
    s.innerHTML = ICONS[name];
    return s;
  };

  const crumbs = el('div', { className: 'crumbs' });
  const searchBtn = el('button', { className: 'search' }, icon('search'), el('span', { textContent: 'Jump to a team, service, API or operation' }), el('kbd', { textContent: '⌘K' }));
  const seg = el('div', { className: 'seg' });
  for (const h of ['team', 'domain'] as Hierarchy[]) {
    const b = el('button', { textContent: h === 'team' ? 'By team' : 'By domain', className: h === graph.hierarchy ? 'on' : '' });
    b.onclick = () => h !== graph.hierarchy && hooks.setHierarchy?.(h);
    seg.append(b);
  }
  const filterBtn = el('button', { className: 'btn' }, icon('filter'), 'Filters');
  const themeBtn = el('button', { className: 'btn icon', title: 'Light or dark' }, icon(theme === 'dark' ? 'moon' : 'sun'));
  const linkBtn = el('button', { className: 'btn primary', textContent: 'Copy view link' });
  app.append(el('header', { className: 'top' }, el('div', { className: 'brand' }, el('span', { className: 'logo' }), 'atlas'), el('span', { className: 'sep' }), crumbs, searchBtn, seg, filterBtn, themeBtn, linkBtn));

  const status = el('div', { className: 'statusline' });
  status.append(
    el('span', { className: 'muted', textContent: `${graph.org.id} / ` }),
    graph.hierarchy === 'team' ? `${graph.totals.teams} teams · ${graph.totals.services} services · ` : `${graph.roots.length} domains · `,
    `${graph.totals.apis} APIs · ${graph.totals.grants} grants`,
    ...(graph.totals.pending ? [' · ', el('span', { className: 'amber', textContent: `${graph.totals.pending} pending` })] : []),
  );

  const stage = el('div', { className: 'stage' });
  const world = el('div', { className: 'world' });
  const edgeSvg = svgEl<SVGSVGElement>('svg', { class: 'edges' });
  const portals = el('div', { className: 'portals' });
  const opCard = el('div', { className: 'opcard', hidden: true });
  const minimap = el('canvas', { className: 'minimap' });
  const levels = el('div', { className: 'levels' });
  const bottom = el('div', { className: 'bottom' });
  const hints = el('div', { className: 'hints' });
  const meter = el('div', { className: 'meter' });
  const inspector = el('aside', { className: 'inspector', hidden: true });
  const palette = el('div', { className: 'palette-wrap', hidden: true });
  const filters = el('div', { className: 'pop filters', hidden: true });
  const toast = el('div', { className: 'toast', hidden: true });
  stage.append(world, edgeSvg, portals, opCard, status, minimap, levels, bottom, hints, inspector, filters, toast);
  app.append(stage, palette);
  hints.append(el('span', { textContent: '/ search · ⌫ zoom out' }), el('span', { textContent: 'double-click to dive' }), meter);

  // ── cards ─────────────────────────────────────────────────────────────────
  const elOf = new Map<string, HTMLElement>();
  const bars = (c: Card) => {
    const box = el('div', { className: 'bars' });
    const shown = c.apis.slice(0, 14);
    for (const a of shown) {
      const t = card(a).traffic;
      const b = el('i');
      if (t > 0) b.style.height = `${Math.round(22 + 78 * (Math.log10(t + 1) / Math.log10(maxTraffic + 1)))}%`;
      else b.className = 'idle';
      box.append(b);
    }
    return box;
  };
  const versionChip = (c: Card) => (c.api?.version ? el('span', { className: 'ver', textContent: `v${c.api.version.replace(/^v/, '')}` }) : '');
  const opsLine = (c: Card) => {
    const d = details.get(c.id);
    const ops = d?.operations.length ?? c.api!.operations;
    const sch = d?.schemas.length ?? c.api!.schemas;
    return [c.api!.specVersion, `${ops} ops`, `${sch} schemas`].filter(Boolean).join(' · ');
  };
  const callsLine = (c: Card) => (c.traffic ? `${compact(c.traffic)} calls / 30d` : 'no calls in 30d');

  // Closed service names: one size per set of siblings, fitted to the longest.
  const serviceFs = new Map<string, number>();
  for (const c of cards.values()) {
    const svcs = c.children.map(card).filter((k) => k.kind === 'service');
    if (!svcs.length) continue;
    const longest = Math.max(...svcs.map((s) => Math.min(s.name.length, 26)));
    const fs = Math.max(18, Math.min(34, (TILE.service.w - 40) / (longest * 0.62 * 0.62)));
    svcs.forEach((s) => serviceFs.set(s.id, fs));
  }

  function buildCard(id: string): HTMLElement {
    const c = card(id);
    const g = geo.get(id)!;
    const e = el('div', { className: `card k-${c.kind}` });
    e.dataset.id = id;
    Object.assign(e.style, { left: `${g.x}px`, top: `${g.y}px`, width: `${g.w}px`, height: `${g.h}px` });
    e.style.setProperty('--ws', String(g.ws));
    if (c.kind === 'group') {
      const people = c.members ? `${c.members} people · ` : '';
      e.append(
        el(
          'div',
          { className: 'sum' },
          el('div', { className: 'r1' }, el('span', { className: 'nm', textContent: c.name }), c.pending ? el('span', { className: 'badge', textContent: String(c.pending) }) : ''),
          bars(c),
          el(
            'div',
            { className: 'r2' },
            el('span', { textContent: graph.hierarchy === 'team' ? `${c.services} svc · ${c.apis.length} api` : `${c.apis.length} api` }),
            el('span', { textContent: c.traffic ? compact(c.traffic) : '–' }),
          ),
        ),
        el(
          'div',
          { className: 'head' },
          el('span', { className: 'nm', textContent: c.name }),
          c.slug ? el('span', { className: 'slug', textContent: c.slug }) : '',
          el('span', {
            className: 'stats',
            textContent: `${people}${graph.hierarchy === 'team' ? `${c.services} services · ` : ''}${c.apis.length} APIs · ${c.traffic ? `${compact(c.traffic)} calls / 30d` : 'no calls in 30d'}`,
          }),
        ),
      );
    } else if (c.kind === 'service') {
      const s = el('div', { className: 'sum' }, el('span', { className: 'nm', textContent: c.name }));
      s.style.fontSize = `${serviceFs.get(id) ?? 24}px`;
      e.append(s, el('div', { className: 'head' }, icon('service', 'svc'), el('span', { className: 'nm', textContent: c.name })));
    } else {
      e.append(
        el(
          'div',
          { className: 'sum' },
          el('div', { className: 'r1' }, icon('api', 'api'), el('span', { className: 'nm', textContent: c.name }), versionChip(c)),
          el('div', { className: 'r2', textContent: opsLine(c) }),
          el('div', { className: 'mix loading' }),
          el('div', { className: 'r3', textContent: callsLine(c) }),
        ),
      );
    }
    if (c.children.length) {
      const inner = el('div', { className: 'inner' });
      const it = g.interior!;
      Object.assign(inner.style, { left: `${it.x}px`, top: `${it.y}px`, width: `${it.w}px`, height: `${it.h}px`, transform: `scale(${it.scale})` });
      for (const k of c.children) inner.append(buildCard(k));
      e.append(inner);
    }
    elOf.set(id, e);
    return e;
  }
  // Cards people have dragged: positions in their parent, kept in this browser per board.
  const MOVES_KEY = `atlas-org-moves:${graph.org.id}:${graph.hierarchy}`;
  const moves = new Map<string, [number, number]>();
  try {
    for (const [id, xy] of Object.entries(JSON.parse(localStorage.getItem(MOVES_KEY) ?? '{}') as Record<string, [number, number]>)) if (geo.has(id)) moves.set(id, xy);
  } catch {
    /* the layout as built */
  }
  /** Move a card (and everything in it) to (x, y) in its parent's units. */
  function moveTo(id: string, x: number, y: number) {
    const g = geo.get(id)!;
    const dx = (x - g.x) * g.ws;
    const dy = (y - g.y) * g.ws;
    g.x = x;
    g.y = y;
    const shift = (cid: string) => {
      const a = geo.get(cid)!.abs;
      a.x += dx;
      a.y += dy;
      card(cid).children.forEach(shift);
    };
    shift(id);
    const e = elOf.get(id);
    if (e) Object.assign(e.style, { left: `${x}px`, top: `${y}px` });
  }
  for (const [id, [x, y]] of moves) moveTo(id, x, y);

  for (const r of graph.roots) world.append(buildCard(r));

  /** Method mix bar on an API preview, once its operations are known. */
  function fillMix(id: string) {
    const d = details.get(id);
    const m = elOf.get(id)?.querySelector('.mix') as HTMLElement | null;
    if (!d || !m) return;
    m.classList.remove('loading');
    m.replaceChildren(...methodMix(d).map(([meth, n]) => Object.assign(el('i', { className: `m-${meth.toLowerCase()}` }), { style: `flex:${n}` })));
    (elOf.get(id)!.querySelector('.r2') as HTMLElement).textContent = opsLine(card(id));
  }

  /** The inside of an open API: operations, schemas, and the lines between them. */
  function buildOps(id: string) {
    const c = card(id);
    const d = details.get(id)!;
    const e = elOf.get(id)!;
    e.querySelector('.ops')?.remove();
    const size = apiInterior(d.operations.length, d.schemas.length);
    const box = el('div', { className: 'ops' });
    Object.assign(box.style, {
      width: `${size.w}px`,
      height: `${size.h}px`,
      left: `${(TILE.api.w - size.w * size.scale) / 2}px`,
      top: `${(TILE.api.h - size.h * size.scale) / 2}px`,
      transform: `scale(${size.scale})`,
    });
    const owner = graph.teamName(c.team).toLowerCase();
    box.append(
      el(
        'div',
        { className: 'oh' },
        icon('api', 'api'),
        el('span', { className: 'nm', textContent: c.name }),
        versionChip(c),
        el('span', { className: 'tr', textContent: c.traffic ? `${compact(c.traffic)} / 30d` : 'no calls' }),
      ),
      el('div', { className: 'osub', textContent: [c.api!.specVersion && `spec ${c.api!.specVersion}`, `${d.operations.length} operations`, `${d.schemas.length} schemas`, `team-wide: ${owner}`].filter(Boolean).join(' · ') }),
    );
    const order = d.operations.map((o, i) => ({ o, i })).sort((a, b) => a.o.path.localeCompare(b.o.path) || a.o.method.localeCompare(b.o.method));
    const rows = el('div', { className: 'rows' });
    order.slice(0, API_OPEN.maxRows).forEach(({ o, i }) => {
      const r = el(
        'div',
        { className: 'op' },
        el('span', { className: `m m-${o.method.toLowerCase()}`, textContent: o.method.toUpperCase() }),
        el('span', { className: 'p', textContent: o.path }),
        el('span', { className: 'oid', textContent: o.operationId ?? '' }),
      );
      r.dataset.op = String(i);
      rows.append(r);
    });
    if (order.length > API_OPEN.maxRows) rows.append(el('div', { className: 'more', textContent: `+ ${order.length - API_OPEN.maxRows} more` }));
    const sch = el('div', { className: 'schemas' }, el('div', { className: 'lab', textContent: `SCHEMAS · ${d.schemas.length}` }));
    d.schemas.slice(0, API_OPEN.maxRows - 1).forEach((s, i) => {
      const r = el('div', { className: 'sc' }, el('span', { textContent: s.name }), el('b', { textContent: String(s.propertyCount) }));
      r.dataset.schema = String(i);
      sch.append(r);
    });
    const lines = svgEl<SVGSVGElement>('svg', { class: 'olines', width: size.w, height: size.h });
    box.append(rows, sch, lines);
    e.append(box);
  }

  // ── view state ────────────────────────────────────────────────────────────
  const view = { x: 0, y: 0, k: 1 };
  let focus: Focus = null;
  let mode: Mode = null;
  const open = new Set<string>();
  const opts = { pending: true, inside: true };
  const vp = () => ({ w: stage.clientWidth, h: stage.clientHeight });
  const screen = (r: Rect): Rect => ({ x: r.x * view.k + view.x, y: r.y * view.k + view.y, w: r.w * view.k, h: r.h * view.k });
  const onScreen = (r: Rect, m = 0) => {
    const v = vp();
    return r.x + r.w > -m && r.y + r.h > -m && r.x < v.w + m && r.y < v.h + m;
  };
  let bounds = boardBounds(graph, geo);

  /** Zoom at which a container's children (or an API's operations) become legible. */
  const openAt = (id: string): number => {
    const c = card(id);
    const g = geo.get(id)!;
    if (c.kind === 'api') {
      const d = details.get(id);
      const s = apiInterior(d?.operations.length ?? c.api!.operations, d?.schemas.length ?? c.api!.schemas).scale;
      return MIN_PX / (OP_FONT * s * g.ws);
    }
    const kid = card(c.children[0]);
    const kws = geo.get(kid.id)!.ws;
    const font = kid.kind === 'service' ? (serviceFs.get(kid.id) ?? 24) : API_NAME_FONT;
    return MIN_PX / (font * kws);
  };
  const openK = new Map([...cards.keys()].filter((id) => card(id).children.length || card(id).kind === 'api').map((id) => [id, openAt(id)]));

  // ── details ───────────────────────────────────────────────────────────────
  const wanted = new Set<string>();
  const loading = new Set<string>();
  let flushTimer = 0;
  function want(id: string) {
    if (details.has(id) || loading.has(id) || wanted.has(id)) return;
    wanted.add(id);
    clearTimeout(flushTimer);
    flushTimer = window.setTimeout(flush, wanted.size >= 50 ? 0 : 120);
  }
  async function flush() {
    const batch = [...wanted].slice(0, 50);
    batch.forEach((id) => {
      wanted.delete(id);
      loading.add(id);
    });
    if (!batch.length) return;
    try {
      const res = await source.details(batch.map((id) => ({ id: id.slice(2), specVersion: card(id).api!.specVersion })));
      for (const d of res) {
        const id = `a:${d.id}`;
        if (!cards.has(id)) continue;
        details.set(id, d);
        openK.set(id, openAt(id));
        fillMix(id);
      }
    } finally {
      batch.forEach((id) => loading.delete(id));
      renderMeter();
      if (wanted.size) flush();
      schedule();
      if (focus && inspector.hidden === false) renderInspector();
    }
  }
  function renderMeter() {
    const det = source.stats.requests.filter((r) => r.kind === 'details');
    const kb = det.reduce((s, r) => s + r.bytes, 0) / 1024;
    meter.textContent = det.length ? `details loaded · ${det.length} batch${det.length === 1 ? '' : 'es'} · ${kb.toFixed(1)} KB` : '';
  }

  // ── per-frame update ──────────────────────────────────────────────────────
  let pending = false;
  function schedule() {
    if (pending) return;
    pending = true;
    requestAnimationFrame(update);
  }

  function walk(ids: string[]) {
    for (const id of ids) {
      const e = elOf.get(id)!;
      const c = card(id);
      const sr = screen(geo.get(id)!.abs);
      const on = onScreen(sr, 80);
      e.classList.toggle('off', !on);
      if (!on) continue;
      const ok = openK.get(id);
      let isOpen = false;
      if (ok !== undefined) {
        const was = open.has(id);
        isOpen = view.k >= ok * (was ? 0.88 : 1);
        if (c.kind === 'api') {
          if (isOpen && !details.has(id)) {
            want(id);
            isOpen = false;
          } else if (isOpen && !e.querySelector('.ops')) buildOps(id);
        }
      }
      if (c.kind === 'api' && API_NAME_FONT * geo.get(id)!.ws * view.k >= 6) want(id);
      if (isOpen) open.add(id);
      else open.delete(id);
      e.classList.toggle('open', isOpen);
      if (!isOpen || !c.children.length) closedRects.push({ id, r: sr });
      if (isOpen && c.children.length) walk(c.children);
    }
  }

  let lastLevel = '';
  let focusOpen = false;
  function update() {
    pending = false;
    world.style.transform = `translate(${view.x}px, ${view.y}px) scale(${view.k})`;
    world.style.setProperty('--k', String(view.k));
    stage.style.backgroundSize = `${gridStep()}px ${gridStep()}px`;
    stage.style.backgroundPosition = `${view.x % gridStep()}px ${view.y % gridStep()}px`;
    closedRects = [];
    walk(graph.roots);
    applyFocusClasses();
    drawEdges();
    placeOpCard();
    const fo = !!focus && open.has(focus.card);
    if (fo !== focusOpen) {
      focusOpen = fo;
      renderBottom();
    }
    const lvl = levelNow();
    if (lvl.key !== lastLevel) {
      lastLevel = lvl.key;
      renderCrumbs(lvl.chain);
      status.hidden = lvl.chain.length > 0;
    }
    renderLevels(lvl.index);
    drawMinimap();
    writeHashSoon();
  }
  const gridStep = () => {
    let s = 22 * view.k;
    while (s < 14) s *= 2;
    while (s >= 28) s /= 2;
    return s;
  };

  /** Deepest open card under the middle of the screen, and the level it puts you at. */
  function levelNow(): { chain: string[]; index: number; key: string } {
    const v = vp();
    const cx = (v.w / 2 - view.x) / view.k;
    const cy = (v.h / 2 - view.y) / view.k;
    const hit = (ids: string[]): string[] => {
      for (const id of ids) {
        const r = geo.get(id)!.abs;
        if (cx < r.x || cy < r.y || cx > r.x + r.w || cy > r.y + r.h || !open.has(id)) continue;
        return [id, ...hit(card(id).children)];
      }
      return [];
    };
    const chain = hit(graph.roots);
    const names = LEVELS[graph.hierarchy];
    let index = chain.length;
    if (graph.hierarchy === 'team' && chain.length >= 3) index = 4;
    else if (graph.hierarchy === 'team' && chain.length === 2) index = 2;
    if (graph.hierarchy === 'domain' && chain.length >= 2) index = 3;
    index = Math.min(index, names.length - 1);
    return { chain, index, key: `${chain.join('>')}|${index}` };
  }

  // ── focus ─────────────────────────────────────────────────────────────────
  /** The card on the board that stands for `id` right now: itself, or its deepest shown ancestor. */
  function rep(id: string): string {
    const chain = ancestors(graph, id).reverse();
    let r = chain[0];
    for (let i = 1; i < chain.length && open.has(chain[i - 1]); i++) r = chain[i];
    return r;
  }

  interface Line {
    from: string | null;
    to: string | null;
    kind: 'in' | 'out' | 'inside' | 'trace';
    pending: boolean;
    grants: Grant[];
    /** Portal text for an end with no card on screen. */
    farName: string;
    farSub: string;
    farCard: string | null;
    /** Operation rows the grant covers, when its API is open. */
    ops?: number[];
  }

  let connCache: { id: string; c: ReturnType<typeof connections> } | null = null;
  const conns = (id: string) => {
    if (connCache?.id !== id) connCache = { id, c: connections(graph, id) };
    return connCache.c;
  };

  function linesFor(): Line[] {
    const out = new Map<string, Line>();
    const push = (g: Grant, kind: Line['kind']) => {
      if (g.status === 'PENDING' && !opts.pending) return;
      const consumer = graph.consumerCard(g);
      const a = consumer ? rep(consumer) : null;
      const b = rep(g.api);
      const key = `${a ?? `ext:${g.consumer}`}|${b}|${kind}|${g.status}`;
      let l = out.get(key);
      if (!l) {
        const far = kind === 'in' ? 'from' : 'to';
        const farCard = far === 'from' ? a : b;
        const team = graph.consumerTeam(g);
        // Portals name the team (or domain) at the far end; the line below says what in it.
        l = {
          from: a,
          to: b,
          kind,
          pending: g.status === 'PENDING',
          grants: [],
          farCard: farCard ? ancestors(graph, farCard).at(-1)! : null,
          farName: far === 'from' ? (farCard ? card(ancestors(graph, farCard).at(-1)!).name : graph.teamName(team)) : card(ancestors(graph, b).at(-1)!).name,
          farSub: '',
          ops: undefined,
        };
        out.set(key, l);
      }
      l.grants.push(g);
    };
    if (mode?.kind === 'trace') {
      for (const g of mode.grants) push(g, 'trace');
    } else if (mode?.kind === 'impact') {
      for (const g of graph.grants) {
        const c = graph.consumerCard(g);
        if (g.status === 'APPROVED' && c && mode.cards.has(c) && [...mode.cards, mode.of].some((x) => within(graph, g.api, x))) push(g, 'in');
      }
    } else if (focus) {
      const f = focus.card;
      const { callers, calls, inside } = conns(f);
      callers.forEach((g) => push(g, 'in'));
      calls.forEach((g) => push(g, 'out'));
      if (opts.inside && open.has(f)) inside.forEach((g) => push(g, 'inside'));
    }
    for (const l of out.values()) {
      const scoped = l.grants.filter((g) => g.scoped).length;
      if (l.kind === 'in' || l.kind === 'trace') {
        const g = l.grants[0];
        const who = g.consumerKind === 'SERVICE' ? graph.consumerName(g) : 'team';
        // How many operations scoped grants cover, once the API's details are known; once the
        // API is open the lines land on exactly those rows.
        let all = false;
        const ops = new Set<number>();
        for (const gr of l.grants) {
          const d = details.get(gr.api);
          const go = d?.grantOperations?.find((x) => x.consumer === gr.consumer && x.consumerKind === gr.consumerKind);
          if (gr.scoped && go) go.operations.forEach((i) => ops.add(i));
          else all = true;
        }
        l.farSub = !all && ops.size ? `${who} · ${ops.size} op${ops.size === 1 ? '' : 's'}` : who;
        if (!all && ops.size && l.to && open.has(l.to) && card(l.to).kind === 'api') l.ops = [...ops];
      } else if (l.kind === 'out') {
        l.farSub = [...new Set(l.grants.map((g) => card(g.api).name))].slice(0, 2).join(', ');
      }
    }
    return [...out.values()];
  }

  function litSet(): { lit: Set<string>; near: Set<string> } | null {
    if (mode?.kind === 'trace') return { lit: new Set(mode.cards.flatMap((c) => ancestors(graph, c))), near: new Set(mode.cards) };
    if (mode?.kind === 'impact') {
      const all = [mode.of, ...mode.cards];
      return { lit: new Set(all.flatMap((c) => ancestors(graph, c))), near: new Set(mode.cards) };
    }
    if (!focus) return null;
    const lit = new Set(ancestors(graph, focus.card));
    const near = new Set<string>();
    const { callers, calls } = conns(focus.card);
    for (const g of [...callers, ...calls]) {
      const c = graph.consumerCard(g);
      for (const x of [c ? rep(c) : null, rep(g.api)]) {
        if (!x || within(graph, x, focus.card) || within(graph, focus.card, x)) continue;
        near.add(x);
        ancestors(graph, x).forEach((a) => lit.add(a));
      }
    }
    return { lit, near };
  }

  function applyFocusClasses() {
    const s = litSet();
    const mark = (ids: string[], insideLit: boolean) => {
      for (const id of ids) {
        const e = elOf.get(id)!;
        const isFocus = focus?.card === id && !mode;
        const inLit = insideLit || (s ? s.near.has(id) || id === focus?.card || (mode?.kind === 'impact' && mode.of === id) : true);
        const bright = !s || inLit || s.lit.has(id);
        e.classList.toggle('dim', !bright);
        e.classList.toggle('focus', isFocus);
        e.classList.toggle('near', !!s && s.near.has(id));
        if (bright && open.has(id)) mark(card(id).children, inLit);
      }
    };
    mark(graph.roots, false);
    // Selected operation inside an open API.
    for (const r of world.querySelectorAll('.op.sel')) r.classList.remove('sel');
    for (const r of world.querySelectorAll('.sc.carry')) r.classList.remove('carry');
    if (focus?.op !== undefined) {
      const e = elOf.get(focus.card);
      e?.querySelector(`.op[data-op="${focus.op}"]`)?.classList.add('sel');
      const d = details.get(focus.card);
      d?.carries.filter(([o]) => o === focus!.op).forEach(([, s]) => e?.querySelector(`.sc[data-schema="${s}"]`)?.classList.add('carry'));
    }
    drawOpLines();
  }

  /** Inside an open API: the selected operation to the schemas it carries; references dashed. */
  function drawOpLines() {
    for (const svg of world.querySelectorAll<SVGSVGElement>('.olines')) svg.replaceChildren();
    if (focus?.op === undefined) return;
    const e = elOf.get(focus.card);
    const d = details.get(focus.card);
    const svg = e?.querySelector<SVGSVGElement>('.olines');
    const box = e?.querySelector<HTMLElement>('.ops');
    if (!e || !d || !svg || !box) return;
    const row = box.querySelector<HTMLElement>(`.op[data-op="${focus.op}"]`);
    if (!row) return;
    const local = (x: HTMLElement) => ({ x: x.offsetLeft, y: x.offsetTop, w: x.offsetWidth, h: x.offsetHeight });
    const rows = box.querySelector<HTMLElement>('.rows')!;
    const sch = box.querySelector<HTMLElement>('.schemas')!;
    const rr = local(row);
    const x0 = rows.offsetLeft + rr.x + rr.w + 4;
    const y0 = rows.offsetTop + rr.y + rr.h / 2;
    const carried = d.carries.filter(([o]) => o === focus!.op).map(([, s]) => s);
    const mid = x0 + (sch.offsetLeft - x0) / 2;
    for (const s of carried) {
      const c = sch.querySelector<HTMLElement>(`.sc[data-schema="${s}"]`);
      if (!c) continue;
      const y1 = sch.offsetTop + c.offsetTop + c.offsetHeight / 2;
      const x1 = sch.offsetLeft + c.offsetLeft;
      svg.append(svgEl('path', { d: roundPoly(elbowPts([x0, y0], [x1 - 2, y1], 'h'), 6), class: 'carry' }), arrow([x1 - 2, y1], 0, 'carry'));
    }
    // References among the carried schemas, on the far side.
    const xr = sch.offsetLeft + sch.offsetWidth + 10;
    for (const [a, b] of d.references) {
      if (!carried.includes(a)) continue;
      const ca = sch.querySelector<HTMLElement>(`.sc[data-schema="${a}"]`);
      const cb = sch.querySelector<HTMLElement>(`.sc[data-schema="${b}"]`);
      if (!ca || !cb) continue;
      const ya = sch.offsetTop + ca.offsetTop + ca.offsetHeight / 2;
      const yb = sch.offsetTop + cb.offsetTop + cb.offsetHeight / 2;
      const xe = sch.offsetLeft + sch.offsetWidth + 2;
      svg.append(svgEl('path', { d: `M${xe},${ya} H${xr} V${yb} H${xe + 4}`, class: 'ref' }), arrow([xe + 2, yb], 180, 'ref'));
    }
  }

  // ── lines and portals ─────────────────────────────────────────────────────
  /** Cards drawn closed on screen this frame: what a line should not run through. */
  let closedRects: Array<{ id: string; r: Rect }> = [];

  function drawEdges() {
    edgeSvg.replaceChildren();
    portals.replaceChildren();
    if (!focus && !mode) return;
    const v = vp();
    const right = inspector.hidden ? v.w : v.w - inspector.offsetWidth - 24;
    const lines = linesFor();
    const shown = (id: string | null) => !!id && onScreen(screen(geo.get(id)!.abs), -4);
    const sideFar: Array<{ l: Line; side: 'l' | 'r'; y: number }> = [];
    const segs: Array<{ a: Rect; b: Rect; l: Line; n: number; pending: boolean }> = [];
    for (const l of lines) {
      const fromOk = shown(l.from);
      const toOk = shown(l.to);
      // A team's own access to its APIs would be a line from the team to its own insides.
      if (l.from && l.to && (within(graph, l.from, l.to) || within(graph, l.to, l.from))) continue;
      if (fromOk && toOk) {
        const b = l.ops && l.to ? opRect(l.to, l.ops) : null;
        for (const r of b ?? [screen(geo.get(l.to!)!.abs)]) segs.push({ a: screen(geo.get(l.from!)!.abs), b: r, l, n: l.grants.length, pending: l.pending });
      } else if (fromOk || toOk) {
        const near = fromOk ? l.from! : l.to!;
        const r = screen(geo.get(near)!.abs);
        sideFar.push({ l, side: toOk ? 'l' : 'r', y: Math.max(r.y, Math.min(r.y + r.h, v.h / 2)) });
      }
    }

    // Portals: off-screen ends in a column on each side, near the card they connect to. One per
    // far team; one line from it to each card it reaches; at most as many as fit, then "+N more".
    const PW = 170;
    const STEP = 62;
    const portalSegs: Array<{ p: Rect; t: Rect; tid: string; side: 'l' | 'r'; l: Line; n: number; pending: boolean; lane: number }> = [];
    for (const side of ['l', 'r'] as const) {
      const list = sideFar.filter((p) => p.side === side);
      if (!list.length) continue;
      type Item = { key: string; far: string; sub: Set<string>; lines: typeof list; y: number; card: string | null };
      const byFar = new Map<string, Item>();
      for (const p of list) {
        const key = p.l.farCard ?? `name:${p.l.farName}`;
        const e = byFar.get(key) ?? { key, far: p.l.farName, sub: new Set<string>(), lines: [], y: 0, card: p.l.farCard };
        if (p.l.farSub) e.sub.add(p.l.farSub);
        e.lines.push(p);
        byFar.set(key, e);
      }
      let items = [...byFar.values()].map((x) => ({ ...x, y: x.lines.reduce((s, p) => s + p.y, 0) / x.lines.length }));
      // The right column stops above the minimap.
      const floor = v.h - 150 - (side === 'r' && minimap.offsetParent ? minimap.offsetHeight + 16 : 0);
      const room = Math.max(1, Math.floor((floor - 96) / STEP) + 1);
      if (items.length > room) {
        items.sort((a, b) => b.lines.length - a.lines.length || a.far.localeCompare(b.far));
        const rest = items.slice(room - 1);
        items = items.slice(0, room - 1);
        items.push({ key: 'more', far: `+${rest.length} more`, sub: new Set([rest.map((r) => r.far).join(', ')]), lines: rest.flatMap((r) => r.lines), y: Infinity, card: null });
      }
      items.sort((a, b) => a.y - b.y);
      let y = 96;
      const x = side === 'l' ? 24 : right - PW - 24;
      const lab = el('div', { className: 'plab', textContent: side === 'l' ? (mode?.kind === 'impact' ? 'DEPENDS ON IT' : 'CALLERS') : 'DEPENDS ON' });
      portals.append(lab);
      items.forEach((it, i) => {
        y = Math.max(y, Math.min(Number.isFinite(it.y) ? it.y - 24 : y, floor - (items.length - 1 - i) * STEP));
        if (i === 0) Object.assign(lab.style, { left: `${x}px`, top: `${y - 28}px` });
        const kind = it.lines[0].l.kind;
        const pending = it.lines.every((q) => q.l.pending);
        const p = el(
          'button',
          { className: `portal ${side} ${kind}${pending ? ' pending' : ''}${it.key === 'more' ? ' more' : ''}` },
          el('b', { textContent: it.far }),
          el('span', { textContent: [...it.sub].slice(0, 2).join(', ') || (side === 'l' ? 'team' : '') }),
        );
        Object.assign(p.style, { left: `${x}px`, top: `${y}px`, width: `${PW}px` });
        p.title = [...it.sub].join(', ');
        if (it.card) p.onclick = () => flyTo(it.card!, true);
        portals.append(p);
        const pr: Rect = { x, y, w: PW, h: 50 };
        // One line per card reached (or per operation row), carrying the number of grants.
        const byTarget = new Map<string, { t: Rect; tid: string; l: Line; n: number; pending: boolean }>();
        for (const q of it.lines) {
          const near = side === 'l' ? q.l.to! : q.l.from!;
          const rows = q.l.ops && side === 'l' ? opRect(near, q.l.ops) : null;
          (rows ?? [screen(geo.get(near)!.abs)]).forEach((t, j) => {
            const k = `${near}#${rows ? q.l.ops![j] : ''}`;
            const e = byTarget.get(k) ?? { t, tid: near, l: q.l, n: 0, pending: true };
            e.n += q.l.grants.length;
            e.pending &&= q.l.pending;
            byTarget.set(k, e);
          });
        }
        for (const e of byTarget.values()) portalSegs.push({ p: pr, t: e.t, tid: e.tid, side, l: e.l, n: e.n, pending: e.pending, lane: 0 });
        y += STEP;
      });
    }

    // Draw. Lines between two cards on screen bend once, halfway; lines to and from a portal turn
    // in their own lane beside it, and go round through the gap between rows when running straight
    // would cross another card.
    const ports = new Map<string, number>();
    const portKey = (r: Rect, s: string) => `${Math.round(r.x)},${Math.round(r.y)},${s}`;
    const take = (r: Rect, s: string) => {
      const i = ports.get(portKey(r, s)) ?? 0;
      ports.set(portKey(r, s), i + 1);
      return i;
    };
    const cards2 = segs.map((sg) => {
      const [sa, sb] = sides(sg.a, sg.b);
      return { ...sg, sa, sb, ia: take(sg.a, sa), ib: take(sg.b, sb) };
    });
    const laneN = { l: 0, r: 0 };
    for (const ps of portalSegs) ps.lane = laneN[ps.side]++;
    const total = (r: Rect, s: string) => ports.get(portKey(r, s)) ?? 1;
    const crosses = (y: number, x0: number, x1: number, skip: string) =>
      closedRects.some(({ id, r }) => id !== skip && !within(graph, skip, id) && y > r.y - 2 && y < r.y + r.h + 2 && Math.max(x0, x1) > r.x && Math.min(x0, x1) < r.x + r.w);
    const draw = (pts: Pt[], kind: Line['kind'], pending: boolean, n: number, end: Side, badgeAt: Pt) => {
      const cls = `e ${kind}${pending ? ' pending' : ''}`;
      edgeSvg.append(svgEl('path', { d: roundPoly(pts, 8), class: cls, 'stroke-width': (1.6 + Math.min(2.4, Math.log2(Math.max(1, n)) * 0.9)).toFixed(2) }));
      edgeSvg.append(arrow(pts[pts.length - 1], end === 'l' ? 0 : end === 'r' ? 180 : end === 't' ? 90 : 270, cls));
      if (n > 1) {
        const g = svgEl('g', { class: `count ${kind}`, transform: `translate(${badgeAt[0].toFixed(1)},${badgeAt[1].toFixed(1)})` });
        g.append(svgEl('rect', { x: -10, y: -8, width: 20, height: 16, rx: 8 }), Object.assign(svgEl('text', {}), { textContent: String(n) }));
        edgeSvg.append(g);
      }
    };
    for (const r of cards2) {
      const pa = port(r.a, r.sa, r.ia, total(r.a, r.sa));
      const pb = port(r.b, r.sb, r.ib, total(r.b, r.sb));
      const horiz = r.sa === 'r' || r.sa === 'l';
      const pts = elbowPts(pa, pb, horiz ? 'h' : 'v');
      draw(pts, r.l.kind, r.pending, r.n, r.sb, horiz ? [(pa[0] + pb[0]) / 2, pa[1]] : [pb[0], (pa[1] + pb[1]) / 2]);
    }
    for (const ps of portalSegs) {
      const lane = ps.lane % 14;
      const t = ps.t;
      if (ps.side === 'l') {
        const pa: Pt = [ps.p.x + ps.p.w, ps.p.y + ps.p.h / 2];
        const lx = pa[0] + 16 + lane * 7;
        const pb = port(t, 'l', take(t, 'l'), 1);
        if (!crosses(pb[1], lx, pb[0], ps.tid)) {
          draw([pa, [lx, pa[1]], [lx, pb[1]], pb], ps.l.kind, ps.pending, ps.n, 'l', [pb[0] - 18, pb[1]]);
          continue;
        }
        // Round through the gap below (or above) the card, and in from that side.
        const below = t.y + t.h + 14;
        const gy = !crosses(below, lx, t.x + t.w / 2, ps.tid) ? below : t.y - 14;
        const cx = t.x + Math.min(t.w / 2, 40 + lane * 6);
        draw([pa, [lx, pa[1]], [lx, gy], [cx, gy], [cx, gy > t.y ? t.y + t.h : t.y]], ps.l.kind, ps.pending, ps.n, gy > t.y ? 'b' : 't', [cx, gy]);
      } else {
        const pb: Pt = [ps.p.x, ps.p.y + ps.p.h / 2];
        const lx = pb[0] - 16 - lane * 7;
        const pa = port(t, 'r', take(t, 'r'), 1);
        if (!crosses(pa[1], pa[0], lx, ps.tid)) {
          draw([pa, [lx, pa[1]], [lx, pb[1]], pb], ps.l.kind, ps.pending, ps.n, 'l', [pa[0] + 18, pa[1]]);
          continue;
        }
        const below = t.y + t.h + 14;
        const gy = !crosses(below, t.x + t.w / 2, lx, ps.tid) ? below : t.y - 14;
        const cx = t.x + t.w - Math.min(t.w / 2, 40 + lane * 6);
        draw([[cx, gy > t.y ? t.y + t.h : t.y], [cx, gy], [lx, gy], [lx, pb[1]], pb], ps.l.kind, ps.pending, ps.n, 'l', [cx, gy]);
      }
    }
  }

  /** Screen rects of operation rows in an open API. */
  function opRect(api: string, ops: number[]): Rect[] | null {
    const e = elOf.get(api);
    const out: Rect[] = [];
    const sr = stage.getBoundingClientRect();
    for (const i of ops) {
      const r = e?.querySelector(`.op[data-op="${i}"]`)?.getBoundingClientRect();
      if (r && r.height > 2) out.push({ x: r.x - sr.x, y: r.y - sr.y, w: r.width, h: r.height });
    }
    return out.length ? out : null;
  }

  // ── op detail card ────────────────────────────────────────────────────────
  function placeOpCard() {
    const f = focus;
    if (!f || f.op === undefined || !open.has(f.card) || mode) {
      opCard.hidden = true;
      return;
    }
    const d = details.get(f.card)!;
    const o = d.operations[f.op];
    if (!o) {
      opCard.hidden = true;
      return;
    }
    if (opCard.dataset.key !== `${f.card}#${f.op}`) {
      opCard.dataset.key = `${f.card}#${f.op}`;
      const c = card(f.card);
      const carried = d.carries.filter(([oi]) => oi === f.op).map(([, s]) => d.schemas[s]?.name).filter(Boolean) as string[];
      const scoped = (d.grantOperations ?? []).map((go) => ({ go, covers: go.operations.includes(f.op!) }));
      const covering = scoped.filter((s) => s.covers).map((s) => graph.consumerName({ consumer: s.go.consumer, consumerKind: s.go.consumerKind }));
      const missing = scoped.filter((s) => !s.covers).map((s) => graph.consumerName({ consumer: s.go.consumer, consumerKind: s.go.consumerKind }));
      const wide = graph.grants.filter((g) => g.api === f.card && !g.scoped && g.status === 'APPROVED').map((g) => graph.consumerName(g));
      const owner = c.team ?? '';
      const curl = `curl -X ${o.method.toUpperCase()} "$BASE_URL${o.path}"`;
      const url = hooks.specUrl?.(f.card.slice(2));
      opCard.replaceChildren(
        el(
          'div',
          { className: 'oc-h' },
          el('span', { className: `m m-${o.method.toLowerCase()}`, textContent: o.method.toUpperCase() }),
          el('b', { textContent: o.path }),
          el('span', { className: 'oid', textContent: o.operationId ?? '' }),
          el('span', { className: 'grow' }),
          url ? Object.assign(el('a', { className: 'btn', textContent: 'Open in spec', href: url, target: '_blank' }), {}) : '',
          Object.assign(el('button', { className: 'btn', textContent: 'Copy as curl' }), { onclick: () => copy(curl, 'curl copied') }),
        ),
        el(
          'div',
          { className: 'oc-cols' },
          el('div', {}, el('h4', { textContent: 'Carries' }), ...(carried.length ? carried.map((s) => el('div', { textContent: s })) : [el('div', { className: 'muted', textContent: 'Nothing' })])),
          el(
            'div',
            {},
            el('h4', { textContent: 'Scoped grants' }),
            ...(covering.length
              ? covering.map((s) => el('div', { textContent: s }))
              : [el('div', { className: missing.length ? 'amber' : 'muted', textContent: missing.length ? `None — ${missing.join(', ')}'s grant doesn't cover this op` : 'None' })]),
          ),
          el('div', {}, el('h4', { textContent: 'Team-wide access' }), ...[owner, ...wide].filter((v, i, a) => v && a.indexOf(v) === i).map((s) => el('div', { textContent: s }))),
        ),
      );
    }
    opCard.hidden = false;
    const r = screen(geo.get(f.card)!.abs);
    const v = vp();
    const w = Math.min(760, Math.max(420, r.w));
    const below = r.y + r.h + 18;
    const top = below + 170 < v.h ? below : Math.max(70, r.y - 190);
    Object.assign(opCard.style, { left: `${Math.max(16, Math.min(v.w - w - 16, r.x + (r.w - w) / 2))}px`, top: `${top}px`, width: `${w}px` });
  }

  // ── chrome: crumbs, levels, bottom bar, minimap ───────────────────────────
  function renderCrumbs(chain: string[]) {
    crumbs.replaceChildren();
    if (!chain.length) {
      crumbs.append(el('span', { className: 'org', textContent: orgSlug }), el('span', { className: 'chip', textContent: `snapshot ${graph.version}` }));
      return;
    }
    const a = el('a', { textContent: graph.org.id });
    a.onclick = fit;
    crumbs.append(a);
    chain.forEach((id, i) => {
      crumbs.append(el('span', { className: 'muted', textContent: ' / ' }));
      const x = el('a', { textContent: label(id).toLowerCase(), className: i === chain.length - 1 ? 'here' : '' });
      x.onclick = () => flyTo(id);
      crumbs.append(x);
    });
  }

  function renderLevels(index: number) {
    const names = LEVELS[graph.hierarchy];
    const key = `${index}|${Math.round(view.k * 100)}`;
    if (levels.dataset.key === key) return;
    levels.dataset.key = key;
    levels.replaceChildren(
      ...names.map((n, i) => {
        const b = el('button', { textContent: n, className: i === index ? 'on' : '' });
        b.onclick = () => goLevel(i);
        return b;
      }),
      el('span', { className: 'pct', textContent: `${Math.round(view.k * 100)}%` }),
    );
  }

  function goLevel(i: number) {
    if (i === 0) return fit();
    const lvl = levelNow();
    const chain = focus ? ancestors(graph, focus.card).reverse() : lvl.chain;
    const kinds = graph.hierarchy === 'team' ? ['group', 'group', 'service', 'api', 'api'] : ['group', 'group', 'api', 'api'];
    let id = chain.find((c) => card(c).kind === kinds[i]);
    if (!id) {
      // Nothing focused at that level: the first one inside where you are.
      let cur = chain.at(-1) ?? graph.roots[0];
      while (card(cur).kind !== kinds[i] && card(cur).children.length) cur = card(cur).children[0];
      id = cur;
    }
    const isOp = i === LEVELS[graph.hierarchy].length - 1;
    flyTo(id, false, isOp ? 1.15 : i === 3 ? 0.8 : undefined);
  }

  function renderBottom() {
    bottom.replaceChildren();
    if (mode) {
      const txt =
        mode.kind === 'trace'
          ? el('span', {}, el('b', { textContent: 'Trace ' }), mode.cards.map((c) => card(c).name).join(' → '))
          : el('span', {}, el('b', { textContent: `${mode.cards.size} ` }), `card${mode.cards.size === 1 ? '' : 's'} depend on `, el('b', { textContent: label(mode.of) }));
      const x = el('button', { className: 'btn', textContent: 'Clear', title: 'Esc' });
      x.onclick = () => setMode(null);
      bottom.append(el('div', { className: 'bar' }, txt, x));
      return;
    }
    if (!focus || open.has(focus.card)) {
      bottom.append(legend());
      return;
    }
    const c = card(focus.card);
    const { callers, calls } = conns(focus.card);
    const groupsOf = (gs: Grant[], end: 'consumer' | 'api') =>
      new Set(gs.map((g) => (end === 'api' ? ancestors(graph, g.api).at(-1)! : (graph.consumerCard(g) ? ancestors(graph, graph.consumerCard(g)!).at(-1)! : `x:${graph.consumerTeam(g)}`)))).size;
    const sub =
      c.kind === 'group'
        ? `${graph.hierarchy === 'team' ? 'team' : 'domain'}${c.members ? ` · ${c.members} people` : ''}`
        : c.kind === 'service'
          ? `service · ${graph.teamName(c.team)}`
          : `api${c.api?.version ? ` · v${c.api.version.replace(/^v/, '')}` : ''}`;
    const zoom = el('button', { className: 'btn primary' }, 'Zoom in', el('kbd', { textContent: '↵' }));
    zoom.onclick = () => flyTo(focus!.card);
    const trace = el('button', { className: 'btn' }, 'Trace', el('kbd', { textContent: 'T' }));
    trace.onclick = () => openPalette('trace');
    const insp = el('button', { className: 'btn' }, 'Inspect', el('kbd', { textContent: 'I' }));
    insp.onclick = toggleInspector;
    bottom.append(
      el(
        'div',
        { className: 'bar' },
        el('span', { className: 'dot' }),
        el('b', { className: 'mono', textContent: label(focus.card).toLowerCase() }),
        el('span', { className: 'muted small', textContent: sub }),
        el('span', { className: 'vr' }),
        el('span', { className: 'in' }, '→ ', el('b', { textContent: String(groupsOf(callers, 'consumer')) }), ' callers'),
        el('span', { className: 'out' }, '→ ', el('b', { textContent: String(groupsOf(calls, 'api')) }), ' dependencies'),
        trace,
        insp,
        zoom,
      ),
    );
  }

  function legend() {
    const item = (cls: string, text: string) => el('span', { className: 'li' }, el('i', { className: cls }), text);
    return el(
      'div',
      { className: 'legend' },
      item('ln in', 'called by'),
      item('ln out', 'calls out'),
      item('ln inside', graph.hierarchy === 'team' ? 'inside the team' : 'inside the domain'),
      item('ln pending', 'pending grant'),
      item('sw m-get', 'GET'),
      item('sw m-post', 'POST'),
      item('sw m-patch', 'PATCH'),
      item('sw m-delete', 'DELETE'),
    );
  }

  const MM = { w: 170, h: 0, s: 0 };
  function drawMinimap() {
    const dpr = window.devicePixelRatio || 1;
    MM.s = MM.w / bounds.w;
    MM.h = Math.ceil(bounds.h * MM.s);
    if (minimap.width !== MM.w * dpr) {
      minimap.width = MM.w * dpr;
      minimap.height = MM.h * dpr;
      minimap.style.width = `${MM.w}px`;
      minimap.style.height = `${MM.h}px`;
    }
    const ctx = minimap.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, MM.w, MM.h);
    const css = getComputedStyle(app);
    const s = litSet();
    for (const r of graph.roots) {
      const a = geo.get(r)!.abs;
      const isF = focus && within(graph, focus.card, r);
      ctx.fillStyle = isF ? css.getPropertyValue('--teal') : s?.lit.has(r) ? css.getPropertyValue('--mm-near') : css.getPropertyValue('--mm-tile');
      ctx.fillRect((a.x - bounds.x) * MM.s, (a.y - bounds.y) * MM.s, Math.max(2, a.w * MM.s), Math.max(2, a.h * MM.s));
    }
    const v = vp();
    ctx.strokeStyle = css.getPropertyValue('--blue');
    ctx.lineWidth = 1.2;
    ctx.strokeRect(((-view.x) / view.k - bounds.x) * MM.s, ((-view.y) / view.k - bounds.y) * MM.s, (v.w / view.k) * MM.s, (v.h / view.k) * MM.s);
  }
  minimap.addEventListener('pointerdown', (e) => {
    const r = minimap.getBoundingClientRect();
    const wx = bounds.x + (e.clientX - r.left) / MM.s;
    const wy = bounds.y + (e.clientY - r.top) / MM.s;
    const v = vp();
    animate({ x: v.w / 2 - wx * view.k, y: v.h / 2 - wy * view.k, k: view.k }, 300);
  });

  // ── zoom and pan ──────────────────────────────────────────────────────────
  const kRange = () => {
    const v = vp();
    const fitK = Math.min(v.w / bounds.w, v.h / bounds.h);
    const deepest = Math.max(...[...openK.values()]);
    return [fitK * 0.4, deepest * 3] as const;
  };
  function setView(x: number, y: number, k: number) {
    const [lo, hi] = kRange();
    const kk = Math.min(hi, Math.max(lo, k));
    Object.assign(view, { x, y, k: kk });
    schedule();
  }
  function zoomAround(px: number, py: number, factor: number) {
    const [lo, hi] = kRange();
    const k = Math.min(hi, Math.max(lo, view.k * factor));
    const f = k / view.k;
    setView(px - (px - view.x) * f, py - (py - view.y) * f, k);
  }
  let anim = 0;
  function animate(to: { x: number; y: number; k: number }, ms?: number) {
    const v = vp();
    const from: [number, number, number] = [(v.w / 2 - view.x) / view.k, (v.h / 2 - view.y) / view.k, v.w / view.k];
    const dest: [number, number, number] = [(v.w / 2 - to.x) / to.k, (v.h / 2 - to.y) / to.k, v.w / to.k];
    const interp = interpolateZoom(from, dest);
    const dur = ms ?? Math.min(1000, Math.max(320, interp.duration * 0.55));
    const id = ++anim;
    const t0 = performance.now();
    const step = (now: number) => {
      if (id !== anim) return;
      const t = Math.min(1, (now - t0) / dur);
      const e = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
      const [cx, cy, w] = interp(e);
      const k = v.w / w;
      setView(v.w / 2 - cx * k, v.h / 2 - cy * k, k);
      if (t < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }
  /** Fly so a card fills the screen, at least far enough in for it to open. */
  function flyTo(id: string, focusIt = false, extra?: number) {
    if (focusIt) setFocus({ card: id });
    const r = geo.get(id)!.abs;
    const v = vp();
    const inset = inspector.hidden ? 0 : inspector.offsetWidth + 24;
    const room = { w: v.w - inset - 360, h: v.h - 220 };
    let k = Math.min(room.w / r.w, room.h / r.h);
    const ok = openK.get(id);
    // An API is shown with its rows at a comfortable reading size, with its neighbours around it,
    // rather than blown up to fill the screen.
    if (card(id).kind === 'api' && ok) k = Math.min(k, ok * (14 / MIN_PX));
    if (ok) k = Math.max(k, ok * 1.08);
    if (extra) k = Math.max(k, (ok ?? k) * extra);
    const cx = r.x + r.w / 2;
    const cy = r.y + r.h / 2;
    animate({ x: (v.w - inset) / 2 - cx * k, y: v.h / 2 + 10 - cy * k, k });
  }
  function fit() {
    const v = vp();
    const k = Math.min((v.w - 120) / bounds.w, (v.h - 200) / bounds.h);
    animate({ x: (v.w - bounds.w * k) / 2 - bounds.x * k, y: 96 + (v.h - 200 - bounds.h * k) / 2 - bounds.y * k, k });
  }

  const isMouseWheel = (e: WheelEvent) => e.deltaMode !== 0 || (e.deltaX === 0 && Number.isInteger(e.deltaY) && Math.abs(e.deltaY) >= 50);
  let glide = { target: 0, frame: 0, at: [0, 0] as [number, number] };
  stage.addEventListener(
    'wheel',
    (e) => {
      if ((e.target as Element).closest('.inspector, .pop, .palette')) return;
      e.preventDefault();
      anim++;
      const r = stage.getBoundingClientRect();
      const px = e.clientX - r.left;
      const py = e.clientY - r.top;
      if (e.ctrlKey || e.metaKey) return zoomAround(px, py, Math.exp(-e.deltaY * 0.01));
      if (!isMouseWheel(e)) return setView(view.x - e.deltaX, view.y - e.deltaY, view.k);
      // A wheel notch eases in around the pointer instead of jumping.
      const per = e.deltaMode === 1 ? 0.05 : e.deltaMode ? 1 : 0.002;
      glide.target = (glide.frame ? glide.target : view.k) * Math.pow(2, -e.deltaY * per);
      glide.at = [px, py];
      const step = () => {
        const done = Math.abs(Math.log(glide.target / view.k)) < 0.004;
        zoomAround(glide.at[0], glide.at[1], done ? glide.target / view.k : Math.pow(glide.target / view.k, 0.28));
        glide.frame = done ? 0 : requestAnimationFrame(step);
      };
      if (!glide.frame) glide.frame = requestAnimationFrame(step);
    },
    { passive: false },
  );

  // Drag the background (or the inside of an open card) to pan; click to focus.
  // A closed card, or an open one by its header, can be dragged within its parent.
  let press: { x: number; y: number; vx: number; vy: number; moved: boolean; id: number; drag: string | null; gx: number; gy: number } | null = null;
  const dragTarget = (t: Element): string | null => {
    const c = t.closest('.card') as HTMLElement | null;
    if (!c || t.closest('.op, .sc')) return null;
    const id = c.dataset.id!;
    return !open.has(id) || t.closest('.head') ? id : null;
  };
  stage.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || (e.target as Element).closest('button, a, .inspector, .pop, .opcard, .minimap, .portal')) return;
    anim++;
    const drag = dragTarget(e.target as Element);
    const g = drag ? geo.get(drag)! : null;
    press = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y, moved: false, id: e.pointerId, drag, gx: g?.x ?? 0, gy: g?.y ?? 0 };
  });
  window.addEventListener('pointermove', (e) => {
    if (!press || e.pointerId !== press.id) return;
    if (!press.moved && Math.hypot(e.clientX - press.x, e.clientY - press.y) < 4) return;
    if (!press.moved) {
      press.moved = true;
      stage.classList.add(press.drag ? 'dragging' : 'panning');
      if (press.drag) elOf.get(press.drag)!.parentElement!.append(elOf.get(press.drag)!);
    }
    if (!press.drag) return setView(press.vx + e.clientX - press.x, press.vy + e.clientY - press.y, view.k);
    const id = press.drag;
    const g = geo.get(id)!;
    let x = press.gx + (e.clientX - press.x) / (view.k * g.ws);
    let y = press.gy + (e.clientY - press.y) / (view.k * g.ws);
    const parent = card(id).parent;
    if (parent) {
      const it = geo.get(parent)!.interior!;
      const pg = geo.get(parent)!;
      // Inside the parent, below its header: the interior's own units are the child's.
      const minX = -it.x / it.scale;
      const minY = -(it.y - (HEAD_OF[card(parent).kind] ?? 0)) / it.scale;
      x = Math.min(Math.max(x, minX), (pg.w - it.x) / it.scale - g.w);
      y = Math.min(Math.max(y, minY), (pg.h - it.y) / it.scale - g.h);
    }
    moveTo(id, x, y);
    schedule();
  });
  window.addEventListener('pointerup', (e) => {
    if (!press || e.pointerId !== press.id) return;
    const { moved, drag } = press;
    press = null;
    stage.classList.remove('panning', 'dragging');
    if (moved && drag) {
      const g = geo.get(drag)!;
      moves.set(drag, [+g.x.toFixed(2), +g.y.toFixed(2)]);
      saveMoves();
      bounds = boardBounds(graph, geo);
      schedule();
    }
    if (moved) return;
    const t = e.target as Element;
    const row = t.closest?.('.op') as HTMLElement | null;
    const c = t.closest?.('.card') as HTMLElement | null;
    if (row && c) setFocus({ card: c.dataset.id!, op: Number(row.dataset.op) });
    else if (c) setFocus({ card: c.dataset.id! });
    else if (t.closest?.('.world') || t === stage || t.closest?.('.edges')) setFocus(null);
  });
  stage.addEventListener('dblclick', (e) => {
    const c = (e.target as Element).closest('.card') as HTMLElement | null;
    if (!c) return;
    e.preventDefault();
    const id = c.dataset.id!;
    // Dive: into the card if it's closed, else into its child under the pointer (already focused).
    flyTo(open.has(id) && card(id).kind !== 'api' ? id : id, true, open.has(id) ? 1.6 : undefined);
  });

  // ── focus and modes ───────────────────────────────────────────────────────
  function setFocus(f: Focus) {
    focus = f;
    if (mode && f) mode = null;
    renderBottom();
    if (!inspector.hidden) f ? renderInspector() : (inspector.hidden = true);
    schedule();
  }
  function setMode(m: Mode) {
    mode = m;
    renderBottom();
    schedule();
  }

  // ── inspector ─────────────────────────────────────────────────────────────
  let tab = 'Overview';
  function toggleInspector() {
    if (!focus) return;
    inspector.hidden = !inspector.hidden;
    if (!inspector.hidden) renderInspector();
    schedule();
  }
  function renderInspector() {
    if (!focus) return;
    const c = card(focus.card);
    if (c.kind === 'api') want(c.id);
    const d = details.get(c.id);
    const close = el('button', { className: 'x', title: 'Close (Esc)' }, icon('x'));
    close.onclick = () => {
      inspector.hidden = true;
      schedule();
    };
    const head: Node[] = [el('div', { className: 'ih' }, el('span', { className: `kind k-${c.kind}`, textContent: c.kind === 'group' ? (graph.hierarchy === 'team' ? 'TEAM' : 'DOMAIN') : c.kind.toUpperCase() }), close)];
    head.push(el('h2', { textContent: c.name }));
    const idText = c.kind === 'api' ? c.api!.id : c.slug ?? c.id.slice(2);
    const copyId = el('button', { className: 'copy', title: 'Copy id' }, icon('copy'));
    copyId.onclick = () => copy(idText, 'Id copied');
    head.push(el('div', { className: 'idl' }, el('span', { textContent: idText }), copyId));
    const { callers, calls } = conns(c.id);
    const consumersOf = (gs: Grant[]) => {
      const m = new Map<string, { name: string; ops: number | 'all'; pending: boolean; card: string | null }>();
      for (const g of gs) {
        const name = graph.consumerName(g);
        const go = d?.grantOperations?.find((x) => x.consumer === g.consumer && x.consumerKind === g.consumerKind);
        m.set(`${g.consumerKind}:${g.consumer}`, { name: g.consumerKind === 'TEAM' ? g.consumer : name, ops: g.scoped && go ? go.operations.length : 'all', pending: g.status === 'PENDING', card: graph.consumerCard(g) });
      }
      return [...m.values()];
    };
    const list = (rows: Array<{ name: string; meta: string; card: string | null; pending?: boolean }>) =>
      rows.length
        ? el(
            'div',
            { className: 'list' },
            ...rows.map((r) => {
              const b = el('button', { className: `row${r.pending ? ' pending' : ''}` }, el('i'), el('span', { textContent: r.name }), el('span', { className: 'meta', textContent: r.meta }));
              if (r.card) b.onclick = () => flyTo(r.card!, true);
              return b;
            }),
          )
        : el('p', { className: 'muted', textContent: 'None' });
    const body: Node[] = [];
    const dl = (pairs: Array<[string, Node | string]>) => el('dl', {}, ...pairs.flatMap(([k, v]) => [el('dt', { textContent: k }), el('dd', {}, v)]));
    if (c.kind === 'api') {
      const tabs = ['Overview', `Consumers`, `Schemas`, `Versions`];
      const counts: Record<string, string> = { Consumers: String(consumersOf(callers).length), Schemas: String(d?.schemas.length ?? c.api!.schemas), Versions: String(d?.versions.length ?? '') };
      if (!tabs.includes(tab)) tab = 'Overview';
      head.push(
        el(
          'div',
          { className: 'tabs' },
          ...tabs.map((t) => {
            const b = el('button', { className: t === tab ? 'on' : '' }, t, counts[t] ? el('small', { textContent: counts[t] }) : '');
            b.onclick = () => {
              tab = t;
              renderInspector();
            };
            return b;
          }),
        ),
      );
      if (tab === 'Overview') {
        const svc = c.parent && card(c.parent).kind === 'service' ? card(c.parent).name : '—';
        body.push(
          dl([
            ['Owner', graph.teamName(c.team)],
            ['Service', svc],
            ['Version', [c.api!.version && `v${c.api!.version.replace(/^v/, '')}`, c.api!.specVersion && `spec ${c.api!.specVersion}`].filter(Boolean).join(' · ') || '—'],
            ['Source', c.api!.source ? (SOURCES[c.api!.source] ?? c.api!.source) : '—'],
            ['Status', el('span', { className: `st st-${c.api!.status.toLowerCase()}` }, el('i'), c.api!.status[0] + c.api!.status.slice(1).toLowerCase())],
            ['Traffic', c.traffic ? `${c.traffic.toLocaleString('en')} calls / 30d` : 'no calls in 30d'],
          ]),
        );
        if (d?.schemas.length) {
          const byDom = new Map<string, number>();
          for (const s of d.schemas) {
            const n = s.domain ? graph.domainName(s.domain).toLowerCase() : 'none';
            byDom.set(n, (byDom.get(n) ?? 0) + 1);
          }
          const doms = [...byDom].sort((a, b) => b[1] - a[1]);
          body.push(
            el('h3', { textContent: 'SCHEMAS BY DOMAIN' }),
            el('div', { className: 'dombar' }, ...doms.map(([, n], i) => Object.assign(el('i', { className: `d${i % 4}` }), { style: `flex:${n}` }))),
            el('div', { className: 'domlab' }, ...doms.map(([name, n]) => el('span', { textContent: `${name} ${n}` }))),
          );
        }
        body.push(el('h3', { textContent: 'CONSUMERS' }), list(consumersOf(callers).map((x) => ({ name: x.name, meta: x.pending ? 'pending' : x.ops === 'all' ? 'all ops' : `${x.ops} ops`, card: x.card, pending: x.pending }))));
        if (d?.versions.length) {
          body.push(
            el('h3', { textContent: 'RECENT VERSIONS' }),
            el(
              'div',
              { className: 'versions' },
              ...d.versions.slice(0, 5).flatMap((v) => [
                el('span', { className: 'mono', textContent: v.tag }),
                el('span', { className: 'mono muted', textContent: v.publishedAt.slice(0, 10) }),
                el('span', { className: v.breaking ? 'red' : 'muted', textContent: v.breaking ? 'breaking' : 'compatible' }),
              ]),
            ),
          );
        }
      } else if (tab === 'Consumers') {
        body.push(list(consumersOf(callers).map((x) => ({ name: x.name, meta: x.pending ? 'pending' : x.ops === 'all' ? 'all ops' : `${x.ops} ops`, card: x.card, pending: x.pending }))));
      } else if (tab === 'Schemas') {
        body.push(d ? list(d.schemas.map((s) => ({ name: s.name, meta: `${s.propertyCount} props`, card: null }))) : el('p', { className: 'muted', textContent: 'Loading…' }));
      } else {
        body.push(d ? list(d.versions.map((v) => ({ name: v.tag, meta: `${v.publishedAt.slice(0, 10)} · ${v.breaking ? 'breaking' : 'compatible'}`, card: null }))) : el('p', { className: 'muted', textContent: 'Loading…' }));
      }
    } else {
      const team = c.kind === 'group' ? c : null;
      body.push(
        dl([
          ...(team?.members ? ([['People', String(team.members)]] as Array<[string, string]>) : []),
          ...(c.kind === 'service' ? ([['Team', graph.teamName(c.team)]] as Array<[string, string]>) : []),
          ...(graph.hierarchy === 'team' && c.kind === 'group' ? ([['Services', String(c.services)]] as Array<[string, string]>) : []),
          ['APIs', String(c.apis.length)],
          ['Traffic', c.traffic ? `${c.traffic.toLocaleString('en')} calls / 30d` : 'no calls in 30d'],
          ['Pending grants', String(c.pending)],
        ]),
      );
      const callerRows = new Map<string, { name: string; meta: string; card: string | null; pending?: boolean }>();
      for (const g of callers) {
        const cc = graph.consumerCard(g);
        const top = cc ? ancestors(graph, cc).at(-1)! : `x:${g.consumer}`;
        const r = callerRows.get(top) ?? { name: cc ? card(top).name : graph.consumerName(g), meta: '', card: cc ? top : null, pending: false };
        r.meta = `${(Number(r.meta.split(' ')[0]) || 0) + 1} grant${r.meta ? 's' : ''}`;
        callerRows.set(top, r);
      }
      const depRows = new Map<string, { name: string; meta: string; card: string | null }>();
      for (const g of calls) {
        const top = ancestors(graph, g.api).at(-1)!;
        const r = depRows.get(top) ?? { name: card(top).name, meta: '', card: top };
        r.meta = [r.meta, card(g.api).name].filter(Boolean).join(', ');
        depRows.set(top, r);
      }
      body.push(el('h3', { textContent: 'CALLERS' }), list([...callerRows.values()]), el('h3', { textContent: 'DEPENDS ON' }), list([...depRows.values()]));
      body.push(el('h3', { textContent: 'APIS' }), list(c.apis.map((a) => ({ name: card(a).name, meta: card(a).traffic ? `${compact(card(a).traffic)} / 30d` : '—', card: a }))));
    }
    const foot = el('div', { className: 'foot' });
    if (c.kind === 'api') {
      const url = hooks.specUrl?.(c.api!.id);
      if (url) foot.append(Object.assign(el('a', { className: 'btn primary', textContent: 'Open spec', href: url, target: '_blank' })));
    }
    const tr = el('button', { className: 'btn', textContent: c.kind === 'api' ? 'Trace consumers' : 'Show dependents' });
    tr.onclick = () => setMode({ kind: 'impact', of: c.id, cards: dependents(graph, c.id) });
    foot.append(tr);
    inspector.replaceChildren(...head, el('div', { className: 'ib' }, ...body), foot);
  }

  // ── command palette ───────────────────────────────────────────────────────
  type Hit = { group: string; id: string; op?: number; name: string; meta: string; icon: string; method?: string };
  let paletteMode: 'jump' | 'trace' = 'jump';
  let traceFrom: string | null = null;
  let hits: Array<Hit | { group: 'ACTIONS'; action: () => void; name: string; icon: string; key?: string }> = [];
  let active = 0;
  const pInput = el('input', { type: 'text', spellcheck: false, autocomplete: 'off' });
  const pCount = el('span', { className: 'count' });
  const pList = el('div', { className: 'plist' });
  const pPrompt = el('div', { className: 'prompt', hidden: true });
  const pFoot = el(
    'div',
    { className: 'pfoot' },
    el('span', {}, el('kbd', { textContent: '↑↓' }), ' move'),
    el('span', {}, el('kbd', { textContent: '↵' }), ' fly to'),
    el('span', {}, el('kbd', { textContent: '⇥' }), ' trace from'),
    el('span', {}, el('kbd', { textContent: '⌘↵' }), ' inspect'),
    el('span', { className: 'grow' }),
    el('span', { textContent: 'esc' }),
  );
  palette.append(el('div', { className: 'palette' }, pPrompt, el('div', { className: 'pin' }, icon('search'), pInput, pCount), pList, pFoot));
  palette.addEventListener('pointerdown', (e) => e.target === palette && closePalette());

  function openPalette(m: 'jump' | 'trace' = 'jump') {
    paletteMode = m;
    traceFrom = m === 'trace' ? (focus?.card ?? null) : null;
    pPrompt.hidden = m !== 'trace' || !traceFrom;
    pPrompt.textContent = traceFrom ? `Trace a path from ${card(traceFrom).name} to…` : '';
    palette.hidden = false;
    pInput.value = '';
    pInput.placeholder = m === 'trace' ? 'Pick where the path ends' : 'Jump to anything';
    runSearch();
    pInput.focus();
  }
  function closePalette() {
    palette.hidden = true;
  }
  function runSearch() {
    const q = pInput.value.trim().toLowerCase();
    const score = (s: string) => {
      const i = s.toLowerCase().indexOf(q);
      return i < 0 ? -1 : i === 0 ? 2 : s.toLowerCase().includes(`-${q}`) || s.toLowerCase().includes(` ${q}`) ? 1 : 0;
    };
    const groups: Record<string, Hit[]> = { TEAMS: [], DOMAINS: [], SERVICES: [], APIS: [], OPERATIONS: [] };
    if (q) {
      for (const c of cards.values()) {
        const s = score(c.name);
        if (s < 0) continue;
        if (c.kind === 'group') groups[graph.hierarchy === 'team' ? 'TEAMS' : 'DOMAINS'].push({ group: '', id: c.id, name: c.name, meta: `${graph.hierarchy === 'team' ? `${c.services} svc · ` : ''}${c.apis.length} api${c.members ? ` · ${c.members} people` : ''}`, icon: 'team' });
        else if (c.kind === 'service') groups.SERVICES.push({ group: '', id: c.id, name: c.name, meta: graph.teamName(c.team), icon: 'service' });
        else groups.APIS.push({ group: '', id: c.id, name: c.name, meta: `${c.api!.operations} ops · ${c.traffic ? `${compact(c.traffic)} / 30d` : 'no calls'}`, icon: 'api' });
      }
      for (const [id, d] of details) {
        d.operations.forEach((o, i) => {
          if (score(o.path) >= 0 || (o.operationId && score(o.operationId) >= 0)) groups.OPERATIONS.push({ group: '', id, op: i, name: o.path, meta: card(id).name, icon: 'op', method: o.method.toUpperCase() });
        });
      }
      for (const k of Object.keys(groups)) groups[k].sort((a, b) => score(b.name) - score(a.name) || a.name.localeCompare(b.name));
    }
    hits = [];
    let total = 0;
    for (const [g, list] of Object.entries(groups)) {
      if (!list.length) continue;
      total += list.length;
      for (const h of list.slice(0, g === 'OPERATIONS' ? 6 : 5)) {
        h.group = g;
        hits.push(h);
      }
    }
    const subject = focus?.card ?? (hits[0] && 'id' in hits[0] ? hits[0].id : null);
    if (paletteMode === 'jump' && subject) {
      const sc = card(subject);
      hits.push({ group: 'ACTIONS', name: `Trace a path from ${sc.name} to…`, icon: 'trace', key: '⇥', action: () => openPalette('trace') });
      hits.push({ group: 'ACTIONS', name: `Show everything that depends on ${sc.name}`, icon: 'impact', action: () => (closePalette(), setMode({ kind: 'impact', of: subject, cards: dependents(graph, subject) })) });
    }
    pCount.textContent = q ? `${total} match${total === 1 ? '' : 'es'}` : '';
    pList.replaceChildren();
    let lastGroup = '';
    hits.forEach((h, i) => {
      if (h.group !== lastGroup) {
        pList.append(el('div', { className: 'pg', textContent: h.group }));
        lastGroup = h.group;
      }
      const row = el('button', { className: `pr${i === active ? ' on' : ''}` });
      if ('action' in h) row.append(icon(h.icon as keyof typeof ICONS), el('span', { className: 'nm', textContent: h.name }), h.key ? el('kbd', { textContent: h.key }) : '');
      else {
        row.append(h.method ? el('span', { className: `m m-${h.method.toLowerCase()}`, textContent: h.method }) : icon(h.icon as keyof typeof ICONS, h.icon), highlight(h.name, q), el('span', { className: 'meta', textContent: h.meta }));
        if (i === active) row.append(el('span', { className: 'hint' }, el('kbd', { textContent: '↵' }), paletteMode === 'trace' ? ' trace to' : ' fly to'));
      }
      row.onmouseenter = () => {
        active = i;
        paintActive();
      };
      row.onclick = () => choose(i, 'enter');
      pList.append(row);
    });
    active = Math.min(active, Math.max(0, hits.length - 1));
  }
  const paintActive = () => [...pList.querySelectorAll('.pr')].forEach((r, i) => r.classList.toggle('on', i === active));
  function highlight(name: string, q: string) {
    const s = el('span', { className: 'nm' });
    const i = q ? name.toLowerCase().indexOf(q) : -1;
    if (i < 0) s.textContent = name;
    else s.append(name.slice(0, i), el('mark', { textContent: name.slice(i, i + q.length) }), name.slice(i + q.length));
    return s;
  }
  function choose(i: number, how: 'enter' | 'tab' | 'inspect') {
    const h = hits[i];
    if (!h) return;
    if ('action' in h) return h.action();
    if (paletteMode === 'trace' && traceFrom) {
      closePalette();
      const p = tracePath(graph, traceFrom, h.id);
      if (!p) return toastMsg(`No path from ${card(traceFrom).name} to ${h.name}`);
      setMode({ kind: 'trace', from: traceFrom, to: h.id, cards: p.cards, grants: p.grants });
      return;
    }
    if (how === 'tab') {
      focus = { card: h.id };
      return openPalette('trace');
    }
    closePalette();
    setFocus(h.op !== undefined ? { card: h.id, op: h.op } : { card: h.id });
    flyTo(h.id, false, h.op !== undefined ? 1.2 : undefined);
    if (how === 'inspect') {
      inspector.hidden = false;
      renderInspector();
    }
  }
  pInput.addEventListener('input', () => {
    active = 0;
    runSearch();
  });
  pInput.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      active = Math.max(0, Math.min(hits.length - 1, active + (e.key === 'ArrowDown' ? 1 : -1)));
      runSearch();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      choose(active, e.metaKey || e.ctrlKey ? 'inspect' : 'enter');
    } else if (e.key === 'Tab') {
      e.preventDefault();
      choose(active, 'tab');
    } else if (e.key === 'Escape') closePalette();
  });

  // ── filters, theme, link ──────────────────────────────────────────────────
  const check = (text: string, key: keyof typeof opts) => {
    const c = el('input', { type: 'checkbox', checked: opts[key] });
    c.onchange = () => {
      opts[key] = c.checked;
      schedule();
    };
    return el('label', {}, c, text);
  };
  const resetBtn = el('button', { className: 'btn', textContent: 'Reset layout', title: 'Put every card you moved back where it started' });
  resetBtn.onclick = () => {
    moves.clear();
    saveMoves();
    location.reload();
  };
  function saveMoves() {
    resetBtn.hidden = !moves.size;
    try {
      if (moves.size) localStorage.setItem(MOVES_KEY, JSON.stringify(Object.fromEntries(moves)));
      else localStorage.removeItem(MOVES_KEY);
    } catch {
      /* the move lasts until the page is closed */
    }
  }
  resetBtn.hidden = !moves.size;
  filters.append(
    el('h4', { textContent: 'Lines' }),
    check('Pending grants', 'pending'),
    check(graph.hierarchy === 'team' ? 'Inside the focused team' : 'Inside the focused domain', 'inside'),
    el('h4', { textContent: 'Layout', className: 'gap' }),
    el('p', { className: 'muted small', textContent: 'Drag a card (an open one by its header) to move it. Moves stay in this browser.' }),
    resetBtn,
  );
  filterBtn.onclick = () => {
    filters.hidden = !filters.hidden;
    const r = filterBtn.getBoundingClientRect();
    const s = stage.getBoundingClientRect();
    filters.style.left = `${r.left - s.left}px`;
  };
  themeBtn.onclick = () => {
    theme = theme === 'dark' ? 'light' : 'dark';
    app.dataset.theme = theme;
    themeBtn.replaceChildren(icon(theme === 'dark' ? 'moon' : 'sun'));
    try {
      localStorage.setItem('atlas-theme', theme);
    } catch {
      /* not remembered */
    }
    schedule();
  };
  linkBtn.onclick = () => {
    writeHash();
    copy(location.href, 'View link copied');
  };
  searchBtn.onclick = () => openPalette();

  let toastTimer = 0;
  function toastMsg(t: string) {
    toast.textContent = t;
    toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => (toast.hidden = true), 1600);
  }
  function copy(text: string, done: string) {
    navigator.clipboard?.writeText(text).then(
      () => toastMsg(done),
      () => toastMsg('Copy failed'),
    );
  }

  // ── keys ──────────────────────────────────────────────────────────────────
  window.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      return palette.hidden ? openPalette() : closePalette();
    }
    if (!palette.hidden || e.target instanceof HTMLInputElement) return;
    const v = vp();
    if (e.key === '/') {
      e.preventDefault();
      openPalette();
    } else if (e.key === 'Escape') {
      if (!filters.hidden) filters.hidden = true;
      else if (mode) setMode(null);
      else if (!inspector.hidden) {
        inspector.hidden = true;
        schedule();
      } else setFocus(null);
    } else if (e.key === 'Enter' && focus) flyTo(focus.card, false, open.has(focus.card) ? 1.6 : undefined);
    else if (e.key === 'Backspace') {
      // Zoom out a level: to the parent of the deepest open card in view.
      const lvl = levelNow();
      if (lvl.chain.length > 1) flyTo(lvl.chain[lvl.chain.length - 2]);
      else fit();
    } else if ((e.key === 't' || e.key === 'T') && focus) {
      e.preventDefault();
      openPalette('trace');
    } else if (e.key === 'i' || e.key === 'I') toggleInspector();
    else if (e.key === 'f' || e.key === 'F') fit();
    else if (e.key === '+' || e.key === '=') zoomAround(v.w / 2, v.h / 2, 1.4);
    else if (e.key === '-') zoomAround(v.w / 2, v.h / 2, 1 / 1.4);
  });
  window.addEventListener('resize', schedule);
  // Nothing in the stage scrolls: focusing or clicking a deep element must not shift the board.
  stage.addEventListener('scroll', () => {
    stage.scrollLeft = 0;
    stage.scrollTop = 0;
  });

  // ── links ─────────────────────────────────────────────────────────────────
  let hashTimer = 0;
  function writeHashSoon() {
    clearTimeout(hashTimer);
    hashTimer = window.setTimeout(writeHash, 300);
  }
  function writeHash() {
    const v = vp();
    const p = new URLSearchParams(location.hash.slice(1));
    p.set('v', [(v.w / 2 - view.x) / view.k, (v.h / 2 - view.y) / view.k, view.k].map((x) => +x.toFixed(4)).join(','));
    if (focus) p.set('focus', focus.op !== undefined ? `${focus.card}#${focus.op}` : focus.card);
    else p.delete('focus');
    if (graph.hierarchy !== 'team') p.set('hierarchy', graph.hierarchy);
    else p.delete('hierarchy');
    history.replaceState(null, '', `#${p.toString()}`);
  }

  // ── first render ──────────────────────────────────────────────────────────
  {
    const p = new URLSearchParams(location.hash.slice(1));
    const v = p.get('v')?.split(',').map(Number);
    const f = p.get('focus');
    const size = vp();
    if (v && v.length === 3 && v.every(Number.isFinite)) Object.assign(view, { x: size.w / 2 - v[0] * v[2], y: size.h / 2 - v[1] * v[2], k: v[2] });
    else {
      const k = Math.min((size.w - 120) / bounds.w, (size.h - 200) / bounds.h);
      Object.assign(view, { k, x: (size.w - bounds.w * k) / 2 - bounds.x * k, y: 96 + (size.h - 200 - bounds.h * k) / 2 - bounds.y * k });
    }
    if (f) {
      const [cid, op] = f.split('#');
      if (cards.has(cid)) {
        focus = { card: cid, ...(op !== undefined ? { op: Number(op) } : {}) };
        if (!v) flyTo(cid, false, op !== undefined ? 1.2 : undefined);
      }
    }
    renderBottom();
    renderMeter();
    update();
    requestAnimationFrame(() => app.classList.add('ready'));
  }
}

// ── geometry helpers ────────────────────────────────────────────────────────
type Pt = [number, number];
type Side = 'l' | 'r' | 't' | 'b';

function sides(a: Rect, b: Rect): [Side, Side] {
  const gapX = Math.max(b.x - (a.x + a.w), a.x - (b.x + b.w));
  const gapY = Math.max(b.y - (a.y + a.h), a.y - (b.y + b.h));
  const dx = b.x + b.w / 2 - (a.x + a.w / 2);
  const dy = b.y + b.h / 2 - (a.y + a.h / 2);
  if (gapX >= gapY) return dx >= 0 ? ['r', 'l'] : ['l', 'r'];
  return dy >= 0 ? ['b', 't'] : ['t', 'b'];
}

function port(r: Rect, s: Side, i: number, n: number): Pt {
  const f = (i + 1) / (n + 1);
  const along = (len: number) => len * (n === 1 ? 0.5 : 0.25 + 0.5 * f);
  if (s === 'l') return [r.x, r.y + along(r.h)];
  if (s === 'r') return [r.x + r.w, r.y + along(r.h)];
  if (s === 't') return [r.x + along(r.w), r.y];
  return [r.x + along(r.w), r.y + r.h];
}

/** Points of an orthogonal path with one bend line, halfway between the ends. */
function elbowPts(a: Pt, b: Pt, dir: 'h' | 'v'): Pt[] {
  if (dir === 'h') {
    if (Math.abs(a[1] - b[1]) < 1) return [a, b];
    const mx = (a[0] + b[0]) / 2;
    return [a, [mx, a[1]], [mx, b[1]], b];
  }
  if (Math.abs(a[0] - b[0]) < 1) return [a, b];
  const my = (a[1] + b[1]) / 2;
  return [a, [a[0], my], [b[0], my], b];
}

/** SVG path through orthogonal points, with rounded corners. */
function roundPoly(pts: Pt[], radius: number): string {
  const f = (n: number) => +n.toFixed(1);
  let d = `M${f(pts[0][0])},${f(pts[0][1])}`;
  for (let i = 1; i < pts.length - 1; i++) {
    const [px, py] = pts[i - 1];
    const [cx, cy] = pts[i];
    const [nx, ny] = pts[i + 1];
    const r = Math.min(radius, Math.hypot(cx - px, cy - py) / 2, Math.hypot(nx - cx, ny - cy) / 2);
    d += ` L${f(cx - Math.sign(cx - px) * r)},${f(cy - Math.sign(cy - py) * r)} Q${f(cx)},${f(cy)} ${f(cx + Math.sign(nx - cx) * r)},${f(cy + Math.sign(ny - cy) * r)}`;
  }
  const last = pts[pts.length - 1];
  return `${d} L${f(last[0])},${f(last[1])}`;
}

/** Arrowhead at `p`, pointing along `deg` (0 = right). */
function arrow(p: Pt, deg: number, cls: string): SVGElement {
  return svgEl('path', { d: 'M0,0 L-7,-4 L-7,4 Z', class: `head ${cls}`, transform: `translate(${p[0].toFixed(1)},${p[1].toFixed(1)}) rotate(${deg})` });
}

const ICONS = {
  search: '<circle cx="7" cy="7" r="4.5" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M10.5 10.5L14 14" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>',
  filter: '<path d="M2.5 3h11l-4.2 5v4.5l-2.6 1.2V8z" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/>',
  moon: '<path d="M13 9.6A5.5 5.5 0 0 1 6.4 3a5.5 5.5 0 1 0 6.6 6.6z" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/>',
  sun: '<circle cx="8" cy="8" r="3" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M8 1.5v1.8M8 12.7v1.8M1.5 8h1.8M12.7 8h1.8M3.4 3.4l1.3 1.3M11.3 11.3l1.3 1.3M3.4 12.6l1.3-1.3M11.3 4.7l1.3-1.3" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>',
  service: '<rect x="2.5" y="2.5" width="11" height="11" rx="2.5" fill="none" stroke="currentColor" stroke-width="1.6"/>',
  api: '<circle cx="8" cy="8" r="5.5" fill="none" stroke="currentColor" stroke-width="1.6"/><circle cx="8" cy="8" r="2" fill="currentColor"/>',
  team: '<rect x="2" y="2" width="12" height="12" rx="3" fill="none" stroke="currentColor" stroke-width="1.6"/><rect x="5" y="5" width="6" height="6" rx="1.2" fill="currentColor"/>',
  op: '<path d="M3 8h10" stroke="currentColor" stroke-width="1.6"/>',
  trace: '<circle cx="4" cy="12" r="1.8" fill="currentColor"/><circle cx="12" cy="4" r="1.8" fill="currentColor"/><path d="M4 10V7.5a2 2 0 0 1 2-2h4" fill="none" stroke="currentColor" stroke-width="1.5"/>',
  impact: '<circle cx="8" cy="8" r="5.5" fill="none" stroke="currentColor" stroke-width="1.5"/><circle cx="8" cy="8" r="2.2" fill="currentColor"/>',
  copy: '<rect x="5" y="5" width="8.5" height="8.5" rx="1.6" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M3 10.5V3.6A1.1 1.1 0 0 1 4.1 2.5H10.5" fill="none" stroke="currentColor" stroke-width="1.4"/>',
  x: '<path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>',
};
