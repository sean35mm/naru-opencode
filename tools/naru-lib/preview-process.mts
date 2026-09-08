import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { cp, lstat, mkdir, mkdtemp, readlink, realpath, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { Spawn } from './transport.mjs';
import { isSafeRelativePath } from './validate.mjs';

const active = new Set<number>();
export type PreviewReadinessMode = 'mcp' | 'auth' | 'catalogue';
export interface PreviewReadinessTiming { deadlineMs?: number; requestTimeoutMs?: number; pollIntervalMs?: number }
export function stopPreviewProcesses() { for (const pid of active) { try { process.kill(-pid, 'SIGKILL'); } catch {} } }

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
function contains(root: string, value: string): boolean {
    const path = relative(root, value);
    return path === '' || (path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}
export async function runtimeReadRoot(node: string): Promise<string> {
    if (!isAbsolute(node)) throw new Error('Node runtime path must be absolute');
    const canonicalNode = await realpath(node);
    const root = await realpath(dirname(dirname(canonicalNode)));
    const home = await realpath(homedir()).catch(() => resolve(homedir()));
    const broadRoots = new Set(['/', '/Applications', '/Library', '/System', '/Users', '/Volumes', '/bin', '/opt', '/private', '/private/tmp', '/private/var', '/sbin', '/tmp', '/usr', '/usr/local', '/var']);
    if (!contains(root, canonicalNode) || broadRoots.has(root) || contains(root, home)) {
        throw new Error('Node runtime read root is too broad for isolated checks');
    }
    return root;
}
export async function copyVerificationSnapshot(directory: string, snapshot: string): Promise<void> {
    let files = 0, bytes = 0;
    await cp(directory, snapshot, { recursive: true, dereference: false, verbatimSymlinks: true, filter: async source => {
        const file = relative(directory, source);
        if (file) {
            const parts = file.split(sep);
            if (parts.includes('node_modules') || !isSafeRelativePath(file)) return false;
        }
        const info = await lstat(source);
        if (++files > 50000 || (bytes += info.isFile() ? info.size : 0) > 512 * 1024 * 1024) throw new Error('Verification snapshot exceeds preview limits');
        if (info.isSymbolicLink()) {
            const link = await readlink(source);
            const target = await realpath(source).catch(() => '');
            const targetPath = relative(directory, target);
            return !isAbsolute(link) && contains(directory, target) && isSafeRelativePath(targetPath);
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
    try { return await response.json(); } catch { throw new Error(`${message}: malformed response`); }
}
const authMethodTypes = new Set(['command', 'env', 'key', 'oauth']);
const interactiveAuthMethodTypes = new Set(['command', 'key', 'oauth']);
export async function waitForPreviewReadiness(url: string, cwd: string, headers: Record<string, string>, mode: PreviewReadinessMode, timing: PreviewReadinessTiming = {}): Promise<void> {
    const deadline = Date.now() + (timing.deadlineMs ?? 20000);
    const requestTimeoutMs = timing.requestTimeoutMs ?? 5000;
    const pollIntervalMs = timing.pollIntervalMs ?? 200;
    if (mode === 'catalogue') {
        let response: Response;
        try {
            response = await fetch(readinessUrl(url, '/api/plugin/await-activation', cwd), { method: 'POST', headers, signal: requestSignal(deadline, requestTimeoutMs) });
        } catch (error) {
            if (error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError')) throw new Error('OpenCode catalogue activation timed out');
            throw new Error('OpenCode catalogue activation failed');
        }
        await response.body?.cancel();
        if (response.status !== 204) throw new Error(`OpenCode catalogue activation failed (${response.status})`);
        return;
    }
    if (mode === 'auth') {
        try {
            // Remote auth commands use the server's startup directory and do not send a location override.
            const response = await fetch(url + '/api/model/default', { headers, signal: requestSignal(deadline, requestTimeoutMs) });
            await response.body?.cancel();
        } catch { /* This endpoint is only a catalogue activation hint. */ }
        while (Date.now() < deadline) {
            const response = await fetch(url + '/api/integration', { headers, signal: requestSignal(deadline, requestTimeoutMs) });
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
    let connected = false;
    for (let attempt = 0; attempt < 100 && Date.now() < deadline; attempt++) {
        const response = await fetch(readinessUrl(url, '/api/mcp', cwd), { headers, signal: requestSignal(deadline, requestTimeoutMs) });
        const value = await responseJson(response, 'Private OpenCode readiness failed') as { data?: Array<{ name: string; status: { status: string; error?: string } }> };
        const server = value.data?.find(item => item.name === 'naru');
        if (server?.status.status === 'failed') throw new Error('Naru MCP failed to connect');
        if (server?.status.status === 'connected') {
            // This pinned beta debounces MCP tool registration for 100ms after connection.
            // Require two connected observations across that registration interval.
            if (connected) return;
            connected = true;
        } else connected = false;
        await new Promise(resolve => setTimeout(resolve, Math.min(pollIntervalMs, Math.max(0, deadline - Date.now()))));
    }
    throw new Error('Naru MCP readiness timed out');
}
export async function startPreviewServer(executable: string, cwd: string, environment: NodeJS.ProcessEnv, readiness: PreviewReadinessMode = 'mcp', timing: PreviewReadinessTiming = {}) {
    const password = randomBytes(32).toString('hex');
    const env = { ...environment, OPENCODE_PASSWORD: password };
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
        await waitForPreviewReadiness(url, cwd, headers, readiness, timing);
        return { url, env, stop };
    } catch (error) { stop(); throw error; }
}
export async function isolatedCheck(directory: string, argv: string[], node: string, scratchRoot: string) {
    if (process.platform !== 'darwin') throw new Error('Isolated checks are unavailable: this platform has not passed containment certification');
    if (!Array.isArray(argv) || argv.length === 0 || argv.length > 64 || argv.some(arg => typeof arg !== 'string' || arg.length > 8192 || arg.includes('\0'))) throw new Error('Invalid check argv');
    await mkdir(scratchRoot, { recursive: true, mode: 0o700 });
    const temporary = await realpath(await mkdtemp(join(scratchRoot, 'check-')));
    const snapshot = join(temporary, 'workspace');
    try {
        await copyVerificationSnapshot(directory, snapshot);
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
