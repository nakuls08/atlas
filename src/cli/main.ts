import { parseArgs } from 'node:util';
import { extname, resolve } from 'node:path';
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { ValidationError, build, buildSpec0 } from '../build/build';
import { prometheusPlugin } from '../enrich/prometheus';
import { parseUsageReport, type UsageContext, type UsagePlugin } from '../enrich/usage';
import type { UsageSpec } from '../orgview/boot';
import { loadRegistry } from '../registry/load';
import { validate } from '../registry/validate';
import type { Issue } from '../registry/types';

const USAGE = `atlas <command> [options]

Commands:
  validate             Check the registry against every type and connection rule
  build -o <dir>       Build the read-only board as one self-contained HTML file
  build-spec0 -o <dir> Build a Spec0 org graph page:
                         --snapshot <file> --details <file>   embedded data (demo)
                         --api <url>                          live graph API
                         --usage <source>                     usage plugin; repeat to add more,
                                                              earlier ones win. A report file
                                                              (.json), a URL the page fetches,
                                                              a plugin module (.mjs/.js/.ts) run
                                                              now, or "spec0" for the snapshot's
                                                              own counts. Default: no usage
  usage prometheus     Write a usage report from Prometheus:
                         --url <base> --label <name> --calls <promql>
                         [--errors <promql>] [--p95 <promql>] [--window 30d]
                         [--map <file>] -o <report.json>

Options:
  -r, --root <dir>     Registry repo root (contains registry/). Default: current directory
  -o, --out <dir>      Output directory for build. Default: dist
  --board-version <v>  Version label shown in the footer. Default: draft
  --commit <sha>       Commit shown in the footer`;

function printIssues(issues: Issue[]) {
  for (const i of issues) console.error(`  ${i.file}${i.id ? ` [${i.id}]` : ''}: ${i.message}`);
}

async function main() {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      root: { type: 'string', short: 'r', default: '.' },
      out: { type: 'string', short: 'o', default: 'dist' },
      'board-version': { type: 'string' },
      commit: { type: 'string' },
      snapshot: { type: 'string' },
      details: { type: 'string' },
      api: { type: 'string' },
      usage: { type: 'string', multiple: true },
      url: { type: 'string' },
      label: { type: 'string' },
      calls: { type: 'string' },
      errors: { type: 'string' },
      p95: { type: 'string' },
      window: { type: 'string', default: '30d' },
      map: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  const [cmd] = positionals;
  const root = resolve(values.root!);

  if (!cmd || values.help) {
    console.log(USAGE);
    return;
  }

  if (cmd === 'validate') {
    const reg = loadRegistry(root);
    const issues = validate(reg);
    if (issues.length) {
      console.error(`✗ ${issues.length} issue(s):`);
      printIssues(issues);
      process.exitCode = 1;
    } else {
      console.log(`✓ ${reg.entries.size} entries, ${reg.connections.length} connections — valid`);
    }
    return;
  }

  if (cmd === 'build') {
    const meta: Record<string, string> = {};
    if (values['board-version']) meta.version = values['board-version'];
    if (values.commit) meta.commit = values.commit;
    try {
      const t0 = performance.now();
      const out = await build(root, resolve(values.out!), meta);
      console.log(`✓ built ${out} in ${Math.round(performance.now() - t0)} ms`);
    } catch (e) {
      if (e instanceof ValidationError) {
        console.error(`✗ build blocked by ${e.issues.length} validation issue(s):`);
        printIssues(e.issues);
        process.exitCode = 1;
        return;
      }
      throw e;
    }
    return;
  }

  if (cmd === 'usage') {
    if (positionals[1] !== 'prometheus' || !values.url || !values.label || !values.calls) {
      console.error('usage prometheus needs --url, --label and --calls (see atlas --help)');
      process.exitCode = 2;
      return;
    }
    const map = values.map ? JSON.parse(readFileSync(resolve(values.map), 'utf8')) : undefined;
    const plugin = prometheusPlugin({ url: values.url, label: values.label, window: values.window!, map, queries: { calls: values.calls, errors: values.errors, p95Ms: values.p95 } });
    const report = await plugin.load({ apis: [] });
    const out = values.out === 'dist' ? 'usage.json' : values.out!;
    writeFileSync(resolve(out), JSON.stringify(report, null, 2) + '\n');
    console.log(`✓ ${Object.keys(report!.apis).length} APIs → ${out}`);
    return;
  }

  if (cmd === 'build-spec0') {
    const t0 = performance.now();
    let out: string;
    const snapshot = values.snapshot ? JSON.parse(readFileSync(resolve(values.snapshot), 'utf8')) : null;
    const ctx: UsageContext = { apis: (snapshot?.apis ?? []).map((a: { id: string; name: string }) => ({ id: a.id, name: a.name })) };
    const usage: UsageSpec[] = [];
    for (const u of values.usage ?? []) usage.push(await usageSpec(u, ctx));
    if (values.api) out = await buildSpec0({ type: 'http', baseUrl: values.api }, resolve(values.out!), undefined, usage);
    else if (snapshot) {
      const details = values.details ? JSON.parse(readFileSync(resolve(values.details), 'utf8')) : {};
      out = await buildSpec0({ type: 'embedded', snapshot, details }, resolve(values.out!), `Atlas — ${snapshot.org?.name ?? 'org graph'}`, usage);
    } else {
      console.error('build-spec0 needs --snapshot <file> or --api <url>');
      process.exitCode = 2;
      return;
    }
    console.log(`✓ built ${out} in ${Math.round(performance.now() - t0)} ms`);
    return;
  }

  console.error(`Unknown command "${cmd}"\n\n${USAGE}`);
  process.exitCode = 2;
}

/** One --usage value as the page will load it. Files and modules are read now and embedded. */
async function usageSpec(u: string, ctx: UsageContext): Promise<UsageSpec> {
  if (u === 'spec0') return { type: 'spec0' };
  if (/^https?:\/\//.test(u)) return { type: 'url', url: u };
  const path = resolve(u);
  if (extname(path) === '.json') {
    const { report, problems } = parseUsageReport(JSON.parse(readFileSync(path, 'utf8')));
    for (const p of problems) console.warn(`  ${u}: ${p}`);
    return { type: 'report', report };
  }
  const mod = await import(pathToFileURL(path).href);
  const plugin: UsagePlugin = mod.default ?? mod.plugin;
  if (!plugin?.load) throw new Error(`${u}: a usage plugin module must export default { name, load(ctx) }`);
  const raw = await plugin.load(ctx);
  if (!raw) throw new Error(`${u}: plugin ${plugin.name} returned no report`);
  return { type: 'report', report: parseUsageReport(raw).report };
}

main();
