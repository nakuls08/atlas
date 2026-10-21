import type { Connection, Entry, EntryType, Registry } from '../src/registry/types';

export function entry(type: EntryType, id: string, fields: Record<string, unknown> = {}, domain?: string): Entry {
  const all = { id, name: id.split('/').pop(), ...fields };
  return {
    id,
    type,
    name: (all.name as string) ?? '',
    status: (fields.status as Entry['status']) ?? 'active',
    domain: domain ?? (id.includes('/') ? id.split('/')[0] : type === 'domain' ? id : undefined),
    file: `registry/${domain ?? id.split('/')[0]}.yaml`,
    fields: all,
  };
}

export function registry(entries: Entry[], connections: Array<Omit<Connection, 'file'>> = []): Registry {
  return {
    entries: new Map(entries.map((e) => [e.id, e])),
    connections: connections.map((c) => ({ ...c, file: 'registry/domains/x.yaml' })),
    tours: [],
    loadIssues: [],
  };
}

/** A small valid registry with one of every type. */
export function sample(): Entry[] {
  return [
    entry('department', 'logistics'),
    entry('cluster', 'main'),
    entry('domain', 'returns', { owningTeam: 't', department: 'logistics' }),
    entry('system', 'returns/sys'),
    entry('service', 'returns/svc', { owningTeam: 't', system: 'returns/sys' }),
    entry('service', 'returns/other', { owningTeam: 't' }),
    entry('api', 'returns/api', { hostedBy: 'returns/svc', style: 'REST' }),
    entry('topic', 'returns/topic', { ownedBy: 'returns/svc', cluster: 'main' }),
    entry('datastore', 'returns/db', { ownedBy: 'returns/svc', technology: 'postgres' }),
    entry('external', 'ext/dhl', { kind: 'partner', ownerTeam: 't' }, 'ext'),
  ];
}
