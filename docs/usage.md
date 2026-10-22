# Usage plugins

Usage is how much each API is called, and optionally how many of those calls failed and how slow they were. Atlas never reads it from a registry or a graph snapshot. It loads it from plugins and draws it as a separate layer, with its source and time window next to the numbers.

Pass plugins to `build-spec0` with `--usage`. Repeat the flag to add more; when two plugins have numbers for the same API, the earlier one wins.

| `--usage` | What happens |
| --- | --- |
| `usage.json` | The report is read and checked at build time and embedded in the page |
| `https://…/usage.json` | The page fetches the report when it opens (the server must allow it with CORS) |
| `my-plugin.mjs` | The module's plugin runs at build time and its report is embedded |
| `spec0` | The snapshot's own `calls30d`: authorisation checks Spec0 answered in the last 30 days |

If a plugin fails, the board still opens. The status line says usage is unavailable, and hovering it shows why.

## Report format

```json
{
  "source": "Prometheus",
  "window": "30d",
  "asOf": "2026-10-21T06:00:00Z",
  "apis": {
    "payments-card-vault-api": { "calls": 442413, "errors": 981, "p95Ms": 215 },
    "payments-klarna-adapter": { "calls": 0 }
  }
}
```

`source` and `window` are required, and the board shows both. `apis` is keyed by API id, the same id the graph uses. `calls` is required for each API; `errors` and `p95Ms` are optional. Leave an API out when you have no numbers for it rather than writing zero: the board shows "no data" for missing APIs and "no calls" for zero. Set `"sample": true` for made-up numbers and the board will label them.

All reports on one board must cover the same window. A report with a different window is refused, because calls from different windows can't be added up into a team total.

## Prometheus

`atlas usage prometheus` runs one to three instant queries and writes a report. Each query must return one series per API, with the API identified by the label you name in `--label`.

```bash
atlas usage prometheus \
  --url http://prometheus:9090 \
  --label service_name \
  --window 30d \
  --calls  'sum by (service_name) (increase(http_server_request_duration_seconds_count[30d]))' \
  --errors 'sum by (service_name) (increase(http_server_request_duration_seconds_count{http_response_status_code=~"5.."}[30d]))' \
  --p95    'histogram_quantile(0.95, sum by (service_name, le) (rate(http_server_request_duration_seconds_bucket[30d]))) * 1000' \
  --map service-map.json \
  -o usage.json
```

The queries above use the OpenTelemetry HTTP server metric names; use whatever your services export. Thanos, Mimir and VictoriaMetrics accept the same queries. When the label values aren't your API ids, `--map` takes a JSON file of label value → API id. Series that match no API are dropped.

Run it on a schedule (in CI, for example) and rebuild the page, or publish the report somewhere the page can fetch it.

## Writing a plugin

A plugin is an object with a name and a `load` function. `load` gets the board's APIs and returns a report, or null when it has nothing.

```js
// datadog-usage.mjs
export default {
  name: 'Datadog',
  async load({ apis }) {
    const res = await fetch('https://api.datadoghq.com/api/v1/query?…', { headers: { 'DD-API-KEY': process.env.DD_API_KEY } });
    const series = (await res.json()).series;
    return {
      source: 'Datadog APM',
      window: '30d',
      asOf: new Date().toISOString(),
      apis: Object.fromEntries(series.map((s) => [s.scope.replace('service:', ''), { calls: Math.round(s.pointlist.at(-1)[1]) }])),
    };
  },
};
```

```bash
atlas build-spec0 --api https://graph.example.com --usage datadog-usage.mjs -o dist/org
```

Module plugins run at build time, in Node, so credentials stay out of the page. The report they return is checked the same way as a file. The types are in `src/enrich/usage.ts`.
