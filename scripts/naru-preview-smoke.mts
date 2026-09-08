#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { callBroker, runModelsListing } from '../tools/naru-preview.mjs';
import { digest, writePrivateJson } from '../tools/naru-lib/preview-broker.mjs';
import { cleanProcessEnvironment, nodeSpawner, startPreviewServer } from '../tools/naru-lib/preview-process.mjs';
import { evaluateOpenCodeVersion } from '../tools/naru-lib/compatibility.mjs';

const cli = resolve(dirname(fileURLToPath(import.meta.url)), '../tools/naru-preview.mjs');
const native = process.argv[2];
if (!native) throw new Error('Usage: node scripts/naru-preview-smoke.mjs /absolute/path/to/pinned/native/opencode2');
const root = await realpath(await mkdtemp('/tmp/naru-preview-smoke-'));
const repository = join(root, 'repository'); await mkdir(repository);
const runtime = join(root, 'preview'); await mkdir(runtime, { mode: 0o700 });
const admin = 'local-test-administrator';
let toolRequests = 0;
const seenModels = new Set<string>();
const endpoint = createServer(async (request, response) => {
    let body = ''; for await (const chunk of request) body += chunk;
    const input = JSON.parse(body);
    assert.equal(input.model, 'fixture'); seenModels.add(input.model);
    const userText = JSON.stringify(input.input);
    const outputs = Array.isArray(input.input) ? input.input.filter((part: { type?: string }) => part.type === 'function_call_output') : [];
    const title = String(input.instructions).includes('title generator');
    if (!title && (userText.includes('DISPATCH_WRITER') || userText.includes('WRITE_FIXTURE'))) {
        assert.deepEqual(input.tools?.map((tool: { name: string }) => tool.name), ['naru_broker'], 'Only the broker may be exposed to the model');
    }
    let call: { name: string; arguments: string } | undefined;
    if (!title && userText.includes('DISPATCH_WRITER') && outputs.length === 0) {
        call = { name: 'naru_broker', arguments: JSON.stringify({ operation: 'start', input: { requestId: 'smoke-writer', role: 'writer', model: 'fixture/fixture', prompt: 'WRITE_FIXTURE' } }) };
    } else if (!title && !userText.includes('DISPATCH_WRITER') && userText.includes('WRITE_FIXTURE')) {
        if (outputs.length === 1) {
            assert.ok(JSON.stringify(outputs[0]).includes('.env.example'));
            assert.ok(!JSON.stringify(outputs[0]).includes('.env.production.local'));
            assert.ok(!JSON.stringify(outputs[0]).includes('secrets/token.txt'));
        }
        if (outputs.length === 2) {
            assert.ok(JSON.stringify(outputs[1]).includes('secret workspace path'));
            assert.ok(!JSON.stringify(outputs[1]).includes('SYNTHETIC_DENIED'));
        }
        const next = [
            { operation: 'files', input: {} },
            { operation: 'read', input: { path: '.env.production.local' } },
            { operation: 'read', input: { path: 'file.txt' } },
            { operation: 'write', input: { path: 'file.txt', content: 'updated\n', expectedHash: digest('original\n') } },
            { operation: 'check', input: { argv: [process.execPath, '-e', "const a=require('assert/strict'),f=require('fs');a.equal(f.readFileSync('file.txt','utf8'),'updated\\n');a.equal(f.readFileSync('.env.example','utf8'),'SAFE_TEMPLATE=true\\n');for(const p of ['.env.production.local','secrets','credentials','node_modules','environment-alias'])a.equal(f.existsSync(p),false);console.log('fixture verified')"] } },
        ][outputs.length];
        if (next) call = { name: 'naru_broker', arguments: JSON.stringify(next) };
    }
    if (call) toolRequests++;
    const text = title ? 'Naru fixture' : 'Naru fixture completed.';
    const item = call
        ? { id: 'fc_' + toolRequests, type: 'function_call', call_id: 'call_' + toolRequests, name: call.name, arguments: call.arguments, status: 'completed' }
        : { id: 'msg_fixture', type: 'message', role: 'assistant', content: [{ type: 'output_text', text, annotations: [] }], status: 'completed' };
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    const send = (value: unknown) => { const event = value as { type: string }; response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`); };
    send({ type: 'response.created', response: { id: 'resp_fixture', object: 'response', status: 'in_progress', model: 'fixture', output: [] } });
    send({ type: 'response.output_item.added', output_index: 0, item: { ...item, ...(call ? { arguments: '' } : { content: [] }), status: 'in_progress' } });
    if (call) {
        send({ type: 'response.function_call_arguments.delta', item_id: item.id, output_index: 0, delta: call.arguments });
        send({ type: 'response.function_call_arguments.done', item_id: item.id, output_index: 0, arguments: call.arguments });
    } else {
        send({ type: 'response.content_part.added', item_id: item.id, output_index: 0, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } });
        send({ type: 'response.output_text.delta', item_id: item.id, output_index: 0, content_index: 0, delta: text });
        send({ type: 'response.output_text.done', item_id: item.id, output_index: 0, content_index: 0, text });
    }
    send({ type: 'response.output_item.done', output_index: 0, item });
    send({ type: 'response.completed', response: { id: 'resp_fixture', object: 'response', status: 'completed', model: 'fixture', output: [item], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } });
    response.end();
});
await new Promise<void>(resolvePromise => endpoint.listen(0, '127.0.0.1', resolvePromise));
const address = endpoint.address(); assert.ok(address && typeof address !== 'string');
const providers = { fixture: { canonical: 'openai', settings: { baseURL: `http://127.0.0.1:${address.port}/v1`, apiKey: 'local-fixture-only' }, models: { fixture: { modelID: 'fixture', capabilities: { tools: true, input: ['text'], output: ['text'] }, limit: { context: 200000, output: 8000 } } } } };
// The wrapper injects only a local mock provider; actual CLI, permissions, MCP and execution use the installed beta.
const wrapper = join(root, 'fixture-host');
await writeFile(wrapper, `#!${process.execPath}\nimport fs from 'node:fs';import path from 'node:path';import {spawn} from 'node:child_process';const file=path.join(process.env.XDG_CONFIG_HOME,'opencode','opencode.json');const config=JSON.parse(fs.readFileSync(file,'utf8'));config.providers=${JSON.stringify(providers)};config.model={providerID:'fixture',model:'fixture'};fs.writeFileSync(file,JSON.stringify(config));const p=spawn(${JSON.stringify(native)},process.argv.slice(2),{stdio:'inherit',env:process.env});p.on('exit',c=>process.exit(c??1));\n`); await chmod(wrapper, 0o755);
const host = { root: runtime, node: process.execPath, cli, executable: wrapper, executableHash: digest(await readFile(wrapper)) };
await writePrivateJson(join(runtime, 'host.json'), host); await writeFile(join(runtime, 'admin'), admin, { mode: 0o600 });
const daemon = spawn(process.execPath, [cli, 'daemon', '--root', runtime], { env: cleanProcessEnvironment(process.execPath), stdio: ['ignore', 'pipe', 'pipe'] });
let errors = ''; daemon.stderr.on('data', chunk => errors += chunk);
let daemonClosed = false;
const daemonClose = new Promise<void>(resolvePromise => daemon.once('close', () => { daemonClosed = true; resolvePromise(); }));
const socket = join(runtime, 'broker.sock');
const rpc = (operation: string, input: unknown = {}) => callBroker(socket, admin, operation, input);
try {
    const run = nodeSpawner(cleanProcessEnvironment(process.execPath));
    for (const argv of [['init', '-q'], ['config', 'user.name', 'Fixture'], ['config', 'user.email', 'fixture@example.invalid']]) assert.equal((await run(['git', ...argv], { cwd: repository })).ok, true);
    await mkdir(join(repository, 'secrets')); await mkdir(join(repository, 'credentials')); await mkdir(join(repository, 'node_modules', 'fixture'), { recursive: true });
    await writeFile(join(repository, 'file.txt'), 'original\n');
    await writeFile(join(repository, '.env.example'), 'SAFE_TEMPLATE=true\n');
    await writeFile(join(repository, '.env.production.local'), 'SYNTHETIC_DENIED=true\n');
    await writeFile(join(repository, 'secrets', 'token.txt'), 'synthetic');
    await writeFile(join(repository, 'credentials', 'service.json'), '{}');
    await writeFile(join(repository, 'node_modules', 'fixture', 'index.js'), 'throw new Error()');
    await symlink('.env.production.local', join(repository, 'environment-alias'));
    for (const argv of [['add', '.'], ['commit', '-qm', 'fixture']]) assert.equal((await run(['git', ...argv], { cwd: repository })).ok, true);
    for (let attempt = 0; ; attempt++) {
        try { await rpc('status'); break; } catch { if (attempt > 100) throw new Error(errors || 'Daemon did not start'); await new Promise(resolvePromise => setTimeout(resolvePromise, 50)); }
    }
    await rpc('enroll', { path: repository, models: ['fixture/fixture'], writeScopes: ['file.txt'] });
    const profile = await rpc('open', { path: repository }) as { cwd: string; env: NodeJS.ProcessEnv };
    const version = await nodeSpawner(profile.env)([native, '--version'], { cwd: profile.cwd });
    assert.equal(evaluateOpenCodeVersion('v2-beta-exploratory', version.stdout).status, 'supported');
    const configurationFile = join(profile.env.XDG_CONFIG_HOME!, 'opencode', 'opencode.json');
    const config = JSON.parse(await readFile(configurationFile, 'utf8')); config.providers = providers; config.model = { providerID: 'fixture', model: 'fixture' }; await writePrivateJson(configurationFile, config);
    const listing = await runModelsListing(native, profile.cwd, profile.env, []);
    assert.equal(listing.ok, true, listing.stdout + listing.stderr);
    assert.match(listing.stdout, /^fixture\/fixture$/m, 'Activated pinned-beta catalogue did not contain the synthetic model');
    const server = await startPreviewServer(native, profile.cwd, profile.env);
    const execution = await Promise.resolve(nodeSpawner(server.env)([native, 'run', '--server', server.url, '--agent', 'naru-preview', '--model', 'fixture/fixture', '--format', 'json', 'DISPATCH_WRITER'], { cwd: profile.cwd, timeout: 30000 })).finally(server.stop);
    assert.equal(execution.ok, true, execution.stdout + execution.stderr);
    assert.ok((await rpc('status') as unknown[]).length, 'Native dispatch did not reach the broker');
    let task: { id: string; state: string; evidence: Array<{ operation: string; ok?: boolean }> } | undefined;
    for (let attempt = 0; attempt < 300; attempt++) {
        task = (await rpc('status') as Array<typeof task>)[0];
        if (task && task.state !== 'running' && task.state !== 'preparing') break;
        await new Promise(resolvePromise => setTimeout(resolvePromise, 100));
    }
    assert.equal(task?.state, 'completed', JSON.stringify(task)); assert.ok(task);
    assert.ok(task.evidence.some(value => value.operation === 'write'));
    assert.ok(task.evidence.some(value => value.operation === 'check' && value.ok));
    assert.equal(await readFile(join(repository, 'file.txt'), 'utf8'), 'original\n');
    const bundle = await rpc('bundle', { id: task.id }) as { digest: string };
    await assert.rejects(rpc('integrate', { id: task.id, digest: 'wrong' }), /Bundle changed/);
    await rpc('integrate', { id: task.id, digest: bundle.digest });
    assert.equal(await readFile(join(repository, 'file.txt'), 'utf8'), 'updated\n');
    await assert.rejects(rpc('integrate', { id: task.id, digest: bundle.digest }), /completed/);
    assert.equal(toolRequests, 6); assert.equal(seenModels.size, 1);
    console.log('PASS pinned beta → native MCP → broker dispatch → secret denial → exact-model writer → dependency-free isolated edit/check → finite integration; no provider credentials or remote delivery');
} finally {
    if (!daemonClosed) daemon.kill('SIGTERM');
    await Promise.race([daemonClose, new Promise(resolvePromise => setTimeout(resolvePromise, 1000))]);
    if (!daemonClosed) {
        daemon.kill('SIGKILL');
        await Promise.race([daemonClose, new Promise(resolvePromise => setTimeout(resolvePromise, 1000))]);
    }
    endpoint.closeAllConnections(); await new Promise<void>(resolvePromise => endpoint.close(() => resolvePromise()));
    await rm(root, { recursive: true, force: true });
}
