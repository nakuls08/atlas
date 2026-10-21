export type EntryType =
  | 'department'
  | 'domain'
  | 'system'
  | 'service'
  | 'api'
  | 'topic'
  | 'datastore'
  | 'channel'
  | 'external'
  | 'cluster';

export type Status = 'planned' | 'active' | 'deprecated';

export type ConnectionKind =
  | 'calls'
  | 'publishes'
  | 'consumes'
  | 'reads-writes'
  | 'calls-unknown'
  /** A grant that is requested but not yet approved (Spec0). */
  | 'requests'
  /** An operation uses a schema (Spec0). */
  | 'uses'
  /** A schema references another schema (Spec0). */
  | 'references'
  /** Two schemas with the same structure in different APIs (Spec0). */
  | 'twin';

/** A registry entry as loaded from YAML. `fields` keeps every key from the file. */
export interface Entry {
  id: string;
  type: EntryType;
  name: string;
  status: Status;
  /** Domain file the entry was declared in, if any. */
  domain?: string;
  file: string;
  fields: Record<string, unknown>;
}

export interface Connection {
  from: string;
  to: string;
  gap?: string;
  file: string;
}

/** A guided walkthrough for presenting the board (registry/tours.yaml). */
export interface Tour {
  id: string;
  name: string;
  description?: string;
  steps: TourStep[];
  file: string;
}

export interface TourStep {
  caption: string;
  /** Card to zoom to. */
  focus?: string;
  /** Highlight the path from the first card to the second. */
  trace?: [string, string];
  /** Highlight everything affected if this card fails (or that it needs). */
  impact?: string;
  direction?: 'dependents' | 'dependencies';
  /** "Show down to" level for the step (0 = department … 4 = interface). */
  level?: number;
}

export interface Registry {
  entries: Map<string, Entry>;
  connections: Connection[];
  tours: Tour[];
  /** Problems found while reading files (duplicate ids, malformed YAML shapes). */
  loadIssues: Issue[];
}

export interface Issue {
  file: string;
  id?: string;
  message: string;
}
