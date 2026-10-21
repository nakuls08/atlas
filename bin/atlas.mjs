#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const tsx = join(root, 'node_modules', '.bin', 'tsx');
const r = spawnSync(tsx, [join(root, 'src/cli/main.ts'), ...process.argv.slice(2)], { stdio: 'inherit' });
process.exit(r.status ?? 1);
