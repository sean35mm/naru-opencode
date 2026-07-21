import { lstat, mkdir, readFile, realpath, rm, writeFile, copyFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';

import { isSchedulerId, isSafeScope } from './scheduler-protocol.mjs';
import { scopeCoversPath } from './scheduler-state.mjs';
import { run } from './transport.mjs';

const MAX_WRITERS = 10;
const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;
const REGISTRY_KEY = Symbol.for('naru.worktree.registry.v1');

function registry() {
  globalThis[REGISTRY_KEY] ??= new Map();
  return globalThis[REGISTRY_KEY];
}

function safeId(value, label) {
  if (!isSchedulerId(value)) throw new Error(`${label} is not a safe identifier`);
  return value;
}

function assertAbsolute(path, label) {
  if (typeof path !== 'string' || !path.startsWith('/') || path.includes('\0')) {
    throw new Error(`${label} must be an absolute path`);
  }
  return path;
}

function parseNul(text) {
  if (!text) return [];
  const values = text.split('\0');
  if (values.at(-1) === '') values.pop();
  return values;
}

async function git(args, { cwd, input, spawn, label }) {
  const result = await run(['git', '--no-pager', '-c', 'color.ui=false', ...args], {
    cwd,
    input,
    maxBytes: MAX_OUTPUT_BYTES,
    timeout: 120000,
    spawn,
  });
  if (!result.ok || result.stdoutTruncated || result.stderrTruncated) {
    const detail = (result.stderr || result.stdout || `exit ${result.code}`).trim();
    throw new Error(`${label} failed: ${detail}`);
  }
  return result.stdout;
}

function inside(root, path) {
  const rel = relative(root, path);
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !rel.startsWith(sep));
}

async function repositoryIdentity(directory, spawn) {
  assertAbsolute(directory, 'directory');
  const top = (await git(['rev-parse', '--show-toplevel'], {
    cwd: directory,
    spawn,
    label: 'repository discovery',
  })).trim();
  const repository = await realpath(top);
  const baseSha = (await git(['rev-parse', 'HEAD'], {
    cwd: repository,
    spawn,
    label: 'baseline revision',
  })).trim();
  if (!/^[a-f0-9]{40}$/.test(baseSha)) throw new Error('baseline revision is not a full commit SHA');
  return { repository, baseSha };
}

async function canonicalRepository(directory, spawn) {
  const identity = await repositoryIdentity(directory, spawn);
  const status = await git(['status', '--porcelain=v1', '-z', '--untracked-files=all'], {
    cwd: identity.repository,
    spawn,
    label: 'workspace status',
  });
  if (status !== '') throw new Error('isolated writer mode requires a clean workspace');
  return identity;
}

async function writeMetadata(runState) {
  const data = {
    schemaVersion: 1,
    runId: runState.runId,
    repository: runState.repository,
    baseSha: runState.baseSha,
    integrationPath: runState.integrationPath,
    maxWriters: runState.maxWriters,
    finalized: runState.finalized,
    faulted: runState.faulted,
    items: [...runState.items.values()].map((item) => ({
      itemId: item.itemId,
      path: item.path,
      ownedWriteScope: item.ownedWriteScope,
      integrated: item.integrated,
      changedPaths: item.changedPaths,
    })),
  };
  await writeFile(join(runState.runRoot, '.naru-run.json'), `${JSON.stringify(data, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
}

async function runRootFor(worktreeRoot, repository, runId, { create = false } = {}) {
  const configuredRoot = resolve(worktreeRoot ?? join(homedir(), '.worktrees'));
  if (create) await mkdir(configuredRoot, { recursive: true, mode: 0o700 });
  const canonicalRoot = await realpath(configuredRoot);
  const parent = join(canonicalRoot, basename(repository), 'naru');
  if (create) await mkdir(parent, { recursive: true, mode: 0o700 });
  const runRoot = join(parent, runId);
  if (!inside(canonicalRoot, runRoot)) throw new Error('derived worktree path escapes its configured root');
  if (create) await mkdir(runRoot, { mode: 0o700 });
  return runRoot;
}

function publicRun(runState) {
  return {
    runId: runState.runId,
    repository: runState.repository,
    baseSha: runState.baseSha,
    integrationPath: runState.integrationPath,
    maxWriters: runState.maxWriters,
    finalized: runState.finalized,
    faulted: runState.faulted,
    items: [...runState.items.values()].map((item) => ({
      itemId: item.itemId,
      path: item.path,
      ownedWriteScope: [...item.ownedWriteScope],
      integrated: item.integrated,
      changedPaths: [...item.changedPaths],
    })),
  };
}

function stateFor(runId, stateRegistry = registry()) {
  const state = stateRegistry.get(runId);
  if (!state) throw new Error(`unknown worktree run: ${runId}`);
  return state;
}

export async function createWorktreeRun({
  directory,
  runId,
  maxWriters = 6,
  worktreeRoot,
  spawn,
  stateRegistry = registry(),
}) {
  safeId(runId, 'runId');
  if (!Number.isSafeInteger(maxWriters) || maxWriters < 1 || maxWriters > MAX_WRITERS) {
    throw new Error(`maxWriters must be an integer from 1 to ${MAX_WRITERS}`);
  }
  if (stateRegistry.has(runId)) throw new Error(`worktree run already exists: ${runId}`);
  const { repository, baseSha } = await canonicalRepository(directory, spawn);
  const runRoot = await runRootFor(worktreeRoot, repository, runId, { create: true });
  const integrationPath = join(runRoot, 'integration');
  try {
    await git(['worktree', 'add', '--detach', integrationPath, baseSha], {
      cwd: repository,
      spawn,
      label: 'integration worktree creation',
    });
  } catch (error) {
    await rm(runRoot, { recursive: true, force: true });
    throw error;
  }
  const runState = {
    runId,
    repository,
    baseSha,
    runRoot,
    integrationPath,
    maxWriters,
    items: new Map(),
    integratedPaths: new Set(),
    finalized: false,
    faulted: false,
  };
  stateRegistry.set(runId, runState);
  await writeMetadata(runState);
  return publicRun(runState);
}

export async function createWriterWorktree({ runId, itemId, ownedWriteScope, spawn, stateRegistry = registry() }) {
  safeId(itemId, 'itemId');
  const runState = stateFor(runId, stateRegistry);
  if (runState.finalized || runState.faulted) throw new Error('worktree run is not writable');
  if (runState.items.has(itemId)) throw new Error(`writer worktree already exists: ${itemId}`);
  if (runState.items.size >= runState.maxWriters) throw new Error('writer worktree limit exhausted');
  if (!Array.isArray(ownedWriteScope) || ownedWriteScope.length === 0 || ownedWriteScope.length > 128) {
    throw new Error('ownedWriteScope must be a bounded non-empty array');
  }
  for (const scope of ownedWriteScope) {
    if (!isSafeScope(scope)) throw new Error(`ownedWriteScope contains an unsafe scope: ${scope}`);
  }
  const path = join(runState.runRoot, 'items', itemId);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await git(['worktree', 'add', '--detach', path, runState.baseSha], {
    cwd: runState.repository,
    spawn,
    label: `writer worktree creation for ${itemId}`,
  });
  runState.items.set(itemId, {
    itemId,
    path,
    ownedWriteScope: [...ownedWriteScope],
    integrated: false,
    changedPaths: [],
  });
  await writeMetadata(runState);
  return publicRun(runState).items.find((item) => item.itemId === itemId);
}

async function changesAt(path, spawn) {
  const tracked = parseNul(await git(['diff', '--name-only', '-z', 'HEAD', '--', '.'], {
    cwd: path,
    spawn,
    label: 'tracked changed-path discovery',
  }));
  const untracked = parseNul(await git(['ls-files', '--others', '--exclude-standard', '-z', '--', '.'], {
    cwd: path,
    spawn,
    label: 'untracked changed-path discovery',
  }));
  return { tracked, untracked, all: [...new Set([...tracked, ...untracked])].sort() };
}

async function rejectSymlinks(root, paths) {
  for (const path of paths) {
    let stats;
    try {
      stats = await lstat(join(root, path));
    } catch (error) {
      if (error?.code === 'ENOENT') continue;
      throw error;
    }
    if (stats.isSymbolicLink()) throw new Error(`changed path is a symbolic link: ${path}`);
    if (!stats.isFile()) throw new Error(`changed path is not a regular file: ${path}`);
  }
}

function assertContained(item, changedPaths) {
  for (const path of changedPaths) {
    if (!isSafeScope(path, { allowGlob: false })) throw new Error(`changed path is unsafe: ${path}`);
    if (!item.ownedWriteScope.some((scope) => scopeCoversPath(scope, path))) {
      throw new Error(`changed path is outside ${item.itemId} ownership: ${path}`);
    }
  }
}

async function trackedPatch(path, spawn) {
  return git(['diff', '--binary', '--full-index', '--no-ext-diff', 'HEAD', '--', '.'], {
    cwd: path,
    spawn,
    label: 'writer patch capture',
  });
}

async function applyPatch(target, patch, spawn, checkOnly = false) {
  if (!patch) return;
  const args = ['apply', '--binary', '--whitespace=nowarn'];
  if (checkOnly) args.push('--check');
  args.push('-');
  await git(args, { cwd: target, input: patch, spawn, label: checkOnly ? 'patch preflight' : 'patch application' });
}

async function copyUntracked(source, target, paths) {
  await rejectSymlinks(source, paths);
  for (const path of paths) {
    const destination = join(target, path);
    await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
    await copyFile(join(source, path), destination);
  }
}

export async function integrateWriterWorktree({ runId, itemId, spawn, stateRegistry = registry() }) {
  const runState = stateFor(runId, stateRegistry);
  if (runState.finalized || runState.faulted) throw new Error('worktree run cannot integrate more items');
  const item = runState.items.get(itemId);
  if (!item) throw new Error(`unknown writer worktree: ${itemId}`);
  if (item.integrated) throw new Error(`writer worktree is already integrated: ${itemId}`);
  const changes = await changesAt(item.path, spawn);
  assertContained(item, changes.all);
  await rejectSymlinks(item.path, changes.all);
  const overlap = changes.all.filter((path) => runState.integratedPaths.has(path));
  if (overlap.length) throw new Error(`writer changes overlap previously integrated paths: ${overlap.join(', ')}`);
  const patch = await trackedPatch(item.path, spawn);
  try {
    await applyPatch(runState.integrationPath, patch, spawn, true);
    for (const path of changes.untracked) {
      try {
        await lstat(join(runState.integrationPath, path));
        throw new Error(`untracked path already exists in integration workspace: ${path}`);
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
      }
    }
    await applyPatch(runState.integrationPath, patch, spawn, false);
    await copyUntracked(item.path, runState.integrationPath, changes.untracked);
  } catch (error) {
    runState.faulted = true;
    await writeMetadata(runState);
    throw error;
  }
  item.integrated = true;
  item.changedPaths = changes.all;
  for (const path of changes.all) runState.integratedPaths.add(path);
  await writeMetadata(runState);
  return { itemId, changedPaths: [...changes.all], integrationPath: runState.integrationPath };
}

export async function finalizeWorktreeRun({ runId, spawn, stateRegistry = registry() }) {
  const runState = stateFor(runId, stateRegistry);
  if (runState.finalized || runState.faulted) throw new Error('worktree run cannot be finalized');
  const incomplete = [...runState.items.values()].filter((item) => !item.integrated).map((item) => item.itemId);
  if (incomplete.length) throw new Error(`writer worktrees are not integrated: ${incomplete.join(', ')}`);
  const status = await git(['status', '--porcelain=v1', '-z', '--untracked-files=all'], {
    cwd: runState.repository,
    spawn,
    label: 'final workspace status',
  });
  if (status !== '') throw new Error('main workspace changed during isolated writer run');
  const head = (await git(['rev-parse', 'HEAD'], {
    cwd: runState.repository,
    spawn,
    label: 'final workspace revision',
  })).trim();
  if (head !== runState.baseSha) throw new Error('main workspace revision changed during isolated writer run');
  const changes = await changesAt(runState.integrationPath, spawn);
  const unexpected = changes.all.filter((path) => !runState.integratedPaths.has(path));
  if (unexpected.length) throw new Error(`integration workspace contains unowned changes: ${unexpected.join(', ')}`);
  const patch = await trackedPatch(runState.integrationPath, spawn);
  await rejectSymlinks(runState.integrationPath, changes.all);
  await applyPatch(runState.repository, patch, spawn, true);
  for (const path of changes.untracked) {
    try {
      await lstat(join(runState.repository, path));
      throw new Error(`untracked path already exists in main workspace: ${path}`);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }
  try {
    await applyPatch(runState.repository, patch, spawn, false);
    await copyUntracked(runState.integrationPath, runState.repository, changes.untracked);
  } catch (error) {
    runState.faulted = true;
    await writeMetadata(runState);
    throw error;
  }
  runState.finalized = true;
  await writeMetadata(runState);
  return { runId, changedPaths: changes.all, finalized: true };
}

export async function recoverWorktreeRun({
  directory,
  runId,
  worktreeRoot,
  spawn,
  stateRegistry = registry(),
}) {
  safeId(runId, 'runId');
  if (stateRegistry.has(runId)) throw new Error(`worktree run already exists: ${runId}`);
  const { repository, baseSha } = await repositoryIdentity(directory, spawn);
  const runRoot = await runRootFor(worktreeRoot, repository, runId);
  const metadata = await readWorktreeMetadata(join(runRoot, '.naru-run.json'));
  const integrationPath = join(runRoot, 'integration');
  if (metadata?.schemaVersion !== 1 || metadata.runId !== runId) throw new Error('invalid worktree run metadata');
  if (metadata.repository !== repository || metadata.baseSha !== baseSha) {
    throw new Error('worktree run metadata does not match the current repository revision');
  }
  if (metadata.integrationPath !== integrationPath) throw new Error('worktree run metadata has an unsafe integration path');
  if (!Number.isSafeInteger(metadata.maxWriters) || metadata.maxWriters < 1 || metadata.maxWriters > MAX_WRITERS) {
    throw new Error('worktree run metadata has an invalid writer limit');
  }
  if (!Array.isArray(metadata.items) || metadata.items.length > metadata.maxWriters) {
    throw new Error('worktree run metadata has invalid writer items');
  }
  if (typeof metadata.finalized !== 'boolean' || typeof metadata.faulted !== 'boolean') {
    throw new Error('worktree run metadata has invalid state flags');
  }
  if (await realpath(integrationPath) !== integrationPath) throw new Error('integration worktree path is not canonical');

  const items = new Map();
  const integratedPaths = new Set();
  for (const persisted of metadata.items) {
    safeId(persisted?.itemId, 'itemId');
    if (items.has(persisted.itemId)) throw new Error(`duplicate writer item in metadata: ${persisted.itemId}`);
    const path = join(runRoot, 'items', persisted.itemId);
    if (persisted.path !== path || await realpath(path) !== path) {
      throw new Error(`writer worktree metadata has an unsafe path: ${persisted.itemId}`);
    }
    if (!Array.isArray(persisted.ownedWriteScope) || persisted.ownedWriteScope.length === 0) {
      throw new Error(`writer worktree metadata has invalid ownership: ${persisted.itemId}`);
    }
    if (!persisted.ownedWriteScope.every((scope) => isSafeScope(scope))) {
      throw new Error(`writer worktree metadata has unsafe ownership: ${persisted.itemId}`);
    }
    if (typeof persisted.integrated !== 'boolean' || !Array.isArray(persisted.changedPaths)) {
      throw new Error(`writer worktree metadata has invalid state: ${persisted.itemId}`);
    }
    const item = {
      itemId: persisted.itemId,
      path,
      ownedWriteScope: [...persisted.ownedWriteScope],
      integrated: persisted.integrated,
      changedPaths: [...persisted.changedPaths],
    };
    assertContained(item, item.changedPaths);
    if (!item.integrated && item.changedPaths.length) {
      throw new Error(`unintegrated writer has persisted changed paths: ${item.itemId}`);
    }
    items.set(item.itemId, item);
    if (item.integrated) for (const changedPath of item.changedPaths) integratedPaths.add(changedPath);
  }

  const runState = {
    runId,
    repository,
    baseSha,
    runRoot,
    integrationPath,
    maxWriters: metadata.maxWriters,
    items,
    integratedPaths,
    finalized: metadata.finalized,
    faulted: metadata.faulted,
  };
  stateRegistry.set(runId, runState);
  return publicRun(runState);
}

export async function cleanupWorktreeRun({ runId, spawn, stateRegistry = registry() }) {
  const runState = stateFor(runId, stateRegistry);
  if (!runState.finalized) throw new Error('refusing to remove worktrees before successful finalization');
  for (const item of runState.items.values()) {
    await git(['worktree', 'remove', '--force', item.path], {
      cwd: runState.repository,
      spawn,
      label: `writer worktree cleanup for ${item.itemId}`,
    });
  }
  await git(['worktree', 'remove', '--force', runState.integrationPath], {
    cwd: runState.repository,
    spawn,
    label: 'integration worktree cleanup',
  });
  await rm(runState.runRoot, { recursive: true, force: true });
  stateRegistry.delete(runId);
  return { runId, cleaned: true };
}

export function worktreeRunSnapshot(runId, stateRegistry = registry()) {
  return publicRun(stateFor(runId, stateRegistry));
}

export function resetWorktreeRegistryForTests(stateRegistry = registry()) {
  stateRegistry.clear();
}

export async function readWorktreeMetadata(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}
