#!/usr/bin/env node
import { createServer, request as httpRequest } from 'node:http';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { cp, lstat, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { PreviewBroker, digest, writePrivateJson } from './naru-lib/preview-broker.mjs';
import { PREVIEW_VERSION, hostEnvironment, type PreviewHost } from './naru-lib/preview-host.mjs';
import { cleanProcessEnvironment, nodeSpawner, startPreviewServer, stopPreviewProcesses } from './naru-lib/preview-process.mjs';
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
        diagnostic('OpenCode catalogue is ready, but no models are available in this isolated preview profile; check the provider connection');
        return { stdout: '', stderr, exitCode: 1 };
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
async function ensureDaemon() {
    const config = await host(), token = await admin();
    try { await callBroker(socketPath, token, 'status'); return; } catch (error) {
        if (!(error instanceof Error && 'code' in error && ['ENOENT', 'ECONNREFUSED'].includes(String(error.code)))) throw error;
    }
    const lock = join(root, 'start.lock');
    try { await mkdir(lock, { mode: 0o700 }); } catch { throw new Error('Another preview start is in progress; retry after it completes'); }
    try {
        try { await callBroker(socketPath, token, 'status'); return; } catch (error) {
            if (!(error instanceof Error && 'code' in error && ['ENOENT', 'ECONNREFUSED'].includes(String(error.code)))) throw error;
        }
        try { const info = await lstat(socketPath); if (!info.isSocket()) throw new Error('Unsafe broker socket path'); await rm(socketPath); } catch (error) {
            if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
        }
        const child = spawn(config.node, [config.cli, 'daemon', '--root', root], { detached: true, stdio: 'ignore', env: cleanProcessEnvironment(config.node) });
        child.unref();
        for (let attempt = 0; attempt < 100; attempt++) {
            await new Promise(resolvePromise => setTimeout(resolvePromise, 50));
            try { await callBroker(socketPath, token, 'status'); return; } catch { /* Startup is bounded. */ }
        }
        throw new Error('Broker did not start; run naru-preview daemon in the foreground to inspect the error');
    } finally { await rm(lock, { recursive: true, force: true }); }
}
const toolSchema = {
    name: 'broker', description: 'Naru durable local broker. status reports repository policy/tasks. start requires a unique requestId, leaf role, exact allowlisted provider/model, and prompt. files lists safe relative paths (optional contains); read returns text and sha256; write takes path, content, expectedHash (null only for new files); check takes argv and runs in a disposable sandbox without dependency directories such as node_modules and never installs dependencies. cancel takes id. Permissions depend on your broker-issued capability. Neither MCP metadata nor supplied role claims authorize a mutation. Integration and delivery are not exposed.',
    inputSchema: { type: 'object', properties: { operation: { type: 'string', enum: ['status', 'start', 'cancel', 'files', 'read', 'write', 'check'] }, input: { type: 'object' } }, required: ['operation', 'input'], additionalProperties: false },
};
async function mcp() {
    const token = process.env.NARU_PREVIEW_CAPABILITY;
    if (!token) throw new Error('MCP requires a broker-issued capability');
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
                    else if (message.method === 'tools/list') result = { tools: [toolSchema] };
                    else if (message.method === 'tools/call') {
                        const params = message.params;
                        if (!isPlainObject(params) || params.name !== 'broker' || !isPlainObject(params.arguments) || typeof params.arguments.operation !== 'string') throw new Error('Invalid broker tool call');
                        try {
                            const value = await callBroker(socketPath, token, params.arguments.operation, params.arguments.input);
                            result = { content: [{ type: 'text', text: JSON.stringify(value) }] };
                        } catch (error) { result = { isError: true, content: [{ type: 'text', text: error instanceof Error ? error.message : 'Broker request failed' }] }; }
                    } else { process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Method not found' } }) + '\n'); return; }
                    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }) + '\n');
                } catch { process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code: -32602, message: 'Invalid request' } }) + '\n'); }
            });
        }
    });
}
async function main() {
    const command = args.shift();
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
        console.log(`Installed isolated preview: ${join(root, 'naru-preview')}\nAuthenticate with: naru-preview auth login\nEnroll a clean repository with: naru-preview enroll PATH --model provider/model --write 'src/**'\nThen: naru-preview open PATH`); return;
    }
    if (command === 'mcp') { await mcp(); return; }
    if (command === 'daemon') {
        const config = await host(), broker = new PreviewBroker(config, await admin()); await broker.load();
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
        server.listen(socketPath, async () => { const { chmod } = await import('node:fs/promises'); await chmod(socketPath, 0o600); await writeFile(join(root, 'daemon.pid'), String(process.pid), { mode: 0o600 }); });
        const stop = () => { broker.shutdown(); server.close(() => { process.exit(0); }); setTimeout(() => process.exit(0), 1000).unref(); };
        process.on('SIGTERM', stop); process.on('SIGINT', stop); return;
    }
    if (command === 'auth' || command === 'models') {
        const config = await host(), env = hostEnvironment(config, 'setup');
        if (digest(await readFile(config.executable)) !== config.executableHash) throw new Error('Pinned OpenCode binary changed; revalidate before authentication');
        const help = args.includes('--help') || args.includes('-h');
        assertNoPrivateConnectionFlags(args);
        if (command === 'models' && !help) {
            const output = modelsOutput(await runModelsListing(config.executable, root, env, args));
            process.stdout.write(output.stdout); process.stderr.write(output.stderr); process.exitCode = output.exitCode; return;
        }
        if (command === 'auth' && args[0] === 'login' && !help) {
            const server = await startPreviewServer(config.executable, root, env, 'auth');
            const child = spawn(config.executable, [command, ...args, '--server', server.url], { cwd: root, env: server.env, stdio: 'inherit' });
            await new Promise<void>(resolvePromise => {
                let settled = false;
                const stop = () => { child.kill('SIGTERM'); server.stop(); process.exitCode = 1; };
                const finish = (code: number | null) => { if (settled) return; settled = true; process.removeListener('SIGTERM', stop); process.removeListener('SIGINT', stop); server.stop(); process.exitCode = code ?? 1; resolvePromise(); };
                process.once('SIGTERM', stop); process.once('SIGINT', stop);
                child.once('error', () => { process.stderr.write('OpenCode authentication could not start\n'); finish(null); });
                child.once('exit', finish);
            });
            return;
        }
        const child = spawn(config.executable, [command, ...args, ...(help ? [] : ['--standalone'])], { cwd: root, env, stdio: 'inherit' });
        child.on('error', () => { process.stderr.write('OpenCode authentication could not start\n'); process.exitCode = 1; });
        child.on('exit', code => { process.exitCode = code ?? 1; }); return;
    }
    if (!command || command === 'help' || command === '--help') {
        console.log('Naru local preview: setup --opencode PATH | enroll PATH --model provider/model [--write scope] | open PATH | auth login | models | status | stop | cancel TASK | integrate TASK\nEach preview root is independent. Workers use exact allowlisted models. No commits, pushes, or delivery operations are available.'); return;
    }
    if (command === 'stop') { await privateRoot(false); console.log(JSON.stringify(await stopBroker(socketPath, await admin()))); return; }
    await ensureDaemon(); const token = await admin();
    if (command === 'enroll') {
        const model = option('--model'), scope = option('--write'), path = args.shift();
        if (!path || !model || args.length) throw new Error('enroll requires PATH --model provider/model [--write scope]');
        console.log(JSON.stringify(await callBroker(socketPath, token, 'enroll', { path: resolve(path), models: model.split(','), writeScopes: scope ? scope.split(',') : [] }), null, 2)); return;
    }
    if (command === 'open') {
        const path = args.shift(); if (!path || args.length) throw new Error('open requires an enrolled repository path');
        const config = await host(); const profile = await callBroker(socketPath, token, 'open', { path: resolve(path) }) as { cwd: string; env: NodeJS.ProcessEnv };
        const server = await startPreviewServer(config.executable, profile.cwd, profile.env);
        const child = spawn(config.executable, ['--server', server.url], { cwd: profile.cwd, env: server.env, stdio: 'inherit' });
        const stop = () => { child.kill('SIGTERM'); server.stop(); };
        process.once('SIGTERM', stop); process.once('SIGINT', stop);
        child.on('error', () => { server.stop(); process.exitCode = 1; });
        child.on('exit', code => { server.stop(); process.exitCode = code ?? 1; }); return;
    }
    if (command === 'status') { console.log(JSON.stringify(await callBroker(socketPath, token, 'status'), null, 2)); return; }
    const id = args.shift(); if (!id || args.length) throw new Error(`${command} requires a task ID`);
    if (command === 'cancel') { console.log(JSON.stringify(await callBroker(socketPath, token, 'cancel', { id }), null, 2)); return; }
    if (command === 'integrate') {
        if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error('Integration requires the Naru-owned interactive terminal confirmation');
        const bundle = await callBroker(socketPath, token, 'bundle', { id }) as { digest: string };
        console.log(JSON.stringify(bundle, null, 2));
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
