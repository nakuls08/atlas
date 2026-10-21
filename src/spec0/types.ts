/**
 * Wire types for the graph format: `GET /graph/snapshot` and `GET /graph/details`, as Spec0
 * serves them for its org graph (see docs/graph-api.md). Nullable fields may also be absent.
 */

export interface GraphSnapshot {
  /** Content digest; also the ETag. */
  version: string;
  generatedAt: string;
  org: { id: string; name: string };
  teams: Array<{ id: string; name: string; members: number }>;
  services: Array<{ id: string; name: string; team?: string | null }>;
  domains: Array<{ id: string; name: string; slug: string }>;
  apis: SnapshotApi[];
  grants: SnapshotGrant[];
}

export interface SnapshotApi {
  id: string;
  name: string;
  version: string;
  /** Latest published spec version; null before the first publish. */
  specVersion?: string | null;
  team: string;
  /** The service exposing the API, once Spec0 records it. */
  service?: string | null;
  status: 'ACTIVE' | 'INACTIVE' | 'DEPRECATED' | 'PENDING';
  sample: boolean;
  source?: string | null;
  updatedAt?: string | null;
  operations: number;
  schemas: number;
  /** Domain id → number of the API's schemas in that domain. */
  domains: Record<string, number>;
  /** Authorised calls over the last 30 days. */
  calls30d: number;
}

/** One per consumer and API; the status is the most permissive across environments. */
export interface SnapshotGrant {
  consumer: string;
  consumerKind: 'TEAM' | 'SERVICE';
  api: string;
  status: 'APPROVED' | 'PENDING' | 'REJECTED';
  operationScoped: boolean;
}

export interface ApiDetails {
  id: string;
  specVersion?: string | null;
  operations: Array<{ method: string; path: string; operationId?: string | null }>;
  schemas: Array<{ name: string; structuralHash: string; propertyCount: number; domain?: string | null }>;
  /** `[operationIndex, schemaIndex]` */
  carries: number[][];
  /** `[schemaIndex, referencedSchemaIndex]` */
  references: number[][];
  grantOperations: Array<{ consumer: string; consumerKind: 'TEAM' | 'SERVICE'; operations: number[] }>;
  versions: Array<{ tag: string; publishedAt: string; breaking: boolean }>;
}

export interface DetailKey {
  id: string;
  specVersion?: string | null;
}

/** Where the viewer gets Spec0 data from: the live API, or a file for demos and tests. */
export interface GraphSource {
  snapshot(): Promise<GraphSnapshot>;
  details(apis: DetailKey[]): Promise<ApiDetails[]>;
  /** Requests made so far, for the network meter. */
  readonly stats: { requests: Array<{ kind: 'snapshot' | 'details'; apis: number; bytes: number; ms: number }> };
}
