import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readFile, readdir, realpath, rename, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { isPlainObject, isSafeRelativePath, isSafeScope, scopeCoversPath, validateAllowedKeys } from './validate.mjs';
import { cleanProcessEnvironment, isolatedCheck, nodeSpawner } from './preview-process.mjs';
import { prepareHost, type PreviewHost } from './preview-host.mjs';
import { createWorktreeRun, createWriterWorktree, recoverWorktreeRun, integrateWriterWorktree, finalizeWorktreeRun, type WorktreeRegistry } from './worktree.mjs';

export type PreviewRole = 'reader' | 'runner' | 'writer';
interface Enrollment { path: string; models: string[]; writeScopes: string[] }
export interface PreviewTask {
    id: string; requestId: string; requestHash: string; repository: string; role: PreviewRole; model: string; prompt: string;
    state: 'preparing' | 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted' | 'integrating' | 'integration-unknown' | 'integrated';
    createdAt: string; updatedAt: string; directory: string; capabilityHash: string; summary: string;
    evidence: Array<{ operation: string; path?: string; hash?: string; ok?: boolean }>;
    authorization?: { digest: string; at: string };
}
interface State { schemaVersion: 1; repositories: Enrollment[]; tasks: PreviewTask[] }
interface Capability { repository: string; task?: string }
export const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
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
    private state: State = { schemaVersion: 1, repositories: [], tasks: [] };
    private capabilities = new Map<string, Capability>();
    private children = new Map<string, ChildProcess>();
    private worktrees: WorktreeRegistry = new Map();
    private queue: Promise<unknown> = Promise.resolve();
    readonly git;
    constructor(readonly host: PreviewHost, private admin: string) { this.git = nodeSpawner(cleanProcessEnvironment(host.node)); }
    async load() {
        try {
            const value: unknown = JSON.parse(await readFile(join(this.host.root, 'state.json'), 'utf8'));
            if (!isPlainObject(value) || value.schemaVersion !== 1 || !Array.isArray(value.repositories) || !Array.isArray(value.tasks)) throw new Error('Invalid preview state');
            this.state = value as unknown as State;
        } catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error; }
        for (const task of this.state.tasks) {
            if (task.state === 'running' || task.state === 'preparing') task.state = 'interrupted';
            if (task.state === 'integrating') task.state = 'integration-unknown';
        }
        await this.save();
    }
    private save() { return writePrivateJson(join(this.host.root, 'state.json'), this.state); }
    serial<T>(operation: () => Promise<T>): Promise<T> {
        const result = this.queue.then(operation); this.queue = result.catch(() => {}); return result;
    }
    private publicTask(task: PreviewTask) { const { capabilityHash, prompt, requestHash, ...publicValue } = task; return publicValue; }
    private task(id: unknown) { const task = this.state.tasks.find(value => value.id === id); if (!task) throw new Error('Unknown task'); return task; }
    private enrollment(path: string) { const value = this.state.repositories.find(value => value.path === path); if (!value) throw new Error('Repository is not enrolled'); return value; }
    private async gitText(directory: string, argv: string[]) {
        const result = await this.git(['git', '--no-pager', ...argv], { cwd: directory, maxBytes: 2 * 1024 * 1024 });
        if (!result.ok) throw new Error(result.stderr || 'Git operation failed');
        return result.stdout;
    }
    async request(token: string, operation: string, input: unknown): Promise<unknown> {
        if (!isPlainObject(input)) throw new Error('input must be an object');
        if (token === this.admin) return this.adminRequest(operation, input);
        const capability = this.capabilities.get(digest(token));
        if (!capability) throw new Error('Capability is absent, expired, or revoked');
        const task = capability.task ? this.task(capability.task) : undefined;
        if (task && task.state !== 'running') throw new Error('Attempt is no longer running');
        if (task) return this.workerRequest(task, operation, input);
        const enrolled = this.enrollment(capability.repository);
        if (operation === 'status') {
            validateAllowedKeys(input, ['id']);
            return { repository: enrolled, tasks: this.state.tasks.filter(value => value.repository === enrolled.path && (!input.id || input.id === value.id)).map(value => this.publicTask(value)) };
        }
        if (operation === 'start') return this.start(enrolled, input);
        if (operation === 'cancel') {
            validateAllowedKeys(input, ['id']);
            const target = this.task(input.id);
            if (target.repository !== enrolled.path) throw new Error('Task is outside this capability');
            return this.cancel(target);
        }
        if (operation === 'files' || operation === 'read') return this.inspect(enrolled.path, operation, input);
        throw new Error('Operation is not available to the orchestrator');
    }
    private async adminRequest(operation: string, input: Record<string, unknown>): Promise<unknown> {
        if (operation === 'stop') { this.shutdown(); return { stopped: true }; }
        if (operation === 'enroll') {
            validateAllowedKeys(input, ['path', 'models', 'writeScopes']);
            const path = await realpath(text(input.path, 'repository'));
            const repository = (await this.gitText(path, ['rev-parse', '--show-toplevel'])).trim();
            if (await realpath(repository) !== path) throw new Error('Enroll the repository root');
            if (!Array.isArray(input.models) || input.models.length === 0 || input.models.length > 32 || !input.models.every(model => typeof model === 'string' && /^[a-zA-Z0-9._-]+\/[a-zA-Z0-9._:/-]+(?:#[a-zA-Z0-9._-]+)?$/.test(model))) throw new Error('Explicit provider/model allowlist is required');
            if (!Array.isArray(input.writeScopes) || input.writeScopes.length > 128 || !input.writeScopes.every(scope => isSafeScope(scope))) throw new Error('Invalid write scopes');
            if (this.state.tasks.some(task => task.repository === path && ['running', 'preparing', 'integrating'].includes(task.state))) throw new Error('Cancel active work before changing enrollment');
            const enrollment = { path, models: input.models as string[], writeScopes: input.writeScopes as string[] };
            this.state.repositories = this.state.repositories.filter(value => value.path !== path); this.state.repositories.push(enrollment);
            await this.save(); return enrollment;
        }
        if (operation === 'open') {
            validateAllowedKeys(input, ['path']);
            const repository = await realpath(text(input.path, 'repository')); this.enrollment(repository);
            const token = randomBytes(32).toString('hex'); this.capabilities.set(digest(token), { repository });
            return prepareHost(this.host, 'orchestrator-' + digest(repository).slice(0, 12), token);
        }
        if (operation === 'status') return this.state.tasks.map(value => this.publicTask(value));
        if (operation === 'cancel') return this.cancel(this.task(input.id));
        if (operation === 'bundle') return this.bundle(this.task(input.id));
        if (operation === 'integrate') return this.integrate(this.task(input.id), text(input.digest, 'bundle digest', 64));
        throw new Error('Unknown administrative operation');
    }
    private async start(enrolled: Enrollment, input: Record<string, unknown>) {
        validateAllowedKeys(input, ['requestId', 'role', 'model', 'prompt']);
        const role = input.role;
        if (role !== 'reader' && role !== 'runner' && role !== 'writer') throw new Error('Invalid leaf role');
        const model = text(input.model, 'model', 256), prompt = text(input.prompt, 'prompt'), requestId = text(input.requestId, 'requestId', 128);
        if (!enrolled.models.includes(model)) throw new Error('Selected model is not allowlisted; no model fallback is performed');
        if (role === 'writer' && !enrolled.writeScopes.length) throw new Error('Repository enrollment is read-only');
        const requestHash = digest(JSON.stringify({ role, model, prompt }));
        const duplicate = this.state.tasks.find(task => task.repository === enrolled.path && task.requestId === requestId);
        if (duplicate) { if (duplicate.requestHash !== requestHash) throw new Error('requestId was already used for different work'); return this.publicTask(duplicate); }
        if (this.children.size >= 2) throw new Error('Preview concurrency limit is two attempts; no work was queued');
        if (this.state.tasks.length >= 200) throw new Error('This preview root has reached its 200-task limit; use a fresh root until retention is implemented');
        const id = randomUUID(), capability = randomBytes(32).toString('hex'), at = new Date().toISOString();
        const task: PreviewTask = { id, requestId, requestHash, repository: enrolled.path, role, model, prompt, state: 'preparing', createdAt: at, updatedAt: at, directory: enrolled.path, capabilityHash: digest(capability), summary: '', evidence: [] };
        this.state.tasks.push(task); await this.save();
        try {
            if (role === 'writer') {
                await createWorktreeRun({ directory: enrolled.path, runId: id, maxWriters: 1, worktreeRoot: join(this.host.root, 'worktrees'), spawn: this.git, stateRegistry: this.worktrees });
                task.directory = (await createWriterWorktree({ runId: id, itemId: 'writer', ownedWriteScope: enrolled.writeScopes, spawn: this.git, stateRegistry: this.worktrees })).path;
            }
            const profile = await prepareHost(this.host, id, capability, true);
            const specification = join(this.host.root, 'hosts', id, 'attempt.json');
            await writePrivateJson(specification, { executable: this.host.executable, cwd: profile.cwd, env: profile.env, argv: ['run', '--standalone', '--agent', 'naru-preview', '--model', model, '--format', 'json', prompt] });
            task.state = 'running'; this.capabilities.set(task.capabilityHash, { repository: enrolled.path, task: id }); await this.save();
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
                    task.summary = summary || 'The selected host/model did not return a completed text result. Check provider login and the exact model; no retry or fallback was started.';
                    task.updatedAt = new Date().toISOString(); await this.save();
                }
            }); });
        } catch (error) { task.state = 'failed'; task.summary = error instanceof Error ? error.message : 'Attempt setup failed'; await this.save(); }
        return this.publicTask(task);
    }
    private async cancel(task: PreviewTask) {
        if (task.state !== 'running') throw new Error('Only running tasks may be cancelled');
        task.state = 'cancelled'; task.updatedAt = new Date().toISOString(); this.capabilities.delete(task.capabilityHash);
        this.children.get(task.id)?.disconnect(); await this.save(); return this.publicTask(task);
    }
    private async inspect(directory: string, operation: string, input: Record<string, unknown>): Promise<unknown> {
        if (operation === 'read') { validateAllowedKeys(input, ['path']); return readWorkspace(directory, input.path); }
        validateAllowedKeys(input, ['contains']);
        const needle = input.contains === undefined ? '' : text(input.contains, 'contains', 256);
        const files: string[] = [];
        const visit = async (folder: string) => {
            for (const entry of await readdir(join(directory, folder), { withFileTypes: true })) {
                if (files.length >= 2000) return;
                const path = folder ? `${folder}/${entry.name}` : entry.name;
                if (!isSafeRelativePath(path) || entry.isSymbolicLink()) continue;
                if (entry.isDirectory()) await visit(path);
                else if (entry.isFile() && path.includes(needle)) files.push(path);
            }
        };
        await visit(''); return { files, truncated: files.length >= 2000 };
    }
    private async workerRequest(task: PreviewTask, operation: string, input: Record<string, unknown>): Promise<unknown> {
        if (operation === 'files' || operation === 'read') return this.inspect(task.directory, operation, input);
        if (operation === 'write') {
            validateAllowedKeys(input, ['path', 'content', 'expectedHash']);
            if (task.role !== 'writer') throw new Error('Only writer capabilities may change files');
            const path = text(input.path, 'path', 1024), enrollment = this.enrollment(task.repository);
            if (!enrollment.writeScopes.some(scope => scopeCoversPath(scope, path))) throw new Error('Path is outside enrollment write scope');
            if (typeof input.content !== 'string' || Buffer.byteLength(input.content) > 128 * 1024 || input.content.includes('\0')) throw new Error('Write requires bounded text content');
            const file = await safeWorkspacePath(task.directory, path, true);
            let before: string | null = null;
            try { before = (await readWorkspace(task.directory, path)).sha256; } catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error; }
            if (input.expectedHash !== before) throw new Error('File changed since inspection; expectedHash must match, or be null for a new file');
            const handle = await open(file, constants.O_WRONLY | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
            try { await handle.truncate(0); await handle.writeFile(input.content); await handle.sync(); } finally { await handle.close(); }
            const hash = digest(input.content); task.evidence.push({ operation, path, hash }); await this.save(); return { path, sha256: hash };
        }
        if (operation === 'check') {
            validateAllowedKeys(input, ['argv']);
            if (task.role === 'reader') throw new Error('Reader capabilities cannot execute repository code');
            if (!Array.isArray(input.argv) || input.argv.some(arg => typeof arg !== 'string')) throw new Error('Invalid argv');
            const result = await isolatedCheck(task.directory, input.argv as string[], this.host.node, join(this.host.root, 'checks'));
            task.evidence.push({ operation, ok: result.ok }); await this.save(); return result;
        }
        if (operation === 'status') return this.publicTask(task);
        throw new Error('Operation is not available to a leaf worker');
    }
    private async bundle(task: PreviewTask) {
        if (task.role !== 'writer' || task.state !== 'completed') throw new Error('Only completed writer attempts can be integrated');
        const patch = await this.gitText(task.directory, ['diff', '--binary', '--full-index', '--no-ext-diff', 'HEAD', '--', '.']);
        const tracked = (await this.gitText(task.directory, ['diff', '--name-only', '-z', 'HEAD', '--', '.'])).split('\0').filter(Boolean).sort();
        const untracked = (await this.gitText(task.directory, ['ls-files', '--others', '--exclude-standard', '-z'])).split('\0').filter(Boolean).sort();
        const files = [];
        for (const path of untracked) files.push(await readWorkspace(task.directory, path));
        const head = (await this.gitText(task.repository, ['rev-parse', 'HEAD'])).trim();
        const changedPaths = [...new Set([...tracked, ...untracked])].sort();
        const data = { task: task.id, repository: task.repository, head, patch, changedPaths, files };
        return { ...data, digest: digest(JSON.stringify(data)) };
    }
    private async integrate(task: PreviewTask, expected: string) {
        const bundle = await this.bundle(task);
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
