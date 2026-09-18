#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createServer, type ServerResponse } from 'node:http';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cleanProcessEnvironment, nodeSpawner, startPreviewServer } from '../tools/naru-lib/preview-process.mjs';
import { validateSmokeNative } from './naru-smoke-native.mjs';

if (process.platform !== 'darwin') throw new Error('Native capability acceptance requires the certified macOS network sandbox');
const defaultNative = '/Users/seangil/.local/share/naru-opencode-v2/versions/0.0.0-beta-19425/opencode2';
const native = await validateSmokeNative(process.argv[2] ?? defaultNative);
const builtRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pluginRoot = join(builtRoot, 'tools', 'oc2-native-plugin');
const skillRoot = join(pluginRoot, 'skills');
assert.deepEqual(JSON.parse(await readFile(join(pluginRoot, 'package.json'), 'utf8')), {
    name: '@naru/oc2-native-plugin', version: '0.0.0', type: 'module', exports: './index.mjs',
});

const root = await realpath(await mkdtemp('/tmp/naru-native-capabilities-'));
const workspace = join(root, 'workspace'), home = join(root, 'home'), configRoot = join(root, 'config');
const dataRoot = join(root, 'data'), cacheRoot = join(root, 'cache'), stateRoot = join(root, 'state'), temporary = join(root, 'tmp');
for (const directory of [workspace, home, join(configRoot, 'opencode'), dataRoot, cacheRoot, stateRoot, temporary]) {
    await mkdir(directory, { recursive: true, mode: 0o700 });
}

let sequence = 0, parentPhase = 0, workerPhase = 0, reviewBlocked = false;
const advertised = new Map<string, string[]>();
function outputs(input: unknown): string {
    const serialized = JSON.stringify(input);
    return serialized.includes('function_call_output') ? serialized : '';
}
function call(name: string, args: unknown) {
    const id = `fc_${++sequence}`;
    return { id, type: 'function_call', call_id: `call_${sequence}`, name, arguments: JSON.stringify(args), status: 'completed' };
}
function message(text: string) {
    return { id: `msg_${++sequence}`, type: 'message', role: 'assistant', content: [{ type: 'output_text', text, annotations: [] }], status: 'completed' };
}
function send(response: ServerResponse, model: string, item: Record<string, unknown>): void {
    const responseID = `resp_${++sequence}`;
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    const event = (value: Record<string, unknown>) => response.write(`event: ${String(value.type)}\ndata: ${JSON.stringify(value)}\n\n`);
    event({ type: 'response.created', response: { id: responseID, object: 'response', status: 'in_progress', model, output: [] } });
    const isCall = item.type === 'function_call';
    event({ type: 'response.output_item.added', output_index: 0, item: { ...item, ...(isCall ? { arguments: '' } : { content: [] }), status: 'in_progress' } });
    if (isCall) {
        event({ type: 'response.function_call_arguments.delta', item_id: item.id, output_index: 0, delta: item.arguments });
        event({ type: 'response.function_call_arguments.done', item_id: item.id, output_index: 0, arguments: item.arguments });
    } else {
        const text = ((item.content as Array<{ text: string }>)[0]!).text;
        event({ type: 'response.content_part.added', item_id: item.id, output_index: 0, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } });
        event({ type: 'response.output_text.delta', item_id: item.id, output_index: 0, content_index: 0, delta: text });
        event({ type: 'response.output_text.done', item_id: item.id, output_index: 0, content_index: 0, text });
    }
    event({ type: 'response.output_item.done', output_index: 0, item });
    event({ type: 'response.completed', response: { id: responseID, object: 'response', status: 'completed', model, output: [item], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } });
    response.end();
}
function custom(tools: string[], suffix: string): string {
    const found = tools.find(name => name.replaceAll('-', '_') === suffix || name.endsWith(`_${suffix}`));
    assert.ok(found, `missing native tool ${suffix}; advertised: ${tools.join(', ')}`);
    return found;
}

const provider = createServer(async (request, response) => {
    if (request.method === 'GET' && request.url?.endsWith('/models')) {
        response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ object: 'list', data: [{ id: 'native-capability-upstream', object: 'model' }] }));
        return;
    }
    let body = '';
    for await (const chunk of request) body += chunk;
    const input = JSON.parse(body) as { model: string; instructions: string; input: unknown; tools?: Array<{ name: string }> };
    if (input.instructions.includes('title generator')) { send(response, input.model, message('Native capabilities')); return; }
    const role = input.instructions.includes('ROLE:worker') ? 'worker' : 'naru';
    const tools = (input.tools ?? []).map(tool => tool.name).sort();
    advertised.set(role, tools);
    const result = outputs(input.input);
    if (role === 'worker') {
        if (workerPhase === 0) send(response, input.model, call('skill', { id: 'naru-review' }));
        else if (workerPhase === 1) {
            assert.match(result, /actual host agent `naru`/);
            send(response, input.model, call(custom(tools, 'naru_github_post_review'), { input: { reviewResult: {} }, agent: 'naru' }));
        } else {
            assert.match(result, /caller agent identity mismatch/);
            reviewBlocked = true;
            send(response, input.model, message('WORKER_CAPABILITIES_COMPLETE'));
        }
        workerPhase++;
        return;
    }
    if (parentPhase === 0) {
        for (const suffix of ['naru_git_read', 'naru_github_read', 'naru_github_post_review', 'naru_worktree']) custom(tools, suffix);
        send(response, input.model, call(custom(tools, 'naru_git_read'), { input: { operation: 'status' } }));
    } else if (parentPhase === 1) {
        assert.match(result, /fixture-dirty\.txt/);
        send(response, input.model, call(custom(tools, 'naru_git_read'), { input: { operation: 'file', ref: 'HEAD', path: 'fixture.txt' } }));
    } else if (parentPhase === 2) {
        assert.match(result, /OC2_NATIVE_FIXTURE/);
        send(response, input.model, call('skill', { id: 'naru-plan' }));
    } else if (parentPhase === 3) {
        assert.match(result, /# Naru Plan/);
        send(response, input.model, call('subagent', { agent: 'writer', description: 'Native capability worker', prompt: 'Run the worker capability proof.' }));
    } else {
        assert.match(result, /WORKER_CAPABILITIES_COMPLETE/);
        send(response, input.model, message('NATIVE_CAPABILITIES_ACCEPTANCE_COMPLETE'));
    }
    parentPhase++;
});
await new Promise<void>(resolvePromise => provider.listen(0, '127.0.0.1', resolvePromise));
const address = provider.address();
assert.ok(address && typeof address === 'object');

const model = { modelID: 'native-capability-upstream', capabilities: { tools: true, input: ['text'], output: ['text'] }, limit: { context: 200000, output: 8000 }, variants: [{ id: 'high', settings: { reasoningEffort: 'high' } }] };
const config = {
    default_agent: 'naru', update: 'disable', share: 'disabled', snapshots: false,
    permissions: [{ action: '*', resource: '*', effect: 'allow' }],
    plugins: [pluginRoot],
    skills: [skillRoot],
    agents: {
        naru: { description: 'Native capability parent', mode: 'primary', model: { providerID: 'fixture', model: 'worker', variant: 'high' }, system: 'ROLE:naru', permissions: [{ action: '*', resource: '*', effect: 'allow' }] },
        writer: { description: 'Native capability worker', mode: 'subagent', model: { providerID: 'fixture', model: 'worker', variant: 'high' }, system: 'ROLE:worker', permissions: [{ action: '*', resource: '*', effect: 'allow' }] },
    },
    providers: { fixture: { canonical: 'openai', settings: { baseURL: `http://127.0.0.1:${address.port}/v1`, apiKey: 'local-fixture-only' }, models: { worker: model } } },
};
await writeFile(join(configRoot, 'opencode', 'opencode.json'), JSON.stringify(config, null, 2), { mode: 0o600 });
const modelSource = join(root, 'models.json');
await writeFile(modelSource, JSON.stringify({ fixture: { id: 'fixture', name: 'Fixture', env: [], npm: '@ai-sdk/openai-compatible', models: { worker: { id: 'worker', name: 'Fixture worker', release_date: '2026-09-13', attachment: false, reasoning: true, tool_call: true, modalities: { input: ['text'], output: ['text'] }, limit: { context: 200000, output: 8000 }, provider: { npm: '@ai-sdk/openai' } } } } }), { mode: 0o600 });

let server: Awaited<ReturnType<typeof startPreviewServer>> | undefined;
try {
    const run = nodeSpawner(cleanProcessEnvironment(process.execPath));
    for (const argv of [['init', '-q'], ['config', 'user.name', 'Fixture'], ['config', 'user.email', 'fixture@example.invalid']]) {
        assert.equal((await run(['git', ...argv], { cwd: workspace })).ok, true);
    }
    await writeFile(join(workspace, 'fixture.txt'), 'OC2_NATIVE_FIXTURE\n');
    assert.equal((await run(['git', 'add', 'fixture.txt'], { cwd: workspace })).ok, true);
    assert.equal((await run(['git', 'commit', '-qm', 'fixture'], { cwd: workspace })).ok, true);
    await writeFile(join(workspace, 'fixture-dirty.txt'), 'dirty\n');

    const wrapper = join(root, 'sandboxed-native');
    const sandbox = '(version 1)(allow default)(deny network-outbound)(allow network-outbound (remote ip "localhost:*"))(allow network-outbound (remote unix-socket))';
    await writeFile(wrapper, `#!/bin/sh\nexec /usr/bin/sandbox-exec -p '${sandbox}' '${native}' "$@"\n`, { mode: 0o700 });
    await chmod(wrapper, 0o700);
    const environment: NodeJS.ProcessEnv = {
        ...cleanProcessEnvironment(process.execPath), HOME: home, XDG_CONFIG_HOME: configRoot, XDG_DATA_HOME: dataRoot,
        XDG_CACHE_HOME: cacheRoot, XDG_STATE_HOME: stateRoot, TMPDIR: temporary, OPENCODE_DB: join(root, 'opencode.db'),
        OPENCODE_DISABLE_AUTOUPDATE: 'true', OPENCODE_DISABLE_PROJECT_CONFIG: 'true', OPENCODE_DISABLE_MODELS_FETCH: 'true', OPENCODE_MODELS_PATH: modelSource,
    };
    server = await startPreviewServer(wrapper, workspace, environment, 'catalogue');
    const execution = await nodeSpawner(server.env)([wrapper, 'run', '--server', server.url, '--agent', 'naru', '--format', 'json', 'Run native capability acceptance.'], { cwd: workspace, timeout: 45_000, maxBytes: 1024 * 1024 });
    assert.equal(execution.ok, true, execution.stdout + execution.stderr);
    assert.match(execution.stdout, /NATIVE_CAPABILITIES_ACCEPTANCE_COMPLETE/);
    assert.equal(reviewBlocked, true);
    assert.ok(advertised.get('naru')?.includes('skill'));
    assert.ok(advertised.get('worker')?.includes('skill'));
    console.log('PASS beta-19425 native capabilities: directory-loaded package plugin; four specialized tools; trusted per-session Git cwd; parent and worker skill({id}) loading; worker review rejected before transport; loopback-only network');
} finally {
    server?.stop();
    provider.closeAllConnections();
    await new Promise<void>(resolvePromise => provider.close(() => resolvePromise()));
    await rm(root, { recursive: true, force: true });
}
