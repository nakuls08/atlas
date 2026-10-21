import ELK from 'elkjs/lib/elk-api.js';
import type { BoardModel, BoardNode } from '../model';
import { DEFAULT_SETTINGS } from '../model';
import { layoutBoard, type ElkEngine } from '../layout/elk';
import { buildFromSnapshot, expandApi, HIERARCHIES, id, type Hierarchy } from '../spec0/board';
import { EmbeddedSource, HttpSource } from '../spec0/source';
import type { ApiDetails, GraphSnapshot, GraphSource } from '../spec0/types';
import { el } from './dom';
import { start, type DetailResult } from './main';

/**
 * Page entry. A registry board arrives fully laid out. A Spec0 board arrives as a data source:
 * the snapshot is fetched, the chosen hierarchy is built and laid out here in the browser
 * (ELK in a Web Worker, cached per snapshot version), and API details load as you zoom.
 */

type Spec0Payload = {
  kind: 'spec0';
  source: { type: 'embedded'; snapshot: GraphSnapshot; details: Record<string, ApiDetails> } | { type: 'http'; baseUrl: string };
};

const payload = JSON.parse(document.getElementById('atlas-model')!.textContent!) as BoardModel | Spec0Payload;
if ('kind' in payload && payload.kind === 'spec0') void bootSpec0(payload);
else start(payload as BoardModel);

/** Bump when layout rules change, so cached layouts are recomputed. */
const LAYOUT_REV = 1;

async function bootSpec0(p: Spec0Payload) {
  const app = document.getElementById('app')!;
  const splash = el('div', { className: 'splash' }, el('div', { className: 'logo' }), el('b', { textContent: 'Atlas' }), el('span', { textContent: 'Loading the org graph…' }));
  app.append(splash);
  const status = (t: string) => ((splash.lastChild as HTMLElement).textContent = t);

  const source: GraphSource = p.source.type === 'embedded' ? new EmbeddedSource(p.source.snapshot, p.source.details) : new HttpSource(p.source.baseUrl);
  const snap = await source.snapshot();

  const params = new URLSearchParams(location.hash.slice(1));
  const hierarchy: Hierarchy = params.get('hierarchy') === 'domain' ? 'domain' : 'team';
  const board = buildFromSnapshot(snap, hierarchy);

  status(`Laying out ${snap.apis.length} APIs…`);
  const t0 = performance.now();
  const cacheKey = `atlas-layout:${snap.org.id}:${snap.version}:${hierarchy}:${LAYOUT_REV}`;
  if (!restoreLayout(cacheKey, board.nodes)) {
    await layoutBoard(board.nodes, board.edges, browserElk(), (n) => (n.type === 'api' && !n.children.length ? { w: n.w, h: n.h } : undefined));
    saveLayout(cacheKey, board.nodes);
  }
  const layoutMs = Math.round(performance.now() - t0);
  splash.remove();

  const model: BoardModel = {
    meta: { version: snap.version, org: snap.org.name },
    settings: DEFAULT_SETTINGS,
    clusters: [],
    nodes: [...board.nodes.values()].sort((a, b) => a.id.localeCompare(b.id)),
    edges: board.edges,
    tours: [],
    levels: board.levels,
    spec0: { hierarchy, org: snap.org.name, snapshotVersion: snap.version },
  };

  // Hierarchy switch: a different view of the same snapshot.
  const seg = el('div', { className: 'seg', title: 'Group the board' });
  for (const h of Object.keys(HIERARCHIES) as Hierarchy[]) {
    const b = el('button', { textContent: HIERARCHIES[h].label, className: h === hierarchy ? 'on' : '' });
    b.onclick = () => {
      if (h === hierarchy) return;
      const q = new URLSearchParams(location.hash.slice(1));
      for (const key of ['v', 'focus', 'pins', 'level']) q.delete(key);
      q.set('hierarchy', h);
      location.hash = q.toString();
      location.reload();
    };
    seg.append(b);
  }

  // Network meter: what this session actually asked the server for.
  const meter = el('span', { className: 'netmeter', title: 'Requests this session (gzipped sizes)' });
  const kb = (b: number) => `${(b / 1024).toFixed(b < 10240 ? 1 : 0)} KB`;
  const renderMeter = () => {
    const r = source.stats.requests;
    const snaps = r.filter((x) => x.kind === 'snapshot');
    const det = r.filter((x) => x.kind === 'details');
    meter.replaceChildren(
      el('b', { textContent: `${r.length} request${r.length === 1 ? '' : 's'}` }),
      ` · snapshot ${kb(snaps.reduce((s, x) => s + x.bytes, 0))}`,
      det.length ? ` · ${det.length} detail batch${det.length === 1 ? '' : 'es'} (${det.reduce((s, x) => s + x.apis, 0)} APIs, ${kb(det.reduce((s, x) => s + x.bytes, 0))})` : '',
      ` · layout ${layoutMs} ms`,
    );
  };
  renderMeter();

  const hashes = new Map<string, string[]>();
  const domainName = new Map(snap.domains.map((d) => [d.id, d.name]));
  start(model, {
    toolbarExtras: [seg],
    footerExtras: [meter],
    async loadDetails(apis: BoardNode[]): Promise<DetailResult[]> {
      const keys = apis.filter((a) => a.lazy).map((a) => ({ id: a.id.slice(2), specVersion: a.lazy!.specVersion }));
      if (!keys.length) return [];
      const details = await source.details(keys);
      renderMeter();
      const byNode = new Map(apis.map((a) => [a.id, a]));
      const nodes = new Map(model.nodes.map((n) => [n.id, n]));
      const out: DetailResult[] = [];
      for (const d of details) {
        const api = byNode.get(id.api(d.id));
        if (!api) continue;
        const r = expandApi(api, d, { nodes, edges: model.edges, hashes, domainName });
        out.push({ api: api.id, nodes: r.nodes, add: r.add, remove: r.remove });
      }
      return out;
    },
  });
}

/** ELK in a Web Worker, from the worker script embedded in the page. */
function browserElk(): ElkEngine {
  const src = document.getElementById('elk-worker')?.textContent;
  if (!src) throw new Error('The ELK worker script is missing from the page');
  const url = URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));
  return new ELK({ workerUrl: url }) as unknown as ElkEngine;
}

function restoreLayout(key: string, nodes: Map<string, BoardNode>): boolean {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return false;
    const geo = JSON.parse(raw) as Record<string, [number, number, number, number]>;
    if (Object.keys(geo).length !== nodes.size || [...nodes.keys()].some((k) => !geo[k])) return false;
    for (const [k, [x, y, w, h]] of Object.entries(geo)) Object.assign(nodes.get(k)!, { x, y, w, h });
    return true;
  } catch {
    return false;
  }
}

function saveLayout(key: string, nodes: Map<string, BoardNode>) {
  try {
    const geo: Record<string, [number, number, number, number]> = {};
    for (const [k, n] of nodes) geo[k] = [n.x, n.y, n.w, n.h];
    // Keep only the latest layout per org and hierarchy.
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const k = localStorage.key(i);
      if (k && k.startsWith(key.split(':').slice(0, 2).join(':')) && k.endsWith(key.split(':').slice(-2).join(':')) && k !== key) localStorage.removeItem(k);
    }
    localStorage.setItem(key, JSON.stringify(geo));
  } catch {
    /* storage unavailable or full: the layout is simply recomputed next time */
  }
}
