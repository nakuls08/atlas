import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { prometheusPlugin } from '../src/enrich/prometheus';
import { loadUsage, parseUsageReport, reportPlugin, type UsagePlugin, type UsageReport } from '../src/enrich/usage';
import { applyUsage, buildGraph } from '../src/orgview/graph';
import type { GraphSnapshot } from '../src/spec0/types';
import { spec0AuthzPlugin } from '../src/spec0/usage';

const snap = JSON.parse(readFileSync('examples/spec0/snapshot-with-services.json', 'utf8')) as GraphSnapshot;
const sample = JSON.parse(readFileSync('examples/spec0/usage.json', 'utf8')) as UsageReport;
const ctx = { apis: snap.apis.map((a) => ({ id: a.id, name: a.name })) };

afterEach(() => vi.unstubAllGlobals());

describe('usage layer', () => {
  it('sums calls over the APIs that report, and keeps "no data" apart from zero calls', async () => {
    const g = buildGraph(snap, 'team');
    applyUsage(g, await loadUsage([reportPlugin(sample)], ctx));
    const payments = g.cards.get('t:team-payments')!;
    const reporting = payments.apis.map((a) => g.cards.get(a)!).filter((c) => c.traffic !== null);
    expect(payments.measured).toBe(reporting.length);
    expect(payments.traffic).toBe(reporting.reduce((s, c) => s + c.traffic!, 0));
    const apis = [...g.cards.values()].filter((c) => c.kind === 'api');
    expect(apis.some((c) => c.traffic === null)).toBe(true);
    expect(apis.some((c) => c.traffic === 0)).toBe(true);
    expect(apis.find((c) => c.traffic)!.usage).toMatchObject({ report: 0 });
  });

  it('never reads traffic from the snapshot unless the Spec0 plugin is asked for', async () => {
    const counted = { ...snap, apis: snap.apis.map((a, i) => ({ ...a, calls30d: i })) };
    const g = buildGraph(counted, 'team');
    expect([...g.cards.values()].every((c) => c.traffic === null)).toBe(true);
    applyUsage(g, await loadUsage([spec0AuthzPlugin(counted)], ctx));
    expect(g.cards.get(`a:${counted.apis[5].id}`)!.traffic).toBe(5);
    expect(g.usage!.reports[0]).toMatchObject({ source: 'Spec0 authorisation checks', window: '30d' });
  });

  it('lets earlier plugins win, records failures, and refuses a different window', async () => {
    const id = snap.apis[0].id;
    const a: UsagePlugin = reportPlugin({ source: 'A', window: '30d', apis: { [id]: { calls: 1 } } });
    const b: UsagePlugin = reportPlugin({ source: 'B', window: '30d', apis: { [id]: { calls: 2 }, [snap.apis[1].id]: { calls: 3 }, unknown: { calls: 9 } } });
    const c: UsagePlugin = reportPlugin({ source: 'C', window: '24h', apis: {} });
    const broken: UsagePlugin = { name: 'broken', load: () => Promise.reject(new Error('down')) };
    const layer = (await loadUsage([a, b, c, broken], ctx))!;
    expect(layer.apis.get(id)).toEqual({ calls: 1, report: 0 });
    expect(layer.apis.get(snap.apis[1].id)).toEqual({ calls: 3, report: 1 });
    expect(layer.apis.has('unknown')).toBe(false);
    expect(layer.failed.map((f) => f.plugin)).toEqual(['C', 'broken']);
  });

  it('checks reports read from files', () => {
    expect(() => parseUsageReport({ window: '30d', apis: {} })).toThrow(/source/);
    const { report, problems } = parseUsageReport({ source: 'x', window: '7d', apis: { a: { calls: 4, p95Ms: 12 }, b: { calls: -1 }, c: {} } });
    expect(report.apis).toEqual({ a: { calls: 4, p95Ms: 12 } });
    expect(problems).toHaveLength(2);
  });
});

describe('prometheus plugin', () => {
  it('maps series to API ids by label and rounds the numbers', async () => {
    const vector = (rows: Array<[string, string]>) => ({ status: 'success', data: { resultType: 'vector', result: rows.map(([k, v]) => ({ metric: { service_name: k }, value: [0, v] })) } });
    const bodies: string[] = [];
    vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
      const q = new URLSearchParams(String(init.body)).get('query')!;
      bodies.push(q);
      const rows: Array<[string, string]> = q === 'calls' ? [['orders', '1200.4'], ['billing-svc', '30'], ['other', '5']] : q === 'errors' ? [['orders', '3']] : [['orders', '181.6'], ['billing-svc', 'NaN']];
      return new Response(JSON.stringify(vector(rows)));
    });
    const plugin = prometheusPlugin({ url: 'http://prom:9090/', label: 'service_name', window: '30d', map: { 'billing-svc': 'billing' }, queries: { calls: 'calls', errors: 'errors', p95Ms: 'p95' } });
    const r = (await plugin.load({ apis: [{ id: 'orders', name: 'Orders' }, { id: 'billing', name: 'Billing' }] }))!;
    expect(r.apis).toEqual({ orders: { calls: 1200, errors: 3, p95Ms: 182 }, billing: { calls: 30, errors: 0 } });
    expect(bodies.sort()).toEqual(['calls', 'errors', 'p95']);
  });

  it('reports query errors', async () => {
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ status: 'error', error: 'parse error at char 3' }), { status: 400 }));
    const plugin = prometheusPlugin({ url: 'http://prom', label: 'job', window: '30d', queries: { calls: 'x(' } });
    await expect(plugin.load({ apis: [] })).rejects.toThrow(/parse error/);
  });
});
