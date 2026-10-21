import type { ConnectionKind, EntryType } from './types';

/**
 * Connection rules: the (source type, target type) pair decides the kind.
 * Any pair not listed is rejected.
 */
export const CONNECTION_RULES: ReadonlyArray<{ from: EntryType; to: EntryType; kind: ConnectionKind }> = [
  { from: 'service', to: 'api', kind: 'calls' },
  { from: 'external', to: 'api', kind: 'calls' },
  { from: 'service', to: 'external', kind: 'calls' },
  { from: 'service', to: 'topic', kind: 'publishes' },
  { from: 'topic', to: 'service', kind: 'consumes' },
  { from: 'topic', to: 'external', kind: 'consumes' },
  { from: 'external', to: 'topic', kind: 'publishes' },
  { from: 'service', to: 'channel', kind: 'publishes' },
  { from: 'channel', to: 'service', kind: 'consumes' },
  { from: 'channel', to: 'external', kind: 'consumes' },
  { from: 'external', to: 'channel', kind: 'publishes' },
  { from: 'service', to: 'datastore', kind: 'reads-writes' },
  { from: 'service', to: 'service', kind: 'calls-unknown' },
];

const byPair = new Map(CONNECTION_RULES.map((r) => [`${r.from}>${r.to}`, r.kind]));

export function connectionKind(from: EntryType, to: EntryType): ConnectionKind | undefined {
  return byPair.get(`${from}>${to}`);
}

export interface FieldRule {
  key: string;
  /** When set, the value must be the id of an entry of one of these types. */
  ref?: EntryType[];
  oneOf?: string[];
}

/** Required fields per type, beyond `id` and `name`. */
export const REQUIRED_FIELDS: Record<EntryType, FieldRule[]> = {
  department: [],
  domain: [{ key: 'owningTeam' }],
  system: [],
  service: [{ key: 'owningTeam' }],
  api: [
    { key: 'hostedBy', ref: ['service'] },
    { key: 'style', oneOf: ['REST', 'gRPC', 'GraphQL'] },
  ],
  topic: [
    { key: 'ownedBy', ref: ['service'] },
    { key: 'cluster', ref: ['cluster'] },
  ],
  datastore: [{ key: 'technology' }, { key: 'ownedBy', ref: ['service'] }],
  channel: [{ key: 'technology' }, { key: 'ownedBy', ref: ['service'] }],
  external: [{ key: 'kind', oneOf: ['partner', 'SaaS', 'other org'] }, { key: 'ownerTeam' }],
  cluster: [],
};

/** Optional reference fields that must resolve when present. */
export const OPTIONAL_REFS: Partial<Record<EntryType, FieldRule[]>> = {
  domain: [{ key: 'department', ref: ['department'] }],
  service: [{ key: 'system', ref: ['system'] }, { key: 'claimant', ref: ['domain'] }],
  api: [{ key: 'supersedes', ref: ['api'] }],
};

/** Optional enumerated fields. */
export const OPTIONAL_ENUMS: Partial<Record<EntryType, Array<{ key: string; oneOf: string[] }>>> = {
  service: [
    { key: 'role', oneOf: ['platform'] },
    { key: 'ownership', oneOf: ['disputed'] },
  ],
  api: [{ key: 'audience', oneOf: ['internal', 'partner', 'public'] }],
};

/** A host with more APIs than this groups them by tag, so its APIs must carry tags. */
export const API_GROUP_THRESHOLD = 8;

/** Zoom level of each type: 0 = outermost. */
export const LEVEL: Record<EntryType | 'band' | 'apigroup' | 'team' | 'operation' | 'schema', number> = {
  band: 0,
  department: 0,
  domain: 1,
  external: 1,
  system: 2,
  service: 3,
  api: 4,
  topic: 4,
  datastore: 4,
  channel: 4,
  apigroup: 3,
  team: 0,
  operation: 4,
  schema: 4,
  cluster: -1,
};

export const LEVEL_NAMES = ['department', 'domain', 'system', 'service', 'interface'] as const;
