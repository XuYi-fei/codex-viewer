import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

export function createRuntimePaths(workspacePath) {
  const root = join(resolve(workspacePath), '.codex-viewer');
  const logsDir = join(root, 'logs');
  const dataDir = join(root, 'data');
  mkdirSync(root, { recursive: true });
  mkdirSync(logsDir, { recursive: true });
  mkdirSync(dataDir, { recursive: true });
  return {
    root,
    logsDir,
    dataDir,
    statePath: join(root, 'runtime-state.json'),
    threadDetailsPath: join(dataDir, 'thread-details.json'),
    rawLogPath: join(logsDir, 'raw-requests.jsonl'),
    appLogPath: join(logsDir, 'codex-viewer.log'),
    daemonLogPath: join(root, 'daemon.log'),
  };
}

export function writeRuntimeState(statePath, state) {
  writeFileSync(statePath, JSON.stringify(state, null, 2));
}

export function readRuntimeState(statePath) {
  if (!existsSync(statePath)) return null;
  try {
    return JSON.parse(readFileSync(statePath, 'utf8'));
  } catch {
    return null;
  }
}
