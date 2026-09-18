#!/usr/bin/env node
import { createServer, request as httpRequest } from 'node:http';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { cp, lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { PreviewBroker, digest, writePrivateJson } from './naru-lib/preview-broker.mjs';
import { PREVIEW_VERSION, hostEnvironment, type PreviewHost } from './naru-lib/preview-host.mjs';
import { MAX_CATALOGUE_REFERENCE_LENGTH, parseCatalogueReference } from './naru-lib/native-reader-projection.mjs';
import { cleanProcessEnvironment, diagnoseExactPreviewCatalogue, diagnosePreviewCatalogue, differentialCatalogueWitness, fetchPreviewCatalogue, nodeSpawner, startPreviewServer, stopPreviewProcesses, type PreviewCatalogue } from './naru-lib/preview-process.mjs';
import { loadManagedModelSource, readManagedModelFeed, refreshManagedModelSource, type PreviewModelSource } from './naru-lib/preview-model-catalogue.mjs';
import { runPreviewWizard, TerminalWizardPrompt, WizardCancelled, type PreviewSetupStatus } from './naru-lib/preview-wizard.mjs';
import { acquirePreviewUpdateGuard, assertPreviewUpdateGuard } from './naru-lib/preview-update-guard.mjs';
import { evaluateOpenCodeVersion } from './naru-lib/compatibility.mjs';
import { isPlainObject } from './naru-lib/validate.mjs';
import type { ProcessResult } from './naru-lib/transport.mjs';

const args = process.argv.slice(2);
function option(name: string): string | undefined {
    const index = args.indexOf(name); if (index < 0) return undefined;
    const value = args[index + 1]; if (!value || value.startsWith('--')) throw new Error(`${name} requires a value`);
    args.splice(index, 2); return value;
}
const rootOption = option('--root');
const interfaceOption = option('--interface');
const root = resolve(rootOption ?? join(homedir(), '.local', 'share', 'naru-preview'));
const socketPath = join(root, 'broker.sock');
const privateConnectionFlags = new Set(['--hostname', '--port', '--server', '--standalone']);
export function assertNoPrivateConnectionFlags(values: string[]): void {
    const flag = values.find(value => privateConnectionFlags.has(value) || [...privateConnectionFlags].some(name => value.startsWith(name + '=')));
    if (flag) throw new Error(`${flag.split('=')[0]} is managed by Naru for this command`);
}
export function modelsOutput(result: ProcessResult): { stdout: string; stderr: string; exitCode: number } {
    let stderr = result.stderr;
    const diagnostic = (message: string) => { stderr += (stderr && !stderr.endsWith('\n') ? '\n' : '') + `naru-preview: ${message}\n`; };
    if (result.stdoutTruncated) diagnostic('OpenCode model listing stdout exceeded the capture limit');
    if (result.stderrTruncated) diagnostic('OpenCode model listing stderr exceeded the capture limit');
    if (result.timedOut) diagnostic('OpenCode model listing timed out');
    if (result.code === null && !result.timedOut && !result.stdoutTruncated && !result.stderrTruncated) diagnostic('OpenCode model listing could not start');
    if (result.ok && result.stdout.trim().length === 0) {
        diagnostic('OpenCode catalogue settled with no eligible models; this can be a legitimate account state, and upstream freshness and account access remain unknown');
        return { stdout: '', stderr, exitCode: 0 };
    }
    return { stdout: result.stdout, stderr, exitCode: result.ok ? 0 : (result.code && result.code > 0 ? result.code : 1) };
}
export async function runModelsListing(executable: string, cwd: string, env: NodeJS.ProcessEnv, values: string[]) {
    let server: Awaited<ReturnType<typeof startPreviewServer>> | undefined;
    const stop = () => { server?.stop(); stopPreviewProcesses(); };
    process.once('SIGTERM', stop); process.once('SIGINT', stop);
    try {
        server = await startPreviewServer(executable, cwd, env, 'catalogue');
        return await nodeSpawner(server.env)([executable, 'models', ...values, '--server', server.url], { cwd, timeout: 30000, maxBytes: 512 * 1024 });
    } finally {
        process.removeListener('SIGTERM', stop); process.removeListener('SIGINT', stop); server?.stop();
    }
}
async function privateRoot(create = true) {
    if (create) await mkdir(root, { recursive: true, mode: 0o700 });
    const info = await lstat(root);
    if (info.isSymbolicLink() || !info.isDirectory() || info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0) throw new Error('Preview root must be an owned, private directory (0700), not a symlink');
    if (socketPath.length > 100) throw new Error('Preview root is too long for a Unix socket');
}
async function host(): Promise<PreviewHost> {
    await privateRoot();
    const value = JSON.parse(await readFile(join(root, 'host.json'), 'utf8'));
    if (!/^[a-f0-9]{64}$/.test(value.executableHash ?? '') || value.root !== root || ![value.executable, value.node, value.cli].every(path => typeof path === 'string' && path.startsWith('/'))) throw new Error('Invalid preview host configuration');
    return value;
}
async function catalogueEnvironment(config: PreviewHost, profile = 'setup', source?: PreviewModelSource | null): Promise<NodeJS.ProcessEnv> {
    const selected = source === undefined ? await loadManagedModelSource(root) : source;
    const env = hostEnvironment(config, profile, profile, selected);
    for (const key of ['HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'XDG_STATE_HOME', 'TMPDIR']) await mkdir(env[key]!, { recursive: true, mode: 0o700 });
    return env;
}
async function observeCatalogue(config: PreviewHost, cwd: string, source?: PreviewModelSource | null): Promise<PreviewCatalogue> {
    let server: Awaited<ReturnType<typeof startPreviewServer>> | undefined;
    const selected = source === undefined ? await loadManagedModelSource(root) : source;
    try {
        server = await startPreviewServer(config.executable, cwd, await catalogueEnvironment(config, source === undefined ? 'setup' : `catalogue-${source?.digest.slice(0, 12) ?? 'native'}`, selected), 'catalogue');
        const value = await fetchPreviewCatalogue(server.url, cwd, server.headers);
        value.source = selected ? { management: 'naru-snapshot', digest: selected.digest, completedAt: selected.completedAt, upstreamFreshness: 'unknown' } : { management: 'host-managed-unverified', upstreamFreshness: 'unknown' };
        return value;
    } finally { server?.stop(); }
}
export async function differentialSourceProof(config: PreviewHost, candidate: PreviewModelSource): Promise<void> {
    if (process.platform !== 'darwin') throw new Error('Unable to verify model source on this platform; previous catalogue source was kept');
    const executableInfo = await lstat(config.executable), canonicalExecutable = await realpath(config.executable);
    const executableBytes = await readFile(config.executable);
    if (!executableInfo.isFile() || executableInfo.isSymbolicLink() || (executableInfo.mode & 0o111) === 0 || canonicalExecutable !== config.executable
        || !['cffaedfe', 'feedfacf', 'cefaedfe', 'feedface', 'cafebabe', 'cafebabf', 'bfbafeca', '7f454c46'].includes(executableBytes.subarray(0, 4).toString('hex'))
        || digest(executableBytes) !== config.executableHash) throw new Error('Pinned OpenCode native binary changed or is not a validated executable; previous catalogue source was kept');
    const feed = await readManagedModelFeed(candidate);
    const selectedProviders: string[] = [];
    for (const entry of [...feed.entries].sort((left, right) => Number(!!right.mode) - Number(!!left.mode) || right.releaseDate.localeCompare(left.releaseDate))) {
        if (!selectedProviders.includes(entry.providerID)) selectedProviders.push(entry.providerID);
        if (selectedProviders.length >= 16) break;
    }
    if (!selectedProviders.length) throw new Error('Unable to verify model source: candidate has no bounded provider witness; previous catalogue source was kept');
    const parent = join(config.root, 'model-catalogue');
    await mkdir(parent, { recursive: true, mode: 0o700 });
    const temporary = await realpath(await mkdtemp(join(parent, 'validation-')));
    try {
        const wrapper = join(temporary, 'sandboxed-opencode');
        const sandbox = '(version 1)(allow default)(deny network-outbound)(allow network-outbound (remote ip "localhost:*"))(allow network-outbound (remote unix-socket))';
        const versionRoot = join(temporary, 'version'); await mkdir(versionRoot, { mode: 0o700 });
        const versionEnv = { ...cleanProcessEnvironment(config.node), HOME: versionRoot, XDG_CONFIG_HOME: versionRoot, XDG_DATA_HOME: versionRoot, XDG_CACHE_HOME: versionRoot, XDG_STATE_HOME: versionRoot, TMPDIR: versionRoot, OPENCODE_DB: join(versionRoot, 'opencode.db'), OPENCODE_DISABLE_AUTOUPDATE: 'true', OPENCODE_DISABLE_PROJECT_CONFIG: 'true' };
        const version = await nodeSpawner(versionEnv)(['/usr/bin/sandbox-exec', '-p', '(version 1)(allow default)(deny network-outbound)', config.executable, '--version'], { cwd: versionRoot, timeout: 10_000 });
        if (!version.ok || evaluateOpenCodeVersion('v2-beta-exploratory', version.stdout).status !== 'supported') throw new Error(`Model source validation requires the exact native OpenCode ${PREVIEW_VERSION} binary; previous catalogue source was kept`);
        await writeFile(wrapper, `#!${config.node}\nimport{spawn}from'node:child_process';const child=spawn('/usr/bin/sandbox-exec',['-p',${JSON.stringify(sandbox)},${JSON.stringify(config.executable)},...process.argv.slice(2)],{env:process.env,stdio:'inherit'});child.on('exit',code=>process.exit(code??1));\n`, { mode: 0o755 });
        const providers = Object.fromEntries(selectedProviders.map(id => [id, { settings: { baseURL: 'http://127.0.0.1:9/validation-only' } }]));
        const run = async (name: 'baseline' | 'candidate', source: PreviewModelSource | null) => {
            const isolatedRoot = join(temporary, name); await mkdir(isolatedRoot, { mode: 0o700 });
            const isolatedHost: PreviewHost = { root: isolatedRoot, executable: wrapper, node: config.node, cli: config.cli };
            const env = hostEnvironment(isolatedHost, 'validation', 'validation', source);
            env.OPENCODE_DISABLE_MODELS_FETCH = 'true';
            for (const key of ['HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'XDG_STATE_HOME', 'TMPDIR']) await mkdir(env[key]!, { recursive: true, mode: 0o700 });
            await mkdir(join(env.XDG_CONFIG_HOME!, 'opencode'), { recursive: true, mode: 0o700 });
            await writeFile(join(env.XDG_CONFIG_HOME!, 'opencode', 'opencode.json'), JSON.stringify({ update: 'disable', providers }), { mode: 0o600 });
            let server: Awaited<ReturnType<typeof startPreviewServer>> | undefined;
            try { server = await startPreviewServer(wrapper, isolatedRoot, env, 'catalogue', { deadlineMs: 20_000, requestTimeoutMs: 5_000 }); return await fetchPreviewCatalogue(server.url, isolatedRoot, server.headers, { deadlineMs: 20_000, requestTimeoutMs: 5_000 }); }
            finally { server?.stop(); }
        };
        const baseline = await run('baseline', null), observed = await run('candidate', candidate);
        const selected = new Set(selectedProviders), witness = differentialCatalogueWitness(feed.entries.filter(entry => selected.has(entry.providerID)), baseline, observed);
        if (!witness) throw new Error('Unable to verify model source by differential metadata proof; previous catalogue source was kept');
    } finally { await rm(temporary, { recursive: true, force: true }).catch(() => {}); }
}
async function refreshCatalogue(config: PreviewHost, cwd: string): Promise<{ source: PreviewModelSource; catalogue: PreviewCatalogue }> {
    let accepted: PreviewCatalogue | undefined;
    const source = await refreshManagedModelSource(root, async candidate => { await differentialSourceProof(config, candidate); accepted = await observeCatalogue(config, cwd, candidate); });
    accepted ??= await observeCatalogue(config, cwd, source);
    return { source, catalogue: accepted };
}
function boundedSearch(value: string): string {
    if (!value || value.length > 256 || /[\u0000-\u001f\u007f-\u009f]/u.test(value)) throw new Error('Model name search must be 1 to 256 safe characters');
    return value;
}
function catalogueDiagnostic(value: string, exact: boolean, catalogue: PreviewCatalogue, entries: Array<{ reference: string; name: string }>) {
    return exact ? diagnoseExactPreviewCatalogue(parseCatalogueReference(value), catalogue, entries) : diagnosePreviewCatalogue(boundedSearch(value), catalogue, entries);
}
async function admin() { return (await readFile(join(root, 'admin'), 'utf8')).trim(); }
export function callBroker(socket: string, token: string, operation: string, input: unknown = {}): Promise<unknown> {
    return new Promise((resolvePromise, reject) => {
        const req = httpRequest({ socketPath: socket, path: '/', method: 'POST', headers: { 'content-type': 'application/json' } }, response => {
            let body = '', bytes = 0;
            response.on('data', chunk => { bytes += chunk.length; if (bytes > 4 * 1024 * 1024) response.destroy(new Error('Broker result too large')); else body += chunk; });
            response.on('error', reject);
            response.on('end', () => { try { const value = JSON.parse(body); if (value.error) reject(new Error(value.error)); else resolvePromise(value.result); } catch (error) { reject(error); } });
        });
        req.setTimeout(45000, () => req.destroy(new Error('Broker request timed out'))); req.on('error', reject);
        req.end(JSON.stringify({ token, operation, input }));
    });
}
export async function stopBroker(socket: string, token: string): Promise<{ stopped: true; alreadyStopped?: true }> {
    try {
        const result = await callBroker(socket, token, 'stop');
        if (!isPlainObject(result) || result.stopped !== true) throw new Error('Invalid broker stop response');
        return { stopped: true };
    } catch (error) {
        if (error instanceof Error && 'code' in error && ['ENOENT', 'ECONNREFUSED'].includes(String(error.code))) {
            return { stopped: true, alreadyStopped: true };
        }
        throw error;
    }
}
async function ensureDaemon(existingGuardToken?: string) {
    const config = await host(), token = await admin();
    if (existingGuardToken) await assertPreviewUpdateGuard(root, existingGuardToken);
    try { await callBroker(socketPath, token, 'status'); return; } catch (error) {
        if (!(error instanceof Error && 'code' in error && ['ENOENT', 'ECONNREFUSED'].includes(String(error.code)))) throw error;
    }
    const guard = existingGuardToken ? undefined : await acquirePreviewUpdateGuard(root);
    const guardToken = existingGuardToken ?? guard!.token;
    try {
        try { await callBroker(socketPath, token, 'status'); return; } catch (error) {
            if (!(error instanceof Error && 'code' in error && ['ENOENT', 'ECONNREFUSED'].includes(String(error.code)))) throw error;
        }
        try { const info = await lstat(socketPath); if (!info.isSocket()) throw new Error('Unsafe broker socket path'); await rm(socketPath); } catch (error) {
            if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
        }
        const child = spawn(config.node, [config.cli, 'daemon', '--root', root], { detached: true, stdio: 'ignore', env: { ...cleanProcessEnvironment(config.node), NARU_PREVIEW_GUARD_TOKEN: guardToken } });
        child.unref();
        for (let attempt = 0; attempt < 100; attempt++) {
            await new Promise(resolvePromise => setTimeout(resolvePromise, 50));
            try { await callBroker(socketPath, token, 'status'); return; } catch { /* Startup is bounded. */ }
        }
        throw new Error('Broker did not start; run naru-preview daemon in the foreground to inspect the error');
    } finally { if (guard) await guard.release(); }
}

export async function waitForChild(child: ReturnType<typeof spawn>, onStop?: () => void): Promise<number> {
    if (child.exitCode !== null || child.signalCode !== null) { onStop?.(); return child.exitCode ?? 1; }
    return new Promise((resolvePromise, reject) => {
        const failed = (error: Error) => { child.off('exit', exited); reject(error); };
        const exited = (code: number | null) => {
            child.off('error', failed);
            try { onStop?.(); resolvePromise(code ?? 1); } catch (error) { reject(error); }
        };
        child.once('error', failed); child.once('exit', exited);
    });
}
async function waitForSpawn(child: ReturnType<typeof spawn>): Promise<void> {
    await new Promise<void>((resolvePromise, reject) => {
        const spawned = () => { child.off('error', failed); resolvePromise(); };
        const failed = (error: Error) => { child.off('spawn', spawned); reject(error); };
        child.once('spawn', spawned); child.once('error', failed);
    });
    await new Promise<void>(resolvePromise => setImmediate(resolvePromise));
    if (child.exitCode !== null || child.signalCode !== null) throw new Error(`Naru host exited during startup with status ${child.exitCode ?? child.signalCode ?? 1}`);
}
async function runAuthentication(values: string[] = ['login']): Promise<void> {
    const guard = await acquirePreviewUpdateGuard(root);
    try {
        const config = await host(), env = await catalogueEnvironment(config);
        if (digest(await readFile(config.executable)) !== config.executableHash) throw new Error('Pinned OpenCode binary changed; use the compatible guarded oc2 updater before authentication');
        const server = await startPreviewServer(config.executable, root, env, 'auth');
        const child = spawn(config.executable, ['auth', ...values, '--server', server.url], { cwd: root, env: server.env, stdio: 'inherit' });
        const stop = () => { child.kill('SIGTERM'); server.stop(); process.exitCode = 1; };
        process.once('SIGTERM', stop); process.once('SIGINT', stop);
        try { const code = await waitForChild(child, server.stop); if (code !== 0) throw new WizardCancelled(true); }
        finally { process.removeListener('SIGTERM', stop); process.removeListener('SIGINT', stop); server.stop(); }
    } finally { await guard.release(); }
}
async function openRepository(path: string): Promise<void> {
    const guard = await acquirePreviewUpdateGuard(root);
    let released = false, server: Awaited<ReturnType<typeof startPreviewServer>> | undefined, child: ReturnType<typeof spawn> | undefined;
    try {
        await ensureDaemon(guard.token); const token = await admin();
        const config = await host(); const profile = await callBroker(socketPath, token, 'open', { path }) as { cwd: string; env: NodeJS.ProcessEnv };
        server = await startPreviewServer(config.executable, profile.cwd, profile.env);
        child = spawn(config.executable, ['--server', server.url], { cwd: profile.cwd, env: server.env, stdio: 'inherit' });
        await waitForSpawn(child);
        const liveChild = child, liveServer = server;
        let serverStopped = false;
        const stopServer = () => { if (!serverStopped) { serverStopped = true; liveServer.stop(); } };
        const stop = () => { liveChild.kill('SIGTERM'); stopServer(); };
        process.once('SIGTERM', stop); process.once('SIGINT', stop);
        await guard.release(); released = true;
        try { const code = await waitForChild(liveChild, stopServer); if (code !== 0) throw new Error(`Naru host exited with status ${code}`); }
        finally { process.removeListener('SIGTERM', stop); process.removeListener('SIGINT', stop); stopServer(); }
    } finally {
        if (!released) { child?.kill('SIGTERM'); server?.stop(); await guard.release(); }
    }
}
async function runWizard(configure: boolean): Promise<void> {
    if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error(`Interactive Naru ${configure ? 'configuration' : 'setup'} requires a TTY. Configure global worker models in a TTY, then use "oc2 naru enroll PATH [--access inspect|check|write] [--write scope]" for scripting and "oc2 naru open PATH". PATH may be a Git repository or an ordinary directory.`);
    await ensureDaemon(); const token = await admin();
    const prompt = new TerminalWizardPrompt();
    const result = await runPreviewWizard({ cwd: process.cwd(), configure, prompt, defaultGlobalInstructionsPath: join(homedir(), '.config', 'opencode', 'AGENTS.md'), adapters: {
        status: path => callBroker(socketPath, token, 'setup-status', { path: resolve(path) }) as Promise<PreviewSetupStatus>,
        authenticate: runAuthentication,
        catalogue: async path => {
            const guard = await acquirePreviewUpdateGuard(root); let server: Awaited<ReturnType<typeof startPreviewServer>> | undefined;
            try {
                const config = await host(), env = await catalogueEnvironment(config);
                server = await startPreviewServer(config.executable, path, env, 'catalogue');
                const value = await fetchPreviewCatalogue(server.url, path, server.headers), source = await loadManagedModelSource(root);
                value.source = source ? { management: 'naru-snapshot', digest: source.digest, completedAt: source.completedAt, upstreamFreshness: 'unknown' } : { management: 'host-managed-unverified', upstreamFreshness: 'unknown' };
                return value;
            } finally { server?.stop(); await guard.release(); }
        },
        refreshCatalogue: async path => {
            const guard = await acquirePreviewUpdateGuard(root);
            try { return (await refreshCatalogue(await host(), path)).catalogue; } finally { await guard.release(); }
        },
        diagnoseCatalogue: async (path, query, current) => {
            const source = await loadManagedModelSource(root);
            const entries = source ? (await readManagedModelFeed(source)).entries : [];
            const observed = current ?? await observeCatalogue(await host(), path);
            try { return catalogueDiagnostic(query, true, observed, entries); } catch { return catalogueDiagnostic(query, false, observed, entries); }
        },
        configureGlobal: input => callBroker(socketPath, token, 'configure-global', input) as Promise<import('./naru-lib/preview-broker.mjs').GlobalWorkerPool>,
        prepareGlobalInstructions: input => callBroker(socketPath, token, 'prepare-global-instructions', input) as Promise<import('./naru-lib/global-instructions.mjs').GlobalInstructionsSource & { sha256: string; byteLength: number }>,
        configureGlobalInstructions: input => callBroker(socketPath, token, 'configure-global-instructions', input) as Promise<import('./naru-lib/global-instructions.mjs').GlobalInstructionsMetadata>,
        disableGlobalInstructions: input => callBroker(socketPath, token, 'disable-global-instructions', input) as Promise<import('./naru-lib/global-instructions.mjs').GlobalInstructionsMetadata>,
        enroll: input => callBroker(socketPath, token, 'enroll', input) as Promise<import('./naru-lib/preview-broker.mjs').Enrollment>,
        open: openRepository,
    } });
    if (result.outcome === 'cancelled') {
        const durable = [result.authenticationMayHaveChanged ? 'isolated host login may have been saved' : '', result.globalWorkerPoolSaved ? 'global worker models were saved' : '', result.globalInstructionsSaved ? 'global instructions reference was saved' : ''].filter(Boolean).join('; ');
        console.log(durable ? `Naru setup cancelled. ${durable}. The workspace was not enrolled or changed.` : 'Naru setup cancelled. No workspace or global model policy was changed.');
    } else if (result.outcome === 'configured') console.log(result.globalInstructionsSaved ? 'Global instructions setting was saved. New sessions will read the approved target; existing sessions are unchanged.' : result.globalWorkerPoolSaved && !result.repository ? 'Global worker models were saved. New sessions will use them; existing sessions are unchanged.' : 'Workspace policy was saved. Run "oc2" in the workspace to retry launch.');
}
const objectSchema = (properties: Record<string, unknown>, required: string[] = []) => ({ type: 'object', properties, required, additionalProperties: false });
const typedTools = {
    files: { name: 'files', description: 'List up to 2,000 safe relative repository file paths, optionally filtered by a bounded substring.', inputSchema: objectSchema({ contains: { type: 'string', maxLength: 256 } }) },
    read: { name: 'read', description: 'Read one bounded UTF-8 repository file and return its content and sha256.', inputSchema: objectSchema({ path: { type: 'string', minLength: 1, maxLength: 1024 } }, ['path']) },
    status: { name: 'status', description: 'Report this managed worker.', inputSchema: objectSchema({}) },
    taskStatus: { name: 'task_status', description: 'List managed workers. Native readers are tracked by OpenCode child sessions and host UI.', inputSchema: objectSchema({ id: { type: 'string', minLength: 1, maxLength: 128 } }) },
    start: { name: 'task_start', description: 'Start one managed runner or writer using an exact enrolled catalogue model. Native readers must use the OpenCode subagent tool.', inputSchema: objectSchema({ role: { type: 'string', enum: ['runner', 'writer'] }, model: { type: 'string', minLength: 3, maxLength: MAX_CATALOGUE_REFERENCE_LENGTH }, prompt: { type: 'string', minLength: 1, maxLength: 16000 }, requestId: { type: 'string', minLength: 1, maxLength: 128 } }, ['role', 'model', 'prompt', 'requestId']) },
    cancel: { name: 'task_cancel', description: 'Cancel one running managed worker. Native reader cancellation belongs to OpenCode.', inputSchema: objectSchema({ id: { type: 'string', minLength: 1, maxLength: 128 } }, ['id']) },
    check: { name: 'check', description: 'Run a bounded check in a disposable sandbox without dependency directories.', inputSchema: objectSchema({ argv: { type: 'array', minItems: 1, maxItems: 64, items: { type: 'string', maxLength: 8192 } } }, ['argv']) },
    write: { name: 'write', description: 'Writer-only bounded text replacement using the sha256 returned by read, or null for a new file.', inputSchema: objectSchema({ path: { type: 'string', minLength: 1, maxLength: 1024 }, content: { type: 'string', maxLength: 131072 }, expectedHash: { anyOf: [{ type: 'string', pattern: '^[a-f0-9]{64}$' }, { type: 'null' }] } }, ['path', 'content', 'expectedHash']) },
};
export type McpInterface = 'repo-reader' | 'orchestrator' | 'managed-worker';
export function mcpToolSchemas(kind: McpInterface, descriptor: { role?: string; access?: string } = {}) {
    if (kind === 'repo-reader') return [typedTools.files, typedTools.read];
    if (kind === 'orchestrator') return [typedTools.taskStatus, typedTools.start, typedTools.cancel];
    return [typedTools.files, typedTools.read, typedTools.check, typedTools.status, ...(descriptor.role === 'writer' && descriptor.access === 'write' ? [typedTools.write] : [])];
}
async function mcp() {
    const token = process.env.NARU_PREVIEW_CAPABILITY;
    if (!token) throw new Error('MCP requires a broker-issued capability');
    if (interfaceOption !== 'repo-reader' && interfaceOption !== 'orchestrator' && interfaceOption !== 'managed-worker') throw new Error('MCP requires an explicit capability interface');
    const advertised = async () => {
        const descriptor = await callBroker(socketPath, token, '__describe', {}) as { kind?: string; role?: string; access?: string };
        if (descriptor.kind !== interfaceOption) throw new Error('MCP interface does not match its broker-issued capability');
        return mcpToolSchemas(interfaceOption, descriptor);
    };
    const operationFor = (name: string, kind: McpInterface): string | undefined => ({
        'repo-reader': { files: 'files', read: 'read' },
        orchestrator: { task_status: 'status', task_start: 'start', task_cancel: 'cancel' },
        'managed-worker': { files: 'files', read: 'read', check: 'check', status: 'status', write: 'write' },
    }[kind] as Record<string, string>)[name];
    let buffer = '', chain = Promise.resolve();
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => {
        buffer += chunk;
        if (Buffer.byteLength(buffer) > 512 * 1024) { process.stderr.write('MCP input limit exceeded\n'); process.exit(1); }
        let index;
        while ((index = buffer.indexOf('\n')) >= 0) {
            const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
            chain = chain.then(async () => {
                let message: Record<string, unknown>;
                try { const parsed: unknown = JSON.parse(line); if (!isPlainObject(parsed)) return; message = parsed; } catch { return; }
                if (message.id === undefined) return;
                let result: unknown;
                try {
                    if (message.method === 'initialize') result = { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'naru-preview', version: '0.1.0-preview' } };
                    else if (message.method === 'ping') result = {};
                    else if (message.method === 'tools/list') {
                        result = { tools: await advertised() };
                        if (process.env.NARU_PREVIEW_MCP_READY_FILE) await writeFile(process.env.NARU_PREVIEW_MCP_READY_FILE, 'ready\n', { mode: 0o600 });
                    }
                    else if (message.method === 'tools/call') {
                        const params = message.params;
                        if (!isPlainObject(params) || typeof params.name !== 'string' || !isPlainObject(params.arguments)) throw new Error('Invalid typed tool call');
                        const available = await advertised();
                        if (!available.some(tool => tool.name === params.name)) throw new Error('Unknown tool for this capability');
                        const operation = operationFor(params.name, interfaceOption);
                        if (!operation) throw new Error('Unknown tool for this capability');
                        try {
                            const value = await callBroker(socketPath, token, operation, params.arguments);
                            result = { content: [{ type: 'text', text: JSON.stringify(value) }] };
                        } catch (error) { result = { isError: true, content: [{ type: 'text', text: error instanceof Error ? error.message : 'Broker request failed' }] }; }
                    } else { process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Method not found' } }) + '\n'); return; }
                    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }) + '\n');
                } catch (error) { process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code: -32602, message: error instanceof Error ? error.message.slice(0, 512) : 'Invalid request' } }) + '\n'); }
            });
        }
    });
}
async function main() {
    const command = args.shift();
    if (command === 'enroll' && args.some(value => value === '--model' || value.startsWith('--model='))) throw new Error('--model no longer creates repository worker overrides. Run "oc2 naru configure" to edit the global worker models, then rerun "oc2 naru enroll PATH [--access inspect|check|write]" without --model.');
    if (!command || command === 'configure') { if (args.length) throw new Error(`${command ?? 'naru'} does not accept arguments`); await runWizard(command === 'configure'); return; }
    if (command === 'execute') {
        const file = args.shift(); if (!file) throw new Error('Missing attempt specification');
        process.on('disconnect', () => { stopPreviewProcesses(); process.exit(1); });
        process.on('SIGTERM', () => { stopPreviewProcesses(); process.exit(1); });
        const value = JSON.parse(await readFile(file, 'utf8'));
        const server = await startPreviewServer(value.executable, value.cwd, value.env);
        try {
            const result = await nodeSpawner(server.env)([value.executable, ...value.argv.filter((arg: string) => arg !== '--standalone'), '--server', server.url], { cwd: value.cwd, timeout: 15 * 60 * 1000, maxBytes: 512 * 1024 });
            process.stdout.write(result.stdout); process.exitCode = result.ok ? 0 : 1;
        } finally { server.stop(); }
        process.removeAllListeners('disconnect');
        if (process.connected) process.disconnect(); return;
    }
    if (command === 'setup') {
        const executable = option('--opencode'); if (!executable || args.length) throw new Error('setup requires --opencode /absolute/path/to/the/pinned/native/binary');
        if (process.versions.node.split('.')[0] !== '24') throw new Error('Run setup with Node 24');
        await privateRoot();
        try { await lstat(join(root, 'host.json')); throw new Error('Preview is already installed; stop it and use a fresh --root for a new build'); } catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error; }
        const binary = await realpath(executable);
        const binaryBytes = await readFile(binary);
        if (!['cffaedfe', 'feedfacf', 'cafebabe', '7f454c46'].includes(binaryBytes.subarray(0, 4).toString('hex'))) throw new Error('Use the native binary, not a wrapper that can override profile isolation');
        const config: PreviewHost = { root, executable: binary, executableHash: digest(binaryBytes), node: await realpath(process.execPath), cli: join(root, 'lib', 'tools', 'naru-preview.mjs') };
        const env = hostEnvironment(config, 'setup');
        for (const key of ['HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'XDG_STATE_HOME', 'TMPDIR']) await mkdir(env[key]!, { recursive: true, mode: 0o700 });
        const result = await nodeSpawner(env)([binary, '--version'], { cwd: root, timeout: 10000 });
        if (!result.ok || evaluateOpenCodeVersion('v2-beta-exploratory', result.stdout).status !== 'supported') throw new Error(`Preview requires the exact native OpenCode ${PREVIEW_VERSION} binary`);
        await cp(dirname(fileURLToPath(import.meta.url)), join(root, 'lib', 'tools'), { recursive: true });
        await writeFile(join(root, 'admin'), randomBytes(32).toString('hex'), { mode: 0o600, flag: 'wx' });
        await writePrivateJson(join(root, 'host.json'), config);
        const quote = (s: string) => "'" + s.replaceAll("'", "'\\''") + "'";
        await writeFile(join(root, 'naru-preview'), `#!/bin/sh\nexec ${quote(config.node)} ${quote(config.cli)} --root ${quote(root)} "$@"\n`, { mode: 0o755 });
        console.log(`Installed isolated preview: ${join(root, 'naru-preview')}\nConfigure global worker models, and optionally reference a global instructions file, with: naru-preview configure\nNo personal instructions file is configured automatically.\nFor scripts, enroll a Git repository or ordinary directory with its access policy; every workspace uses that global pool.\nThen: naru-preview open PATH`); return;
    }
    if (command === 'mcp') { await mcp(); return; }
    if (command === 'daemon') {
        const inheritedGuard = process.env.NARU_PREVIEW_GUARD_TOKEN;
        const daemonGuard = inheritedGuard ? undefined : await acquirePreviewUpdateGuard(root);
        if (inheritedGuard) await assertPreviewUpdateGuard(root, inheritedGuard);
        const config = await host(), broker = new PreviewBroker(config, await admin(), { home: homedir() }); await broker.load();
        const server = createServer((request, response) => {
            if (request.method !== 'POST' || request.url !== '/') { response.writeHead(404).end(); return; }
            let body = '', bytes = 0;
            request.on('data', chunk => { bytes += chunk.length; if (bytes > 256 * 1024) request.destroy(); else body += chunk; });
            request.on('end', () => { void broker.serial(async () => {
                try {
                    const value = JSON.parse(body);
                    if (!isPlainObject(value) || typeof value.token !== 'string' || typeof value.operation !== 'string') throw new Error('Invalid request');
                    const result = await broker.request(value.token, value.operation, value.input);
                    response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ result }));
                    if (value.operation === 'stop' && isPlainObject(result) && result.stopped === true) { server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 1000).unref(); }
                } catch (error) { response.end(JSON.stringify({ error: error instanceof Error ? error.message : 'Broker request failed' })); }
            }); });
        });
        server.on('error', error => { process.stderr.write(error.message + '\n'); process.exitCode = 1; });
        server.listen(socketPath, async () => { const { chmod } = await import('node:fs/promises'); await chmod(socketPath, 0o600); await writeFile(join(root, 'daemon.pid'), String(process.pid), { mode: 0o600 }); if (daemonGuard) await daemonGuard.release(); });
        const stop = () => { broker.shutdown(); server.close(() => { process.exit(0); }); setTimeout(() => process.exit(0), 1000).unref(); };
        process.on('SIGTERM', stop); process.on('SIGINT', stop); return;
    }
    if (command === 'auth' || command === 'models') {
        const guard = await acquirePreviewUpdateGuard(root);
        try {
            const config = await host(), env = await catalogueEnvironment(config);
            if (digest(await readFile(config.executable)) !== config.executableHash) throw new Error('Pinned OpenCode binary changed; revalidate before authentication');
            const help = args.includes('--help') || args.includes('-h');
            assertNoPrivateConnectionFlags(args);
            if (command === 'models' && !help) {
                const check = option('--check');
                const search = option('--search');
                if (check && search) throw new Error('models accepts either --check REF or --search NAME, not both');
                const refreshIndex = args.indexOf('--refresh');
                if (refreshIndex >= 0) {
                    args.splice(refreshIndex, 1);
                    if (args.length) throw new Error('models --refresh accepts only an optional --check REF or --search NAME');
                    const refreshed = await refreshCatalogue(config, process.cwd());
                    const diagnosticQuery = check ?? search, diagnostic = diagnosticQuery ? catalogueDiagnostic(diagnosticQuery, !!check, refreshed.catalogue, (await readManagedModelFeed(refreshed.source)).entries) : undefined;
                    console.log(JSON.stringify({ source: { digest: refreshed.source.digest, bytes: refreshed.source.bytes, requestedAt: refreshed.source.requestedAt, completedAt: refreshed.source.completedAt, outcome: refreshed.source.outcome, upstreamFreshness: 'unknown', accountAccess: 'unknown' }, observedAt: refreshed.catalogue.observedAt, eligibleModels: refreshed.catalogue.models.length, ...(diagnostic ? { diagnostic } : {}) }, null, 2)); return;
                }
                if (check || search) {
                    if (args.length) throw new Error(check ? 'models --check requires exactly one provider/model reference' : 'models --search requires exactly one bounded name query');
                    const catalogue = await observeCatalogue(config, process.cwd()), source = await loadManagedModelSource(root);
                    console.log(JSON.stringify(catalogueDiagnostic((check ?? search)!, !!check, catalogue, source ? (await readManagedModelFeed(source)).entries : []), null, 2)); return;
                }
                const output = modelsOutput(await runModelsListing(config.executable, root, env, args));
                process.stdout.write(output.stdout); process.stderr.write(output.stderr); process.exitCode = output.exitCode; return;
            }
            if (command === 'auth' && args[0] === 'login' && !help) {
                await guard.release(); await runAuthentication(args); return;
            }
            process.exitCode = await waitForChild(spawn(config.executable, [command, ...args, ...(help ? [] : ['--standalone'])], { cwd: root, env, stdio: 'inherit' })); return;
        } finally { await guard.release(); }
    }
    if (command === 'help' || command === '--help') {
        console.log('Naru runtime: [configure] | setup --opencode PATH | enroll PATH [--access inspect|check|write] [--write scope] | open PATH | auth login | models [--refresh] [--check REF|--search NAME] | status | stop | cancel TASK | integrate TASK\nBare "oc2" and "oc2 naru" start the same interactive workspace wizard. Use "oc2 naru configure" for the global worker pool or an optional read-only global instructions reference. PATH may be a Git repository or ordinary directory. Directory writers apply scoped changes directly, one atomic file at a time, without rollback or integration. Model refresh is explicit and publishes a normalized immutable official-feed snapshot only after a clean native baseline/candidate differential metadata proof. Each preview root is independent. The host model is always chosen by the user; policy models are worker-only. No commits, pushes, or delivery operations are available.'); return;
    }
    if (command === 'stop') { await privateRoot(false); console.log(JSON.stringify(await stopBroker(socketPath, await admin()))); return; }
    if (command === 'open') {
        const path = args.shift(); if (!path || args.length) throw new Error('open requires an enrolled workspace path');
        await openRepository(resolve(path)); return;
    }
    await ensureDaemon(); const token = await admin();
    if (command === 'enroll') {
        const scope = option('--write'), requestedAccess = option('--access'), useGlobalIndex = args.indexOf('--use-global');
        if (useGlobalIndex >= 0) args.splice(useGlobalIndex, 1);
        const path = args.shift();
        if (!path || args.length) throw new Error('enroll requires PATH [--access inspect|check|write] [--write scope]');
        const access = requestedAccess ?? (scope ? 'write' : 'check');
        if (!['inspect', 'check', 'write'].includes(access) || (scope && access !== 'write')) throw new Error('--write requires --access write; access must be inspect, check, or write');
        const setup = await callBroker(socketPath, token, 'setup-status', { path: resolve(path) }) as PreviewSetupStatus;
        if (!setup.repository) throw new Error(setup.blockers.join('; ') || 'enroll PATH must be an existing directory');
        if (!setup.globalProfile) throw new Error('Global worker models are not configured; run "oc2 naru configure" in a TTY before enrolling workspaces');
        console.log(JSON.stringify(await callBroker(socketPath, token, 'enroll', { path: setup.repository.path, kind: setup.repository.kind, access, writeScopes: scope ? scope.split(',') : [], expectedRevision: setup.repository.enrollment?.revision ?? null, expectedGlobalRevision: setup.globalProfile.revision }), null, 2)); return;
    }
    if (command === 'status') { console.log(JSON.stringify(await callBroker(socketPath, token, 'status'), null, 2)); return; }
    const id = args.shift(); if (!id || args.length) throw new Error(`${command} requires a task ID`);
    if (command === 'cancel') { console.log(JSON.stringify(await callBroker(socketPath, token, 'cancel', { id }), null, 2)); return; }
    if (command === 'integrate') {
        if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error('Integration requires the Naru-owned interactive terminal confirmation');
        const bundle = await callBroker(socketPath, token, 'bundle', { id }) as { digest?: string; mode?: string };
        console.log(JSON.stringify(bundle, null, 2));
        if (bundle.mode === 'direct') return;
        if (!bundle.digest) throw new Error('Writer bundle did not include a confirmation digest');
        const terminal = createInterface({ input: process.stdin, output: process.stdout });
        try {
            const answer = await terminal.question(`Apply exactly this bundle to the enrolled working tree? Type ${bundle.digest}: `);
            if (answer !== bundle.digest) throw new Error('No changes applied');
            console.log(JSON.stringify(await callBroker(socketPath, token, 'integrate', { id, digest: bundle.digest }), null, 2));
        } finally { terminal.close(); }
        return;
    }
    throw new Error('Unknown preview command');
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    main().catch(error => { process.stderr.write(`naru-preview: ${error instanceof Error ? error.message : 'Failed'}\n`); process.exitCode = 1; });
}
