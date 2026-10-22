import type { Usage, UsagePlugin } from './usage';

/**
 * Usage from Prometheus (or anything that speaks its HTTP query API: Thanos, Mimir,
 * VictoriaMetrics). Each query must return an instant vector with one series per API; `label`
 * names the label that identifies the API. Its values are matched to API ids directly, or
 * through `map` when the metrics use other names.
 *
 *   calls:  sum by (service_name) (increase(http_server_request_duration_seconds_count[30d]))
 *   errors: sum by (service_name) (increase(http_server_request_duration_seconds_count{http_response_status_code=~"5.."}[30d]))
 *   p95:    histogram_quantile(0.95, sum by (service_name, le) (rate(http_server_request_duration_seconds_bucket[30d]))) * 1000
 */
export interface PrometheusOptions {
  url: string;
  label: string;
  window: string;
  queries: { calls: string; errors?: string; p95Ms?: string };
  /** Label value → API id, for series whose names differ from the ids. */
  map?: Record<string, string>;
  headers?: Record<string, string>;
  /** Shown as the report's source. Default "Prometheus". */
  source?: string;
}

type Vector = { status: string; error?: string; data?: { resultType: string; result: Array<{ metric: Record<string, string>; value: [number, string] }> } };

export function prometheusPlugin(o: PrometheusOptions): UsagePlugin {
  const query = async (q: string): Promise<Map<string, number>> => {
    const res = await fetch(`${o.url.replace(/\/$/, '')}/api/v1/query`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', ...o.headers },
      body: new URLSearchParams({ query: q }),
    });
    const body = (await res.json().catch(() => null)) as Vector | null;
    if (!res.ok || body?.status !== 'success') throw new Error(`Prometheus: ${body?.error ?? `HTTP ${res.status}`}`);
    if (body.data?.resultType !== 'vector') throw new Error(`Prometheus: expected an instant vector, got ${body.data?.resultType}`);
    const out = new Map<string, number>();
    for (const s of body.data.result) {
      const key = s.metric[o.label];
      const v = Number(s.value[1]);
      if (key === undefined || !Number.isFinite(v)) continue;
      const id = o.map?.[key] ?? key;
      out.set(id, (out.get(id) ?? 0) + v);
    }
    return out;
  };
  return {
    name: o.source ?? 'Prometheus',
    async load(ctx) {
      const [calls, errors, p95] = await Promise.all([query(o.queries.calls), o.queries.errors ? query(o.queries.errors) : null, o.queries.p95Ms ? query(o.queries.p95Ms) : null]);
      const ids = new Set(ctx.apis.map((a) => a.id));
      const apis: Record<string, Usage> = {};
      for (const [id, n] of calls) {
        if (ids.size && !ids.has(id)) continue;
        const u: Usage = { calls: Math.round(n) };
        if (errors) u.errors = Math.round(errors.get(id) ?? 0);
        if (p95?.has(id)) u.p95Ms = Math.round(p95.get(id)!);
        apis[id] = u;
      }
      return { source: o.source ?? 'Prometheus', window: o.window, asOf: new Date().toISOString(), apis };
    },
  };
}
