import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';
import ELK from 'elkjs/lib/elk.bundled.js';
import { layoutBoard } from '../layout/elk';
import { DEFAULT_SETTINGS, type BoardModel } from '../model';
import { loadRegistry } from '../registry/load';
import { buildTree } from '../registry/tree';
import type { Issue } from '../registry/types';
import { validate } from '../registry/validate';
import { fontFaceCss } from './fonts';

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

export class ValidationError extends Error {
  constructor(public issues: Issue[]) {
    super(`${issues.length} validation issue(s)`);
  }
}

/** Registry → validated → laid out. Pure apart from reading the registry files. */
export async function buildModel(root: string, meta: Record<string, string> = {}): Promise<BoardModel> {
  const reg = loadRegistry(root);
  const issues = validate(reg);
  if (issues.length) throw new ValidationError(issues);

  const { nodes, edges } = buildTree(reg);
  await layoutBoard(nodes, edges, new ELK());

  return {
    meta: { version: 'draft', ...meta },
    settings: DEFAULT_SETTINGS,
    clusters: [...reg.entries.values()]
      .filter((e) => e.type === 'cluster')
      .map((e) => ({ id: e.id, name: e.name }))
      .sort((a, b) => a.id.localeCompare(b.id)),
    nodes: [...nodes.values()].sort((a, b) => a.id.localeCompare(b.id)),
    edges,
    tours: reg.tours.map(({ file: _file, ...t }) => t),
  };
}

async function bundleViewer(): Promise<{ js: string; css: string }> {
  const result = await esbuild.build({
    entryPoints: [join(here, '../viewer/boot.ts')],
    bundle: true,
    minify: true,
    format: 'iife',
    target: ['chrome110', 'firefox110', 'safari16'],
    write: false,
    outdir: 'out',
    legalComments: 'none',
  });
  const js = result.outputFiles.find((f) => f.path.endsWith('.js'))!.text;
  const css = result.outputFiles.find((f) => f.path.endsWith('.css'))?.text ?? '';
  return { js, css };
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

export function renderHtml(model: BoardModel | object, viewer: { js: string; css: string }, extraHead = '', title?: string): string {
  const data = JSON.stringify(model).replace(/</g, '\\u003c');
  const name = title ?? `Atlas — ${esc((model as BoardModel).meta?.version ?? '')}`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${name}</title>${extraHead}
<style>${fontFaceCss()}</style>
<style>${viewer.css}</style>
</head>
<body>
<div id="app"></div>
<script type="application/json" id="atlas-model">${data}</script>
<script>${viewer.js}</script>
</body>
</html>
`;
}

export async function build(root: string, outDir: string, meta: Record<string, string> = {}): Promise<string> {
  const [model, viewer] = await Promise.all([buildModel(root, meta), bundleViewer()]);
  const out = join(outDir, 'index.html');
  mkdirSync(outDir, { recursive: true });
  writeFileSync(out, renderHtml(model, viewer));
  return out;
}

/**
 * A Spec0 org graph: the page carries a data source instead of a laid-out model. The browser
 * fetches the snapshot, builds the hierarchy, lays it out (ELK in a Web Worker) and loads API
 * details as you zoom. `embedded` serves a snapshot and details from the page (demos, tests);
 * `http` points at a live graph API.
 */
export async function buildSpec0(
  source: { type: 'embedded'; snapshot: unknown; details: unknown } | { type: 'http'; baseUrl: string },
  outDir: string,
  title = 'Atlas — org graph',
): Promise<string> {
  const viewer = await bundleViewer();
  const worker = readFileSync(require.resolve('elkjs/lib/elk-worker.min.js'), 'utf8').replace(/<\/script/gi, '<\\/script');
  const html = renderHtml({ kind: 'spec0', source }, viewer, `\n<script type="text/plain" id="elk-worker">${worker}</script>`, esc(title));
  const out = join(outDir, 'index.html');
  mkdirSync(outDir, { recursive: true });
  writeFileSync(out, html);
  return out;
}
