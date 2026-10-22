/**
 * Builds the demo site published to GitHub Pages:
 *
 *   dist/demo/              the e-commerce example
 *   dist/demo/small/        the small example registry
 *   dist/demo/org-graph/    the org graph fixture
 *
 *   tsx scripts/build-demo.ts
 *
 * Boards are labelled with the package version, and with the commit when GITHUB_SHA is set.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, rmSync } from 'node:fs';

const { version } = JSON.parse(readFileSync('package.json', 'utf8'));
const commit = process.env.GITHUB_SHA ? ['--commit', process.env.GITHUB_SHA.slice(0, 7)] : [];
const atlas = (...args: string[]) => execFileSync('npx', ['tsx', 'src/cli/main.ts', ...args], { stdio: 'inherit' });

rmSync('dist/demo', { recursive: true, force: true });
atlas('build', '-r', 'examples/ecommerce', '-o', 'dist/demo', '--board-version', version, ...commit);
atlas('build', '-r', 'examples', '-o', 'dist/demo/small', '--board-version', version, ...commit);
atlas('build-spec0', '-o', 'dist/demo/org-graph', '--snapshot', 'examples/spec0/snapshot-with-services.json', '--details', 'examples/spec0/details.json', '--usage', 'examples/spec0/usage.json');
