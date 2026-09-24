#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer, type ServerResponse } from 'node:http';
import { cp, lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { updateOc2NativeProfile } from '../tools/naru-lib/oc2-native-config.mjs';
import { planOc2NativeLaunch } from '../tools/naru-lib/oc2-native-launch.mjs';
import { projectOc2NativeAgents } from '../tools/naru-lib/oc2-native-projection.mjs';
import { oc2NativePaths } from '../tools/naru-lib/oc2-profile.mjs';
import { cleanProcessEnvironment, nodeSpawner, startPreviewServer } from '../tools/naru-lib/preview-process.mjs';
import { validateSmokeNative } from './naru-smoke-native.mjs';

if (process.platform !== 'darwin') throw new Error('Native agent acceptance requires the certified macOS network sandbox');
const nativeArgument = process.argv[2];
if (!nativeArgument) throw new Error('Usage: node scripts/naru-native-agent-smoke.mjs /absolute/path/to/opencode-2.0.15');
const native = await validateSmokeNative(nativeArgument);
const root = await realpath(await mkdtemp('/tmp/naru-native-agent-smoke-'));
const installedRoot = join(root, 'installed'), workspace = join(root, 'workspace'), workspaceTwo = join(root, 'workspace-two'), outside = join(root, 'outside'), home = join(root, 'home'), temporary = join(root, 'tmp');
const paths = oc2NativePaths(installedRoot), configRoot = paths.configRoot, dataRoot = paths.dataRoot, cacheRoot = paths.cacheRoot, stateRoot = paths.stateRoot;
for (const path of [installedRoot, workspace, workspaceTwo, outside, home, temporary, paths.configDirectory, paths.dataRoot, join(installedRoot, 'lib'), join(home, '.config', 'opencode', 'agents')]) await mkdir(path, { recursive: true, mode: 0o700 });
const builtRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
await cp(join(builtRoot, 'tools'), join(installedRoot, 'lib', 'tools'), { recursive: true });

const stableConfig = join(home, '.config', 'opencode', 'opencode.json');
const stableAgent = join(home, '.config', 'opencode', 'agents', 'stable-sentinel.md');
await writeFile(stableConfig, JSON.stringify({ agents: { 'stable-sentinel': { mode: 'primary', system: 'STABLE_CONFIG_MUST_NOT_LOAD', permissions: [{ action: '*', resource: '*', effect: 'allow' }] } } }) + '\n', { mode: 0o600 });
await writeFile(stableAgent, 'STABLE_AGENT_ASSET_MUST_NOT_LOAD\n', { mode: 0o600 });
const stableBefore = [await readFile(stableConfig), await readFile(stableAgent)].map(value => createHash('sha256').update(value).digest('hex'));
await writeFile(join(workspace, 'source.txt'), 'workspace-native-fixture\n');
await writeFile(join(workspaceTwo, 'source.txt'), 'workspace-two-native-fixture\n');
await writeFile(join(outside, 'outside.txt'), 'outside-native-fixture\n');

const workerReference = 'fixture/worker#high', fastReference = 'fixture/worker-fast#max', parentReference = 'fixture/orchestrator#medium';
const expectedProjection = projectOc2NativeAgents([workerReference, fastReference]);
const workerName = expectedProjection.workers[0]!.name;
const fastWorkerName = expectedProjection.workers[1]!.name;

const mcpProgram = join(root, 'synthetic-mcp.mjs');
await writeFile(mcpProgram, `let buffer='';const label=process.argv[2],tool=process.argv[3];process.stdin.setEncoding('utf8');process.stdin.on('data',chunk=>{buffer+=chunk;for(;;){const end=buffer.indexOf('\\n');if(end<0)break;const line=buffer.slice(0,end).trim();buffer=buffer.slice(end+1);if(!line)continue;let request;try{request=JSON.parse(line)}catch{continue}if(request.id===undefined)continue;const result=request.method==='initialize'?{protocolVersion:'2024-11-05',capabilities:{tools:{}},serverInfo:{name:label,version:'1.0.0'}}:request.method==='tools/list'?{tools:[{name:tool,description:'Synthetic '+label+' proof tool',inputSchema:{type:'object',properties:{}}}]}:request.method==='tools/call'?{content:[{type:'text',text:'MCP_OK:'+label+':'+tool}]}:{};process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:request.id,result})+'\\n')}});\n`, { mode: 0o600 });

const gates = new Map<string, { expected: number; active: number; peak: number; release: Promise<void>; open: () => void }>();
function gate(name: string, expected: number) {
    let open!: () => void;
    const value = { expected, active: 0, peak: 0, release: new Promise<void>(resolvePromise => { open = resolvePromise; }), open: () => open() };
    gates.set(name, value); return value;
}
gate('reader', 5); gate('runner', 2); gate('writer', 2);
async function overlap(name: string): Promise<void> {
    const value = gates.get(name)!; value.active++; value.peak = Math.max(value.peak, value.active);
    if (value.active === value.expected) value.open();
    await Promise.race([value.release, new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`Host did not overlap ${value.expected} ${name} provider requests`)), 10_000))]);
    value.active--;
}

let sequence = 0;
const advertised = new Map<string, string[]>();
const observedModels = new Map<string, Set<string>>();
const observedFastRequests: Array<{ model: string; effort?: string; serviceTier?: string }> = [];
const mcpCompleted = new Map<string, number>();
let lifecycleChild = false, lifecycleContinuation = false, lifecycleBackground = false;
function roleFrom(instructions: string): string {
    if (instructions.includes('primary native OpenCode coordinator')) return 'naru';
    return instructions.includes('reusable native Naru worker') ? 'worker' : 'unknown';
}
function outputs(input: unknown): string { return JSON.stringify(input).match(/function_call_output/g)?.length ? JSON.stringify(input) : ''; }
function call(name: string, args: unknown) { const id = `fc_${++sequence}`; return { id, type: 'function_call', call_id: `call_${sequence}`, name, arguments: JSON.stringify(args), status: 'completed' }; }
function advertisedTools(input: { instructions: string; tools?: Array<{ name: string }> }): string[] {
    const names = (input.tools ?? []).map(tool => tool.name);
    for (const match of input.instructions.matchAll(/\btools\.([a-zA-Z0-9_]+(?:\.[a-zA-Z0-9_]+)?)/g)) names.push(match[1]!);
    return [...new Set(names)].sort();
}
function invoke(toolNames: string[], directName: string, codePath: string, args: unknown): Record<string, unknown> {
    if (toolNames.includes(directName)) return call(directName, args);
    assert.ok(toolNames.includes(codePath.replace(/^tools\./, '')), `Tool was not advertised directly or through Code Mode: ${directName}/${codePath}; got ${toolNames.join(',')}`);
    return call('execute', { code: `return await ${codePath}(${JSON.stringify(args)})` });
}
function message(text: string) { return { id: `msg_${++sequence}`, type: 'message', role: 'assistant', content: [{ type: 'output_text', text, annotations: [] }], status: 'completed' }; }
function send(response: ServerResponse, model: string, items: Array<Record<string, unknown>>): void {
    const responseID = `resp_${++sequence}`;
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    const event = (value: Record<string, unknown>) => response.write(`event: ${String(value.type)}\ndata: ${JSON.stringify(value)}\n\n`);
    event({ type: 'response.created', response: { id: responseID, object: 'response', status: 'in_progress', model, output: [] } });
    items.forEach((item, index) => {
        const isCall = item.type === 'function_call';
        event({ type: 'response.output_item.added', output_index: index, item: { ...item, ...(isCall ? { arguments: '' } : { content: [] }), status: 'in_progress' } });
        if (isCall) {
            event({ type: 'response.function_call_arguments.delta', item_id: item.id, output_index: index, delta: item.arguments });
            event({ type: 'response.function_call_arguments.done', item_id: item.id, output_index: index, arguments: item.arguments });
        } else {
            const text = ((item.content as Array<{ text: string }>)[0]!).text;
            event({ type: 'response.content_part.added', item_id: item.id, output_index: index, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } });
            event({ type: 'response.output_text.delta', item_id: item.id, output_index: index, content_index: 0, delta: text });
            event({ type: 'response.output_text.done', item_id: item.id, output_index: index, content_index: 0, text });
        }
        event({ type: 'response.output_item.done', output_index: index, item });
    });
    event({ type: 'response.completed', response: { id: responseID, object: 'response', status: 'completed', model, output: items, usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } });
    response.end();
}

const provider = createServer(async (request, response) => {
    if (request.method === 'GET' && request.url?.endsWith('/models')) {
        response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ object: 'list', data: ['native-parent-upstream', 'native-worker-upstream'].map(id => ({ id, object: 'model' })) })); return;
    }
    let body = ''; for await (const chunk of request) body += chunk;
    const input = JSON.parse(body) as { model: string; reasoning?: { effort?: string }; service_tier?: string; instructions: string; input: unknown; tools?: Array<{ name: string }> };
    const serialized = JSON.stringify(input.input), result = outputs(input.input), role = roleFrom(input.instructions);
    const toolNames = advertisedTools(input);
    advertised.set(`${role}:${serialized.includes('AFTER_RESTART') ? 'after' : 'before'}`, toolNames);
    if (!observedModels.has(role)) observedModels.set(role, new Set());
    if (input.instructions.includes('title generator')) { send(response, input.model, [message('Native beta proof')]); return; }
    observedModels.get(role)!.add(`${input.model}#${input.reasoning?.effort ?? ''}`);
    if (role === 'naru') { assert.equal(input.model, 'native-parent-upstream'); assert.equal(input.reasoning?.effort, 'medium'); }
    else if (role !== 'unknown') {
        assert.equal(input.model, 'native-worker-upstream', JSON.stringify({ role, serialized, instructions: input.instructions.slice(0, 300) }));
        if (input.instructions.includes(`exact configured model ${fastReference}`)) {
            assert.equal(input.reasoning?.effort, 'max'); assert.equal(input.service_tier, 'priority');
            observedFastRequests.push({ model: input.model, effort: input.reasoning.effort, serviceTier: input.service_tier });
        } else { assert.equal(input.reasoning?.effort, 'high'); assert.equal(input.service_tier, undefined); }
    }

    const concurrent = serialized.match(/(READ|RUN|WRITE)_CONCURRENT_(\d)/);
    if (concurrent) {
        const kind = concurrent[1] === 'READ' ? 'reader' : concurrent[1] === 'RUN' ? 'runner' : 'writer';
        const index = concurrent[2]!;
        if (role === 'naru') {
            if (!result.includes(`${kind.toUpperCase()}_${index}_DONE`)) send(response, input.model, [call('subagent', { agent: workerName, description: `Concurrent ${kind} ${index}`, prompt: `${concurrent[0]}: ${kind === 'writer' ? `edit only ${join(workspace, `writer-${index}.txt`)}` : `inspect ${workspace}`}; return evidence` })]);
            else send(response, input.model, [message(`${kind.toUpperCase()}_${index}_PARENT_DONE`)]);
            return;
        }
        if (!result) {
            await overlap(kind);
            if (kind === 'reader') send(response, input.model, [invoke(toolNames, 'read', 'tools.read', { path: join(workspace, 'source.txt') })]);
            else if (kind === 'runner') send(response, input.model, [invoke(toolNames, 'shell', 'tools.shell', { command: `/bin/pwd; /usr/bin/printenv NARU_SYNTHETIC_ENV; /bin/cat ${JSON.stringify(join(outside, 'outside.txt'))}` })]);
            else send(response, input.model, [invoke(toolNames, 'write', 'tools.write', { path: join(workspace, `writer-${index}.txt`), content: `writer-${index}-complete\n` })]);
            return;
        }
        if (kind === 'reader' && !result.includes('outside-native-fixture')) { assert.match(result, /workspace-native-fixture/); send(response, input.model, [invoke(toolNames, 'read', 'tools.read', { path: join(outside, 'outside.txt') })]); return; }
        if (kind === 'reader') assert.match(result, /outside-native-fixture/);
        if (kind === 'runner') { assert.match(result, new RegExp(workspace.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))); assert.match(result, /NARU_ENV_INHERITED/); assert.match(result, /outside-native-fixture/); }
        if (kind === 'writer' && !result.includes(`writer-${index}-complete`)) { send(response, input.model, [invoke(toolNames, 'read', 'tools.read', { path: join(workspace, `writer-${index}.txt`) })]); return; }
        if (kind === 'writer') assert.match(result, new RegExp(`writer-${index}-complete`));
        send(response, input.model, [message(`${kind.toUpperCase()}_${index}_DONE`)]); return;
    }

    if (serialized.includes('LIFECYCLE_PARENT')) {
        if (!result.includes('LIFECYCLE_CHILD_DONE')) { send(response, input.model, [call('subagent', { agent: workerName, description: 'Native lifecycle child', prompt: 'LIFECYCLE_CHILD' })]); return; }
        if (!result.includes('LIFECYCLE_CONTINUED')) {
            const session = result.match(/sessionID=\\?"([a-zA-Z0-9_-]+)/)?.[1]; assert.ok(session, result);
            send(response, input.model, [call('subagent', { agent: workerName, description: 'Native lifecycle continuation', prompt: 'LIFECYCLE_CONTINUE', sessionID: session })]); return;
        }
        if (!serialized.includes('LIFECYCLE_BACKGROUND')) { send(response, input.model, [call('subagent', { agent: workerName, description: 'Native background child', prompt: 'LIFECYCLE_BACKGROUND', background: true })]); return; }
        for (let attempt = 0; attempt < 100 && !lifecycleBackground; attempt++) await new Promise(resolvePromise => setTimeout(resolvePromise, 50));
        send(response, input.model, [message('LIFECYCLE_PARENT_DONE')]); return;
    }
    if (serialized.includes('LIFECYCLE_CONTINUE')) { lifecycleContinuation = true; send(response, input.model, [message('LIFECYCLE_CONTINUED')]); return; }
    if (serialized.includes('LIFECYCLE_CHILD')) { lifecycleChild = true; send(response, input.model, [message('LIFECYCLE_CHILD_DONE')]); return; }
    if (serialized.includes('LIFECYCLE_BACKGROUND')) { lifecycleBackground = true; send(response, input.model, [message('LIFECYCLE_BACKGROUND_DONE')]); return; }

    const delegated = serialized.match(/DELEGATE_(worker|fast-worker):((?:MCP|CUSTOM|SKILL)_[A-Z_]+|FAST_TRANSPORT|DENIED_WRITE)/);
    if (delegated && role === 'naru') {
        if (!result.match(/_DONE|_FAILED|NOT_ADVERTISED|HOST_DENIAL_ENFORCED/)) send(response, input.model, [call('subagent', { agent: delegated[1] === 'fast-worker' ? fastWorkerName : workerName, description: 'Worker capability proof', prompt: delegated[2] })]);
        else send(response, input.model, [message(`DELEGATE_${delegated[1]}_DONE`)]);
        return;
    }
    if (serialized.includes('FAST_TRANSPORT')) { send(response, input.model, [message('FAST_TRANSPORT_DONE')]); return; }

    const mcp = serialized.match(/MCP_(BASELINE|NOVEL)_(?:BEFORE|AFTER)_RESTART/);
    if (mcp) {
        const suffix = mcp[1] === 'BASELINE' ? '_ping' : '_novel', codePath = mcp[1] === 'BASELINE' ? 'tools.baseline.ping' : 'tools.future_service.novel';
        if (!result.includes('MCP_OK:')) {
            const name = toolNames.find(tool => tool.endsWith(suffix));
            send(response, input.model, [name ? call(name, {}) : invoke(toolNames, suffix.slice(1), codePath, {})]); return;
        }
        assert.match(result, mcp[1] === 'BASELINE' ? /MCP_OK:baseline:ping/ : /MCP_OK:future:novel/);
        const key = `${role}:${mcp[1]}:${serialized.includes('AFTER_RESTART') ? 'after' : 'before'}`; mcpCompleted.set(key, (mcpCompleted.get(key) ?? 0) + 1);
        send(response, input.model, [message(`MCP_${mcp[1]}_DONE`)]); return;
    }
    if (serialized.includes('SECOND_CWD')) { assert.match(input.instructions, new RegExp(workspaceTwo.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))); send(response, input.model, [message('SECOND_CWD_DONE')]); return; }
    if (serialized.includes('PARENT_DIRECT_READ')) {
        if (!result) send(response, input.model, [invoke(toolNames, 'read', 'tools.read', { path: join(workspace, 'source.txt') })]);
        else { assert.match(result, /workspace-native-fixture/); send(response, input.model, [message('PARENT_DIRECT_DONE')]); }
        return;
    }
    if (serialized.includes('DENIED_WRITE')) {
        if (!result && !toolNames.includes('write') && !toolNames.includes('tools.write')) send(response, input.model, [message('HOST_DENIAL_ENFORCED')]);
        else if (!result) send(response, input.model, [invoke(toolNames, 'write', 'tools.write', { path: join(workspace, 'denied.txt'), content: 'must-not-exist\n' })]);
        else { assert.match(result, /denied|permission|not allowed|forbidden/i); send(response, input.model, [message('HOST_DENIAL_ENFORCED')]); }
        return;
    }
    send(response, input.model, [message('UNEXPECTED_PROMPT')]);
});
await new Promise<void>(resolvePromise => provider.listen(0, '127.0.0.1', resolvePromise));
const providerAddress = provider.address(); assert.ok(providerAddress && typeof providerAddress === 'object');

const model = (modelID: string, variant: string, effort: string) => ({ modelID, capabilities: { tools: true, input: ['text'], output: ['text'] }, limit: { context: 200000, output: 8000 }, variants: [{ id: variant, settings: { reasoningEffort: effort } }] });
const official = JSON.parse(await readFile(join(builtRoot, '..', 'tests', 'fixtures', 'current-public-models.json'), 'utf8'));
const officialFast = official.openai.models['gpt-5.6-sol'];
const supportedEfforts: string[] = officialFast.reasoning_options[0].values;
assert.ok(supportedEfforts.includes('high') && supportedEfforts.includes('max'));
const fastBody = officialFast.experimental.modes.fast.provider.body;
assert.deepEqual(fastBody, { service_tier: 'priority' });
const configFile = join(configRoot, 'opencode', 'opencode.json');
const initialConfig: Record<string, any> = {
    providers: { fixture: { canonical: 'openai', settings: { baseURL: `http://127.0.0.1:${providerAddress.port}/v1`, apiKey: 'local-fixture-only' }, models: { orchestrator: model('native-parent-upstream', 'medium', 'medium'), worker: model('native-worker-upstream', 'high', 'high'), 'worker-fast': { ...model('native-worker-upstream', 'high', 'high'), body: fastBody, variants: ['high', 'max'].map(id => ({ id, settings: { reasoningEffort: id } })) } } } },
    mcp: { servers: { baseline: { type: 'local', command: [process.execPath, mcpProgram, 'baseline', 'ping'], codemode: false } } },
    // The synthetic host fixture allows tools; production projection never changes host permissions.
    permissions: [{ action: '*', resource: '*', effect: 'allow' }],
};
await writeFile(configFile, JSON.stringify(initialConfig, null, 2), { mode: 0o600 });
await writeFile(join(installedRoot, 'host.json'), JSON.stringify({ root: installedRoot, executable: native, executableHash: createHash('sha256').update(await readFile(native)).digest('hex'), node: process.execPath, cli: join(builtRoot, 'tools', 'oc2.mjs') }), { mode: 0o600 });
const databaseBefore = Buffer.alloc(0); await writeFile(paths.database, databaseBefore, { mode: 0o600 });
await assert.rejects(lstat(join(installedRoot, 'state.json')), { code: 'ENOENT' });
const freshProfile = await updateOc2NativeProfile(installedRoot, [workerReference, fastReference], { home });
assert.deepEqual(freshProfile.models, [workerReference, fastReference]);
await assert.rejects(lstat(join(installedRoot, 'state.json')), { code: 'ENOENT' });
assert.deepEqual(await readFile(paths.database), databaseBefore);
let config: Record<string, any> = JSON.parse(await readFile(configFile, 'utf8'));
assert.deepEqual(config.agents, expectedProjection.agents);
assert.deepEqual(config.permissions, initialConfig.permissions);
const generatedNaru = config.agents.naru as unknown as Record<string, unknown>;
assert.equal(generatedNaru.model, undefined); assert.equal(generatedNaru.variant, undefined);
assert.deepEqual(config.plugins, [join(installedRoot, 'lib', 'tools', 'oc2-native-plugin')]);
assert.deepEqual(config.skills, [join(installedRoot, 'lib', 'tools', 'oc2-native-plugin', 'skills')]);
const modelSource = join(root, 'models.json');
const sourceModel = (id: string) => ({ id, name: `Native ${id} fixture`, release_date: '2026-09-11', attachment: false, reasoning: true, tool_call: true, modalities: { input: ['text'], output: ['text'] }, limit: { context: 200000, output: 8000 }, provider: { npm: '@ai-sdk/openai' } });
await writeFile(modelSource, JSON.stringify({ fixture: { id: 'fixture', name: 'Fixture', env: [], npm: '@ai-sdk/openai-compatible', models: { orchestrator: sourceModel('orchestrator'), worker: sourceModel('worker'), 'worker-fast': sourceModel('worker-fast') } } }), { mode: 0o600 });

const sandbox = '(version 1)(allow default)(deny network-outbound)(allow network-outbound (remote ip "localhost:*"))(allow network-outbound (remote unix-socket))';
const sourceEnvironment: NodeJS.ProcessEnv = {
    ...cleanProcessEnvironment(process.execPath), HOME: home, TMPDIR: temporary, OPENCODE_DISABLE_MODELS_FETCH: 'true', OPENCODE_MODELS_PATH: modelSource,
    OPENCODE_CONFIG: stableConfig, OPENCODE_CONFIG_DIR: join(home, '.config', 'opencode'), OPENCODE_CONFIG_CONTENT: '{"stable":true}', OPENCODE_DISABLE_PROJECT_CONFIG: 'true',
    NARU_SYNTHETIC_ENV: 'NARU_ENV_INHERITED',
};
const parentPlan = await planOc2NativeLaunch(['naru', 'run', '--model', parentReference, '--format', 'json', 'NATIVE_PROOF'], { root: installedRoot }, workspace, sourceEnvironment);
const secondPlan = await planOc2NativeLaunch(['naru', 'run', '--model', parentReference, 'SECOND_CWD'], { root: installedRoot }, workspaceTwo, sourceEnvironment);
const barePlan = await planOc2NativeLaunch(['serve'], { root: installedRoot }, workspaceTwo, sourceEnvironment);
assert.equal(parentPlan.executable, native); assert.equal(parentPlan.cwd, workspace); assert.deepEqual(parentPlan.argv.slice(0, 5), ['run', '--agent', 'naru', '--model', parentReference]);
assert.equal(secondPlan.cwd, workspaceTwo); assert.equal(barePlan.cwd, workspaceTwo); assert.equal(barePlan.env.OPENCODE_DB, parentPlan.env.OPENCODE_DB); assert.equal(parentPlan.env.OPENCODE_DB, paths.database);
for (const key of ['OPENCODE_CONFIG', 'OPENCODE_CONFIG_DIR', 'OPENCODE_CONFIG_CONTENT', 'OPENCODE_DISABLE_PROJECT_CONFIG']) assert.equal(parentPlan.env[key], undefined);
const environment: NodeJS.ProcessEnv = { ...parentPlan.env, NARU_PREVIEW_REQUIRED_MCP: 'baseline' };
let server: Awaited<ReturnType<typeof startPreviewServer>> | undefined;
let executable = '';
let permissionApi = '';
const location = () => `?location%5Bdirectory%5D=${encodeURIComponent(workspace)}`;
async function api(path: string, init: RequestInit = {}): Promise<{ status: number; value: any }> {
    const response = await fetch(server!.url + path, { ...init, headers: { ...server!.headers, ...(init.headers ?? {}) } });
    const text = await response.text();
    let value: any = null;
    if (text) { try { value = JSON.parse(text); } catch { throw new Error(`${path} returned non-JSON response with status ${response.status}`); } }
    return { status: response.status, value };
}
function processDiagnostics(result: { code: number | null; timedOut?: true; stdoutTruncated?: boolean; stderrTruncated?: boolean }): string {
    return JSON.stringify({ code: result.code, timedOut: result.timedOut === true, stdoutTruncated: result.stdoutTruncated === true, stderrTruncated: result.stderrTruncated === true });
}
function responseShape(value: unknown): string {
    const sample = Array.isArray(value) ? value[0] : value;
    return JSON.stringify({ type: value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value, length: Array.isArray(value) ? value.length : undefined, keys: sample && typeof sample === 'object' && !Array.isArray(sample) ? Object.keys(sample).sort() : [] });
}
async function run(role: string, prompt: string, cwd = workspace): Promise<string> {
    const modelArgs = role === 'naru' ? ['--model', 'fixture/orchestrator#medium'] : [];
    const result = await nodeSpawner(server!.env)([executable, 'run', '--server', server!.url, '--agent', role, ...modelArgs, '--format', 'json', prompt], { cwd, timeout: 30_000, maxBytes: 1024 * 1024 });
    assert.equal(result.ok, true, `${role} run failed: ${processDiagnostics(result)}`); return result.stdout;
}
const runRole = (role: string, prompt: string) => run('naru', role === 'naru' ? prompt : `DELEGATE_${role}:${prompt}`);
async function pendingPermissions(): Promise<any[]> {
    for (const path of ['/api/permission' + location(), `/permission?directory=${encodeURIComponent(workspace)}`]) {
        try {
            const response = await api(path);
            if (response.status === 200 && Array.isArray(response.value)) { permissionApi = path.split('?')[0]!; return response.value; }
            if (response.status === 200 && Array.isArray(response.value?.data)) { permissionApi = path.split('?')[0]!; return response.value.data; }
        } catch { /* Try the session-scoped beta API. */ }
    }
    const sessions = await api('/api/session' + location()); assert.equal(sessions.status, 200, `Session API returned status ${sessions.status}`); assert.ok(Array.isArray(sessions.value?.data));
    const pending: any[] = [];
    for (const session of sessions.value.data) {
        const response = await api(`/api/session/${encodeURIComponent(session.id)}/permission` + location());
        assert.equal(response.status, 200, `Permission API unavailable for ${session.id}`);
        assert.ok(Array.isArray(response.value?.data)); pending.push(...response.value.data);
    }
    permissionApi = '/api/session/:id/permission';
    return pending;
}

try {
    const wrapper = join(root, 'sandboxed-native');
    await writeFile(wrapper, `#!/bin/sh\nexec /usr/bin/sandbox-exec -p '${sandbox}' '${native}' "$@"\n`, { mode: 0o700 });
    executable = wrapper;
    server = await startPreviewServer(wrapper, workspace, environment, 'mcp', { requiredMcpNames: ['baseline'] });
    const configResponse = await api('/api/config' + location()); assert.equal(configResponse.status, 200, `Config API returned status ${configResponse.status}`);
    const configSources = configResponse.value?.data ?? configResponse.value;
    assert.ok(Array.isArray(configSources), `Config API did not return configuration sources: ${responseShape(configResponse.value)}`);
    assert.ok(configSources.every((value: unknown) => value && typeof value === 'object' && typeof (value as { path?: unknown }).path === 'string'), `Config API returned an invalid source list: ${responseShape(configResponse.value)}`);
    const configSourcePaths = configSources.map((value: { path: string }) => value.path);
    assert.ok(configSourcePaths.includes(configFile), 'Config API did not load the isolated native configuration source');
    assert.equal(configSourcePaths.includes(stableConfig), false, 'Config API loaded the stable configuration source');
    const agentsResponse = await api('/api/agent' + location()); assert.equal(agentsResponse.status, 200); assert.ok(Array.isArray(agentsResponse.value?.data)); const agents = agentsResponse.value.data;
    for (const [name, role] of [['naru', 'naru'], [workerName, 'worker'], [fastWorkerName, 'fast-worker']] as const) {
        const resolved: any = agents.find((value: any) => value.id === name); assert.ok(resolved, `Agent API missing ${name}`);
        assert.equal('permissions' in config.agents[name]!, false);
        if (role === 'naru') assert.equal(resolved.model, undefined);
        else assert.deepEqual(resolved.model, { providerID: 'fixture', id: role === 'fast-worker' ? 'worker-fast' : 'worker', variant: role === 'fast-worker' ? 'max' : 'high' });
    }
    assert.equal(agents.some((value: any) => value.id === 'stable-sentinel'), false);
    assert.match(await run('naru', 'MCP_BASELINE_BEFORE_RESTART'), /MCP_BASELINE_DONE/);
    assert.match(await run('naru', 'PARENT_DIRECT_READ'), /PARENT_DIRECT_DONE/);
    assert.match(await runRole('fast-worker', 'FAST_TRANSPORT'), /DELEGATE_fast-worker_DONE/);
    assert.match(await run('naru', 'SECOND_CWD', workspaceTwo), /SECOND_CWD_DONE/);
    assert.deepEqual(await pendingPermissions(), []);

    const lifecycle = await run('naru', 'LIFECYCLE_PARENT'); assert.match(lifecycle, /LIFECYCLE_PARENT_DONE/);
    for (let attempt = 0; attempt < 100 && !lifecycleBackground; attempt++) await new Promise(resolvePromise => setTimeout(resolvePromise, 50));
    assert.equal(lifecycleChild, true); assert.equal(lifecycleContinuation, true); assert.equal(lifecycleBackground, true);
    await Promise.all(Array.from({ length: 5 }, (_, index) => run('naru', `READ_CONCURRENT_${index}`)));
    await Promise.all(Array.from({ length: 2 }, (_, index) => run('naru', `RUN_CONCURRENT_${index}`)));
    await Promise.all(Array.from({ length: 2 }, (_, index) => run('naru', `WRITE_CONCURRENT_${index}`)));
    for (const [name, expected] of [['reader', 5], ['runner', 2], ['writer', 2]] as const) assert.equal(gates.get(name)!.peak, expected);
    for (let index = 0; index < 2; index++) assert.equal(await readFile(join(workspace, `writer-${index}.txt`), 'utf8'), `writer-${index}-complete\n`);
    assert.deepEqual(await pendingPermissions(), []);

    server.stop(); server = undefined;
    const agentsBeforeMcpAddition = JSON.stringify(config.agents);
    config.mcp.servers['future-service'] = { type: 'local', command: [process.execPath, mcpProgram, 'future', 'novel'], codemode: false };
    await writeFile(configFile, JSON.stringify(config, null, 2), { mode: 0o600 });
    await updateOc2NativeProfile(installedRoot, undefined, { home });
    config = JSON.parse(await readFile(configFile, 'utf8'));
    assert.equal(JSON.stringify(config.agents), agentsBeforeMcpAddition); assert.deepEqual(config.mcp.servers['future-service'], { type: 'local', command: [process.execPath, mcpProgram, 'future', 'novel'], codemode: false });
    environment.NARU_PREVIEW_REQUIRED_MCP = 'baseline,future-service';
    server = await startPreviewServer(wrapper, workspace, environment, 'mcp', { requiredMcpNames: ['baseline', 'future-service'] });
    for (const role of ['naru', 'worker']) {
        assert.match(await runRole(role, 'MCP_BASELINE_AFTER_RESTART'), role === 'naru' ? /MCP_BASELINE_DONE/ : new RegExp(`DELEGATE_${role}_DONE`));
        assert.match(await runRole(role, 'MCP_NOVEL_AFTER_RESTART'), role === 'naru' ? /MCP_NOVEL_DONE/ : new RegExp(`DELEGATE_${role}_DONE`));
        const tools = advertised.get(`${role}:after`) ?? [];
        assert.ok(tools.some(tool => tool.endsWith('_ping') || tool === 'baseline.ping'), `${role} missing baseline tool`); assert.ok(tools.some(tool => tool.endsWith('_novel') || tool === 'future_service.novel'), `${role} missing novel tool`);
        assert.equal(mcpCompleted.get(`${role}:BASELINE:after`), 1); assert.equal(mcpCompleted.get(`${role}:NOVEL:after`), 1);
    }
    assert.deepEqual(await pendingPermissions(), []);

    // Host denial takes precedence over fixture baseline allow, with no agent override.
    server.stop(); server = undefined;
    config.permissions.push({ action: 'edit', resource: '*', effect: 'deny' });
    await writeFile(configFile, JSON.stringify(config, null, 2), { mode: 0o600 });
    await updateOc2NativeProfile(installedRoot, undefined, { home });
    config = JSON.parse(await readFile(configFile, 'utf8'));
    assert.deepEqual(config.permissions.at(-1), { action: 'edit', resource: '*', effect: 'deny' });
    server = await startPreviewServer(wrapper, workspace, environment, 'mcp', { requiredMcpNames: ['baseline', 'future-service'] });
    assert.match(await runRole('worker', 'DENIED_WRITE'), /DELEGATE_worker_DONE/);
    await assert.rejects(readFile(join(workspace, 'denied.txt')), { code: 'ENOENT' });
    assert.deepEqual(await pendingPermissions(), []);

    const stableAfter = [await readFile(stableConfig), await readFile(stableAgent)].map(value => createHash('sha256').update(value).digest('hex'));
    assert.deepEqual(stableAfter, stableBefore);
    assert.ok((await readFile(paths.database)).length > 0);
    await assert.rejects(lstat(join(installedRoot, 'state.json')), { code: 'ENOENT' });
    await assert.rejects(lstat(join(installedRoot, 'broker.sock')), { code: 'ENOENT' });
    assert.deepEqual([...observedModels.get('naru')!], ['native-parent-upstream#medium']);
    assert.deepEqual([...observedModels.get('worker')!].sort(), ['native-worker-upstream#high', 'native-worker-upstream#max']);
    assert.ok(observedFastRequests.length > 0);
    console.log(JSON.stringify({
        status: 'PASS', native, workspaceKind: 'non-git', sandbox: 'loopback-only', production: ['projectOc2NativeAgents', 'updateOc2NativeProfile', 'planOc2NativeLaunch'],
        agentNames: { naru: 'naru', worker: workerName, fastWorker: fastWorkerName }, permission: { fixtureBaseline: 'allow', hostDenial: true, generatedOverrides: false, pending: 0 }, parentModel: `${parentReference} (user-selected)`, workerModels: [workerReference, fastReference], upstreamModels: ['native-parent-upstream', 'native-worker-upstream'],
        nativeSubagentArgs: ['agent', 'description', 'prompt', 'sessionID', 'background'], lifecycle: { child: lifecycleChild, continuation: lifecycleContinuation, background: lifecycleBackground }, overlapPeak: Object.fromEntries([...gates].map(([name, value]) => [name, value.peak])),
        nativeEffects: { runnerShell: true, writerEditRead: true, cwd: workspace, secondCwd: workspaceTwo, inheritedEnv: 'NARU_SYNTHETIC_ENV', outsideCwdRead: true },
        launch: { naruEntry: parentPlan.argv.slice(0, 5), bareEntry: barePlan.argv, sharedDatabase: paths.database },
        setup: { freshModels: freshProfile.models, databasePreserved: true, noBrokerState: true },
        syntheticTransport: { fast: observedFastRequests[0], scope: 'host request plumbing only; account entitlement untested' },
        mcp: { beforeRestartCalls: 1, afterRestartCalls: 4, afterRestartAllAgents: ['baseline_ping', 'future_service_novel'], updaterPreservedFutureServer: true, workerRegeneration: false, pendingPermissions: 0, permissionApi },
        stableSentinels: { loaded: false, modified: false, homeEquivalent: home, isolatedXdg: configRoot },
        pluginSkills: 'covered-by-naru-native-capabilities-smoke',
    }));
} finally {
    server?.stop(); provider.closeAllConnections(); await new Promise<void>(resolvePromise => provider.close(() => resolvePromise())); await rm(root, { recursive: true, force: true });
}
