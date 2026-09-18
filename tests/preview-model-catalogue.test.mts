import assert from 'node:assert/strict';
import { chmod, lstat, mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { loadManagedModelSource, MODEL_CATALOGUE_USER_AGENT, OFFICIAL_MODEL_CATALOGUE_URL, readManagedModelFeed, refreshManagedModelSource, validateOfficialModelFeed } from '../tools/naru-lib/preview-model-catalogue.mjs';

const fixturePath = join(import.meta.dirname, '..', '..', 'tests', 'fixtures', 'current-public-models.json');
const feed = async () => readFile(fixturePath);
const response = (body: BodyInit | null, status = 200, headers: HeadersInit = {}) => new Response(body, { status, headers });

test('offline current public-feed fixture accepts supported metadata and contains the DeepSeek regression model', async () => {
    const input = JSON.parse(await readFile(fixturePath, 'utf8'));
    const provider = input['opencode-go'], model = provider.models['deepseek-v4.1-flash'];
    for (const [key, value] of Object.entries({ admin: 'synthetic-admin', settings: 'synthetic-settings', commands: 'synthetic-commands', plugins: 'synthetic-plugins' })) {
        provider[key] = value; model[key] = value;
    }
    input['opencode-go'].api = '${OPENCODE_API_KEY}/v1';
    input['opencode-go'].models['deepseek-v4.1-flash'].interleaved = true;
    input['opencode-go'].models['deepseek-v4.1-flash'].provider = { npm: '@ai-sdk/google-vertex/anthropic' };
    const validated = validateOfficialModelFeed(input);
    assert.ok(validated.entries.some(entry => entry.reference === 'opencode-go/deepseek-v4.1-flash' && entry.name === 'DeepSeek V4.1 Flash'));
    const normalizedProvider = validated.value['opencode-go'] as Record<string, unknown>;
    const normalizedModel = (normalizedProvider.models as Record<string, Record<string, unknown>>)['deepseek-v4.1-flash']!;
    assert.equal(normalizedProvider.api, '${OPENCODE_API_KEY}/v1');
    assert.equal(normalizedModel.interleaved, true);
    assert.deepEqual(normalizedModel.provider, { npm: '@ai-sdk/google-vertex/anthropic' });
    assert.deepEqual(normalizedModel.reasoning_options, [{ type: 'effort', values: ['low', 'high', 'max'] }]);
    assert.equal((normalizedModel.cost as Record<string, unknown>).cache_read, 0.003);
    const openAI = validated.value.openai as { models: Record<string, Record<string, unknown>> };
    const sol = openAI.models['gpt-5.6-sol']!;
    assert.deepEqual(sol.reasoning_options, [{ type: 'effort', values: ['none', 'low', 'medium', 'high', 'xhigh', 'max'] }]);
    assert.deepEqual(sol.experimental, { modes: {
        fast: { cost: { input: 8, output: 40, cache_read: 0.8, cache_write: 10 }, provider: { body: { service_tier: 'priority' } } },
        pro: { provider: { body: { reasoning: { mode: 'pro' } } } },
    } });
    for (const family of ['sol', 'luna', 'terra']) {
        assert.ok(validated.entries.some(entry => entry.reference === `openai/gpt-5.6-${family}`));
        assert.ok(validated.entries.some(entry => entry.reference === `openai/gpt-5.6-${family}-fast` && entry.modelID === `gpt-5.6-${family}` && entry.mode?.body?.service_tier === 'priority'));
        assert.ok(validated.entries.some(entry => entry.reference === `openai/gpt-5.6-${family}-pro` && entry.mode?.body?.reasoning?.mode === 'pro'));
    }
    for (const key of ['admin', 'settings', 'commands', 'plugins']) {
        assert.equal(Object.hasOwn(validated.value, key), false);
        assert.equal(Object.hasOwn(normalizedProvider, key), false);
        assert.equal(Object.hasOwn(normalizedModel, key), false);
    }
    assert.doesNotMatch(JSON.stringify(validated.value), /synthetic-(?:admin|settings|commands|plugins)/);
    assert.doesNotMatch(JSON.stringify(validated.value), /supported_future_metadata/);
});

test('experimental modes retain only bounded consumed cost and request metadata', async () => {
    const original = JSON.parse(await readFile(fixturePath, 'utf8'));
    const mode = original.openai.models['gpt-5.6-sol'].experimental.modes.fast;
    mode.cost = {
        ...mode.cost,
        input_audio: 12,
        output_audio: 13,
        reasoning: 14,
        context_over_200k: { input: 16, output: 80, cache_read: 1.6, cache_write: 20, unknown: 999 },
        tiers: [{ input: 9, output: 45, cache_read: 0.9, cache_write: 11, unknown: 999, tier: { type: 'context', size: 1000000 } }],
        unknown: 999,
    };
    mode.provider.body.plugins = ['run-command'];
    mode.provider.body.input = 'override';
    mode.provider.headers = { 'x-unknown-public-header': 'stripped' };
    mode.provider.commands = ['run-command'];
    const validated = validateOfficialModelFeed(original);
    const normalized = ((validated.value.openai as { models: Record<string, Record<string, any>> }).models['gpt-5.6-sol']!.experimental.modes.fast);
    assert.deepEqual(normalized.provider, { body: { service_tier: 'priority' } });
    assert.deepEqual(normalized.cost.context_over_200k, { input: 16, output: 80, cache_read: 1.6, cache_write: 20 });
    assert.deepEqual(normalized.cost.tiers, [{ input: 9, output: 45, cache_read: 0.9, cache_write: 11, tier: { type: 'context', size: 1000000 } }]);
    assert.equal(normalized.cost.input_audio, 12); assert.equal(normalized.cost.output_audio, 13); assert.equal(normalized.cost.reasoning, 14);
    assert.doesNotMatch(JSON.stringify(normalized), /unknown|plugins|commands|run-command|override|x-unknown/);

    const invalidMutations = [
        (value: typeof original) => { value.openai.models['gpt-5.6-sol'].experimental.modes.fast.provider.headers = { Authorization: 'Bearer secret' }; },
        (value: typeof original) => { value.openai.models['gpt-5.6-sol'].experimental.modes.fast.provider.body.service_tier = 'default'; },
        (value: typeof original) => { delete value.openai.models['gpt-5.6-sol'].experimental.modes.fast.provider; },
        (value: typeof original) => { value.openai.models['gpt-5.6-sol'].experimental.modes.fast.provider = { body: { reasoning: { mode: 'pro' } } }; },
        (value: typeof original) => { value.openai.models['gpt-5.6-sol'].experimental.modes.fast.provider = { body: {} }; },
        (value: typeof original) => { value.openai.models['gpt-5.6-sol'].experimental.modes.pro.provider.body.reasoning.mode = 'unsafe'; },
        (value: typeof original) => { delete value.openai.models['gpt-5.6-sol'].experimental.modes.pro.provider; },
        (value: typeof original) => { value.openai.models['gpt-5.6-sol'].experimental.modes.pro.provider = { body: { service_tier: 'priority' } }; },
        (value: typeof original) => { value.openai.models['gpt-5.6-sol'].experimental.modes['bad/mode'] = {}; },
        (value: typeof original) => { value.openai.models['gpt-5.6-sol-fast'] = { ...value.openai.models['gpt-5.6-sol'], id: 'gpt-5.6-sol-fast' }; },
        (value: typeof original) => { value.openai.models['gpt-5.6-sol'].experimental.modes = Object.fromEntries(Array.from({ length: 33 }, (_, index) => [`mode${index}`, {}])); },
    ];
    for (const mutate of invalidMutations) {
        const value = structuredClone(original); mutate(value);
        assert.throws(() => validateOfficialModelFeed(value), /invalid model record|colliding experimental mode ID/);
    }

    const generic = structuredClone(original);
    generic['opencode-go'].models['deepseek-v4.1-flash'].experimental = { modes: { economy: { cost: { input: 0.1, output: 0.2 } } } };
    assert.deepEqual((((validateOfficialModelFeed(generic).value['opencode-go'] as any).models['deepseek-v4.1-flash'].experimental.modes.economy)), { cost: { input: 0.1, output: 0.2 } });

    const anthropic = structuredClone(original);
    anthropic['opencode-go'].models['deepseek-v4.1-flash'].experimental = { modes: { fast: { cost: { input: 30, output: 150 }, provider: { body: { speed: 'fast' }, headers: { 'anthropic-beta': 'fast-mode-2026-02-01' } } } } };
    assert.deepEqual((((validateOfficialModelFeed(anthropic).value['opencode-go'] as any).models['deepseek-v4.1-flash'].experimental.modes.fast.provider)), { body: { speed: 'fast' }, headers: { 'anthropic-beta': 'fast-mode-2026-02-01' } });
    delete anthropic['opencode-go'].models['deepseek-v4.1-flash'].experimental.modes.fast.provider.headers;
    assert.throws(() => validateOfficialModelFeed(anthropic), /invalid model record/);
});

test('official feed validation rejects unsafe executable package and API override inputs', async () => {
    const original = JSON.parse(await readFile(fixturePath, 'utf8'));
    for (const mutate of [
        (value: typeof original) => { value['opencode-go'].npm = 'file:/tmp/provider'; },
        (value: typeof original) => { value['opencode-go'].models['deepseek-v4.1-flash'].provider = { api: 'file:///tmp/socket' }; },
        (value: typeof original) => { value['opencode-go'].models['deepseek-v4.1-flash'].provider = { shape: 'openai; run-command' }; },
        (value: typeof original) => { value['opencode-go'].api = '${UNDECLARED_BASE_URL}/v1'; },
    ]) {
        const value = structuredClone(original); mutate(value);
        assert.throws(() => validateOfficialModelFeed(value), /invalid (provider|model) record/);
    }
});

test('refresh sends only public metadata headers, validates host before atomic publication, and reuses verified immutable bytes', async () => {
    const root = await realpath(await mkdtemp('/tmp/naru-model-source-test-'));
    const requests: Array<{ url: string; init?: RequestInit }> = []; const accepted: string[] = [];
    try {
        const fetcher = async (url: string | URL | Request, init?: RequestInit) => { requests.push({ url: String(url), ...(init ? { init } : {}) }); return response(await feed()); };
        const first = await refreshManagedModelSource(root, async source => { assert.equal(await lstat(source.path).then(info => info.mode & 0o777), 0o600); accepted.push(source.digest); }, { fetch: fetcher as typeof fetch });
        assert.equal(first.outcome, 'downloaded'); assert.equal(requests[0]!.url, OFFICIAL_MODEL_CATALOGUE_URL);
        assert.deepEqual(requests[0]!.init?.headers, { accept: 'application/json', 'user-agent': MODEL_CATALOGUE_USER_AGENT });
        assert.equal(requests[0]!.init?.redirect, 'manual'); assert.equal((await loadManagedModelSource(root))?.digest, first.digest);
        assert.ok((await readManagedModelFeed(first)).entries.some(entry => entry.reference === 'opencode-go/deepseek-v4.1-flash'));
        assert.doesNotMatch(await readFile(first.path, 'utf8'), /supported_future_metadata/);
        const second = await refreshManagedModelSource(root, async source => { accepted.push(source.digest); }, { fetch: fetcher as typeof fetch });
        assert.equal(second.outcome, 'unchanged'); assert.deepEqual(accepted, [first.digest]);
        assert.deepEqual((await lstat(join(root, 'model-catalogue', 'current.json'))).mode & 0o777, 0o600);
    } finally { await rm(root, { recursive: true, force: true }); }
});

test('invalid JSON, schema, HTTP 403, timeout, overflow, and candidate-host failure preserve the last good pointer', async () => {
    const root = await realpath(await mkdtemp('/tmp/naru-model-source-failure-test-'));
    try {
        const good = await refreshManagedModelSource(root, async () => {}, { fetch: (async () => response(await feed())) as typeof fetch });
        const failures: Array<{ fetch: typeof fetch; pattern: RegExp }> = [
            { fetch: (async () => response('{')) as typeof fetch, pattern: /valid UTF-8 JSON/ },
            { fetch: (async () => response('{}')) as typeof fetch, pattern: /invalid schema/ },
            { fetch: (async () => response('', 403)) as typeof fetch, pattern: /refused \(403\).*no retry/ },
            { fetch: (async () => { const error = new Error('timeout'); error.name = 'TimeoutError'; throw error; }) as typeof fetch, pattern: /timed out/ },
            { fetch: (async () => response('oversized', 200, { 'content-length': String(17 * 1024 * 1024) })) as typeof fetch, pattern: /16 MiB limit/ },
        ];
        for (const item of failures) {
            await assert.rejects(refreshManagedModelSource(root, async () => {}, { fetch: item.fetch }), item.pattern);
            assert.equal((await loadManagedModelSource(root))?.digest, good.digest);
        }
        const changed = JSON.parse((await feed()).toString('utf8')); changed['opencode-go'].models.other = { ...changed['opencode-go'].models['deepseek-v4.1-flash'], id: 'other', name: 'Other' };
        await assert.rejects(refreshManagedModelSource(root, async () => { throw new Error('Pinned host rejected candidate'); }, { fetch: (async () => response(JSON.stringify(changed))) as typeof fetch }), /rejected candidate/);
        assert.equal((await loadManagedModelSource(root))?.digest, good.digest);
        const attempt = JSON.parse(await readFile(join(root, 'model-catalogue', 'last-attempt.json'), 'utf8'));
        assert.equal(attempt.outcome, 'failed'); assert.doesNotMatch(JSON.stringify(attempt), /DeepSeek|supported_future|reasoning_options|cache_read/);
    } finally { await rm(root, { recursive: true, force: true }); }
});

test('adding normalized modes publishes a new immutable digest while old source handles remain unchanged', async () => {
    const root = await realpath(await mkdtemp('/tmp/naru-model-mode-refresh-test-'));
    try {
        const current = JSON.parse((await feed()).toString('utf8'));
        const beforeModes = structuredClone(current);
        for (const model of Object.values(beforeModes.openai.models) as Array<Record<string, unknown>>) delete model.experimental;
        const oldSource = await refreshManagedModelSource(root, async () => {}, { fetch: (async () => response(JSON.stringify(beforeModes))) as typeof fetch });
        const oldPath = oldSource.path, oldDigest = oldSource.digest, oldBytes = await readFile(oldPath);
        const newSource = await refreshManagedModelSource(root, async candidate => {
            const candidateFeed = await readManagedModelFeed(candidate);
            assert.ok(candidateFeed.entries.some(entry => entry.reference === 'openai/gpt-5.6-sol-fast'));
        }, { fetch: (async () => response(JSON.stringify(current))) as typeof fetch });
        assert.notEqual(newSource.digest, oldDigest); assert.equal((await loadManagedModelSource(root))?.digest, newSource.digest);
        assert.equal(oldSource.digest, oldDigest); assert.equal(oldSource.path, oldPath); assert.deepEqual(await readFile(oldPath), oldBytes);
    } finally { await rm(root, { recursive: true, force: true }); }
});

test('managed source rejects symlinked roots, pointers, snapshots, and digest mismatches', async () => {
    const root = await realpath(await mkdtemp('/tmp/naru-model-source-symlink-test-'));
    try {
        const outside = join(root, 'outside'); await mkdir(outside, { mode: 0o700 });
        const linkedRoot = join(root, 'linked-root'); await symlink(outside, linkedRoot);
        await assert.rejects(loadManagedModelSource(linkedRoot), /without symlinks/);
        const source = await refreshManagedModelSource(root, async () => {}, { fetch: (async () => response(await feed())) as typeof fetch });
        await writeFile(source.path, Buffer.concat([await feed(), Buffer.from(' ')])); await chmod(source.path, 0o600);
        await assert.rejects(loadManagedModelSource(root), /immutable 0600|digest/);
        const pointer = join(root, 'model-catalogue', 'current.json'), outsidePointer = join(outside, 'pointer.json');
        await writeFile(outsidePointer, '{}', { mode: 0o600 }); await rm(pointer); await symlink(outsidePointer, pointer);
        await assert.rejects(loadManagedModelSource(root), /pointer must be.*not a symlink/);
    } finally { await rm(root, { recursive: true, force: true }); }
});

test('pointer publication failure preserves the previous source while post-rename failures are nonfatal', async () => {
    const root = await realpath(await mkdtemp('/tmp/naru-model-source-publication-test-'));
    const metadataWriter = async (path: string, value: unknown) => writeFile(path, JSON.stringify(value), { mode: 0o600 });
    try {
        const first = await refreshManagedModelSource(root, async () => {}, { fetch: (async () => response(await feed())) as typeof fetch });
        const changed = JSON.parse((await feed()).toString('utf8'));
        changed['opencode-go'].models.other = { ...changed['opencode-go'].models['deepseek-v4.1-flash'], id: 'other', name: 'Other' };
        await assert.rejects(refreshManagedModelSource(root, async () => {}, {
            fetch: (async () => response(JSON.stringify(changed))) as typeof fetch,
            writeMetadata: async (path, value) => path.endsWith('current.json') ? Promise.reject(new Error('pointer write failed')) : metadataWriter(path, value),
        }), /pointer write failed/);
        assert.equal((await loadManagedModelSource(root))?.digest, first.digest);

        const published = await refreshManagedModelSource(root, async () => {}, {
            fetch: (async () => response(JSON.stringify(changed))) as typeof fetch,
            writeMetadata: async (path, value) => path.endsWith('last-attempt.json') ? Promise.reject(new Error('diagnostic write failed')) : metadataWriter(path, value),
        });
        assert.equal((await loadManagedModelSource(root))?.digest, published.digest);
        assert.match(published.warnings?.[0] ?? '', /published.*diagnostic metadata/);

        changed['opencode-go'].models.newer = { ...changed['opencode-go'].models['deepseek-v4.1-flash'], id: 'newer', name: 'Newer' };
        const committed = await refreshManagedModelSource(root, async () => {}, {
            fetch: (async () => response(JSON.stringify(changed))) as typeof fetch,
            writeMetadata: async (path, value, onRenamed) => {
                await metadataWriter(path, value);
                if (path.endsWith('current.json')) { onRenamed?.(); throw new Error('directory sync failed'); }
            },
        });
        assert.equal((await loadManagedModelSource(root))?.digest, committed.digest);
        assert.match(committed.warnings?.[0] ?? '', /published.*durability sync/);
    } finally { await rm(root, { recursive: true, force: true }); }
});
