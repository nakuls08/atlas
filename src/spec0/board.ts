import type { BoardEdge, BoardNode, NodeType } from '../model';
import { API_GRID, apiCardSize, apiCells } from './apiGrid';
import type { ApiDetails, GraphSnapshot } from './types';

const field = (k: string, v: string | null | undefined): Array<[string, string]> => (v ? [[k, v]] : []);

/**
 * Builds an Atlas board from a Spec0 snapshot, in the browser. The hierarchy is a view choice,
 * not part of the data:
 *
 *   team    team → service → API → operations and schemas   (APIs sit under their exposing
 *           service once Spec0 records it, otherwise under the owning team)
 *   domain  domain → API → operations and schemas, with teams and services in a side band
 *           as consumers. An API goes under the domain holding most of its schemas.
 *
 * APIs arrive without their operations and schemas (`lazy`); `expandApi` adds them later.
 */

export type Hierarchy = 'team' | 'domain';

export const HIERARCHIES: Record<Hierarchy, { label: string; levels: string[] }> = {
  team: { label: 'By team', levels: ['team', 'service', 'API', 'operation & schema'] },
  domain: { label: 'By domain', levels: ['domain', 'API', 'operation & schema'] },
};

const LEVELS: Record<Hierarchy, Partial<Record<NodeType, number>>> = {
  team: { team: 0, band: 0, service: 1, api: 2, operation: 3, schema: 3 },
  domain: { domain: 0, band: 0, team: 1, api: 1, service: 2, operation: 2, schema: 2 },
};

export const id = {
  team: (x: string) => `t:${x}`,
  service: (x: string) => `s:${x}`,
  api: (x: string) => `a:${x}`,
  domain: (x: string) => `d:${x}`,
};
const NO_DOMAIN = '__nodomain';
const TEAMS = '__teams';
const NO_TEAM = '__noteam';

export interface Spec0Board {
  nodes: Map<string, BoardNode>;
  edges: BoardEdge[];
  levels: string[];
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
const compact = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(n));

export function buildFromSnapshot(snap: GraphSnapshot, hierarchy: Hierarchy): Spec0Board {
  const nodes = new Map<string, BoardNode>();
  const level = LEVELS[hierarchy];
  const node = (nid: string, type: NodeType, name: string, parent: string | null, extra: Partial<BoardNode> = {}): BoardNode => {
    const n: BoardNode = {
      id: nid,
      type,
      name,
      parent,
      level: level[type] ?? 0,
      status: 'active',
      x: 0,
      y: 0,
      w: 0,
      h: 0,
      children: [],
      dept: null,
      summary: '',
      detail: '',
      flags: [],
      tags: [],
      uses: [],
      fields: [],
      ...extra,
    };
    nodes.set(nid, n);
    return n;
  };

  const teamName = new Map(snap.teams.map((t) => [t.id, t.name]));
  const serviceName = new Map(snap.services.map((s) => [s.id, s.name]));
  const domainName = new Map(snap.domains.map((d) => [d.id, d.name]));
  const byName = <T extends { name: string; id: string }>(a: T, b: T) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id);

  // Containers that hold teams and services.
  const teamParent = hierarchy === 'team' ? null : TEAMS;
  if (hierarchy === 'domain') node(TEAMS, 'band', 'Teams', null);
  for (const t of [...snap.teams].sort(byName)) {
    node(id.team(t.id), 'team', t.name, teamParent, {
      detail: t.members ? plural(t.members, 'member', 'members') : '',
      fields: [['id', t.id], ['type', 'team'], ...(t.members ? ([['members', String(t.members)]] as Array<[string, string]>) : [])],
    });
  }
  const ownerless = snap.services.some((s) => !s.team || !teamName.has(s.team));
  if (ownerless) node(NO_TEAM, hierarchy === 'team' ? 'band' : 'team', 'No owning team', teamParent);
  for (const s of [...snap.services].sort(byName)) {
    const owner = s.team && teamName.has(s.team) ? id.team(s.team) : NO_TEAM;
    node(id.service(s.id), 'service', s.name, owner, {
      detail: s.team ? (teamName.get(s.team) ?? '') : '',
      fields: [['id', s.id], ['type', 'service'], ['team', s.team ? (teamName.get(s.team) ?? s.team) : 'none']],
    });
  }

  if (hierarchy === 'domain') {
    for (const d of [...snap.domains].sort(byName)) {
      node(id.domain(d.id), 'domain', d.name, null, { fields: [['id', d.id], ['type', 'domain'], ...(d.slug ? ([['slug', d.slug]] as Array<[string, string]>) : [])] });
    }
  }

  // APIs.
  let noDomain = false;
  for (const a of [...snap.apis].sort(byName)) {
    let parent: string;
    if (hierarchy === 'team') {
      parent = a.service && serviceName.has(a.service) ? id.service(a.service) : id.team(a.team);
    } else {
      const doms = Object.entries(a.domains ?? {}).filter(([d]) => domainName.has(d));
      doms.sort((x, y) => y[1] - x[1] || x[0].localeCompare(y[0]));
      parent = doms.length ? id.domain(doms[0][0]) : NO_DOMAIN;
      if (!doms.length) noDomain = true;
    }
    const size = apiCardSize(a.operations, a.schemas);
    const domains = Object.keys(a.domains ?? {})
      .map((d) => domainName.get(d))
      .filter(Boolean) as string[];
    node(id.api(a.id), 'api', a.name, parent, {
      status: a.status === 'DEPRECATED' ? 'deprecated' : a.status === 'PENDING' ? 'planned' : 'active',
      w: size.w,
      h: size.h,
      summary: [a.operations && plural(a.operations, 'operation', 'operations'), a.schemas && plural(a.schemas, 'schema', 'schemas')].filter(Boolean).join(' · '),
      detail: [a.version && `v${a.version.replace(/^v/, '')}`, a.status !== 'ACTIVE' && a.status.toLowerCase(), a.calls30d > 0 && `${compact(a.calls30d)} calls/30d`, a.sample && 'sample']
        .filter(Boolean)
        .join(' · '),
      tags: domains,
      lazy: a.operations + a.schemas ? { operations: a.operations, schemas: a.schemas, specVersion: a.specVersion } : undefined,
      fields: [
        ['id', a.id],
        ['type', 'api'],
        ['team', teamName.get(a.team) ?? a.team],
        ...(a.service ? ([['service', serviceName.get(a.service) ?? a.service]] as Array<[string, string]>) : []),
        ...(a.version ? ([['version', a.version]] as Array<[string, string]>) : []),
        ...field('spec version', a.specVersion),
        ['status', a.status],
        ...(a.source ? ([['source', a.source]] as Array<[string, string]>) : []),
        ['operations', String(a.operations)],
        ['schemas', String(a.schemas)],
        ['calls (30d)', a.calls30d.toLocaleString('en')],
        ...(domains.length ? ([['domains', domains.join(', ')]] as Array<[string, string]>) : []),
        ...(a.updatedAt ? ([['updated', a.updatedAt.slice(0, 10)]] as Array<[string, string]>) : []),
      ],
    });
  }
  if (noDomain) node(NO_DOMAIN, 'band', 'No domain', null);

  for (const n of nodes.values()) if (n.parent) nodes.get(n.parent)!.children.push(n.id);
  const rank: Partial<Record<NodeType, number>> = { band: 0, team: 1, domain: 1, service: 2, api: 3 };
  for (const n of nodes.values()) {
    n.children.sort((a, b) => {
      const na = nodes.get(a)!;
      const nb = nodes.get(b)!;
      return (rank[na.type] ?? 9) - (rank[nb.type] ?? 9) || na.name.localeCompare(nb.name) || a.localeCompare(b);
    });
  }
  // Root of each card, for colouring; and child counts for closed containers.
  for (const n of nodes.values()) {
    let r: BoardNode = n;
    while (r.parent) r = nodes.get(r.parent)!;
    n.dept = r.id;
  }
  for (const n of nodes.values()) {
    if (!n.children.length) continue;
    const count = new Map<NodeType, number>();
    const walk = (x: string) => {
      for (const c of nodes.get(x)!.children) {
        const t = nodes.get(c)!.type;
        count.set(t, (count.get(t) ?? 0) + 1);
        walk(c);
      }
    };
    walk(n.id);
    const names: Partial<Record<NodeType, [string, string]>> = { team: ['team', 'teams'], service: ['service', 'services'], api: ['API', 'APIs'] };
    n.summary = (['team', 'service', 'api'] as NodeType[])
      .filter((t) => count.get(t))
      .map((t) => plural(count.get(t)!, names[t]![0], names[t]![1]))
      .join(' · ');
  }

  // Grants are the connections: consumer (team or service) → API.
  const edges: BoardEdge[] = [];
  for (const g of snap.grants) {
    if (g.status === 'REJECTED') continue;
    const from = g.consumerKind === 'SERVICE' ? id.service(g.consumer) : id.team(g.consumer);
    const to = id.api(g.api);
    if (!nodes.has(from) || !nodes.has(to)) continue;
    edges.push({ id: `g:${from}->${to}`, from, to, kind: g.status === 'PENDING' ? 'requests' : 'calls' });
  }
  edges.sort((a, b) => a.id.localeCompare(b.id));
  return { nodes, edges, levels: HIERARCHIES[hierarchy].levels };
}

/**
 * Adds an API's operations and schemas once its details arrive. They are placed inside the
 * API card's reserved box. Operation-scoped grants are refined from consumer → API to
 * consumer → operation; operations link to the schemas they use; schemas link to the
 * schemas they reference and to identical schemas in other loaded APIs.
 */
export function expandApi(
  api: BoardNode,
  d: ApiDetails,
  ctx: { nodes: Map<string, BoardNode>; edges: BoardEdge[]; hashes: Map<string, string[]>; domainName?: Map<string, string> },
): { nodes: BoardNode[]; add: BoardEdge[]; remove: Set<string> } {
  // Cells are worked out in the card's own units, then shrunk with it (see BoardNode.s).
  const sc = api.s ?? 1;
  const cells = apiCells({ w: api.w / sc, h: api.h / sc }, { operations: d.operations.length, schemas: d.schemas.length });
  const r4 = (v: number) => Math.round(v * 1e4) / 1e4;
  const out: BoardNode[] = [];
  const level = (api.level ?? 2) + 1;
  const base = (nid: string, type: NodeType, name: string, c: { x: number; y: number; w: number; h: number }, extra: Partial<BoardNode>): BoardNode => ({
    id: nid,
    type,
    name,
    parent: api.id,
    level,
    status: 'active',
    x: r4(api.x + c.x * sc),
    y: r4(api.y + c.y * sc),
    w: r4(c.w * sc),
    h: r4(c.h * sc),
    s: r4((c.w / (type === 'operation' ? API_GRID.op.w : API_GRID.schema.w)) * sc),
    children: [],
    dept: api.dept,
    summary: '',
    detail: '',
    flags: [],
    tags: [],
    uses: [],
    fields: [],
    ...extra,
  });

  // Keep the API's order: operations by path then method, schemas by name.
  const ops = d.operations.map((o, i) => ({ o, i })).sort((a, b) => a.o.path.localeCompare(b.o.path) || a.o.method.localeCompare(b.o.method));
  const schemas = d.schemas.map((s, i) => ({ s, i })).sort((a, b) => a.s.name.localeCompare(b.s.name));
  const opId = (i: number) => `${api.id}/op/${i}`;
  const schemaId = (i: number) => `${api.id}/schema/${d.schemas[i].name}`;
  const deprecated = api.status === 'deprecated';

  ops.forEach(({ o: { method, path, operationId }, i }, k) => {
    out.push(
      base(opId(i), 'operation', path, cells.operations[k], {
        detail: method,
        status: deprecated ? 'deprecated' : 'active',
        fields: [['method', method], ['path', path], ...field('operationId', operationId), ['api', api.name]],
      }),
    );
  });
  schemas.forEach(({ s: { name, structuralHash: hash, propertyCount: props, domain: domainId }, i }, k) => {
    const domain = domainId ? (ctx.domainName?.get(domainId) ?? domainId) : null;
    out.push(
      base(schemaId(i), 'schema', name, cells.schemas[k], {
        tags: domain ? [domain] : [],
        fields: [
          ['schema', name],
          ['properties', String(props)],
          ['structural hash', hash.slice(0, 12)],
          ['api', api.name],
          ...(domain ? ([['domain', domain]] as Array<[string, string]>) : []),
        ],
      }),
    );
  });

  const add: BoardEdge[] = [];
  const remove = new Set<string>();
  for (const g of d.grantOperations ?? []) {
    const from = g.consumerKind === 'SERVICE' ? id.service(g.consumer) : id.team(g.consumer);
    const grant = ctx.edges.find((e) => e.id === `g:${from}->${api.id}`);
    if (!grant || !g.operations.length) continue;
    remove.add(grant.id);
    for (const i of g.operations) {
      if (!d.operations[i]) continue;
      add.push({ id: `g:${from}->${opId(i)}`, from, to: opId(i), kind: grant.kind });
    }
  }
  for (const [o, s] of d.carries ?? []) {
    if (d.operations[o] && d.schemas[s]) add.push({ id: `u:${opId(o)}->${schemaId(s)}`, from: opId(o), to: schemaId(s), kind: 'uses' });
  }
  for (const [a, b] of d.references ?? []) {
    if (d.schemas[a] && d.schemas[b] && a !== b) add.push({ id: `r:${schemaId(a)}->${schemaId(b)}`, from: schemaId(a), to: schemaId(b), kind: 'references' });
  }
  // Identical schemas across loaded APIs, matched by structural hash.
  d.schemas.forEach(({ structuralHash: hash }, i) => {
    const mine = schemaId(i);
    for (const other of ctx.hashes.get(hash) ?? []) {
      if (other.startsWith(`${api.id}/`)) continue;
      const [a, b] = [mine, other].sort();
      add.push({ id: `w:${a}|${b}`, from: a, to: b, kind: 'twin' });
    }
    ctx.hashes.set(hash, [...(ctx.hashes.get(hash) ?? []), mine]);
  });
  return { nodes: out, add, remove };
}

export { compact };
