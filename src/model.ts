import type { ConnectionKind, EntryType, Status, TourStep } from './registry/types';

export type NodeType = Exclude<EntryType, 'cluster'> | 'band' | 'apigroup' | 'team' | 'operation' | 'schema';

/**
 * Markers derived from the registry:
 * platform   service with `role: platform` (its incoming links are hidden by default)
 * disputed   service with `ownership: disputed`
 * shared     datastore accessed by a service other than its owner
 * migrate    service that calls a deprecated API
 * superseded API that a newer API supersedes
 */
export type NodeFlag = 'platform' | 'disputed' | 'shared' | 'migrate' | 'superseded';

/** One card on the board. Geometry is absolute and fixed: zoom only shows or hides cards. */
export interface BoardNode {
  id: string;
  type: NodeType;
  name: string;
  parent: string | null;
  level: number;
  status: Status;
  x: number;
  y: number;
  w: number;
  h: number;
  /**
   * How much the card is shrunk: it is drawn at w/s × h/s and scaled by s. Siblings are equal
   * tiles, so a container's children are drawn smaller than it to fit (1 at the top level).
   */
  s?: number;
  children: string[];
  /** Department (or band) the card sits in, for colouring. */
  dept: string | null;
  /** Child summary for containers, e.g. "6 services · 3 topics". */
  summary: string;
  /** One-line detail for leaves, e.g. "REST · partner". */
  detail: string;
  flags: NodeFlag[];
  tags: string[];
  /** Platform services this service calls, shown as a badge instead of links. */
  uses: string[];
  /** Display fields for the selection panel. */
  fields: Array<[string, string]>;
  file?: string;
  /**
   * Children not loaded yet (progressive sources). The card is sized from these counts, so it
   * doesn't move when the children arrive.
   */
  lazy?: { operations: number; schemas: number; specVersion?: string | null };
}

export interface BoardEdge {
  id: string;
  from: string;
  to: string;
  kind: ConnectionKind;
  gap?: string;
  /** Target is a platform service or one of its APIs. */
  platform?: boolean;
}

export interface BoardModel {
  meta: Record<string, string>;
  settings: { expandAt: number; collapseAt: number };
  /** Kafka clusters, for the cluster filter. */
  clusters: Array<{ id: string; name: string }>;
  nodes: BoardNode[];
  edges: BoardEdge[];
  tours: Array<{ id: string; name: string; description?: string; steps: TourStep[] }>;
  /** Names of the zoom levels for "show down to"; defaults to the registry's. */
  levels?: string[];
  /** Set when the board was built in the browser from a Spec0 snapshot. */
  spec0?: { hierarchy: 'team' | 'domain'; org: string; snapshotVersion: string };
}

export const DEFAULT_SETTINGS = { expandAt: 320, collapseAt: 260 };
