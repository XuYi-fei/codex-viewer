#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const cliPath = join(__dirname, '..', 'cli.js');
const [command = 'start', ...rest] = process.argv.slice(2);
const workspace = resolve(process.env.INIT_CWD || process.cwd());
const hasWorkspace = rest.includes('--workspace');
const args = [cliPath, command, ...rest];

if (!hasWorkspace) {
  args.push('--workspace', workspace);
}

const result = spawnSync(process.execPath, args, {
  cwd: workspace,
  stdio: 'inherit',
  env: process.env,
});

process.exit(result.status ?? 0);
