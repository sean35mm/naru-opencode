#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { chmod, cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

interface CliOptions { opencode: string | null; source: string | null; help?: boolean }
interface ProcessResult { code: number | null; output: string; timedOut: boolean }

const EXPECTED_VERSION = '1.18.31';
const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
const PROCESS_TIMEOUT_MS = 30_000;

function usage(): string {
    return 'Usage: node scripts/naru-mcp-permission-smoke.mjs --opencode PATH --source PATH\n';
}

function parseArgs(argv: string[]): CliOptions {
    const options: CliOptions = { opencode: null, source: null };
    for (let index = 0; index < argv.length; index += 1) {
        const argument = argv[index];
        if (argument === '--help' || argument === '-h') options.help = true;
        else if (argument === '--opencode' || argument === '--source') {
            const value = argv[index + 1];
            if (!value || value.startsWith('-')) throw new Error(`${argument} requires a path`);
            index += 1;
            if (argument === '--opencode') options.opencode = value;
            else options.source = value;
        }
        else throw new Error(`unknown option: ${argument ?? ''}`);
    }
    if (!options.help && (!options.opencode || !options.source)) throw new Error('--opencode and --source are required');
    return options;
}

async function run(executable: string, args: readonly string[], cwd: string, env: NodeJS.ProcessEnv, timeoutMs = PROCESS_TIMEOUT_MS): Promise<ProcessResult> {
    return await new Promise((resolvePromise, reject) => {
        const child = spawn(executable, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
        let output = Buffer.alloc(0);
        let overflow = false;
        const append = (chunk: Buffer) => {
            if (overflow) return;
            output = Buffer.concat([output, chunk]);
            if (output.length > MAX_OUTPUT_BYTES) {
                overflow = true;
                child.kill('SIGKILL');
            }
        };
        child.stdout.on('data', append);
        child.stderr.on('data', append);
        child.once('error', reject);
        let timedOut = false;
        const timer = setTimeout(() => {
            timedOut = true;
            child.kill('SIGKILL');
        }, timeoutMs);
        child.once('exit', (code) => {
            clearTimeout(timer);
            resolvePromise({ code, output: output.subarray(0, MAX_OUTPUT_BYTES).toString('utf8'), timedOut: timedOut || overflow });
        });
    });
}

function sseChunk(delta: Record<string, unknown>, finishReason?: string): Record<string, unknown> {
    return {
        id: 'chatcmpl-naru-smoke',
        object: 'chat.completion.chunk',
        choices: [{ delta, ...(finishReason ? { finish_reason: finishReason } : {}) }],
    };
}

function messagesContainToolResult(body: Record<string, unknown>): boolean {
    return Array.isArray(body.messages) && body.messages.some((message) =>
        message !== null && typeof message === 'object' && !Array.isArray(message) && Reflect.get(message, 'role') === 'tool');
}

function requestedTool(body: Record<string, unknown>): string {
    const serialized = JSON.stringify(body.messages ?? []);
    if (serialized.includes('future_ping')) return 'future_ping';
    if (serialized.includes('synthetic_blocked')) return 'synthetic_blocked';
    return 'synthetic_ping';
}

async function startProvider(): Promise<{ server: Server; url: string }> {
    const server = createServer((request, response) => {
        const chunks: Buffer[] = [];
        request.on('data', (chunk: Buffer) => chunks.push(chunk));
        request.on('end', () => {
            let body: Record<string, unknown> = {};
            try {
                const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
                if (value !== null && typeof value === 'object' && !Array.isArray(value)) body = value as Record<string, unknown>;
            }
            catch {
                response.writeHead(400).end();
                return;
            }
            response.writeHead(200, { 'content-type': 'text/event-stream', connection: 'close' });
            const lines = messagesContainToolResult(body)
                ? [
                    sseChunk({ role: 'assistant' }),
                    sseChunk({ content: 'SMOKE_OK' }),
                    sseChunk({}, 'stop'),
                ]
                : [
                    sseChunk({ role: 'assistant' }),
                    sseChunk({ tool_calls: [{ index: 0, id: 'call_naru_smoke', type: 'function', function: { name: requestedTool(body), arguments: '' } }] }),
                    sseChunk({ tool_calls: [{ index: 0, function: { arguments: '{}' } }] }),
                    sseChunk({}, 'tool_calls'),
                ];
            for (const line of lines) response.write(`data: ${JSON.stringify(line)}\n\n`);
            response.end('data: [DONE]\n\n');
        });
    });
    await new Promise<void>((resolvePromise, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolvePromise);
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('synthetic provider did not bind TCP');
    return { server, url: `http://127.0.0.1:${address.port}/v1` };
}

function mcpServerSource(): string {
    return `import { appendFileSync } from 'node:fs';
const log = process.argv[2];
const tag = process.argv[3];
let buffered = '';
function send(id, result) { process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\\n'); }
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  buffered += chunk;
  for (;;) {
    const newline = buffered.indexOf('\\n');
    if (newline === -1) break;
    const line = buffered.slice(0, newline).trim();
    buffered = buffered.slice(newline + 1);
    if (!line) continue;
    const message = JSON.parse(line);
    if (message.method === 'initialize') send(message.id, { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: tag, version: '1.0.0' } });
    else if (message.method === 'tools/list') send(message.id, { tools: [
      { name: 'ping', description: 'Harmless synthetic ping', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
      { name: 'blocked', description: 'Must remain denied', inputSchema: { type: 'object', properties: {}, additionalProperties: false } }
    ] });
    else if (message.method === 'tools/call') {
      appendFileSync(log, tag + ':' + String(message.params?.name) + '\\n');
      send(message.id, { content: [{ type: 'text', text: 'PONG:' + tag }] });
    } else if (message.id !== undefined) send(message.id, {});
  }
});
`;
}

function providerConfig(baseURL: string): Record<string, unknown> {
    return {
        name: 'Synthetic loopback',
        id: 'test',
        env: [],
        npm: '@ai-sdk/openai-compatible',
        models: {
            'test-model': {
                id: 'test-model', name: 'Synthetic model', attachment: false, reasoning: false,
                temperature: false, tool_call: true, release_date: '2025-01-01',
                limit: { context: 100_000, output: 10_000 }, cost: { input: 0, output: 0 }, options: {},
            },
        },
        options: { apiKey: 'synthetic', baseURL },
    };
}

async function writeOpenCodeConfig(file: string, providerURL: string, mcpScript: string, callLog: string, includeFuture: boolean): Promise<void> {
    const mcp: Record<string, unknown> = {
        synthetic: { type: 'local', command: [process.execPath, mcpScript, callLog, 'synthetic'], enabled: true },
    };
    if (includeFuture) mcp.future = { type: 'local', command: [process.execPath, mcpScript, callLog, 'future'], enabled: true };
    const deny = { synthetic_blocked: { '*': 'deny' } };
    await writeFile(file, `${JSON.stringify({
        model: 'test/test-model',
        formatter: false,
        lsp: false,
        provider: { test: providerConfig(providerURL) },
        mcp,
        agent: {
            'naru-orchestrator': { permission: deny },
            'naru-reader': { permission: deny },
            'naru-runner': { permission: deny },
            'naru-writer': { permission: deny },
        },
    })}\n`);
}

async function closeServer(server: Server): Promise<void> {
    await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
}

async function main(): Promise<void> {
    let options: CliOptions;
    try {
        options = parseArgs(process.argv.slice(2));
    }
    catch (error) {
        process.stderr.write(`naru-mcp-permission-smoke: ${error instanceof Error ? error.message : 'invalid arguments'}\n${usage()}`);
        process.exitCode = 2;
        return;
    }
    if (options.help) {
        process.stdout.write(usage());
        return;
    }
    const opencode = await realpath(path.resolve(options.opencode ?? ''));
    const source = await realpath(path.resolve(options.source ?? ''));
    const root = await mkdtemp(path.join(os.tmpdir(), 'naru-mcp-permission-smoke-'));
    const provider = await startProvider();
    try {
        await chmod(root, 0o700);
        const home = path.join(root, 'home');
        const configRoot = path.join(home, '.config', 'opencode');
        const project = path.join(root, 'project');
        const state = path.join(root, 'state');
        const mcpScript = path.join(root, 'synthetic-mcp.mjs');
        const callLog = path.join(root, 'mcp-calls.log');
        await mkdir(configRoot, { recursive: true, mode: 0o700 });
        await mkdir(project, { recursive: true, mode: 0o700 });
        await cp(path.join(source, 'agents'), path.join(configRoot, 'agents'), { recursive: true });
        await cp(path.join(source, 'plugins'), path.join(configRoot, 'plugins'), { recursive: true });
        await cp(path.join(source, 'tools'), path.join(configRoot, 'tools'), { recursive: true });
        await writeFile(mcpScript, mcpServerSource(), { mode: 0o700 });
        await writeFile(callLog, '');
        await writeFile(path.join(configRoot, 'naru-runtime.json'), `${JSON.stringify({
            schemaVersion: 1,
            mcp: { configuredTools: 'allow' },
            models: { smoke: { use: 'stable MCP permission smoke', chain: ['test/test-model'] } },
        })}\n`);
        const configFile = path.join(configRoot, 'opencode.json');
        await writeOpenCodeConfig(configFile, provider.url, mcpScript, callLog, false);
        const env: NodeJS.ProcessEnv = {
            CI: '1', HOME: home, OPENCODE_AUTH_CONTENT: '{}', OPENCODE_DISABLE_AUTOCOMPACT: '1',
            OPENCODE_DISABLE_AUTOUPDATE: '1', OPENCODE_DISABLE_MODELS_FETCH: '1', OPENCODE_TEST_HOME: home,
            PATH: [path.dirname(process.execPath), '/usr/bin', '/bin'].join(path.delimiter),
            TERM: 'dumb', XDG_CACHE_HOME: path.join(root, 'cache'), XDG_CONFIG_HOME: path.join(home, '.config'),
            XDG_DATA_HOME: path.join(root, 'data'), XDG_STATE_HOME: state,
        };
        const version = await run(opencode, ['--version'], project, env);
        if (version.code !== 0 || version.output.trim() !== EXPECTED_VERSION) throw new Error(`expected OpenCode ${EXPECTED_VERSION}`);
        const resolved = await run(opencode, ['debug', 'config'], project, env);
        if (resolved.code !== 0 || !resolved.output.includes('"synthetic_*": "allow"')) throw new Error(`stable host did not resolve synthetic MCP allow rules: ${resolved.output}`);
        const roles = ['naru-orchestrator', 'naru-reader', 'naru-runner', 'naru-writer', 'naru-reader-smoke', 'naru-runner-smoke', 'naru-writer-smoke'];
        for (const role of roles) {
            const before = (await readFile(callLog, 'utf8')).split('\n').filter((entry) => entry === 'synthetic:ping').length;
            const result = await run(opencode, ['run', '--format', 'json', '--agent', role, '--model', 'test/test-model', 'Call synthetic_ping exactly once.'], project, env);
            if (result.code !== 0 || result.timedOut || !result.output.includes('SMOKE_OK')) throw new Error(`${role} did not complete the synthetic MCP call`);
            if (result.output.includes('permission requested')) throw new Error(`${role} produced an MCP permission request`);
            const after = (await readFile(callLog, 'utf8')).split('\n').filter((entry) => entry === 'synthetic:ping').length;
            if (after !== before + 1) throw new Error(`${role} did not execute exactly one synthetic MCP call; MCP log=${await readFile(callLog, 'utf8')}; output=${result.output}`);
        }
        await writeOpenCodeConfig(configFile, provider.url, mcpScript, callLog, true);
        const rebuilt = await run(opencode, ['debug', 'config'], project, env);
        if (rebuilt.code !== 0 || !rebuilt.output.includes('"future_*": "allow"')) throw new Error(`stable host did not rebuild future MCP allow rules: ${rebuilt.output}`);
        const future = await run(opencode, ['run', '--format', 'json', '--agent', 'naru-writer-smoke', '--model', 'test/test-model', 'Call future_ping exactly once.'], project, env);
        if (future.code !== 0 || future.timedOut || !future.output.includes('SMOKE_OK')) throw new Error('new configured server was not available after rebuild');
        if (future.output.includes('permission requested')) throw new Error('future configured server produced an MCP permission request');
        const denied = await run(opencode, ['run', '--format', 'json', '--agent', 'naru-orchestrator', '--model', 'test/test-model', 'Call synthetic_blocked exactly once.'], project, env, 10_000);
        if (denied.timedOut) throw new Error('explicit deny produced a pending permission request');
        if (denied.output.includes('permission requested')) throw new Error('explicit deny produced a pending permission request');
        const calls = (await readFile(callLog, 'utf8')).trim().split('\n').filter(Boolean);
        if (calls.filter((entry) => entry === 'synthetic:ping').length !== roles.length) throw new Error(`base or variant MCP call count mismatch: ${calls.join(',')}`);
        if (!calls.includes('future:ping')) throw new Error('future configured server did not execute');
        if (calls.some((entry) => entry.endsWith(':blocked'))) throw new Error(`explicitly denied MCP tool executed: ${calls.join(',')}`);
        process.stdout.write(`Naru MCP permission smoke: passed (${roles.length} roles, future server, explicit deny)\n`);
    }
    finally {
        await closeServer(provider.server);
        await rm(root, { recursive: true, force: true });
    }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    await main().catch((error) => {
        process.stderr.write(`naru-mcp-permission-smoke: ${error instanceof Error ? error.message : 'failed'}\n`);
        process.exitCode = 1;
    });
}
