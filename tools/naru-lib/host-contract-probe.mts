import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { constants as fsConstants } from 'node:fs';
import { cp, lstat, mkdir, open, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { createServer as createHttpServer } from 'node:http';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';

type UnknownRecord = Record<string, unknown>;
export const HOST_CONTRACT_TIMEOUT_MS = 30_000;
const MAX_OUTPUT_BYTES = 64 * 1024;
const MAX_API_BYTES = 64 * 1024;
const TERMINATION_GRACE_MS = 1_000;

export const HOST_CONTRACT_LIMITATION = 'Bounded OpenCode scheduling with a loopback synthetic provider; no external provider, credentials, account, approval response, or MCP tool execution';

export interface BoundedProcessResult {
    durationMs: number;
    output: string;
    stdout: string;
    status: 'passed' | 'failed';
    reason: string | null;
}

export interface BoundedProcessOptions {
    cwd: string;
    env: NodeJS.ProcessEnv;
    maxOutputBytes?: number;
    retainOutput?: boolean;
    timeoutMs?: number;
}

export interface HostPermissionObservation {
    agent: string;
    action: string;
    effect: 'allow' | 'ask' | 'deny';
}

export interface HostContractResult {
    status: 'passed' | 'failed';
    diagnostic: string | null;
    observations: HostPermissionObservation[];
}

function isRecord(value: unknown): value is UnknownRecord {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function errorCode(error: unknown): string | undefined {
    return error instanceof Error && 'code' in error && typeof error.code === 'string' ? error.code : undefined;
}

function validateTimeout(value: unknown): number {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 50 || value > 30_000) {
        throw new Error('timeout must be from 50 to 30000 milliseconds');
    }
    return value;
}

function validateOutputLimit(value: unknown): number {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < MAX_OUTPUT_BYTES || value > 1024 * 1024) {
        throw new Error(`output limit must be from ${MAX_OUTPUT_BYTES} to ${1024 * 1024} bytes`);
    }
    return value;
}

function waitForExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
    if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
    return new Promise(resolvePromise => {
        const timer = setTimeout(() => {
            child.removeListener('exit', onExit);
            resolvePromise(false);
        }, timeoutMs);
        function onExit() {
            clearTimeout(timer);
            resolvePromise(true);
        }
        child.once('exit', onExit);
    });
}

export function signalProcessGroup(child: ChildProcess, signal: NodeJS.Signals): void {
    try {
        if (child.pid === undefined) return;
        process.kill(-child.pid, signal);
    }
    catch {
        try { child.kill(signal); } catch { /* The process already exited. */ }
    }
}

export async function stopProcessGroup(child: ChildProcess): Promise<void> {
    signalProcessGroup(child, 'SIGTERM');
    if (await waitForExit(child, TERMINATION_GRACE_MS)) return;
    signalProcessGroup(child, 'SIGKILL');
    await waitForExit(child, 250);
}

export async function runBoundedProcess(executable: string, args: readonly string[], {
    cwd, env, maxOutputBytes = MAX_OUTPUT_BYTES, retainOutput = true, timeoutMs = HOST_CONTRACT_TIMEOUT_MS,
}: BoundedProcessOptions): Promise<BoundedProcessResult> {
    validateTimeout(timeoutMs);
    validateOutputLimit(maxOutputBytes);
    const started = Date.now();
    let output = Buffer.alloc(0);
    let stdout = Buffer.alloc(0);
    let outputBytes = 0;
    let overflow = false;
    let spawnError = false;
    const child = spawn(executable, args, { cwd, detached: true, env, stdio: ['ignore', 'pipe', 'pipe'] });
    const append = (chunk: Buffer) => {
        if (overflow) return;
        outputBytes += chunk.length;
        if (retainOutput) output = Buffer.concat([output, chunk]).subarray(0, maxOutputBytes);
        if (outputBytes > maxOutputBytes) {
            overflow = true;
            signalProcessGroup(child, 'SIGTERM');
        }
    };
    child.stdout.on('data', (chunk: Buffer) => {
        if (retainOutput && !overflow) stdout = Buffer.concat([stdout, chunk]).subarray(0, maxOutputBytes);
        append(chunk);
    });
    child.stderr.on('data', append);
    const exited = new Promise<boolean>(resolvePromise => {
        child.once('error', () => { spawnError = true; resolvePromise(false); });
        child.once('close', code => resolvePromise(code === 0));
    });
    let timedOut = false;
    let timer: NodeJS.Timeout | undefined;
    const successful = await Promise.race([
        exited,
        new Promise<boolean>(resolvePromise => {
            timer = setTimeout(() => { timedOut = true; resolvePromise(false); }, timeoutMs);
        }),
    ]);
    if (timer) clearTimeout(timer);
    if (timedOut || overflow || spawnError) await stopProcessGroup(child);
    return {
        durationMs: Date.now() - started,
        output: output.toString('utf8'),
        stdout: stdout.toString('utf8'),
        status: successful && !timedOut && !overflow && !spawnError ? 'passed' : 'failed',
        reason: timedOut ? 'timeout' : overflow ? 'output-limit' : spawnError ? 'spawn-failed' : successful ? null : 'nonzero-exit',
    };
}

export function coreConfigContractFailures(value: unknown): string[] {
    if (!isRecord(value) || !isRecord(value.agent)) return ['config-agent-map-missing'];
    const agents = value.agent;
    const orchestrator = agents['naru-orchestrator'];
    if (!isRecord(orchestrator) || orchestrator.mode !== 'primary' || !isRecord(orchestrator.permission)) return ['orchestrator-contract-invalid'];
    const task = orchestrator.permission.task;
    if (!isRecord(task) || task['*'] !== 'deny') return ['orchestrator-task-boundary-invalid'];
    if (typeof orchestrator.prompt !== 'string' || !orchestrator.prompt.includes('Effective defaults: profile=release-critical; decision=comment-only; output=concise.')) return ['review-defaults-missing'];
    const failures: string[] = [];
    for (const role of ['naru-reader', 'naru-runner', 'naru-writer']) {
        const base = agents[role];
        const variant = agents[`${role}-smoke`];
        if (!isRecord(base) || !isRecord(base.permission) || base.mode !== 'subagent' || task[role] !== 'allow') {
            failures.push(`${role}:base-contract-invalid`);
            continue;
        }
        if (base.permission['*'] !== 'deny' || base.permission.task !== 'deny' || base.permission.edit !== (role === 'naru-writer' ? 'allow' : 'deny')) failures.push(`${role}:native-boundary-changed`);
        if (role === 'naru-runner' && (base.permission.bash !== 'deny' || base.permission['naru-check'] !== 'allow')) failures.push('naru-runner:bash-boundary-changed');
        if (!isRecord(variant) || variant.model !== 'openai/naru-compat-fixture' || variant.variant !== 'high' || task[`${role}-smoke`] !== 'allow') failures.push(`${role}:variant-contract-invalid`);
    }
    return failures;
}

export function validateCoreConfigContract(value: unknown): boolean {
    return coreConfigContractFailures(value).length === 0;
}

export async function writeHostContractFixtures(globalRoot: string, projectRoot: string): Promise<string> {
    await mkdir(globalRoot, { recursive: true, mode: 0o700 });
    await mkdir(projectRoot, { recursive: true, mode: 0o700 });
    const marker = path.join(path.dirname(projectRoot), 'tool-called');
    const server = path.join(path.dirname(projectRoot), 'synthetic-mcp.mjs');
    await writeFile(server, `import { writeFileSync } from 'node:fs';
let buffered = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  buffered += chunk;
  for (;;) {
    const newline = buffered.indexOf('\\n');
    if (newline < 0) break;
    const line = buffered.slice(0, newline).trim();
    buffered = buffered.slice(newline + 1);
    if (!line) continue;
    let request;
    try { request = JSON.parse(line); } catch { continue; }
    if (request.id === undefined) continue;
    if (request.method === 'tools/call') writeFileSync(${JSON.stringify(marker)}, 'called');
    const result = request.method === 'initialize'
      ? { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'naru-contract-fixture', version: '1.0.0' } }
      : request.method === 'tools/list'
        ? { tools: [{ name: 'read', description: 'Synthetic local contract tool', inputSchema: { type: 'object', properties: {} } }, { name: 'delete', description: 'Synthetic denied contract tool', inputSchema: { type: 'object', properties: {} } }] }
        : request.method === 'tools/call' ? { content: [{ type: 'text', text: 'called' }] } : {};
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\\n');
  }
});
`, { mode: 0o600 });
    const local = { type: 'local', command: [process.execPath, server] };
    await writeFile(path.join(globalRoot, 'opencode.json'), `${JSON.stringify({
        mcp: { 'safe.tools': local, 'override-me': local, codebase: local },
    })}\n`, { mode: 0o600 });
    await writeFile(path.join(projectRoot, 'opencode.json'), `${JSON.stringify({
        mcp: { 'override-me': { ...local, enabled: false } },
    })}\n`, { mode: 0o600 });
    await mkdir(path.join(globalRoot, 'plugins'), { recursive: true, mode: 0o700 });
    await writeFile(path.join(globalRoot, 'plugins', 'z-naru-contract-fixture.js'), `export default async () => ({
  config: async config => {
    for (const name of ['naru-orchestrator', 'naru-writer', 'naru-writer-smoke']) {
      const permission = config.agent?.[name]?.permission;
      if (permission && typeof permission === 'object') permission.safe_tools_delete = 'deny';
    }
  },
});
`, { mode: 0o600 });
    return marker;
}

export async function stageHostContractAssets(sourceRoot: string, globalRoot: string): Promise<void> {
    const source = await realpath(sourceRoot);
    for (const relative of ['agents', 'plugins', 'tools/naru-lib']) {
        const stats = await lstat(path.join(source, relative));
        if (!stats.isDirectory() || stats.isSymbolicLink()) throw new Error(`probe source ${relative} is unsafe`);
        await cp(path.join(source, relative), path.join(globalRoot, relative), { recursive: true });
    }
    const packageMarker = path.join(source, 'tools', 'package.json');
    const markerStats = await lstat(packageMarker);
    if (!markerStats.isFile() || markerStats.isSymbolicLink()) throw new Error('probe source tools/package.json is unsafe');
    await mkdir(path.join(globalRoot, 'tools'), { recursive: true, mode: 0o700 });
    await cp(packageMarker, path.join(globalRoot, 'tools', 'package.json'));
    await writeFile(path.join(globalRoot, 'naru-runtime.json'), `${JSON.stringify({
        schemaVersion: 1,
        models: { smoke: { use: 'Local host-contract fixture; never execute', chain: ['openai/naru-compat-fixture@high'] } },
        review: { defaultProfile: 'release-critical', defaultDecision: 'comment-only', defaultOutput: 'concise' },
        mcp: { configuredTools: 'ask' },
    })}\n`, { mode: 0o600 });
}

async function availablePort(): Promise<number> {
    const server = createServer();
    await new Promise<void>((resolvePromise, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolvePromise);
    });
    const address = server.address();
    await new Promise<void>(resolvePromise => server.close(() => resolvePromise()));
    if (!address || typeof address === 'string') throw new Error('localhost-port-unavailable');
    return address.port;
}

async function boundedJsonRequest(url: string, init: RequestInit, timeoutMs: number, maxBytes = MAX_API_BYTES): Promise<{ status: number; value: unknown }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const response = await fetch(url, { ...init, signal: controller.signal });
        const bytes = Buffer.from(await response.arrayBuffer());
        if (bytes.length > maxBytes) throw new Error('host-api-output-limit');
        let value: unknown;
        try { value = bytes.length === 0 ? null : JSON.parse(bytes.toString('utf8')); }
        catch { throw new Error('host-api-invalid-json'); }
        return { status: response.status, value };
    }
    finally { clearTimeout(timer); }
}

function resolvedAgentRules(value: unknown, role: string): unknown[] | null {
    if (!Array.isArray(value)) return null;
    const variant = role.endsWith('-smoke');
    const base = variant ? role.slice(0, -'-smoke'.length) : role;
    const candidate = value.find(item => {
        if (!isRecord(item) || item.name !== base || !Array.isArray(item.permission)) return false;
        const options = isRecord(item.options) ? item.options : {};
        return variant ? options.naruVariant === true && item.variant === 'high' : options.naruVariant !== true;
    });
    return isRecord(candidate) && Array.isArray(candidate.permission) ? candidate.permission : null;
}

async function fileExists(file: string): Promise<boolean> {
    try { await lstat(file); return true; }
    catch (error) { if (errorCode(error) === 'ENOENT') return false; throw error; }
}

export async function runHostContractProbe({ executable, cwd, env, marker, timeoutMs = HOST_CONTRACT_TIMEOUT_MS }: {
    executable: string;
    cwd: string;
    env: NodeJS.ProcessEnv;
    marker: string;
    timeoutMs?: number;
}): Promise<HostContractResult> {
    validateTimeout(timeoutMs);
    const port = await availablePort();
    const providerPort = await availablePort();
    const base = `http://127.0.0.1:${port}`;
    let requestedAction = '';
    let providerRequests = 0;
    const providerServer = createHttpServer((request, response) => {
        let body = '';
        request.setEncoding('utf8');
        request.on('data', chunk => { body += chunk; });
        request.on('end', () => {
            if (body.length > MAX_API_BYTES || requestedAction.length === 0) { response.writeHead(400); response.end(); return; }
            const call = !body.includes('"function_call_output"');
            if (call) providerRequests += 1;
            const item = call
                ? { id: 'fc_contract', type: 'function_call', call_id: 'call_contract', name: requestedAction, arguments: '{}', status: 'completed' }
                : { id: 'msg_contract', type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'done', annotations: [] }], status: 'completed' };
            response.writeHead(200, { 'content-type': 'text/event-stream' });
            const send = (value: UnknownRecord) => response.write(`event: ${String(value.type)}\ndata: ${JSON.stringify(value)}\n\n`);
            send({ type: 'response.created', response: { id: 'resp_contract', object: 'response', status: 'in_progress', model: 'fixture', output: [] } });
            send({ type: 'response.output_item.added', output_index: 0, item: { ...item, ...(call ? { arguments: '' } : { content: [] }), status: 'in_progress' } });
            if (call) {
                send({ type: 'response.function_call_arguments.delta', item_id: item.id, output_index: 0, delta: '{}' });
                send({ type: 'response.function_call_arguments.done', item_id: item.id, output_index: 0, arguments: '{}' });
            }
            else {
                send({ type: 'response.content_part.added', item_id: item.id, output_index: 0, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } });
                send({ type: 'response.output_text.delta', item_id: item.id, output_index: 0, content_index: 0, delta: 'done' });
                send({ type: 'response.output_text.done', item_id: item.id, output_index: 0, content_index: 0, text: 'done' });
            }
            send({ type: 'response.output_item.done', output_index: 0, item });
            send({ type: 'response.completed', response: { id: 'resp_contract', object: 'response', status: 'completed', model: 'fixture', output: [item], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } });
            response.end();
        });
    });
    await new Promise<void>((resolvePromise, reject) => {
        providerServer.once('error', reject);
        providerServer.listen(providerPort, '127.0.0.1', resolvePromise);
    });
    const projectConfigFile = path.join(cwd, 'opencode.json');
    const projectConfig = JSON.parse(await readFile(projectConfigFile, 'utf8')) as UnknownRecord;
    projectConfig.provider = { openai: { options: { apiKey: 'local-fixture-only', baseURL: `http://127.0.0.1:${providerPort}/v1` } } };
    projectConfig.model = 'openai/gpt-5.2';
    await writeFile(projectConfigFile, `${JSON.stringify(projectConfig)}\n`, { mode: 0o600 });
    const child = spawn(executable, ['serve', '--hostname', '127.0.0.1', '--port', String(port)], {
        cwd, detached: true, env, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let outputBytes = 0;
    let overflow = false;
    let spawnFailed = false;
    const count = (chunk: Buffer) => {
        outputBytes += chunk.length;
        if (outputBytes > MAX_OUTPUT_BYTES) { overflow = true; signalProcessGroup(child, 'SIGTERM'); }
    };
    child.stdout.on('data', count);
    child.stderr.on('data', count);
    child.once('error', () => { spawnFailed = true; });
    const observations: HostPermissionObservation[] = [];
    const deadline = Date.now() + timeoutMs;
    try {
        let healthy = false;
        while (Date.now() < deadline && !overflow && !spawnFailed && child.exitCode === null) {
            try {
                const result = await boundedJsonRequest(`${base}/global/health`, {}, Math.min(500, Math.max(50, deadline - Date.now())));
                if (result.status === 200) { healthy = true; break; }
            }
            catch { /* The local host may still be starting. */ }
            await new Promise(resolve => setTimeout(resolve, 50));
        }
        if (!healthy) return { status: 'failed', diagnostic: overflow ? 'host-output-limit' : spawnFailed ? 'host-spawn-failed' : child.exitCode !== null ? 'host-early-exit' : 'host-startup-timeout', observations };
        const agentsResponse = await boundedJsonRequest(`${base}/agent?directory=${encodeURIComponent(cwd)}`, {}, Math.max(50, deadline - Date.now()), 1024 * 1024);
        const resolvedAgents = agentsResponse.value;
        if (agentsResponse.status !== 200 || !Array.isArray(resolvedAgents)) {
            return { status: 'failed', diagnostic: 'host-resolved-agent-contract-missing', observations };
        }
        const rules = new Map<string, unknown[]>();
        for (const role of ['naru-orchestrator', 'naru-writer', 'naru-writer-smoke', 'naru-reader', 'naru-runner', 'naru-reader-smoke', 'naru-runner-smoke']) {
            const permission = resolvedAgentRules(resolvedAgents, role);
            if (permission === null) return { status: 'failed', diagnostic: `host-agent-permissions-missing:${role}`, observations };
            rules.set(role, permission);
        }
        const hasRule = (role: string, permission: string, action: string) => rules.get(role)?.some(rule => isRecord(rule) && rule.permission === permission && rule.action === action) === true;
        for (const role of ['naru-orchestrator', 'naru-writer', 'naru-writer-smoke']) {
            if (!hasRule(role, 'safe_tools_*', 'ask') || !hasRule(role, 'codebase_*', 'ask') || hasRule(role, 'override_me_*', 'ask')) return { status: 'failed', diagnostic: `resolved-mcp-rules-invalid:${role}`, observations };
            if (!hasRule(role, 'safe_tools_delete', 'deny')) return { status: 'failed', diagnostic: `resolved-exact-deny-missing:${role}`, observations };
            for (const admin of ['codebase-memory-mcp_delete_project', 'codebase-memory-mcp_index_repository', 'codebase-memory-mcp_ingest_traces']) {
                if (hasRule(role, admin, 'allow')) return { status: 'failed', diagnostic: `resolved-protected-admin-allowed:${role}:${admin}`, observations };
            }
        }
        for (const role of ['naru-reader', 'naru-runner', 'naru-reader-smoke', 'naru-runner-smoke']) {
            if (hasRule(role, 'safe_tools_*', 'ask') || hasRule(role, 'codebase_*', 'ask')) return { status: 'failed', diagnostic: `resolved-read-only-rules-broadened:${role}`, observations };
        }
        if (!hasRule('naru-orchestrator', '*', 'deny') || !hasRule('naru-writer', '*', 'deny') || !hasRule('naru-orchestrator', 'codebase-memory-mcp_search_graph', 'allow')) return { status: 'failed', diagnostic: 'resolved-native-or-curated-rules-invalid', observations };
        const expectations = [
            ...['naru-orchestrator', 'naru-writer', 'naru-writer-smoke'].flatMap(agent => [{ agent, action: 'safe_tools_read', effect: 'ask' as const }, { agent, action: 'safe_tools_delete', effect: 'deny' as const }]),
            { agent: 'naru-orchestrator', action: 'codebase_read', effect: 'ask' as const },
            ...['naru-reader', 'naru-runner', 'naru-reader-smoke', 'naru-runner-smoke'].map(agent => ({ agent, action: 'safe_tools_read', effect: 'deny' as const })),
        ];
        for (const expected of expectations) {
            if (Date.now() >= deadline) return { status: 'failed', diagnostic: 'host-permission-api-timeout', observations };
            const created = await boundedJsonRequest(`${base}/session?directory=${encodeURIComponent(cwd)}`, {
                method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ agent: expected.agent, title: 'Naru host contract' }),
            }, Math.max(50, deadline - Date.now()));
            const sessionID = isRecord(created.value) ? created.value.id : undefined;
            if (created.status !== 200 || typeof sessionID !== 'string') return { status: 'failed', diagnostic: `session-create-failed:${expected.agent}`, observations };
            requestedAction = expected.action;
            providerRequests = 0;
            const prompted = await boundedJsonRequest(`${base}/session/${encodeURIComponent(sessionID)}/prompt_async?directory=${encodeURIComponent(cwd)}`, {
                method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ agent: expected.agent, model: { providerID: 'openai', modelID: 'gpt-5.2' }, parts: [{ type: 'text', text: `NARU_CONTRACT_ACTION:${expected.action}` }] }),
            }, Math.max(50, deadline - Date.now()));
            if (prompted.status !== 204) return { status: 'failed', diagnostic: `session-prompt-failed:${expected.agent}:${expected.action}`, observations };
            let pendingMatch = false;
            const settleUntil = deadline;
            while (Date.now() < settleUntil && providerRequests === 0) await new Promise(resolve => setTimeout(resolve, 25));
            if (providerRequests === 0) return { status: 'failed', diagnostic: `provider-not-called:${expected.agent}:${expected.action}`, observations };
            while (Date.now() < settleUntil) {
                const pending = await boundedJsonRequest(`${base}/permission?directory=${encodeURIComponent(cwd)}`, {}, Math.max(50, deadline - Date.now()));
                const list = pending.value;
                pendingMatch = pending.status === 200 && Array.isArray(list) && list.some(item => isRecord(item) && item.sessionID === sessionID && item.permission === expected.action);
                if (pendingMatch || expected.effect === 'deny') break;
                await new Promise(resolve => setTimeout(resolve, 25));
            }
            if ((expected.effect === 'ask') !== pendingMatch) return { status: 'failed', diagnostic: `permission-pending-mismatch:${expected.agent}:${expected.action}:expected-${expected.effect}`, observations };
            if (expected.effect === 'deny') {
                let rejected = false;
                while (Date.now() < settleUntil) {
                    const messages = await boundedJsonRequest(`${base}/session/${encodeURIComponent(sessionID)}/message?directory=${encodeURIComponent(cwd)}`, {}, Math.max(50, deadline - Date.now()));
                    rejected = messages.status === 200 && Array.isArray(messages.value) && messages.value.some(message => isRecord(message) && Array.isArray(message.parts) && message.parts.some(part => isRecord(part) && part.type === 'tool' && part.tool === expected.action && isRecord(part.state) && part.state.status === 'error'));
                    if (rejected) break;
                    await new Promise(resolve => setTimeout(resolve, 25));
                }
                if (!rejected) return { status: 'failed', diagnostic: `denied-action-not-rejected:${expected.agent}:${expected.action}`, observations };
            }
            if (await fileExists(marker)) return { status: 'failed', diagnostic: `synthetic-tool-ran-without-approval:${expected.agent}:${expected.action}`, observations };
            observations.push(expected);
        }
        return { status: 'passed', diagnostic: null, observations };
    }
    catch (error) {
        return { status: 'failed', diagnostic: error instanceof Error && error.name === 'AbortError' ? 'host-permission-api-timeout' : error instanceof Error ? error.message.slice(0, 160) : 'host-contract-failed', observations };
    }
    finally {
        await stopProcessGroup(child);
        await new Promise<void>(resolvePromise => providerServer.close(() => resolvePromise()));
    }
}

export async function guardedRemoveDisposableRoot(root: string): Promise<void> {
    const temporaryRoot = await realpath(os.tmpdir());
    const resolved = await realpath(root);
    if (!resolved.startsWith(`${temporaryRoot}${path.sep}`) || !path.basename(resolved).startsWith('naru-')) throw new Error('disposable root escaped the canonical temporary directory');
    await rm(resolved, { recursive: true, force: true });
}

export async function writeBoundedJson(file: string, value: unknown): Promise<void> {
    const bytes = Buffer.from(`${JSON.stringify(value)}\n`);
    if (bytes.length > MAX_API_BYTES) throw new Error('bounded JSON exceeded limit');
    const handle = await open(file, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_TRUNC | (fsConstants.O_NOFOLLOW ?? 0), 0o600);
    try { await handle.writeFile(bytes); } finally { await handle.close(); }
}
