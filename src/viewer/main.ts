import { select } from 'd3-selection';
import { zoom as d3zoom, zoomIdentity, type ZoomBehavior, type ZoomTransform } from 'd3-zoom';
import { interpolateZoom } from 'd3-interpolate';
import './style.css';
import type { BoardEdge, BoardModel, BoardNode, NodeType } from '../model';
import { computeVisible, type VisibleState } from '../lod/visibility';
import { ancestorChains, describeKinds, liftEdges, regroupBy, type LiftedEdge } from '../lod/lift';
import { routeAll, roundedPath, type Pt, type Rect, type RouteRequest } from '../route/orthogonal';
import { LEVEL_NAMES } from '../registry/rules';
import type { ConnectionKind } from '../registry/types';
import { el, svgEl } from './dom';
import { buildCard, buildDefs, CHIP_TYPES, closedChipFs, deptHue, legendShape, MAX_PX, type CardText } from './shapes';
import { initPresentation, type Highlight } from './present';

const MIN_TEXT_PX = 9;
const STALE_DAYS = 180;
const FAN_THRESHOLD = 10; // topics with more consumers draw one fan-out edge

export interface DetailResult {
  api: string;
  nodes: BoardNode[];
  add: BoardEdge[];
  remove: Set<string>;
}

export interface ViewerHooks {
  /** Loads the operations and schemas of lazy cards (progressive sources). */
  loadDetails?(apis: BoardNode[]): Promise<DetailResult[]>;
  /** Extra toolbar controls, e.g. the hierarchy switch. */
  toolbarExtras?: HTMLElement[];
  /** Extra footer items, e.g. the network meter. */
  footerExtras?: HTMLElement[];
}

/** Renders a board. The model may grow later through `hooks.loadDetails`. */
export function start(model: BoardModel, hooks: ViewerHooks = {}) {
const { expandAt, collapseAt } = model.settings;
const nodes = new Map(model.nodes.map((n) => [n.id, n]));
const roots = model.nodes
  .filter((n) => n.parent === null)
  .sort((a, b) => a.y - b.y || a.x - b.x)
  .map((n) => n.id);
const chains = ancestorChains(new Map(model.nodes.map((n) => [n.id, n.parent])));
const edgesById = new Map(model.edges.map((e) => [e.id, e]));
// Colour families: one per top-level container, and one per team wherever teams sit.
const hueKeys = [...roots.filter((id) => nodes.get(id)!.type !== 'band'), ...model.nodes.filter((n) => n.type === 'team' && n.parent).map((n) => n.id)];
const hueOf = new Map(hueKeys.map((id, i) => [id, deptHue(i)]));
const hueFor = (n: BoardNode) => hueOf.get(n.type === 'team' ? n.id : (n.dept ?? '')) ?? (n.dept && nodes.get(n.dept)?.type === 'band' ? hueOfTeam(n) : undefined);
/** Inside a band of teams, cards take their team's colour. */
const hueOfTeam = (n: BoardNode) => {
  for (let p: string | null = n.parent; p; p = nodes.get(p)?.parent ?? null) if (hueOf.has(p)) return hueOf.get(p);
  return undefined;
};

const nameOf = (id: string) => nodes.get(id)?.name ?? id;
const inSubtree = (id: string, root: string) => chains.get(id)?.includes(root) ?? false;
const pathOf = (id: string) => [...chains.get(id)!].reverse().map(nameOf).join(' › ');
const field = (n: BoardNode, key: string) => n.fields.find(([k]) => k === key)?.[1];

// ── shell ───────────────────────────────────────────────────────────────────
const app = document.getElementById('app')!;
const searchInput = el('input', { type: 'search', placeholder: 'Search name, id, owner, tag…  ( / )' });
const results = el('ul', { className: 'results', hidden: true });
const levelSelect = el('select');
levelSelect.append(el('option', { value: '', textContent: 'Auto' }));
const levelNames: readonly string[] = model.levels ?? LEVEL_NAMES;
levelNames.forEach((name, i) => levelSelect.append(el('option', { value: String(i), textContent: name })));
const filterBtn = el('button', { textContent: 'Filters' });
const legendBtn = el('button', { textContent: 'Legend' });
const fitBtn = el('button', { textContent: 'Fit', title: 'Fit to screen (F)' });
const styleSwitch = el('div', { className: 'seg', role: 'group', title: 'Drawing style' });
const STYLES = ['studio', 'sketch'] as const;
type Style = (typeof STYLES)[number];
let style: Style = 'studio';
const styleBtns = STYLES.map((st) => {
  const b = el('button', { textContent: st === 'studio' ? 'Studio' : 'Sketch' });
  b.onclick = () => setStyle(st);
  styleSwitch.append(b);
  return b;
});
function setStyle(st: Style) {
  style = st;
  app.dataset.style = st;
  styleBtns.forEach((b, i) => b.classList.toggle('on', STYLES[i] === st));
  try {
    localStorage.setItem('atlas-style', st);
  } catch {
    /* storage unavailable: the style just isn't remembered */
  }
  writeHash();
}

app.append(
  el(
    'header',
    { className: 'toolbar' },
    el('span', { className: 'brand' }, el('span', { className: 'logo' }), 'Atlas', el('small', {}, model.meta.version === 'draft' ? 'draft' : `v${model.meta.version}`)),
    el('div', { className: 'search' }, searchInput, results),
    el('label', {}, 'Show down to', levelSelect),
    filterBtn,
    legendBtn,
    fitBtn,
    ...(hooks.toolbarExtras ?? []),
    el('span', { className: 'spacer' }),
    styleSwitch,
  ),
);

const stage = el('div', { className: 'stage' });
const svg = svgEl<SVGSVGElement>('svg', { class: 'board' });
const world = svgEl<SVGGElement>('g', { class: 'world' });
svg.append(buildDefs([...hueOf.values()]));
const nodeLayer = svgEl<SVGGElement>('g', { class: 'nodes' });
const edgeLayer = svgEl<SVGGElement>('g', { class: 'edges' });
world.append(nodeLayer, edgeLayer);
svg.append(world);
const panel = el('aside', { className: 'panel', hidden: true });
const tip = el('div', { className: 'tip', hidden: true });
const crumbbar = el('nav', { className: 'crumbbar' });
const edgeNote = el('div', { className: 'edge-note', hidden: true });
const mapLabels = el('div', { className: 'map-labels' });
const minimap = el('canvas', { className: 'minimap' });
const filterPop = el('div', { className: 'popover', hidden: true });
const legendPop = el('div', { className: 'popover', hidden: true });
stage.append(svg, mapLabels, crumbbar, edgeNote, minimap, panel, tip, filterPop, legendPop);

const footer = el('footer', { className: 'footer' });
footer.append(
  ...[
    `Version ${model.meta.version}`,
    model.meta.publishedAt && `published ${model.meta.publishedAt}`,
    model.meta.commit && `commit ${model.meta.commit.slice(0, 10)}`,
    `${model.nodes.filter((n) => n.type !== 'band' && n.type !== 'apigroup').length} components · ${model.edges.length} connections`,
    model.spec0 ? `${model.spec0.org} · ${model.spec0.hierarchy === 'team' ? 'grouped by team' : 'grouped by domain'}` : 'Logical production architecture — environments and regions not shown',
  ]
    .filter(Boolean)
    .map((t) => el('span', {}, t as string)),
);
if (model.meta.version === 'draft') footer.append(el('span', { className: 'warn' }, 'Draft — not published'));
footer.append(...(hooks.footerExtras ?? []));
footer.append(el('span', { className: 'spacer' }), el('span', { className: 'hint' }, 'Drag to pan · scroll or pinch to zoom · double-click to highlight connections · / to search'));
app.append(stage, footer);

// ── cards ───────────────────────────────────────────────────────────────────
interface Card {
  node: BoardNode;
  g: SVGGElement;
  container: boolean;
  /** Text sizes while closed (or for a leaf) and while open. */
  closed: CardText;
  open: CardText;
  base: string;
}
const cards = new Map<string, Card>();
const now = Date.now();
const staleDomains = new Set<string>();

function staleInfo(n: BoardNode): { text: string; stale: boolean } | null {
  if (n.type !== 'domain' || model.spec0) return null;
  const at = field(n, 'reviewedAt');
  const by = field(n, 'reviewedBy');
  if (!at) return { text: 'never reviewed', stale: true };
  const days = Math.floor((now - Date.parse(at)) / 86_400_000);
  return { text: `reviewed ${at}${by ? ` by ${by}` : ''}`, stale: days > STALE_DAYS };
}

/** Closed service-like siblings share one name size: the smallest any of them needs. */
const sharedClosedFs = new Map<string, number>();
for (const p of model.nodes) {
  const sibs = p.children.map((c) => nodes.get(c)!).filter((c) => (c.children.length || c.lazy) && CHIP_TYPES.has(c.type));
  if (sibs.length < 2) continue;
  const fs = Math.min(...sibs.map(closedChipFs));
  for (const c of sibs) sharedClosedFs.set(c.id, fs);
}

function addCard(id: string) {
  const n = nodes.get(id)!;
  const container = n.children.length > 0 || !!n.lazy;
  const s = staleInfo(n);
  if (s?.stale) staleDomains.add(id);
  const { g, closed, open } = buildCard(n, { container, staleText: s?.text ?? null, closedFs: sharedClosedFs.get(id) });
  const hue = hueFor(n);
  if (hue !== undefined) g.style.setProperty('--h', String(hue));
  const flags = [
    n.status !== 'active' ? n.status : '',
    s?.stale ? 'stale' : '',
    n.flags.includes('platform') ? 'platform' : '',
  ].filter(Boolean);
  const base = `node t-${n.type} ${flags.join(' ')}`.trim();
  g.setAttribute('class', base);
  g.dataset.id = id;
  nodeLayer.append(g);
  cards.set(id, { node: n, g, container, closed, open, base });
  for (const c of n.children) addCard(c);
}
roots.forEach(addCard);

/**
 * Zoom at which a container's children become readable: the median child's name reaches the size
 * at which it is actually drawn (9 px, 10 for containers). Opening any earlier shows blank cards.
 * Containers stay closed (showing their own name and counts) until then.
 */
const nameAt = (id: string) => MIN_TEXT_PX + (cards.get(id)!.container ? 1 : 0);
const lodNodes = new Map<string, BoardNode & { openK?: number }>(
  model.nodes.map((n): [string, BoardNode & { openK?: number }] => {
    if (!n.children.length) return [n.id, n];
    const ks = n.children.map((c) => nameAt(c) / Math.max(1, cards.get(c)!.closed.nameFs)).sort((a, b) => a - b);
    return [n.id, { ...n, openK: ks[Math.floor(ks.length / 2)] }];
  }),
);

// ── view state ──────────────────────────────────────────────────────────────
let k = 1;
let levelOverride: number | null = null;
const pins = new Map<string, boolean>();
let state: VisibleState = { expanded: new Set(), visible: new Set(), signature: '\u0000' };
let lifted: LiftedEdge[] = [];
let fans: Fan[] = [];
let pending = false;
let selected: string | null = null;
/** Card whose connections are highlighted (double-click a card). */
let focused: string | null = null;
/** Leaf edges of the connection picked by double-clicking a line. */
let picked: Set<string> | null = null;
/** True from the first zoom or pan event until the view has been still for a moment. */
let gesturing = false;
/** World area the drawn edges cover; panning beyond it during a gesture draws more. */
let drawnBox: Rect | null = null;
let focusSet: Set<string> | null = null;
/** Trace or impact result from the presentation tools; takes precedence over selection focus. */
let highlight: Highlight | null = null;
/** Visible card → its emphasis: hops from the impact origin, or -1 for "on the traced path". */
// ── progressive details ─────────────────────────────────────────────────────
/**
 * Lazy cards (APIs whose operations and schemas aren't loaded) are fetched just before they
 * would open: everything that qualifies during a gesture goes out in one batched request.
 * Their children are placed inside the space the card already reserved.
 */
const LAZY_OPEN_K = MIN_TEXT_PX / 11;
const detailQueue = new Set<string>();
const detailsLoading = new Set<string>();
let detailTimer = 0;

function wantDetails() {
  if (!hooks.loadDetails) return;
  const near = viewBox(0.25);
  for (const id of state.visible) {
    const n = nodes.get(id)!;
    if (!n.lazy || detailsLoading.has(id) || detailQueue.has(id)) continue;
    // Prefetch a little before the card would open.
    if (n.w * k >= expandAt * 0.8 && k >= LAZY_OPEN_K * 0.8 && intersects(n, near)) detailQueue.add(id);
  }
  if (detailQueue.size && !detailTimer) detailTimer = window.setTimeout(flushDetails, 140);
}

async function flushDetails() {
  detailTimer = 0;
  const ids = [...detailQueue].slice(0, 50);
  for (const id of ids) {
    detailQueue.delete(id);
    detailsLoading.add(id);
    const c = cards.get(id)!;
    c.base += ' loading';
  }
  let results: DetailResult[] = [];
  try {
    results = await hooks.loadDetails!(ids.map((id) => nodes.get(id)!));
  } catch (err) {
    console.error('Atlas: loading details failed', err);
  }
  for (const r of results) applyDetails(r);
  for (const id of ids) {
    detailsLoading.delete(id);
    const c = cards.get(id)!;
    c.base = c.base.replace(' loading', '');
    if (!results.some((r) => r.api === id)) delete nodes.get(id)!.lazy; // nothing to load; stop asking
  }
  state = { ...state, signature: '\u0000' };
  schedule();
  if (detailQueue.size) detailTimer = window.setTimeout(flushDetails, 0);
}

function applyDetails(r: DetailResult) {
  const parent = nodes.get(r.api);
  if (!parent) return;
  const chain = chains.get(r.api)!;
  for (const n of r.nodes) {
    nodes.set(n.id, n);
    model.nodes.push(n);
    parent.children.push(n.id);
    chains.set(n.id, [n.id, ...chain]);
    lodNodes.set(n.id, n);
    addCard(n.id);
  }
  delete parent.lazy;
  const ks = parent.children.map((c) => nameAt(c) / Math.max(1, cards.get(c)!.closed.nameFs)).sort((a, b) => a - b);
  lodNodes.set(parent.id, { ...parent, openK: ks.length ? ks[Math.floor(ks.length / 2)] : 0 });
  if (r.remove.size || r.add.length) {
    model.edges = model.edges.filter((e) => !r.remove.has(e.id)).concat(r.add);
    for (const id of r.remove) edgesById.delete(id);
    for (const e of r.add) edgesById.set(e.id, e);
  }
}

let emphasis = new Map<string, number>();
let present: ReturnType<typeof initPresentation> | null = null;

type KindGroup = 'calls' | 'async' | 'store' | 'gap' | 'pending' | 'schema' | 'twin';
/** Shown unless turned off; schema twins are opt-in. */
const DEFAULT_KINDS: KindGroup[] = ['calls', 'async', 'store', 'gap', 'pending', 'schema'];
const kindsAreDefault = () => filters.kinds.size === DEFAULT_KINDS.length && DEFAULT_KINDS.every((x) => filters.kinds.has(x));
const filters = {
  kinds: new Set<KindGroup>(DEFAULT_KINDS),
  tag: '',
  cluster: '',
  stale: false,
  platform: false,
};
let matchSet: Set<string> | null = null;

const kindGroup = (k: ConnectionKind): KindGroup =>
  k === 'calls'
    ? 'calls'
    : k === 'publishes' || k === 'consumes'
      ? 'async'
      : k === 'reads-writes'
        ? 'store'
        : k === 'requests'
          ? 'pending'
          : k === 'uses' || k === 'references'
            ? 'schema'
            : k === 'twin'
              ? 'twin'
              : 'gap';

/** Timings exposed for the performance script. */
const perf = { stages: [] as Array<Record<string, number>>, lodMs: [] as number[], frameMs: [] as number[], edgeMs: [] as number[], routeMs: [] as number[], classMs: [] as number[] };
(window as unknown as { __atlasPerf: typeof perf }).__atlasPerf = perf;
const record = (list: unknown[], v: unknown) => {
  list.push(v);
  if (list.length > 600) list.splice(0, list.length - 500);
};
let liftMs = 0;

function schedule() {
  if (pending) return;
  pending = true;
  requestAnimationFrame(update);
}

function update() {
  pending = false;
  const t0 = performance.now();
  const next = computeVisible(lodNodes, roots, k, state.expanded, { expandAt, collapseAt, levelOverride, pins });
  const visMs = performance.now() - t0;
  const changed = next.signature !== state.signature;
  state = next;
  liftMs = 0;
  const t1 = performance.now();
  applyCardClasses();
  record(perf.classMs, performance.now() - t1);
  // While the view is moving, lines stay as they are: they are redrawn once it settles, unless
  // the move has carried the screen past the area they were drawn for.
  const escaped = !!drawnBox && !contains(drawnBox, viewBox(0));
  if ((changed && !gesturing) || escaped) {
    const t2 = performance.now();
    drawEdges();
    applyFocus();
    record(perf.edgeMs, performance.now() - t2);
  }
  if (changed) present?.onVisibility();
  record(perf.lodMs, visMs + liftMs);
  record(perf.frameMs, performance.now() - t0);
  wantDetails();
  placeMapLabels();
  drawMinimapViewport();
}

/**
 * Map-style labels for open departments and domains whose own name band is too small to read
 * (far zoomed out). They sit at the container's top-left corner in screen space.
 */
const labelEls = new Map<string, HTMLElement>();
function placeMapLabels() {
  const t = currentTransform();
  const shown = new Set<string>();
  const v = viewport();
  const headerReadable = screenPx(14, MAX_PX.header / 14) >= MIN_TEXT_PX;
  for (const id of state.visible) {
    const n = nodes.get(id)!;
    if (n.type !== 'department' && n.type !== 'domain' && n.type !== 'band' && n.type !== 'team') continue;
    const card = cards.get(id)!;
    const open = state.expanded.has(id);
    // Only where the card's own name can't be read: an open card's band, or a closed card's title.
    const ownReadable = open ? headerReadable : screenPx(card.closed.nameFs, card.closed.nameCap) >= MIN_TEXT_PX + 1;
    if (ownReadable) continue;
    const x = t.x + n.x * t.k;
    const y = t.y + n.y * t.k;
    const w = n.w * t.k;
    const h = n.h * t.k;
    if (w < 36 || x > v.w || y > v.h || x + w < 0 || y + h < 0) continue;
    // Domains inside a closed department are not drawn, and neither are their labels.
    if (n.type === 'domain' && n.parent && !state.expanded.has(n.parent)) continue;
    let lab = labelEls.get(id);
    if (!lab) {
      lab = el('div', { className: `map-label ml-${n.type}`, textContent: n.name });
      const hue = n.dept ? hueOf.get(n.dept) : undefined;
      if (hue !== undefined) lab.style.setProperty('--h', String(hue));
      lab.onclick = () => zoomToNode(id);
      mapLabels.append(lab);
      labelEls.set(id, lab);
    }
    // Open cards: pinned to the top-left corner. Closed: centred on the card.
    lab.classList.toggle('centred', !open);
    lab.style.transform = open
      ? `translate(${Math.max(0, x) + 4}px, ${Math.max(0, y) + (n.type === 'department' ? -2 : 3)}px)`
      : `translate(${x + w / 2}px, ${y + h / 2}px) translate(-50%, -50%)`;
    lab.style.maxWidth = `${open ? Math.max(48, w - 6) : Math.max(110, w - 6)}px`;
    lab.hidden = false;
    shown.add(id);
  }
  for (const [id, lab] of labelEls) if (!shown.has(id)) lab.hidden = true;
}

/** On-screen size of text designed at `fs` world units whose block stops growing at zoom `cap`. */
const screenPx = (fs: number, cap: number) => fs * Math.min(k, cap);

function applyCardClasses() {
  // Cards well outside the viewport are taken out of rendering entirely.
  const view = viewBox(0.3);
  const tagsReadable = screenPx(10, MAX_PX.tag / 10) >= 8;
  for (const c of cards.values()) {
    const n = c.node;
    let cls = c.base;
    if (!state.visible.has(n.id)) cls += ' hidden';
    else if (!intersects(n, view)) cls += ' offscreen';
    else {
      const open = state.expanded.has(n.id);
      const sw = n.w * k;
      const t = open ? c.open : c.closed;
      if (c.container && open) {
        cls += ' open';
        if (screenPx(t.nameFs, t.nameCap) >= MIN_TEXT_PX) cls += ' show-hdr';
        if (sw >= 1.5 * expandAt && screenPx(11, MAX_PX.meta / 11) >= MIN_TEXT_PX) cls += ' show-meta';
      } else {
        if (c.container) cls += ' show-closed';
        if (screenPx(t.nameFs, t.nameCap) >= MIN_TEXT_PX + (c.container ? 1 : 0)) cls += ' show-name';
        if (n.h * Math.min(k, t.nameCap) >= 16) cls += ' show-chip';
        // Second line: child counts on a closed container, detail on a leaf.
        const subOk = screenPx(t.subFs, t.nameCap) >= 8.5;
        if (c.container && subOk) cls += ' show-sub';
        if (!c.container && subOk && sw >= 1.5 * expandAt) cls += ' show-sub';
      }
      if (tagsReadable && sw >= 140) cls += ' show-marks';
      if (pins.has(n.id)) cls += ' pinned';
      if (n.id === selected) cls += ' selected';
      if (focusSet && !focusSet.has(n.id)) cls += ' dim';
      const em = emphasis.get(n.id);
      if (em !== undefined) cls += em < 0 ? ' on-path' : ` ring-${Math.min(em, 3)}`;
      if (matchSet && !matchSet.has(n.id)) cls += ' fdim';
    }
    if (cls !== c.g.getAttribute('class')) c.g.setAttribute('class', cls);
  }
}

// ── edges ───────────────────────────────────────────────────────────────────
interface Fan {
  topic: string;
  targets: string[];
  leaves: string[];
}

const kindClass = (kinds: LiftedEdge['kinds']): string => {
  const groups = new Set((Object.keys(kinds) as ConnectionKind[]).map(kindGroup));
  return groups.size === 1 ? `k-${[...groups][0]}` : 'k-mixed';
};

const rectOf = (id: string): Rect => {
  const n = nodes.get(id)!;
  return { x: n.x, y: n.y, w: n.w, h: n.h };
};
const isAncestor = (a: string, b: string) => a !== b && chains.get(b)!.includes(a);

/**
 * Cards an edge must go around: the visible siblings of every card on the paths from the root
 * to its two ends. Cards nested inside those siblings are covered by the sibling itself.
 */
function obstaclesFor(a: string, b: string, cache: Map<string | null, string[]>): { rects: Rect[]; key: string } {
  const onPath = new Set([...chains.get(a)!, ...chains.get(b)!]);
  const out: Rect[] = [];
  const ids: string[] = [];
  const seenParents = new Set<string | null>();
  for (const id of onPath) {
    const parent = nodes.get(id)!.parent;
    if (seenParents.has(parent)) continue;
    seenParents.add(parent);
    let sibs = cache.get(parent);
    if (!sibs) {
      sibs = (parent ? nodes.get(parent)!.children : roots).filter((s) => state.visible.has(s));
      cache.set(parent, sibs);
    }
    for (const s of sibs) {
      if (onPath.has(s)) continue;
      out.push(rectOf(s));
      ids.push(s);
    }
  }
  return { rects: out, key: ids.join(',') };
}

/** Routes survive visibility changes while their ports and surroundings stay the same. */
const routeCache = new Map<string, Pt[]>();
let routesIncomplete = false;


let refineQueued = false;
/** Most connections drawn at once before they are grouped at a coarser level. */
const EDGE_BUDGET = 160;
let edgeLevel = 4;

function drawEdges() {
  const t0 = performance.now();
  const base = filters.platform ? model.edges : model.edges.filter((e) => !e.platform);
  const view = viewBox(0.5);
  const near = (id: string) => intersects(rectOf(id), view);
  const valid = (l: LiftedEdge) => !isAncestor(l.from, l.to) && !isAncestor(l.to, l.from);

  // Edge level of detail. Ends on screen keep their detail; ends off screen are grouped by
  // domain, since the line only has to say where it goes. If that is still too many lines,
  // on-screen ends are grouped too, level by level (services → systems → domains → departments).
  // Cards never change.
  const fine = liftEdges(base, chains, state.visible).filter(valid);
  const inner = viewBox(0.05);
  const inView = (id: string) => intersects(rectOf(id), inner);
  const coarse = (id: string, level: number) => chains.get(id)!.find((a) => state.visible.has(a) && nodes.get(a)!.level <= level);
  const group = (level: number) => regroupBy(fine, (id) => coarse(id, inView(id) ? level : Math.min(level, 1))).filter(valid);
  edgeLevel = 4;
  let all = group(edgeLevel);
  const onScreen = (ls: LiftedEdge[]) => ls.reduce((n, l) => n + (inView(l.from) || inView(l.to) ? 1 : 0), 0);
  while (edgeLevel > 0 && onScreen(all) > EDGE_BUDGET) all = group(--edgeLevel);
  edgeNote.hidden = edgeLevel === 4 || !all.length;
  edgeNote.textContent = `Connections grouped by ${levelNames[edgeLevel] ?? 'level'} — zoom in for detail`;
  liftMs = performance.now() - t0;

  // Topics with many consumers draw one fan-out edge instead of one per consumer.
  const consumersByTopic = new Map<string, LiftedEdge[]>();
  for (const l of all) {
    const t = nodes.get(l.from)!.type;
    if ((t === 'topic' || t === 'channel') && Object.keys(l.kinds).every((x) => x === 'consumes')) {
      if (!consumersByTopic.has(l.from)) consumersByTopic.set(l.from, []);
      consumersByTopic.get(l.from)!.push(l);
    }
  }
  const fanned = new Set<LiftedEdge>();
  fans = [];
  for (const [topic, list] of consumersByTopic) {
    if (list.length <= FAN_THRESHOLD) continue;
    list.forEach((l) => fanned.add(l));
    fans.push({ topic, targets: list.map((l) => l.to), leaves: list.flatMap((l) => l.leaves) });
  }
  lifted = all.filter((l) => !fanned.has(l));
  svg.classList.toggle('dense', lifted.length > 150);
  svg.classList.toggle('quiet', lifted.filter((l) => near(l.from) || near(l.to)).length > 40);

  const t1 = performance.now();
  const cache = new Map<string | null, string[]>();
  // Only edges that can reach the screen are routed and drawn; panning past the margin redraws.
  const drawn = lifted.filter((l) => near(l.from) || near(l.to));
  const requests: RouteRequest[] = drawn.map((l) => {
    const o = obstaclesFor(l.from, l.to, cache);
    return { key: l.key, from: l.from, to: l.to, a: rectOf(l.from), b: rectOf(l.to), obstacles: o.rects, obstacleKey: o.key };
  });
  const tReq = performance.now();
  if (routeCache.size > 20000) routeCache.clear();
  // While zooming, spend at most a frame on routing; the rest is finished when the gesture ends.
  const { routes, complete } = routeAll(requests, {}, { cache: routeCache, budgetMs: 12 });
  routesIncomplete = !complete;
  // Routing is progressive: unfinished edges show as simple elbows and are refined frame by frame.
  if (!complete && !refineQueued) {
    refineQueued = true;
    requestAnimationFrame(() => {
      refineQueued = false;
      if (routesIncomplete) {
        drawEdges();
        applyFocus();
      }
    });
  }
  record(perf.routeMs, performance.now() - t1);

  const tRouted = performance.now();
  // Lines are kept by key: one that hasn't changed stays exactly as it is, a new one fades in and
  // a removed one fades out, so redrawing never makes the board blink.
  const old = new Map<string, SVGGElement>();
  for (const c of edgeLayer.children) {
    const g = c as SVGGElement;
    if (!g.classList.contains('leaving')) old.set(g.dataset.id!, g);
  }
  const entering: SVGGElement[] = [];
  const put = (id: string, cls: string, sig: string, build: (g: SVGGElement) => void, data: (g: SVGGElement) => void) => {
    let g = old.get(id);
    old.delete(id);
    if (g && g.dataset.sig === sig) return;
    if (!g) {
      g = svgEl<SVGGElement>('g', {});
      g.dataset.id = id;
      g.classList.add('entering');
      entering.push(g);
      edgeLayer.append(g);
    } else g.replaceChildren();
    g.setAttribute('class', `${cls}${g.classList.contains('entering') ? ' entering' : ''}`);
    g.dataset.sig = sig;
    data(g);
    build(g);
  };
  for (const l of drawn) {
    const pts = routes.get(l.key)!;
    const d = roundedPath(pts, 10);
    const width = Math.min(5, 1.4 + 0.9 * Math.log2(l.count)).toFixed(2);
    const cls = `edge ${kindClass(l.kinds)}${l.gapOnly ? ' gap' : ''}`;
    put(
      l.key,
      cls,
      `${cls}|${d}|${width}|${l.count}`,
      (g) => {
        g.append(svgEl('path', { class: 'hit', d }));
        g.append(svgEl('path', { class: 'line', d, 'stroke-width': width }));
        g.append(arrowHead(pts, l));
        if (l.count > 1) g.append(countLabel(pts, l.count));
      },
      (g) => (g.dataset.key = l.key),
    );
  }
  for (const f of fans) {
    const n = nodes.get(f.topic)!;
    if (!intersects(n, view)) continue;
    const x0 = n.x + n.w;
    const y = n.y + n.h / 2;
    const d = `M${x0},${y} H${x0 + 30}`;
    put(
      `fan:${f.topic}`,
      'edge fan k-async',
      `${d}|${f.targets.length}`,
      (g) => {
        g.append(svgEl('path', { class: 'hit', d }), svgEl('path', { class: 'line', d, 'stroke-width': 2.5 }));
        const badge = svgEl<SVGGElement>('g', {});
        badge.setAttribute('style', `transform: translate(${x0 + 44}px, ${y}px) scale(var(--inv, 1))`);
        badge.append(svgEl('circle', { r: 14 }));
        const t = svgEl('text', {});
        t.textContent = String(f.targets.length);
        badge.append(t);
        g.append(badge);
      },
      (g) => (g.dataset.fan = f.topic),
    );
  }
  const tBuilt = performance.now();
  for (const g of old.values()) {
    g.classList.add('leaving');
    window.setTimeout(() => g.remove(), 200);
  }
  if (entering.length) requestAnimationFrame(() => requestAnimationFrame(() => entering.forEach((g) => g.classList.remove('entering'))));
  drawnBox = view;
  applyEdgeFilter();
  record(perf.stages, { lift: t1 - t0, prep: tReq - t1, route: tRouted - tReq, build: tBuilt - tRouted, attach: performance.now() - tBuilt, drawn: drawn.length });
}

function viewBox(pad: number): Rect {
  const t = currentTransform();
  const v = viewport();
  const w = v.w / t.k;
  const h = v.h / t.k;
  return { x: -t.x / t.k - w * pad, y: -t.y / t.k - h * pad, w: w * (1 + 2 * pad), h: h * (1 + 2 * pad) };
}
const union = (a: Rect, b: Rect): Rect => {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y };
};
const contains = (a: Rect, b: Rect) => b.x >= a.x && b.y >= a.y && b.x + b.w <= a.x + a.w && b.y + b.h <= a.y + a.h;
const intersects = (a: Rect, b: Rect) => a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;

function arrowHead(pts: Pt[], l: LiftedEdge): SVGElement {
  const [px, py] = pts[pts.length - 2];
  const [x, y] = pts[pts.length - 1];
  const angle = (Math.atan2(y - py, x - px) * 180) / Math.PI;
  const kinds = Object.keys(l.kinds) as ConnectionKind[];
  if (kinds.every((x) => x === 'twin')) return svgEl('g', {});
  const async = kinds.every((x) => x === 'publishes' || x === 'consumes' || x === 'uses' || x === 'references');
  const store = kinds.every((x) => x === 'reads-writes');
  const head = store
    ? svgEl('path', { class: 'head', d: 'M-8,0 a3.5,3.5 0 1,0 7,0 a3.5,3.5 0 1,0 -7,0' })
    : async
      ? svgEl('path', { class: 'head open', d: 'M-9,-5 L-1,0 L-9,5' })
      : svgEl('path', { class: 'head', d: 'M0,0 L-10,-5 L-10,5 Z' });
  head.setAttribute('style', `transform: translate(${x}px, ${y}px) rotate(${angle}deg) scale(var(--inv, 1))`);
  return head;
}

/** Count badge on the middle of the longest segment. */
function countLabel(pts: Pt[], count: number): SVGElement {
  let best = 0;
  let at: Pt = pts[0];
  for (let i = 0; i + 1 < pts.length; i++) {
    const len = Math.abs(pts[i + 1][0] - pts[i][0]) + Math.abs(pts[i + 1][1] - pts[i][1]);
    if (len > best) {
      best = len;
      at = [(pts[i][0] + pts[i + 1][0]) / 2, (pts[i][1] + pts[i + 1][1]) / 2];
    }
  }
  const g = svgEl('g', { class: 'count' });
  g.setAttribute('style', `transform: translate(${at[0]}px, ${at[1]}px) scale(var(--inv, 1))`);
  const w = 10 + String(count).length * 6;
  g.append(svgEl('rect', { x: -w / 2, y: -8, width: w, height: 16, rx: 8 }));
  const t = svgEl('text', {});
  t.textContent = String(count);
  g.append(t);
  return g;
}

// ── zoom ────────────────────────────────────────────────────────────────────
const bounds = (() => {
  const rs = roots.map((id) => nodes.get(id)!);
  const x0 = Math.min(...rs.map((n) => n.x));
  const y0 = Math.min(...rs.map((n) => n.y));
  const x1 = Math.max(...rs.map((n) => n.x + n.w));
  const y1 = Math.max(...rs.map((n) => n.y + n.h));
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
})();
const smallestLeaf = Math.min(...model.nodes.filter((n) => !n.children.length).map((n) => n.w));

/** Cached: reading clientWidth after class changes forces a synchronous style and layout pass. */
let viewportSize = { w: 0, h: 0 };
const measureViewport = () => (viewportSize = { w: svg.clientWidth || window.innerWidth, h: svg.clientHeight || window.innerHeight });
const viewport = () => (viewportSize.w ? viewportSize : measureViewport());
const panelInset = () => (panel.hidden || window.innerWidth < 700 ? 0 : panel.offsetWidth + 24);
const fitScale = (box: { w: number; h: number }, pad = 0.9, inset = 0) => {
  const v = viewport();
  return Math.min(((v.w - inset) * pad) / box.w, (v.h * pad) / box.h);
};

// Zoom range: from "whole board fits" to "smallest leaf at ~3× expandAt".
const zoomBehavior: ZoomBehavior<SVGSVGElement, unknown> = d3zoom<SVGSVGElement, unknown>()
  .scaleExtent([fitScale(bounds) * 0.5, (3 * expandAt) / smallestLeaf])
  .filter((e: Event) => {
    // Pinch (and ctrl/⌘ + wheel) goes to d3-zoom; mouse wheels and trackpad scrolls are handled below.
    if (e.type === 'wheel') return (e as WheelEvent).ctrlKey || (e as WheelEvent).metaKey;
    if (e.type === 'dblclick') return false;
    if (present?.capturesDrag() && (e.type === 'mousedown' || e.type === 'touchstart')) return false;
    return !(e as MouseEvent).ctrlKey && !(e as MouseEvent).button;
  })
  .on('end', () => {
    // Trackpad pans and animations end after every event or frame, so wait until the view
    // has been still for a moment before settling.
    clearTimeout(settleTimer);
    settleTimer = window.setTimeout(settle, SETTLE_MS);
  })
  .on('zoom', (e: { transform: ZoomTransform }) => {
    clearTimeout(settleTimer);
    gesturing = true;
    world.setAttribute('transform', e.transform.toString());
    k = e.transform.k;
    moveGrid(e.transform);
    syncScaleVars();
    present?.onViewChange();
    tip.hidden = true;
    schedule();
  });
const svgSel = select(svg);
svgSel.call(zoomBehavior);

const SETTLE_MS = 160;
let settleTimer = 0;
/** The view has stopped moving: regroup and redraw lines for what is now on screen. */
function settle() {
  gesturing = false;
  drawEdges();
  applyFocus();
  syncScaleVars();
  updateCrumbs();
  writeHash();
}
const currentTransform = () => svgSel.property('__zoom') as ZoomTransform;

/** The dot grid behind the board pans and zooms with it, folded into a 16–32 px step. */
function moveGrid(t: ZoomTransform) {
  let step = 24 * t.k;
  while (step < 16) step *= 2;
  while (step >= 32) step /= 2;
  svg.style.backgroundSize = `${step}px ${step}px`;
  svg.style.backgroundPosition = `${t.x % step}px ${t.y % step}px`;
}

/**
 * Screen-constant sizes (arrowheads, counts, headers) read --inv and --k. They follow the zoom on
 * every frame: stepping them made labels and arrowheads jump in size mid-gesture.
 */
function syncScaleVars() {
  world.style.setProperty('--inv', String(1 / k));
  world.style.setProperty('--k', String(k));
}

/** Pinch and mouse wheels zoom; two-finger trackpad scrolls pan. */
function isZoomWheel(e: WheelEvent) {
  if (e.ctrlKey || e.metaKey) return true;
  if (e.deltaMode !== 0) return true;
  return e.deltaX === 0 && Number.isInteger(e.deltaY) && Math.abs(e.deltaY) >= 50;
}
svg.addEventListener(
  'wheel',
  (e) => {
    if (e.ctrlKey || e.metaKey) return;
    e.preventDefault();
    animation++;
    if (isZoomWheel(e)) glideZoom(e);
    else zoomBehavior.translateBy(svgSel, -e.deltaX / k, -e.deltaY / k);
  },
  { passive: false },
);

/**
 * A mouse wheel notch zooms by the same amount as d3-zoom would, but eases there over a few
 * frames around the pointer instead of jumping, and further notches extend the same glide.
 */
let glideTarget = 0;
let glideAt: [number, number] = [0, 0];
let glideFrame = 0;
function glideZoom(e: WheelEvent) {
  const [lo, hi] = zoomBehavior.scaleExtent();
  const per = e.deltaMode === 1 ? 0.05 : e.deltaMode ? 1 : 0.002;
  const from = glideFrame ? glideTarget : currentTransform().k;
  glideTarget = Math.min(hi, Math.max(lo, from * Math.pow(2, -e.deltaY * per)));
  const r = svg.getBoundingClientRect();
  glideAt = [e.clientX - r.left, e.clientY - r.top];
  if (!glideFrame) glideFrame = requestAnimationFrame(glideStep);
}
function glideStep() {
  const now = currentTransform().k;
  const done = Math.abs(Math.log(glideTarget / now)) < 0.004;
  zoomBehavior.scaleTo(svgSel, done ? glideTarget : now * Math.pow(glideTarget / now, 0.28), glideAt);
  glideFrame = done ? 0 : requestAnimationFrame(glideStep);
}

let animation = 0;
function animateTo(box: { x: number; y: number; w: number; h: number }, pad = 0.85, maxK?: number, instant = false, minK = 0) {
  const v = viewport();
  const [minScale, maxExtent] = zoomBehavior.scaleExtent();
  const minExtent = () => minScale;
  const inset = panelInset();
  const targetK = Math.min(maxExtent, Math.max(minK, minExtent(), Math.min(fitScale(box, pad, inset), maxK ?? maxExtent)));
  const t0 = currentTransform();
  const from: [number, number, number] = [(v.w / 2 - t0.x) / t0.k, (v.h / 2 - t0.y) / t0.k, v.w / t0.k];
  // Shift the target so the box centres in the area the panel leaves uncovered.
  const to: [number, number, number] = [box.x + box.w / 2 + inset / 2 / targetK, box.y + box.h / 2, v.w / targetK];
  const interp = interpolateZoom(from, to);
  const duration = instant ? 0 : Math.min(1100, Math.max(350, interp.duration * 0.6));
  cancelAnimationFrame(glideFrame);
  glideFrame = 0;
  const start = performance.now();
  const id = ++animation;
  const step = (now: number) => {
    if (id !== animation) return;
    const t = duration ? Math.min(1, (now - start) / duration) : 1;
    const e = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
    const [cx, cy, w] = interp(e);
    const kk = v.w / w;
    zoomBehavior.transform(svgSel, zoomIdentity.translate(v.w / 2 - cx * kk, v.h / 2 - cy * kk).scale(kk));
    if (t < 1) requestAnimationFrame(step);
  };
  if (instant) step(start);
  else requestAnimationFrame(step);
}

function zoomToNode(id: string, instant = false) {
  const n = nodes.get(id)!;
  // Leaves get enough room to show their detail line; containers fit the viewport.
  const container = n.children.length > 0 || !!n.lazy;
  // A container is shown open: zoom at least to where its children become readable,
  // even if part of it then runs past the edges.
  const openAt = container ? Math.max(lodNodes.get(id)?.openK ?? 0, n.lazy ? LAZY_OPEN_K : 0, expandAt / n.w) * 1.06 : 0;
  const maxK = Math.max(((container ? 2.5 : 1.8) * expandAt) / n.w, openAt);
  animateTo(n, container ? 0.85 : 0.5, maxK, instant, openAt);
}
const fit = () => animateTo(bounds, 0.92);

// ── selection, focus, panel ─────────────────────────────────────────────────
/**
 * Selects a card and opens its panel. Its connections are highlighted only when `connections` is
 * set (double-click, tours); a plain click leaves the lines alone.
 */
function selectNode(id: string | null, zoomTo = false, connections = false) {
  selected = id;
  if (connections) focused = id;
  else if (focused !== id) focused = null;
  picked = null;
  if (!id) hideTip(true);
  renderPanel();
  applyFocus();
  writeHash();
  if (id && zoomTo) zoomToNode(id);
}

/** Focus: the selected card, its ancestors and descendants, and its 1-hop neighbours. */
function applyFocus() {
  emphasis = new Map();
  if (highlight) {
    // Keep the highlighted cards and their containers; mark the deepest visible card of each.
    const keep = new Set<string>();
    for (const [id, rank] of highlight.nodes) {
      const chain = chains.get(id);
      if (!chain) continue;
      chain.forEach((a) => keep.add(a));
      const host = chain.find((a) => state.visible.has(a));
      if (!host) continue;
      const v = highlight.kind === 'trace' ? -1 : rank;
      const prev = emphasis.get(host);
      if (prev === undefined || (v >= 0 && v < prev)) emphasis.set(host, v);
    }
    focusSet = keep;
  } else if (picked) {
    // A picked line: keep the cards at either end of every connection it stands for.
    const keep = new Set<string>();
    for (const leaf of picked) {
      const e = edgesById.get(leaf);
      if (!e) continue;
      chains.get(e.from)!.forEach((a) => keep.add(a));
      chains.get(e.to)!.forEach((a) => keep.add(a));
    }
    focusSet = keep;
  } else if (!focused) focusSet = null;
  else {
    const focusedId = focused;
    const keep = new Set<string>(chains.get(focusedId));
    const sub = (id: string) => {
      keep.add(id);
      nodes.get(id)!.children.forEach(sub);
    };
    sub(focusedId);
    for (const e of model.edges) {
      const fromIn = inSubtree(e.from, focusedId);
      const toIn = inSubtree(e.to, focusedId);
      if (fromIn === toIn) continue;
      for (const a of chains.get(fromIn ? e.to : e.from)!) keep.add(a);
    }
    focusSet = keep;
  }
  svg.classList.toggle('focusing', !!focusSet);
  const byKey = new Map(lifted.map((l) => [l.key, l]));
  for (const g of edgeLayer.children) {
    const el = g as SVGGElement;
    if (!focusSet) {
      setClass(el, 'dim', false);
      setClass(el, 'emph', false);
      continue;
    }
    const l = byKey.get(el.dataset.key ?? '');
    const hotSet = highlight ? highlight.edges : picked;
    if (hotSet) {
      const hot = !!l && l.leaves.some((leaf) => hotSet.has(leaf));
      setClass(el, 'dim', !hot);
      setClass(el, 'emph', hot);
      continue;
    }
    setClass(el, 'emph', false);
    const touches = l
      ? l.leaves.some((leaf) => {
          const e = edgesById.get(leaf)!;
          return inSubtree(e.from, focused!) || inSubtree(e.to, focused!);
        })
      : el.dataset.fan === focused;
    setClass(el, 'dim', !touches);
  }
  applyCardClasses();
}

/** Touches the element only when the class actually changes, so unchanged lines aren't restyled. */
const setClass = (e: Element, name: string, on: boolean) => {
  if (e.classList.contains(name) !== on) e.classList.toggle(name, on);
};

const FLAG_NOTES: Record<string, (n: BoardNode) => string> = {
  platform: () => 'Platform service: links to it are hidden by default and shown as a "uses" badge on callers. Turn on "Platform links" in Filters to draw them.',
  disputed: (n) => `Ownership disputed${field(n, 'claimant') ? ` with ${nameOf(field(n, 'claimant')!)}` : ''}. It keeps its current parent until resolved.`,
  shared: () => 'Shared datastore: services other than its owner read or write it.',
  migrate: () => 'Calls a deprecated API — migration work.',
  superseded: () => 'Superseded by a newer API version.',
};

function renderPanel() {
  stage.classList.toggle('panel-open', !!selected);
  if (!selected) {
    panel.hidden = true;
    return;
  }
  const n = nodes.get(selected)!;
  const crumbs = el('div', { className: 'crumbs' });
  [...chains.get(n.id)!].reverse().slice(0, -1).forEach((id) => {
    const a = el('a', { textContent: nameOf(id) });
    a.onclick = () => selectNode(id, true);
    crumbs.append(a, ' › ');
  });
  crumbs.append(n.name);

  const dl = el('dl');
  for (const [key, v] of n.fields) if (key !== 'tags') dl.append(el('dt', { textContent: key }), el('dd', { textContent: v }));
  if (n.summary) dl.append(el('dt', { textContent: 'contains' }), el('dd', { textContent: n.summary }));
  if (n.file) dl.append(el('dt', { textContent: 'file' }), el('dd', { textContent: n.file }));

  const inbound: BoardEdge[] = [];
  const outbound: BoardEdge[] = [];
  for (const e of model.edges) {
    const fromIn = inSubtree(e.from, n.id);
    const toIn = inSubtree(e.to, n.id);
    if (fromIn && !toIn) outbound.push(e);
    else if (toIn && !fromIn) inbound.push(e);
  }
  const edgeList = (list: BoardEdge[], dir: 'in' | 'out') => {
    if (!list.length) return el('p', { className: 'empty', textContent: 'None' });
    const ul = el('ul');
    for (const e of list) {
      const other = dir === 'out' ? e.to : e.from;
      // For a container, say which child the connection belongs to.
      const own = dir === 'out' ? e.from : e.to;
      const label =
        own === n.id ? (dir === 'out' ? `→ ${nameOf(other)}` : `${nameOf(other)} →`) : dir === 'out' ? `${nameOf(own)} → ${nameOf(other)}` : `${nameOf(other)} → ${nameOf(own)}`;
      const li = el('li', {}, el('span', {}, label), el('span', { className: 'kind' }, `${e.kind}${e.platform ? ' · platform' : ''}`));
      if (e.gap) li.append(el('span', { className: 'gap-note', textContent: `gap: ${e.gap}` }));
      li.title = pathOf(other);
      li.onclick = () => selectNode(other, true);
      ul.append(li);
    }
    return ul;
  };

  const close = el('button', { className: 'close', textContent: '×', title: 'Close (Esc)' });
  close.onclick = () => selectNode(null);
  const typeBadge = el('span', { className: 'type' });
  const badgeShape = legendShape(n.type as NodeType, 22, 12);
  const hue = n.dept ? hueOf.get(n.dept) : undefined;
  (badgeShape.firstChild as SVGElement).style.setProperty('--h', String(hue ?? deptHue(0)));
  typeBadge.append(badgeShape, n.type);
  const parts: Node[] = [close, typeBadge, el('h2', { textContent: n.name }), crumbs, panelActions(n)];
  for (const f of n.flags) parts.push(el('p', { className: 'note', textContent: FLAG_NOTES[f]?.(n) ?? f }));
  if (staleDomains.has(n.id)) parts.push(el('p', { className: 'note', textContent: `Not reviewed in the last ${STALE_DAYS} days.` }));
  if (n.uses.length) parts.push(el('h3', { textContent: 'Uses platform services' }), chips(n.uses));
  if (n.tags.length) parts.push(el('h3', { textContent: 'Tags' }), chips(n.tags));
  parts.push(
    el('h3', { textContent: 'Details' }),
    dl,
    el('h3', { textContent: `Outbound (${outbound.length})` }),
    edgeList(outbound, 'out'),
    el('h3', { textContent: `Inbound (${inbound.length})` }),
    edgeList(inbound, 'in'),
  );
  panel.replaceChildren(...parts);
  panel.hidden = false;
}

/** "Show connections" for every card; keeping a container open or closed for containers. */
function panelActions(n: BoardNode): HTMLElement {
  const row = el('div', { className: 'actions' });
  const conn = el('button', { textContent: focused === n.id ? 'Hide connections' : 'Show connections', title: 'Or double-click the card' });
  conn.onclick = () => toggleConnections(n.id);
  row.append(conn);
  if (n.children.length) {
    const pin = pins.get(n.id);
    const b = el('button', {
      textContent: pin === undefined ? (state.expanded.has(n.id) ? 'Keep open' : 'Keep closed') : `Kept ${pin ? 'open' : 'closed'} · release`,
      title: 'Hold this card open or closed whatever the zoom',
    });
    b.onclick = () => {
      if (pins.has(n.id)) pins.delete(n.id);
      else pins.set(n.id, !state.expanded.has(n.id));
      state = { ...state, signature: '\u0000' };
      schedule();
      writeHash();
      requestAnimationFrame(renderPanel);
    };
    row.append(b);
  }
  return row;
}

function toggleConnections(id: string) {
  if (focused === id) {
    focused = null;
    applyFocus();
    renderPanel();
  } else selectNode(id, false, true);
}

const chips = (items: string[]) => el('div', { className: 'chips' }, ...items.map((t) => el('span', { textContent: t })));

nodeLayer.addEventListener('click', (e) => {
  const g = (e.target as Element).closest('.node') as SVGGElement | null;
  if (!g) return;
  e.stopPropagation();
  if (present?.onNodeClick(g.dataset.id!, e)) return;
  selectNode(g.dataset.id!);
});

// Double-click a card to highlight its connections; again to clear them. Lines never react to
// hovering or a single click, so moving the pointer across the board changes nothing.
nodeLayer.addEventListener('dblclick', (e) => {
  const g = (e.target as Element).closest('.node') as SVGGElement | null;
  const id = g?.dataset.id;
  if (!id || present?.passiveHover()) return;
  e.stopPropagation();
  toggleConnections(id);
});

svg.addEventListener('click', (e) => {
  if ((e.target as Element).closest('.node, .edge')) return;
  selectNode(null);
  hideTip(true);
});

// ── merged-edge tooltip ─────────────────────────────────────────────────────
let tipPinned = false;

function showTip(g: SVGGElement, x: number, y: number, pin: boolean) {
  let title = '';
  let leaves: string[] = [];
  if (g.dataset.fan) {
    const f = fans.find((x) => x.topic === g.dataset.fan)!;
    title = `${nameOf(f.topic)} → ${f.targets.length} consumers`;
    leaves = f.leaves;
  } else {
    const l = lifted.find((x) => x.key === g.dataset.key);
    if (!l) return;
    title = `${nameOf(l.from)} → ${nameOf(l.to)} · ${describeKinds(l.kinds)}`;
    leaves = l.leaves;
  }
  tipPinned = pin;
  const ul = el('ul');
  for (const leaf of leaves) {
    const e = edgesById.get(leaf)!;
    const li = el('li', {}, `${nameOf(e.from)} → ${nameOf(e.to)} `, el('span', { className: 'k', textContent: `${e.kind}${e.gap ? ` · gap: ${e.gap}` : ''}` }));
    li.onclick = () => {
      const a = nodes.get(e.from)!;
      const b = nodes.get(e.to)!;
      const x0 = Math.min(a.x, b.x);
      const y0 = Math.min(a.y, b.y);
      animateTo({ x: x0, y: y0, w: Math.max(a.x + a.w, b.x + b.w) - x0, h: Math.max(a.y + a.h, b.y + b.h) - y0 }, 0.7);
      hideTip(true);
    };
    ul.append(li);
  }
  tip.replaceChildren(el('b', { textContent: title }), ul);
  const r = stage.getBoundingClientRect();
  tip.hidden = false;
  tip.style.left = `${Math.max(8, Math.min(x - r.left + 12, r.width - tip.offsetWidth - 8))}px`;
  tip.style.top = `${Math.max(8, Math.min(y - r.top + 12, r.height - tip.offsetHeight - 8))}px`;
}
function hideTip(force: boolean) {
  if (tipPinned && !force) return;
  tipPinned = false;
  tip.hidden = true;
  if (force && picked) {
    picked = null;
    applyFocus();
  }
}
// Double-click a line to select it: it and the cards at its ends stay bright, and a list of the
// connections it stands for opens beside it.
edgeLayer.addEventListener('dblclick', (e) => {
  const g = (e.target as Element).closest('.edge') as SVGGElement | null;
  if (!g || present?.passiveHover()) return;
  e.stopPropagation();
  const leaves = g.dataset.fan ? fans.find((f) => f.topic === g.dataset.fan)?.leaves : lifted.find((l) => l.key === g.dataset.key)?.leaves;
  if (!leaves) return;
  focused = null;
  picked = new Set(leaves);
  applyFocus();
  showTip(g, e.clientX, e.clientY, true);
});

// ── search ──────────────────────────────────────────────────────────────────
let hits: BoardNode[] = [];
let active = 0;

function runSearch() {
  const q = searchInput.value.trim().toLowerCase();
  if (!q) {
    results.hidden = true;
    return;
  }
  hits = model.nodes
    .filter((n) => n.type !== 'band')
    .map((n) => {
      const hay = [n.id, n.name, ...n.tags, ...n.fields.filter(([key]) => /team|owner|head|technology|style/i.test(key)).map(([, v]) => v)].join(' ').toLowerCase();
      const name = n.name.toLowerCase();
      const score = name === q ? 0 : name.startsWith(q) ? 1 : hay.includes(q) ? 2 : -1;
      return { n, score };
    })
    .filter((h) => h.score >= 0)
    .sort((a, b) => a.score - b.score || a.n.level - b.n.level || a.n.id.localeCompare(b.n.id))
    .slice(0, 12)
    .map((h) => h.n);
  active = 0;
  renderResults();
}
function renderResults() {
  results.replaceChildren(
    ...hits.map((n, i) => {
      const li = el('li', { className: i === active ? 'active' : '' }, el('div', { textContent: `${n.name}  ·  ${n.type}` }), el('div', { className: 'path', textContent: pathOf(n.id) }));
      li.onmousedown = (e) => {
        e.preventDefault();
        choose(n.id);
      };
      return li;
    }),
  );
  if (!hits.length) results.append(el('li', { className: 'path', textContent: 'No matches' }));
  results.hidden = false;
}
function choose(id: string) {
  results.hidden = true;
  searchInput.blur();
  selectNode(id, true);
}
searchInput.addEventListener('input', runSearch);
searchInput.addEventListener('blur', () => (results.hidden = true));
searchInput.addEventListener('focus', runSearch);
searchInput.addEventListener('keydown', (e) => {
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    active = (active + (e.key === 'ArrowDown' ? 1 : -1) + hits.length) % Math.max(1, hits.length);
    renderResults();
  } else if (e.key === 'Enter' && hits[active]) choose(hits[active].id);
  else if (e.key === 'Escape') {
    searchInput.value = '';
    results.hidden = true;
    searchInput.blur();
  }
});

// ── filters ─────────────────────────────────────────────────────────────────
const allTags = [...new Set(model.nodes.flatMap((n) => n.tags))].sort();

/** Connection kinds this board can show (Spec0 boards also get operation and schema links later). */
const presentGroups = (): Set<KindGroup> => {
  const g = new Set(model.edges.map((e) => kindGroup(e.kind)));
  if (model.spec0) ['schema', 'twin'].forEach((x) => g.add(x as KindGroup));
  return g;
};
const KIND_ROWS: Array<[KindGroup, string, string]> = [
  ['calls', 'Calls', '--e-calls'],
  ['pending', 'Pending grants', '--e-pending'],
  ['async', 'Events (publish / consume)', '--e-async'],
  ['store', 'Datastore access', '--e-store'],
  ['gap', 'Unknown API', '--e-gap'],
  ['schema', 'Schema use and references', '--e-schema'],
  ['twin', 'Identical schemas across APIs', '--e-twin'],
];
let kindRows: () => HTMLElement[] = () => [];

function buildFilterPopover() {
  const kindRow = (key: KindGroup, label: string, color: string) => {
    const cb = el('input', { type: 'checkbox', checked: filters.kinds.has(key) });
    cb.onchange = () => {
      if (cb.checked) filters.kinds.add(key);
      else filters.kinds.delete(key);
      applyFilters();
    };
    const sw = el('span', { className: 'swatch' });
    sw.style.background = `var(${color})`;
    return el('label', {}, cb, sw, label);
  };
  kindRows = () => {
    const have = presentGroups();
    return KIND_ROWS.filter(([g]) => have.has(g)).map(([g, label, color]) => kindRow(g, label, color));
  };
  const select_ = (options: string[], value: string, onChange: (v: string) => void, any: string) => {
    const s = el('select');
    s.append(el('option', { value: '', textContent: any }), ...options.map((o) => el('option', { value: o, textContent: o })));
    s.value = value;
    s.onchange = () => onChange(s.value);
    return s;
  };
  const toggle = (label: string, value: boolean, onChange: (v: boolean) => void) => {
    const cb = el('input', { type: 'checkbox', checked: value });
    cb.onchange = () => onChange(cb.checked);
    return el('label', {}, cb, label);
  };
  filterPop.replaceChildren(
    el('h4', { textContent: 'Connections' }),
    ...kindRows(),
    toggle('Platform links', filters.platform, (v) => {
      filters.platform = v;
      state = { ...state, signature: '\u0000' };
      schedule();
      writeHash();
    }),
    ...(model.clusters.length
      ? [el('h4', { textContent: 'Kafka cluster' }), select_(model.clusters.map((c) => c.id), filters.cluster, (v) => ((filters.cluster = v), applyFilters()), 'All clusters')]
      : []),
    el('h4', { textContent: 'Tag' }),
    select_(allTags, filters.tag, (v) => ((filters.tag = v), applyFilters()), allTags.length ? 'All tags' : 'No tags in registry'),
    el('h4', { textContent: 'Freshness' }),
    toggle(`Stale domains only (${staleDomains.size})`, filters.stale, (v) => ((filters.stale = v), applyFilters())),
  );
}

function applyFilters() {
  const sets: Set<string>[] = [];
  const withFamily = (ids: Iterable<string>) => {
    const out = new Set<string>();
    const down = (id: string) => {
      out.add(id);
      nodes.get(id)!.children.forEach(down);
    };
    for (const id of ids) {
      chains.get(id)!.forEach((a) => out.add(a));
      down(id);
    }
    return out;
  };
  if (filters.tag) sets.push(withFamily(model.nodes.filter((n) => n.tags.includes(filters.tag)).map((n) => n.id)));
  if (filters.cluster) {
    const topics = model.nodes.filter((n) => n.type === 'topic' && field(n, 'cluster') === filters.cluster).map((n) => n.id);
    const t = new Set(topics);
    const linked = model.edges.filter((e) => t.has(e.from) || t.has(e.to)).flatMap((e) => [e.from, e.to]);
    // Producers and consumers stay lit, but only the topics themselves bring their subtree.
    const lit = withFamily(topics);
    linked.forEach((id) => chains.get(id)!.forEach((a) => lit.add(a)));
    sets.push(lit);
  }
  if (filters.stale) sets.push(withFamily(staleDomains));
  matchSet = sets.length ? sets.reduce((a, b) => new Set([...a].filter((x) => b.has(x)))) : null;
  filterBtn.classList.toggle('on', sets.length > 0 || !kindsAreDefault() || filters.platform);
  applyEdgeFilter();
  applyCardClasses();
  writeHash();
}

function applyEdgeFilter() {
  const byKey = new Map(lifted.map((l) => [l.key, l]));
  for (const g of edgeLayer.children) {
    const el = g as SVGGElement;
    const l = byKey.get(el.dataset.key ?? '');
    let dim = false;
    if (l) {
      dim = !(Object.keys(l.kinds) as ConnectionKind[]).some((kk) => filters.kinds.has(kindGroup(kk)));
      if (matchSet && (!matchSet.has(l.from) || !matchSet.has(l.to))) dim = true;
    } else if (el.dataset.fan) {
      dim = !filters.kinds.has('async') || (!!matchSet && !matchSet.has(el.dataset.fan));
    }
    el.classList.toggle('fdim', dim);
  }
}

// ── legend ──────────────────────────────────────────────────────────────────
function buildLegend() {
  const grid = el('div', { className: 'legend-grid' });
  const types: Array<[NodeType, string]> = [
    ['department', 'Department'],
    ['domain', 'Domain'],
    ['system', 'System (optional grouping)'],
    ['service', 'Service'],
    ['api', 'API (one contract)'],
    ['apigroup', 'API group (busy hosts, by tag)'],
    ['topic', 'Kafka topic'],
    ['channel', 'Channel (SFTP, webhook, queue…)'],
    ['datastore', 'Datastore'],
    ['external', 'External partner / SaaS'],
  ];
  for (const [t, label] of types) {
    const s = legendShape(t);
    if (t === 'department' || t === 'domain' || t === 'system') (s.firstChild as SVGElement).style.setProperty('--h', String(deptHue(0)));
    grid.append(s, el('span', { textContent: label }));
  }
  const line = (cls: string, head: string, label: string) => {
    const s = svgEl<SVGSVGElement>('svg', { class: 'legend-line', viewBox: '0 0 44 12' });
    const g = svgEl('g', { class: `edge ${cls}` });
    g.append(svgEl('path', { class: 'line', d: 'M2,6 H38', 'stroke-width': 2 }));
    const h = svgEl('path', { class: head === 'open' ? 'head open' : 'head', d: head === 'open' ? 'M33,1 L41,6 L33,11' : head === 'dot' ? 'M34,6 a3.5,3.5 0 1,0 7,0 a3.5,3.5 0 1,0 -7,0' : 'M42,6 L32,1 L32,11 Z' });
    g.append(h);
    s.append(g);
    grid.append(s, el('span', { textContent: label }));
  };
  line('k-calls', 'fill', 'Calls (sync)');
  line('k-async', 'open', 'Publishes / consumes (async)');
  line('k-store', 'dot', 'Reads / writes a datastore');
  line('k-gap gap', 'fill', 'Calls, API unknown (gap)');
  line('k-mixed', 'fill', 'Merged, mixed kinds (number = count)');
  legendPop.replaceChildren(
    el('h4', { textContent: 'Components' }),
    grid,
    el('h4', { textContent: 'Markers' }),
    el(
      'div',
      { className: 'chips' },
      ...['PLATFORM — links hidden, shown as "uses"', 'DISPUTED — ownership', 'MIGRATE — calls a deprecated API', 'SHARED — datastore', 'Red dashed — domain review overdue'].map((t) =>
        el('span', { textContent: t }),
      ),
    ),
  );
}

function togglePopover(pop: HTMLElement, btn: HTMLElement, build: () => void) {
  const open = pop.hidden;
  filterPop.hidden = true;
  legendPop.hidden = true;
  filterBtn.classList.toggle('on', false);
  legendBtn.classList.toggle('on', false);
  if (open) {
    build();
    pop.hidden = false;
    const r = btn.getBoundingClientRect();
    pop.style.left = `${Math.max(8, r.left - stage.getBoundingClientRect().left)}px`;
    btn.classList.add('on');
  }
  applyFilters();
}
filterBtn.onclick = () => togglePopover(filterPop, filterBtn, buildFilterPopover);
legendBtn.onclick = () => togglePopover(legendPop, legendBtn, buildLegend);

// ── breadcrumb ──────────────────────────────────────────────────────────────
function updateCrumbs() {
  const t = currentTransform();
  const v = viewport();
  const cx = (v.w / 2 - t.x) / t.k;
  const cy = (v.h / 2 - t.y) / t.k;
  const contains = (n: BoardNode) => cx >= n.x && cx <= n.x + n.w && cy >= n.y && cy <= n.y + n.h;
  const chain: string[] = [];
  let level: string[] = roots;
  while (true) {
    const hit = level.find((id) => state.expanded.has(id) && contains(nodes.get(id)!));
    if (!hit) break;
    chain.push(hit);
    level = nodes.get(hit)!.children;
  }
  crumbbar.replaceChildren();
  chain.forEach((id, i) => {
    if (i) crumbbar.append(el('span', { className: 'sep', textContent: '›' }));
    const a = el('a', { textContent: nameOf(id) });
    a.onclick = () => zoomToNode(id);
    crumbbar.append(a);
  });
}

// ── minimap ─────────────────────────────────────────────────────────────────
const MM_W = 200;
const mmScale = Math.min(MM_W / bounds.w, 140 / bounds.h);
const mmBase = document.createElement('canvas');
{
  const dpr = window.devicePixelRatio || 1;
  const w = Math.ceil(bounds.w * mmScale) + 12;
  const h = Math.ceil(bounds.h * mmScale) + 12;
  for (const c of [minimap, mmBase]) {
    c.width = w * dpr;
    c.height = h * dpr;
  }
  minimap.style.width = `${w}px`;
  minimap.style.height = `${h}px`;
  const ctx = mmBase.getContext('2d')!;
  ctx.scale(dpr, dpr);
  const draw = (id: string, depth: number) => {
    const n = nodes.get(id)!;
    const hue = n.dept ? hueOf.get(n.dept) : undefined;
    ctx.fillStyle = hue === undefined ? '#ecebe6' : depth === 0 ? `hsl(${hue} 36% 90%)` : `hsl(${hue} 30% 97%)`;
    ctx.strokeStyle = hue === undefined ? '#c9c6bd' : `hsl(${hue} 26% ${depth === 0 ? 70 : 80}%)`;
    const x = 6 + (n.x - bounds.x) * mmScale;
    const y = 6 + (n.y - bounds.y) * mmScale;
    ctx.fillRect(x, y, n.w * mmScale, n.h * mmScale);
    ctx.strokeRect(x, y, n.w * mmScale, n.h * mmScale);
    if (depth === 0) n.children.forEach((c) => draw(c, 1));
  };
  roots.forEach((id) => draw(id, 0));
}
function drawMinimapViewport() {
  const ctx = minimap.getContext('2d')!;
  const dpr = window.devicePixelRatio || 1;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, minimap.width, minimap.height);
  ctx.drawImage(mmBase, 0, 0);
  ctx.scale(dpr, dpr);
  const t = currentTransform();
  const v = viewport();
  const x = 6 + (-t.x / t.k - bounds.x) * mmScale;
  const y = 6 + (-t.y / t.k - bounds.y) * mmScale;
  ctx.strokeStyle = '#2f6fdc';
  ctx.lineWidth = 1.5;
  ctx.fillStyle = 'rgba(47,111,220,.08)';
  ctx.fillRect(x, y, (v.w / t.k) * mmScale, (v.h / t.k) * mmScale);
  ctx.strokeRect(x, y, (v.w / t.k) * mmScale, (v.h / t.k) * mmScale);
}
function minimapPan(e: MouseEvent) {
  const r = minimap.getBoundingClientRect();
  const wx = bounds.x + (e.clientX - r.left - 6) / mmScale;
  const wy = bounds.y + (e.clientY - r.top - 6) / mmScale;
  zoomBehavior.translateTo(svgSel, wx, wy);
}
let mmDrag = false;
minimap.addEventListener('mousedown', (e) => {
  mmDrag = true;
  minimapPan(e);
});
window.addEventListener('mousemove', (e) => mmDrag && minimapPan(e));
window.addEventListener('mouseup', () => {
  if (mmDrag) updateCrumbs();
  mmDrag = false;
});

// ── deep links ──────────────────────────────────────────────────────────────
let hashTimer = 0;
function writeHash() {
  clearTimeout(hashTimer);
  hashTimer = window.setTimeout(() => {
    const t = currentTransform();
    const v = viewport();
    const p = new URLSearchParams(location.hash.slice(1));
    for (const key of ['v', 'focus', 'level', 'pins', 'kinds', 'tag', 'cluster', 'stale', 'platform', 'style']) p.delete(key);
    p.set('v', [(v.w / 2 - t.x) / t.k, (v.h / 2 - t.y) / t.k, t.k].map((x) => +x.toFixed(3)).join(','));
    if (selected) p.set('focus', selected);
    if (levelOverride !== null) p.set('level', String(levelOverride));
    if (pins.size) p.set('pins', [...pins].map(([id, open]) => `${id}:${open ? 1 : 0}`).join(','));
    if (!kindsAreDefault()) p.set('kinds', [...filters.kinds].join(','));
    if (filters.tag) p.set('tag', filters.tag);
    if (filters.cluster) p.set('cluster', filters.cluster);
    if (filters.stale) p.set('stale', '1');
    if (filters.platform) p.set('platform', '1');
    if (style !== 'studio') p.set('style', style);
    history.replaceState(null, '', `#${p.toString()}`);
  }, 250);
}

function readHash() {
  const p = new URLSearchParams(location.hash.slice(1));
  const level = p.get('level');
  if (level !== null && levelNames[Number(level)]) {
    levelOverride = Number(level);
    levelSelect.value = level;
  }
  for (const pin of (p.get('pins') ?? '').split(',').filter(Boolean)) {
    const i = pin.lastIndexOf(':');
    if (nodes.has(pin.slice(0, i))) pins.set(pin.slice(0, i), pin.slice(i + 1) === '1');
  }
  const kinds = p.get('kinds');
  if (kinds !== null) filters.kinds = new Set(kinds.split(',').filter(Boolean) as KindGroup[]);
  filters.tag = p.get('tag') ?? '';
  filters.cluster = p.get('cluster') ?? '';
  filters.stale = p.get('stale') === '1';
  filters.platform = p.get('platform') === '1';
  let saved: string | null = null;
  try {
    saved = localStorage.getItem('atlas-style');
  } catch {
    /* storage unavailable */
  }
  const st = (p.get('style') ?? saved) as Style | null;
  setStyle(st && STYLES.includes(st) ? st : 'studio');
  const focus = p.get('focus');
  const v = p.get('v')?.split(',').map(Number);
  return { focus: focus && nodes.has(focus) ? focus : null, view: v && v.length === 3 && v.every(Number.isFinite) ? v : null };
}

// ── controls ────────────────────────────────────────────────────────────────
levelSelect.addEventListener('change', () => {
  levelOverride = levelSelect.value === '' ? null : Number(levelSelect.value);
  schedule();
  writeHash();
});
fitBtn.onclick = fit;

window.addEventListener('keydown', (e) => {
  if (present?.onKey(e)) {
    e.preventDefault();
    return;
  }
  if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement || e.target instanceof HTMLTextAreaElement) return;
  if (e.key === '+' || e.key === '=') zoomBehavior.scaleBy(svgSel, 1.4);
  else if (e.key === '-' || e.key === '_') zoomBehavior.scaleBy(svgSel, 1 / 1.4);
  else if (e.key === 'f' || e.key === 'F') fit();
  else if ((e.key === 'z' || e.key === 'Z') && selected) zoomToNode(selected);
  else if (e.key === '/') {
    e.preventDefault();
    searchInput.focus();
  } else if (e.key === 'Escape') {
    hideTip(true);
    filterPop.hidden = true;
    legendPop.hidden = true;
    selectNode(null);
  }
});
window.addEventListener('resize', () => {
  measureViewport();
  schedule();
});

// ── presentation and review tools ───────────────────────────────────────────
present = initPresentation({
  model,
  nodes,
  chains,
  app,
  stage,
  svg,
  world,
  nameOf,
  pathOf,
  currentTransform,
  viewport,
  zoomToNode: (id) => zoomToNode(id),
  zoomToBox: (box, pad) => animateTo(box, pad ?? 0.85),
  setHighlight(h) {
    highlight = h;
    svg.classList.toggle('highlighting', !!h);
    applyFocus();
  },
  selectNode: (id) => selectNode(id, false, true),
  setLevel(level) {
    levelOverride = level;
    levelSelect.value = level === null ? '' : String(level);
    schedule();
  },
  isVisible: (id) => state.visible.has(id),
  setTool(t) {
    app.dataset.tool = t;
  },
});
present.setFocusGetter(() => selected);

// ── first render ────────────────────────────────────────────────────────────
{
  const { focus, view } = readHash();
  const v = viewport();
  if (view) {
    const [cx, cy, kk] = view;
    zoomBehavior.transform(svgSel, zoomIdentity.translate(v.w / 2 - cx * kk, v.h / 2 - cy * kk).scale(kk));
  } else {
    const k0 = fitScale(bounds, 0.92);
    zoomBehavior.transform(svgSel, zoomIdentity.translate(v.w / 2 - (bounds.x + bounds.w / 2) * k0, v.h / 2 - (bounds.y + bounds.h / 2) * k0).scale(k0));
  }
  if (focus) {
    selectNode(focus);
    if (!view) zoomToNode(focus, true);
  }
  syncScaleVars();
  update();
  applyFilters();
  updateCrumbs();
  requestAnimationFrame(() => app.classList.add('ready'));
}
}
