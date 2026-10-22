import type { Usage, UsageLayer } from '../enrich/usage';
import type { ApiDetails, GraphSnapshot, SnapshotApi } from '../spec0/types';

/**
 * The org graph as the board sees it: groups (teams, or domains), the services and APIs inside
 * them, and the grants between consumers and APIs. Built from a snapshot in the browser; API
 * details (operations, schemas) are merged in as they load.
 *
 *   by team    team → service → API   (APIs with no exposing service sit in their team)
 *   by domain  domain → API           (an API goes to the domain holding most of its schemas;
 *                                      teams and services are consumers off the board)
 */

export type Hierarchy = 'team' | 'domain';
export type CardKind = 'group' | 'service' | 'api';

export interface Card {
  id: string;
  kind: CardKind;
  name: string;
  parent: string | null;
  children: string[];
  /** Team id for teams; the owning team for services and APIs. */
  team: string | null;
  /** Groups: "team-payments", a domain slug. */
  slug?: string;
  members?: number;
  api?: SnapshotApi;
  /** API card ids in this card's subtree, in board order. */
  apis: string[];
  services: number;
  /**
   * Calls in the usage window, summed over the subtree's APIs that have usage data; null when
   * none has (or no usage plugin is loaded). Set by `applyUsage`, never from the snapshot.
   */
  traffic: number | null;
  /** APIs: the rest of their usage, when the source has it. */
  usage?: Usage & { report: number };
  /** How many of the subtree's APIs have usage data. */
  measured: number;
  /** Grants awaiting approval on APIs in the subtree. */
  pending: number;
}

/** A consumer's access to an API. Rejected grants are not part of the graph. */
export interface Grant {
  key: string;
  /** Consumer: a team or service id from the snapshot (not a card id; it may have no card). */
  consumer: string;
  consumerKind: 'TEAM' | 'SERVICE';
  /** API card id. */
  api: string;
  status: 'APPROVED' | 'PENDING';
  scoped: boolean;
}

export interface OrgGraph {
  hierarchy: Hierarchy;
  org: { id: string; name: string };
  version: string;
  cards: Map<string, Card>;
  roots: string[];
  grants: Grant[];
  /** Card that stands for a consumer on this board, if any (a service, else its team). */
  consumerCard(g: Pick<Grant, 'consumer' | 'consumerKind'>): string | null;
  consumerName(g: Pick<Grant, 'consumer' | 'consumerKind'>): string;
  /** Owning team id of a consumer. */
  consumerTeam(g: Pick<Grant, 'consumer' | 'consumerKind'>): string | null;
  teamName(id: string | null): string;
  domainName(id: string): string;
  totals: { teams: number; services: number; apis: number; grants: number; pending: number };
  /** Where traffic came from, once `applyUsage` has run with something. */
  usage: UsageLayer | null;
}

export const cardId = {
  team: (x: string) => `t:${x}`,
  service: (x: string) => `s:${x}`,
  api: (x: string) => `a:${x}`,
  domain: (x: string) => `d:${x}`,
};
const NO_TEAM = '__noteam';
const NO_DOMAIN = '__nodomain';

const byName = <T extends { name: string; id: string }>(a: T, b: T) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id);

export function buildGraph(snap: GraphSnapshot, hierarchy: Hierarchy): OrgGraph {
  const cards = new Map<string, Card>();
  const add = (id: string, kind: CardKind, name: string, parent: string | null, extra: Partial<Card> = {}) => {
    const c: Card = { id, kind, name, parent, children: [], team: null, apis: [], services: 0, traffic: null, measured: 0, pending: 0, ...extra };
    cards.set(id, c);
    if (parent) cards.get(parent)!.children.push(id);
    return c;
  };
  const teamName = new Map(snap.teams.map((t) => [t.id, t.name]));
  const services = new Map(snap.services.map((s) => [s.id, s]));
  const domainName = new Map(snap.domains.map((d) => [d.id, d.name]));

  if (hierarchy === 'team') {
    for (const t of [...snap.teams].sort(byName)) add(cardId.team(t.id), 'group', t.name, null, { team: t.id, slug: t.id, members: t.members });
    const orphanServices = snap.services.some((s) => !s.team || !teamName.has(s.team));
    const orphanApis = snap.apis.some((a) => !teamName.has(a.team) && !(a.service && services.has(a.service)));
    if (orphanServices || orphanApis) add(NO_TEAM, 'group', 'No owning team', null);
    for (const s of [...snap.services].sort(byName)) {
      const team = s.team && teamName.has(s.team) ? s.team : null;
      add(cardId.service(s.id), 'service', s.name, team ? cardId.team(team) : NO_TEAM, { team });
    }
    for (const a of [...snap.apis].sort(byName)) {
      const parent = a.service && services.has(a.service) ? cardId.service(a.service) : teamName.has(a.team) ? cardId.team(a.team) : NO_TEAM;
      add(cardId.api(a.id), 'api', a.name, parent, { team: a.team, api: a });
    }
  } else {
    for (const d of [...snap.domains].sort(byName)) add(cardId.domain(d.id), 'group', d.name, null, { slug: d.slug });
    let none = false;
    const placed: Array<[SnapshotApi, string]> = [];
    for (const a of [...snap.apis].sort(byName)) {
      const doms = Object.entries(a.domains ?? {}).filter(([d]) => domainName.has(d));
      doms.sort((x, y) => y[1] - x[1] || x[0].localeCompare(y[0]));
      if (!doms.length) none = true;
      placed.push([a, doms.length ? cardId.domain(doms[0][0]) : NO_DOMAIN]);
    }
    if (none) add(NO_DOMAIN, 'group', 'No domain', null);
    for (const [a, parent] of placed) add(cardId.api(a.id), 'api', a.name, parent, { team: a.team, api: a });
  }

  // Groups with nothing in them would be empty tiles; drop them.
  for (const c of [...cards.values()]) if (c.kind === 'group' && !c.children.length && c.parent === null && hierarchy === 'domain') cards.delete(c.id);

  const grants: Grant[] = [];
  for (const g of snap.grants) {
    if (g.status === 'REJECTED' || !cards.has(cardId.api(g.api))) continue;
    grants.push({
      key: `${g.consumerKind}:${g.consumer}->${g.api}`,
      consumer: g.consumer,
      consumerKind: g.consumerKind,
      api: cardId.api(g.api),
      status: g.status,
      scoped: g.operationScoped,
    });
  }
  grants.sort((a, b) => a.key.localeCompare(b.key));

  // Roll-ups, children first.
  const roots = [...cards.values()].filter((c) => !c.parent).map((c) => c.id);
  const pendingByApi = new Map<string, number>();
  for (const g of grants) if (g.status === 'PENDING') pendingByApi.set(g.api, (pendingByApi.get(g.api) ?? 0) + 1);
  const roll = (id: string) => {
    const c = cards.get(id)!;
    if (c.kind === 'api') {
      c.apis = [id];
      c.pending = pendingByApi.get(id) ?? 0;
      return;
    }
    for (const k of c.children) {
      roll(k);
      const kid = cards.get(k)!;
      c.apis.push(...kid.apis);
      c.pending += kid.pending;
      c.services += kid.kind === 'service' ? 1 : kid.services;
    }
  };
  roots.forEach(roll);

  const consumerTeam = (g: Pick<Grant, 'consumer' | 'consumerKind'>) => (g.consumerKind === 'TEAM' ? g.consumer : (services.get(g.consumer)?.team ?? null));
  return {
    hierarchy,
    org: snap.org,
    version: snap.version,
    cards,
    roots,
    grants,
    consumerCard(g) {
      if (hierarchy !== 'team') return null;
      if (g.consumerKind === 'SERVICE' && cards.has(cardId.service(g.consumer))) return cardId.service(g.consumer);
      const t = consumerTeam(g);
      return t && cards.has(cardId.team(t)) ? cardId.team(t) : null;
    },
    consumerName: (g) => (g.consumerKind === 'TEAM' ? (teamName.get(g.consumer) ?? g.consumer) : (services.get(g.consumer)?.name ?? g.consumer)),
    consumerTeam,
    teamName: (id) => (id ? (teamName.get(id) ?? id) : 'No owning team'),
    domainName: (id) => domainName.get(id) ?? id,
    totals: {
      teams: snap.teams.length,
      services: snap.services.length,
      apis: snap.apis.length,
      grants: grants.length,
      pending: grants.filter((g) => g.status === 'PENDING').length,
    },
    usage: null,
  };
}

/**
 * Puts a usage layer on the graph: each API's numbers from its plugin, and sums for every card
 * above it. Replaces whatever layer was there.
 */
export function applyUsage(graph: OrgGraph, layer: UsageLayer | null): void {
  graph.usage = layer;
  const roll = (id: string): void => {
    const c = graph.cards.get(id)!;
    if (c.kind === 'api') {
      const u = layer?.apis.get(c.api!.id);
      c.usage = u;
      c.traffic = u ? u.calls : null;
      c.measured = u ? 1 : 0;
      return;
    }
    c.traffic = null;
    c.measured = 0;
    for (const k of c.children) {
      roll(k);
      const kid = graph.cards.get(k)!;
      if (kid.traffic !== null) c.traffic = (c.traffic ?? 0) + kid.traffic;
      c.measured += kid.measured;
    }
  };
  graph.roots.forEach(roll);
}

/** Is `id` the card `root` or inside it? */
export function within(graph: OrgGraph, id: string | null, root: string): boolean {
  for (let cur = id; cur; cur = graph.cards.get(cur)?.parent ?? null) if (cur === root) return true;
  return false;
}

export function ancestors(graph: OrgGraph, id: string): string[] {
  const out: string[] = [];
  for (let cur: string | null = id; cur; cur = graph.cards.get(cur)?.parent ?? null) out.push(cur);
  return out;
}

export type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'OTHER';
export const METHODS: Method[] = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OTHER'];

/** How many operations use each method: a read API and a write API look different at a glance. */
export function methodMix(d: ApiDetails): Array<[Method, number]> {
  const n = new Map<Method, number>();
  for (const o of d.operations) {
    const m = (METHODS as string[]).includes(o.method.toUpperCase()) ? (o.method.toUpperCase() as Method) : 'OTHER';
    n.set(m, (n.get(m) ?? 0) + 1);
  }
  return METHODS.filter((m) => n.get(m)).map((m) => [m, n.get(m)!]);
}

/**
 * Who calls a card and what it calls: grants with exactly one end inside it. Ends are the card
 * that stands for the consumer on the board (or null when there is none, as in the domain view).
 */
export function connections(graph: OrgGraph, id: string): { callers: Grant[]; calls: Grant[]; inside: Grant[] } {
  const callers: Grant[] = [];
  const calls: Grant[] = [];
  const inside: Grant[] = [];
  for (const g of graph.grants) {
    const apiIn = within(graph, g.api, id);
    const consumerIn = within(graph, graph.consumerCard(g), id);
    if (apiIn && consumerIn) inside.push(g);
    else if (apiIn) callers.push(g);
    else if (consumerIn) calls.push(g);
  }
  return { callers, calls, inside };
}

/** Top-level card a grant end belongs to, or a stable key for consumers with no card. */
export function groupOf(graph: OrgGraph, card: string | null, fallback: string): string {
  if (!card) return `ext:${fallback}`;
  const chain = ancestors(graph, card);
  return chain[chain.length - 1];
}

/**
 * Everything that depends on `id`: consumers of its APIs, then consumers of theirs, and so on.
 * Returns card ids (top-level cards for consumers without a card are skipped).
 */
export function dependents(graph: OrgGraph, id: string): Set<string> {
  const out = new Set<string>();
  const queue = [id];
  while (queue.length) {
    const cur = queue.shift()!;
    for (const g of graph.grants) {
      if (g.status !== 'APPROVED' || !within(graph, g.api, cur)) continue;
      const c = graph.consumerCard(g);
      if (!c || out.has(c) || within(graph, c, id)) continue;
      out.add(c);
      queue.push(c);
    }
  }
  return out;
}

/**
 * Shortest chain of calls from card `from` to card `to`: each step is a grant whose consumer is
 * inside the current card and whose API is the next stop (then that API's owner calls on).
 * Returns the cards along the way, or null.
 */
export function tracePath(graph: OrgGraph, from: string, to: string): { cards: string[]; grants: Grant[] } | null {
  // Nodes are top-level groups or services/APIs: step from a card to the APIs its subtree calls.
  const owner = (api: string) => {
    const c = graph.cards.get(api)!;
    return c.parent ?? api;
  };
  const prev = new Map<string, { from: string; grant: Grant }>();
  const seen = new Set([from]);
  const queue = [from];
  while (queue.length) {
    const cur = queue.shift()!;
    if (within(graph, cur, to) || within(graph, to, cur)) {
      if (cur === from && from !== to) {
        /* keep searching for an actual step */
      } else {
        const cards: string[] = [cur];
        const grants: Grant[] = [];
        for (let c = cur; prev.has(c); c = prev.get(c)!.from) {
          grants.unshift(prev.get(c)!.grant);
          cards.unshift(prev.get(c)!.from);
        }
        return { cards, grants };
      }
    }
    for (const g of graph.grants) {
      // A team's grants cover its services too.
      const c = graph.consumerCard(g);
      if (g.status !== 'APPROVED' || !(within(graph, c, cur) || within(graph, cur, c ?? ''))) continue;
      const next = within(graph, g.api, to) ? to : owner(g.api);
      if (seen.has(next)) continue;
      seen.add(next);
      prev.set(next, { from: cur, grant: g });
      queue.push(next);
    }
  }
  return null;
}

export const compact = (n: number) => (n >= 1e6 ? `${+(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)}M` : n >= 1e3 ? `${+(n / 1e3).toFixed(n >= 1e4 ? 0 : 1)}k` : String(n));
