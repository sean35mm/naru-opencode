import { createHash } from 'node:crypto';
import { constants as fsConstants, realpathSync } from 'node:fs';
import type { Dirent, Stats } from 'node:fs';
import { copyFile, cp, lstat, mkdir, open, opendir, readlink, writeFile, } from 'node:fs/promises';
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

type PlainObject = Record<string, unknown>;
type LocationMode = 'global' | 'project' | 'custom';
type InstallMode = 'copy' | 'symlink';
type EntryMethod = 'copy' | 'symlink';
type EntryKind = 'file' | 'directory' | 'symlink';
type TransactionOperation = 'install' | 'rollback' | 'uninstall';
type Fingerprint = string;

export interface InstallOptions {
    dashboard: boolean;
    configureSubagentDepth: boolean;
    migrateOrchestrator: boolean;
}

export interface ManagedEntry {
    path: string;
    sourcePath: string;
    method: EntryMethod;
    sourceKind: EntryKind;
    sourceFingerprint: string;
    installedKind: EntryKind;
    installedFingerprint: string;
}

export interface InstallManifest {
    schemaVersion: typeof INSTALL_MANIFEST_SCHEMA_VERSION;
    product: typeof PRODUCT;
    sourceVersion: string;
    locationMode: LocationMode;
    installMode: InstallMode;
    options: InstallOptions;
    managed: ManagedEntry[];
}

export interface FilesystemSnapshot {
    kind: EntryKind;
    fingerprint: Fingerprint;
}

export interface BackedUpFilesystemSnapshot extends FilesystemSnapshot {
    backupPath: string;
}

export interface InstallTransactionChange {
    path: string;
    before: BackedUpFilesystemSnapshot | null;
    after: FilesystemSnapshot | null;
}

export interface InstallTransaction {
    schemaVersion: typeof INSTALL_TRANSACTION_SCHEMA_VERSION;
    product: typeof PRODUCT;
    transactionId: string;
    operation: TransactionOperation;
    beforeManifest: InstallManifest | null;
    afterManifest: InstallManifest | null;
    changes: InstallTransactionChange[];
}

interface FingerprintBudget {
    entries: number;
    bytes: number;
}

export interface FingerprintFileResult {
    bytes: Buffer;
    size: number;
}

interface InstallPlanEntry {
    method: string;
    source: string;
    path: string;
}

interface VerifyAppliedTransactionInput {
    targetRoot: string;
    transactionId: unknown;
    receiptPath: string;
}

interface BuildInstallManifestInput {
    sourceRoot: string;
    locationMode: unknown;
    installMode: unknown;
    options: unknown;
    planEntries: InstallPlanEntry[];
}

interface BuildInstallTransactionInput {
    transactionId: string;
    targetRoot: string;
    previousManifest: InstallManifest | null;
    desiredManifest: InstallManifest;
    operations: InstallPlanOperation[];
}

interface ClassifyInstallPlanInput {
    targetRoot: string;
    desiredManifest: unknown;
    previousManifest: unknown;
    replaceConflicts?: boolean;
    selectedPaths?: ReadonlySet<string> | null;
}

interface LifecycleTransactionInput {
    transactionId: string;
    operation: Exclude<TransactionOperation, 'install'>;
    beforeManifest: InstallManifest | null;
    afterManifest: InstallManifest | null;
    operations: LifecycleOperation[];
}

interface LifecycleConfirmationInput {
    targetRoot: string;
    action: Exclude<TransactionOperation, 'install'>;
    backupId: string | null;
    replaceConflicts: boolean;
    currentManifest: InstallManifest | null;
    selectedReceipt: InstallTransaction | null;
    operations: LifecycleOperation[];
}

interface RollbackPlanInput {
    targetRoot: string;
    backupId: string;
    transactionId: string;
    replaceConflicts: boolean;
}

interface UninstallPlanInput {
    targetRoot: string;
    transactionId: string;
    replaceConflicts: boolean;
}

export interface InstallPlanOperation {
    action: 'create' | 'update' | 'unchanged' | 'conflict-unowned' | 'conflict-modified'
        | 'retire' | 'retire-missing' | 'preserve-retired-modified' | 'preserve-orphaned'
        | 'preserve-unselected';
    reason: string;
    entry: ManagedEntry;
    current: FilesystemSnapshot | null;
    stageSource?: string;
}

export interface LifecycleOperation {
    action: 'unchanged' | 'remove' | 'restore' | 'conflict-modified' | 'missing'
        | 'preserve-dashboard' | 'preserve-modified' | 'preserve-manifest';
    path: string;
    source: string;
    reason: string;
    current: FilesystemSnapshot | null;
    desired: FilesystemSnapshot | null;
}

export interface LifecyclePlan {
    action: 'rollback' | 'uninstall';
    backupId: string | null;
    currentManifest: InstallManifest | null;
    selectedReceipt: InstallTransaction | null;
    operations: LifecycleOperation[];
    receipt: InstallTransaction | null;
    token: string;
}
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
    // Retired with the v-next simplification: seven minions collapsed into
    // reader/runner/writer, and the plugin runtime was removed entirely.
    'agents/naru-minion-scout.md',
    'agents/naru-minion-investigate.md',
    'agents/naru-minion-architect.md',
    'agents/naru-minion-implement.md',
    'agents/naru-minion-debug.md',
    'agents/naru-minion-verify.md',
    'agents/naru-minion-judge.md',
    'plugins/naru-delegate.js',
    'plugins/naru-scheduler.js',
    'plugins/naru-minions-dashboard.tsx',
    'plugins/naru-minions-dashboard-state.mjs',
    'tools/naru-scheduler.js',
    'scripts/naru-live-eval.mjs',
    'scripts/live-evals.example.json',
    // Retired in 0.2.0: agents inherit the user's default model, so the deep
    // reader was indistinguishable from the standard reader.
    'agents/naru-reader-deep.md',
]);
function isPlainObject(value: unknown): value is PlainObject {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function assertExactKeys(value: PlainObject, expected: readonly string[], label: string): void {
    const actual = Object.keys(value).sort();
    const wanted = [...expected].sort();
    if (JSON.stringify(actual) !== JSON.stringify(wanted)) {
        throw new Error(`${label} keys must be exactly ${wanted.join(', ')}`);
    }
}
function assertBoolean(value: unknown, label: string): asserts value is boolean {
    if (typeof value !== 'boolean')
        throw new Error(`${label} must be a boolean`);
}
function assertNonEmptyString(value: unknown, label: string): asserts value is string {
    if (typeof value !== 'string' || value.length === 0) {
        throw new Error(`${label} must be a non-empty string`);
    }
}
function assertFingerprint(value: unknown, label: string): asserts value is Fingerprint {
    if (typeof value !== 'string' || !FINGERPRINT_PATTERN.test(value)) {
        throw new Error(`${label} must be a supported SHA-256 fingerprint`);
    }
}
function stateEqual(left: FilesystemSnapshot | null, right: FilesystemSnapshot | null): boolean {
    return left === null
        ? right === null
        : right !== null && left.kind === right.kind && left.fingerprint === right.fingerprint;
}
function manifestEqual(left: InstallManifest | null, right: InstallManifest | null): boolean {
    if (left === null || right === null)
        return left === right;
    return serializeInstallManifest(left) === serializeInstallManifest(right);
}
export function normalizeManagedPath(value: unknown, label = 'managed path'): string {
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
function assertUnreservedManagedPath(value: string, label: string): void {
    for (const reserved of RESERVED_MANAGED_ROOTS) {
        if (value === reserved || value.startsWith(`${reserved}/`)) {
            throw new Error(`${label} uses reserved lifecycle path ${reserved}`);
        }
    }
}
function assertDisjointManagedPaths(values: Iterable<string>, label: string): void {
    const sorted = [...new Set(values)].sort();
    for (let index = 1; index < sorted.length; index += 1) {
        for (let parentIndex = 0; parentIndex < index; parentIndex += 1) {
            const child = sorted[index];
            const parent = sorted[parentIndex];
            if (child === undefined || parent === undefined)
                throw new Error(`${label} contains an invalid path`);
            if (child.startsWith(`${parent}/`)) {
                throw new Error(`${label} contains overlapping paths: ${parent} and ${child}`);
            }
        }
    }
}
function containedPath(root: string, relative: unknown, label: string): string {
    const normalized = normalizeManagedPath(relative, label);
    const resolvedRoot = path.resolve(root);
    const resolved = path.resolve(resolvedRoot, ...normalized.split('/'));
    if (resolved !== resolvedRoot && !resolved.startsWith(`${resolvedRoot}${path.sep}`)) {
        throw new Error(`${label} escapes its root`);
    }
    return resolved;
}
async function containedPathWithoutSymlinkParents(root: string, relative: unknown, label: string): Promise<string> {
    const normalized = normalizeManagedPath(relative, label);
    const resolvedRoot = path.resolve(root);
    const parts = normalized.split('/');
    let cursor = resolvedRoot;
    for (const part of parts.slice(0, -1)) {
        cursor = path.join(cursor, part);
        const stats = await statOrNull(cursor);
        if (stats === null)
            break;
        if (stats.isSymbolicLink() || !stats.isDirectory()) {
            throw new Error(`${label} has an unsafe parent`);
        }
    }
    return containedPath(resolvedRoot, normalized, label);
}
function hashBytes(value: string | Buffer): string {
    return createHash('sha256').update(value).digest('hex');
}
function hasErrorCode(error: unknown, code: string): boolean {
    return (typeof error === 'object' || typeof error === 'function')
        && error !== null
        && 'code' in error
        && error.code === code;
}
async function statOrNull(value: string): Promise<Stats | null> {
    try {
        return await lstat(value);
    }
    catch (error) {
        if (hasErrorCode(error, 'ENOENT'))
            return null;
        throw error;
    }
}
function compareNames(left: Dirent, right: Dirent): number {
    if (left.name < right.name)
        return -1;
    if (left.name > right.name)
        return 1;
    return 0;
}
async function fingerprintFile(absolute: string, state: FingerprintBudget | null = null): Promise<FingerprintFileResult> {
    const handle = await open(absolute, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    try {
        const stats = await handle.stat();
        if (!stats.isFile() || stats.size > MAX_FINGERPRINT_FILE_BYTES) {
            throw new Error('managed file exceeds fingerprint limits');
        }
        if (state !== null) {
            state.bytes += stats.size;
            if (state.bytes > MAX_FINGERPRINT_TREE_BYTES)
                throw new Error('managed tree exceeds fingerprint byte limit');
        }
        const bytes = await handle.readFile();
        return { bytes, size: stats.size };
    }
    finally {
        await handle.close();
    }
}
function fingerprintBudget(): FingerprintBudget {
    return { entries: 0, bytes: 0 };
}
function countFingerprintEntry(state: FingerprintBudget): void {
    state.entries += 1;
    if (state.entries > MAX_FINGERPRINT_TREE_ENTRIES)
        throw new Error('managed paths exceed fingerprint entry limit');
}
async function directoryRecords(root: string, relative = '', state = fingerprintBudget()): Promise<string[]> {
    const absolute = relative === '' ? root : containedPath(root, relative, 'tree path');
    const children = [];
    const directory = await opendir(absolute);
    try {
        for await (const child of directory) {
            countFingerprintEntry(state);
            children.push(child);
        }
    }
    finally {
        await directory.close().catch((error) => {
            if (!hasErrorCode(error, 'ERR_DIR_CLOSED'))
                throw error;
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
        }
        else if (stats.isFile()) {
            const file = await fingerprintFile(childAbsolute, state);
            records.push(`file\0${childRelative}\0${file.size}\0${hashBytes(file.bytes)}\0`);
        }
        else if (stats.isSymbolicLink()) {
            const target = await readlink(childAbsolute);
            records.push(`symlink\0${childRelative}\0${target}\0`);
        }
        else {
            throw new Error(`unsupported managed path type: ${childRelative}`);
        }
    }
    return records;
}
export async function fingerprintPath(absolute: string, state = fingerprintBudget()): Promise<FilesystemSnapshot | null> {
    const stats = await statOrNull(absolute);
    if (stats === null)
        return null;
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
function desiredSymlinkFingerprint(sourceAbsolute: string): Fingerprint {
    return `symlink-sha256:${hashBytes(sourceAbsolute)}`;
}
function isEntryMethod(value: unknown): value is EntryMethod {
    return typeof value === 'string' && ENTRY_METHODS.has(value);
}

function isEntryKind(value: unknown): value is EntryKind {
    return typeof value === 'string' && ENTRY_KINDS.has(value);
}

function isLocationMode(value: unknown): value is LocationMode {
    return typeof value === 'string' && LOCATION_MODES.has(value);
}

function isInstallMode(value: unknown): value is InstallMode {
    return typeof value === 'string' && INSTALL_MODES.has(value);
}

function isTransactionOperation(value: unknown): value is TransactionOperation {
    return typeof value === 'string' && TRANSACTION_OPERATIONS.has(value);
}

function validateEntry(value: unknown, index: number): asserts value is ManagedEntry {
    if (!isPlainObject(value))
        throw new Error(`managed[${index}] must be an object`);
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
    if (!isEntryMethod(value.method)) {
        throw new Error(`managed[${index}].method is invalid`);
    }
    if (!isEntryKind(value.sourceKind)) {
        throw new Error(`managed[${index}].sourceKind is invalid`);
    }
    if (!isEntryKind(value.installedKind)) {
        throw new Error(`managed[${index}].installedKind is invalid`);
    }
    assertNonEmptyString(value.sourceFingerprint, `managed[${index}].sourceFingerprint`);
    assertNonEmptyString(value.installedFingerprint, `managed[${index}].installedFingerprint`);
}

function assertManagedEntries(value: unknown[]): asserts value is ManagedEntry[] {
    const seen = new Set<string>();
    for (const [index, entry] of value.entries()) {
        validateEntry(entry, index);
        if (seen.has(entry.path))
            throw new Error(`duplicate managed path: ${entry.path}`);
        seen.add(entry.path);
    }
    assertDisjointManagedPaths(seen, 'install manifest managed');
}

function validateInstallOptions(value: unknown): asserts value is InstallOptions {
    if (!isPlainObject(value))
        throw new Error('install manifest options must be an object');
    assertExactKeys(value, [
        'dashboard',
        'configureSubagentDepth',
        'migrateOrchestrator',
    ], 'install manifest options');
    assertBoolean(value.dashboard, 'install manifest options.dashboard');
    assertBoolean(value.configureSubagentDepth, 'install manifest options.configureSubagentDepth');
    assertBoolean(value.migrateOrchestrator, 'install manifest options.migrateOrchestrator');
}

function assertValidInstallManifest(value: unknown): asserts value is InstallManifest {
    if (!isPlainObject(value))
        throw new Error('install manifest must be an object');
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
    if (value.product !== PRODUCT)
        throw new Error(`install manifest product must be ${PRODUCT}`);
    assertNonEmptyString(value.sourceVersion, 'install manifest sourceVersion');
    if (!isLocationMode(value.locationMode)) {
        throw new Error('install manifest locationMode is invalid');
    }
    if (!isInstallMode(value.installMode)) {
        throw new Error('install manifest installMode is invalid');
    }
    validateInstallOptions(value.options);
    if (!Array.isArray(value.managed) || value.managed.length > MAX_MANAGED_ENTRIES) {
        throw new Error(`install manifest managed must contain at most ${MAX_MANAGED_ENTRIES} entries`);
    }
    assertManagedEntries(value.managed);
}

export function validateInstallManifest(value: unknown): InstallManifest {
    assertValidInstallManifest(value);
    return value;
}
export function serializeInstallManifest(value: unknown): string {
    validateInstallManifest(value);
    return `${JSON.stringify(value, null, 2)}\n`;
}
export async function loadInstallManifest(targetRoot: string): Promise<InstallManifest | null> {
    const manifestPath = path.join(path.resolve(targetRoot), INSTALL_MANIFEST_FILE);
    const stats = await statOrNull(manifestPath);
    if (stats === null)
        return null;
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
    }
    finally {
        await handle.close();
    }
}
function manifestState(manifest: InstallManifest | null): FilesystemSnapshot | null {
    if (manifest === null)
        return null;
    return {
        kind: 'file',
        fingerprint: `sha256:${hashBytes(serializeInstallManifest(manifest))}`,
    };
}
function validateTransactionState(value: unknown, label: string, withBackupPath: true): BackedUpFilesystemSnapshot;
function validateTransactionState(value: unknown, label: string, withBackupPath: false): FilesystemSnapshot;
function validateTransactionState(value: unknown, label: string, withBackupPath: boolean): FilesystemSnapshot | BackedUpFilesystemSnapshot {
    if (!isPlainObject(value))
        throw new Error(`${label} must be an object`);
    const expected = withBackupPath ? ['kind', 'fingerprint', 'backupPath'] : ['kind', 'fingerprint'];
    assertExactKeys(value, expected, label);
    if (!isEntryKind(value.kind))
        throw new Error(`${label}.kind is invalid`);
    assertFingerprint(value.fingerprint, `${label}.fingerprint`);
    if (withBackupPath) {
        return {
            kind: value.kind,
            fingerprint: value.fingerprint,
            backupPath: normalizeManagedPath(value.backupPath, `${label}.backupPath`),
        };
    }
    return { kind: value.kind, fingerprint: value.fingerprint };
}
function validateOptionalManifest(value: unknown, label: string): InstallManifest | null {
    if (value === null)
        return null;
    try {
        return validateInstallManifest(value);
    }
    catch (error) {
        throw new Error(`${label}: ${error instanceof Error ? error.message : String(error)}`);
    }
}
function assertValidInstallTransaction(value: unknown): asserts value is InstallTransaction {
    if (!isPlainObject(value))
        throw new Error('install transaction must be an object');
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
    if (value.product !== PRODUCT)
        throw new Error(`install transaction product must be ${PRODUCT}`);
    if (typeof value.transactionId !== 'string' || !TRANSACTION_ID_PATTERN.test(value.transactionId)) {
        throw new Error('install transaction transactionId is invalid');
    }
    if (!isTransactionOperation(value.operation)) {
        throw new Error('install transaction operation is invalid');
    }
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
    const seen = new Set<string>();
    let previousPath: string | null = null;
    let manifestChange: InstallTransactionChange | null = null;
    for (const [index, change] of value.changes.entries()) {
        const label = `install transaction changes[${index}]`;
        if (!isPlainObject(change))
            throw new Error(`${label} must be an object`);
        assertExactKeys(change, ['path', 'before', 'after'], label);
        const managedPath = normalizeManagedPath(change.path, `${label}.path`);
        if (managedPath !== INSTALL_MANIFEST_FILE && !ownedPaths.has(managedPath)) {
            throw new Error(`${label}.path is not manifest-owned`);
        }
        if (seen.has(managedPath))
            throw new Error(`duplicate install transaction path: ${managedPath}`);
        if (previousPath !== null && managedPath < previousPath)
            throw new Error('install transaction changes must be path-sorted');
        seen.add(managedPath);
        previousPath = managedPath;
        const before = change.before === null
            ? null
            : validateTransactionState(change.before, `${label}.before`, true);
        if (before !== null && before.backupPath !== managedPath) {
            throw new Error(`${label}.before.backupPath must equal path`);
        }
        const after = change.after === null
            ? null
            : validateTransactionState(change.after, `${label}.after`, false);
        if (stateEqual(before, after))
            throw new Error(`${label} must change state`);
        if (managedPath === INSTALL_MANIFEST_FILE) {
            manifestChange = { path: managedPath, before, after };
        }
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
}

export function validateInstallTransaction(value: unknown): InstallTransaction {
    assertValidInstallTransaction(value);
    return value;
}
export function serializeInstallTransaction(value: unknown): string {
    validateInstallTransaction(value);
    const serialized = `${JSON.stringify(value, null, 2)}\n`;
    if (Buffer.byteLength(serialized) > MAX_INSTALL_TRANSACTION_BYTES) {
        throw new Error(`install transaction exceeds ${MAX_INSTALL_TRANSACTION_BYTES} bytes`);
    }
    return serialized;
}
async function loadJsonFile(absolute: string, maxBytes: number, label: string): Promise<unknown> {
    const stats = await statOrNull(absolute);
    if (stats === null)
        throw new Error(`${label} is missing`);
    if (stats.isSymbolicLink() || !stats.isFile())
        throw new Error(`${label} must be a regular non-symlinked file`);
    if (stats.size > maxBytes)
        throw new Error(`${label} exceeds ${maxBytes} bytes`);
    const handle = await open(absolute, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    try {
        return JSON.parse(await handle.readFile({ encoding: 'utf8' }));
    }
    finally {
        await handle.close();
    }
}
export async function loadInstallTransaction(targetRoot: string, transactionId: unknown): Promise<InstallTransaction> {
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
    const receipt = validateInstallTransaction(await loadJsonFile(path.join(transactionRoot, INSTALL_TRANSACTION_FILE), MAX_INSTALL_TRANSACTION_BYTES, `rollback backup ${transactionId} receipt`));
    if (receipt.transactionId !== transactionId)
        throw new Error('rollback receipt transactionId does not match backup id');
    const budget = fingerprintBudget();
    for (const change of receipt.changes) {
        if (change.before === null)
            continue;
        const backupAbsolute = await containedPathWithoutSymlinkParents(transactionRoot, change.before.backupPath, 'rollback backup path');
        const current = await fingerprintPath(backupAbsolute, budget);
        if (!stateEqual(current, change.before)) {
            throw new Error(`rollback backup is missing or modified: ${change.path}`);
        }
        if (change.path === INSTALL_MANIFEST_FILE) {
            const backupManifest = validateInstallManifest(await loadJsonFile(backupAbsolute, MAX_INSTALL_MANIFEST_BYTES, 'rollback backup ownership manifest'));
            if (!manifestEqual(backupManifest, receipt.beforeManifest)) {
                throw new Error('rollback backup ownership manifest does not match the receipt');
            }
        }
    }
    return receipt;
}
async function verifyAppliedTransaction({ targetRoot, transactionId, receiptPath, }: VerifyAppliedTransactionInput): Promise<void> {
    if (typeof transactionId !== 'string' || !TRANSACTION_ID_PATTERN.test(transactionId)) {
        throw new Error('transaction backup id is invalid');
    }
    const resolvedTarget = path.resolve(targetRoot);
    const transactionRoot = path.join(resolvedTarget, '.naru-backups', transactionId);
    const transactionStats = await statOrNull(transactionRoot);
    if (transactionStats === null || transactionStats.isSymbolicLink() || !transactionStats.isDirectory()) {
        throw new Error('transaction backup root is missing or unsafe');
    }
    const receipt = validateInstallTransaction(await loadJsonFile(receiptPath, MAX_INSTALL_TRANSACTION_BYTES, 'prepared install transaction receipt'));
    if (receipt.transactionId !== transactionId)
        throw new Error('prepared receipt transactionId does not match backup id');
    const backupBudget = fingerprintBudget();
    const targetBudget = fingerprintBudget();
    for (const change of receipt.changes) {
        const backupAbsolute = await containedPathWithoutSymlinkParents(transactionRoot, change.path, 'transaction backup path');
        const backupState = await fingerprintPath(backupAbsolute, backupBudget);
        if (!stateEqual(backupState, change.before)) {
            throw new Error(`transaction backup does not match confirmed state: ${change.path}`);
        }
        if (change.path === INSTALL_MANIFEST_FILE && change.before !== null) {
            const backupManifest = validateInstallManifest(await loadJsonFile(backupAbsolute, MAX_INSTALL_MANIFEST_BYTES, 'transaction backup ownership manifest'));
            if (!manifestEqual(backupManifest, receipt.beforeManifest)) {
                throw new Error('transaction backup ownership manifest does not match the prepared receipt');
            }
        }
        const targetAbsolute = await containedPathWithoutSymlinkParents(resolvedTarget, change.path, 'transaction target path');
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
export async function buildInstallManifest({ sourceRoot, locationMode, installMode, options, planEntries, }: BuildInstallManifestInput): Promise<InstallManifest> {
    const resolvedSourceRoot = path.resolve(sourceRoot);
    if (typeof locationMode !== 'string' || !LOCATION_MODES.has(locationMode))
        throw new Error('locationMode is invalid');
    if (typeof installMode !== 'string' || !INSTALL_MODES.has(installMode))
        throw new Error('installMode is invalid');
    if (!isPlainObject(options))
        throw new Error('options must be an object');
    if (!Array.isArray(planEntries) || planEntries.length > MAX_MANAGED_ENTRIES) {
        throw new Error(`plan must contain at most ${MAX_MANAGED_ENTRIES} entries`);
    }
    const managed = [];
    const sourceBudget = fingerprintBudget();
    for (const [index, item] of planEntries.entries()) {
        if (!isPlainObject(item))
            throw new Error(`plan entry ${index} must be an object`);
        const managedPath = normalizeManagedPath(item.path, `plan entry ${index} path`);
        const sourceAbsolute = path.resolve(item.source);
        const sourceRelativeNative = path.relative(resolvedSourceRoot, sourceAbsolute);
        if (sourceRelativeNative === '' || sourceRelativeNative.startsWith(`..${path.sep}`) || path.isAbsolute(sourceRelativeNative)) {
            throw new Error(`plan entry ${index} source is outside the source root`);
        }
        const sourcePath = normalizeManagedPath(sourceRelativeNative.split(path.sep).join('/'), `plan entry ${index} sourcePath`);
        if (typeof item.method !== 'string' || !ENTRY_METHODS.has(item.method)) {
            throw new Error(`plan entry ${index} method is invalid`);
        }
        const sourceState = await fingerprintPath(sourceAbsolute, sourceBudget);
        if (sourceState === null)
            throw new Error(`missing managed source: ${sourcePath}`);
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
        locationMode: locationMode,
        installMode: installMode,
        options: {
            dashboard: options.dashboard === true,
            configureSubagentDepth: options.configureSubagentDepth === true,
            migrateOrchestrator: options.migrateOrchestrator === true,
        },
        managed,
    });
}

function sourceVersionForManaged(managed: ManagedEntry[]): string {
    const input = managed.map(entry => [
        entry.sourcePath,
        entry.sourceKind,
        entry.sourceFingerprint,
    ].join('\0')).join('\n');
    return `sha256:${hashBytes(input)}`;
}

async function ensureContainedDirectory(root: string, relative: string): Promise<void> {
    if (relative === '.' || relative === '')
        return;
    let cursor = path.resolve(root);
    for (const part of normalizeManagedPath(relative, 'composite directory').split('/')) {
        cursor = path.join(cursor, part);
        const current = await statOrNull(cursor);
        if (current === null) {
            await mkdir(cursor);
        }
        else if (current.isSymbolicLink() || !current.isDirectory()) {
            throw new Error('composite directory has an unsafe parent');
        }
    }
}

async function buildSelectedInstallManifest({
    sourceRoot,
    targetRoot,
    requestedLocationMode,
    planEntries,
    selections,
    compositeRoot,
}: {
    sourceRoot: string;
    targetRoot: string;
    requestedLocationMode: unknown;
    planEntries: InstallPlanEntry[];
    selections: string[];
    compositeRoot: string;
}): Promise<{ manifest: InstallManifest; selectedOwners: Set<string>; leafSelections: Map<string, string[]> }> {
    const previous = await loadInstallManifest(targetRoot);
    if (previous === null)
        throw new Error('--only requires a valid prior .naru-install.json ownership manifest');
    if (previous.locationMode !== requestedLocationMode)
        throw new Error(`--only target location mode must remain ${previous.locationMode}`);
    if (selections.length === 0)
        throw new Error('--only requires at least one installed path');

    const planByPath = new Map<string, InstallPlanEntry>();
    for (const [index, entry] of planEntries.entries()) {
        const managedPath = normalizeManagedPath(entry.path, `plan entry ${index} path`);
        assertUnreservedManagedPath(managedPath, `plan entry ${index} path`);
        if (planByPath.has(managedPath))
            throw new Error(`duplicate plan path: ${managedPath}`);
        planByPath.set(managedPath, entry);
    }
    assertDisjointManagedPaths(planByPath.keys(), 'install plan');

    const normalizedSelections: string[] = [];
    const seenSelections = new Set<string>();
    for (const [index, selectionValue] of selections.entries()) {
        const selection = normalizeManagedPath(selectionValue, `--only path ${index + 1}`);
        assertUnreservedManagedPath(selection, `--only path ${index + 1}`);
        if (seenSelections.has(selection))
            throw new Error(`duplicate --only path: ${selection}`);
        seenSelections.add(selection);
        normalizedSelections.push(selection);
    }
    assertDisjointManagedPaths(normalizedSelections, '--only paths');

    const previousByPath = new Map(previous.managed.map(entry => [entry.path, entry]));
    const selectedOwners = new Set<string>();
    const leafSelections = new Map<string, string[]>();
    for (const selection of normalizedSelections) {
        let owner = selection;
        if (!planByPath.has(selection)) {
            owner = 'tools/naru-lib';
            if (!selection.startsWith(`${owner}/`) || !planByPath.has(owner))
                throw new Error(`unknown --only installed path: ${selection}`);
            const leaves = leafSelections.get(owner) ?? [];
            leaves.push(selection.slice(owner.length + 1));
            leafSelections.set(owner, leaves);
        }
        if (!previousByPath.has(owner))
            throw new Error(`--only path is not owned by the prior manifest: ${selection}`);
        selectedOwners.add(owner);
    }

    const adjustedPlan = planEntries.map(entry => ({
        ...entry,
        method: previousByPath.get(entry.path)?.method ?? entry.method,
    }));
    const packageManifest = await buildInstallManifest({
        sourceRoot,
        locationMode: previous.locationMode,
        installMode: previous.installMode,
        options: previous.options,
        planEntries: adjustedPlan,
    });
    const packageByPath = new Map(packageManifest.managed.map(entry => [entry.path, entry]));
    const selectedEntries = new Map<string, ManagedEntry>();
    for (const owner of selectedOwners) {
        const candidate = packageByPath.get(owner);
        if (candidate === undefined)
            throw new Error(`selected path is not in the fixed install plan: ${owner}`);
        selectedEntries.set(owner, candidate);
    }

    for (const [owner, leaves] of leafSelections) {
        const previousEntry = previousByPath.get(owner);
        if (previousEntry === undefined || previousEntry.method !== 'copy' || previousEntry.installedKind !== 'directory') {
            throw new Error(`--only descendants require an existing copy-managed directory: ${owner}`);
        }
        const targetOwner = await containedPathWithoutSymlinkParents(targetRoot, owner, 'composite target path');
        const baseline = await fingerprintPath(targetOwner);
        if (!stateMatches(baseline, previousEntry)) {
            throw new Error(`copy-managed directory baseline is missing or modified: ${owner}`);
        }
        const compositeOwner = containedPath(compositeRoot, owner, 'composite path');
        await mkdir(path.dirname(compositeOwner), { recursive: true });
        await cp(targetOwner, compositeOwner, { recursive: true, dereference: false, errorOnExist: true });
        const copiedBaseline = await fingerprintPath(compositeOwner);
        if (!stateMatches(copiedBaseline, previousEntry))
            throw new Error(`copy-managed directory changed while staging: ${owner}`);

        for (const leaf of leaves) {
            const sourceRelative = `${owner}/${leaf}`;
            const sourceAbsolute = await containedPathWithoutSymlinkParents(sourceRoot, sourceRelative, 'selected package leaf');
            const sourceStats = await statOrNull(sourceAbsolute);
            if (sourceStats === null || sourceStats.isSymbolicLink() || !sourceStats.isFile())
                throw new Error(`selected package leaf must be a regular file: ${sourceRelative}`);
            await ensureContainedDirectory(compositeOwner, path.posix.dirname(leaf));
            const compositeLeaf = await containedPathWithoutSymlinkParents(compositeOwner, leaf, 'composite leaf');
            const existing = await statOrNull(compositeLeaf);
            if (existing !== null && (existing.isSymbolicLink() || !existing.isFile()))
                throw new Error(`composite leaf is not a regular file: ${sourceRelative}`);
            await copyFile(sourceAbsolute, compositeLeaf);
            const [sourceState, stagedState] = await Promise.all([
                fingerprintPath(sourceAbsolute),
                fingerprintPath(compositeLeaf),
            ]);
            if (!stateEqual(sourceState, stagedState))
                throw new Error(`selected package leaf changed while staging: ${sourceRelative}`);
        }
        const compositeState = await fingerprintPath(compositeOwner);
        if (compositeState === null || compositeState.kind !== 'directory')
            throw new Error(`failed to stage copy-managed directory: ${owner}`);
        selectedEntries.set(owner, {
            ...previousEntry,
            sourceKind: compositeState.kind,
            sourceFingerprint: compositeState.fingerprint,
            installedKind: compositeState.kind,
            installedFingerprint: compositeState.fingerprint,
        });
    }

    const managed = previous.managed.map(entry => selectedEntries.get(entry.path) ?? entry);
    const manifest = validateInstallManifest({
        ...previous,
        sourceVersion: sourceVersionForManaged(managed),
        managed,
    });
    return { manifest, selectedOwners, leafSelections };
}
function stateMatches(current: FilesystemSnapshot | null, entry: ManagedEntry): boolean {
    return current !== null
        && current.kind === entry.installedKind
        && current.fingerprint === entry.installedFingerprint;
}
function installedState(entry: ManagedEntry): FilesystemSnapshot {
    return { kind: entry.installedKind, fingerprint: entry.installedFingerprint };
}
function backedUpState(state: FilesystemSnapshot | null, managedPath: string): BackedUpFilesystemSnapshot | null {
    if (state === null)
        return null;
    return { kind: state.kind, fingerprint: state.fingerprint, backupPath: managedPath };
}
async function buildInstallTransaction({ transactionId, targetRoot, previousManifest, desiredManifest, operations, }: BuildInstallTransactionInput): Promise<InstallTransaction | null> {
    const changes = [];
    for (const operation of operations) {
        if (!['create', 'update', 'conflict-unowned', 'conflict-modified', 'retire'].includes(operation.action))
            continue;
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
    if (changes.length === 0)
        return null;
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
export async function classifyInstallPlan({ targetRoot, desiredManifest: desiredManifestValue, previousManifest: previousManifestValue, replaceConflicts = false, selectedPaths = null, }: ClassifyInstallPlanInput): Promise<InstallPlanOperation[]> {
    const desiredManifest = validateInstallManifest(desiredManifestValue);
    const previousManifest = previousManifestValue === null
        ? null
        : validateInstallManifest(previousManifestValue);
    const previousByPath = new Map(previousManifest?.managed.map(entry => [entry.path, entry]) ?? []);
    const desiredPaths = new Set(desiredManifest.managed.map(entry => entry.path));
    const operations: InstallPlanOperation[] = [];
    const targetBudget = fingerprintBudget();
    for (const entry of desiredManifest.managed) {
        const current = await fingerprintPath(await containedPathWithoutSymlinkParents(targetRoot, entry.path, 'target path'), targetBudget);
        if (selectedPaths !== null && !selectedPaths.has(entry.path)) {
            const previous = previousByPath.get(entry.path);
            if (previous === undefined || JSON.stringify(previous) !== JSON.stringify(entry))
                throw new Error(`unselected ownership changed unexpectedly: ${entry.path}`);
            const reason = current === null
                ? 'unselected-missing-preserved'
                : stateMatches(current, previous)
                    ? 'unselected-healthy-preserved'
                    : 'unselected-modified-preserved';
            operations.push({ action: 'preserve-unselected', reason, entry, current });
            continue;
        }
        let action: InstallPlanOperation['action'];
        let reason: string;
        if (current === null) {
            action = 'create';
            reason = 'missing';
        }
        else if (stateMatches(current, entry)) {
            action = 'unchanged';
            reason = 'matches-desired';
        }
        else {
            const previous = previousByPath.get(entry.path);
            if (previous === undefined) {
                action = 'conflict-unowned';
                reason = 'not-owned-by-manifest';
            }
            else if (stateMatches(current, previous)) {
                action = 'update';
                reason = 'owned-and-unmodified';
            }
            else {
                action = 'conflict-modified';
                reason = 'changed-after-install';
            }
        }
        operations.push({ action, reason, entry, current });
    }
    for (const entry of selectedPaths === null ? previousManifest?.managed ?? [] : []) {
        if (!desiredPaths.has(entry.path)) {
            if (RETIRED_MANAGED_PATHS.has(entry.path)) {
                const current = await fingerprintPath(await containedPathWithoutSymlinkParents(targetRoot, entry.path, 'retired target path'), targetBudget);
                let action: InstallPlanOperation['action'];
                let reason: string;
                if (current === null) {
                    action = 'retire-missing';
                    reason = 'previously-owned-already-missing';
                }
                else if (stateMatches(current, entry)) {
                    action = 'retire';
                    reason = 'previously-owned-and-unmodified';
                }
                else if (replaceConflicts) {
                    action = 'retire';
                    reason = 'reviewed-conflict-choice';
                }
                else {
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
function lifecycleTransaction({ transactionId, operation, beforeManifest, afterManifest, operations, }: LifecycleTransactionInput): InstallTransaction | null {
    const changes = operations
        .filter(item => item.action === 'remove' || item.action === 'restore')
        .map(item => ({
        path: item.path,
        before: backedUpState(item.current, item.path),
        after: item.desired,
    }))
        .sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
    if (changes.length === 0)
        return null;
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
function lifecycleConfirmationToken({ targetRoot, action, backupId, replaceConflicts, currentManifest, selectedReceipt, operations, }: LifecycleConfirmationInput): string {
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
async function planRollback({ targetRoot, backupId, transactionId, replaceConflicts, }: RollbackPlanInput): Promise<LifecyclePlan> {
    const selectedReceipt = await loadInstallTransaction(targetRoot, backupId);
    const currentManifest = await loadInstallManifest(targetRoot);
    if (!manifestEqual(currentManifest, selectedReceipt.afterManifest)) {
        throw new Error('rollback is stale: current ownership manifest does not match the selected transaction');
    }
    const operations: LifecycleOperation[] = [];
    const budget = fingerprintBudget();
    for (const change of selectedReceipt.changes) {
        const current = await fingerprintPath(await containedPathWithoutSymlinkParents(targetRoot, change.path, 'rollback target path'), budget);
        const desired = change.before === null ? null : {
            kind: change.before.kind,
            fingerprint: change.before.fingerprint,
        };
        const expected = change.after;
        const source = change.before === null ? '-' : `.naru-backups/${backupId}/${change.before.backupPath}`;
        let action: LifecycleOperation['action'];
        let reason: string;
        if (stateEqual(current, desired)) {
            action = 'unchanged';
            reason = 'already-at-rollback-state';
        }
        else if (stateEqual(current, expected)) {
            action = desired === null ? 'remove' : 'restore';
            reason = 'matches-selected-transaction';
        }
        else if (replaceConflicts) {
            action = desired === null ? 'remove' : 'restore';
            reason = 'reviewed-conflict-choice';
        }
        else {
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
async function planUninstall({ targetRoot, transactionId, replaceConflicts, }: UninstallPlanInput): Promise<LifecyclePlan> {
    const currentManifest = await loadInstallManifest(targetRoot);
    if (currentManifest === null)
        throw new Error('uninstall requires a valid .naru-install.json ownership manifest');
    const operations: LifecycleOperation[] = [];
    const budget = fingerprintBudget();
    let preservedModified = 0;
    let preservedDashboard = 0;
    for (const entry of currentManifest.managed) {
        const current = await fingerprintPath(await containedPathWithoutSymlinkParents(targetRoot, entry.path, 'uninstall target path'), budget);
        if (current === null) {
            operations.push({
                action: 'missing',
                path: entry.path,
                source: '-',
                reason: 'already-missing',
                current,
                desired: null,
            });
        }
        else if (currentManifest.options.dashboard
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
        }
        else if (stateMatches(current, entry) || replaceConflicts) {
            operations.push({
                action: 'remove',
                path: entry.path,
                source: '-',
                reason: stateMatches(current, entry) ? 'manifest-owned-and-unmodified' : 'reviewed-conflict-choice',
                current,
                desired: null,
            });
        }
        else {
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
    const manifestCurrent = await fingerprintPath(await containedPathWithoutSymlinkParents(targetRoot, INSTALL_MANIFEST_FILE, 'uninstall manifest path'), budget);
    if (afterManifest === null) {
        operations.push({
            action: 'remove',
            path: INSTALL_MANIFEST_FILE,
            source: '-',
            reason: 'full-uninstall',
            current: manifestCurrent,
            desired: null,
        });
    }
    else {
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
export async function inferInstallSourceRoot(targetRoot: string, manifestValue: unknown): Promise<string | null> {
    const manifest = validateInstallManifest(manifestValue);
    let inferred = null;
    for (const entry of manifest.managed) {
        if (entry.method !== 'symlink')
            continue;
        const installed = await containedPathWithoutSymlinkParents(targetRoot, entry.path, 'installed path');
        const stats = await statOrNull(installed);
        if (stats === null || !stats.isSymbolicLink())
            continue;
        const resolvedTarget = path.resolve(path.dirname(installed), await readlink(installed));
        const sourceParts = entry.sourcePath.split('/');
        let candidate = resolvedTarget;
        for (let index = 0; index < sourceParts.length; index += 1)
            candidate = path.dirname(candidate);
        if (path.resolve(candidate, ...sourceParts) !== resolvedTarget)
            continue;
        if (inferred !== null && inferred !== candidate)
            return null;
        inferred = candidate;
    }
    return inferred;
}
export async function inspectInstallManifest({ targetRoot, manifest: manifestValue, sourceRoot = null, }: {
    targetRoot: string;
    manifest: unknown;
    sourceRoot?: string | null;
}): Promise<Array<{
    path: string;
    method: EntryMethod;
    installedStatus: 'healthy' | 'missing' | 'modified';
    sourceStatus: 'unknown' | 'missing' | 'matched' | 'copy-stale' | 'symlink-live-source-changed';
}>> {
    const manifest = validateInstallManifest(manifestValue);
    const resolvedSourceRoot = sourceRoot === null ? null : path.resolve(sourceRoot);
    const entries = [];
    const installedBudget = fingerprintBudget();
    const sourceBudget = fingerprintBudget();
    for (const entry of manifest.managed) {
        const current = await fingerprintPath(await containedPathWithoutSymlinkParents(targetRoot, entry.path, 'installed path'), installedBudget);
        let installedStatus: 'healthy' | 'missing' | 'modified' = 'healthy';
        if (current === null)
            installedStatus = 'missing';
        else if (!stateMatches(current, entry))
            installedStatus = 'modified';
        let sourceStatus: 'unknown' | 'missing' | 'matched' | 'copy-stale' | 'symlink-live-source-changed' = 'unknown';
        if (resolvedSourceRoot !== null) {
            const source = await fingerprintPath(await containedPathWithoutSymlinkParents(resolvedSourceRoot, entry.sourcePath, 'source path'), sourceBudget);
            if (source === null)
                sourceStatus = 'missing';
            else if (source.kind === entry.sourceKind && source.fingerprint === entry.sourceFingerprint)
                sourceStatus = 'matched';
            else
                sourceStatus = entry.method === 'copy' ? 'copy-stale' : 'symlink-live-source-changed';
        }
        entries.push({ path: entry.path, method: entry.method, installedStatus, sourceStatus });
    }
    return entries;
}
interface PrepareArguments {
    '--source': string;
    '--target': string;
    '--plan': string;
    '--manifest-output': string;
    '--operations-output': string;
    '--receipt-output': string;
    '--transaction-id': string;
    '--location-mode': string;
    '--install-mode': string;
    '--dashboard': string;
    '--configure-subagent-depth': string;
    '--migrate-orchestrator': string;
    '--replace-conflicts': string;
    '--selected': string;
    '--composite-root': string;
    '--context-output': string;
}

interface LifecycleArguments {
    '--action': string;
    '--target': string;
    '--backup-id': string;
    '--operations-output': string;
    '--receipt-output': string;
    '--token-output': string;
    '--transaction-id': string;
    '--replace-conflicts': string;
}

interface VerifyArguments {
    '--target': string;
    '--backup-id': string;
    '--receipt': string;
}

interface VerifyPreparedArguments {
    '--source': string;
    '--target': string;
    '--stage': string;
    '--manifest': string;
    '--operations': string;
    '--receipt': string;
    '--selected': string;
    '--before-manifest-fingerprint': string;
}

function parseBoolean(value: string, label: string): boolean {
    if (value === 'true')
        return true;
    if (value === 'false')
        return false;
    throw new Error(`${label} must be true or false`);
}
function parseKeyValueArgs<Key extends string>(argv: string[], command: string, expected: readonly Key[]): Record<Key, string> {
    if (argv[0] !== command)
        throw new Error(`expected ${command} command`);
    const values: Record<string, string> = {};
    for (let index = 1; index < argv.length; index += 2) {
        const key = argv[index];
        const value = argv[index + 1];
        if (!key?.startsWith('--') || value === undefined)
            throw new Error(`invalid argument: ${key ?? ''}`);
        if (Object.hasOwn(values, key))
            throw new Error(`duplicate argument: ${key}`);
        values[key] = value;
    }
    assertExactKeys(values, expected, `${command} arguments`);
    return values as Record<Key, string>;
}
function parsePrepareArgs(argv: string[]): PrepareArguments {
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
        '--selected',
        '--composite-root',
        '--context-output',
    ]);
    if (!TRANSACTION_ID_PATTERN.test(values['--transaction-id']))
        throw new Error('prepare transaction id is invalid');
    return {
        '--source': values['--source'],
        '--target': values['--target'],
        '--plan': values['--plan'],
        '--manifest-output': values['--manifest-output'],
        '--operations-output': values['--operations-output'],
        '--receipt-output': values['--receipt-output'],
        '--transaction-id': values['--transaction-id'],
        '--location-mode': values['--location-mode'],
        '--install-mode': values['--install-mode'],
        '--dashboard': values['--dashboard'],
        '--configure-subagent-depth': values['--configure-subagent-depth'],
        '--migrate-orchestrator': values['--migrate-orchestrator'],
        '--replace-conflicts': values['--replace-conflicts'],
        '--selected': values['--selected'],
        '--composite-root': values['--composite-root'],
        '--context-output': values['--context-output'],
    };
}
function parseLifecycleArgs(argv: string[]): LifecycleArguments {
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
    if (!['rollback', 'uninstall'].includes(values['--action']))
        throw new Error('lifecycle action is invalid');
    if (!TRANSACTION_ID_PATTERN.test(values['--transaction-id']))
        throw new Error('lifecycle transaction id is invalid');
    if (values['--action'] === 'rollback') {
        if (!TRANSACTION_ID_PATTERN.test(values['--backup-id']))
            throw new Error('rollback backup id is invalid');
    }
    else if (values['--backup-id'] !== '-') {
        throw new Error('uninstall backup id must be -');
    }
    return {
        '--action': values['--action'],
        '--target': values['--target'],
        '--backup-id': values['--backup-id'],
        '--operations-output': values['--operations-output'],
        '--receipt-output': values['--receipt-output'],
        '--token-output': values['--token-output'],
        '--transaction-id': values['--transaction-id'],
        '--replace-conflicts': values['--replace-conflicts'],
    };
}
function parseVerifyArgs(argv: string[]): VerifyArguments {
    const values = parseKeyValueArgs(argv, 'verify', [
        '--target',
        '--backup-id',
        '--receipt',
    ]);
    if (!TRANSACTION_ID_PATTERN.test(values['--backup-id']))
        throw new Error('verify backup id is invalid');
    return {
        '--target': values['--target'],
        '--backup-id': values['--backup-id'],
        '--receipt': values['--receipt'],
    };
}

function parseVerifyPreparedArgs(argv: string[]): VerifyPreparedArguments {
    const values = parseKeyValueArgs(argv, 'verify-prepared', [
        '--source',
        '--target',
        '--stage',
        '--manifest',
        '--operations',
        '--receipt',
        '--selected',
        '--before-manifest-fingerprint',
    ]);
    return {
        '--source': values['--source'],
        '--target': values['--target'],
        '--stage': values['--stage'],
        '--manifest': values['--manifest'],
        '--operations': values['--operations'],
        '--receipt': values['--receipt'],
        '--selected': values['--selected'],
        '--before-manifest-fingerprint': values['--before-manifest-fingerprint'],
    };
}
async function readPlan(planPath: string): Promise<InstallPlanEntry[]> {
    const handle = await open(planPath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    let text;
    try {
        const stats = await handle.stat();
        if (!stats.isFile() || stats.size > MAX_INSTALL_MANIFEST_BYTES)
            throw new Error('install plan exceeds limits');
        text = await handle.readFile({ encoding: 'utf8' });
    }
    finally {
        await handle.close();
    }
    const entries: InstallPlanEntry[] = [];
    for (const [index, line] of text.split('\n').entries()) {
        if (line === '')
            continue;
        const fields = line.split('\t');
        if (fields.length !== 3)
            throw new Error(`plan line ${index + 1} is malformed`);
        const [method, source, entryPath] = fields;
        if (method === undefined || source === undefined || entryPath === undefined)
            throw new Error(`plan line ${index + 1} is malformed`);
        entries.push({ method, source, path: entryPath });
    }
    return entries;
}

async function readSelectedPaths(selectedPath: string): Promise<string[]> {
    if (selectedPath === '-')
        return [];
    const handle = await open(selectedPath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    try {
        const stats = await handle.stat();
        if (!stats.isFile() || stats.size > MAX_INSTALL_MANIFEST_BYTES)
            throw new Error('--only selection exceeds limits');
        return (await handle.readFile({ encoding: 'utf8' })).split('\n').filter(line => line !== '');
    }
    finally {
        await handle.close();
    }
}

async function prepare(argv: string[]): Promise<void> {
    const values = parsePrepareArgs(argv);
    const planEntries = await readPlan(values['--plan']);
    const previousManifest = await loadInstallManifest(values['--target']);
    const selections = await readSelectedPaths(values['--selected']);
    let desiredManifest: InstallManifest;
    let selectedOwners: Set<string> | null = null;
    let leafSelections = new Map<string, string[]>();
    if (values['--selected'] !== '-') {
        const selected = await buildSelectedInstallManifest({
            sourceRoot: values['--source'],
            targetRoot: values['--target'],
            requestedLocationMode: values['--location-mode'],
            planEntries,
            selections,
            compositeRoot: values['--composite-root'],
        });
        desiredManifest = selected.manifest;
        selectedOwners = selected.selectedOwners;
        leafSelections = selected.leafSelections;
    }
    else {
        desiredManifest = await buildInstallManifest({
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
    }
    const operations = await classifyInstallPlan({
        targetRoot: values['--target'],
        desiredManifest,
        previousManifest,
        replaceConflicts: parseBoolean(values['--replace-conflicts'], '--replace-conflicts'),
        selectedPaths: selectedOwners,
    });
    for (const owner of leafSelections.keys()) {
        const previousEntry = previousManifest?.managed.find(entry => entry.path === owner);
        const operation = operations.find(item => item.entry.path === owner);
        if (previousEntry === undefined || operation === undefined || !stateMatches(operation.current, previousEntry)) {
            throw new Error(`copy-managed directory baseline changed after staging: ${owner}`);
        }
    }
    for (const operation of operations) {
        if (leafSelections.has(operation.entry.path))
            operation.stageSource = containedPath(values['--composite-root'], operation.entry.path, 'composite stage source');
    }
    const receipt = await buildInstallTransaction({
        transactionId: values['--transaction-id'],
        targetRoot: values['--target'],
        previousManifest,
        desiredManifest,
        operations,
    });
    await writeFile(values['--manifest-output'], serializeInstallManifest(desiredManifest), { mode: 0o600 });
    const lines = operations.map(operation => [
        operation.action,
        operation.entry.method,
        operation.entry.sourcePath,
        operation.entry.path,
        operation.reason,
        operation.stageSource ?? '-',
    ].join('\t'));
    await writeFile(values['--operations-output'], `${lines.join('\n')}\n`, { mode: 0o600 });
    await writeFile(values['--receipt-output'], receipt === null ? '' : serializeInstallTransaction(receipt), { mode: 0o600 });
    const previousManifestState = await fingerprintPath(path.join(path.resolve(values['--target']), INSTALL_MANIFEST_FILE));
    const previousManifestFingerprint = previousManifestState === null ? 'missing' : previousManifestState.fingerprint;
    await writeFile(values['--context-output'], `${desiredManifest.locationMode}\t${desiredManifest.installMode}\t${previousManifestFingerprint}\n`, { mode: 0o600 });
}
async function planLifecycle(argv: string[]): Promise<void> {
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
    await writeFile(values['--receipt-output'], result.receipt === null ? '' : serializeInstallTransaction(result.receipt), { mode: 0o600 });
    await writeFile(values['--token-output'], `${result.token}\n`, { mode: 0o600 });
}
async function verify(argv: string[]): Promise<void> {
    const values = parseVerifyArgs(argv);
    await verifyAppliedTransaction({
        targetRoot: values['--target'],
        transactionId: values['--backup-id'],
        receiptPath: values['--receipt'],
    });
}

async function verifyPrepared(argv: string[]): Promise<void> {
    const values = parseVerifyPreparedArgs(argv);
    const desiredManifest = validateInstallManifest(await loadJsonFile(values['--manifest'], MAX_INSTALL_MANIFEST_BYTES, 'prepared ownership manifest'));
    const currentManifest = await loadInstallManifest(values['--target']);
    const currentManifestState = await fingerprintPath(path.join(path.resolve(values['--target']), INSTALL_MANIFEST_FILE));
    const currentManifestFingerprint = currentManifestState === null ? 'missing' : currentManifestState.fingerprint;
    if (currentManifestFingerprint !== values['--before-manifest-fingerprint'])
        throw new Error('ownership manifest bytes changed after install planning');
    const receiptStats = await statOrNull(values['--receipt']);
    const receipt = receiptStats === null || receiptStats.size === 0
        ? null
        : validateInstallTransaction(await loadJsonFile(values['--receipt'], MAX_INSTALL_TRANSACTION_BYTES, 'prepared install transaction receipt'));
    if (receipt === null) {
        if (!manifestEqual(currentManifest, desiredManifest))
            throw new Error('ownership manifest changed after install planning');
    }
    else if (!manifestEqual(currentManifest, receipt.beforeManifest)) {
        throw new Error('ownership manifest changed after install planning');
    }
    if (receipt !== null && !manifestEqual(receipt.afterManifest, desiredManifest))
        throw new Error('prepared receipt does not match the desired ownership manifest');

    const operationHandle = await open(values['--operations'], fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    let operationText: string;
    try {
        operationText = await operationHandle.readFile({ encoding: 'utf8' });
    }
    finally {
        await operationHandle.close();
    }
    const desiredByPath = new Map(desiredManifest.managed.map(entry => [entry.path, entry]));
    const receiptByPath = new Map(receipt?.changes.map(change => [change.path, change]) ?? []);
    const selections = await readSelectedPaths(values['--selected']);
    const selectedDescendantOwners = new Set(selections
        .filter(selection => selection.startsWith('tools/naru-lib/'))
        .map(() => 'tools/naru-lib'));
    for (const owner of selectedDescendantOwners) {
        const previousEntry = receipt?.beforeManifest?.managed.find(entry => entry.path === owner)
            ?? currentManifest?.managed.find(entry => entry.path === owner);
        const current = await fingerprintPath(await containedPathWithoutSymlinkParents(values['--target'], owner, 'prepared composite target path'));
        if (previousEntry === undefined || !stateMatches(current, previousEntry))
            throw new Error(`copy-managed directory baseline changed after install planning: ${owner}`);
    }
    for (const [index, line] of operationText.split('\n').entries()) {
        if (line === '')
            continue;
        const fields = line.split('\t');
        if (fields.length !== 6)
            throw new Error(`prepared operation line ${index + 1} is malformed`);
        const [action, , , operationPath] = fields;
        if (action === undefined || operationPath === undefined)
            throw new Error(`prepared operation line ${index + 1} is malformed`);
        if (action === 'preserve-unselected' || action === 'preserve-orphaned' || action === 'retire-missing' || action === 'preserve-retired-modified')
            continue;
        const entry = desiredByPath.get(operationPath)
            ?? receipt?.beforeManifest?.managed.find(candidate => candidate.path === operationPath);
        if (entry === undefined)
            throw new Error(`prepared operation path is not desired: ${operationPath}`);
        const current = await fingerprintPath(await containedPathWithoutSymlinkParents(values['--target'], operationPath, 'prepared target path'));
        if (action === 'unchanged') {
            if (!stateMatches(current, entry))
                throw new Error(`selected target changed after install planning: ${operationPath}`);
            continue;
        }
        const change = receiptByPath.get(operationPath);
        if (change === undefined || !stateEqual(current, change.before))
            throw new Error(`selected target changed after install planning: ${operationPath}`);
        if (action !== 'retire') {
            const staged = await fingerprintPath(await containedPathWithoutSymlinkParents(values['--stage'], operationPath, 'prepared staged path'));
            if (!stateEqual(staged, change.after))
                throw new Error(`staged result does not match the prepared receipt: ${operationPath}`);
        }
    }

    const manifestChange = receiptByPath.get(INSTALL_MANIFEST_FILE);
    if (manifestChange !== undefined) {
        const currentManifestState = await fingerprintPath(await containedPathWithoutSymlinkParents(values['--target'], INSTALL_MANIFEST_FILE, 'current manifest path'));
        if (!stateEqual(currentManifestState, manifestChange.before))
            throw new Error('ownership manifest bytes changed after install planning');
        const stagedManifestState = await fingerprintPath(await containedPathWithoutSymlinkParents(values['--stage'], INSTALL_MANIFEST_FILE, 'staged manifest path'));
        if (!stateEqual(stagedManifestState, manifestChange.after))
            throw new Error('staged ownership manifest does not match the prepared receipt');
    }
    for (const change of receipt?.changes ?? []) {
        if (change.path === INSTALL_MANIFEST_FILE || change.after === null)
            continue;
        const staged = await fingerprintPath(await containedPathWithoutSymlinkParents(values['--stage'], change.path, 'receipt staged path'));
        if (!stateEqual(staged, change.after))
            throw new Error(`staged result does not match the prepared receipt: ${change.path}`);
    }

    const leafSelections = selections.filter(selection => selection.startsWith('tools/naru-lib/'));
    const leafOwnerSelected = leafSelections.length > 0;
    for (const selection of selections) {
        const normalized = normalizeManagedPath(selection, '--only verification path');
        if (normalized.startsWith('tools/naru-lib/')) {
            const source = await fingerprintPath(await containedPathWithoutSymlinkParents(values['--source'], normalized, 'selected package source'));
            const staged = await fingerprintPath(await containedPathWithoutSymlinkParents(values['--stage'], normalized, 'selected staged leaf'));
            if (source === null || source.kind !== 'file' || !stateEqual(source, staged))
                throw new Error(`selected package source changed after staging: ${normalized}`);
            continue;
        }
        const entry = desiredByPath.get(normalized);
        if (entry === undefined)
            throw new Error(`selected path is not desired: ${normalized}`);
        if (normalized === 'tools/naru-lib' && leafOwnerSelected)
            continue;
        const source = await fingerprintPath(await containedPathWithoutSymlinkParents(values['--source'], entry.sourcePath, 'selected source path'));
        if (source === null || source.kind !== entry.sourceKind || source.fingerprint !== entry.sourceFingerprint)
            throw new Error(`selected source changed after install planning: ${normalized}`);
    }
}
async function main(): Promise<void> {
    try {
        const argv = process.argv.slice(2);
        if (argv[0] === 'prepare')
            await prepare(argv);
        else if (argv[0] === 'lifecycle')
            await planLifecycle(argv);
        else if (argv[0] === 'verify')
            await verify(argv);
        else if (argv[0] === 'verify-prepared')
            await verifyPrepared(argv);
        else
            throw new Error('expected prepare, lifecycle, verify, or verify-prepared command');
    }
    catch (error) {
        process.stderr.write(`install-manifest: ${error instanceof Error ? error.message : String(error)}\n`);
        process.exitCode = 1;
    }
}
function realpathOrNull(value: string): string | null {
    try {
        return realpathSync(value);
    }
    catch {
        return null;
    }
}
const invokedPath = process.argv[1] === undefined ? null : realpathOrNull(process.argv[1]);
if (invokedPath !== null && invokedPath === realpathSync(fileURLToPath(import.meta.url)))
    await main();
