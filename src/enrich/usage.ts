/**
 * Usage enrichment: how much an API is actually called, and how well it answers. A registry
 * declares what exists and who may call what; it never holds traffic, because traffic changes by
 * the hour and nobody should review a pull request for it. Usage comes from plugins instead (a
 * file exported from a metrics system, a query against Prometheus, a platform's own logs) and is
 * drawn as its own layer, with where it came from and the window it covers.
 *
 * Plugins are keyed by API id. An API a plugin says nothing about has no data, which the board
 * shows differently from an API with zero calls.
 */

export interface Usage {
  calls: number;
  /** Calls that failed (5xx, or whatever the source counts as an error). */
  errors?: number;
  /** 95th percentile latency in milliseconds. */
  p95Ms?: number;
}

/** What a plugin returns: one window of numbers from one source. */
export interface UsageReport {
  /** Shown next to the numbers: "Prometheus", "Gateway logs", "Sample data". */
  source: string;
  /** The window the numbers cover, such as "30d" or "24h". */
  window: string;
  /** When the numbers were taken, as an ISO time. */
  asOf?: string;
  /** Made-up numbers, for demos. The board labels them as such. */
  sample?: boolean;
  /** API id → usage. */
  apis: Record<string, Usage>;
}

/** What a plugin is told about the board it is loading numbers for. */
export interface UsageContext {
  apis: Array<{ id: string; name: string }>;
}

export interface UsagePlugin {
  name: string;
  /** Null when the plugin has nothing for this board. */
  load(ctx: UsageContext): Promise<UsageReport | null>;
}

/** Plugin results merged for the board: per API, the first plugin that has it wins. */
export interface UsageLayer {
  reports: Array<Omit<UsageReport, 'apis'>>;
  /** API id → usage and the index of the report it came from. */
  apis: Map<string, Usage & { report: number }>;
  /** Plugins that failed, by name, with the reason. The board still draws without them. */
  failed: Array<{ plugin: string; error: string }>;
}

export async function loadUsage(plugins: UsagePlugin[], ctx: UsageContext): Promise<UsageLayer | null> {
  const results = await Promise.all(
    plugins.map(async (p) => {
      try {
        return { plugin: p.name, report: await p.load(ctx) };
      } catch (e) {
        return { plugin: p.name, error: e instanceof Error ? e.message : String(e) };
      }
    }),
  );
  const layer: UsageLayer = { reports: [], apis: new Map(), failed: [] };
  const known = new Set(ctx.apis.map((a) => a.id));
  for (const r of results) {
    if ('error' in r) {
      layer.failed.push({ plugin: r.plugin, error: r.error! });
      continue;
    }
    if (!r.report) continue;
    // Calls from different windows can't be added up.
    if (layer.reports.length && r.report.window !== layer.reports[0].window) {
      layer.failed.push({ plugin: r.plugin, error: `window ${r.report.window} differs from ${layer.reports[0].window}` });
      continue;
    }
    const { apis, ...meta } = r.report;
    const index = layer.reports.push(meta) - 1;
    for (const [id, u] of Object.entries(apis)) if (known.has(id) && !layer.apis.has(id)) layer.apis.set(id, { ...u, report: index });
  }
  return layer.reports.length || layer.failed.length ? layer : null;
}

const isCount = (v: unknown) => typeof v === 'number' && Number.isFinite(v) && v >= 0;

/**
 * Checks a report read from a file or a URL. Entries with bad numbers are dropped and listed in
 * `problems`; a report without a source or window is refused.
 */
export function parseUsageReport(json: unknown): { report: UsageReport; problems: string[] } {
  const o = json as Partial<UsageReport> | null;
  if (!o || typeof o !== 'object') throw new Error('usage report must be a JSON object');
  if (typeof o.source !== 'string' || !o.source) throw new Error('usage report needs a "source", such as "Prometheus"');
  if (typeof o.window !== 'string' || !o.window) throw new Error('usage report needs a "window", such as "30d"');
  if (!o.apis || typeof o.apis !== 'object') throw new Error('usage report needs "apis": { "<api id>": { "calls": <n> } }');
  const problems: string[] = [];
  const apis: Record<string, Usage> = {};
  for (const [id, u] of Object.entries(o.apis as Record<string, Partial<Usage>>)) {
    if (!u || !isCount(u.calls) || (u.errors !== undefined && !isCount(u.errors)) || (u.p95Ms !== undefined && !isCount(u.p95Ms))) {
      problems.push(`${id}: calls, errors and p95Ms must be non-negative numbers`);
      continue;
    }
    apis[id] = { calls: u.calls!, ...(u.errors !== undefined ? { errors: u.errors } : {}), ...(u.p95Ms !== undefined ? { p95Ms: u.p95Ms } : {}) };
  }
  const report: UsageReport = { source: o.source, window: o.window, apis };
  if (typeof o.asOf === 'string') report.asOf = o.asOf;
  if (o.sample === true) report.sample = true;
  return { report, problems };
}

/** A report already in hand: read from a file at build time and embedded in the page. */
export const reportPlugin = (report: UsageReport): UsagePlugin => ({ name: report.source, load: async () => report });

/** A report served as JSON, fetched by the browser when the board opens. */
export const urlPlugin = (url: string, init?: RequestInit): UsagePlugin => ({
  name: url,
  async load() {
    const res = await fetch(url, init);
    if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
    return parseUsageReport(await res.json()).report;
  },
});
