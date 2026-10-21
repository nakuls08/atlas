import type { ApiDetails, DetailKey, GraphSnapshot, GraphSource } from './types';

type Stats = GraphSource['stats'];

/** Gzipped size, as the browser would receive it (CompressionStream where available). */
async function gzipBytes(text: string): Promise<number> {
  try {
    const stream = new Blob([text]).stream().pipeThrough(new CompressionStream('gzip'));
    return (await new Response(stream).arrayBuffer()).byteLength;
  } catch {
    return text.length;
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Serves a snapshot and per-API details that were embedded in the page, with network-like
 * latency, so demos and tests exercise the same progressive path as the live API.
 */
export class EmbeddedSource implements GraphSource {
  readonly stats: Stats = { requests: [] };
  constructor(
    private snap: GraphSnapshot,
    private all: Record<string, ApiDetails>,
    private latency: [number, number] = [90, 220],
  ) {}

  private async wait() {
    await sleep(this.latency[0] + Math.random() * (this.latency[1] - this.latency[0]));
  }

  async snapshot(): Promise<GraphSnapshot> {
    const t = performance.now();
    await this.wait();
    const body = JSON.stringify(this.snap);
    this.stats.requests.push({ kind: 'snapshot', apis: this.snap.apis.length, bytes: await gzipBytes(body), ms: performance.now() - t });
    return JSON.parse(body);
  }

  async details(apis: DetailKey[]): Promise<ApiDetails[]> {
    const t = performance.now();
    await this.wait();
    const out = apis.map((a) => this.all[a.id]).filter(Boolean);
    const body = JSON.stringify({ apis: out });
    this.stats.requests.push({ kind: 'details', apis: out.length, bytes: await gzipBytes(body), ms: performance.now() - t });
    return JSON.parse(body).apis;
  }
}

/** The details request carries at most this many APIs (the server's limit). */
const DETAILS_BATCH = 50;

/**
 * A live graph API over HTTP. The snapshot is revalidated with its ETag, so reloading
 * an unchanged org costs a 304 and no body; details for current versions are cached by the
 * browser as immutable.
 */
export class HttpSource implements GraphSource {
  readonly stats: Stats = { requests: [] };
  private cached: { etag: string; snap: GraphSnapshot } | null = null;
  constructor(
    private base: string,
    private headers: () => Record<string, string> | Promise<Record<string, string>> = () => ({}),
  ) {}

  private async get(path: string, extra: Record<string, string> = {}) {
    const res = await fetch(`${this.base.replace(/\/$/, '')}${path}`, { headers: { Accept: 'application/json', ...(await this.headers()), ...extra }, credentials: 'include' });
    if (!res.ok && res.status !== 304) throw new Error(`${path}: HTTP ${res.status}`);
    return res;
  }

  async snapshot(): Promise<GraphSnapshot> {
    const t = performance.now();
    const res = await this.get('/graph/snapshot', this.cached ? { 'If-None-Match': this.cached.etag } : {});
    if (res.status === 304 && this.cached) {
      this.stats.requests.push({ kind: 'snapshot', apis: this.cached.snap.apis.length, bytes: 0, ms: performance.now() - t });
      return this.cached.snap;
    }
    const text = await res.text();
    const snap = JSON.parse(text) as GraphSnapshot;
    const etag = res.headers.get('ETag');
    this.cached = etag ? { etag, snap } : null;
    this.stats.requests.push({ kind: 'snapshot', apis: snap.apis.length, bytes: Number(res.headers.get('Content-Length')) || text.length, ms: performance.now() - t });
    return snap;
  }

  async details(apis: DetailKey[]): Promise<ApiDetails[]> {
    const out: ApiDetails[] = [];
    for (let i = 0; i < apis.length; i += DETAILS_BATCH) {
      const t = performance.now();
      const batch = apis.slice(i, i + DETAILS_BATCH);
      const q = batch.map((a) => encodeURIComponent(a.specVersion ? `${a.id}@${a.specVersion}` : a.id)).join(',');
      const res = await this.get(`/graph/details?apis=${q}`);
      const text = await res.text();
      out.push(...(JSON.parse(text).apis as ApiDetails[]));
      this.stats.requests.push({ kind: 'details', apis: batch.length, bytes: Number(res.headers.get('Content-Length')) || text.length, ms: performance.now() - t });
    }
    return out;
  }
}
