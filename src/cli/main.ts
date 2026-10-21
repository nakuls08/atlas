import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import { ValidationError, build, buildSpec0 } from '../build/build';
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

  if (cmd === 'build-spec0') {
    const t0 = performance.now();
    let out: string;
    if (values.api) out = await buildSpec0({ type: 'http', baseUrl: values.api }, resolve(values.out!));
    else if (values.snapshot) {
      const snapshot = JSON.parse(readFileSync(resolve(values.snapshot), 'utf8'));
      const details = values.details ? JSON.parse(readFileSync(resolve(values.details), 'utf8')) : {};
      out = await buildSpec0({ type: 'embedded', snapshot, details }, resolve(values.out!), `Atlas — ${snapshot.org?.name ?? 'org graph'}`);
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

main();
