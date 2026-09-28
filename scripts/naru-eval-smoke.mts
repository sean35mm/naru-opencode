#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer, type ServerResponse } from 'node:http';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { EvaluationMatrix } from '../tools/naru-lib/oc2-eval-catalogue.mjs';
import { parseAttemptLines, type AnswerKey } from '../tools/naru-lib/oc2-eval-report.mjs';
import { createNativeEvaluationDispatcher, runEvaluation, type EvaluationTaskManifest } from '../tools/naru-lib/oc2-eval-runner.mjs';
import { validateSmokeNative } from './naru-smoke-native.mjs';

if (process.platform !== 'darwin') throw new Error('Native evaluation acceptance requires the certified macOS loopback-only sandbox');
const expectedNative = '/Users/seangil/.local/share/naru-opencode-v2/versions/0.0.0-beta-19425/opencode2';
const native = await validateSmokeNative(process.argv[2] ?? expectedNative);
assert.equal(await realpath(native), await realpath(expectedNative), 'This acceptance must use the exact installed beta-19425 executable');

const root = await realpath(await mkdtemp('/tmp/naru-eval-smoke-')), runtime = join(root, 'runtime'), output = join(root, 'run');
await mkdir(runtime, { mode: 0o700 }); await mkdir(join(runtime, 'host-data'), { mode: 0o700 });
let calls = 0, rateCalls = 0, authCalls = 0, invalidCalls = 0, delayedCalls = 0, delayedResponse: ServerResponse | undefined, delayedClosedResolve!: () => void;
const delayedClosed = new Promise<void>(resolvePromise => { delayedClosedResolve = resolvePromise; });
const observations: Array<{ model: unknown; reasoning: unknown; serviceTier: unknown; maxOutputTokens: unknown; tools: unknown }> = [];

function assistant(text: string) { return { id: `msg_${calls}`, type: 'message', role: 'assistant', content: [{ type: 'output_text', text, annotations: [] }], status: 'completed' }; }
function send(response: ServerResponse, input: Record<string, unknown>, text: string): void {
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    const emit = (event: Record<string, unknown>) => response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`), item = assistant(text);
    emit({ type: 'response.created', response: { id: `resp_${calls}`, object: 'response', status: 'in_progress', model: input.model, output: [] } });
    emit({ type: 'response.output_item.added', output_index: 0, item: { ...item, content: [] }, status: 'in_progress' });
    emit({ type: 'response.content_part.added', item_id: item.id, output_index: 0, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } });
    emit({ type: 'response.output_text.delta', item_id: item.id, output_index: 0, content_index: 0, delta: text });
    emit({ type: 'response.output_text.done', item_id: item.id, output_index: 0, content_index: 0, text });
    emit({ type: 'response.output_item.done', output_index: 0, item });
    emit({ type: 'response.completed', response: { id: `resp_${calls}`, object: 'response', status: 'completed', model: input.model, output: [item], usage: { input_tokens: 3, input_tokens_details: { cached_tokens: 1 }, output_tokens: 7, output_tokens_details: { reasoning_tokens: 2 }, total_tokens: 10 } } });
    response.end();
}

const provider = createServer(async (request, response) => {
    if (request.method === 'GET' && request.url?.endsWith('/models')) { response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ object: 'list', data: [{ id: 'fixture-upstream', object: 'model' }, { id: 'openai-upstream', object: 'model' }] })); return; }
    let body = ''; for await (const chunk of request) body += chunk;
    const input = JSON.parse(body) as Record<string, unknown>, serialized = JSON.stringify(input.input); calls++;
    observations.push({ model: input.model, reasoning: input.reasoning, serviceTier: input.service_tier, maxOutputTokens: input.max_output_tokens, tools: input.tools });
    assert.equal(input.service_tier, 'priority');
    if (input.model === 'openai-upstream') {
        if (input.max_output_tokens !== undefined) { response.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ error: { type: 'provider.invalid-request', param: 'max_output_tokens', message: "Unsupported parameter: 'max_output_tokens'" } })); return; }
    } else { assert.equal(input.model, 'fixture-upstream'); assert.equal(input.max_output_tokens, 32); }
    assert.ok(input.tools === undefined || Array.isArray(input.tools) && input.tools.length === 0, `No-tool policy failed: ${JSON.stringify(input.tools)}`);
    if (serialized.includes('RATE_LIMIT')) { rateCalls++; response.writeHead(429, { 'content-type': 'application/json', 'retry-after': '120' }).end(JSON.stringify({ error: { type: 'rate_limit', message: 'synthetic rate limit' } })); return; }
    if (serialized.includes('AUTH_REFUSAL')) { authCalls++; response.writeHead(403, { 'content-type': 'application/json' }).end(JSON.stringify({ error: { type: 'provider.auth', message: 'only available through a workspace https://never-store.example/key' } })); return; }
    if (serialized.includes('INVALID_REQUEST')) { invalidCalls++; response.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ error: { type: 'provider.invalid-request', param: 'max_output_tokens', message: "Unsupported parameter: 'max_output_tokens'" } })); return; }
    if (serialized.includes('DELAY')) {
        delayedCalls++; delayedResponse = response; response.once('close', delayedClosedResolve); response.writeHead(200, { 'content-type': 'text/event-stream' }); response.flushHeaders();
        response.write(`event: response.created\ndata: ${JSON.stringify({ type: 'response.created', response: { id: `resp_${calls}`, object: 'response', status: 'in_progress', model: input.model, output: [] } })}\n\n`); return;
    }
    send(response, input, JSON.stringify({ taskID: 'facts', facts: { answer: 42 }, evidence: { answer: [{ path: 'source.ts', startLine: 1, endLine: 1 }] }, briefExplanation: 'Synthetic.' }));
});
await new Promise<void>(resolvePromise => provider.listen(0, '127.0.0.1', resolvePromise));
const address = provider.address(); assert.ok(address && typeof address === 'object');
const model = (modelID: string) => ({ modelID, body: { service_tier: 'priority' }, capabilities: { tools: true, input: ['text'], output: ['text'] }, limit: { context: 200000, output: 8000 }, variants: [{ id: 'high', settings: { reasoningEffort: 'high' } }] });
const settings = { baseURL: `http://127.0.0.1:${address.port}/v1`, apiKey: 'local-fixture-only' };
const providers = { fixture: { canonical: 'openai', settings, models: { fast: model('fixture-upstream') } }, openai: { canonical: 'openai', settings, models: { 'synthetic-fast': model('openai-upstream') } } };
const sandbox = '(version 1)(allow default)(deny network-outbound)(allow network-outbound (remote ip "localhost:*"))(allow network-outbound (remote unix-socket))';
const wrapper = join(runtime, 'sandboxed-opencode');
await writeFile(wrapper, `#!${process.execPath}\nimport fs from 'node:fs';import {spawn} from 'node:child_process';import path from 'node:path';const file=path.join(process.env.XDG_CONFIG_HOME,'opencode','opencode.json');const config=JSON.parse(fs.readFileSync(file,'utf8'));config.providers=${JSON.stringify(providers)};fs.writeFileSync(file,JSON.stringify(config));const child=spawn('/usr/bin/sandbox-exec',['-p',${JSON.stringify(sandbox)},${JSON.stringify(native)},...process.argv.slice(2)],{stdio:'inherit',env:process.env});child.on('exit',code=>process.exit(code??1));\n`, { mode: 0o755 }); await chmod(wrapper, 0o755);
await writeFile(join(runtime, 'host.json'), JSON.stringify({ root: runtime, executable: wrapper, executableHash: createHash('sha256').update(await readFile(wrapper)).digest('hex'), node: process.execPath, cli: join(root, 'unused.mjs') }), { mode: 0o600 });

const config = (providerID: 'fixture' | 'openai', variant: string | null): EvaluationMatrix['configurations'][number] => ({ id: `${providerID}/${providerID === 'openai' ? 'synthetic-fast' : 'fast'}#${variant ?? 'default'}`, routeID: `${providerID}/${providerID === 'openai' ? 'synthetic-fast' : 'fast'}`, providerID, modelID: providerID === 'openai' ? 'synthetic-fast' : 'fast', upstreamModelID: providerID === 'openai' ? 'openai-upstream' : 'fixture-upstream', variant, reasoningLevel: variant ?? 'default', serviceTier: 'priority', requestSettings: { serviceTier: 'priority' }, costProvenance: { mode: 'subscription-only-authorization', allowance: 'unknown', cataloguePricesUsedForEligibility: false }, status: 'pending' });
const configurations = [config('openai', null), config('openai', 'high')];
const matrix: EvaluationMatrix = { schemaVersion: 2, kind: 'task-conditioned-read-only', observedAt: new Date().toISOString(), generatedAt: new Date().toISOString(), limitations: [], selection: { opencodeGoRoutes: 0, advertisedFreeOpenCodeRoutes: 0, requiredNamedRoutes: 0, opencodeGoRouteIDs: [], advertisedFreeOpenCodeRouteIDs: [], requiredNamedRouteIDs: [], fullConfigurationCount: 2 }, subset: { mode: 'configuration-ids', requestedConfigurationIDs: configurations.map(item => item.id), fullConfigurationCount: 2, selectedConfigurationCount: 2 }, sampling: { exploratory: true, ranking: false, replicates: 1, order: 'route-then-variant' }, configurations };
const source = { path: 'source.ts', sha256: 'a'.repeat(64) };
const requestedFormat = { $schema: 'https://json-schema.org/draft/2020-12/schema', type: 'object', additionalProperties: false, required: ['taskID', 'facts', 'evidence'], properties: {
    taskID: { const: 'facts' }, facts: { type: 'object', additionalProperties: false, required: ['answer'], properties: { answer: { type: 'number' } } },
    evidence: { type: 'object', additionalProperties: false, required: ['answer'], properties: { answer: { type: 'array', minItems: 1, maxItems: 3, items: { $ref: '#/$defs/evidenceSpan' } } } },
    briefExplanation: { type: 'string', maxLength: 1000 },
}, $defs: { evidenceSpan: { type: 'object', additionalProperties: false, required: ['path', 'startLine', 'endLine'], properties: { path: { type: 'string' }, startLine: { type: 'integer', minimum: 1 }, endLine: { type: 'integer', minimum: 1 } } } } };
const manifest: EvaluationTaskManifest = { schemaVersion: 2, scoringVersion: 2, sourceListingFormat: 'numbered-lines-v1', numericPolicy: 'strict-json-types', repository: { path: root, commit: 'b'.repeat(40), requireCleanHead: true }, approvedSources: [source], tasks: [{ id: 'facts', instruction: 'Return the synthetic fact.', sources: [source], requestedFormat }] };
const answerKey: AnswerKey = { schemaVersion: 2, scoringVersion: 2, numericPolicy: 'strict-json-types', tasks: [{ taskID: 'facts', facts: { answer: 42 }, evidence: { answer: [{ path: 'source.ts', start: 1, end: 1 }] } }] };
const materialize = async (_manifest: EvaluationTaskManifest, task: EvaluationTaskManifest['tasks'][number]) => ({ task, digest: 'c'.repeat(64), prompt: 'SYNTHETIC_EVAL', sources: [{ path: 'source.ts', lines: 1 }] });

try {
    await runEvaluation({ matrix, manifest, answerKey, authorization: { schemaVersion: 1, subscriptionOnly: true, paidFallback: false, allowedRouteIDs: ['openai/synthetic-fast'] }, outputDirectory: output, maxAttempts: 2, maxOutputTokens: 32, materialize,
        dispatcherFactory: limits => createNativeEvaluationDispatcher(runtime, limits.maxOutputTokens) });
    const records = parseAttemptLines(await readFile(join(output, 'attempts.ndjson'), 'utf8'));
    assert.equal(records.length, 2); assert.ok(records.every(record => record.status === 'completed' && record.grade.perfect && record.budgetPolicy.enforcement === 'deadline-only' && record.budgetPolicy.appliedMaxTokens === null), JSON.stringify(records));
    assert.ok(records.every(record => record.protocol.taskVersion === 2 && record.protocol.scorerVersion === 2 && record.usage.reasoningTokens === 2 && record.usage.cacheReadTokens === 1), JSON.stringify(records));
    assert.equal(observations[0]!.reasoning, undefined); assert.deepEqual(observations[1]!.reasoning, { effort: 'high' });

    const nativeDispatcher = await createNativeEvaluationDispatcher(runtime, 32);
    try {
        const fixture = config('fixture', null);
        const capped = await nativeDispatcher.dispatch({ runID: 'synthetic', attemptID: 'capped', configuration: fixture, prompt: 'CAP_SUPPORTED', maxOutputTokens: 32, timeoutMs: 10_000 });
        assert.equal(capped.status, 'completed');
        const rate = await nativeDispatcher.dispatch({ runID: 'synthetic', attemptID: 'rate', configuration: fixture, prompt: 'RATE_LIMIT', maxOutputTokens: 32, timeoutMs: 10_000 });
        assert.equal(rate.status, 'rate-limit'); assert.equal(rateCalls, 1, 'Native retry policy made more than one billable call');
        const invalid = await nativeDispatcher.dispatch({ runID: 'synthetic', attemptID: 'invalid', configuration: configurations[0]!, prompt: 'INVALID_REQUEST', maxOutputTokens: 32, timeoutMs: 10_000 });
        assert.equal(invalid.status, 'request-invalid'); assert.equal(invalid.diagnostic?.reasonCode, 'unsupported-output-limit'); assert.equal(invalidCalls, 1);
        const auth = await nativeDispatcher.dispatch({ runID: 'synthetic', attemptID: 'auth', configuration: configurations[0]!, prompt: 'AUTH_REFUSAL', maxOutputTokens: 32, timeoutMs: 10_000 });
        assert.equal(auth.status, 'auth-unavailable'); assert.equal(auth.diagnostic?.reasonCode, 'workspace-required'); assert.equal(authCalls, 1);
        const delayed = nativeDispatcher.dispatch({ runID: 'synthetic', attemptID: 'delay', configuration: configurations[0]!, prompt: 'DELAY', maxOutputTokens: 32, timeoutMs: 500 });
        const timed = await delayed; assert.equal(timed.status, 'timeout');
        await Promise.race([delayedClosed, new Promise((_, reject) => setTimeout(() => reject(new Error('Interrupt did not close the provider request')), 5_000))]);
        delayedResponse?.destroy(); await new Promise(resolvePromise => setTimeout(resolvePromise, 750)); assert.equal(delayedCalls, 1, 'Provider activity continued after interrupt');
    } finally { await nativeDispatcher.close(); }
    console.log('PASS beta-19425 evaluation acceptance: task/scorer revision 2 evidence protocol; exact create/prompt/wait/message protocol; separate reasoning/cache usage; OpenAI subscription fast routes omit unsupported max_output_tokens and record deadline-only policy; other routes retain token caps; structured auth and invalid-request diagnostics; default and explicit variant; no tools; retry disabled; interrupt stopped delayed generation; deterministic grader records');
} finally {
    delayedResponse?.destroy(); await new Promise<void>(resolvePromise => provider.close(() => resolvePromise())); await rm(root, { recursive: true, force: true });
}
