import { createHash, randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { link, lstat, mkdir, open, readFile, readdir, rename, rm } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { promisify } from 'node:util';
import { loadGlobalInstructions, validateGlobalInstructionsSetting, type GlobalInstructionsSnapshot } from './global-instructions.mjs';
import { LEGACY_STANDALONE_NARU_AGENT, ensureOc2NativeDirectories, inspectOc2NativeDirectories, oc2NativePaths, type Oc2NativePaths } from './oc2-profile.mjs';
import { NATIVE_MODEL_LIMIT, projectOc2NativeAgents, type NativeAgent } from './oc2-native-projection.mjs';
import { parseCatalogueReference } from './native-reader-projection.mjs';

export interface Oc2NativeInstructionMetadata { sourcePath: string; canonicalPath: string; sha256: string; byteLength: number }
export interface Oc2NativeModelProfile { schemaVersion: 2; models: string[]; preferences: Record<string, unknown>; instructions: Oc2NativeInstructionMetadata | null }
interface ManagedProjection { schemaVersion: 1; agents: Record<string, NativeAgent> }
interface Snapshot { exists: boolean; bytes?: Buffer; dev?: bigint; ino?: bigint; size?: bigint; mtimeNs?: bigint; ctimeNs?: bigint }
interface TransactionEntry { key: 'config' | 'ownership' | 'profile'; oldExists: boolean }
interface TransactionManifest { schemaVersion: 1; entries: TransactionEntry[] }
export interface NativeConfigAdapters {
    expectedModels?: readonly string[] | null;
    beforeConfigCommit?: () => Promise<void>;
    afterLockStaged?: () => Promise<void>;
    afterLockAcquired?: () => Promise<void>;
    afterTransactionStageFile?: (index: number, path: string) => Promise<void>;
    afterTransactionPublished?: () => Promise<void>;
    afterCommitFile?: (index: number, path: string) => Promise<void>;
    rename?: typeof rename;
    home?: string;
    processIdentity?: (pid: number) => Promise<string | null>;
}

function object(value: unknown, label: string): Record<string, unknown> {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be a JSON object`);
    return value as Record<string, unknown>;
}
function parseJson(bytes: Buffer, label: string): unknown {
    try { return JSON.parse(bytes.toString('utf8')); } catch { throw new Error(`${label} contains malformed JSON`); }
}
function validModels(value: unknown, allowEmpty = true): string[] {
    if (!Array.isArray(value) || (!allowEmpty && value.length === 0) || value.length > NATIVE_MODEL_LIMIT || !value.every(item => typeof item === 'string')) throw new Error(`Native model pool must contain ${allowEmpty ? '0–32' : '1–32'} exact references`);
    const models = value as string[], seen = new Set<string>();
    for (const reference of models) {
        parseCatalogueReference(reference);
        if (seen.has(reference)) throw new Error(`Duplicate native model reference: ${reference}`);
        seen.add(reference);
    }
    return [...models];
}
function safePreferences(value: unknown): Record<string, unknown> {
    const preferences = object(value, 'Native model preferences');
    const serialized = JSON.stringify(preferences);
    const sensitive = (item: unknown): boolean => item !== null && typeof item === 'object' && Object.entries(item as Record<string, unknown>).some(([key, nested]) => /(?:secret|token|password|credential|cookie|api.?key|auth)/iu.test(key) || sensitive(nested));
    if (Buffer.byteLength(serialized) > 16 * 1024 || sensitive(preferences)) throw new Error('Native model preferences contain unsupported or sensitive fields');
    return preferences;
}
function instructionMetadata(value: unknown): Oc2NativeInstructionMetadata | null {
    if (value === null) return null;
    const record = object(value, 'Native global instructions metadata');
    if (Object.keys(record).sort().join(',') !== 'byteLength,canonicalPath,sha256,sourcePath' || typeof record.sourcePath !== 'string' || typeof record.canonicalPath !== 'string'
        || !/^[a-f0-9]{64}$/.test(String(record.sha256)) || !Number.isSafeInteger(record.byteLength) || (record.byteLength as number) < 1) throw new Error('Native global instructions metadata is invalid');
    return record as unknown as Oc2NativeInstructionMetadata;
}

async function snapshot(path: string): Promise<Snapshot> {
    try {
        const info = await lstat(path, { bigint: true });
        if (!info.isFile() || info.isSymbolicLink() || (process.getuid && info.uid !== BigInt(process.getuid())) || (info.mode & 0o077n) !== 0n) throw new Error(`${basename(path)} must be an owned private regular file, not a symlink`);
        const bytes = await readFile(path), after = await lstat(path, { bigint: true });
        if (after.dev !== info.dev || after.ino !== info.ino || after.size !== info.size || after.mtimeNs !== info.mtimeNs || after.ctimeNs !== info.ctimeNs) throw new Error(`${basename(path)} changed while it was being read`);
        return { exists: true, bytes, dev: info.dev, ino: info.ino, size: info.size, mtimeNs: info.mtimeNs, ctimeNs: info.ctimeNs };
    } catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return { exists: false };
        throw error;
    }
}
function same(left: Snapshot, right: Snapshot): boolean {
    return left.exists === right.exists && (!left.exists || left.dev === right.dev && left.ino === right.ino && left.size === right.size && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs && left.bytes!.equals(right.bytes!));
}
function bytesMatch(current: Snapshot, exists: boolean, bytes?: Buffer): boolean { return current.exists === exists && (!exists || current.bytes!.equals(bytes!)); }
async function writeAtomic(path: string, bytes: Buffer, expected?: Snapshot, renameFile: typeof rename = rename): Promise<Snapshot> {
    const temporary = join(dirname(path), `.${basename(path)}.oc2-${process.pid}-${randomBytes(8).toString('hex')}`);
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
        handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
        await handle.writeFile(bytes); await handle.sync(); await handle.close(); handle = undefined;
        if (expected && !same(expected, await snapshot(path))) throw new Error(`${basename(path)} changed concurrently; refusing to overwrite it`);
        await renameFile(temporary, path);
        return snapshot(path);
    } finally { await handle?.close().catch(() => undefined); await rm(temporary, { force: true }).catch(() => undefined); }
}
const execFileAsync = promisify(execFile);
async function nativeProcessIdentity(pid: number): Promise<string | null> {
    try { process.kill(pid, 0); }
    catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'ESRCH') return null;
        throw new Error(`Could not verify whether OC2 profile lock PID ${pid} is alive`, { cause: error });
    }
    try {
        const { stdout } = await execFileAsync('/bin/ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin', LC_ALL: 'C' } });
        const identity = stdout.trim();
        if (!identity) throw new Error('process start identity was empty');
        return identity;
    } catch (error) {
        try { process.kill(pid, 0); }
        catch (recheckError) {
            if (recheckError instanceof Error && 'code' in recheckError && recheckError.code === 'ESRCH') return null;
            throw new Error(`Could not recheck OC2 profile lock PID ${pid}`, { cause: recheckError });
        }
        throw new Error(`Could not verify process identity for PID ${pid}`, { cause: error });
    }
}
interface NativeLockOwner { schemaVersion: 1; pid: number; processIdentity: string; nonce: string }
const lockStagingPrefix = '.native-profile.lock.staging-';
function lockOwner(bytes: Buffer): NativeLockOwner {
    const value = object(parseJson(bytes, 'OC2 native profile lock'), 'OC2 native profile lock');
    if (Object.keys(value).sort().join(',') !== 'nonce,pid,processIdentity,schemaVersion' || value.schemaVersion !== 1
        || !Number.isSafeInteger(value.pid) || (value.pid as number) <= 1 || typeof value.processIdentity !== 'string' || value.processIdentity.length < 1 || value.processIdentity.length > 256
        || typeof value.nonce !== 'string' || !/^[a-f0-9]{32}$/.test(value.nonce)) throw new Error('OC2 native profile lock is malformed; refusing to clear it');
    return value as unknown as NativeLockOwner;
}
async function reclaimStaleLock(paths: Oc2NativePaths, identify: (pid: number) => Promise<string | null>): Promise<void> {
    let observed: Snapshot;
    try { observed = await snapshot(paths.lock); }
    catch (error) {
        if (error instanceof Error && /changed while it was being read/.test(error.message)) throw new Error('Another OC2 native profile update is active (lock metadata is still being published)');
        throw error;
    }
    if (!observed.exists) return;
    const owner = lockOwner(observed.bytes!);
    const current = await identify(owner.pid);
    if (current === owner.processIdentity) throw new Error(`Another OC2 native profile update is active (PID ${owner.pid}, matching process identity)`);
    const rechecked = await snapshot(paths.lock);
    if (!same(observed, rechecked)) throw new Error('OC2 native profile lock changed while stale ownership was being verified');
    await rm(paths.lock);
}
function processIdentityHash(value: string): string { return createHash('sha256').update(value).digest('hex').slice(0, 16); }
async function cleanupLockStaging(paths: Oc2NativePaths, identify: (pid: number) => Promise<string | null>): Promise<void> {
    for (const name of await readdir(dirname(paths.lock))) {
        if (!name.startsWith(lockStagingPrefix)) continue;
        const match = name.match(/^\.native-profile\.lock\.staging-([1-9][0-9]*)-([a-f0-9]{16})-([a-f0-9]{16})$/);
        if (!match) throw new Error('OC2 native profile lock staging path is malformed; refusing to remove it');
        const path = join(dirname(paths.lock), name), observed = await snapshot(path), pid = Number(match[1]), expectedIdentityHash = match[2]!;
        if (!observed.exists) continue;
        const currentIdentity = await identify(pid);
        if (currentIdentity && processIdentityHash(currentIdentity) === expectedIdentityHash) continue;
        const rechecked = await snapshot(path);
        if (!same(observed, rechecked)) throw new Error('OC2 native profile lock staging file changed while stale ownership was being verified');
        await rm(path);
    }
}
async function acquire(paths: Oc2NativePaths, identify: (pid: number) => Promise<string | null>, adapters: NativeConfigAdapters): Promise<() => Promise<void>> {
    const processIdentity = await identify(process.pid);
    if (!processIdentity) throw new Error(`Could not determine process identity for OC2 native profile update PID ${process.pid}`);
    const owner: NativeLockOwner = { schemaVersion: 1, pid: process.pid, processIdentity, nonce: randomBytes(16).toString('hex') };
    await cleanupLockStaging(paths, identify);
    const staging = join(dirname(paths.lock), `${lockStagingPrefix}${process.pid}-${processIdentityHash(processIdentity)}-${randomBytes(8).toString('hex')}`);
    let handle: Awaited<ReturnType<typeof open>> | undefined, published = false, identity: Awaited<ReturnType<Awaited<ReturnType<typeof open>>['stat']>> | undefined;
    try {
        handle = await open(staging, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
        await handle.writeFile(JSON.stringify(owner) + '\n'); await handle.sync();
        identity = await handle.stat({ bigint: true }); await handle.close(); handle = undefined;
        await adapters.afterLockStaged?.();
        for (let attempt = 0; attempt < 2; attempt++) {
            try { await link(staging, paths.lock); published = true; break; }
            catch (error) {
                if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error;
                if (attempt > 0) throw new Error('OC2 native profile lock was recreated while reclaiming a stale owner');
                await reclaimStaleLock(paths, identify);
            }
        }
        if (!published) throw new Error('Could not publish OC2 native profile lock');
        if (!identity) throw new Error('OC2 native profile lock identity was not recorded');
        const publishedIdentity = identity;
        const current = await lstat(paths.lock, { bigint: true });
        if (current.dev !== publishedIdentity.dev || current.ino !== publishedIdentity.ino) throw new Error('OC2 native profile lock publication changed unexpectedly');
        await syncDirectory(dirname(paths.lock)); await rm(staging); await syncDirectory(dirname(paths.lock));
        return async () => { const final = await lstat(paths.lock, { bigint: true }); if (final.dev !== publishedIdentity.dev || final.ino !== publishedIdentity.ino) throw new Error('OC2 native profile lock changed unexpectedly'); await rm(paths.lock); };
    } catch (error) {
        await handle?.close().catch(() => undefined);
        if (published && identity) {
            try { const current = await lstat(paths.lock, { bigint: true }); if (current.dev === identity.dev && current.ino === identity.ino) await rm(paths.lock); } catch {}
        }
        await rm(staging, { force: true }).catch(() => undefined);
        throw error;
    }
}

function readProfile(value: unknown): Oc2NativeModelProfile {
    const record = object(value, 'OC2 native model profile');
    if (record.schemaVersion === 1 && Object.keys(record).sort().join(',') === 'models,preferences,schemaVersion') return { schemaVersion: 2, models: validModels(record.models), preferences: safePreferences(record.preferences), instructions: null };
    if (record.schemaVersion !== 2 || Object.keys(record).sort().join(',') !== 'instructions,models,preferences,schemaVersion') throw new Error('OC2 native model profile has an unsupported schema');
    return { schemaVersion: 2, models: validModels(record.models), preferences: safePreferences(record.preferences), instructions: instructionMetadata(record.instructions) };
}
function readManaged(value: unknown): ManagedProjection {
    const record = object(value, 'OC2 native ownership metadata');
    if (Object.keys(record).sort().join(',') !== 'agents,schemaVersion' || record.schemaVersion !== 1) throw new Error('OC2 native ownership metadata has an unsupported schema');
    return { schemaVersion: 1, agents: object(record.agents, 'OC2 managed agents') as Record<string, NativeAgent> };
}
async function importedProfile(root: string, home: string): Promise<{ models: string[]; instructions: GlobalInstructionsSnapshot | null }> {
    try {
        const state = await snapshot(join(root, 'state.json'));
        if (!state.exists) return { models: [], instructions: null };
        const value = object(parseJson(state.bytes!, 'Legacy preview state'), 'Legacy preview state');
        if (!Number.isSafeInteger(value.schemaVersion) || (value.schemaVersion as number) < 1 || (value.schemaVersion as number) > 6) throw new Error('Legacy preview state has an unsupported schema');
        let models: string[] = [];
        if ((value.schemaVersion as number) >= 3 && value.globalWorkerPool !== null && value.globalWorkerPool !== undefined) {
            const pool = object(value.globalWorkerPool, 'Legacy global worker pool');
            if (!Number.isSafeInteger(pool.revision) || (pool.revision as number) < 0) throw new Error('Legacy global worker pool has an invalid revision');
            models = validModels(pool.models);
        }
        if ((value.schemaVersion as number) < 5 || value.globalInstructions === undefined) return { models, instructions: null };
        const setting = await validateGlobalInstructionsSetting(value.globalInstructions, home);
        return { models, instructions: setting.source ? await loadGlobalInstructions(setting.source, home) : null };
    } catch (error) { throw error; }
}
async function currentInstructions(profile: Oc2NativeModelProfile, home: string): Promise<GlobalInstructionsSnapshot | null> {
    if (!profile.instructions) return null;
    return loadGlobalInstructions({ sourcePath: profile.instructions.sourcePath, canonicalPath: profile.instructions.canonicalPath }, home);
}
function metadata(snapshotValue: GlobalInstructionsSnapshot | null): Oc2NativeInstructionMetadata | null {
    if (!snapshotValue) return null;
    const { text: _text, ...value } = snapshotValue;
    return value;
}

export async function loadOc2NativeModelProfile(root: string): Promise<Oc2NativeModelProfile | null> {
    const paths = oc2NativePaths(root);
    if (!await inspectOc2NativeDirectories(paths)) return null;
    try { await lstat(paths.transaction); throw new Error('OC2 native profile has an interrupted transaction; run explicit native setup recovery before launching Naru'); }
    catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error; }
    const current = await snapshot(paths.profileState);
    return current.exists ? readProfile(parseJson(current.bytes!, 'OC2 native model profile')) : null;
}

async function mergeProjection(configSnapshot: Snapshot, managedSnapshot: Snapshot, projection: ReturnType<typeof projectOc2NativeAgents>): Promise<{ config: Record<string, unknown>; managed: ManagedProjection }> {
    const config = configSnapshot.exists ? object(parseJson(configSnapshot.bytes!, 'OpenCode profile config'), 'OpenCode profile config') : {};
    const configuredAgents = config.agents === undefined ? {} : object(config.agents, 'OpenCode profile agents');
    const previous = managedSnapshot.exists ? readManaged(parseJson(managedSnapshot.bytes!, 'OC2 native ownership metadata')) : null;
    if (previous) for (const [name, agent] of Object.entries(previous.agents)) {
        if (!isDeepStrictEqual(configuredAgents[name], agent)) throw new Error(`Managed native agent ${name} was changed outside OC2; refusing to overwrite it`);
        delete configuredAgents[name];
    }
    for (const [name, agent] of Object.entries(projection.agents)) {
        const existing = configuredAgents[name];
        const exactLegacy = name === 'naru' && isDeepStrictEqual(existing, LEGACY_STANDALONE_NARU_AGENT);
        if (existing !== undefined && !exactLegacy) throw new Error(`Native agent name ${name} collides with an unrelated profile entry`);
        configuredAgents[name] = agent;
    }
    config.agents = configuredAgents;
    return { config, managed: { schemaVersion: 1, agents: projection.agents } };
}

function mergeNativeAssets(config: Record<string, unknown>, root: string): void {
    const plugin = join(root, 'lib', 'tools', 'oc2-native-plugin'), skills = join(plugin, 'skills');
    for (const [key, required] of [['plugins', plugin], ['skills', skills]] as const) {
        const existing = config[key] === undefined ? [] : config[key];
        if (!Array.isArray(existing) || !existing.every(value => typeof value === 'string')) throw new Error(`OpenCode profile ${key} must be an array of paths`);
        config[key] = existing.includes(required) ? [...existing] : [...existing, required];
    }
}

const transactionKeys = ['config', 'ownership', 'profile'] as const;
const transactionStagingPrefix = '.native-profile-transaction.staging-';
function targetFor(paths: Oc2NativePaths, key: TransactionEntry['key']): string { return key === 'config' ? paths.configFile : key === 'ownership' ? paths.ownership : paths.profileState; }
async function transactionFile(path: string, bytes: Buffer): Promise<void> {
    const handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
}
const transactionFileNames = new Set(['manifest.json', ...transactionKeys.flatMap(key => [`${key}.old`, `${key}.new`])]);
async function removeIncompleteTransactionDirectory(path: string): Promise<void> {
    const before = await lstat(path, { bigint: true });
    if (!before.isDirectory() || before.isSymbolicLink() || (process.getuid && before.uid !== BigInt(process.getuid())) || (before.mode & 0o077n) !== 0n) throw new Error('OC2 native incomplete transaction directory is unsafe');
    const names = await readdir(path);
    if (names.some(name => !transactionFileNames.has(name))) throw new Error('OC2 native incomplete transaction contains unexpected data; refusing to remove it');
    for (const name of names) if (!(await snapshot(join(path, name))).exists) throw new Error('OC2 native incomplete transaction changed during validation');
    const after = await lstat(path, { bigint: true });
    if (after.dev !== before.dev || after.ino !== before.ino || after.mtimeNs !== before.mtimeNs || after.ctimeNs !== before.ctimeNs) throw new Error('OC2 native incomplete transaction changed during validation');
    await rm(path, { recursive: true });
}
async function cleanupTransactionStaging(paths: Oc2NativePaths): Promise<void> {
    for (const name of await readdir(dirname(paths.transaction))) {
        if (!name.startsWith(transactionStagingPrefix)) continue;
        if (!/^\.native-profile-transaction\.staging-[1-9][0-9]*-[a-f0-9]{16}$/.test(name)) throw new Error('OC2 native transaction staging path is malformed; refusing to remove it');
        await removeIncompleteTransactionDirectory(join(dirname(paths.transaction), name));
    }
}
async function recoverTransaction(paths: Oc2NativePaths): Promise<'none' | 'rolled-back' | 'committed'> {
    let info;
    try { info = await lstat(paths.transaction); } catch (error) { if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return 'none'; throw error; }
    if (!info.isDirectory() || info.isSymbolicLink() || (process.getuid && info.uid !== process.getuid()) || (info.mode & 0o077) !== 0) throw new Error('OC2 native transaction recovery path is unsafe');
    const manifestSnapshot = await snapshot(join(paths.transaction, 'manifest.json'));
    if (!manifestSnapshot.exists) { await removeIncompleteTransactionDirectory(paths.transaction); return 'rolled-back'; }
    const manifestValue = object(parseJson(manifestSnapshot.bytes!, 'OC2 native transaction manifest'), 'OC2 native transaction manifest');
    if (manifestValue.schemaVersion !== 1 || !Array.isArray(manifestValue.entries) || manifestValue.entries.length !== 3) throw new Error('OC2 native transaction manifest is invalid');
    const entries = manifestValue.entries as TransactionEntry[];
    if (entries.map(entry => entry.key).join(',') !== transactionKeys.join(',') || entries.some(entry => typeof entry.oldExists !== 'boolean')) throw new Error('OC2 native transaction manifest is invalid');
    const records = await Promise.all(entries.map(async entry => {
        const oldSnapshot = entry.oldExists ? await snapshot(join(paths.transaction, `${entry.key}.old`)) : null;
        const nextSnapshot = await snapshot(join(paths.transaction, `${entry.key}.new`));
        if (entry.oldExists && !oldSnapshot!.exists || !nextSnapshot.exists) throw new Error('OC2 native transaction recovery files are incomplete');
        return { entry, target: targetFor(paths, entry.key), old: oldSnapshot?.bytes, next: nextSnapshot.bytes!, current: await snapshot(targetFor(paths, entry.key)) };
    }));
    for (const record of records) if (!bytesMatch(record.current, record.entry.oldExists, record.old) && !bytesMatch(record.current, true, record.next)) throw new Error(`OC2 native transaction recovery found a newer ${record.entry.key} edit; it was preserved and manual recovery is required`);
    if (records.every(record => bytesMatch(record.current, true, record.next))) { await rm(paths.transaction, { recursive: true }); return 'committed'; }
    for (const record of [...records].reverse()) {
        const current = await snapshot(record.target);
        if (!bytesMatch(current, record.entry.oldExists, record.old) && !bytesMatch(current, true, record.next)) throw new Error(`OC2 native transaction rollback found a newer ${record.entry.key} edit; it was preserved and manual recovery is required`);
        if (bytesMatch(current, record.entry.oldExists, record.old)) continue;
        if (record.entry.oldExists) await writeAtomic(record.target, record.old!, current);
        else {
            const beforeRemove = await snapshot(record.target);
            if (!same(current, beforeRemove)) throw new Error(`OC2 native transaction rollback found a newer ${record.entry.key} edit; it was preserved and manual recovery is required`);
            await rm(record.target);
        }
    }
    await rm(paths.transaction, { recursive: true });
    return 'rolled-back';
}
async function syncDirectory(path: string): Promise<void> {
    const handle = await open(path, 'r');
    try { await handle.sync(); } finally { await handle.close(); }
}
async function prepareTransaction(paths: Oc2NativePaths, originals: Record<TransactionEntry['key'], Snapshot>, values: Record<TransactionEntry['key'], Buffer>, adapters: NativeConfigAdapters): Promise<void> {
    const staging = join(dirname(paths.transaction), `${transactionStagingPrefix}${process.pid}-${randomBytes(8).toString('hex')}`);
    await mkdir(staging, { mode: 0o700 });
    const entries: TransactionEntry[] = transactionKeys.map(key => ({ key, oldExists: originals[key].exists }));
    let published = false, index = 0;
    try {
        for (const entry of entries) {
            if (entry.oldExists) {
                const path = join(staging, `${entry.key}.old`); await transactionFile(path, originals[entry.key].bytes!); await adapters.afterTransactionStageFile?.(++index, path);
            }
            const path = join(staging, `${entry.key}.new`); await transactionFile(path, values[entry.key]); await adapters.afterTransactionStageFile?.(++index, path);
        }
        const manifest = join(staging, 'manifest.json');
        await transactionFile(manifest, Buffer.from(JSON.stringify({ schemaVersion: 1, entries } satisfies TransactionManifest) + '\n')); await adapters.afterTransactionStageFile?.(++index, manifest);
        await syncDirectory(staging);
        await rename(staging, paths.transaction); published = true;
        await syncDirectory(dirname(paths.transaction));
    } catch (error) { if (!published) await rm(staging, { recursive: true, force: true }); throw error; }
}

export async function updateOc2NativeProfile(root: string, models?: readonly string[], adapters: NativeConfigAdapters = {}): Promise<Oc2NativeModelProfile> {
    if (!isAbsolute(root)) throw new Error('OC2 preview root must be absolute');
    const paths = oc2NativePaths(root); await ensureOc2NativeDirectories(paths);
    const release = await acquire(paths, adapters.processIdentity ?? nativeProcessIdentity, adapters);
    try {
        await adapters.afterLockAcquired?.();
        await cleanupTransactionStaging(paths);
        await recoverTransaction(paths);
        const profileSnapshot = await snapshot(paths.profileState), configSnapshot = await snapshot(paths.configFile), managedSnapshot = await snapshot(paths.ownership);
        if (adapters.expectedModels !== undefined) {
            const observed = profileSnapshot.exists ? readProfile(parseJson(profileSnapshot.bytes!, 'OC2 native model profile')).models : null;
            if (!isDeepStrictEqual(observed, adapters.expectedModels)) throw new Error('Global native worker models changed while configuring; rerun model selection before saving');
        }
        const home = adapters.home ?? process.env.HOME;
        if (!home) throw new Error('OC2 native setup requires HOME to validate explicit global instructions');
        let current: Oc2NativeModelProfile, instructions: GlobalInstructionsSnapshot | null;
        if (profileSnapshot.exists) {
            current = readProfile(parseJson(profileSnapshot.bytes!, 'OC2 native model profile'));
            instructions = await currentInstructions(current, home);
        } else {
            const imported = await importedProfile(root, home);
            instructions = imported.instructions;
            current = { schemaVersion: 2, models: imported.models, preferences: {}, instructions: metadata(instructions) };
        }
        const next: Oc2NativeModelProfile = { ...current, schemaVersion: 2, models: models === undefined ? current.models : validModels([...models], false), instructions: metadata(instructions) };
        const projection = projectOc2NativeAgents(next.models, instructions);
        const merged = await mergeProjection(configSnapshot, managedSnapshot, projection);
        mergeNativeAssets(merged.config, root);
        const values = {
            config: Buffer.from(JSON.stringify(merged.config, null, 2) + '\n'),
            ownership: Buffer.from(JSON.stringify(merged.managed, null, 2) + '\n'),
            profile: Buffer.from(JSON.stringify(next, null, 2) + '\n'),
        };
        if (configSnapshot.exists && configSnapshot.bytes!.equals(values.config) && managedSnapshot.exists && managedSnapshot.bytes!.equals(values.ownership) && profileSnapshot.exists && profileSnapshot.bytes!.equals(values.profile)) return next;
        await adapters.beforeConfigCommit?.();
        const originals = { config: configSnapshot, ownership: managedSnapshot, profile: profileSnapshot };
        for (const key of transactionKeys) if (!same(originals[key], await snapshot(targetFor(paths, key)))) throw new Error(`${basename(targetFor(paths, key))} changed concurrently; refusing to start the transaction`);
        await prepareTransaction(paths, originals, values, adapters);
        await adapters.afterTransactionPublished?.();
        try {
            for (const [index, key] of transactionKeys.entries()) {
                await writeAtomic(targetFor(paths, key), values[key], originals[key], adapters.rename ?? rename);
                await adapters.afterCommitFile?.(index + 1, targetFor(paths, key));
            }
            await rm(paths.transaction, { recursive: true });
        } catch (error) {
            let recovery: Awaited<ReturnType<typeof recoverTransaction>>;
            try { recovery = await recoverTransaction(paths); }
            catch (recoveryError) { throw new Error(`OC2 native profile update failed and automatic rollback preserved a newer edit; transaction recovery remains at ${paths.transaction}`, { cause: recoveryError }); }
            if (recovery === 'committed') return next;
            throw error;
        }
        return next;
    } finally { await release(); }
}
