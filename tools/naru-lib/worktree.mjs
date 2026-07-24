import { constants as fsConstants } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { lstat, mkdir, open, readFile, realpath, rename, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';

import { isSchedulerId, isSafeScope } from './scheduler-protocol.mjs';
import { scopeCoversPath } from './scheduler-state.mjs';
import { run } from './transport.mjs';

const MAX_WRITERS = 50;
const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;
// Isolated worktrees are for source changes, not transferring arbitrarily large artifacts.
const MAX_UNTRACKED_FILE_BYTES = 64 * 1024 * 1024;
const NO_HOOKS_PATH = '/dev/null';
const METADATA_FILE = '.naru-run.json';
const REGISTRY_KEY = Symbol.for('naru.worktree.registry.v1');
const RUN_LOCKS = new Map();

function registry() {
  globalThis[REGISTRY_KEY] ??= new Map();
  return globalThis[REGISTRY_KEY];
}

async function withRunLock(runId, operation) {
  const previous = RUN_LOCKS.get(runId) ?? Promise.resolve();
  let release;
  const gate = new Promise((resolveGate) => {
    release = resolveGate;
  });
  const tail = previous.catch(() => {}).then(() => gate);
  RUN_LOCKS.set(runId, tail);
  await previous.catch(() => {});
  try {
    return await operation();
  } finally {
    release();
    if (RUN_LOCKS.get(runId) === tail) RUN_LOCKS.delete(runId);
  }
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

async function addWorktree(repository, path, baseSha, spawn, label) {
  await git(['-c', `core.hooksPath=${NO_HOOKS_PATH}`, 'worktree', 'add', '--detach', path, baseSha], {
    cwd: repository,
    spawn,
    label,
  });
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
  const metadataPath = join(runState.runRoot, METADATA_FILE);
  const temporaryPath = join(
    runState.runRoot,
    `.naru-run.${process.pid}.${randomBytes(8).toString('hex')}.tmp`,
  );
  let handle;
  try {
    handle = await open(
      temporaryPath,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | (fsConstants.O_NOFOLLOW ?? 0),
      0o600,
    );
    await handle.writeFile(`${JSON.stringify(data, null, 2)}\n`, 'utf8');
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporaryPath, metadataPath);
  } catch (error) {
    await handle?.close().catch(() => {});
    await rm(temporaryPath, { force: true }).catch(() => {});
    throw error;
  }
}

async function runRootFor(worktreeRoot, repository, runId, { create = false } = {}) {
  const configuredRoot = resolve(worktreeRoot ?? join(homedir(), '.worktrees'));
  if (create) await mkdir(configuredRoot, { recursive: true, mode: 0o700 });
  const canonicalRoot = await realpath(configuredRoot);

  const validateSegment = async (path, label, { exclusive = false } = {}) => {
    if (!inside(canonicalRoot, path)) throw new Error('derived worktree path escapes its configured root');
    let created = false;
    if (create) {
      try {
        await mkdir(path, { mode: 0o700 });
        created = true;
      } catch (error) {
        if (error?.code !== 'EEXIST') throw error;
      }
    }
    const status = await lstat(path);
    if (status.isSymbolicLink()) throw new Error(`${label} must not be a symbolic link`);
    if (!status.isDirectory()) throw new Error(`${label} must be a directory`);
    const canonicalPath = await realpath(path);
    if (canonicalPath !== path || !inside(canonicalRoot, canonicalPath)) {
      throw new Error(`${label} is not a canonical descendant of its configured root`);
    }
    if (exclusive && !created) throw new Error(`${label} already exists`);
  };

  const repositoryRoot = join(canonicalRoot, basename(repository));
  await validateSegment(repositoryRoot, 'repository worktree directory');
  const parent = join(repositoryRoot, 'naru');
  await validateSegment(parent, 'Naru worktree directory');
  const runRoot = join(parent, runId);
  await validateSegment(runRoot, 'worktree run directory', { exclusive: create });
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

async function createWorktreeRunUnlocked({
  directory,
  runId,
  maxWriters = 10,
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
    await addWorktree(repository, integrationPath, baseSha, spawn, 'integration worktree creation');
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
  try {
    await writeMetadata(runState);
  } catch (error) {
    stateRegistry.delete(runId);
    await git(['worktree', 'remove', '--force', integrationPath], {
      cwd: repository,
      spawn,
      label: 'failed integration worktree cleanup',
    }).catch(() => {});
    await rm(runRoot, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
  return publicRun(runState);
}

async function createWriterWorktreeUnlocked({ runId, itemId, ownedWriteScope, spawn, stateRegistry }) {
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
  await addWorktree(runState.repository, path, runState.baseSha, spawn, `writer worktree creation for ${itemId}`);
  runState.items.set(itemId, {
    itemId,
    path,
    ownedWriteScope: [...ownedWriteScope],
    integrated: false,
    changedPaths: [],
  });
  try {
    await writeMetadata(runState);
  } catch (error) {
    runState.items.delete(itemId);
    await git(['worktree', 'remove', '--force', path], {
      cwd: runState.repository,
      spawn,
      label: `failed writer worktree cleanup for ${itemId}`,
    }).catch(() => {});
    throw error;
  }
  return publicRun(runState).items.find((item) => item.itemId === itemId);
}

async function changesAt(path, spawn) {
  const tracked = parseNul(await git(['diff', '--name-only', '-z', 'HEAD', '--', '.'], {
    cwd: path,
    spawn,
    label: 'tracked changed-path discovery',
  })).sort();
  const untracked = parseNul(await git(['ls-files', '--others', '--exclude-standard', '-z', '--', '.'], {
    cwd: path,
    spawn,
    label: 'untracked changed-path discovery',
  })).sort();
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

async function applyPatch(target, patch, spawn, checkOnly = false, reverse = false) {
  if (!patch) return;
  const args = ['apply', '--binary', '--whitespace=nowarn'];
  if (reverse) args.push('--reverse');
  if (checkOnly) args.push('--check');
  args.push('-');
  const action = reverse ? 'patch rollback' : 'patch application';
  await git(args, { cwd: target, input: patch, spawn, label: checkOnly ? `${action} preflight` : action });
}

async function safeAncestor(root, relativePath, { create }) {
  const canonicalRoot = await realpath(root);
  if (canonicalRoot !== root) throw new Error(`copy root is not canonical: ${root}`);
  const parent = dirname(relativePath);
  if (parent === '.') return root;
  let current = root;
  for (const segment of parent.split(sep)) {
    current = join(current, segment);
    let stats;
    try {
      stats = await lstat(current);
    } catch (error) {
      if (error?.code !== 'ENOENT' || !create) throw error;
      try {
        await mkdir(current, { mode: 0o700 });
      } catch (mkdirError) {
        if (mkdirError?.code !== 'EEXIST') throw mkdirError;
      }
      stats = await lstat(current);
    }
    if (stats.isSymbolicLink() || !stats.isDirectory()) {
      throw new Error(`copy path has an unsafe ancestor: ${relativePath}`);
    }
    const canonical = await realpath(current);
    if (canonical !== current || !inside(canonicalRoot, canonical)) {
      throw new Error(`copy path escapes its root: ${relativePath}`);
    }
  }
  return current;
}

async function copyRegularFile(source, target, path, created) {
  const sourceParent = await safeAncestor(source, path, { create: false });
  const targetParent = await safeAncestor(target, path, { create: true });
  const sourcePath = join(source, path);
  const destination = join(target, path);
  let sourceHandle;
  let destinationHandle;
  let record;
  try {
    sourceHandle = await open(sourcePath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    const sourceStats = await sourceHandle.stat({ bigint: true });
    if (!sourceStats.isFile()) throw new Error(`changed path is not a regular file: ${path}`);
    const sourcePathStats = await lstat(sourcePath, { bigint: true });
    if (
      await realpath(sourceParent) !== sourceParent
      || sourcePathStats.dev !== sourceStats.dev
      || sourcePathStats.ino !== sourceStats.ino
    ) {
      throw new Error(`untracked source escaped its root while opening: ${path}`);
    }
    if (sourceStats.size > BigInt(MAX_UNTRACKED_FILE_BYTES)) {
      throw new Error(`untracked file exceeds ${MAX_UNTRACKED_FILE_BYTES} bytes: ${path}`);
    }
    try {
      destinationHandle = await open(
        destination,
        fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | (fsConstants.O_NOFOLLOW ?? 0),
        Number(sourceStats.mode & 0o777n),
      );
    } catch (error) {
      if (error?.code === 'EEXIST') throw new Error(`untracked path already exists in target workspace: ${path}`);
      throw error;
    }
    record = {
      path,
      destination,
      dev: undefined,
      ino: undefined,
      expected: undefined,
    };
    created.push(record);
    const destinationStats = await destinationHandle.stat({ bigint: true });
    record.dev = destinationStats.dev;
    record.ino = destinationStats.ino;
    const destinationPathStats = await lstat(destination, { bigint: true });
    if (
      await realpath(targetParent) !== targetParent
      || destinationPathStats.dev !== destinationStats.dev
      || destinationPathStats.ino !== destinationStats.ino
    ) {
      throw new Error(`untracked target escaped its root while opening: ${path}`);
    }

    const buffer = Buffer.allocUnsafe(64 * 1024);
    let position = 0;
    const expectedSize = Number(sourceStats.size);
    while (position < expectedSize) {
      const length = Math.min(buffer.length, expectedSize - position);
      const { bytesRead } = await sourceHandle.read(buffer, 0, length, position);
      if (bytesRead === 0) throw new Error(`untracked source changed while copying: ${path}`);
      let written = 0;
      while (written < bytesRead) {
        const result = await destinationHandle.write(buffer, written, bytesRead - written, position + written);
        if (result.bytesWritten === 0) throw new Error(`untracked target stopped accepting data: ${path}`);
        written += result.bytesWritten;
      }
      position += bytesRead;
    }
    const extra = await sourceHandle.read(Buffer.allocUnsafe(1), 0, 1, position);
    const finalSourceStats = await sourceHandle.stat({ bigint: true });
    if (
      extra.bytesRead !== 0
      || finalSourceStats.dev !== sourceStats.dev
      || finalSourceStats.ino !== sourceStats.ino
      || finalSourceStats.size !== sourceStats.size
      || finalSourceStats.mtimeNs !== sourceStats.mtimeNs
    ) {
      throw new Error(`untracked source changed while copying: ${path}`);
    }
    await destinationHandle.sync();
  } finally {
    if (destinationHandle) {
      try {
        record.expected = await destinationHandle.stat({ bigint: true });
      } finally {
        await destinationHandle.close().catch(() => {});
      }
    }
    await sourceHandle?.close().catch(() => {});
  }
}

async function copyUntracked(source, target, paths, created) {
  for (const path of paths) await copyRegularFile(source, target, path, created);
}

function sameCreatedFile(stats, record) {
  return record.expected
    && stats.isFile()
    && stats.dev === record.dev
    && stats.ino === record.ino
    && stats.size === record.expected.size
    && stats.mtimeNs === record.expected.mtimeNs;
}

async function rollbackMutation(target, patch, created, spawn) {
  const residuals = [];
  for (const record of [...created].reverse()) {
    try {
      await safeAncestor(target, record.path, { create: false });
      const stats = await lstat(record.destination, { bigint: true });
      if (!sameCreatedFile(stats, record)) {
        residuals.push(`${record.path} changed after creation`);
        continue;
      }
      await rm(record.destination);
    } catch (error) {
      if (error?.code !== 'ENOENT') residuals.push(`${record.path}: ${error.message}`);
    }
  }
  if (patch) {
    try {
      await applyPatch(target, patch, spawn, true, true);
      await applyPatch(target, patch, spawn, false, true);
    } catch (error) {
      residuals.push(`tracked patch: ${error.message}`);
    }
  }
  return residuals;
}

async function faultAfterRollback(runState, error, target, patch, created, spawn) {
  const residuals = await rollbackMutation(target, patch, created, spawn);
  runState.faulted = true;
  try {
    await writeMetadata(runState);
  } catch (metadataError) {
    residuals.push(`fault metadata: ${metadataError.message}`);
  }
  const rollback = residuals.length ? `rollback residual: ${residuals.join('; ')}` : 'rollback completed';
  throw new Error(`${error instanceof Error ? error.message : String(error)}; ${rollback}`, { cause: error });
}

async function integrateWriterWorktreeUnlocked({ runId, itemId, spawn, stateRegistry }) {
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
  const created = [];
  let patchApplied = false;
  try {
    await applyPatch(runState.integrationPath, patch, spawn, true);
    await applyPatch(runState.integrationPath, patch, spawn, false);
    patchApplied = Boolean(patch);
    await copyUntracked(item.path, runState.integrationPath, changes.untracked, created);
    item.integrated = true;
    item.changedPaths = changes.all;
    for (const path of changes.all) runState.integratedPaths.add(path);
    await writeMetadata(runState);
  } catch (error) {
    item.integrated = false;
    item.changedPaths = [];
    for (const path of changes.all) runState.integratedPaths.delete(path);
    await faultAfterRollback(runState, error, runState.integrationPath, patchApplied ? patch : '', created, spawn);
  }
  return { itemId, changedPaths: [...changes.all], integrationPath: runState.integrationPath };
}

async function finalizeWorktreeRunUnlocked({ runId, spawn, stateRegistry }) {
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
  const created = [];
  let patchApplied = false;
  try {
    await applyPatch(runState.repository, patch, spawn, false);
    patchApplied = Boolean(patch);
    await copyUntracked(runState.integrationPath, runState.repository, changes.untracked, created);
    runState.finalized = true;
    await writeMetadata(runState);
  } catch (error) {
    runState.finalized = false;
    await faultAfterRollback(runState, error, runState.repository, patchApplied ? patch : '', created, spawn);
  }
  return { runId, changedPaths: changes.all, finalized: true };
}

async function recoverWorktreeRunUnlocked({
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
  const metadata = await readWorktreeMetadata(join(runRoot, METADATA_FILE));
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
  if (metadata.finalized && metadata.faulted) throw new Error('worktree run metadata has inconsistent state flags');
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
    if (
      !Array.isArray(persisted.ownedWriteScope)
      || persisted.ownedWriteScope.length === 0
      || persisted.ownedWriteScope.length > 128
    ) {
      throw new Error(`writer worktree metadata has invalid ownership: ${persisted.itemId}`);
    }
    if (!persisted.ownedWriteScope.every((scope) => isSafeScope(scope))) {
      throw new Error(`writer worktree metadata has unsafe ownership: ${persisted.itemId}`);
    }
    if (
      typeof persisted.integrated !== 'boolean'
      || !Array.isArray(persisted.changedPaths)
      || persisted.changedPaths.length > 65536
      || new Set(persisted.changedPaths).size !== persisted.changedPaths.length
    ) {
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
    if (item.integrated) {
      for (const changedPath of item.changedPaths) {
        if (integratedPaths.has(changedPath)) {
          throw new Error(`integrated writer paths overlap in metadata: ${changedPath}`);
        }
        integratedPaths.add(changedPath);
      }
    }
  }
  if (metadata.finalized && [...items.values()].some((item) => !item.integrated)) {
    throw new Error('finalized worktree run metadata contains unintegrated writers');
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

async function cleanupWorktreeRunUnlocked({ runId, spawn, stateRegistry }) {
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
  let metadata;
  try {
    metadata = JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error('invalid worktree run metadata: malformed JSON', { cause: error });
    throw error;
  }
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
    throw new Error('invalid worktree run metadata');
  }
  return metadata;
}

export async function createWorktreeRun(options) {
  const stateRegistry = options.stateRegistry ?? registry();
  return withRunLock(options.runId, () => createWorktreeRunUnlocked({ ...options, stateRegistry }));
}

export async function createWriterWorktree(options) {
  const stateRegistry = options.stateRegistry ?? registry();
  return withRunLock(options.runId, () => createWriterWorktreeUnlocked({ ...options, stateRegistry }));
}

export async function integrateWriterWorktree(options) {
  const stateRegistry = options.stateRegistry ?? registry();
  return withRunLock(options.runId, () => integrateWriterWorktreeUnlocked({ ...options, stateRegistry }));
}

export async function finalizeWorktreeRun(options) {
  const stateRegistry = options.stateRegistry ?? registry();
  return withRunLock(options.runId, () => finalizeWorktreeRunUnlocked({ ...options, stateRegistry }));
}

export async function recoverWorktreeRun(options) {
  const stateRegistry = options.stateRegistry ?? registry();
  return withRunLock(options.runId, () => recoverWorktreeRunUnlocked({ ...options, stateRegistry }));
}

export async function cleanupWorktreeRun(options) {
  const stateRegistry = options.stateRegistry ?? registry();
  return withRunLock(options.runId, () => cleanupWorktreeRunUnlocked({ ...options, stateRegistry }));
}
