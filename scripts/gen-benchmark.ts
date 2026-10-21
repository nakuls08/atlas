/**
 * Generates the benchmark registry (NFR section): 8 departments, 30 domains, 80 systems,
 * 400 services, 600 APIs, 250 topics, ~3,000 connections, ~40% crossing a department.
 *
 * Connections follow a realistic shape rather than uniform noise: most stay inside a domain,
 * each department talks mainly to two partner departments, a handful of platform services are
 * called by everyone, a few hosts carry many tagged APIs, and one topic has 30 consumers.
 * Fixed seed, so every run writes the same files.
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { stringify } from 'yaml';

const OUT = join(process.argv[2] ?? 'bench', 'registry');

let seed = 20261003;
const rand = () => {
  seed |= 0;
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const pick = <T>(xs: T[]) => xs[Math.floor(rand() * xs.length)];
const spread = (total: number, buckets: number) => {
  const out = Array(buckets).fill(1);
  for (let i = buckets; i < total; i++) out[Math.floor(rand() * buckets)]++;
  return out as number[];
};

const DEPTS = ['logistics', 'finance', 'commerce', 'identity', 'data', 'platform', 'marketing', 'support'];
const NOUNS = ['order', 'returns', 'refund', 'invoice', 'ledger', 'label', 'tracking', 'catalog', 'pricing', 'stock',
  'payment', 'account', 'profile', 'session', 'consent', 'search', 'review', 'promo', 'ticket', 'chat', 'routing',
  'dispatch', 'carrier', 'warehouse', 'tax', 'fraud', 'loyalty', 'cart', 'checkout', 'notify'];
const SUFFIX = ['service', 'worker', 'gateway', 'engine', 'adapter', 'sync', 'manager'];
const API_TAGS = ['orders', 'customers', 'admin', 'reports', 'webhooks'];

rmSync(OUT, { recursive: true, force: true });
mkdirSync(join(OUT, 'domains'), { recursive: true });

writeFileSync(join(OUT, 'departments.yaml'), stringify({ departments: DEPTS.map((d) => ({ id: d, name: d[0].toUpperCase() + d.slice(1) })) }));
writeFileSync(join(OUT, 'clusters.yaml'), stringify({ clusters: DEPTS.map((d) => ({ id: `${d}-kafka`, name: `${d}-kafka` })) }));

const externals = Array.from({ length: 12 }, (_, i) => ({ id: `ext/partner-${i}`, name: `Partner ${i}`, kind: pick(['partner', 'SaaS', 'other org']), ownerTeam: 'team-ext' }));

interface Dom { id: string; dept: string; services: string[]; apis: string[]; topics: string[]; doc: any }
const domains: Dom[] = [];
const domCounts = spread(30, 8);
const sysCounts = spread(80, 30);
const svcCounts = spread(400, 30);
let domainIdx = 0;

DEPTS.forEach((dept, di) => {
  for (let i = 0; i < domCounts[di]; i++, domainIdx++) {
    const id = NOUNS[domainIdx];
    const systems = Array.from({ length: sysCounts[domainIdx] }, (_, s) => ({ id: `${id}/sys-${s}`, name: `${id} system ${s}` }));
    const services = Array.from({ length: svcCounts[domainIdx] }, (_, s) => {
      const name = `${id}-${pick(SUFFIX)}-${s}`;
      const svc: Record<string, unknown> = { id: `${id}/${name}`, name, owningTeam: `team-${id}` };
      if (rand() < 0.7) svc.system = pick(systems).id;
      if (rand() < 0.02) svc.status = 'planned';
      return svc;
    });
    const reviewed = rand() < 0.2 ? '2025-11-01' : '2026-07-01';
    domains.push({
      id,
      dept,
      services: services.map((s) => s.id as string),
      apis: [],
      topics: [],
      doc: { domain: { id, name: id[0].toUpperCase() + id.slice(1), department: dept, owningTeam: `team-${id}`, reviewedAt: reviewed, reviewedBy: 'pe' }, systems, services, apis: [], topics: [], channels: [], datastores: [], connections: [] },
    });
  }
});

// Platform services: called by everyone, shown as badges instead of links.
const platformDomain = domains.find((d) => d.dept === 'platform')!;
const platformApis: string[] = [];
for (const name of ['auth', 'notify', 'feature-flags']) {
  const svc = platformDomain.doc.services.find((s: any) => !s.role && !platformApis.some((a) => a.startsWith(s.id)));
  svc.role = 'platform';
  svc.name = `${name}-service`;
  const api = `${platformDomain.id}/${name}-api`;
  platformDomain.doc.apis.push({ id: api, name: `${name} API`, hostedBy: svc.id, style: 'REST' });
  platformDomain.apis.push(api);
  platformApis.push(api);
}

const allServices = domains.flatMap((d) => d.services.map((s) => ({ s, d })));

// Two busy hosts (a monolith and a BFF) with many tagged APIs, grouped on the board.
const busyHosts = [allServices[7], allServices[211]];
let apiCount = platformApis.length;
for (const { s, d } of busyHosts) {
  for (let i = 0; i < 14; i++, apiCount++) {
    const id = `${d.id}/api-${apiCount}`;
    d.doc.apis.push({ id, name: `${pick(API_TAGS)} API ${apiCount}`, hostedBy: s, style: pick(['REST', 'gRPC']), tags: [API_TAGS[i % API_TAGS.length]] });
    d.apis.push(id);
  }
}
const busy = new Set(busyHosts.map((b) => b.s));
while (apiCount < 600) {
  const { s, d } = allServices[apiCount % allServices.length];
  if (busy.has(s)) {
    apiCount++;
    continue;
  }
  const id = `${d.id}/api-${apiCount}`;
  const api: Record<string, unknown> = { id, name: `${s.split('/')[1]} API ${apiCount}`, hostedBy: s, style: pick(['REST', 'REST', 'gRPC', 'GraphQL']) };
  // Some hosts run two versions side by side.
  if (rand() < 0.04 && d.apis.length) {
    const prev = d.doc.apis[d.doc.apis.length - 1];
    if (prev.hostedBy === s && !prev.status) {
      prev.status = 'deprecated';
      api.supersedes = prev.id;
    }
  }
  d.doc.apis.push(api);
  d.apis.push(id);
  apiCount++;
}
for (let i = 0; i < 250; i++) {
  const { s, d } = pick(allServices);
  const id = `${d.id}/topic-${i}`;
  d.doc.topics.push({ id, name: `${d.id}.event-${i}.v1`, ownedBy: s, cluster: `${d.dept}-kafka` });
  d.topics.push(id);
}
for (let i = 0; i < 20; i++) {
  const { s, d } = pick(allServices);
  d.doc.channels.push({ id: `${d.id}/channel-${i}`, name: `${pick(['SFTP drop', 'webhook', 'SQS queue', 'EDI feed'])} ${i}`, technology: pick(['SFTP', 'HTTP webhook', 'SQS', 'EDI']), ownedBy: s });
}
for (let i = 0; i < 60; i++) {
  const { s, d } = pick(allServices);
  d.doc.datastores.push({ id: `${d.id}/store-${i}`, name: `${d.id}-db-${i}`, technology: pick(['postgres', 'redis', 'dynamodb', 's3']), ownedBy: s });
}
for (let i = 0; i < 6; i++) {
  const svc = pick(pick(domains).doc.services) as any;
  svc.ownership = 'disputed';
  svc.claimant = pick(domains).id;
}

// Each department talks mainly to two partner departments.
const partners = new Map(DEPTS.map((d, i) => [d, [DEPTS[(i + 1) % DEPTS.length], DEPTS[(i + 3) % DEPTS.length]]]));
const seen = new Set<string>();
const connect = (d: Dom, from: string, to: string) => {
  const key = `${from}->${to}`;
  if (seen.has(key) || from === to) return false;
  seen.add(key);
  d.doc.connections.push({ from, to });
  return true;
};

let made = 0;
// One topic with 30 consumers.
const hotTopic = domains[3].topics[0];
for (const { s, d } of allServices.slice(40, 70)) made += +connect(d, hotTopic, s);
// Platform calls.
for (const { s, d } of allServices) if (rand() < 0.35) made += +connect(d, s, pick(platformApis));

while (made < 3000) {
  const src = pick(domains);
  const r0 = rand();
  const target =
    r0 < 0.4 ? src : r0 < 0.6 ? pick(domains.filter((d) => d.dept === src.dept)) : pick(domains.filter((d) => partners.get(src.dept)!.includes(d.dept) || rand() < 0.1));
  const from = pick(src.services);
  const r = rand();
  if (r < 0.65 && target.apis.length) made += +connect(src, from, pick(target.apis));
  else if (r < 0.85 && src.topics.length) made += +connect(src, from, pick(src.topics));
  else if (target.topics.length) made += +connect(src, pick(target.topics), from);
}
// A few unknown-API calls.
for (let i = 0; i < 10; i++) {
  const d = pick(domains);
  const from = pick(d.services);
  const to = pick(pick(domains).services);
  if (from !== to && !seen.has(`${from}->${to}`)) d.doc.connections.push({ from, to, gap: 'legacy, no spec' });
}

for (const d of domains) writeFileSync(join(OUT, 'domains', `${d.id}.yaml`), stringify(d.doc));
writeFileSync(
  join(OUT, 'externals.yaml'),
  stringify({ externals, connections: externals.map((e) => ({ from: e.id, to: pick(domains.filter((d) => d.apis.length)).apis[0] })) }),
);
console.log(`wrote ${OUT}: ${domains.length} domains, ${allServices.length} services, ${apiCount} APIs, ${made} connections`);
