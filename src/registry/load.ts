import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';
import { parse } from 'yaml';
import type { Connection, Entry, EntryType, Issue, Registry, Status, Tour } from './types';

type Raw = Record<string, unknown>;

const DOMAIN_SECTIONS: Array<[string, EntryType]> = [
  ['systems', 'system'],
  ['services', 'service'],
  ['apis', 'api'],
  ['topics', 'topic'],
  ['datastores', 'datastore'],
  ['channels', 'channel'],
];

/** Loads `<root>/registry/**`. Never throws on content problems; they are reported as issues. */
export function loadRegistry(root: string): Registry {
  const dir = join(root, 'registry');
  if (!existsSync(dir)) throw new Error(`No registry/ directory under ${root}`);

  const entries = new Map<string, Entry>();
  const connections: Connection[] = [];
  const tours: Tour[] = [];
  const loadIssues: Issue[] = [];
  const rel = (p: string) => relative(root, p);

  const add = (raw: unknown, type: EntryType, file: string, domain?: string) => {
    if (!raw || typeof raw !== 'object') {
      loadIssues.push({ file, message: `Malformed ${type} entry` });
      return;
    }
    const r = raw as Raw;
    const id = typeof r.id === 'string' ? r.id : '';
    if (!id) {
      loadIssues.push({ file, message: `A ${type} entry has no id` });
      return;
    }
    if (entries.has(id)) {
      loadIssues.push({ file, id, message: `Duplicate id (also in ${entries.get(id)!.file})` });
      return;
    }
    entries.set(id, {
      id,
      type,
      name: typeof r.name === 'string' ? r.name : '',
      status: (r.status as Status) ?? 'active',
      domain,
      file,
      fields: r,
    });
  };

  const readYaml = (path: string): Raw | undefined => {
    try {
      return (parse(readFileSync(path, 'utf8')) ?? {}) as Raw;
    } catch (e) {
      loadIssues.push({ file: rel(path), message: `YAML parse error: ${(e as Error).message}` });
      return undefined;
    }
  };

  const listOf = (doc: Raw | undefined, key: string): unknown[] => {
    const v = doc?.[key];
    return Array.isArray(v) ? v : [];
  };

  for (const [fileName, key, type] of [
    ['departments.yaml', 'departments', 'department'],
    ['clusters.yaml', 'clusters', 'cluster'],
    ['externals.yaml', 'externals', 'external'],
  ] as const) {
    const path = join(dir, fileName);
    if (!existsSync(path)) continue;
    const doc = readYaml(path);
    for (const raw of listOf(doc, key)) add(raw, type, rel(path));
    for (const c of listOf(doc, 'connections')) addConnection(c, rel(path));
  }

  const domainsDir = join(dir, 'domains');
  const domainFiles = existsSync(domainsDir)
    ? readdirSync(domainsDir).filter((f) => f.endsWith('.yaml') || f.endsWith('.yml')).sort()
    : [];

  for (const f of domainFiles) {
    const path = join(domainsDir, f);
    const file = rel(path);
    const doc = readYaml(path);
    if (!doc) continue;
    const domain = doc.domain as Raw | undefined;
    if (!domain || typeof domain.id !== 'string') {
      loadIssues.push({ file, message: 'Domain file has no `domain:` block with an id' });
      continue;
    }
    add(domain, 'domain', file, domain.id);
    for (const [key, type] of DOMAIN_SECTIONS) {
      for (const raw of listOf(doc, key)) add(raw, type, file, domain.id);
    }
    for (const c of listOf(doc, 'connections')) addConnection(c, file);
  }

  function addConnection(raw: unknown, file: string) {
    const r = raw as Raw | undefined;
    if (!r || typeof r.from !== 'string' || typeof r.to !== 'string') {
      loadIssues.push({ file, message: 'A connection needs string `from` and `to`' });
      return;
    }
    connections.push({ from: r.from, to: r.to, gap: typeof r.gap === 'string' ? r.gap : undefined, file });
  }

  const toursPath = join(dir, 'tours.yaml');
  if (existsSync(toursPath)) {
    const doc = readYaml(toursPath);
    for (const raw of listOf(doc, 'tours')) {
      const t = raw as Raw;
      if (typeof t?.id !== 'string' || !Array.isArray(t.steps)) {
        loadIssues.push({ file: rel(toursPath), message: 'A tour needs an `id` and a list of `steps`' });
        continue;
      }
      tours.push({
        id: t.id,
        name: typeof t.name === 'string' ? t.name : t.id,
        ...(typeof t.description === 'string' ? { description: t.description } : {}),
        steps: t.steps as Tour['steps'],
        file: rel(toursPath),
      });
    }
  }

  return { entries, connections, tours, loadIssues };
}
