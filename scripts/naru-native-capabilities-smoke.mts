#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createServer, type ServerResponse } from 'node:http';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cleanProcessEnvironment, nodeSpawner, startPreviewServer } from '../tools/naru-lib/preview-process.mjs';
import { validateSmokeNative } from './naru-smoke-native.mjs';

if (process.platform !== 'darwin') throw new Error('Native capability acceptance requires the certified macOS network sandbox');
if (!process.argv[2]) throw new Error('Usage: node scripts/naru-native-capabilities-smoke.mjs /absolute/path/to/opencode-2.0.15');
const native = await validateSmokeNative(process.argv[2]);
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

let sequence = 0, parentPhase = 0, workerPhase = 0, reviewBlocked = false, commandReceived = false, userCommandReceived = false;
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
        response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ object: 'list', data: ['native-capability-parent', 'native-capability-worker'].map(id => ({ id, object: 'model' })) }));
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
    if (JSON.stringify(input.input).includes('USER_COMMAND_SENTINEL')) {
        assert.equal(role, 'naru');
        assert.equal(input.model, 'native-capability-parent');
        assert.match(JSON.stringify(input.input), /custom-only/);
        assert.doesNotMatch(JSON.stringify(input.input), /Handle this Naru convenience invocation/);
        userCommandReceived = true;
        send(response, input.model, message('USER_COMMAND_COMPLETE'));
        return;
    }
    if (JSON.stringify(input.input).includes('CUSTOM_COMMAND_SETUP')) {
        assert.equal(role, 'naru');
        send(response, input.model, message('CUSTOM_SESSION_READY'));
        return;
    }
    if (JSON.stringify(input.input).includes('WORKER_COMMAND_SETUP')) {
        assert.equal(role, 'worker');
        send(response, input.model, message('WORKER_SESSION_READY'));
        return;
    }
    if (JSON.stringify(input.input).includes('Handle this Naru convenience invocation')) {
        assert.equal(role, 'naru');
        assert.equal(input.model, 'native-capability-parent', 'command changed the user-selected parent model');
        assert.match(JSON.stringify(input.input), /ship-review owner\/repo#7 --dry-run/);
        commandReceived = true;
        send(response, input.model, message('NATIVE_COMMAND_DRY_RUN_COMPLETE'));
        return;
    }
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

const model = (modelID: string, variant: string) => ({ modelID, capabilities: { tools: true, input: ['text'], output: ['text'] }, limit: { context: 200000, output: 8000 }, variants: [{ id: variant, settings: { reasoningEffort: variant } }] });
const config = {
    default_agent: 'naru', update: 'disable', share: 'disabled', snapshots: false,
    permissions: [{ action: '*', resource: '*', effect: 'allow' }],
    plugins: [pluginRoot],
    skills: [skillRoot],
    agents: {
        naru: { description: 'Native capability parent', mode: 'primary', system: 'ROLE:naru', permissions: [{ action: '*', resource: '*', effect: 'allow' }] },
        writer: { description: 'Native capability worker', mode: 'subagent', model: { providerID: 'fixture', model: 'worker', variant: 'high' }, system: 'ROLE:worker', permissions: [{ action: '*', resource: '*', effect: 'allow' }] },
    },
    providers: { fixture: { canonical: 'openai', settings: { baseURL: `http://127.0.0.1:${address.port}/v1`, apiKey: 'local-fixture-only' }, models: { parent: model('native-capability-parent', 'medium'), worker: model('native-capability-worker', 'high') } } },
};
await writeFile(join(configRoot, 'opencode', 'opencode.json'), JSON.stringify(config, null, 2), { mode: 0o600 });
const modelSource = join(root, 'models.json');
const sourceModel = (id: string) => ({ id, name: `Fixture ${id}`, release_date: '2026-09-13', attachment: false, reasoning: true, tool_call: true, modalities: { input: ['text'], output: ['text'] }, limit: { context: 200000, output: 8000 }, provider: { npm: '@ai-sdk/openai' } });
await writeFile(modelSource, JSON.stringify({ fixture: { id: 'fixture', name: 'Fixture', env: [], npm: '@ai-sdk/openai-compatible', models: { parent: sourceModel('parent'), worker: sourceModel('worker') } } }), { mode: 0o600 });

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
    const location = `?location%5Bdirectory%5D=${encodeURIComponent(workspace)}`;
    const commandResponse = await fetch(server.url + '/api/command' + location, { headers: server.headers });
    assert.equal(commandResponse.status, 200, `Native command listing failed: ${commandResponse.status}`);
    const commandList = await commandResponse.json() as { data?: Array<{ name: string }> };
    const execution = await nodeSpawner(server.env)([wrapper, 'run', '--server', server.url, '--agent', 'naru', '--model', 'fixture/parent#medium', '--format', 'json', 'Run native capability acceptance.'], { cwd: workspace, timeout: 45_000, maxBytes: 1024 * 1024 });
    assert.equal(execution.ok, true, execution.stdout + execution.stderr);
    assert.match(execution.stdout, /NATIVE_CAPABILITIES_ACCEPTANCE_COMPLETE/);
    assert.ok(commandList.data?.some(entry => entry.name === 'naru'), `native /naru command not registered: ${JSON.stringify(commandList)}`);
    const sessionID = execution.stdout.match(/"sessionID":"([^"]+)"/)?.[1];
    assert.ok(sessionID, 'native run did not return a session ID');
    const commandInvocation = await fetch(server.url + `/api/session/${encodeURIComponent(sessionID)}/command` + location, {
        method: 'POST', headers: { ...server.headers, 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'naru', text: 'ship-review owner/repo#7 --dry-run', agent: 'naru' }),
    });
    const commandResult = await commandInvocation.text();
    assert.equal(commandInvocation.status, 204, `Native command invocation failed: ${commandInvocation.status} ${commandResult}`);
    for (let attempt = 0; attempt < 100 && !commandReceived; attempt++) await new Promise(resolvePromise => setTimeout(resolvePromise, 50));
    assert.equal(commandReceived, true, 'native command did not reach the loopback provider');
    const workerExecution = await nodeSpawner(server.env)([wrapper, 'run', '--server', server.url, '--agent', 'writer', '--format', 'json', 'WORKER_COMMAND_SETUP'], { cwd: workspace, timeout: 30_000 });
    assert.equal(workerExecution.ok, true, workerExecution.stdout + workerExecution.stderr);
    const workerSessionID = workerExecution.stdout.match(/"sessionID":"([^"]+)"/)?.[1];
    assert.ok(workerSessionID);
    const workerCommand = await fetch(server.url + `/api/session/${encodeURIComponent(workerSessionID)}/command` + location, {
        method: 'POST', headers: { ...server.headers, 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'naru', text: 'ship-review owner/repo#8 --dry-run', agent: 'naru' }),
    });
    assert.equal(workerCommand.status, 500);
    assert.match(await workerCommand.text(), /worker sessions cannot invoke it/);
    assert.equal(commandReceived, true, 'worker command promoted to parent provider prompt');
    assert.equal(reviewBlocked, true);
    assert.ok(advertised.get('naru')?.includes('skill'));
    assert.ok(advertised.get('worker')?.includes('skill'));

    server.stop(); server = undefined;
    const project = join(root, 'custom-command-workspace');
    await mkdir(join(project, '.opencode'), { recursive: true, mode: 0o700 });
    await writeFile(join(project, '.opencode', 'opencode.json'), JSON.stringify({
        commands: { naru: { description: 'User fixture command', template: 'USER_COMMAND_SENTINEL $ARGUMENTS' } },
    }), { mode: 0o600 });
    const { OPENCODE_DISABLE_PROJECT_CONFIG: _disabled, ...projectEnvironment } = environment;
    server = await startPreviewServer(wrapper, project, projectEnvironment, 'catalogue');
    const projectLocation = `?location%5Bdirectory%5D=${encodeURIComponent(project)}`;
    const sourcesResponse = await fetch(server.url + '/api/config' + projectLocation, { headers: server.headers });
    assert.equal(sourcesResponse.status, 200);
    const sources = await sourcesResponse.json() as Array<{ path: string }>;
    assert.ok(sources.some(source => source.path === join(project, '.opencode', 'opencode.json')), 'custom project configuration did not load');
    const userListResponse = await fetch(server.url + '/api/command' + projectLocation, { headers: server.headers });
    assert.equal(userListResponse.status, 200);
    const userList = await userListResponse.json() as { data?: Array<{ name: string; description: string }> };
    const userCommands = userList.data?.filter(entry => entry.name === 'naru') ?? [];
    assert.equal(userCommands.length, 1, JSON.stringify(userList));
    assert.equal(userCommands[0]!.description, 'User fixture command');
    const userExecution = await nodeSpawner(server.env)([wrapper, 'run', '--server', server.url, '--agent', 'naru', '--model', 'fixture/parent#medium', '--format', 'json', 'CUSTOM_COMMAND_SETUP'], { cwd: project, timeout: 30_000 });
    assert.equal(userExecution.ok, true, userExecution.stdout + userExecution.stderr);
    const userSessionID = userExecution.stdout.match(/"sessionID":"([^"]+)"/)?.[1];
    assert.ok(userSessionID);
    const userInvocation = await fetch(server.url + `/api/session/${encodeURIComponent(userSessionID)}/command` + projectLocation, {
        method: 'POST', headers: { ...server.headers, 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'naru', text: 'custom-only', agent: 'naru' }),
    });
    const userResult = await userInvocation.text();
    assert.equal(userInvocation.status, 204, `User command invocation failed: ${userInvocation.status} ${userResult}`);
    for (let attempt = 0; attempt < 100 && !userCommandReceived; attempt++) await new Promise(resolvePromise => setTimeout(resolvePromise, 50));
    assert.equal(userCommandReceived, true, 'preexisting user command was not invoked');
    console.log('PASS 2.0.15 native capabilities: managed command dry-run, worker denial, preexisting project command preserved and invoked; four tools; trusted cwd; skills; loopback-only network');
} finally {
    server?.stop();
    provider.closeAllConnections();
    await new Promise<void>(resolvePromise => provider.close(() => resolvePromise()));
    await rm(root, { recursive: true, force: true });
}
