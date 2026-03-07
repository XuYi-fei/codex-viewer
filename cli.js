#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, openSync, readFileSync, rmSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';

const VERSION = '0.1.0';
const PROJECT_ROOT = dirname(fileURLToPath(import.meta.url));

function printHelp() {
  console.log(`codex-viewer ${VERSION}

Usage:
  codex-viewer start [--foreground] [--workspace DIR] [--web-host HOST] [--web-port N] [--public-url URL] [--log-file FILE]
  codex-viewer stop [--workspace DIR]
  codex-viewer status [--workspace DIR]
  codex-viewer open [--workspace DIR]
  codex-viewer version
`);
}

function parseArgs(argv) {
  const args = { _: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) {
      args._.push(token);
      continue;
    }

    const key = token.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith('--')) {
      args[key] = true;
      continue;
    }
    args[key] = next;
    index += 1;
  }
  return args;
}

function getWorkspacePath(args) {
  return resolve(args.workspace || process.cwd());
}

function getRuntimeDir(workspacePath) {
  return join(workspacePath, '.codex-viewer');
}

function getStatePath(workspacePath) {
  return join(getRuntimeDir(workspacePath), 'runtime-state.json');
}

function readState(workspacePath) {
  const statePath = getStatePath(workspacePath);
  if (!existsSync(statePath)) return null;
  try {
    return JSON.parse(readFileSync(statePath, 'utf8'));
  } catch {
    return null;
  }
}

function isProcessAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function startCommand(args) {
  const workspacePath = getWorkspacePath(args);
  const runtimeDir = getRuntimeDir(workspacePath);
  mkdirSync(runtimeDir, { recursive: true });

  const existing = readState(workspacePath);
  if (existing?.pid && isProcessAlive(existing.pid)) {
    console.log(`codex-viewer already running for ${workspacePath}`);
    console.log(`Local URL: ${existing.localUrl}`);
    if (existing.publicUrl) console.log(`Public URL: ${existing.publicUrl}`);
    console.log(`Pair URL: ${existing.pairUrl}`);
    if (existing.appLogPath) console.log(`App log: ${existing.appLogPath}`);
    return;
  }
  if (existing?.pid && !isProcessAlive(existing.pid)) {
    rmSync(getStatePath(workspacePath), { force: true });
  }

  const daemonEntry = join(PROJECT_ROOT, 'src', 'daemon.js');
  const daemonArgs = [
    daemonEntry,
    '--workspace', workspacePath,
  ];

  if (args['web-port']) daemonArgs.push('--web-port', String(args['web-port']));
  if (args['web-host']) {
    daemonArgs.push('--web-host', args['web-host'] === true ? '0.0.0.0' : String(args['web-host']));
  }
  if (args['public-url']) daemonArgs.push('--public-url', String(args['public-url']));
  if (args['log-file']) daemonArgs.push('--log-file', String(args['log-file']));

  if (args.foreground) {
    const child = spawn(process.execPath, daemonArgs, {
      cwd: workspacePath,
      stdio: 'inherit',
      env: { ...process.env, CODEX_VIEWER_FOREGROUND: '1' },
    });
    child.on('exit', (code) => process.exit(code ?? 0));
    return;
  }

  const logPath = join(runtimeDir, 'daemon.log');
  const stdoutFd = openSync(logPath, 'a');
  const stderrFd = openSync(logPath, 'a');
  const out = spawn(process.execPath, daemonArgs, {
    cwd: workspacePath,
    detached: true,
    stdio: ['ignore', stdoutFd, stderrFd],
    env: { ...process.env },
  });
  out.unref();

  const startedAt = Date.now();
  const statePath = getStatePath(workspacePath);
  while (Date.now() - startedAt < 5000) {
    const state = readState(workspacePath);
    if (state?.pid === out.pid && state?.localUrl && isProcessAlive(state.pid)) {
      console.log(`codex-viewer started for ${workspacePath}`);
      console.log(`Local URL: ${state.localUrl}`);
      if (state.publicUrl) console.log(`Public URL: ${state.publicUrl}`);
      console.log(`Pair URL: ${state.pairUrl}`);
      console.log(`Runtime state: ${statePath}`);
      console.log(`Daemon log: ${logPath}`);
      if (state.appLogPath) console.log(`App log: ${state.appLogPath}`);
      return;
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
  }

  console.error('codex-viewer failed to start within 5s');
  process.exit(1);
}

function stopCommand(args) {
  const workspacePath = getWorkspacePath(args);
  const state = readState(workspacePath);
  if (!state?.pid) {
    console.log('codex-viewer is not running');
    return;
  }
  if (!isProcessAlive(state.pid)) {
    console.log('codex-viewer state found, but process is not alive');
    rmSync(getStatePath(workspacePath), { force: true });
    return;
  }
  process.kill(state.pid, 'SIGTERM');
  console.log(`stopped codex-viewer (pid ${state.pid})`);
}

function statusCommand(args) {
  const workspacePath = getWorkspacePath(args);
  const state = readState(workspacePath);
  if (!state) {
    console.log('codex-viewer is not running');
    return;
  }
  const alive = isProcessAlive(state.pid);
  if (!alive) {
    rmSync(getStatePath(workspacePath), { force: true });
  }
  console.log(JSON.stringify({
    workspacePath,
    alive,
    ...state,
  }, null, 2));
}

function openCommand(args) {
  const workspacePath = getWorkspacePath(args);
  const state = readState(workspacePath);
  if (!state) {
    console.log('codex-viewer is not running');
    return;
  }
  if (!isProcessAlive(state.pid)) {
    rmSync(getStatePath(workspacePath), { force: true });
    console.log('codex-viewer is not running');
    return;
  }
  console.log(`Local URL: ${state.localUrl}`);
  if (state.publicUrl) console.log(`Public URL: ${state.publicUrl}`);
  console.log(`Pair URL: ${state.pairUrl}`);
  if (state.appLogPath) console.log(`App log: ${state.appLogPath}`);
}

const args = parseArgs(process.argv.slice(2));
const command = args._[0] || 'start';

switch (command) {
  case 'start':
    startCommand(args);
    break;
  case 'stop':
    stopCommand(args);
    break;
  case 'status':
    statusCommand(args);
    break;
  case 'open':
    openCommand(args);
    break;
  case 'version':
  case '--version':
  case '-v':
    console.log(VERSION);
    break;
  case 'help':
  case '--help':
  case '-h':
    printHelp();
    break;
  default:
    printHelp();
    process.exit(1);
}
