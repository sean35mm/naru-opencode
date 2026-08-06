import { constants as fsConstants } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { lstat, mkdir, open, readFile, realpath, rename, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';

import { isSchedulerId, isSafeScope } from './scheduler-protocol.mjs';
import { scopeCoversPath } from './scheduler-state.mjs';
import { run } from './transport.mjs';
import type { BigIntStats } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import type { SpawnAdapter } from './transport.mjs';

const MAX_WRITERS = 50;
const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;
// Isolated worktrees are for source changes, not transferring arbitrarily large artifacts.
const MAX_UNTRACKED_FILE_BYTES = 64 * 1024 * 1024;
const NO_HOOKS_PATH = '/dev/null';
const METADATA_FILE = '.naru-run.json';
const REGISTRY_KEY = Symbol.for('naru.worktree.registry.v1');
const RUN_LOCKS = new Map<string, Promise<void>>();

type UnknownRecord = Record<string, unknown>;

export interface RepositoryIdentity {
  repository: string;
  baseSha: string;
}

export interface WorktreeItemState {
  itemId: string;
  path: string;
  ownedWriteScope: string[];
  integrated: boolean;
  changedPaths: string[];
}

export interface WorktreeRunState extends RepositoryIdentity {
  runId: string;
  runRoot: string;
  integrationPath: string;
  maxWriters: number;
  items: Map<string, WorktreeItemState>;
  integratedPaths: Set<string>;
  finalized: boolean;
  faulted: boolean;
}

export type WorktreeRegistry = Map<string, WorktreeRunState>;

export interface WorktreeItemSnapshot {
  itemId: string;
  path: string;
  ownedWriteScope: string[];
  integrated: boolean;
  changedPaths: string[];
}

export interface WorktreeRunSnapshot extends RepositoryIdentity {
  runId: string;
  integrationPath: string;
  maxWriters: number;
  finalized: boolean;
  faulted: boolean;
  items: WorktreeItemSnapshot[];
}

export interface PersistedWorktreeItem {
  itemId: string;
  path: string;
  ownedWriteScope: string[];
  integrated: boolean;
  changedPaths: string[];
}

export interface WorktreeMetadata extends UnknownRecord {
  schemaVersion: 1;
  runId: string;
  repository: string;
  baseSha: string;
  integrationPath: string;
  maxWriters: number;
  finalized: boolean;
  faulted: boolean;
  items: PersistedWorktreeItem[];
}

interface GitOptions {
  cwd: string;
  input?: string | undefined;
  spawn?: SpawnAdapter | undefined;
  label: string;
}

interface RunRootOptions {
  create?: boolean;
}

interface SegmentOptions {
  exclusive?: boolean;
}

interface CopyRecord {
  path: string;
  destination: string;
  dev?: bigint | undefined;
  ino?: bigint | undefined;
  expected?: BigIntStats | undefined;
}

type WorktreeGlobal = typeof globalThis & {
  [REGISTRY_KEY]?: WorktreeRegistry;
};

interface WorktreeCommonOptions {
  runId: string;
  spawn?: SpawnAdapter | undefined;
  stateRegistry?: WorktreeRegistry | undefined;
}

export interface CreateWorktreeRunOptions extends WorktreeCommonOptions {
  directory: string;
  maxWriters?: number;
  worktreeRoot?: string | undefined;
}

export interface CreateWriterWorktreeOptions extends WorktreeCommonOptions {
  itemId: string;
  ownedWriteScope: unknown[];
}

export interface IntegrateWriterWorktreeOptions extends WorktreeCommonOptions {
  itemId: string;
}

export interface RecoverWorktreeRunOptions extends WorktreeCommonOptions {
  directory: string;
  worktreeRoot?: string | undefined;
}

export type FinalizeWorktreeRunOptions = WorktreeCommonOptions;
export type CleanupWorktreeRunOptions = WorktreeCommonOptions;

export interface WorktreeChanges {
  tracked: string[];
  untracked: string[];
  all: string[];
}

export interface IntegrateWriterResult {
  itemId: string;
  changedPaths: string[];
  integrationPath: string;
}

export interface FinalizeWorktreeResult {
  runId: string;
  changedPaths: string[];
  finalized: true;
}

export interface CleanupWorktreeResult {
  runId: string;
  cleaned: true;
}

export type RecoverWorktreeResult = WorktreeRunSnapshot;
export type RollbackOutcome = string[];
export type FaultOutcome = never;

function hasErrorCode(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error && error.code === code;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isUnknownRecord(value: unknown): value is UnknownRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function assertUnknownRecord(value: unknown, label: string): asserts value is UnknownRecord {
  if (!isUnknownRecord(value)) {
    throw new Error(`${label} must be an object`);
  }
}

function registry(): WorktreeRegistry {
  const runtime = globalThis as WorktreeGlobal;
  runtime[REGISTRY_KEY] ??= new Map<string, WorktreeRunState>();
  return runtime[REGISTRY_KEY];
}

async function withRunLock<T>(runId: string, operation: () => Promise<T>): Promise<T> {
  const previous = RUN_LOCKS.get(runId) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolveGate) => {
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

function safeId(value: unknown, label: string): string {
  if (!isSchedulerId(value)) throw new Error(`${label} is not a safe identifier`);
  return value;
}

function assertAbsolute(path: unknown, label: string): string {
  if (typeof path !== 'string' || !path.startsWith('/') || path.includes('\0')) {
    throw new Error(`${label} must be an absolute path`);
  }
  return path;
}

function parseNul(text: string): string[] {
  if (!text) return [];
  const values = text.split('\0');
  if (values.at(-1) === '') values.pop();
  return values;
}

async function git(args: readonly string[], { cwd, input, spawn, label }: GitOptions): Promise<string> {
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

async function addWorktree(
  repository: string,
  path: string,
  baseSha: string,
  spawn: SpawnAdapter | undefined,
  label: string,
): Promise<void> {
  await git(['-c', `core.hooksPath=${NO_HOOKS_PATH}`, 'worktree', 'add', '--detach', path, baseSha], {
    cwd: repository,
    spawn,
    label,
  });
}

function inside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !rel.startsWith(sep));
}

async function repositoryIdentity(directory: string, spawn?: SpawnAdapter): Promise<RepositoryIdentity> {
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

async function canonicalRepository(directory: string, spawn?: SpawnAdapter): Promise<RepositoryIdentity> {
  const identity = await repositoryIdentity(directory, spawn);
  const status = await git(['status', '--porcelain=v1', '-z', '--untracked-files=all'], {
    cwd: identity.repository,
    spawn,
    label: 'workspace status',
  });
  if (status !== '') throw new Error('isolated writer mode requires a clean workspace');
  return identity;
}

async function writeMetadata(runState: WorktreeRunState): Promise<void> {
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
  } satisfies WorktreeMetadata;
  const metadataPath = join(runState.runRoot, METADATA_FILE);
  const temporaryPath = join(
    runState.runRoot,
    `.naru-run.${process.pid}.${randomBytes(8).toString('hex')}.tmp`,
  );
  let handle: FileHandle | undefined;
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

async function runRootFor(
  worktreeRoot: string | undefined,
  repository: string,
  runId: string,
  { create = false }: RunRootOptions = {},
): Promise<string> {
  const configuredRoot = resolve(worktreeRoot ?? join(homedir(), '.worktrees'));
  if (create) await mkdir(configuredRoot, { recursive: true, mode: 0o700 });
  const canonicalRoot = await realpath(configuredRoot);

  const validateSegment = async (
    path: string,
    label: string,
    { exclusive = false }: SegmentOptions = {},
  ): Promise<void> => {
    if (!inside(canonicalRoot, path)) throw new Error('derived worktree path escapes its configured root');
    let created = false;
    if (create) {
      try {
        await mkdir(path, { mode: 0o700 });
        created = true;
      } catch (error) {
        if (!hasErrorCode(error, 'EEXIST')) throw error;
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

function publicRun(runState: WorktreeRunState): WorktreeRunSnapshot {
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

function stateFor(runId: string, stateRegistry: WorktreeRegistry = registry()): WorktreeRunState {
  const state = stateRegistry.get(runId);
  if (!state) throw new Error(`unknown worktree run: ${runId}`);
  return state;
}

async function createWorktreeRunUnlocked({
  directory,
  runId,
  maxWriters = 50,
  worktreeRoot,
  spawn,
  stateRegistry = registry(),
}: CreateWorktreeRunOptions & { stateRegistry: WorktreeRegistry }): Promise<WorktreeRunSnapshot> {
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
    items: new Map<string, WorktreeItemState>(),
    integratedPaths: new Set<string>(),
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

async function createWriterWorktreeUnlocked({
  runId,
  itemId,
  ownedWriteScope,
  spawn,
  stateRegistry,
}: CreateWriterWorktreeOptions & { stateRegistry: WorktreeRegistry }): Promise<WorktreeItemSnapshot> {
  safeId(itemId, 'itemId');
  const runState = stateFor(runId, stateRegistry);
  if (runState.finalized || runState.faulted) throw new Error('worktree run is not writable');
  if (runState.items.has(itemId)) throw new Error(`writer worktree already exists: ${itemId}`);
  if (runState.items.size >= runState.maxWriters) throw new Error('writer worktree limit exhausted');
  if (!Array.isArray(ownedWriteScope) || ownedWriteScope.length === 0 || ownedWriteScope.length > 128) {
    throw new Error('ownedWriteScope must be a bounded non-empty array');
  }
  const validatedScopes: string[] = [];
  for (const scope of ownedWriteScope) {
    if (!isSafeScope(scope)) throw new Error(`ownedWriteScope contains an unsafe scope: ${scope}`);
    validatedScopes.push(scope);
  }
  const path = join(runState.runRoot, 'items', itemId);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await addWorktree(runState.repository, path, runState.baseSha, spawn, `writer worktree creation for ${itemId}`);
  runState.items.set(itemId, {
    itemId,
    path,
    ownedWriteScope: validatedScopes,
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
  const item = publicRun(runState).items.find((candidate) => candidate.itemId === itemId);
  if (!item) throw new Error(`writer worktree state was not recorded: ${itemId}`);
  return item;
}

async function changesAt(path: string, spawn?: SpawnAdapter): Promise<WorktreeChanges> {
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

async function rejectSymlinks(root: string, paths: readonly string[]): Promise<void> {
  for (const path of paths) {
    let stats;
    try {
      stats = await lstat(join(root, path));
    } catch (error) {
      if (hasErrorCode(error, 'ENOENT')) continue;
      throw error;
    }
    if (stats.isSymbolicLink()) throw new Error(`changed path is a symbolic link: ${path}`);
    if (!stats.isFile()) throw new Error(`changed path is not a regular file: ${path}`);
  }
}

function assertContained(item: WorktreeItemState, changedPaths: readonly string[]): void {
  for (const path of changedPaths) {
    if (!isSafeScope(path, { allowGlob: false })) throw new Error(`changed path is unsafe: ${path}`);
    if (!item.ownedWriteScope.some((scope) => scopeCoversPath(scope, path))) {
      throw new Error(`changed path is outside ${item.itemId} ownership: ${path}`);
    }
  }
}

async function trackedPatch(path: string, spawn?: SpawnAdapter): Promise<string> {
  return git(['diff', '--binary', '--full-index', '--no-ext-diff', 'HEAD', '--', '.'], {
    cwd: path,
    spawn,
    label: 'writer patch capture',
  });
}

async function applyPatch(
  target: string,
  patch: string,
  spawn?: SpawnAdapter,
  checkOnly = false,
  reverse = false,
): Promise<void> {
  if (!patch) return;
  const args = ['apply', '--binary', '--whitespace=nowarn'];
  if (reverse) args.push('--reverse');
  if (checkOnly) args.push('--check');
  args.push('-');
  const action = reverse ? 'patch rollback' : 'patch application';
  await git(args, { cwd: target, input: patch, spawn, label: checkOnly ? `${action} preflight` : action });
}

async function safeAncestor(
  root: string,
  relativePath: string,
  { create }: { create: boolean },
): Promise<string> {
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
      if (!hasErrorCode(error, 'ENOENT') || !create) throw error;
      try {
        await mkdir(current, { mode: 0o700 });
      } catch (mkdirError) {
        if (!hasErrorCode(mkdirError, 'EEXIST')) throw mkdirError;
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

async function copyRegularFile(
  source: string,
  target: string,
  path: string,
  created: CopyRecord[],
): Promise<void> {
  const sourceParent = await safeAncestor(source, path, { create: false });
  const targetParent = await safeAncestor(target, path, { create: true });
  const sourcePath = join(source, path);
  const destination = join(target, path);
  let sourceHandle: FileHandle | undefined;
  let destinationHandle: FileHandle | undefined;
  let record: CopyRecord | undefined;
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
      if (hasErrorCode(error, 'EEXIST')) throw new Error(`untracked path already exists in target workspace: ${path}`);
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
        if (record) record.expected = await destinationHandle.stat({ bigint: true });
      } finally {
        await destinationHandle.close().catch(() => {});
      }
    }
    await sourceHandle?.close().catch(() => {});
  }
}

async function copyUntracked(
  source: string,
  target: string,
  paths: readonly string[],
  created: CopyRecord[],
): Promise<void> {
  for (const path of paths) await copyRegularFile(source, target, path, created);
}

function sameCreatedFile(stats: BigIntStats, record: CopyRecord): boolean {
  return record.expected !== undefined
    && stats.isFile()
    && stats.dev === record.dev
    && stats.ino === record.ino
    && stats.size === record.expected.size
    && stats.mtimeNs === record.expected.mtimeNs;
}

async function rollbackMutation(
  target: string,
  patch: string,
  created: readonly CopyRecord[],
  spawn?: SpawnAdapter,
): Promise<RollbackOutcome> {
  const residuals: string[] = [];
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
      if (!hasErrorCode(error, 'ENOENT')) residuals.push(`${record.path}: ${errorMessage(error)}`);
    }
  }
  if (patch) {
    try {
      await applyPatch(target, patch, spawn, true, true);
      await applyPatch(target, patch, spawn, false, true);
    } catch (error) {
      residuals.push(`tracked patch: ${errorMessage(error)}`);
    }
  }
  return residuals;
}

async function faultAfterRollback(
  runState: WorktreeRunState,
  error: unknown,
  target: string,
  patch: string,
  created: readonly CopyRecord[],
  spawn?: SpawnAdapter,
): Promise<FaultOutcome> {
  const residuals = await rollbackMutation(target, patch, created, spawn);
  runState.faulted = true;
  try {
    await writeMetadata(runState);
  } catch (metadataError) {
    residuals.push(`fault metadata: ${errorMessage(metadataError)}`);
  }
  const rollback = residuals.length ? `rollback residual: ${residuals.join('; ')}` : 'rollback completed';
  throw new Error(`${error instanceof Error ? error.message : String(error)}; ${rollback}`, { cause: error });
}

async function integrateWriterWorktreeUnlocked({
  runId,
  itemId,
  spawn,
  stateRegistry,
}: IntegrateWriterWorktreeOptions & { stateRegistry: WorktreeRegistry }): Promise<IntegrateWriterResult> {
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
  const created: CopyRecord[] = [];
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

async function finalizeWorktreeRunUnlocked({
  runId,
  spawn,
  stateRegistry,
}: FinalizeWorktreeRunOptions & { stateRegistry: WorktreeRegistry }): Promise<FinalizeWorktreeResult> {
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
  const created: CopyRecord[] = [];
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
}: RecoverWorktreeRunOptions & { stateRegistry: WorktreeRegistry }): Promise<RecoverWorktreeResult> {
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
  if (
    typeof metadata.maxWriters !== 'number'
    || !Number.isSafeInteger(metadata.maxWriters)
    || metadata.maxWriters < 1
    || metadata.maxWriters > MAX_WRITERS
  ) {
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

  const persistedItems = metadata.items;
  const items = new Map<string, WorktreeItemState>();
  const integratedPaths = new Set<string>();
  for (const persisted of persistedItems) {
    assertUnknownRecord(persisted, 'writer worktree metadata item');
    const persistedItemId = safeId(persisted.itemId, 'itemId');
    if (items.has(persistedItemId)) throw new Error(`duplicate writer item in metadata: ${persistedItemId}`);
    const path = join(runRoot, 'items', persistedItemId);
    if (persisted.path !== path || await realpath(path) !== path) {
      throw new Error(`writer worktree metadata has an unsafe path: ${persistedItemId}`);
    }
    if (
      !Array.isArray(persisted.ownedWriteScope)
      || persisted.ownedWriteScope.length === 0
      || persisted.ownedWriteScope.length > 128
    ) {
      throw new Error(`writer worktree metadata has invalid ownership: ${persistedItemId}`);
    }
    if (!persisted.ownedWriteScope.every((scope) => isSafeScope(scope))) {
      throw new Error(`writer worktree metadata has unsafe ownership: ${persistedItemId}`);
    }
    if (
      typeof persisted.integrated !== 'boolean'
      || !Array.isArray(persisted.changedPaths)
      || persisted.changedPaths.length > 65536
      || new Set(persisted.changedPaths).size !== persisted.changedPaths.length
    ) {
      throw new Error(`writer worktree metadata has invalid state: ${persistedItemId}`);
    }
    const ownedWriteScope = persisted.ownedWriteScope.filter((scope): scope is string => typeof scope === 'string');
    const changedPaths = persisted.changedPaths.filter((changedPath): changedPath is string => typeof changedPath === 'string');
    if (ownedWriteScope.length !== persisted.ownedWriteScope.length || changedPaths.length !== persisted.changedPaths.length) {
      throw new Error(`writer worktree metadata has invalid state: ${persistedItemId}`);
    }
    const item = {
      itemId: persistedItemId,
      path,
      ownedWriteScope,
      integrated: persisted.integrated,
      changedPaths,
    } satisfies WorktreeItemState;
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
  } satisfies WorktreeRunState;
  stateRegistry.set(runId, runState);
  return publicRun(runState);
}

async function cleanupWorktreeRunUnlocked({
  runId,
  spawn,
  stateRegistry,
}: CleanupWorktreeRunOptions & { stateRegistry: WorktreeRegistry }): Promise<CleanupWorktreeResult> {
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

export function worktreeRunSnapshot(
  runId: string,
  stateRegistry: WorktreeRegistry = registry(),
): WorktreeRunSnapshot {
  return publicRun(stateFor(runId, stateRegistry));
}

export function resetWorktreeRegistryForTests(stateRegistry: WorktreeRegistry = registry()): void {
  stateRegistry.clear();
}

export async function readWorktreeMetadata(path: string): Promise<UnknownRecord> {
  let metadata: unknown;
  try {
    metadata = JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error('invalid worktree run metadata: malformed JSON', { cause: error });
    throw error;
  }
  if (!isUnknownRecord(metadata)) {
    throw new Error('invalid worktree run metadata');
  }
  return metadata;
}

export async function createWorktreeRun(options: CreateWorktreeRunOptions): Promise<WorktreeRunSnapshot> {
  const stateRegistry = options.stateRegistry ?? registry();
  return withRunLock(options.runId, () => createWorktreeRunUnlocked({ ...options, stateRegistry }));
}

export async function createWriterWorktree(options: CreateWriterWorktreeOptions): Promise<WorktreeItemSnapshot> {
  const stateRegistry = options.stateRegistry ?? registry();
  return withRunLock(options.runId, () => createWriterWorktreeUnlocked({ ...options, stateRegistry }));
}

export async function integrateWriterWorktree(
  options: IntegrateWriterWorktreeOptions,
): Promise<IntegrateWriterResult> {
  const stateRegistry = options.stateRegistry ?? registry();
  return withRunLock(options.runId, () => integrateWriterWorktreeUnlocked({ ...options, stateRegistry }));
}

export async function finalizeWorktreeRun(options: FinalizeWorktreeRunOptions): Promise<FinalizeWorktreeResult> {
  const stateRegistry = options.stateRegistry ?? registry();
  return withRunLock(options.runId, () => finalizeWorktreeRunUnlocked({ ...options, stateRegistry }));
}

export async function recoverWorktreeRun(options: RecoverWorktreeRunOptions): Promise<RecoverWorktreeResult> {
  const stateRegistry = options.stateRegistry ?? registry();
  return withRunLock(options.runId, () => recoverWorktreeRunUnlocked({ ...options, stateRegistry }));
}

export async function cleanupWorktreeRun(options: CleanupWorktreeRunOptions): Promise<CleanupWorktreeResult> {
  const stateRegistry = options.stateRegistry ?? registry();
  return withRunLock(options.runId, () => cleanupWorktreeRunUnlocked({ ...options, stateRegistry }));
}
