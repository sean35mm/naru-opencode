import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import type { EvaluationMatrix } from '../tools/naru-lib/oc2-eval-catalogue.mjs';
import { evaluationTaskDigest, interpretNativeAssistantMessages, numberSourceLines, parseRetryAfter, runEvaluation, type EvaluationDispatcher, type EvaluationTaskManifest } from '../tools/naru-lib/oc2-eval-runner.mjs';
import { parseAttemptLines, type AnswerKey } from '../tools/naru-lib/oc2-eval-report.mjs';

const configuration = (providerID: string, modelID: string, variant: string | null = null): EvaluationMatrix['configurations'][number] => ({
    id: `${providerID}/${modelID}#${variant ?? 'default'}`, routeID: `${providerID}/${modelID}`, providerID, modelID, upstreamModelID: modelID.endsWith('-fast') ? modelID.slice(0, -5) : modelID, variant, reasoningLevel: variant ?? 'default', serviceTier: modelID.endsWith('-fast') ? 'priority' : 'default', requestSettings: modelID.endsWith('-fast') ? { serviceTier: 'priority' } : {}, costProvenance: { mode: 'subscription-only-authorization', allowance: 'unknown', cataloguePricesUsedForEligibility: false }, status: 'pending',
});
const configurations = [configuration('opencode-go', 'a'), configuration('opencode', 'b-free'), configuration('openai', 'c-fast', 'high')];
const matrix: EvaluationMatrix = { schemaVersion: 2, kind: 'task-conditioned-read-only', observedAt: '2026-09-15T00:00:00.000Z', generatedAt: '2026-09-15T00:00:00.000Z', limitations: [],
    selection: { opencodeGoRoutes: 1, advertisedFreeOpenCodeRoutes: 1, requiredNamedRoutes: 0, opencodeGoRouteIDs: ['opencode-go/a'], advertisedFreeOpenCodeRouteIDs: ['opencode/b-free'], requiredNamedRouteIDs: [], fullConfigurationCount: 3 },
    subset: { mode: 'full', requestedConfigurationIDs: [], fullConfigurationCount: 3, selectedConfigurationCount: 3 },
    sampling: { exploratory: true, ranking: false, replicates: 1, order: 'route-then-variant' }, configurations };
const source = { path: 'source.ts', sha256: 'b'.repeat(64) };
const responseSchema = (taskID: string) => ({ $schema: 'https://json-schema.org/draft/2020-12/schema', type: 'object', additionalProperties: false, required: ['taskID', 'facts', 'evidence'], properties: {
    taskID: { const: taskID }, facts: { type: 'object', additionalProperties: false, required: ['answer'], properties: { answer: { type: 'number' } } },
    evidence: { type: 'object', additionalProperties: false, required: ['answer'], properties: { answer: { type: 'array', minItems: 1, maxItems: 3, items: { $ref: '#/$defs/evidenceSpan' } } } },
    briefExplanation: { type: 'string', maxLength: 1000 },
}, $defs: { evidenceSpan: { type: 'object', additionalProperties: false, required: ['path', 'startLine', 'endLine'], properties: { path: { type: 'string' }, startLine: { type: 'integer', minimum: 1 }, endLine: { type: 'integer', minimum: 1 } } } } });
const manifest: EvaluationTaskManifest = { schemaVersion: 2, scoringVersion: 2, sourceListingFormat: 'numbered-lines-v1', numericPolicy: 'strict-json-types', repository: { path: '/synthetic/repository', commit: 'a'.repeat(40), requireCleanHead: true }, approvedSources: [source], tasks: [{ id: 'facts', instruction: 'Read it.', sources: [source], requestedFormat: responseSchema('facts') }] };
const answerKey: AnswerKey = { schemaVersion: 2, scoringVersion: 2, numericPolicy: 'strict-json-types', tasks: [{ taskID: 'facts', facts: { answer: 42 }, evidence: { answer: [{ path: 'source.ts', start: 1, end: 1 }] } }] };
const materialize = async (_manifest: EvaluationTaskManifest, task: EvaluationTaskManifest['tasks'][number]) => ({ task, digest: 'c'.repeat(64), prompt: 'PROPRIETARY SOURCE BODY', sources: [{ path: 'source.ts', lines: 1 }] });
const authorization = { schemaVersion: 1 as const, subscriptionOnly: true as const, paidFallback: false as const, allowedRouteIDs: configurations.map(item => item.routeID) };
const goodText = JSON.stringify({ taskID: 'facts', facts: { answer: 42 }, evidence: { answer: [{ path: 'source.ts', startLine: 1, endLine: 1 }] }, briefExplanation: 'Arithmetic.' });
const completed = (input: Parameters<EvaluationDispatcher>[0]) => ({ status: 'completed' as const, text: goodText, observedModel: { providerID: input.configuration.providerID, modelID: input.configuration.upstreamModelID, variant: input.configuration.variant, finish: 'stop' } });

test('quota stops a shared provider budget and resume keeps it stopped until an exact explicit unblock', async () => {
    const output = await mkdtemp('/tmp/naru-eval-runner-'); await rm(output, { recursive: true }); const calls: string[] = [];
    const dispatcher: EvaluationDispatcher = async input => { calls.push(input.configuration.routeID); return input.configuration.providerID === 'opencode-go' ? { status: 'rate-limit', retryAfterSeconds: 60 } : completed(input); };
    try {
        const first = await runEvaluation({ matrix, manifest, answerKey, authorization, outputDirectory: output, maxAttempts: 1, materialize, dispatcher, runID: 'stable-run' });
        assert.deepEqual(calls, ['opencode-go/a']); assert.deepEqual(first.stoppedBudgets, ['opencode-shared']);
        const resumed = await runEvaluation({ matrix, manifest, answerKey, authorization, outputDirectory: output, maxAttempts: 1, materialize, dispatcher, resume: true });
        assert.equal(resumed.runID, 'stable-run'); assert.deepEqual(calls, ['opencode-go/a', 'openai/c-fast']); assert.deepEqual(resumed.stoppedBudgets, ['opencode-shared']);
        const unblocked = await runEvaluation({ matrix, manifest, answerKey, authorization, outputDirectory: output, maxAttempts: 1, materialize, dispatcher, resume: true, unblockBudgets: ['opencode-shared'] });
        assert.deepEqual(calls, ['opencode-go/a', 'openai/c-fast', 'opencode/b-free']); assert.deepEqual(unblocked.stoppedBudgets, []);
        const later = await runEvaluation({ matrix, manifest, answerKey, authorization, outputDirectory: output, maxAttempts: 1, materialize, dispatcher, resume: true });
        assert.deepEqual(later.stoppedBudgets, [], 'an explicitly unblocked budget must not be reconstructed from an older stop record');
        const log = await readFile(join(output, 'attempts.ndjson'), 'utf8'); assert.doesNotMatch(log, /PROPRIETARY|Arithmetic/); assert.equal(log.trim().split('\n').length, 3);
        const records = log.trim().split('\n').map(line => JSON.parse(line) as { budgetPolicy: { enforcement: string; appliedMaxTokens: number | null } });
        assert.equal(records.find(record => record.budgetPolicy.enforcement === 'deadline-only')?.budgetPolicy.appliedMaxTokens, null);
    } finally { await rm(output, { recursive: true, force: true }); }
});

test('resume freezes matrix, tasks, answer key, authorization, limits, and run ID before creating a native dispatcher', async () => {
    const output = await mkdtemp('/tmp/naru-eval-freeze-'); await rm(output, { recursive: true }); let factories = 0;
    try {
        await runEvaluation({ matrix: { ...matrix, configurations: [configurations[2]!] }, manifest, answerKey, authorization, outputDirectory: output, maxAttempts: 1, materialize, dispatcher: async input => completed(input), runID: 'frozen' });
        const changed = structuredClone(matrix); changed.configurations[2]!.serviceTier = 'default';
        await assert.rejects(runEvaluation({ matrix: { ...changed, configurations: [changed.configurations[2]!] }, manifest, answerKey, authorization, outputDirectory: output, maxAttempts: 1, materialize, resume: true,
            dispatcherFactory: async () => { factories++; return { dispatch: async input => completed(input), close: async () => {} }; } }), /inputs, limits, or task protocol differ/);
        assert.equal(factories, 0);
        assert.equal((JSON.parse(await readFile(join(output, 'run.json'), 'utf8')) as { runID: string }).runID, 'frozen');
    } finally { await rm(output, { recursive: true, force: true }); }
});

test('an output lock prevents simultaneous writers and is never removed as stale automatically', async () => {
    const output = await mkdtemp('/tmp/naru-eval-lock-'); await rm(output, { recursive: true });
    try {
        await runEvaluation({ matrix: { ...matrix, configurations: [configurations[2]!] }, manifest, answerKey, authorization, outputDirectory: output, materialize, dispatcher: async input => completed(input) });
        await writeFile(join(output, 'run.lock'), 'other\n', { mode: 0o600 });
        await assert.rejects(runEvaluation({ matrix: { ...matrix, configurations: [configurations[2]!] }, manifest, answerKey, authorization, outputDirectory: output, materialize, dispatcher: async input => completed(input), resume: true }), /locked.*stale-lock removal is forbidden/);
    } finally { await rm(output, { recursive: true, force: true }); }
});

test('authorization, provider concurrency, attempt count, and wall bounds fail closed', async () => {
    const one = { ...matrix, configurations: [configurations[2]!] }, badOutput = await mkdtemp('/tmp/naru-eval-bad-'); await rm(badOutput, { recursive: true }); let calls = 0;
    try {
        await assert.rejects(runEvaluation({ matrix, manifest, answerKey, authorization: { ...authorization, allowedRouteIDs: ['openai/c-fast'] }, outputDirectory: badOutput, materialize, dispatcher: async () => { calls++; return { status: 'unavailable' }; } }), /not explicitly subscription-authorized/);
        await assert.rejects(runEvaluation({ matrix: one, manifest, answerKey, authorization, outputDirectory: badOutput, providerConcurrency: 2, materialize, dispatcher: async () => { calls++; return { status: 'unavailable' }; } }), /must be 1/);
        await assert.rejects(runEvaluation({ matrix: one, manifest, answerKey, authorization, outputDirectory: badOutput, maxAttemptWallMs: 999, materialize, dispatcher: async () => { calls++; return { status: 'unavailable' }; } }), /max-attempt-wall-ms/);
        await assert.rejects(runEvaluation({ matrix: one, manifest, answerKey, authorization: { ...authorization, paidFallback: true } as unknown as typeof authorization, outputDirectory: badOutput, materialize, dispatcher: async () => { calls++; return { status: 'unavailable' }; } }), /paid fallback disabled/);
        assert.equal(calls, 0);
    } finally { await rm(badOutput, { recursive: true, force: true }); }

    const attemptOutput = await mkdtemp('/tmp/naru-eval-attempt-'); await rm(attemptOutput, { recursive: true });
    const wallOutput = await mkdtemp('/tmp/naru-eval-wall-'); await rm(wallOutput, { recursive: true });
    try {
        const fastUnknown = { ...configurations[2]!, serviceTier: 'unknown' as const, requestSettings: {} };
        const attemptMatrix = { ...matrix, configurations: [fastUnknown] };
        let attemptTimeout = 0;
        const attempt = await runEvaluation({ matrix: attemptMatrix, manifest, answerKey, authorization, outputDirectory: attemptOutput, maxAttempts: 1, maxWallMs: 10_000, maxAttemptWallMs: 1_500, materialize, dispatcher: async input => { calls++; attemptTimeout = input.timeoutMs; return completed(input); } });
        assert.equal(attempt.dispatched, 1); assert.equal(calls, 1);
        assert.ok(attemptTimeout > 0 && attemptTimeout <= 1_500);
        const attemptRecord = parseAttemptLines(await readFile(join(attemptOutput, 'attempts.ndjson'), 'utf8'))[0]!;
        assert.equal(attemptRecord.budgetPolicy.wallDeadlineMs, attemptTimeout);
        assert.equal(attemptRecord.requested.serviceTier, 'unknown'); assert.equal(attemptRecord.observed?.modelID, 'c'); assert.equal(attemptRecord.observed?.variant, 'high');
        let tick = 0;
        const wall = await runEvaluation({ matrix: one, manifest, answerKey, authorization, outputDirectory: wallOutput, maxWallMs: 1000, now: () => tick += 1001, materialize, dispatcher: async input => { calls++; return completed(input); } });
        assert.equal(wall.dispatched, 0); assert.equal(calls, 1);
    } finally { await rm(attemptOutput, { recursive: true, force: true }); await rm(wallOutput, { recursive: true, force: true }); }
});

test('the first request-invalid response halts the batch before a second task or configuration dispatch', async () => {
    const invalidConfigurations = [configuration('xai', 'grok-4.6', 'high'), configuration('openai', 'c-fast', 'high')];
    const invalidMatrix: EvaluationMatrix = { ...matrix, configurations: invalidConfigurations, selection: { ...matrix.selection, fullConfigurationCount: 2 }, subset: { ...matrix.subset, fullConfigurationCount: 2, selectedConfigurationCount: 2 } };
    const secondTask = { ...manifest.tasks[0]!, id: 'facts-two', requestedFormat: responseSchema('facts-two') };
    const twoTaskManifest: EvaluationTaskManifest = { ...manifest, tasks: [manifest.tasks[0]!, secondTask] };
    const twoTaskKey: AnswerKey = { ...answerKey, tasks: [answerKey.tasks[0]!, { ...answerKey.tasks[0]!, taskID: 'facts-two' }] };
    const output = await mkdtemp('/tmp/naru-eval-invalid-'); await rm(output, { recursive: true }); let calls = 0;
    const dispatcher: EvaluationDispatcher = async input => { calls++; return { status: 'request-invalid', observedModel: { providerID: input.configuration.providerID, modelID: input.configuration.upstreamModelID, variant: input.configuration.variant, finish: null }, diagnostic: { category: 'request-invalid', providerErrorType: 'provider.invalid-request' } }; };
    const options = { matrix: invalidMatrix, manifest: twoTaskManifest, answerKey: twoTaskKey, authorization: { ...authorization, allowedRouteIDs: invalidConfigurations.map(item => item.routeID) }, outputDirectory: output, maxAttempts: 4, maxWallMs: 10_000, maxAttemptWallMs: 2_000, materialize, dispatcher };
    try {
        const result = await runEvaluation(options);
        assert.equal(calls, 1); assert.equal(result.dispatched, 1); assert.equal(result.haltedReason, 'request-invalid'); assert.deepEqual(result.stoppedBudgets, []);
        const records = parseAttemptLines(await readFile(join(output, 'attempts.ndjson'), 'utf8'));
        assert.equal(records.length, 1); assert.equal(records[0]!.status, 'request-invalid'); assert.equal(records[0]!.observed?.variant, 'high'); assert.equal(records[0]!.requested.serviceTier, 'default');
        const checkpoint = JSON.parse(await readFile(join(output, 'checkpoint.json'), 'utf8')) as { haltedReason: unknown };
        assert.equal(checkpoint.haltedReason, 'request-invalid');
        const resumed = await runEvaluation({ ...options, resume: true });
        assert.equal(resumed.dispatched, 0); assert.equal(resumed.haltedReason, 'request-invalid'); assert.equal(calls, 1);
    } finally { await rm(output, { recursive: true, force: true }); }
});

test('manifest rejects duplicate, unapproved, sensitive, and malformed requested source inputs', async () => {
    const output = await mkdtemp('/tmp/naru-eval-manifest-'); await rm(output, { recursive: true });
    const base = { matrix: { ...matrix, configurations: [configurations[2]!] }, answerKey, authorization, outputDirectory: output, materialize, dispatcher: async (input: Parameters<EvaluationDispatcher>[0]) => completed(input) };
    try {
        await assert.rejects(runEvaluation({ ...base, manifest: { ...manifest, tasks: [{ ...manifest.tasks[0]!, sources: [source, source] }] } }), /duplicate or outside/);
        const secret = { path: '.env.production', sha256: 'd'.repeat(64) };
        await assert.rejects(runEvaluation({ ...base, manifest: { ...manifest, approvedSources: [secret], tasks: [{ ...manifest.tasks[0]!, sources: [secret] }] } }), /sensitive/);
        await assert.rejects(runEvaluation({ ...base, manifest: { ...manifest, tasks: [{ ...manifest.tasks[0]!, requestedFormat: {} }] } }), /Invalid evaluation task/);
    } finally { await rm(output, { recursive: true, force: true }); }
});

test('native message interpretation requires one completed final assistant from the selected model', () => {
    const selected = configurations[2]!;
    const assistant = (patch: Record<string, unknown> = {}) => ({ type: 'assistant', agent: 'naru-eval', model: { providerID: 'openai', id: 'c-fast', variant: 'high' }, content: [{ type: 'text', text: goodText }], finish: 'stop', tokens: { input: 2, output: 3, reasoning: 0, cache: { read: 0, write: 0 } }, time: { created: 1, completed: 2 }, ...patch });
    assert.deepEqual(interpretNativeAssistantMessages({ data: [assistant()] }, selected).usage, { inputTokens: 2, outputTokens: 3, reasoningTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 });
    assert.equal(interpretNativeAssistantMessages({ data: [assistant({ time: { created: 1 } })] }, selected).status, 'infrastructure-failure');
    assert.equal(interpretNativeAssistantMessages({ data: [assistant({ finish: 'unknown' })] }, selected).status, 'infrastructure-failure');
    assert.equal(interpretNativeAssistantMessages({ data: [assistant({ content: [] })] }, selected).status, 'infrastructure-failure');
    assert.equal(interpretNativeAssistantMessages({ data: [assistant({ retry: { attempt: 2 } })] }, selected).status, 'infrastructure-failure');
    assert.equal(interpretNativeAssistantMessages({ data: [assistant({ error: { type: 'quota_exceeded' } })] }, selected).status, 'quota');
    assert.deepEqual(interpretNativeAssistantMessages({ data: [assistant({ error: { type: 'provider.invalid-request', nested: { parameter: 'max_output_tokens', secret: 'must-not-survive' } } })] }, selected), {
        status: 'request-invalid', observedModel: { providerID: 'openai', modelID: 'c-fast', variant: 'high', finish: 'stop' }, diagnostic: { category: 'request-invalid', reasonCode: 'unsupported-output-limit', providerErrorType: 'provider.invalid-request' },
    });
    assert.deepEqual(interpretNativeAssistantMessages({ data: [assistant({ error: { type: 'provider.auth', message: 'This model is only available through a workspace https://secret.example/key' } })] }, selected), {
        status: 'auth-unavailable', observedModel: { providerID: 'openai', modelID: 'c-fast', variant: 'high', finish: 'stop' }, diagnostic: { category: 'auth-unavailable', reasonCode: 'workspace-required', providerErrorType: 'provider.auth' },
    });
    assert.equal(interpretNativeAssistantMessages({ data: [assistant({ finish: 'length' })] }, selected).status, 'incomplete-output');
    assert.equal(interpretNativeAssistantMessages({ data: [assistant({ content: [{ type: 'tool', name: 'bash' }] })] }, selected).status, 'tool-failure');
    assert.equal(interpretNativeAssistantMessages({ data: [assistant({ model: { providerID: 'other', id: 'c-fast', variant: 'high' } })] }, selected).status, 'infrastructure-failure');
});

test('task protocol v2 numbers source lines and fingerprints schema and scorer inputs', () => {
    assert.equal(numberSourceLines('alpha\nbeta\n'), '1: alpha\n2: beta');
    const task = manifest.tasks[0]!, digest = evaluationTaskDigest(manifest, task);
    assert.notEqual(evaluationTaskDigest(manifest, { ...task, requestedFormat: { ...task.requestedFormat, title: 'changed' } }), digest);
    assert.notEqual(evaluationTaskDigest({ ...manifest, scoringVersion: 3 } as unknown as EvaluationTaskManifest, task), digest);
    assert.notEqual(evaluationTaskDigest({ ...manifest, sourceListingFormat: 'other' } as unknown as EvaluationTaskManifest, task), digest);
});

test('one structured auth refusal blocks only that provider and makes no further requests in its scope', async () => {
    const authConfigurations = [configuration('opencode-go', 'a'), configuration('opencode-go', 'a', 'high'), configuration('opencode', 'b-free')];
    const authMatrix: EvaluationMatrix = { ...matrix, configurations: authConfigurations, selection: { ...matrix.selection, fullConfigurationCount: 3 }, subset: { ...matrix.subset, fullConfigurationCount: 3, selectedConfigurationCount: 3 } };
    const output = await mkdtemp('/tmp/naru-eval-auth-'); await rm(output, { recursive: true }); const calls: string[] = [];
    try {
        const result = await runEvaluation({ matrix: authMatrix, manifest, answerKey, authorization: { ...authorization, allowedRouteIDs: ['opencode-go/a', 'opencode/b-free'] }, outputDirectory: output, maxAttempts: 3, materialize, dispatcher: async input => {
            calls.push(input.configuration.id);
            return input.configuration.providerID === 'opencode-go' ? { status: 'auth-unavailable', diagnostic: { category: 'auth-unavailable', reasonCode: 'workspace-required', providerErrorType: 'provider.auth' } } : completed(input);
        } });
        assert.deepEqual(calls, ['opencode-go/a#default', 'opencode/b-free#default']);
        assert.deepEqual(result.blockedAuthScopes, ['provider:opencode-go']); assert.deepEqual(result.stoppedBudgets, []);
        const stored = await readFile(join(output, 'attempts.ndjson'), 'utf8');
        assert.equal(parseAttemptLines(stored)[0]!.status, 'auth-unavailable');
        assert.doesNotMatch(stored, /workspace https|secret|only available through/i);
        assert.match(stored, /"reasonCode":"workspace-required"/);
    } finally { await rm(output, { recursive: true, force: true }); }
});

test('Retry-After parsing preserves absence, supports integer and date forms, and caps nonnegative delays', () => {
    const now = Date.parse('2026-09-15T00:00:00Z');
    assert.equal(parseRetryAfter(null, now), undefined); assert.equal(parseRetryAfter('120', now), 120); assert.equal(parseRetryAfter('99999', now), 900);
    assert.equal(parseRetryAfter('Tue, 15 Sep 2026 00:01:30 GMT', now), 90); assert.equal(parseRetryAfter('Mon, 14 Sep 2026 23:59:00 GMT', now), 0);
    assert.equal(parseRetryAfter('invalid', now), undefined);
});
