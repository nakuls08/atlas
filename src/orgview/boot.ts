import { EmbeddedSource, HttpSource } from '../spec0/source';
import type { ApiDetails, GraphSnapshot, GraphSource } from '../spec0/types';
import { el } from '../viewer/dom';
import { buildGraph, type Hierarchy } from './graph';
import { layoutOrg } from './layout';
import { mountOrgView } from './view';

/** Page entry for an org graph: fetch the snapshot, build the chosen grouping, mount the board. */

type Payload = {
  kind: 'spec0';
  source: { type: 'embedded'; snapshot: GraphSnapshot; details: Record<string, ApiDetails> } | { type: 'http'; baseUrl: string };
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
