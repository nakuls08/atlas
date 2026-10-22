import { loadUsage, reportPlugin, urlPlugin, type UsagePlugin, type UsageReport } from '../enrich/usage';
import { EmbeddedSource, HttpSource } from '../spec0/source';
import type { ApiDetails, GraphSnapshot, GraphSource } from '../spec0/types';
import { spec0AuthzPlugin } from '../spec0/usage';
import { el } from '../viewer/dom';
import { applyUsage, buildGraph, type Hierarchy } from './graph';
import { layoutOrg } from './layout';
import { mountOrgView } from './view';
import './page.css';

/**
 * Page entry for an org graph: fetch the snapshot, build the chosen grouping, load usage from the
 * page's plugins, mount the board.
 */

/** Usage plugins a page can name; earlier ones win for an API more than one of them covers. */
export type UsageSpec = { type: 'report'; report: UsageReport } | { type: 'url'; url: string } | { type: 'spec0' };

type Payload = {
  kind: 'spec0';
  source: { type: 'embedded'; snapshot: GraphSnapshot; details: Record<string, ApiDetails> } | { type: 'http'; baseUrl: string };
  usage?: UsageSpec[];
};

const payload = JSON.parse(document.getElementById('atlas-model')!.textContent!) as Payload;
void boot(payload);

async function boot(p: Payload) {
  const app = document.getElementById('app')!;
  const splash = el('div', { className: 'ov-splash', textContent: 'Loading the org graph…' });
  document.body.append(splash);
  const source: GraphSource = p.source.type === 'embedded' ? new EmbeddedSource(p.source.snapshot, p.source.details) : new HttpSource(p.source.baseUrl);
  const snap = await source.snapshot();
  const hierarchy: Hierarchy = new URLSearchParams(location.hash.slice(1)).get('hierarchy') === 'domain' ? 'domain' : 'team';
  const graph = buildGraph(snap, hierarchy);
  const plugins: UsagePlugin[] = (p.usage ?? []).map((u) => (u.type === 'report' ? reportPlugin(u.report) : u.type === 'url' ? urlPlugin(u.url) : spec0AuthzPlugin(snap)));
  if (plugins.length) applyUsage(graph, await loadUsage(plugins, { apis: snap.apis.map((a) => ({ id: a.id, name: a.name })) }));
  const geo = layoutOrg(graph);
  splash.remove();
  mountOrgView(app, graph, geo, source, {
    setHierarchy(h) {
      const q = new URLSearchParams();
      if (h !== 'team') q.set('hierarchy', h);
      location.hash = q.toString();
      location.reload();
    },
  });
}
