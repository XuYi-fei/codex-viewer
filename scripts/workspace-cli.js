#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const cliPath = join(__dirname, '..', 'cli.js');
const [command = 'start', ...rest] = process.argv.slice(2);
const normalizedRest = [];
let workspace = null;
let hasWebHost = false;

for (let index = 0; index < rest.length; index += 1) {
  const token = rest[index];
  const next = rest[index + 1];
  const isFlag = String(token).startsWith('--');

  if (!isFlag) {
    if (!workspace) {
      workspace = resolve(token);
      continue;
    }
    normalizedRest.push(token);
    continue;
  }

  if (token === '--web-host') hasWebHost = true;
  normalizedRest.push(token);

  if (!next || String(next).startsWith('--')) continue;
  normalizedRest.push(next);
  if (token === '--workspace') workspace = resolve(next);
  index += 1;
}

if (!workspace) workspace = resolve(process.env.INIT_CWD || process.cwd());

const args = [cliPath, command, ...normalizedRest];
if (!normalizedRest.includes('--workspace')) args.push('--workspace', workspace);

if (command === 'start' && !hasWebHost) {
  args.push('--web-host', '0.0.0.0');
}

const result = spawnSync(process.execPath, args, {
  cwd: workspace,
  stdio: 'inherit',
  env: process.env,
});

process.exit(result.status ?? 0);
