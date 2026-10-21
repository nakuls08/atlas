/**
 * Writes a fixture in the graph format (GET /graph/snapshot and /graph/details, see
 * docs/graph-api.md), derived from the e-commerce example:
 *
 *   examples/spec0/snapshot.json                 teams, services, domains, APIs, grants
 *   examples/spec0/snapshot-with-services.json   same, with APIs linked to their exposing service
 *   examples/spec0/details.json                  operations, schemas and links per API
 *
 *   tsx scripts/gen-spec0-fixture.ts
 *
 * Spec0 only knows OpenAPI resources, so topics, channels, datastores and externals are left out.
 * Operations and schemas are generated from each API's name and style; shared shapes (Error,
 * Money, Address, Pagination) get the same structural hash everywhere, as twins do in Spec0.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { loadRegistry } from '../src/registry/load';
import type { Entry } from '../src/registry/types';
import type { ApiDetails, GraphSnapshot, SnapshotApi } from '../src/spec0/types';

let seed = 20261012;
const rand = () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const pick = <T>(xs: readonly T[]) => xs[Math.floor(rand() * xs.length)];
const int = (a: number, b: number) => a + Math.floor(rand() * (b - a + 1));
const hash = (s: string) => createHash('sha256').update(s).digest('hex');
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const pascal = (s: string) => s.replace(/(^|[-\s])(\w)/g, (_, __, c: string) => c.toUpperCase()).replace(/[^A-Za-z0-9]/g, '');

const reg = loadRegistry('examples/ecommerce');
const entries = [...reg.entries.values()];
const of = (t: Entry['type']) => entries.filter((e) => e.type === t).sort((a, b) => a.id.localeCompare(b.id));

// ── teams and services ────────────────────────────────────────────────────────
const teamName = (t: string) =>
  t
    .replace(/^team-/, '')
    .split('-')
    .map((w) => (['wms', 'crm', 'ugc', 'ml', 'sre'].includes(w) ? w.toUpperCase() : w[0].toUpperCase() + w.slice(1)))
    .join(' ');
const services = of('service');
const teamIds = [...new Set(services.map((s) => String(s.fields.owningTeam)))].sort();
const teams = teamIds.map((t) => ({ id: t, name: teamName(t), members: int(3, 16) }));
const serviceId = (e: Entry) => slug(e.name);

// ── schema domains (Spec0 sense: business data concepts) ──────────────────────
const DOMAINS: Array<[string, RegExp]> = [
  ['Order', /order|cart|checkout|return|fulfil/i],
  ['Customer', /customer|profile|address|consent|loyalty|login|preference|audience/i],
  ['Product', /product|catalog|taxonomy|attribute|listing|search|recommend|content|media|review|merchand/i],
  ['Payment', /payment|refund|card|fraud|chargeback|payout|psp|adyen|stripe|paypal|klarna/i],
  ['Fulfilment', /shipment|shipping|label|tracking|carrier|delivery|wms|location|allocation|inventory|availability/i],
  ['Finance', /invoice|ledger|tax|cost|reconcil/i],
  ['Pricing', /price|pricing|promotion|coupon|fx|currency/i],
  ['Common', /^(Money|Address|PhoneNumber)$/],
];
const domains = DOMAINS.map(([name]) => ({ id: `dom-${slug(name)}`, name, slug: slug(name) }));
const domainFor = (schema: string, api: string): string | null => {
  if (/^(Error|Pagination)$/.test(schema)) return null;
  for (const [name, re] of DOMAINS) if (re.test(schema)) return `dom-${slug(name)}`;
  for (const [name, re] of DOMAINS) if (name !== 'Common' && re.test(api)) return `dom-${slug(name)}`;
  return null;
};

// ── APIs, with generated operations and schemas ───────────────────────────────
const SHARED: Record<string, number> = { Error: 4, Money: 3, Address: 7, Pagination: 4 };
const ACTIONS = ['search', 'export', 'history', 'events', 'status', 'bulk', 'summary', 'preview'];
const COMMANDS = ['cancel', 'approve', 'archive', 'retry', 'refresh', 'validate'];
const details: Record<string, ApiDetails> = {};
const snapApis: SnapshotApi[] = [];
const hostOf = (api: Entry) => reg.entries.get(String(api.fields.hostedBy))!;

for (const api of of('api')) {
  const host = hostOf(api);
  const apiId = slug(api.id.replace('/', '-'));
  const style = String(api.fields.style ?? 'REST');
  const resWord = slug(api.name.replace(/\b(api|adapter|v\d+)\b/gi, '')) || 'items';
  const resource = resWord.endsWith('s') ? resWord : `${resWord}s`;
  const Entity = pascal(resWord.replace(/s$/, '')) || 'Item';
  const ops: ApiDetails['operations'] = [];
  const schemaNames: string[] = [];
  const schema = (name: string) => {
    if (!schemaNames.includes(name)) schemaNames.push(name);
    return schemaNames.indexOf(name);
  };
  const carries: number[][] = [];
  const op = (method: string, path: string, opId: string, uses: string[]) => {
    ops.push({ method, path, operationId: opId });
    for (const u of uses) carries.push([ops.length - 1, schema(u)]);
  };
  if (style === 'GraphQL') {
    op('POST', '/graphql', 'query', [Entity, 'Error']);
    if (rand() < 0.6) op('GET', '/graphql', 'persistedQuery', [Entity]);
    for (const extra of ['Connection', 'Edge', 'PageInfo', 'Filter']) schema(`${Entity}${extra}`);
  } else if (style === 'gRPC') {
    const svc = `${resWord.replace(/-/g, '')}.v1.${Entity}Service`;
    for (const m of ['Get', 'List', 'Create', 'Update', 'Evaluate', 'Stream'].slice(0, int(3, 6))) {
      op('POST', `/${svc}/${m}${m === 'List' ? `${Entity}s` : Entity}`, `${m.toLowerCase()}${Entity}`, [`${m}${Entity}Request`, m === 'List' ? `List${Entity}sResponse` : Entity]);
    }
  } else {
    op('GET', `/${resource}`, `list${Entity}s`, [`${Entity}List`, 'Pagination']);
    op('POST', `/${resource}`, `create${Entity}`, [`Create${Entity}Request`, Entity, 'Error']);
    op('GET', `/${resource}/{id}`, `get${Entity}`, [Entity]);
    if (rand() < 0.8) op('PATCH', `/${resource}/{id}`, `update${Entity}`, [`Update${Entity}Request`, Entity, 'Error']);
    if (rand() < 0.5) op('DELETE', `/${resource}/{id}`, `delete${Entity}`, []);
    for (const a of ACTIONS.slice(0, int(0, 4))) op('GET', `/${resource}/${a === 'search' ? 'search' : `{id}/${a}`}`, `${a}${Entity}`, [Entity]);
    for (const c of COMMANDS.slice(0, int(0, 3))) op('POST', `/${resource}/{id}:${c}`, `${c}${Entity}`, [Entity, 'Error']);
  }
  // Domain-specific shared shapes and a couple of local ones.
  if (/order|cart|checkout|payment|refund|invoice|price|ledger|payout|coupon|promotion/i.test(api.name)) schema('Money');
  if (/customer|address|shipping|checkout|order|delivery|returns|label/i.test(api.name)) schema('Address');
  for (const extra of ['LineItem', 'AuditInfo', 'Status', 'Metadata'].slice(0, int(0, 2))) schema(`${Entity}${extra}`);

  // References: the entity uses the shared shapes and its local parts.
  const references: number[][] = [];
  const idx = (n: string) => schemaNames.indexOf(n);
  for (const n of schemaNames) {
    if (n === Entity) for (const r of ['Money', 'Address', `${Entity}LineItem`, `${Entity}Status`, `${Entity}AuditInfo`]) if (idx(r) >= 0) references.push([idx(n), idx(r)]);
    if (n === `${Entity}List` && idx(Entity) >= 0) references.push([idx(n), idx(Entity)]);
  }
  const schemas: ApiDetails['schemas'] = schemaNames.map((n) => {
    const shared = SHARED[n];
    const props = shared ?? int(3, 22);
    return { name: n, structuralHash: hash(shared ? `shared:${n}` : `${apiId}:${n}`), propertyCount: props, domain: domainFor(n, api.name) };
  });

  const nVersions = int(1, 5);
  const major = int(1, 3);
  const versions = Array.from({ length: nVersions }, (_, i) => ({
    tag: `${major}.${nVersions - 1 - i}.${int(0, 9)}`,
    publishedAt: new Date(Date.UTC(2026, 9 - i * 2, int(1, 27))).toISOString(),
    breaking: i > 0 && rand() < 0.25,
  }));
  const domainCounts: Record<string, number> = {};
  for (const s of schemas) if (s.domain) domainCounts[s.domain] = (domainCounts[s.domain] ?? 0) + 1;

  details[apiId] = { id: apiId, specVersion: versions[0].tag, operations: ops, schemas, carries, references, grantOperations: [], versions };
  snapApis.push({
    id: apiId,
    name: slug(api.name),
    version: /v(\d+)/i.exec(api.name)?.[1] ?? String(int(1, 3)),
    specVersion: versions[0].tag,
    team: String(host.fields.owningTeam),
    service: serviceId(host),
    sample: false,
    status: api.status === 'deprecated' ? 'DEPRECATED' : host.status === 'planned' ? 'PENDING' : 'ACTIVE',
    source: pick(['GITHUB', 'GITHUB', 'GITHUB', 'CLI', 'MANUAL_UPLOAD']),
    updatedAt: versions[0].publishedAt,
    operations: ops.length,
    schemas: schemas.length,
    domains: domainCounts,
    calls30d: 0,
  });
}

// ── grants: registry calls from services to APIs ──────────────────────────────
const apiBy = new Map(of('api').map((a) => [a.id, slug(a.id.replace('/', '-'))]));
const grants: GraphSnapshot['grants'] = [];
const seen = new Set<string>();
for (const c of reg.connections) {
  const from = reg.entries.get(c.from);
  const api = apiBy.get(c.to);
  if (!from || from.type !== 'service' || !api) continue;
  // Some grants are held by the calling service's identity, others by its team.
  const consumerKind = rand() < 0.6 ? 'SERVICE' : 'TEAM';
  const consumer = consumerKind === 'SERVICE' ? serviceId(from) : String(from.fields.owningTeam);
  const key = `${consumer}>${api}`;
  if (seen.has(key)) continue;
  seen.add(key);
  const r = rand();
  const status = r < 0.88 ? 'APPROVED' : r < 0.97 ? 'PENDING' : 'REJECTED';
  const operationScoped = rand() < 0.3;
  // Calls are per API (Spec0 has no per-grant rollup); each approved grant adds its traffic.
  if (status === 'APPROVED') snapApis.find((a) => a.id === api)!.calls30d += Math.round(Math.exp(int(70, 140) / 10));
  grants.push({ consumer, consumerKind, api, status, operationScoped });
  if (operationScoped && status !== 'REJECTED') {
    const ops = details[api].operations;
    const chosen = [...new Set(Array.from({ length: int(1, Math.min(3, ops.length)) }, () => int(0, ops.length - 1)))].sort((a, b) => a - b);
    details[api].grantOperations.push({ consumer, consumerKind, operations: chosen });
  }
}

const base: GraphSnapshot = {
  version: '2026-10-12.1',
  generatedAt: '2026-10-12T09:00:00Z',
  org: { id: 'acme', name: 'Acme Commerce' },
  teams,
  services: services.map((s) => ({ id: serviceId(s), name: s.name, team: String(s.fields.owningTeam) })),
  domains,
  apis: snapApis.map((a) => ({ ...a, service: null })),
  grants,
};
const withServices: GraphSnapshot = { ...base, version: '2026-10-12.1+services', apis: snapApis };

const out = join('examples', 'spec0');
mkdirSync(out, { recursive: true });
writeFileSync(join(out, 'snapshot.json'), `${JSON.stringify(base)}\n`);
writeFileSync(join(out, 'snapshot-with-services.json'), `${JSON.stringify(withServices)}\n`);
writeFileSync(join(out, 'details.json'), `${JSON.stringify(details)}\n`);
const opsTotal = Object.values(details).reduce((n, d) => n + d.operations.length, 0);
const schemasTotal = Object.values(details).reduce((n, d) => n + d.schemas.length, 0);
console.log(
  `wrote ${out}: ${teams.length} teams, ${base.services.length} services, ${domains.length} domains, ${snapApis.length} APIs, ` +
    `${grants.length} grants, ${opsTotal} operations, ${schemasTotal} schemas`,
);
