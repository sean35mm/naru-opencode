import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { constants } from 'node:fs';
import { lstat, mkdir, open, opendir, readFile, realpath, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { isPlainObject, isSafeRelativePath, isSafeScope, scopeCoversPath, validateAllowedKeys } from './validate.mjs';
import { cleanProcessEnvironment, isolatedCheck, nodeSpawner } from './preview-process.mjs';
import { PREVIEW_VERSION, prepareHost, type PreviewHost } from './preview-host.mjs';
import { MAX_CATALOGUE_REFERENCE_LENGTH, parseCatalogueReference } from './native-reader-projection.mjs';
import { globalInstructionsMetadata, loadGlobalInstructions, prepareGlobalInstructions, validateGlobalInstructionsSetting, type GlobalInstructionsMetadata, type GlobalInstructionsSetting, type GlobalInstructionsSnapshot } from './global-instructions.mjs';
import { loadManagedModelSource, type PreviewModelSource } from './preview-model-catalogue.mjs';
import { createWorktreeRun, createWriterWorktree, recoverWorktreeRun, integrateWriterWorktree, finalizeWorktreeRun, type WorktreeRegistry } from './worktree.mjs';
import { assertDirectoryIdentity, atomicWorkspaceWrite, directoryIdentity, pathContains, protectedPathContains, type DirectoryIdentity } from './safe-write.mjs';

export type PreviewRole = 'reader' | 'runner' | 'writer';
export type PreviewAccess = 'inspect' | 'check' | 'write';
export interface GlobalWorkerPool { models: string[]; revision: number }
export type EnrollmentKind = 'git' | 'directory';
export interface Enrollment { path: string; kind?: EnrollmentKind; access: PreviewAccess; writeScopes: string[]; revision: number; rootIdentity?: DirectoryIdentity }
export interface PreviewTask {
    id: string; requestId: string; requestHash: string; repository: string; role: PreviewRole; model: string; prompt: string;
    state: 'preparing' | 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted' | 'integrating' | 'integration-unknown' | 'integrated';
    createdAt: string; updatedAt: string; directory: string; capabilityHash: string; summary: string;
    mode: 'direct' | 'worktree'; evidence: Array<{ operation: string; path?: string; hash?: string; ok?: boolean }>;
    authorization?: { digest: string; at: string };
}
interface State { schemaVersion: 6; globalWorkerPool: GlobalWorkerPool | null; globalInstructions: GlobalInstructionsSetting; repositories: Enrollment[]; tasks: PreviewTask[] }
interface ModelPolicySnapshot { models: string[]; globalWorkerPoolRevision: number; repositoryRevision: number }
export type PreviewCapability =
    | { kind: 'repo-reader'; repository: string }
    | ({ kind: 'orchestrator'; repository: string; globalInstructions: GlobalInstructionsSnapshot | null; globalInstructionsRevision: number; modelSource: PreviewModelSource | null } & ModelPolicySnapshot)
    | { kind: 'managed-worker'; repository: string; task: string };
export const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const activeStates = new Set(['running', 'preparing', 'integrating']);
const taskStates = new Set(['preparing', 'running', 'completed', 'failed', 'cancelled', 'interrupted', 'integrating', 'integration-unknown', 'integrated']);
function validModelReference(value: unknown): value is string {
    if (typeof value !== 'string') return false;
    try { parseCatalogueReference(value); return true; } catch { return false; }
}
function validModels(value: unknown): value is string[] {
    return Array.isArray(value) && value.length > 0 && value.length <= 32 && value.every(validModelReference) && new Set(value).size === value.length;
}
export function maximumPreviewAccess(platform: string = process.platform, arch: string = process.arch): PreviewAccess { return platform === 'darwin' && arch === 'arm64' ? 'write' : 'inspect'; }
const text = (value: unknown, name: string, max = 16000): string => {
    if (typeof value !== 'string' || !value.trim() || value.length > max || value.includes('\0')) throw new Error(`Invalid ${name}`);
    return value;
};
export async function writePrivateJson(path: string, value: unknown): Promise<void> {
    const temporary = `${path}.${randomUUID()}.tmp`;
    const handle = await open(temporary, 'wx', 0o600);
    try { await handle.writeFile(JSON.stringify(value, null, 2)); await handle.sync(); } finally { await handle.close(); }
    await rename(temporary, path);
}
export async function safeWorkspacePath(root: string, value: unknown, create = false): Promise<string> {
    if (!isSafeRelativePath(value) || value.includes('\\')) throw new Error('Unsafe or secret workspace path');
    const canonical = await realpath(root);
    let current = canonical;
    const parts = value.split('/');
    for (let index = 0; index < parts.length; index++) {
        current = join(current, parts[index]!);
        let info;
        try { info = await lstat(current); } catch (error) {
            if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
            if (!create) throw error;
            if (index < parts.length - 1) await mkdir(current, { mode: 0o700 });
            continue;
        }
        if (info.isSymbolicLink() || (index < parts.length - 1 ? !info.isDirectory() : !info.isFile())) throw new Error('Workspace paths must not traverse symlinks or special files');
    }
    return current;
}
function pathsOverlap(left: string, right: string): boolean { return pathContains(left, right) || pathContains(right, left); }
interface WorkspaceFilesystemPolicy { denied: boolean; excludedPaths: string[] }
const deniedFilesystemMessage = 'Filesystem access is disabled because this workspace is inside Naru runtime state';
async function readWorkspace(root: string, path: unknown) {
    const file = await safeWorkspacePath(root, path);
    const safePath = path as string;
    const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
        const info = await handle.stat();
        if (!info.isFile() || info.size > 256 * 1024) throw new Error('File exceeds the preview read limit');
        const content = await handle.readFile();
        if (content.length > 256 * 1024 || content.includes(0)) throw new Error('Only bounded text files can be read');
        let decoded: string;
        try { decoded = new TextDecoder('utf-8', { fatal: true }).decode(content); }
        catch { throw new Error('Only bounded UTF-8 text files can be read'); }
        return { path: safePath, content: decoded, sha256: digest(content) };
    } finally { await handle.close(); }
}
export class PreviewBroker {
    private state: State = { schemaVersion: 6, globalWorkerPool: null, globalInstructions: { revision: 0, source: null }, repositories: [], tasks: [] };
    private capabilities = new Map<string, PreviewCapability>();
    private children = new Map<string, ChildProcess>();
    private worktrees: WorktreeRegistry = new Map();
    private queue: Promise<unknown> = Promise.resolve();
    readonly git;
    constructor(readonly host: PreviewHost, private admin: string, private runtime: { platform?: string; arch?: string; home?: string } = {}) { this.git = nodeSpawner(cleanProcessEnvironment(host.node)); }
    private maximumAccess() { return maximumPreviewAccess(this.runtime.platform ?? process.platform, this.runtime.arch ?? process.arch); }
    private userHome() { return this.runtime.home ?? homedir(); }
    async load() {
        try {
            const value: unknown = JSON.parse(await readFile(join(this.host.root, 'state.json'), 'utf8'));
            if (!isPlainObject(value) || ![1, 2, 3, 4, 5, 6].includes(value.schemaVersion as number) || !Array.isArray(value.repositories) || !Array.isArray(value.tasks)) throw new Error('Invalid preview state');
            validateAllowedKeys(value, value.schemaVersion === 5 || value.schemaVersion === 6 ? ['schemaVersion', 'globalWorkerPool', 'globalInstructions', 'repositories', 'tasks'] : value.schemaVersion === 3 || value.schemaVersion === 4 ? ['schemaVersion', 'globalWorkerPool', 'repositories', 'tasks'] : ['schemaVersion', 'repositories', 'tasks']);
            const schemaVersion = value.schemaVersion as 1 | 2 | 3 | 4 | 5 | 6;
            const repositories = value.repositories.map((record, index) => this.validEnrollment(record, schemaVersion, index));
            const tasks = value.tasks.map((record, index) => this.validTask(record, index, schemaVersion));
            const globalWorkerPool = schemaVersion >= 3 ? this.validGlobalWorkerPool(value.globalWorkerPool) : null;
            const globalInstructions = schemaVersion >= 5 ? await validateGlobalInstructionsSetting(value.globalInstructions, this.userHome()) : { revision: 0, source: null };
            if (schemaVersion === 3 && !globalWorkerPool && value.repositories.some(record => isPlainObject(record) && isPlainObject(record.workerPool) && record.workerPool.source === 'global')) throw new Error('Invalid preview state: repository inherits an absent global worker pool');
            this.state = { schemaVersion: 6, globalWorkerPool, globalInstructions, repositories, tasks };
        } catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error; }
        for (const task of this.state.tasks) {
            if (task.state === 'running' || task.state === 'preparing') { task.state = 'interrupted'; if (task.mode === 'direct' && task.role === 'writer') task.summary = 'Worker was interrupted; direct edits may remain in the enrolled directory.'; }
            if (task.state === 'integrating') task.state = 'integration-unknown';
        }
        await this.save();
    }
    private save() { return writePrivateJson(join(this.host.root, 'state.json'), this.state); }
    private validGlobalWorkerPool(value: unknown): GlobalWorkerPool | null {
        if (value === null) return null;
        if (!isPlainObject(value)) throw new Error('Invalid global worker pool');
        validateAllowedKeys(value, ['models', 'revision']);
        if (!validModels(value.models) || !Number.isSafeInteger(value.revision) || (value.revision as number) < 1) throw new Error('Invalid global worker pool');
        return { models: [...value.models], revision: value.revision as number };
    }
    private validEnrollment(value: unknown, schemaVersion: 1 | 2 | 3 | 4 | 5 | 6, index: number): Enrollment {
        if (!isPlainObject(value)) throw new Error(`Invalid preview enrollment ${index}`);
        validateAllowedKeys(value, schemaVersion === 1 ? ['path', 'models', 'writeScopes'] : schemaVersion === 2 ? ['path', 'models', 'access', 'writeScopes', 'revision'] : schemaVersion === 3 ? ['path', 'workerPool', 'access', 'writeScopes', 'revision'] : schemaVersion === 6 ? ['path', 'kind', 'access', 'writeScopes', 'revision', 'rootIdentity'] : ['path', 'access', 'writeScopes', 'revision']);
        if (schemaVersion === 1 || schemaVersion === 2) {
            if (!validModels(value.models)) throw new Error(`Invalid preview enrollment ${index}`);
        } else if (schemaVersion === 3) {
            if (!isPlainObject(value.workerPool)) throw new Error(`Invalid preview enrollment ${index}`);
            if (value.workerPool.source === 'global') validateAllowedKeys(value.workerPool, ['source']);
            else if (value.workerPool.source === 'repository') {
                validateAllowedKeys(value.workerPool, ['source', 'models']);
                if (!validModels(value.workerPool.models)) throw new Error(`Invalid preview enrollment ${index}`);
            } else throw new Error(`Invalid preview enrollment ${index}`);
        }
        if (typeof value.path !== 'string' || !value.path.startsWith('/') || !Array.isArray(value.writeScopes) || value.writeScopes.length > 128 || !value.writeScopes.every(scope => isSafeScope(scope))) throw new Error(`Invalid preview enrollment ${index}`);
        const access = schemaVersion === 1 ? (value.writeScopes.length ? 'write' : 'check') : value.access;
        if (access !== 'inspect' && access !== 'check' && access !== 'write') throw new Error(`Invalid preview enrollment ${index}`);
        if (access !== 'write' && value.writeScopes.length) throw new Error(`Invalid preview enrollment ${index}`);
        if (schemaVersion !== 1 && access === 'write' && !value.writeScopes.length) throw new Error(`Invalid preview enrollment ${index}`);
        const revision = schemaVersion === 1 ? 1 : value.revision;
        if (!Number.isSafeInteger(revision) || (revision as number) < 1) throw new Error(`Invalid preview enrollment ${index}`);
        const kind = schemaVersion === 6 ? value.kind : 'git';
        if (kind !== 'git' && kind !== 'directory') throw new Error(`Invalid preview enrollment ${index}`);
        let rootIdentity: DirectoryIdentity | undefined;
        if (kind === 'directory') {
            if (!isPlainObject(value.rootIdentity) || typeof value.rootIdentity.dev !== 'string' || typeof value.rootIdentity.ino !== 'string' || !/^\d+$/.test(value.rootIdentity.dev) || !/^\d+$/.test(value.rootIdentity.ino)) throw new Error(`Invalid preview enrollment ${index}`);
            rootIdentity = { dev: value.rootIdentity.dev, ino: value.rootIdentity.ino };
        } else if (value.rootIdentity !== undefined) throw new Error(`Invalid preview enrollment ${index}`);
        return { path: value.path, kind, access, writeScopes: [...value.writeScopes] as string[], revision: revision as number, ...(rootIdentity ? { rootIdentity } : {}) };
    }
    private validTask(value: unknown, index: number, schemaVersion: 1 | 2 | 3 | 4 | 5 | 6): PreviewTask {
        if (!isPlainObject(value)) throw new Error(`Invalid preview task ${index}`);
        validateAllowedKeys(value, ['id', 'requestId', 'requestHash', 'repository', 'role', 'model', 'prompt', 'state', 'createdAt', 'updatedAt', 'directory', 'capabilityHash', 'summary', 'evidence', 'authorization', ...(schemaVersion === 6 ? ['mode'] : [])]);
        const role = value.role, state = value.state;
        if (![value.id, value.requestId, value.requestHash, value.repository, value.model, value.prompt, value.createdAt, value.updatedAt, value.directory, value.capabilityHash, value.summary].every(item => typeof item === 'string')
            || (role !== 'reader' && role !== 'runner' && role !== 'writer') || typeof state !== 'string' || !taskStates.has(state) || !Array.isArray(value.evidence)) throw new Error(`Invalid preview task ${index}`);
        for (const evidence of value.evidence) if (!isPlainObject(evidence) || typeof evidence.operation !== 'string' || (evidence.path !== undefined && typeof evidence.path !== 'string') || (evidence.hash !== undefined && typeof evidence.hash !== 'string') || (evidence.ok !== undefined && typeof evidence.ok !== 'boolean')) throw new Error(`Invalid preview task ${index}`);
        if (value.authorization !== undefined && (!isPlainObject(value.authorization) || typeof value.authorization.digest !== 'string' || typeof value.authorization.at !== 'string')) throw new Error(`Invalid preview task ${index}`);
        const mode = schemaVersion === 6 ? value.mode : role === 'writer' ? 'worktree' : 'direct';
        if (mode !== 'direct' && mode !== 'worktree') throw new Error(`Invalid preview task ${index}`);
        return { ...(value as unknown as PreviewTask), mode };
    }
    serial<T>(operation: () => Promise<T>): Promise<T> {
        const result = this.queue.then(operation); this.queue = result.catch(() => {}); return result;
    }
    private publicTask(task: PreviewTask) {
        const { capabilityHash, prompt, requestHash, ...publicValue } = task;
        return task.role === 'writer' && task.mode === 'direct'
            ? { ...publicValue, writeMode: 'direct', ...(task.state === 'completed' ? { changesAlreadyApplied: true } : {}), ...(['failed', 'cancelled', 'interrupted'].includes(task.state) ? { warning: 'Direct edits are not rolled back; partial edits may remain in the enrolled directory.' } : {}) }
            : publicValue;
    }
    private task(id: unknown) { const task = this.state.tasks.find(value => value.id === id); if (!task) throw new Error('Unknown task'); return task; }
    private enrollment(path: string) { const value = this.state.repositories.find(value => value.path === path); if (!value) throw new Error('Repository is not enrolled'); return value; }
    private effectiveWorkerPool(enrollment: Enrollment): ModelPolicySnapshot {
        if (!this.state.globalWorkerPool) throw new Error('Global worker models are not configured; run "oc2 naru configure" before opening this repository');
        return { models: [...this.state.globalWorkerPool.models], globalWorkerPoolRevision: this.state.globalWorkerPool.revision, repositoryRevision: enrollment.revision };
    }
    private async instructionsStatus(): Promise<GlobalInstructionsMetadata> { return globalInstructionsMetadata(this.state.globalInstructions, this.userHome()); }
    private async modelSourceStatus() {
        const source = await loadManagedModelSource(this.host.root);
        return source ? { management: 'naru-snapshot', digest: source.digest, bytes: source.bytes, requestedAt: source.requestedAt, completedAt: source.completedAt, outcome: source.outcome, upstreamFreshness: 'unknown', accountAccess: 'unknown' }
            : { management: 'host-managed-unverified', detail: 'Host-managed source; freshness and generation are unverified. Naru does not switch this session to a new managed source automatically.', upstreamFreshness: 'unknown', accountAccess: 'unknown' };
    }
    private async gitText(directory: string, argv: string[]) {
        const result = await this.git(['git', '--no-pager', ...argv], { cwd: directory, maxBytes: 2 * 1024 * 1024 });
        if (!result.ok) throw new Error(result.stderr || 'Git operation failed');
        return result.stdout;
    }
    private async workspace(path: string): Promise<{ path: string; kind: EnrollmentKind; dirty: boolean | null; rootIdentity?: DirectoryIdentity }> {
        const requested = await realpath(path), info = await lstat(requested);
        if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Selected path must be an existing directory');
        const discovered = await this.git(['git', '--no-pager', 'rev-parse', '--show-toplevel'], { cwd: requested, maxBytes: 2 * 1024 * 1024 });
        if (discovered.ok) {
            const repository = await realpath(discovered.stdout.trim());
            return { path: repository, kind: 'git', dirty: (await this.gitText(repository, ['status', '--porcelain=v1', '--untracked-files=normal'])).length > 0 };
        }
        return { path: requested, kind: 'directory', dirty: null, rootIdentity: await directoryIdentity(requested) };
    }
    private async assertEnrollmentRoot(enrollment: Enrollment): Promise<void> {
        if (enrollment.kind === 'directory') await assertDirectoryIdentity(enrollment.path, enrollment.rootIdentity!);
    }
    private async filesystemPolicy(enrollment: Enrollment): Promise<WorkspaceFilesystemPolicy> {
        const workspace = await realpath(enrollment.path), runtime = await realpath(this.host.root);
        if (pathContains(runtime, workspace)) return { denied: true, excludedPaths: [] };
        if (pathContains(workspace, runtime)) return { denied: false, excludedPaths: [relative(workspace, runtime)] };
        return { denied: false, excludedPaths: [] };
    }
    async request(token: string, operation: string, input: unknown): Promise<unknown> {
        if (!isPlainObject(input)) throw new Error('input must be an object');
        if (token === this.admin) return this.adminRequest(operation, input);
        const capability = this.capabilities.get(digest(token));
        if (!capability) throw new Error('Capability is absent, expired, or revoked');
        if (operation === '__describe') {
            validateAllowedKeys(input, []);
            if (capability.kind === 'managed-worker') {
                const task = this.task(capability.task), enrollment = this.enrollment(task.repository);
                return { kind: capability.kind, role: task.role, access: enrollment.access };
            }
            return { kind: capability.kind };
        }
        if (capability.kind === 'managed-worker') {
            const task = this.task(capability.task);
            if (task.state !== 'running') throw new Error('Attempt is no longer running');
            if (task.repository !== capability.repository) throw new Error('Managed worker capability does not match its persisted task');
            return this.workerRequest(task, operation, input);
        }
        const enrolled = this.enrollment(capability.repository);
        if (capability.kind === 'repo-reader') {
            if (operation === 'files' || operation === 'read') { await this.assertEnrollmentRoot(enrolled); return this.inspect(enrolled.path, operation, input, await this.filesystemPolicy(enrolled)); }
            throw new Error('Operation is not available to a repository reader');
        }
        if (operation === 'status') {
            validateAllowedKeys(input, ['id']);
            const globalInstructions = capability.globalInstructions;
            return { repository: enrolled, workerModelProfile: { models: [...capability.models], globalWorkerPoolRevision: capability.globalWorkerPoolRevision, repositoryRevision: capability.repositoryRevision }, modelSource: capability.modelSource ? { management: 'naru-snapshot', digest: capability.modelSource.digest, bytes: capability.modelSource.bytes, completedAt: capability.modelSource.completedAt, upstreamFreshness: 'unknown', accountAccess: 'unknown' } : { management: 'host-managed-unverified', detail: 'Host-managed source; freshness and generation are unverified. Naru does not switch this session to a new managed source automatically.', upstreamFreshness: 'unknown', accountAccess: 'unknown' }, globalInstructions: globalInstructions ? { revision: capability.globalInstructionsRevision, sourcePath: globalInstructions.sourcePath, canonicalPath: globalInstructions.canonicalPath, sha256: globalInstructions.sha256, byteLength: globalInstructions.byteLength, loadStatus: 'loaded' } : { revision: capability.globalInstructionsRevision, sourcePath: null, loadStatus: 'disabled' }, nativeReaders: { lifecycle: 'host-native', tracking: 'OpenCode child sessions and host UI' }, managedWorkers: this.state.tasks.filter(value => value.repository === enrolled.path && (!input.id || input.id === value.id)).map(value => this.publicTask(value)) };
        }
        if (operation === 'start') return this.start(enrolled, capability, input);
        if (operation === 'cancel') {
            validateAllowedKeys(input, ['id']);
            const target = this.task(input.id);
            if (target.repository !== enrolled.path) throw new Error('Task is outside this capability');
            return this.cancel(target);
        }
        throw new Error('Operation is not available to the orchestrator');
    }
    private async adminRequest(operation: string, input: Record<string, unknown>): Promise<unknown> {
        if (operation === 'stop') { this.shutdown(); return { stopped: true }; }
        if (operation === 'global-status') { validateAllowedKeys(input, []); return this.state.globalWorkerPool ? { ...this.state.globalWorkerPool, models: [...this.state.globalWorkerPool.models] } : null; }
        if (operation === 'prepare-global-instructions') {
            validateAllowedKeys(input, ['sourcePath']);
            const { text: _text, ...metadata } = await prepareGlobalInstructions(text(input.sourcePath, 'global instructions source path', 4096), this.userHome());
            return metadata;
        }
        if (operation === 'configure-global-instructions') {
            validateAllowedKeys(input, ['sourcePath', 'canonicalPath', 'sha256', 'byteLength', 'expectedRevision']);
            const expected = input.expectedRevision;
            if (!Number.isSafeInteger(expected) || (expected as number) < 0 || expected !== this.state.globalInstructions.revision) throw new Error('Global instructions changed since setup status; reload, review, and confirm again');
            const prepared = await prepareGlobalInstructions(text(input.sourcePath, 'global instructions source path', 4096), this.userHome());
            if (input.canonicalPath !== prepared.canonicalPath || input.sha256 !== prepared.sha256 || input.byteLength !== prepared.byteLength) throw new Error('Global instructions source changed after preview; reload and confirm the current canonical target and metadata');
            this.state.globalInstructions = { revision: this.state.globalInstructions.revision + 1, source: { sourcePath: prepared.sourcePath, canonicalPath: prepared.canonicalPath } };
            await this.save(); return this.instructionsStatus();
        }
        if (operation === 'disable-global-instructions') {
            validateAllowedKeys(input, ['expectedRevision']);
            const expected = input.expectedRevision;
            if (!Number.isSafeInteger(expected) || (expected as number) < 0 || expected !== this.state.globalInstructions.revision) throw new Error('Global instructions changed since setup status; reload, review, and confirm again');
            this.state.globalInstructions = { revision: this.state.globalInstructions.revision + 1, source: null };
            await this.save(); return this.instructionsStatus();
        }
        if (operation === 'configure-global') {
            validateAllowedKeys(input, ['models', 'expectedRevision']);
            if (!validModels(input.models)) throw new Error('Global worker models require 1 to 32 unique exact provider/model references');
            const previous = this.state.globalWorkerPool, expected = input.expectedRevision;
            if ((expected !== null && !Number.isSafeInteger(expected)) || expected !== (previous?.revision ?? null)) throw new Error('Global worker models changed since setup status; reload, review, and confirm again');
            const globalWorkerPool = { models: [...input.models], revision: (previous?.revision ?? 0) + 1 };
            this.state.globalWorkerPool = globalWorkerPool; await this.save(); return globalWorkerPool;
        }
        if (operation === 'enroll') {
            validateAllowedKeys(input, ['path', 'kind', 'access', 'writeScopes', 'expectedRevision', 'expectedGlobalRevision']);
            const selected = await this.workspace(text(input.path, 'workspace'));
            const path = selected.path;
            if (input.kind !== undefined && input.kind !== selected.kind) throw new Error('Workspace kind changed since setup status; reload and review the selected path');
            if (!this.state.globalWorkerPool) throw new Error('Global worker models are not configured; run "oc2 naru configure" first');
            if (input.expectedGlobalRevision !== this.state.globalWorkerPool.revision) throw new Error('Global worker models changed since setup status; reload, review, and confirm again');
            if (!Array.isArray(input.writeScopes) || input.writeScopes.length > 128 || !input.writeScopes.every(scope => isSafeScope(scope))) throw new Error('Invalid write scopes');
            if (input.access !== 'inspect' && input.access !== 'check' && input.access !== 'write') throw new Error('Invalid workspace access');
            if (input.access !== 'write' && input.writeScopes.length) throw new Error('Write scopes require write access');
            if (input.access === 'write' && !input.writeScopes.length) throw new Error('Write access requires at least one write scope');
            if (input.access !== 'inspect' && this.maximumAccess() === 'inspect') throw new Error('Runner and writer containment is not certified on this platform and architecture');
            const previous = this.state.repositories.find(value => value.path === path);
            const expected = input.expectedRevision;
            if ((expected !== null && !Number.isSafeInteger(expected)) || expected !== (previous?.revision ?? null)) throw new Error('Enrollment changed since setup status; review and confirm the current policy');
            if (this.state.tasks.some(task => task.repository === path && activeStates.has(task.state))) throw new Error('Cancel active work before changing enrollment');
            if (input.access === 'write' && selected.kind === 'git' && selected.dirty) throw new Error('Write access requires a clean repository; no policy change was saved');
            const enrollment: Enrollment = { path, kind: selected.kind, access: input.access, writeScopes: [...input.writeScopes] as string[], revision: (previous?.revision ?? 0) + 1, ...(selected.rootIdentity ? { rootIdentity: selected.rootIdentity } : {}) };
            this.state.repositories = this.state.repositories.filter(value => value.path !== path); this.state.repositories.push(enrollment);
            await this.save(); return enrollment;
        }
        if (operation === 'setup-status') {
            validateAllowedKeys(input, ['path']);
            let requested: string;
            try { requested = await realpath(text(input.path, 'repository path')); }
            catch { const maximumAccess = this.maximumAccess(); return { installation: { version: PREVIEW_VERSION, isolated: true, hostCapabilities: { inspect: true, check: maximumAccess !== 'inspect', write: maximumAccess === 'write' } }, globalProfile: this.state.globalWorkerPool ? { ...this.state.globalWorkerPool, models: [...this.state.globalWorkerPool.models] } : null, globalInstructions: await this.instructionsStatus(), modelSource: await this.modelSourceStatus(), repository: null, blockers: ['The selected path does not exist or cannot be resolved'], maximumAccess }; }
            let workspace: Awaited<ReturnType<PreviewBroker['workspace']>> | null = null, enrollment: Enrollment | null = null;
            try {
                workspace = await this.workspace(requested);
                enrollment = this.state.repositories.find(value => value.path === workspace!.path) ?? null;
            } catch (error) {
                const maximumAccess = this.maximumAccess();
                return { installation: { version: PREVIEW_VERSION, isolated: true, hostCapabilities: { inspect: true, check: maximumAccess !== 'inspect', write: maximumAccess === 'write' } }, globalProfile: this.state.globalWorkerPool ? { ...this.state.globalWorkerPool, models: [...this.state.globalWorkerPool.models] } : null, globalInstructions: await this.instructionsStatus(), modelSource: await this.modelSourceStatus(), repository: null, blockers: [error instanceof Error ? error.message : 'The selected path is not an accessible directory'], maximumAccess };
            }
            const maximumAccess = this.maximumAccess();
            const effective = enrollment ? (() => { try { const value = this.effectiveWorkerPool(enrollment); return { models: value.models, revision: value.globalWorkerPoolRevision }; } catch { return null; } })() : null;
            return { installation: { version: PREVIEW_VERSION, isolated: true, hostCapabilities: { inspect: true, check: maximumAccess !== 'inspect', write: maximumAccess === 'write' } }, globalProfile: this.state.globalWorkerPool ? { ...this.state.globalWorkerPool, models: [...this.state.globalWorkerPool.models] } : null, globalInstructions: await this.instructionsStatus(), modelSource: await this.modelSourceStatus(), repository: { path: workspace.path, kind: workspace.kind, dirty: workspace.dirty, enrollment, effectiveWorkerPool: effective }, blockers: [], maximumAccess };
        }
        if (operation === 'open') {
            validateAllowedKeys(input, ['path']);
            const selected = await this.workspace(text(input.path, 'workspace')), repository = selected.path, enrollment = this.enrollment(repository), snapshot = this.effectiveWorkerPool(enrollment);
            if (selected.kind !== enrollment.kind) throw new Error('Enrolled workspace kind changed; review and enroll it again');
            await this.assertEnrollmentRoot(enrollment);
            const instructionsRevision = this.state.globalInstructions.revision;
            const instructions = this.state.globalInstructions.source ? await loadGlobalInstructions(this.state.globalInstructions.source, this.userHome()) : null;
            const modelSource = await loadManagedModelSource(this.host.root);
            const control = randomBytes(32).toString('hex'), repo = randomBytes(32).toString('hex');
            this.capabilities.set(digest(control), { kind: 'orchestrator', repository, ...snapshot, globalInstructions: instructions, globalInstructionsRevision: instructionsRevision, modelSource });
            this.capabilities.set(digest(repo), { kind: 'repo-reader', repository });
            const persistentProfile = 'orchestrator-' + digest(repository).slice(0, 12);
            return prepareHost(this.host, `${persistentProfile}-${randomUUID()}`, { kind: 'orchestrator', control, repo, models: snapshot.models, globalInstructions: instructions, modelSource }, persistentProfile);
        }
        if (operation === 'status') return { nativeReaders: { lifecycle: 'host-native', tracking: 'OpenCode child sessions and host UI' }, managedWorkers: this.state.tasks.map(value => this.publicTask(value)) };
        if (operation === 'cancel') return this.cancel(this.task(input.id));
        if (operation === 'bundle') return this.bundle(this.task(input.id));
        if (operation === 'integrate') {
            const task = this.task(input.id);
            if (task.mode === 'direct') { validateAllowedKeys(input, ['id']); return this.integrate(task, ''); }
            validateAllowedKeys(input, ['id', 'digest']); return this.integrate(task, text(input.digest, 'bundle digest', 64));
        }
        throw new Error('Unknown administrative operation');
    }
    private async start(enrolled: Enrollment, snapshot: Extract<PreviewCapability, { kind: 'orchestrator' }>, input: Record<string, unknown>) {
        validateAllowedKeys(input, ['requestId', 'role', 'model', 'prompt']);
        const role = input.role;
        if (role !== 'runner' && role !== 'writer') throw new Error('Managed task role must be runner or writer; readers use OpenCode native subagents');
        if (role === 'runner' && enrolled.access === 'inspect') throw new Error('Repository access allows inspect workers only');
        if (role === 'writer' && enrolled.access !== 'write') throw new Error('Repository access does not allow writers');
        if (this.maximumAccess() === 'inspect') throw new Error('Runner and writer containment is not certified on this platform and architecture');
        const model = text(input.model, 'model', MAX_CATALOGUE_REFERENCE_LENGTH), prompt = text(input.prompt, 'prompt'), requestId = text(input.requestId, 'requestId', 128);
        if (!snapshot.models.includes(model)) throw new Error('Selected model is not in this session’s frozen worker pool; reopen Naru to apply model changes and no fallback is performed');
        if (role === 'writer' && !enrolled.writeScopes.length) throw new Error('Workspace enrollment has no write scopes');
        await this.assertEnrollmentRoot(enrolled);
        const requestHash = digest(JSON.stringify({ role, model, prompt }));
        const duplicate = this.state.tasks.find(task => task.repository === enrolled.path && task.requestId === requestId);
        if (duplicate) { if (duplicate.requestHash !== requestHash) throw new Error('requestId was already used for different work'); return this.publicTask(duplicate); }
        if (role === 'writer' && enrolled.kind === 'directory' && this.state.tasks.some(task => task.role === 'writer' && task.mode === 'direct' && activeStates.has(task.state) && pathsOverlap(task.repository, enrolled.path))) throw new Error('An overlapping direct writer is already active; direct directory writers are serialized');
        if (this.children.size >= 2) throw new Error('Preview concurrency limit is two attempts; no work was queued');
        if (this.state.tasks.length >= 200) throw new Error('This preview root has reached its 200-task limit; use a fresh root until retention is implemented');
        const id = randomUUID(), capability = randomBytes(32).toString('hex'), at = new Date().toISOString();
        const mode = role === 'writer' && enrolled.kind === 'git' ? 'worktree' : 'direct';
        const task: PreviewTask = { id, requestId, requestHash, repository: enrolled.path, role, model, prompt, state: 'preparing', createdAt: at, updatedAt: at, directory: enrolled.path, capabilityHash: digest(capability), summary: '', mode, evidence: [] };
        this.state.tasks.push(task); await this.save();
        try {
            if (role === 'writer' && mode === 'worktree') {
                await createWorktreeRun({ directory: enrolled.path, runId: id, maxWriters: 1, worktreeRoot: join(this.host.root, 'worktrees'), spawn: this.git, stateRegistry: this.worktrees });
                task.directory = (await createWriterWorktree({ runId: id, itemId: 'writer', ownedWriteScope: enrolled.writeScopes, spawn: this.git, stateRegistry: this.worktrees })).path;
            }
            const profile = await prepareHost(this.host, id, { kind: 'managed-worker', token: capability, role, workspaceMode: mode, globalInstructions: snapshot.globalInstructions, modelSource: snapshot.modelSource });
            const specification = join(this.host.root, 'hosts', id, 'attempt.json');
            await writePrivateJson(specification, { executable: this.host.executable, cwd: profile.cwd, env: profile.env, argv: ['run', '--standalone', '--agent', 'naru', '--model', model, '--format', 'json', prompt] });
            task.state = 'running'; this.capabilities.set(task.capabilityHash, { kind: 'managed-worker', repository: enrolled.path, task: id }); await this.save();
            const child = spawn(this.host.node, [this.host.cli, 'execute', specification], { env: cleanProcessEnvironment(this.host.node), detached: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
            this.children.set(id, child);
            let output = '', bytes = 0;
            const receive = (chunk: Buffer) => { bytes += chunk.length; if (bytes <= 512 * 1024) output += chunk.toString(); else child.kill('SIGTERM'); };
            child.stdout!.on('data', receive); child.stderr!.on('data', () => {});
            child.on('error', () => {});
            child.once('close', code => { void this.serial(async () => {
                this.children.delete(id); this.capabilities.delete(task.capabilityHash);
                if (task.state === 'running') {
                    let summary = '';
                    for (const line of output.split('\n')) {
                        try { const event = JSON.parse(line); if (event.type === 'text' && typeof event.part?.text === 'string') summary = event.part.text.slice(0, 16000); } catch { /* Non-result events are not evidence. */ }
                    }
                    task.state = code === 0 && bytes <= 512 * 1024 && summary ? 'completed' : 'failed';
                    task.summary = summary || `The selected host/model did not return a completed text result. Check provider login and the exact model; no retry or fallback was started.${task.role === 'writer' && task.mode === 'direct' ? ' Direct edits may remain in the enrolled directory.' : ''}`;
                    task.updatedAt = new Date().toISOString(); await this.save();
                }
            }); });
        } catch (error) { task.state = 'failed'; task.summary = `${error instanceof Error ? error.message : 'Attempt setup failed'}${task.role === 'writer' && task.mode === 'direct' ? ' Direct edits may remain in the enrolled directory.' : ''}`; await this.save(); }
        return this.publicTask(task);
    }
    private async cancel(task: PreviewTask) {
        if (task.state !== 'running') throw new Error('Only running tasks may be cancelled');
        task.state = 'cancelled'; task.updatedAt = new Date().toISOString(); if (task.role === 'writer' && task.mode === 'direct') task.summary = 'Direct writer cancelled; partial edits may remain in the enrolled directory.'; this.capabilities.delete(task.capabilityHash);
        this.children.get(task.id)?.disconnect(); await this.save(); return this.publicTask(task);
    }
    private async inspect(directory: string, operation: string, input: Record<string, unknown>, policy: WorkspaceFilesystemPolicy): Promise<unknown> {
        if (policy.denied) {
            if (operation === 'files') { validateAllowedKeys(input, ['contains']); return { files: [], truncated: false }; }
            throw new Error(deniedFilesystemMessage);
        }
        if (operation === 'read') {
            validateAllowedKeys(input, ['path']);
            const path = text(input.path, 'path', 1024);
            if (policy.excludedPaths.some(excluded => protectedPathContains(excluded, path))) throw new Error('Path is protected Naru runtime state');
            return readWorkspace(directory, path);
        }
        validateAllowedKeys(input, ['contains']);
        const needle = input.contains === undefined ? '' : text(input.contains, 'contains', 256);
        const files: string[] = []; let visitedEntries = 0, visitedDirectories = 0, truncated = false;
        const visit = async (folder: string) => {
            if (visitedDirectories >= 1000) { truncated = true; return; }
            visitedDirectories++;
            let entries;
            try { entries = await opendir(join(directory, folder)); }
            catch (error) {
                if (error instanceof Error && 'code' in error && (error.code === 'EACCES' || error.code === 'EPERM')) return;
                throw error;
            }
            try {
                for await (const entry of entries) {
                    if (files.length >= 2000 || visitedEntries >= 10000) { truncated = true; return; }
                    visitedEntries++;
                    const path = folder ? `${folder}/${entry.name}` : entry.name;
                    if (!isSafeRelativePath(path) || entry.isSymbolicLink()) continue;
                    if (policy.excludedPaths.some(excluded => protectedPathContains(excluded, path))) continue;
                    if (entry.isDirectory()) await visit(path);
                    else if (entry.isFile() && path.includes(needle)) files.push(path);
                }
            } catch (error) {
                if (!(error instanceof Error && 'code' in error && (error.code === 'EACCES' || error.code === 'EPERM'))) throw error;
            }
        };
        await visit(''); return { files, truncated };
    }
    private async workerRequest(task: PreviewTask, operation: string, input: Record<string, unknown>): Promise<unknown> {
        const enrollment = this.enrollment(task.repository);
        await this.assertEnrollmentRoot(enrollment);
        const policy = await this.filesystemPolicy(enrollment);
        if (operation === 'files' || operation === 'read') return this.inspect(task.directory, operation, input, policy);
        if (operation === 'write') {
            validateAllowedKeys(input, ['path', 'content', 'expectedHash']);
            if (task.role !== 'writer') throw new Error('Only writer capabilities may change files');
            if (enrollment.access !== 'write') throw new Error('Repository access does not allow writes');
            if (this.maximumAccess() === 'inspect') throw new Error('Writer containment is not certified on this platform and architecture');
            const path = text(input.path, 'path', 1024);
            if (policy.denied) throw new Error(deniedFilesystemMessage);
            if (policy.excludedPaths.some(excluded => protectedPathContains(excluded, path))) throw new Error('Path is protected Naru runtime state');
            if (!enrollment.writeScopes.some(scope => scopeCoversPath(scope, path))) throw new Error('Path is outside enrollment write scope');
            if (typeof input.content !== 'string' || Buffer.byteLength(input.content) > 128 * 1024 || input.content.includes('\0')) throw new Error('Write requires bounded text content');
            if (input.expectedHash !== null && (typeof input.expectedHash !== 'string' || !/^[a-f0-9]{64}$/.test(input.expectedHash))) throw new Error('expectedHash must be a sha256 or null');
            const rootIdentity = task.mode === 'direct' && enrollment.kind === 'directory' ? enrollment.rootIdentity! : await directoryIdentity(task.directory);
            const result = await atomicWorkspaceWrite(task.directory, rootIdentity, path, input.content, input.expectedHash as string | null);
            task.evidence.push({ operation, path, hash: result.sha256 }); await this.save(); return { path, sha256: result.sha256 };
        }
        if (operation === 'check') {
            validateAllowedKeys(input, ['argv']);
            if (task.role === 'reader') throw new Error('Reader capabilities cannot execute repository code');
            if (enrollment.access === 'inspect') throw new Error('Repository access does not allow checks');
            if (this.maximumAccess() === 'inspect') throw new Error('Runner containment is not certified on this platform and architecture');
            if (!Array.isArray(input.argv) || input.argv.some(arg => typeof arg !== 'string')) throw new Error('Invalid argv');
            if (policy.denied) throw new Error(deniedFilesystemMessage);
            const result = await isolatedCheck(task.directory, input.argv as string[], this.host.node, join(this.host.root, 'checks'), policy.excludedPaths);
            task.evidence.push({ operation, ok: result.ok }); await this.save(); return result;
        }
        if (operation === 'status') return this.publicTask(task);
        throw new Error('Operation is not available to a leaf worker');
    }
    private async bundle(task: PreviewTask) {
        if (task.role !== 'writer' || task.state !== 'completed') throw new Error('Only completed writer attempts can be integrated');
        if (task.mode === 'direct') return { task: task.id, mode: 'direct', applied: true, message: 'Not applicable: direct directory writes were already applied. File writes are atomic per file, not a multi-file transaction, and are not rolled back.' };
        const enrollment = this.enrollment(task.repository), policy = await this.filesystemPolicy(enrollment);
        if (policy.denied) throw new Error(deniedFilesystemMessage);
        const protectedPath = (path: string) => policy.excludedPaths.some(excluded => protectedPathContains(excluded, path));
        const tracked = (await this.gitText(task.directory, ['diff', '--name-only', '-z', 'HEAD', '--', '.'])).split('\0').filter(Boolean).filter(path => !protectedPath(path)).sort();
        const untracked = (await this.gitText(task.directory, ['ls-files', '--others', '--exclude-standard', '-z', '--', '.'])).split('\0').filter(Boolean).filter(path => !protectedPath(path)).sort();
        const patch = tracked.length ? await this.gitText(task.directory, ['diff', '--binary', '--full-index', '--no-ext-diff', 'HEAD', '--', ...tracked.map(path => `:(literal)${path}`)]) : '';
        const files = [];
        for (const path of untracked) files.push(await readWorkspace(task.directory, path));
        const head = (await this.gitText(task.repository, ['rev-parse', 'HEAD'])).trim();
        const changedPaths = [...new Set([...tracked, ...untracked])].sort();
        const data = { task: task.id, repository: task.repository, head, patch, changedPaths, files };
        return { ...data, digest: digest(JSON.stringify(data)) };
    }
    private async integrate(task: PreviewTask, expected: string) {
        if (task.role !== 'writer') throw new Error('Only writer attempts have changes');
        if (task.mode === 'direct') return { task: task.id, mode: 'direct', applied: true, message: 'Not applicable: direct directory writes were already applied; there is no bundle or integration step.' };
        const bundle = await this.bundle(task);
        if (!('digest' in bundle)) throw new Error('Writer bundle is not available for integration');
        if (bundle.digest !== expected) throw new Error('Bundle changed; terminal confirmation must be repeated');
        task.authorization = { digest: expected, at: new Date().toISOString() }; task.state = 'integrating'; await this.save();
        try {
            if (!this.worktrees.has(task.id)) await recoverWorktreeRun({ runId: task.id, directory: task.repository, worktreeRoot: join(this.host.root, 'worktrees'), spawn: this.git, stateRegistry: this.worktrees });
            const approved = {
                patch: bundle.patch,
                changedPaths: bundle.changedPaths,
                files: bundle.files.map(file => ({ path: file.path, content: file.content })),
            };
            await integrateWriterWorktree({ runId: task.id, itemId: 'writer', approved, spawn: this.git, stateRegistry: this.worktrees });
            const result = await finalizeWorktreeRun({ runId: task.id, approved, spawn: this.git, stateRegistry: this.worktrees });
            task.state = 'integrated'; await this.save(); return result;
        } catch (error) { task.state = 'integration-unknown'; await this.save(); throw error; }
    }
    shutdown() { for (const child of this.children.values()) { if (child.connected) child.disconnect(); } }
}
