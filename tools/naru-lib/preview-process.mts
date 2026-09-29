import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { access, cp, lstat, mkdir, mkdtemp, readlink, realpath, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path';
import type { Spawn } from './transport.mjs';
import { isSafeRelativePath } from './validate.mjs';
import { pathContains, protectedPathContains } from './safe-write.mjs';

const active = new Set<number>();
export type PreviewReadinessMode = 'mcp' | 'auth' | 'catalogue';
export interface PreviewReadinessTiming { deadlineMs?: number; requestTimeoutMs?: number; pollIntervalMs?: number; requiredMcpNames?: string[]; readyFiles?: string[] }
export interface PreviewCatalogueModel { id: string; providerID: string; name: string; reference: string; capabilities: { tools: boolean; input: string[]; output: string[] }; variantIDs: string[] }
export type PreviewCatalogueExclusion = 'provider-disabled' | 'model-disabled' | 'deprecated' | 'tools-unsupported' | 'text-input-unsupported' | 'text-output-unsupported';
export interface PreviewCatalogueEntry { id: string; providerID: string; upstreamModelID: string; name: string; reference: string; variantIDs: string[]; capabilities: { tools: boolean; input: string[]; output: string[] }; limit: { context: number; input?: number; output?: number }; releasedAt: number; eligibility: 'eligible' | 'excluded'; reason?: PreviewCatalogueExclusion }
export interface PreviewCatalogue { models: PreviewCatalogueModel[]; providers: Array<{ id: string; name: string; activation: 'auto' | 'enabled' | 'disabled' }>; entries?: PreviewCatalogueEntry[]; observedAt: string; metadataFreshness: 'unknown'; accountAccess: 'unknown'; source?: { management: 'host-managed-unverified' | 'naru-snapshot'; digest?: string; completedAt?: string; upstreamFreshness: 'unknown' } }

export function nodeSpawner(env: NodeJS.ProcessEnv): Spawn {
    return async (argv, options = {}) => new Promise(resolve => {
        const child = spawn(argv[0]!, argv.slice(1), { cwd: options.cwd, env, detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
        child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
        if (child.pid) active.add(child.pid);
        let stdout = '', stderr = '', stdoutBytes = 0, stderrBytes = 0, stdoutTruncated = false, stderrTruncated = false, settled = false, timedOut = false;
        const limit = options.maxBytes ?? 1024 * 1024;
        const kill = () => { try { if (child.pid) process.kill(-child.pid, 'SIGKILL'); } catch { /* Already exited. */ } };
        const finish = (code: number | null) => {
            if (settled) return;
            settled = true; clearTimeout(timer); kill(); if (child.pid) active.delete(child.pid);
            resolve({ ok: code === 0 && !timedOut && !stdoutTruncated && !stderrTruncated, code, stdout, stderr,
                stdoutTruncated, stderrTruncated, ...(timedOut ? { timedOut: true as const } : {}) });
        };
        const timer = setTimeout(() => { timedOut = true; kill(); finish(null); }, options.timeout ?? 30000);
        child.stdout.on('data', chunk => {
            const value = Buffer.from(chunk); const remaining = Math.max(0, limit - stdoutBytes);
            stdout += value.subarray(0, remaining).toString(); stdoutBytes += value.length;
            if (stdoutBytes > limit) { stdoutTruncated = true; kill(); finish(null); }
        });
        child.stderr.on('data', chunk => {
            const value = Buffer.from(chunk); const remaining = Math.max(0, limit - stderrBytes);
            stderr += value.subarray(0, remaining).toString(); stderrBytes += value.length;
            if (stderrBytes > limit) { stderrTruncated = true; kill(); finish(null); }
        });
        child.on('error', () => finish(null));
        child.on('close', (code, signal) => { if (signal) stderr += `Process terminated by ${signal}`; finish(code); });
        child.stdin.on('error', () => {});
        child.stdin.end(options.input);
    });
}
export function cleanProcessEnvironment(node: string): NodeJS.ProcessEnv {
    return { PATH: `${dirname(node)}:/usr/bin:/bin`, LANG: 'C', NO_COLOR: '1', GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' };
}
export async function runtimeReadRoot(node: string): Promise<string> {
    if (!isAbsolute(node)) throw new Error('Node runtime path must be absolute');
    const canonicalNode = await realpath(node);
    const root = await realpath(dirname(dirname(canonicalNode)));
    const home = await realpath(homedir()).catch(() => resolve(homedir()));
    const broadRoots = new Set(['/', '/Applications', '/Library', '/System', '/Users', '/Volumes', '/bin', '/opt', '/private', '/private/tmp', '/private/var', '/sbin', '/tmp', '/usr', '/usr/local', '/var']);
    if (!pathContains(root, canonicalNode) || broadRoots.has(root) || pathContains(root, home)) {
        throw new Error('Node runtime read root is too broad for isolated checks');
    }
    return root;
}
async function verificationSource(directory: string): Promise<string> {
    const source = await realpath(directory);
    if (source === parse(source).root) throw new Error('Isolated checks cannot snapshot the filesystem root; choose a narrower enrolled directory');
    return source;
}
export async function copyVerificationSnapshot(directory: string, snapshot: string, excludedPaths: string[] = []): Promise<void> {
    directory = await verificationSource(directory);
    const exclusions = [...excludedPaths];
    const snapshotPath = resolve(snapshot);
    if (pathContains(directory, snapshotPath)) exclusions.push(relative(directory, snapshotPath));
    let files = 0, bytes = 0;
    await cp(directory, snapshot, { recursive: true, dereference: false, verbatimSymlinks: true, filter: async source => {
        const file = relative(directory, source);
        if (file) {
            if (exclusions.some(excluded => protectedPathContains(excluded, file))) return false;
            const parts = file.split(sep);
            if (parts.includes('node_modules') || !isSafeRelativePath(file)) return false;
        }
        const info = await lstat(source);
        if (++files > 50000 || (bytes += info.isFile() ? info.size : 0) > 512 * 1024 * 1024) throw new Error('Verification snapshot exceeds preview limits');
        if (info.isSymbolicLink()) {
            const link = await readlink(source);
            const target = await realpath(source).catch(() => '');
            const targetPath = relative(directory, target);
            return !isAbsolute(link) && pathContains(directory, target) && isSafeRelativePath(targetPath);
        }
        return info.isDirectory() || info.isFile();
    } });
}
function readinessUrl(url: string, path: string, cwd: string): string {
    return url + path + '?location%5Bdirectory%5D=' + encodeURIComponent(cwd);
}
function requestSignal(deadline: number, requestTimeoutMs: number): AbortSignal {
    return AbortSignal.timeout(Math.max(1, Math.min(requestTimeoutMs, deadline - Date.now())));
}
async function responseJson(response: Response, message: string): Promise<unknown> {
    if (!response.ok) throw new Error(`${message} (${response.status})`);
    try { return await response.json(); } catch (error) {
        if (error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError')) throw error;
        throw new Error(`${message}: malformed response`);
    }
}
async function boundedResponseJson(response: Response, message: string, maxBytes = 1024 * 1024): Promise<unknown> {
    if (!response.ok) throw new Error(`${message} (${response.status})`);
    const declared = Number(response.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > maxBytes) { await response.body?.cancel(); throw new Error(`${message}: response exceeded the byte limit`); }
    if (!response.body) throw new Error(`${message}: empty response`);
    const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let bytes = 0;
    try {
        while (true) {
            const item = await reader.read(); if (item.done) break;
            bytes += item.value.byteLength;
            if (bytes > maxBytes) { await reader.cancel(); throw new Error(`${message}: response exceeded the byte limit`); }
            chunks.push(item.value);
        }
    } finally { reader.releaseLock(); }
    try { return JSON.parse(Buffer.concat(chunks.map(chunk => Buffer.from(chunk))).toString('utf8')); }
    catch { throw new Error(`${message}: malformed response`); }
}
const providerCatalogueID = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;
const modelCatalogueSegment = /^[a-zA-Z0-9@~][a-zA-Z0-9._:@~-]{0,127}$/;
export function isSafeCatalogueModelID(value: unknown): value is string {
    if (typeof value !== 'string' || value.length > 512 || value.startsWith('/') || value.endsWith('/')) return false;
    const segments = value.split('/');
    return segments.length <= 16 && segments.every(segment => segment !== '.' && segment !== '..' && modelCatalogueSegment.test(segment));
}
const variantCatalogueID = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;
const unsafeDisplay = /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]/u;
const displayText = (value: unknown, max: number): value is string => typeof value === 'string' && value.length > 0 && value.length <= max && !unsafeDisplay.test(value);
const stringArray = (value: unknown): value is string[] => Array.isArray(value) && value.length <= 32 && value.every(item => displayText(item, 64));
export async function fetchPreviewCatalogue(url: string, cwd: string, headers: Record<string, string>, timing: PreviewReadinessTiming = {}): Promise<PreviewCatalogue> {
    const deadline = Date.now() + (timing.deadlineMs ?? 20000), requestTimeoutMs = timing.requestTimeoutMs ?? 5000;
    const get = async (path: string, message: string, maxBytes = 1024 * 1024) => {
        try { return await boundedResponseJson(await fetch(readinessUrl(url, path, cwd), { headers, signal: requestSignal(deadline, requestTimeoutMs) }), message, maxBytes); }
        catch (error) {
            if (error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError')) throw new Error(`${message} timed out; catalogue freshness and account access remain unknown`);
            throw error;
        }
    };
    const providerValue = await get('/api/provider', 'OpenCode provider catalogue failed');
    const modelValue = await get('/api/model', 'OpenCode model catalogue failed', 16 * 1024 * 1024);
    if (!providerValue || typeof providerValue !== 'object' || !('location' in providerValue) || !('data' in providerValue) || !Array.isArray(providerValue.data)
        || !modelValue || typeof modelValue !== 'object' || !('location' in modelValue) || !('data' in modelValue) || !Array.isArray(modelValue.data)) throw new Error('OpenCode catalogue response has an invalid schema');
    const providers: PreviewCatalogue['providers'] = []; const providerIDs = new Set<string>();
    for (const value of providerValue.data) {
        if (!value || typeof value !== 'object') throw new Error('OpenCode provider catalogue response has an invalid schema');
        const provider = value as Record<string, unknown>;
        if (typeof provider.id !== 'string' || !providerCatalogueID.test(provider.id) || providerIDs.has(provider.id) || !displayText(provider.name, 256)
            || (provider.activation !== 'auto' && provider.activation !== 'enabled' && provider.activation !== 'disabled') || typeof provider.package !== 'string') throw new Error('OpenCode provider catalogue response has an invalid schema');
        providerIDs.add(provider.id); providers.push({ id: provider.id, name: provider.name, activation: provider.activation });
    }
    const providerMap = new Map(providers.map(provider => [provider.id, provider]));
    const models: PreviewCatalogueModel[] = []; const entries: PreviewCatalogueEntry[] = []; const references = new Set<string>();
    for (const value of modelValue.data) {
        if (!value || typeof value !== 'object') throw new Error('OpenCode model catalogue response has an invalid schema');
        const model = value as Record<string, unknown>, capabilities = model.capabilities, limit = model.limit;
        if (!isSafeCatalogueModelID(model.id) || typeof model.modelID !== 'string' || !model.modelID || typeof model.providerID !== 'string' || !providerCatalogueID.test(model.providerID)
            || !displayText(model.name, 256) || !capabilities || typeof capabilities !== 'object' || Array.isArray(capabilities)
            || typeof (capabilities as Record<string, unknown>).tools !== 'boolean' || !stringArray((capabilities as Record<string, unknown>).input) || !stringArray((capabilities as Record<string, unknown>).output)
            || !Array.isArray(model.variants) || model.variants.length > 32 || !model.time || typeof model.time !== 'object' || typeof (model.time as Record<string, unknown>).released !== 'number'
            || !Array.isArray(model.cost) || (model.status !== 'alpha' && model.status !== 'beta' && model.status !== 'deprecated' && model.status !== 'active') || typeof model.enabled !== 'boolean'
            || !limit || typeof limit !== 'object' || typeof (limit as Record<string, unknown>).context !== 'number') throw new Error('OpenCode model catalogue response has an invalid schema');
        const variantIDs: string[] = [];
        for (const variantValue of model.variants) {
            if (!variantValue || typeof variantValue !== 'object' || typeof (variantValue as Record<string, unknown>).id !== 'string' || !variantCatalogueID.test((variantValue as Record<string, unknown>).id as string) || variantIDs.includes((variantValue as Record<string, unknown>).id as string)) throw new Error('OpenCode model catalogue response has an invalid schema');
            variantIDs.push((variantValue as Record<string, unknown>).id as string);
        }
        const reference = `${model.providerID}/${model.id}`;
        if (references.has(reference)) throw new Error('OpenCode model catalogue contains duplicate model IDs');
        references.add(reference);
        const capability = capabilities as Record<string, unknown>, provider = providerMap.get(model.providerID);
        if (!provider) throw new Error('OpenCode model catalogue references an unknown provider');
        const reason: PreviewCatalogueExclusion | undefined = provider.activation === 'disabled' ? 'provider-disabled'
            : !model.enabled ? 'model-disabled' : model.status === 'deprecated' ? 'deprecated' : !capability.tools ? 'tools-unsupported'
                : !(capability.input as string[]).includes('text') ? 'text-input-unsupported' : !(capability.output as string[]).includes('text') ? 'text-output-unsupported' : undefined;
        const normalizedLimit = limit as Record<string, unknown>;
        const entry: PreviewCatalogueEntry = { id: model.id, providerID: model.providerID, upstreamModelID: model.modelID, name: model.name, reference, variantIDs,
            capabilities: { tools: capability.tools as boolean, input: [...capability.input as string[]], output: [...capability.output as string[]] },
            limit: { context: normalizedLimit.context as number, ...(typeof normalizedLimit.input === 'number' ? { input: normalizedLimit.input } : {}), ...(typeof normalizedLimit.output === 'number' ? { output: normalizedLimit.output } : {}) },
            releasedAt: (model.time as Record<string, unknown>).released as number, eligibility: reason ? 'excluded' : 'eligible', ...(reason ? { reason } : {}) };
        Object.defineProperty(entry, 'upstreamModelID', { value: model.modelID, enumerable: false });
        entries.push(entry);
        if (!reason) {
            models.push({ id: model.id, providerID: model.providerID, name: model.name, reference, capabilities: { tools: true, input: [...(capability.input as string[])], output: [...(capability.output as string[])] }, variantIDs });
        }
    }
    return { models, providers, entries, observedAt: new Date().toISOString(), metadataFreshness: 'unknown', accountAccess: 'unknown' };
}

const authMethodTypes = new Set(['command', 'env', 'key', 'oauth']);
const interactiveAuthMethodTypes = new Set(['command', 'key', 'oauth']);
export async function waitForPreviewReadiness(url: string, cwd: string, headers: Record<string, string>, mode: PreviewReadinessMode, timing: PreviewReadinessTiming = {}): Promise<void> {
    const deadline = Date.now() + (timing.deadlineMs ?? 20000);
    const requestTimeoutMs = timing.requestTimeoutMs ?? 5000;
    const pollIntervalMs = timing.pollIntervalMs ?? 200;
    const activate = async () => {
        let response: Response;
        try {
            response = await fetch(readinessUrl(url, '/api/plugin/await-activation', cwd), { method: 'POST', headers, signal: requestSignal(deadline, requestTimeoutMs) });
        } catch (error) {
            if (error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError')) throw new Error('OpenCode catalogue activation timed out');
            throw new Error('OpenCode catalogue activation failed');
        }
        if (response.status === 404) {
            await response.body?.cancel();
            while (Date.now() < deadline) {
                try {
                    const plugins = await fetch(readinessUrl(url, '/api/plugin', cwd), { headers, signal: requestSignal(deadline, requestTimeoutMs) });
                    const value = await responseJson(plugins, 'OpenCode catalogue activation failed') as { data?: unknown };
                    if (!Array.isArray(value?.data)) throw new Error('OpenCode catalogue activation failed: malformed plugin response');
                    if (value.data.length) return;
                } catch (error) {
                    if (!(error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError'))) throw error;
                }
                await new Promise(resolve => setTimeout(resolve, Math.min(pollIntervalMs, Math.max(0, deadline - Date.now()))));
            }
            throw new Error('OpenCode catalogue activation timed out');
        }
        await response.body?.cancel();
        if (response.status !== 204) throw new Error(`OpenCode catalogue activation failed (${response.status})`);
    };
    if (mode === 'catalogue') {
        await activate();
        return;
    }
    if (mode === 'auth') {
        try {
            // Remote auth commands use the server's startup directory and do not send a location override.
            const response = await fetch(url + '/api/model/default', { headers, signal: requestSignal(deadline, requestTimeoutMs) });
            await response.body?.cancel();
        } catch { /* This endpoint is only a catalogue activation hint. */ }
        while (Date.now() < deadline) {
            let response: Response;
            try { response = await fetch(url + '/api/integration', { headers, signal: requestSignal(deadline, requestTimeoutMs) }); }
            catch (error) {
                if (!(error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError'))) throw error;
                if (Date.now() >= deadline) break;
                await new Promise(resolve => setTimeout(resolve, Math.min(pollIntervalMs, Math.max(0, deadline - Date.now()))));
                continue;
            }
            const value = await responseJson(response, 'Private OpenCode auth readiness failed');
            if (!value || typeof value !== 'object' || !('data' in value) || !Array.isArray(value.data)) throw new Error('Private OpenCode auth readiness failed: malformed response');
            const integrations = value.data as unknown[];
            let interactive = false;
            for (const integration of integrations) {
                if (!integration || typeof integration !== 'object' || !('methods' in integration) || !Array.isArray(integration.methods)) throw new Error('Private OpenCode auth readiness failed: malformed response');
                for (const method of integration.methods) {
                    if (!method || typeof method !== 'object' || !('type' in method) || typeof method.type !== 'string') throw new Error('Private OpenCode auth readiness failed: malformed response');
                    if (!authMethodTypes.has(method.type)) throw new Error('Private OpenCode auth readiness failed: malformed response');
                    if (interactiveAuthMethodTypes.has(method.type)) interactive = true;
                }
            }
            if (interactive) return;
            await new Promise(resolve => setTimeout(resolve, Math.min(pollIntervalMs, Math.max(0, deadline - Date.now()))));
        }
        throw new Error('OpenCode authentication integrations readiness timed out');
    }
    await activate();
    const required = timing.requiredMcpNames ?? ['naru'];
    const readyFiles = timing.readyFiles ?? [];
    let connectedAt = 0, observations = 0;
    for (let attempt = 0; attempt < 100 && Date.now() < deadline; attempt++) {
        const response = await fetch(readinessUrl(url, '/api/mcp', cwd), { headers, signal: requestSignal(deadline, requestTimeoutMs) });
        const value = await responseJson(response, 'Private OpenCode readiness failed') as { data?: Array<{ name: string; status: { status: string; error?: string } }> };
        const servers = required.map(name => value.data?.find(item => item.name === name));
        const failed = servers.find(server => server?.status.status === 'failed');
        if (failed) throw new Error(`Required Naru MCP server ${failed.name} failed to connect${failed.status.error ? `: ${failed.status.error.slice(0, 512)}` : ''}`);
        if (servers.every(server => server?.status.status === 'connected')) {
            if (!connectedAt) connectedAt = Date.now();
            observations++;
            const toolsListed = (await Promise.all(readyFiles.map(path => access(path).then(() => true, () => false)))).every(Boolean);
            if (observations >= 2 && Date.now() - connectedAt >= 150 && toolsListed) return;
        } else { connectedAt = 0; observations = 0; }
        await new Promise(resolve => setTimeout(resolve, Math.min(pollIntervalMs, Math.max(0, deadline - Date.now()))));
    }
    throw new Error('Naru MCP readiness timed out');
}
export async function startPreviewServer(executable: string, cwd: string, environment: NodeJS.ProcessEnv, readiness: PreviewReadinessMode = 'mcp', timing: PreviewReadinessTiming = {}) {
    const password = randomBytes(32).toString('hex');
    const env: NodeJS.ProcessEnv = { ...environment, OPENCODE_PASSWORD: password };
    if (readiness === 'mcp') for (const path of (env.NARU_PREVIEW_MCP_READY_FILES ?? '').split(':').filter(Boolean)) await rm(path, { force: true });
    const child = spawn(executable, ['serve', '--stdio', '--hostname', '127.0.0.1', '--port', '0'], { cwd, env, detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
    if (child.pid) active.add(child.pid);
    const stop = () => { child.stdin.end(); if (child.pid) { try { process.kill(-child.pid, 'SIGKILL'); } catch {} active.delete(child.pid); } };
    child.stdin.on('error', () => {});
    child.stderr.resume();
    child.once('close', () => { if (child.pid) active.delete(child.pid); });
    try {
        const url = await new Promise<string>((resolve, reject) => {
            let buffer = '';
            const timeout = setTimeout(() => reject(new Error('Private OpenCode server startup timed out')), 20000);
            const finish = (value?: string) => { clearTimeout(timeout); if (value) resolve(value); else reject(new Error('Private OpenCode server failed to start')); };
            child.once('error', () => finish()); child.once('close', () => finish());
            child.stdout.on('data', chunk => {
                buffer += chunk.toString();
                if (buffer.length > 8192) { finish(); return; }
                for (const line of buffer.split('\n')) {
                    try { const parsed = JSON.parse(line); if (typeof parsed.url === 'string' && /^http:\/\/127\.0\.0\.1:\d+$/.test(parsed.url)) { finish(parsed.url); return; } } catch {}
                }
            });
        });
        const headers = { authorization: 'Basic ' + Buffer.from(`opencode:${password}`).toString('base64') };
        await waitForPreviewReadiness(url, cwd, headers, readiness, { ...timing,
            requiredMcpNames: (env.NARU_PREVIEW_REQUIRED_MCP ?? 'naru').split(',').filter(Boolean),
            readyFiles: (env.NARU_PREVIEW_MCP_READY_FILES ?? '').split(':').filter(Boolean),
        });
        return { url, env, headers, stop };
    } catch (error) { stop(); throw error; }
}
export async function isolatedCheck(directory: string, argv: string[], node: string, scratchRoot: string, excludedPaths: string[] = []) {
    if (process.platform !== 'darwin') throw new Error('Isolated checks are unavailable: this platform has not passed containment certification');
    if (!Array.isArray(argv) || argv.length === 0 || argv.length > 64 || argv.some(arg => typeof arg !== 'string' || arg.length > 8192 || arg.includes('\0'))) throw new Error('Invalid check argv');
    directory = await verificationSource(directory);
    const scratchInsideSource = pathContains(directory, resolve(scratchRoot));
    if (!scratchInsideSource) await mkdir(scratchRoot, { recursive: true, mode: 0o700 });
    const temporary = await realpath(await mkdtemp(scratchInsideSource ? join(tmpdir(), 'naru-check-') : join(scratchRoot, 'check-')));
    const snapshot = join(temporary, 'workspace');
    try {
        await copyVerificationSnapshot(directory, snapshot, excludedPaths);
        const tmp = join(temporary, 'tmp');
        await mkdir(tmp, { mode: 0o700 });
        const executableRoot = await runtimeReadRoot(node);
        const quote = (value: string) => JSON.stringify(value);
        const profile = `(version 1)
(deny default)
(import "system.sb")
(allow syscall* mach-bootstrap process-exec process-fork sysctl-read file-read-metadata)
(allow signal (target self))
(allow file-read* file-map-executable (subpath "/System") (subpath "/usr") (subpath "/bin") (subpath "/sbin") (subpath "/Library") (subpath "/private/var/db") (subpath "/dev") (subpath ${quote(executableRoot)}) (subpath ${quote(temporary)}))
(allow file-write* (subpath ${quote(temporary)}) (literal "/dev/null"))`;
        return await nodeSpawner({ ...cleanProcessEnvironment(node), HOME: tmp, TMPDIR: tmp, TMP: tmp, TEMP: tmp })(
            ['/usr/bin/sandbox-exec', '-p', profile, ...argv], { cwd: snapshot, timeout: 30000, maxBytes: 128 * 1024 });
    } finally { await rm(temporary, { recursive: true, force: true }); }
}
