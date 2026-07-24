import { createHash } from 'node:crypto';
import { constants as fsConstants, realpathSync } from 'node:fs';
import {
  lstat,
  open,
  opendir,
  readlink,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const INSTALL_MANIFEST_FILE = '.naru-install.json';
export const INSTALL_MANIFEST_SCHEMA_VERSION = 1;
export const INSTALL_TRANSACTION_FILE = '.naru-transaction.json';
export const INSTALL_TRANSACTION_SCHEMA_VERSION = 1;
export const MAX_INSTALL_MANIFEST_BYTES = 512 * 1024;
export const MAX_INSTALL_TRANSACTION_BYTES = 512 * 1024;
export const MAX_MANAGED_ENTRIES = 256;
export const MAX_FINGERPRINT_FILE_BYTES = 16 * 1024 * 1024;
export const MAX_FINGERPRINT_TREE_BYTES = 64 * 1024 * 1024;
export const MAX_FINGERPRINT_TREE_ENTRIES = 4_096;

const PRODUCT = 'naru-opencode';
const LOCATION_MODES = new Set(['global', 'project', 'custom']);
const INSTALL_MODES = new Set(['copy', 'symlink']);
const ENTRY_METHODS = new Set(['copy', 'symlink']);
const ENTRY_KINDS = new Set(['file', 'directory', 'symlink']);
const TRANSACTION_OPERATIONS = new Set(['install', 'rollback', 'uninstall']);
const TRANSACTION_ID_PATTERN = /^[0-9]{14}-[0-9]+$/;
const FINGERPRINT_PATTERN = /^(?:sha256|tree-sha256|symlink-sha256):[a-f0-9]{64}$/;
const RESERVED_MANAGED_ROOTS = [
  INSTALL_MANIFEST_FILE,
  INSTALL_TRANSACTION_FILE,
  '.naru-backups',
  '.naru-staging',
];
const DASHBOARD_RUNTIME_PATHS = new Set([
  'plugins/naru-minions-dashboard-state.mjs',
  'plugins/naru-minions-dashboard.tsx',
  'tools/naru-lib',
]);
export const RETIRED_MANAGED_PATHS = new Set([
  'commands/naru-plan.md',
  'commands/naru-impact.md',
  'commands/naru-triage.md',
  'commands/naru-review.md',
  'commands/naru-review-post.md',
  'agents/naru-plan.md',
  'agents/naru-plan-architecture.md',
  'agents/naru-plan-minimal-change.md',
  'agents/naru-plan-risk.md',
  'agents/naru-plan-tests.md',
  'agents/naru-plan-judge.md',
  'agents/naru-impact.md',
  'agents/naru-impact-topology.md',
  'agents/naru-impact-contracts.md',
  'agents/naru-impact-data.md',
  'agents/naru-impact-frontend-mobile.md',
  'agents/naru-impact-tests-ci.md',
  'agents/naru-impact-judge.md',
  'agents/naru-triage.md',
  'agents/naru-triage-reproduction.md',
  'agents/naru-triage-codepath.md',
  'agents/naru-triage-regression.md',
  'agents/naru-triage-tests.md',
  'agents/naru-triage-judge.md',
  'agents/naru-review.md',
  'agents/naru-review-security.md',
  'agents/naru-review-backend.md',
  'agents/naru-review-frontend-mobile.md',
  'agents/naru-review-integrations.md',
  'agents/naru-review-tests-ci.md',
  'agents/naru-review-judge.md',
  'agents/naru-review-post.md',
]);

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function assertExactKeys(value, expected, label) {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) {
    throw new Error(`${label} keys must be exactly ${wanted.join(', ')}`);
  }
}

function assertBoolean(value, label) {
  if (typeof value !== 'boolean') throw new Error(`${label} must be a boolean`);
}

function assertNonEmptyString(value, label) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
}

function assertFingerprint(value, label) {
  if (typeof value !== 'string' || !FINGERPRINT_PATTERN.test(value)) {
    throw new Error(`${label} must be a supported SHA-256 fingerprint`);
  }
}

function stateEqual(left, right) {
  return left === null
    ? right === null
    : right !== null && left.kind === right.kind && left.fingerprint === right.fingerprint;
}

function manifestEqual(left, right) {
  if (left === null || right === null) return left === right;
  return serializeInstallManifest(left) === serializeInstallManifest(right);
}

export function normalizeManagedPath(value, label = 'managed path') {
  assertNonEmptyString(value, label);
  if (value.includes('\0') || value.includes('\n') || value.includes('\r') || value.includes('\t')) {
    throw new Error(`${label} contains unsupported control characters`);
  }
  if (path.isAbsolute(value) || value === '.' || value === '..') {
    throw new Error(`${label} must be a relative path`);
  }
  const normalized = path.posix.normalize(value.replaceAll('\\', '/'));
  if (normalized !== value || normalized.startsWith('../') || normalized.includes('/../')) {
    throw new Error(`${label} must be normalized and contained`);
  }
  return normalized;
}

function assertUnreservedManagedPath(value, label) {
  for (const reserved of RESERVED_MANAGED_ROOTS) {
    if (value === reserved || value.startsWith(`${reserved}/`)) {
      throw new Error(`${label} uses reserved lifecycle path ${reserved}`);
    }
  }
}

function assertDisjointManagedPaths(values, label) {
  const sorted = [...new Set(values)].sort();
  for (let index = 1; index < sorted.length; index += 1) {
    for (let parentIndex = 0; parentIndex < index; parentIndex += 1) {
      if (sorted[index].startsWith(`${sorted[parentIndex]}/`)) {
        throw new Error(`${label} contains overlapping paths: ${sorted[parentIndex]} and ${sorted[index]}`);
      }
    }
  }
}

function containedPath(root, relative, label) {
  const normalized = normalizeManagedPath(relative, label);
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, ...normalized.split('/'));
  if (resolved !== resolvedRoot && !resolved.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new Error(`${label} escapes its root`);
  }
  return resolved;
}

async function containedPathWithoutSymlinkParents(root, relative, label) {
  const normalized = normalizeManagedPath(relative, label);
  const resolvedRoot = path.resolve(root);
  const parts = normalized.split('/');
  let cursor = resolvedRoot;
  for (const part of parts.slice(0, -1)) {
    cursor = path.join(cursor, part);
    const stats = await statOrNull(cursor);
    if (stats === null) break;
    if (stats.isSymbolicLink() || !stats.isDirectory()) {
      throw new Error(`${label} has an unsafe parent`);
    }
  }
  return containedPath(resolvedRoot, normalized, label);
}

function hashBytes(value) {
  return createHash('sha256').update(value).digest('hex');
}

async function statOrNull(value) {
  try {
    return await lstat(value);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

function compareNames(left, right) {
  if (left.name < right.name) return -1;
  if (left.name > right.name) return 1;
  return 0;
}

async function fingerprintFile(absolute, state = null) {
  const handle = await open(absolute, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  try {
    const stats = await handle.stat();
    if (!stats.isFile() || stats.size > MAX_FINGERPRINT_FILE_BYTES) {
      throw new Error('managed file exceeds fingerprint limits');
    }
    if (state !== null) {
      state.bytes += stats.size;
      if (state.bytes > MAX_FINGERPRINT_TREE_BYTES) throw new Error('managed tree exceeds fingerprint byte limit');
    }
    const bytes = await handle.readFile();
    return { bytes, size: stats.size };
  } finally {
    await handle.close();
  }
}

function fingerprintBudget() {
  return { entries: 0, bytes: 0 };
}

function countFingerprintEntry(state) {
  state.entries += 1;
  if (state.entries > MAX_FINGERPRINT_TREE_ENTRIES) throw new Error('managed paths exceed fingerprint entry limit');
}

async function directoryRecords(root, relative = '', state = fingerprintBudget()) {
  const absolute = relative === '' ? root : containedPath(root, relative, 'tree path');
  const children = [];
  const directory = await opendir(absolute);
  try {
    for await (const child of directory) {
      countFingerprintEntry(state);
      children.push(child);
    }
  } finally {
    await directory.close().catch(error => {
      if (error?.code !== 'ERR_DIR_CLOSED') throw error;
    });
  }
  children.sort(compareNames);
  const records = [];

  for (const child of children) {
    const childRelative = relative === '' ? child.name : `${relative}/${child.name}`;
    const childAbsolute = containedPath(root, childRelative, 'tree path');
    const stats = await lstat(childAbsolute);
    if (stats.isDirectory()) {
      records.push(`directory\0${childRelative}\0`);
      records.push(...await directoryRecords(root, childRelative, state));
    } else if (stats.isFile()) {
      const file = await fingerprintFile(childAbsolute, state);
      records.push(`file\0${childRelative}\0${file.size}\0${hashBytes(file.bytes)}\0`);
    } else if (stats.isSymbolicLink()) {
      const target = await readlink(childAbsolute);
      records.push(`symlink\0${childRelative}\0${target}\0`);
    } else {
      throw new Error(`unsupported managed path type: ${childRelative}`);
    }
  }

  return records;
}

export async function fingerprintPath(absolute, state = fingerprintBudget()) {
  const stats = await statOrNull(absolute);
  if (stats === null) return null;
  countFingerprintEntry(state);
  if (stats.isSymbolicLink()) {
    return {
      kind: 'symlink',
      fingerprint: `symlink-sha256:${hashBytes(await readlink(absolute))}`,
    };
  }
  if (stats.isFile()) {
    const file = await fingerprintFile(absolute, state);
    return {
      kind: 'file',
      fingerprint: `sha256:${hashBytes(file.bytes)}`,
    };
  }
  if (stats.isDirectory()) {
    const records = await directoryRecords(absolute, '', state);
    return {
      kind: 'directory',
      fingerprint: `tree-sha256:${hashBytes(records.join('\n'))}`,
    };
  }
  throw new Error(`unsupported managed path type: ${absolute}`);
}

function desiredSymlinkFingerprint(sourceAbsolute) {
  return `symlink-sha256:${hashBytes(sourceAbsolute)}`;
}

function validateEntry(value, index) {
  if (!isPlainObject(value)) throw new Error(`managed[${index}] must be an object`);
  assertExactKeys(value, [
    'path',
    'sourcePath',
    'method',
    'sourceKind',
    'sourceFingerprint',
    'installedKind',
    'installedFingerprint',
  ], `managed[${index}]`);
  const managedPath = normalizeManagedPath(value.path, `managed[${index}].path`);
  assertUnreservedManagedPath(managedPath, `managed[${index}].path`);
  normalizeManagedPath(value.sourcePath, `managed[${index}].sourcePath`);
  if (!ENTRY_METHODS.has(value.method)) throw new Error(`managed[${index}].method is invalid`);
  if (!ENTRY_KINDS.has(value.sourceKind)) throw new Error(`managed[${index}].sourceKind is invalid`);
  if (!ENTRY_KINDS.has(value.installedKind)) throw new Error(`managed[${index}].installedKind is invalid`);
  assertNonEmptyString(value.sourceFingerprint, `managed[${index}].sourceFingerprint`);
  assertNonEmptyString(value.installedFingerprint, `managed[${index}].installedFingerprint`);
  return value;
}

export function validateInstallManifest(value) {
  if (!isPlainObject(value)) throw new Error('install manifest must be an object');
  assertExactKeys(value, [
    'schemaVersion',
    'product',
    'sourceVersion',
    'locationMode',
    'installMode',
    'options',
    'managed',
  ], 'install manifest');
  if (value.schemaVersion !== INSTALL_MANIFEST_SCHEMA_VERSION) {
    throw new Error(`unsupported install manifest schemaVersion: ${value.schemaVersion}`);
  }
  if (value.product !== PRODUCT) throw new Error(`install manifest product must be ${PRODUCT}`);
  assertNonEmptyString(value.sourceVersion, 'install manifest sourceVersion');
  if (!LOCATION_MODES.has(value.locationMode)) throw new Error('install manifest locationMode is invalid');
  if (!INSTALL_MODES.has(value.installMode)) throw new Error('install manifest installMode is invalid');
  if (!isPlainObject(value.options)) throw new Error('install manifest options must be an object');
  assertExactKeys(value.options, [
    'dashboard',
    'configureSubagentDepth',
    'migrateOrchestrator',
  ], 'install manifest options');
  assertBoolean(value.options.dashboard, 'install manifest options.dashboard');
  assertBoolean(value.options.configureSubagentDepth, 'install manifest options.configureSubagentDepth');
  assertBoolean(value.options.migrateOrchestrator, 'install manifest options.migrateOrchestrator');
  if (!Array.isArray(value.managed) || value.managed.length > MAX_MANAGED_ENTRIES) {
    throw new Error(`install manifest managed must contain at most ${MAX_MANAGED_ENTRIES} entries`);
  }
  const seen = new Set();
  for (const [index, entry] of value.managed.entries()) {
    validateEntry(entry, index);
    if (seen.has(entry.path)) throw new Error(`duplicate managed path: ${entry.path}`);
    seen.add(entry.path);
  }
  assertDisjointManagedPaths(seen, 'install manifest managed');
  return value;
}

export function serializeInstallManifest(value) {
  validateInstallManifest(value);
  return `${JSON.stringify(value, null, 2)}\n`;
}

export async function loadInstallManifest(targetRoot) {
  const manifestPath = path.join(path.resolve(targetRoot), INSTALL_MANIFEST_FILE);
  const stats = await statOrNull(manifestPath);
  if (stats === null) return null;
  if (stats.isSymbolicLink() || !stats.isFile()) {
    throw new Error(`${INSTALL_MANIFEST_FILE} must be a regular non-symlinked file`);
  }
  if (stats.size > MAX_INSTALL_MANIFEST_BYTES) {
    throw new Error(`${INSTALL_MANIFEST_FILE} exceeds ${MAX_INSTALL_MANIFEST_BYTES} bytes`);
  }
  const handle = await open(manifestPath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  try {
    const text = await handle.readFile({ encoding: 'utf8' });
    return validateInstallManifest(JSON.parse(text));
  } finally {
    await handle.close();
  }
}

function manifestState(manifest) {
  if (manifest === null) return null;
  return {
    kind: 'file',
    fingerprint: `sha256:${hashBytes(serializeInstallManifest(manifest))}`,
  };
}

function validateTransactionState(value, label, withBackupPath) {
  if (!isPlainObject(value)) throw new Error(`${label} must be an object`);
  const expected = withBackupPath ? ['kind', 'fingerprint', 'backupPath'] : ['kind', 'fingerprint'];
  assertExactKeys(value, expected, label);
  if (!ENTRY_KINDS.has(value.kind)) throw new Error(`${label}.kind is invalid`);
  assertFingerprint(value.fingerprint, `${label}.fingerprint`);
  if (withBackupPath) normalizeManagedPath(value.backupPath, `${label}.backupPath`);
  return value;
}

function validateOptionalManifest(value, label) {
  if (value === null) return null;
  try {
    return validateInstallManifest(value);
  } catch (error) {
    throw new Error(`${label}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function validateInstallTransaction(value) {
  if (!isPlainObject(value)) throw new Error('install transaction must be an object');
  assertExactKeys(value, [
    'schemaVersion',
    'product',
    'transactionId',
    'operation',
    'beforeManifest',
    'afterManifest',
    'changes',
  ], 'install transaction');
  if (value.schemaVersion !== INSTALL_TRANSACTION_SCHEMA_VERSION) {
    throw new Error(`unsupported install transaction schemaVersion: ${value.schemaVersion}`);
  }
  if (value.product !== PRODUCT) throw new Error(`install transaction product must be ${PRODUCT}`);
  if (typeof value.transactionId !== 'string' || !TRANSACTION_ID_PATTERN.test(value.transactionId)) {
    throw new Error('install transaction transactionId is invalid');
  }
  if (!TRANSACTION_OPERATIONS.has(value.operation)) throw new Error('install transaction operation is invalid');
  const beforeManifest = validateOptionalManifest(value.beforeManifest, 'install transaction beforeManifest');
  const afterManifest = validateOptionalManifest(value.afterManifest, 'install transaction afterManifest');
  if (!Array.isArray(value.changes) || value.changes.length === 0 || value.changes.length > MAX_MANAGED_ENTRIES + 1) {
    throw new Error(`install transaction changes must contain 1-${MAX_MANAGED_ENTRIES + 1} entries`);
  }

  const ownedPaths = new Set([
    ...(beforeManifest?.managed.map(entry => entry.path) ?? []),
    ...(afterManifest?.managed.map(entry => entry.path) ?? []),
  ]);
  assertDisjointManagedPaths(ownedPaths, 'install transaction manifests');
  const seen = new Set();
  let previousPath = null;
  let manifestChange = null;
  for (const [index, change] of value.changes.entries()) {
    const label = `install transaction changes[${index}]`;
    if (!isPlainObject(change)) throw new Error(`${label} must be an object`);
    assertExactKeys(change, ['path', 'before', 'after'], label);
    const managedPath = normalizeManagedPath(change.path, `${label}.path`);
    if (managedPath !== INSTALL_MANIFEST_FILE && !ownedPaths.has(managedPath)) {
      throw new Error(`${label}.path is not manifest-owned`);
    }
    if (seen.has(managedPath)) throw new Error(`duplicate install transaction path: ${managedPath}`);
    if (previousPath !== null && managedPath < previousPath) throw new Error('install transaction changes must be path-sorted');
    seen.add(managedPath);
    previousPath = managedPath;
    if (change.before !== null) {
      validateTransactionState(change.before, `${label}.before`, true);
      if (change.before.backupPath !== managedPath) throw new Error(`${label}.before.backupPath must equal path`);
    }
    if (change.after !== null) validateTransactionState(change.after, `${label}.after`, false);
    if (stateEqual(change.before, change.after)) throw new Error(`${label} must change state`);
    if (managedPath === INSTALL_MANIFEST_FILE) manifestChange = change;
  }

  const manifestsDiffer = !manifestEqual(beforeManifest, afterManifest);
  if (manifestsDiffer !== (manifestChange !== null)) {
    throw new Error('install transaction manifest change does not match beforeManifest/afterManifest');
  }
  if (manifestChange !== null) {
    const expectedBefore = manifestState(beforeManifest);
    const expectedAfter = manifestState(afterManifest);
    if ((manifestChange.before === null) !== (expectedBefore === null)
        || (manifestChange.after === null) !== (expectedAfter === null)
        || (manifestChange.before !== null && manifestChange.before.kind !== 'file')
        || (manifestChange.after !== null && manifestChange.after.kind !== 'file')) {
      throw new Error('install transaction manifest states are inconsistent');
    }
  }
  return value;
}

export function serializeInstallTransaction(value) {
  validateInstallTransaction(value);
  const serialized = `${JSON.stringify(value, null, 2)}\n`;
  if (Buffer.byteLength(serialized) > MAX_INSTALL_TRANSACTION_BYTES) {
    throw new Error(`install transaction exceeds ${MAX_INSTALL_TRANSACTION_BYTES} bytes`);
  }
  return serialized;
}

async function loadJsonFile(absolute, maxBytes, label) {
  const stats = await statOrNull(absolute);
  if (stats === null) throw new Error(`${label} is missing`);
  if (stats.isSymbolicLink() || !stats.isFile()) throw new Error(`${label} must be a regular non-symlinked file`);
  if (stats.size > maxBytes) throw new Error(`${label} exceeds ${maxBytes} bytes`);
  const handle = await open(absolute, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  try {
    return JSON.parse(await handle.readFile({ encoding: 'utf8' }));
  } finally {
    await handle.close();
  }
}

export async function loadInstallTransaction(targetRoot, transactionId) {
  if (typeof transactionId !== 'string' || !TRANSACTION_ID_PATTERN.test(transactionId)) {
    throw new Error('rollback backup id is invalid');
  }
  const backupsRoot = path.join(path.resolve(targetRoot), '.naru-backups');
  const backupsStats = await statOrNull(backupsRoot);
  if (backupsStats === null || backupsStats.isSymbolicLink() || !backupsStats.isDirectory()) {
    throw new Error('rollback backup root is missing or unsafe');
  }
  const transactionRoot = path.join(backupsRoot, transactionId);
  const transactionStats = await statOrNull(transactionRoot);
  if (transactionStats === null || transactionStats.isSymbolicLink() || !transactionStats.isDirectory()) {
    throw new Error(`rollback backup ${transactionId} is missing or unsafe`);
  }
  const receipt = validateInstallTransaction(await loadJsonFile(
    path.join(transactionRoot, INSTALL_TRANSACTION_FILE),
    MAX_INSTALL_TRANSACTION_BYTES,
    `rollback backup ${transactionId} receipt`,
  ));
  if (receipt.transactionId !== transactionId) throw new Error('rollback receipt transactionId does not match backup id');

  const budget = fingerprintBudget();
  for (const change of receipt.changes) {
    if (change.before === null) continue;
    const backupAbsolute = await containedPathWithoutSymlinkParents(
      transactionRoot,
      change.before.backupPath,
      'rollback backup path',
    );
    const current = await fingerprintPath(backupAbsolute, budget);
    if (!stateEqual(current, change.before)) {
      throw new Error(`rollback backup is missing or modified: ${change.path}`);
    }
    if (change.path === INSTALL_MANIFEST_FILE) {
      const backupManifest = validateInstallManifest(await loadJsonFile(
        backupAbsolute,
        MAX_INSTALL_MANIFEST_BYTES,
        'rollback backup ownership manifest',
      ));
      if (!manifestEqual(backupManifest, receipt.beforeManifest)) {
        throw new Error('rollback backup ownership manifest does not match the receipt');
      }
    }
  }
  return receipt;
}

async function verifyAppliedTransaction({ targetRoot, transactionId, receiptPath }) {
  if (typeof transactionId !== 'string' || !TRANSACTION_ID_PATTERN.test(transactionId)) {
    throw new Error('transaction backup id is invalid');
  }
  const resolvedTarget = path.resolve(targetRoot);
  const transactionRoot = path.join(resolvedTarget, '.naru-backups', transactionId);
  const transactionStats = await statOrNull(transactionRoot);
  if (transactionStats === null || transactionStats.isSymbolicLink() || !transactionStats.isDirectory()) {
    throw new Error('transaction backup root is missing or unsafe');
  }
  const receipt = validateInstallTransaction(await loadJsonFile(
    receiptPath,
    MAX_INSTALL_TRANSACTION_BYTES,
    'prepared install transaction receipt',
  ));
  if (receipt.transactionId !== transactionId) throw new Error('prepared receipt transactionId does not match backup id');

  const backupBudget = fingerprintBudget();
  const targetBudget = fingerprintBudget();
  for (const change of receipt.changes) {
    const backupAbsolute = await containedPathWithoutSymlinkParents(
      transactionRoot,
      change.path,
      'transaction backup path',
    );
    const backupState = await fingerprintPath(backupAbsolute, backupBudget);
    if (!stateEqual(backupState, change.before)) {
      throw new Error(`transaction backup does not match confirmed state: ${change.path}`);
    }
    if (change.path === INSTALL_MANIFEST_FILE && change.before !== null) {
      const backupManifest = validateInstallManifest(await loadJsonFile(
        backupAbsolute,
        MAX_INSTALL_MANIFEST_BYTES,
        'transaction backup ownership manifest',
      ));
      if (!manifestEqual(backupManifest, receipt.beforeManifest)) {
        throw new Error('transaction backup ownership manifest does not match the prepared receipt');
      }
    }

    const targetAbsolute = await containedPathWithoutSymlinkParents(
      resolvedTarget,
      change.path,
      'transaction target path',
    );
    const targetState = await fingerprintPath(targetAbsolute, targetBudget);
    if (!stateEqual(targetState, change.after)) {
      throw new Error(`transaction target does not match prepared result: ${change.path}`);
    }
  }
  const appliedManifest = await loadInstallManifest(resolvedTarget);
  if (!manifestEqual(appliedManifest, receipt.afterManifest)) {
    throw new Error('transaction result ownership manifest does not match the prepared receipt');
  }
}

export async function buildInstallManifest({
  sourceRoot,
  locationMode,
  installMode,
  options,
  planEntries,
}) {
  const resolvedSourceRoot = path.resolve(sourceRoot);
  if (!LOCATION_MODES.has(locationMode)) throw new Error('locationMode is invalid');
  if (!INSTALL_MODES.has(installMode)) throw new Error('installMode is invalid');
  if (!isPlainObject(options)) throw new Error('options must be an object');
  if (!Array.isArray(planEntries) || planEntries.length > MAX_MANAGED_ENTRIES) {
    throw new Error(`plan must contain at most ${MAX_MANAGED_ENTRIES} entries`);
  }

  const managed = [];
  const sourceBudget = fingerprintBudget();
  for (const [index, item] of planEntries.entries()) {
    if (!isPlainObject(item)) throw new Error(`plan entry ${index} must be an object`);
    const managedPath = normalizeManagedPath(item.path, `plan entry ${index} path`);
    const sourceAbsolute = path.resolve(item.source);
    const sourceRelativeNative = path.relative(resolvedSourceRoot, sourceAbsolute);
    if (sourceRelativeNative === '' || sourceRelativeNative.startsWith(`..${path.sep}`) || path.isAbsolute(sourceRelativeNative)) {
      throw new Error(`plan entry ${index} source is outside the source root`);
    }
    const sourcePath = normalizeManagedPath(sourceRelativeNative.split(path.sep).join('/'), `plan entry ${index} sourcePath`);
    if (!ENTRY_METHODS.has(item.method)) throw new Error(`plan entry ${index} method is invalid`);
    const sourceState = await fingerprintPath(sourceAbsolute, sourceBudget);
    if (sourceState === null) throw new Error(`missing managed source: ${sourcePath}`);
    const installedKind = item.method === 'symlink' ? 'symlink' : sourceState.kind;
    const installedFingerprint = item.method === 'symlink'
      ? desiredSymlinkFingerprint(sourceAbsolute)
      : sourceState.fingerprint;
    managed.push({
      path: managedPath,
      sourcePath,
      method: item.method,
      sourceKind: sourceState.kind,
      sourceFingerprint: sourceState.fingerprint,
      installedKind,
      installedFingerprint,
    });
  }

  managed.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  const sourceVersionInput = managed.map(entry => [
    entry.sourcePath,
    entry.sourceKind,
    entry.sourceFingerprint,
  ].join('\0')).join('\n');
  return validateInstallManifest({
    schemaVersion: INSTALL_MANIFEST_SCHEMA_VERSION,
    product: PRODUCT,
    sourceVersion: `sha256:${hashBytes(sourceVersionInput)}`,
    locationMode,
    installMode,
    options: {
      dashboard: options.dashboard === true,
      configureSubagentDepth: options.configureSubagentDepth === true,
      migrateOrchestrator: options.migrateOrchestrator === true,
    },
    managed,
  });
}

function stateMatches(current, entry) {
  return current !== null
    && current.kind === entry.installedKind
    && current.fingerprint === entry.installedFingerprint;
}

function installedState(entry) {
  return { kind: entry.installedKind, fingerprint: entry.installedFingerprint };
}

function backedUpState(state, managedPath) {
  if (state === null) return null;
  return { kind: state.kind, fingerprint: state.fingerprint, backupPath: managedPath };
}

async function buildInstallTransaction({ transactionId, targetRoot, previousManifest, desiredManifest, operations }) {
  const changes = [];
  for (const operation of operations) {
    if (!['create', 'update', 'conflict-unowned', 'conflict-modified', 'retire'].includes(operation.action)) continue;
    changes.push({
      path: operation.entry.path,
      before: backedUpState(operation.current, operation.entry.path),
      after: operation.action === 'retire' ? null : installedState(operation.entry),
    });
  }
  if (!manifestEqual(previousManifest, desiredManifest)) {
    const previousManifestState = previousManifest === null
      ? null
      : await fingerprintPath(path.join(path.resolve(targetRoot), INSTALL_MANIFEST_FILE));
    changes.push({
      path: INSTALL_MANIFEST_FILE,
      before: backedUpState(previousManifestState, INSTALL_MANIFEST_FILE),
      after: manifestState(desiredManifest),
    });
  }
  if (changes.length === 0) return null;
  changes.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  return validateInstallTransaction({
    schemaVersion: INSTALL_TRANSACTION_SCHEMA_VERSION,
    product: PRODUCT,
    transactionId,
    operation: 'install',
    beforeManifest: previousManifest,
    afterManifest: desiredManifest,
    changes,
  });
}

export async function classifyInstallPlan({ targetRoot, desiredManifest, previousManifest, replaceConflicts = false }) {
  validateInstallManifest(desiredManifest);
  if (previousManifest !== null) validateInstallManifest(previousManifest);
  const previousByPath = new Map(previousManifest?.managed.map(entry => [entry.path, entry]) ?? []);
  const desiredPaths = new Set(desiredManifest.managed.map(entry => entry.path));
  const operations = [];
  const targetBudget = fingerprintBudget();

  for (const entry of desiredManifest.managed) {
    const current = await fingerprintPath(
      await containedPathWithoutSymlinkParents(targetRoot, entry.path, 'target path'),
      targetBudget,
    );
    let action;
    let reason;
    if (current === null) {
      action = 'create';
      reason = 'missing';
    } else if (stateMatches(current, entry)) {
      action = 'unchanged';
      reason = 'matches-desired';
    } else {
      const previous = previousByPath.get(entry.path);
      if (previous === undefined) {
        action = 'conflict-unowned';
        reason = 'not-owned-by-manifest';
      } else if (stateMatches(current, previous)) {
        action = 'update';
        reason = 'owned-and-unmodified';
      } else {
        action = 'conflict-modified';
        reason = 'changed-after-install';
      }
    }
    operations.push({ action, reason, entry, current });
  }

  for (const entry of previousManifest?.managed ?? []) {
    if (!desiredPaths.has(entry.path)) {
      if (RETIRED_MANAGED_PATHS.has(entry.path)) {
        const current = await fingerprintPath(
          await containedPathWithoutSymlinkParents(targetRoot, entry.path, 'retired target path'),
          targetBudget,
        );
        let action;
        let reason;
        if (current === null) {
          action = 'retire-missing';
          reason = 'previously-owned-already-missing';
        } else if (stateMatches(current, entry)) {
          action = 'retire';
          reason = 'previously-owned-and-unmodified';
        } else if (replaceConflicts) {
          action = 'retire';
          reason = 'reviewed-conflict-choice';
        } else {
          action = 'preserve-retired-modified';
          reason = 'changed-after-install';
        }
        operations.push({ action, reason, entry, current });
        continue;
      }
      operations.push({
        action: 'preserve-orphaned',
        reason: 'previously-owned-not-in-selected-install',
        entry,
        current: null,
      });
    }
  }

  return operations;
}

function lifecycleTransaction({ transactionId, operation, beforeManifest, afterManifest, operations }) {
  const changes = operations
    .filter(item => item.action === 'remove' || item.action === 'restore')
    .map(item => ({
      path: item.path,
      before: backedUpState(item.current, item.path),
      after: item.desired,
    }))
    .sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  if (changes.length === 0) return null;
  return validateInstallTransaction({
    schemaVersion: INSTALL_TRANSACTION_SCHEMA_VERSION,
    product: PRODUCT,
    transactionId,
    operation,
    beforeManifest,
    afterManifest,
    changes,
  });
}

function lifecycleConfirmationToken({
  targetRoot,
  action,
  backupId,
  replaceConflicts,
  currentManifest,
  selectedReceipt,
  operations,
}) {
  const input = {
    target: path.resolve(targetRoot),
    action,
    backupId,
    replaceConflicts,
    currentManifest: currentManifest === null ? null : serializeInstallManifest(currentManifest),
    selectedReceipt: selectedReceipt === null ? null : serializeInstallTransaction(selectedReceipt),
    operations: operations.map(item => ({
      action: item.action,
      path: item.path,
      source: item.source,
      reason: item.reason,
      current: item.current,
      desired: item.desired,
    })),
  };
  return `sha256:${hashBytes(JSON.stringify(input))}`;
}

async function planRollback({ targetRoot, backupId, transactionId, replaceConflicts }) {
  const selectedReceipt = await loadInstallTransaction(targetRoot, backupId);
  const currentManifest = await loadInstallManifest(targetRoot);
  if (!manifestEqual(currentManifest, selectedReceipt.afterManifest)) {
    throw new Error('rollback is stale: current ownership manifest does not match the selected transaction');
  }

  const operations = [];
  const budget = fingerprintBudget();
  for (const change of selectedReceipt.changes) {
    const current = await fingerprintPath(
      await containedPathWithoutSymlinkParents(targetRoot, change.path, 'rollback target path'),
      budget,
    );
    const desired = change.before === null ? null : {
      kind: change.before.kind,
      fingerprint: change.before.fingerprint,
    };
    const expected = change.after;
    const source = desired === null ? '-' : `.naru-backups/${backupId}/${change.before.backupPath}`;
    let action;
    let reason;
    if (stateEqual(current, desired)) {
      action = 'unchanged';
      reason = 'already-at-rollback-state';
    } else if (stateEqual(current, expected)) {
      action = desired === null ? 'remove' : 'restore';
      reason = 'matches-selected-transaction';
    } else if (replaceConflicts) {
      action = desired === null ? 'remove' : 'restore';
      reason = 'reviewed-conflict-choice';
    } else {
      action = 'conflict-modified';
      reason = 'changed-after-selected-transaction';
    }
    operations.push({ action, path: change.path, source, reason, current, desired });
  }

  const receipt = lifecycleTransaction({
    transactionId,
    operation: 'rollback',
    beforeManifest: currentManifest,
    afterManifest: selectedReceipt.beforeManifest,
    operations,
  });
  return {
    action: 'rollback',
    backupId,
    currentManifest,
    selectedReceipt,
    operations,
    receipt,
    token: lifecycleConfirmationToken({
      targetRoot,
      action: 'rollback',
      backupId,
      replaceConflicts,
      currentManifest,
      selectedReceipt,
      operations,
    }),
  };
}

async function planUninstall({ targetRoot, transactionId, replaceConflicts }) {
  const currentManifest = await loadInstallManifest(targetRoot);
  if (currentManifest === null) throw new Error('uninstall requires a valid .naru-install.json ownership manifest');

  const operations = [];
  const budget = fingerprintBudget();
  let preservedModified = 0;
  let preservedDashboard = 0;
  for (const entry of currentManifest.managed) {
    const current = await fingerprintPath(
      await containedPathWithoutSymlinkParents(targetRoot, entry.path, 'uninstall target path'),
      budget,
    );
    if (current === null) {
      operations.push({
        action: 'missing',
        path: entry.path,
        source: '-',
        reason: 'already-missing',
        current,
        desired: null,
      });
    } else if (currentManifest.options.dashboard
        && DASHBOARD_RUNTIME_PATHS.has(entry.path)
        && !replaceConflicts) {
      preservedDashboard += 1;
      operations.push({
        action: 'preserve-dashboard',
        path: entry.path,
        source: '-',
        reason: 'tui-registration-not-managed',
        current,
        desired: current,
      });
    } else if (stateMatches(current, entry) || replaceConflicts) {
      operations.push({
        action: 'remove',
        path: entry.path,
        source: '-',
        reason: stateMatches(current, entry) ? 'manifest-owned-and-unmodified' : 'reviewed-conflict-choice',
        current,
        desired: null,
      });
    } else {
      preservedModified += 1;
      operations.push({
        action: 'preserve-modified',
        path: entry.path,
        source: '-',
        reason: 'changed-after-install',
        current,
        desired: current,
      });
    }
  }

  const afterManifest = preservedModified === 0 && preservedDashboard === 0 ? null : currentManifest;
  const manifestCurrent = await fingerprintPath(
    await containedPathWithoutSymlinkParents(targetRoot, INSTALL_MANIFEST_FILE, 'uninstall manifest path'),
    budget,
  );
  if (afterManifest === null) {
    operations.push({
      action: 'remove',
      path: INSTALL_MANIFEST_FILE,
      source: '-',
      reason: 'full-uninstall',
      current: manifestCurrent,
      desired: null,
    });
  } else {
    operations.push({
      action: 'preserve-manifest',
      path: INSTALL_MANIFEST_FILE,
      source: '-',
      reason: 'modified-managed-paths-remain',
      current: manifestCurrent,
      desired: manifestCurrent,
    });
  }

  const receipt = lifecycleTransaction({
    transactionId,
    operation: 'uninstall',
    beforeManifest: currentManifest,
    afterManifest,
    operations,
  });
  return {
    action: 'uninstall',
    backupId: null,
    currentManifest,
    selectedReceipt: null,
    operations,
    receipt,
    token: lifecycleConfirmationToken({
      targetRoot,
      action: 'uninstall',
      backupId: null,
      replaceConflicts,
      currentManifest,
      selectedReceipt: null,
      operations,
    }),
  };
}

export async function inferInstallSourceRoot(targetRoot, manifest) {
  validateInstallManifest(manifest);
  let inferred = null;
  for (const entry of manifest.managed) {
    if (entry.method !== 'symlink') continue;
    const installed = await containedPathWithoutSymlinkParents(targetRoot, entry.path, 'installed path');
    const stats = await statOrNull(installed);
    if (stats === null || !stats.isSymbolicLink()) continue;
    const resolvedTarget = path.resolve(path.dirname(installed), await readlink(installed));
    const sourceParts = entry.sourcePath.split('/');
    let candidate = resolvedTarget;
    for (let index = 0; index < sourceParts.length; index += 1) candidate = path.dirname(candidate);
    if (path.resolve(candidate, ...sourceParts) !== resolvedTarget) continue;
    if (inferred !== null && inferred !== candidate) return null;
    inferred = candidate;
  }
  return inferred;
}

export async function inspectInstallManifest({ targetRoot, manifest, sourceRoot = null }) {
  validateInstallManifest(manifest);
  const resolvedSourceRoot = sourceRoot === null ? null : path.resolve(sourceRoot);
  const entries = [];
  const installedBudget = fingerprintBudget();
  const sourceBudget = fingerprintBudget();
  for (const entry of manifest.managed) {
    const current = await fingerprintPath(
      await containedPathWithoutSymlinkParents(targetRoot, entry.path, 'installed path'),
      installedBudget,
    );
    let installedStatus = 'healthy';
    if (current === null) installedStatus = 'missing';
    else if (!stateMatches(current, entry)) installedStatus = 'modified';

    let sourceStatus = 'unknown';
    if (resolvedSourceRoot !== null) {
      const source = await fingerprintPath(
        await containedPathWithoutSymlinkParents(resolvedSourceRoot, entry.sourcePath, 'source path'),
        sourceBudget,
      );
      if (source === null) sourceStatus = 'missing';
      else if (source.kind === entry.sourceKind && source.fingerprint === entry.sourceFingerprint) sourceStatus = 'matched';
      else sourceStatus = entry.method === 'copy' ? 'copy-stale' : 'symlink-live-source-changed';
    }
    entries.push({ path: entry.path, method: entry.method, installedStatus, sourceStatus });
  }
  return entries;
}

function parseBoolean(value, label) {
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new Error(`${label} must be true or false`);
}

function parseKeyValueArgs(argv, command, expected) {
  if (argv[0] !== command) throw new Error(`expected ${command} command`);
  const values = {};
  for (let index = 1; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith('--') || value === undefined) throw new Error(`invalid argument: ${key ?? ''}`);
    if (Object.hasOwn(values, key)) throw new Error(`duplicate argument: ${key}`);
    values[key] = value;
  }
  assertExactKeys(values, expected, `${command} arguments`);
  return values;
}

function parsePrepareArgs(argv) {
  const values = parseKeyValueArgs(argv, 'prepare', [
    '--source',
    '--target',
    '--plan',
    '--manifest-output',
    '--operations-output',
    '--receipt-output',
    '--transaction-id',
    '--location-mode',
    '--install-mode',
    '--dashboard',
    '--configure-subagent-depth',
    '--migrate-orchestrator',
    '--replace-conflicts',
  ]);
  if (!TRANSACTION_ID_PATTERN.test(values['--transaction-id'])) throw new Error('prepare transaction id is invalid');
  return values;
}

function parseLifecycleArgs(argv) {
  const values = parseKeyValueArgs(argv, 'lifecycle', [
    '--action',
    '--target',
    '--backup-id',
    '--operations-output',
    '--receipt-output',
    '--token-output',
    '--transaction-id',
    '--replace-conflicts',
  ]);
  if (!['rollback', 'uninstall'].includes(values['--action'])) throw new Error('lifecycle action is invalid');
  if (!TRANSACTION_ID_PATTERN.test(values['--transaction-id'])) throw new Error('lifecycle transaction id is invalid');
  if (values['--action'] === 'rollback') {
    if (!TRANSACTION_ID_PATTERN.test(values['--backup-id'])) throw new Error('rollback backup id is invalid');
  } else if (values['--backup-id'] !== '-') {
    throw new Error('uninstall backup id must be -');
  }
  return values;
}

function parseVerifyArgs(argv) {
  const values = parseKeyValueArgs(argv, 'verify', [
    '--target',
    '--backup-id',
    '--receipt',
  ]);
  if (!TRANSACTION_ID_PATTERN.test(values['--backup-id'])) throw new Error('verify backup id is invalid');
  return values;
}

async function readPlan(planPath) {
  const handle = await open(planPath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  let text;
  try {
    const stats = await handle.stat();
    if (!stats.isFile() || stats.size > MAX_INSTALL_MANIFEST_BYTES) throw new Error('install plan exceeds limits');
    text = await handle.readFile({ encoding: 'utf8' });
  } finally {
    await handle.close();
  }
  const entries = [];
  for (const [index, line] of text.split('\n').entries()) {
    if (line === '') continue;
    const fields = line.split('\t');
    if (fields.length !== 3) throw new Error(`plan line ${index + 1} is malformed`);
    entries.push({ method: fields[0], source: fields[1], path: fields[2] });
  }
  return entries;
}

async function prepare(argv) {
  const values = parsePrepareArgs(argv);
  const planEntries = await readPlan(values['--plan']);
  const desiredManifest = await buildInstallManifest({
    sourceRoot: values['--source'],
    locationMode: values['--location-mode'],
    installMode: values['--install-mode'],
    options: {
      dashboard: parseBoolean(values['--dashboard'], '--dashboard'),
      configureSubagentDepth: parseBoolean(values['--configure-subagent-depth'], '--configure-subagent-depth'),
      migrateOrchestrator: parseBoolean(values['--migrate-orchestrator'], '--migrate-orchestrator'),
    },
    planEntries,
  });
  const previousManifest = await loadInstallManifest(values['--target']);
  const operations = await classifyInstallPlan({
    targetRoot: values['--target'],
    desiredManifest,
    previousManifest,
    replaceConflicts: parseBoolean(values['--replace-conflicts'], '--replace-conflicts'),
  });
  const receipt = await buildInstallTransaction({
    transactionId: values['--transaction-id'],
    targetRoot: values['--target'],
    previousManifest,
    desiredManifest,
    operations,
  });
  await writeFile(values['--manifest-output'], serializeInstallManifest(desiredManifest), { mode: 0o600 });
  const lines = operations.map(({ action, reason, entry }) => [
    action,
    entry.method,
    entry.sourcePath,
    entry.path,
    reason,
  ].join('\t'));
  await writeFile(values['--operations-output'], `${lines.join('\n')}\n`, { mode: 0o600 });
  await writeFile(
    values['--receipt-output'],
    receipt === null ? '' : serializeInstallTransaction(receipt),
    { mode: 0o600 },
  );
}

async function planLifecycle(argv) {
  const values = parseLifecycleArgs(argv);
  const replaceConflicts = parseBoolean(values['--replace-conflicts'], '--replace-conflicts');
  const result = values['--action'] === 'rollback'
    ? await planRollback({
        targetRoot: values['--target'],
        backupId: values['--backup-id'],
        transactionId: values['--transaction-id'],
        replaceConflicts,
      })
    : await planUninstall({
        targetRoot: values['--target'],
        transactionId: values['--transaction-id'],
        replaceConflicts,
      });
  const lines = result.operations.map(item => [
    item.action,
    item.path,
    item.source,
    item.reason,
    item.current === null ? 'missing' : 'present',
  ].join('\t'));
  await writeFile(values['--operations-output'], `${lines.join('\n')}\n`, { mode: 0o600 });
  await writeFile(
    values['--receipt-output'],
    result.receipt === null ? '' : serializeInstallTransaction(result.receipt),
    { mode: 0o600 },
  );
  await writeFile(values['--token-output'], `${result.token}\n`, { mode: 0o600 });
}

async function verify(argv) {
  const values = parseVerifyArgs(argv);
  await verifyAppliedTransaction({
    targetRoot: values['--target'],
    transactionId: values['--backup-id'],
    receiptPath: values['--receipt'],
  });
}

async function main() {
  try {
    const argv = process.argv.slice(2);
    if (argv[0] === 'prepare') await prepare(argv);
    else if (argv[0] === 'lifecycle') await planLifecycle(argv);
    else if (argv[0] === 'verify') await verify(argv);
    else throw new Error('expected prepare, lifecycle, or verify command');
  } catch (error) {
    process.stderr.write(`install-manifest: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}

const invokedPath = process.argv[1] === undefined ? null : realpathSync(process.argv[1]);
if (invokedPath === realpathSync(fileURLToPath(import.meta.url))) await main();
