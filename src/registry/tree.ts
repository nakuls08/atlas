import type { BoardEdge, BoardNode, NodeFlag, NodeType } from '../model';
import { API_GROUP_THRESHOLD, LEVEL, connectionKind } from './rules';
import type { Entry, Registry } from './types';

export const UNASSIGNED = '__unassigned';
export const EXTERNAL = '__external';

const TYPE_ORDER: Record<NodeType, number> = {
  band: 9,
  department: 0,
  domain: 1,
  external: 1,
  system: 2,
  service: 3,
  apigroup: 4,
  topic: 5,
  channel: 5,
  api: 6,
  datastore: 7,
  team: 0,
  operation: 6,
  schema: 7,
};

const PLURAL: Partial<Record<NodeType, [string, string]>> = {
  domain: ['domain', 'domains'],
  system: ['system', 'systems'],
  service: ['service', 'services'],
  api: ['API', 'APIs'],
  topic: ['topic', 'topics'],
  channel: ['channel', 'channels'],
  datastore: ['datastore', 'datastores'],
  external: ['external', 'externals'],
};

const PANEL_FIELDS_SKIP = new Set(['id', 'name']);

/** The parent rule from the Types table. Assumes a registry that passed validation. */
export function parentOf(e: Entry, reg: Registry): string | null {
  const f = e.fields;
  switch (e.type) {
    case 'department':
    case 'cluster':
      return null;
    case 'domain':
      return typeof f.department === 'string' ? f.department : UNASSIGNED;
    case 'system':
      return e.domain!;
    case 'service':
      return typeof f.system === 'string' ? f.system : e.domain!;
    case 'api':
      return f.hostedBy as string;
    case 'datastore':
      return f.ownedBy as string;
    case 'topic':
    case 'channel': {
      const owner = reg.entries.get(f.ownedBy as string);
      return owner ? parentOf(owner, reg) : e.domain!;
    }
    case 'external':
      return EXTERNAL;
  }
}

function detailOf(e: Entry): string {
  const f = e.fields;
  const parts: unknown[] = [];
  switch (e.type) {
    case 'api':
      parts.push(f.style, f.audience, f.version);
      break;
    case 'topic':
      parts.push(f.cluster);
      break;
    case 'channel':
    case 'datastore':
      parts.push(f.technology);
      break;
    case 'service':
      parts.push(f.owningTeam, f.runtime);
      break;
    case 'external':
      parts.push(f.kind, f.ownerTeam);
      break;
    case 'domain':
      parts.push(f.owningTeam);
      break;
  }
  if (e.status !== 'active') parts.push(e.status);
  return parts.filter((p) => p !== undefined && p !== null && p !== '').join(' · ');
}

function panelFields(e: Entry): Array<[string, string]> {
  const out: Array<[string, string]> = [['id', e.id], ['type', e.type]];
  for (const k of Object.keys(e.fields).sort()) {
    if (PANEL_FIELDS_SKIP.has(k)) continue;
    const v = e.fields[k];
    if (v === undefined || v === null) continue;
    out.push([k, Array.isArray(v) ? v.join(', ') : typeof v === 'object' ? JSON.stringify(v) : String(v)]);
  }
  return out;
}

const tagsOf = (e: Entry): string[] => (Array.isArray(e.fields.tags) ? (e.fields.tags as string[]) : []);

/** Builds the containment tree (no geometry yet) and leaf edges. Output order is deterministic. */
export function buildTree(reg: Registry): { nodes: Map<string, BoardNode>; edges: BoardEdge[] } {
  const nodes = new Map<string, BoardNode>();
  const blank = (id: string, type: NodeType, name: string, parent: string | null): BoardNode => ({
    id,
    type,
    name,
    parent,
    level: LEVEL[type],
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
  });

  const sorted = [...reg.entries.values()].filter((e) => e.type !== 'cluster').sort((a, b) => a.id.localeCompare(b.id));
  for (const e of sorted) {
    const n = blank(e.id, e.type as NodeType, e.name, parentOf(e, reg));
    n.status = e.status;
    n.detail = detailOf(e);
    n.fields = panelFields(e);
    n.tags = tagsOf(e);
    n.file = e.file;
    if (e.fields.role === 'platform') n.flags.push('platform');
    if (e.fields.ownership === 'disputed') n.flags.push('disputed');
    nodes.set(e.id, n);
  }
  if (sorted.some((e) => nodes.get(e.id)!.parent === UNASSIGNED)) {
    nodes.set(UNASSIGNED, blank(UNASSIGNED, 'band', 'Unassigned', null));
  }
  if (sorted.some((e) => e.type === 'external')) {
    nodes.set(EXTERNAL, blank(EXTERNAL, 'band', 'External', null));
  }

  // Busy hosts group their APIs by first tag ("Orders · 12 APIs"); the group opens like any container.
  const apisByHost = new Map<string, BoardNode[]>();
  for (const n of nodes.values()) {
    if (n.type !== 'api' || !n.parent) continue;
    if (!apisByHost.has(n.parent)) apisByHost.set(n.parent, []);
    apisByHost.get(n.parent)!.push(n);
  }
  for (const [host, apis] of apisByHost) {
    if (apis.length <= API_GROUP_THRESHOLD) continue;
    for (const api of apis) {
      const tag = api.tags[0] ?? 'other';
      const gid = `${host}#${tag}`;
      if (!nodes.has(gid)) nodes.set(gid, blank(gid, 'apigroup', tag[0].toUpperCase() + tag.slice(1), host));
      api.parent = gid;
    }
  }

  for (const n of nodes.values()) {
    if (n.parent) nodes.get(n.parent)?.children.push(n.id);
  }
  const order = (a: string, b: string) => {
    const na = nodes.get(a)!;
    const nb = nodes.get(b)!;
    return TYPE_ORDER[na.type] - TYPE_ORDER[nb.type] || a.localeCompare(b);
  };
  for (const n of nodes.values()) n.children.sort(order);

  // Department of every card, for colouring.
  const deptOf = (n: BoardNode): string | null => {
    let cur: BoardNode | undefined = n;
    while (cur?.parent) cur = nodes.get(cur.parent);
    return cur?.id ?? null;
  };
  for (const n of nodes.values()) n.dept = deptOf(n);

  // Child summary counts every descendant by type, outermost types first.
  const countInto = (id: string, acc: Map<NodeType, number>) => {
    for (const c of nodes.get(id)!.children) {
      const t = nodes.get(c)!.type;
      if (PLURAL[t]) acc.set(t, (acc.get(t) ?? 0) + 1);
      countInto(c, acc);
    }
  };
  for (const n of nodes.values()) {
    if (!n.children.length) continue;
    const acc = new Map<NodeType, number>();
    countInto(n.id, acc);
    n.summary = [...acc.entries()]
      .sort((a, b) => TYPE_ORDER[a[0]] - TYPE_ORDER[b[0]])
      .map(([t, c]) => `${c} ${PLURAL[t]![c === 1 ? 0 : 1]}`)
      .join(' · ');
  }

  // The service an API or datastore belongs to, through any API group.
  const hostService = (id: string): BoardNode | undefined => {
    let n = nodes.get(id);
    while (n && n.type !== 'service') n = n.parent ? nodes.get(n.parent) : undefined;
    return n;
  };

  const edges: BoardEdge[] = [];
  const flag = (n: BoardNode | undefined, f: NodeFlag) => n && !n.flags.includes(f) && n.flags.push(f);
  for (const c of reg.connections) {
    const from = reg.entries.get(c.from);
    const to = reg.entries.get(c.to);
    if (!from || !to) continue;
    const kind = connectionKind(from.type, to.type);
    if (!kind) continue;
    const target = to.type === 'api' || to.type === 'service' ? hostService(to.id) : undefined;
    const platform = !!target?.flags.includes('platform') && target.id !== hostService(from.id)?.id;
    edges.push({ id: `${c.from}->${c.to}`, from: c.from, to: c.to, kind, ...(c.gap ? { gap: c.gap } : {}), ...(platform ? { platform } : {}) });

    if (platform) {
      const caller = nodes.get(c.from)!;
      if (!caller.uses.includes(target!.name)) caller.uses.push(target!.name);
    }
    if (to.type === 'datastore') flag(nodes.get(to.id), 'shared');
    if (to.type === 'api' && to.status === 'deprecated') flag(nodes.get(c.from), 'migrate');
  }
  for (const e of reg.entries.values()) {
    if (e.type === 'api' && typeof e.fields.supersedes === 'string') flag(nodes.get(e.fields.supersedes), 'superseded');
  }
  for (const n of nodes.values()) n.uses.sort();
  edges.sort((a, b) => a.id.localeCompare(b.id));
  return { nodes, edges };
}
