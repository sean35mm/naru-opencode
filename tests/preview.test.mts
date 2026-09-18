import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmod, lstat, mkdtemp, mkdir, readFile, readdir, realpath, rename, rm, symlink, truncate, writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { assertNoPrivateConnectionFlags, mcpToolSchemas, modelsOutput, runModelsListing, stopBroker, waitForChild } from '../tools/naru-preview.mjs';
import { PreviewBroker, safeWorkspacePath, digest, maximumPreviewAccess, type Enrollment } from '../tools/naru-lib/preview-broker.mjs';
import { copyVerificationSnapshot, diagnoseExactPreviewCatalogue, diagnosePreviewCatalogue, differentialCatalogueWitness, fetchPreviewCatalogue, isSafeCatalogueModelID, isolatedCheck, nodeSpawner, cleanProcessEnvironment, runtimeReadRoot, startPreviewServer, waitForPreviewReadiness } from '../tools/naru-lib/preview-process.mjs';
import { hostEnvironment } from '../tools/naru-lib/preview-host.mjs';
import { MAX_CATALOGUE_REFERENCE_LENGTH } from '../tools/naru-lib/native-reader-projection.mjs';
import { acquirePreviewUpdateGuard } from '../tools/naru-lib/preview-update-guard.mjs';
import { readManagedModelFeed, refreshManagedModelSource } from '../tools/naru-lib/preview-model-catalogue.mjs';
import { atomicWorkspaceWrite, directoryIdentity, pathContains, protectedPathContains } from '../tools/naru-lib/safe-write.mjs';
import { createWorktreeRun, createWriterWorktree, finalizeWorktreeRun, integrateWriterWorktree, type WorktreeRegistry } from '../tools/naru-lib/worktree.mjs';

const built = join(dirname(fileURLToPath(import.meta.url)), '..');

test('waitForChild resolves a child that exited before observation and cleans up once', async () => {
    const child = spawn(process.execPath, ['-e', '']);
    await new Promise<void>((resolvePromise, reject) => { child.once('exit', () => resolvePromise()); child.once('error', reject); });
    let cleanupCalls = 0;
    assert.equal(await waitForChild(child, () => { cleanupCalls++; }), 0);
    assert.equal(cleanupCalls, 1);
});

test('native smoke scripts reject wrappers before execution or fixture root creation', { skip: process.platform !== 'darwin' }, async () => {
    const fixture = await realpath(await mkdtemp('/tmp/naru-smoke-wrapper-test-'));
    const wrapper = join(fixture, 'opencode2-naru'), marker = join(fixture, 'executed');
    const fixtureRoots = async () => (await readdir('/tmp')).filter(name => name.startsWith('naru-preview-smoke-') || name.startsWith('naru-native-reader-smoke-')).sort();
    try {
        await writeFile(wrapper, `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(marker)},'executed')\n`, { mode: 0o755 }); await chmod(wrapper, 0o755);
        const before = await fixtureRoots();
        for (const script of ['naru-preview-smoke.mjs', 'naru-native-reader-smoke.mjs']) {
            const result = await nodeSpawner(cleanProcessEnvironment(process.execPath))([process.execPath, join(built, 'scripts', script), wrapper], { cwd: fixture });
            assert.equal(result.ok, false); assert.match(result.stderr, /Mach-O or ELF native executable, not a wrapper/);
            await assert.rejects(lstat(marker), { code: 'ENOENT' });
        }
        assert.deepEqual(await fixtureRoots(), before);
    } finally { await rm(fixture, { recursive: true, force: true }); }
});

test('MCP interfaces advertise capability-specific typed tools and closed task schemas', () => {
    assert.deepEqual(mcpToolSchemas('repo-reader').map(tool => tool.name), ['files', 'read']);
    assert.deepEqual(mcpToolSchemas('orchestrator').map(tool => tool.name), ['task_status', 'task_start', 'task_cancel']);
    assert.deepEqual(mcpToolSchemas('managed-worker', { role: 'runner', access: 'check' }).map(tool => tool.name), ['files', 'read', 'check', 'status']);
    assert.deepEqual(mcpToolSchemas('managed-worker', { role: 'writer', access: 'write' }).map(tool => tool.name), ['files', 'read', 'check', 'status', 'write']);
    const start = mcpToolSchemas('orchestrator').find(tool => tool.name === 'task_start')!;
    assert.equal(start.inputSchema.additionalProperties, false);
    assert.deepEqual((start.inputSchema.properties.role as { enum: string[] }).enum, ['runner', 'writer']);
    assert.equal((start.inputSchema.properties.model as { maxLength: number }).maxLength, MAX_CATALOGUE_REFERENCE_LENGTH);
    assert.equal(MAX_CATALOGUE_REFERENCE_LENGTH, 770);
    assert.deepEqual(start.inputSchema.required, ['role', 'model', 'prompt', 'requestId']);
    assert.doesNotMatch(JSON.stringify(mcpToolSchemas('repo-reader')), /write|check|cancel|start/);
});

test('stop is idempotent for missing and stale sockets without removing them', async () => {
    const root = await realpath(await mkdtemp('/tmp/naru-stop-idempotency-test-'));
    const socket = join(root, 'broker.sock');
    let staleDaemon: ReturnType<typeof spawn> | undefined;
    try {
        assert.deepEqual(await stopBroker(socket, 'synthetic-admin'), { stopped: true, alreadyStopped: true });
        const daemon = spawn(process.execPath, ['-e', `require('node:net').createServer().listen(${JSON.stringify(socket)},()=>process.stdout.write('ready'))`], { stdio: ['ignore', 'pipe', 'ignore'] });
        staleDaemon = daemon; assert.ok(daemon.stdout);
        await new Promise<void>((resolvePromise, reject) => { daemon.stdout!.once('data', () => resolvePromise()); daemon.once('error', reject); });
        daemon.kill('SIGKILL');
        await new Promise<void>(resolvePromise => daemon.once('exit', () => resolvePromise()));
        assert.deepEqual(await stopBroker(socket, 'synthetic-admin'), { stopped: true, alreadyStopped: true });
        assert.equal((await lstat(socket)).isSocket(), true);
    } finally {
        if (staleDaemon && staleDaemon.exitCode === null && staleDaemon.signalCode === null) staleDaemon.kill('SIGKILL');
        await rm(root, { recursive: true, force: true });
    }
});

test('stop reaches an active broker and propagates broker refusals and malformed replies', async () => {
    const root = await realpath(await mkdtemp('/tmp/naru-stop-active-test-'));
    const socket = join(root, 'broker.sock');
    let response: unknown = { result: { stopped: true } };
    const requests: unknown[] = [];
    const server = (await import('node:http')).createServer((request, reply) => {
        let body = '';
        request.setEncoding('utf8'); request.on('data', chunk => { body += chunk; });
        request.on('end', () => {
            requests.push(JSON.parse(body));
            reply.setHeader('content-type', 'application/json');
            reply.end(typeof response === 'string' ? response : JSON.stringify(response));
        });
    });
    await new Promise<void>((resolvePromise, reject) => { server.once('error', reject); server.listen(socket, resolvePromise); });
    try {
        assert.deepEqual(await stopBroker(socket, 'synthetic-admin'), { stopped: true });
        assert.deepEqual(requests[0], { token: 'synthetic-admin', operation: 'stop', input: {} });
        response = { error: 'Synthetic stop refused' };
        await assert.rejects(stopBroker(socket, 'synthetic-admin'), /Synthetic stop refused/);
        response = '{';
        await assert.rejects(stopBroker(socket, 'synthetic-admin'), SyntaxError);
    } finally {
        await new Promise<void>((resolvePromise, reject) => server.close(error => error ? reject(error) : resolvePromise()));
        await rm(root, { recursive: true, force: true });
    }
});

test('stop does not create an absent installation or hide a missing admin file', async () => {
    const fixture = await realpath(await mkdtemp('/tmp/naru-stop-installation-test-'));
    const absent = join(fixture, 'not-installed');
    const installed = join(fixture, 'installed-without-admin');
    const run = nodeSpawner(process.env);
    try {
        const missingInstallation = await run([process.execPath, join(built, 'tools', 'naru-preview.mjs'), '--root', absent, 'stop'], { cwd: fixture });
        assert.equal(missingInstallation.ok, false); assert.match(missingInstallation.stderr, /ENOENT|no such file/i);
        await assert.rejects(lstat(absent), { code: 'ENOENT' });
        await mkdir(installed, { mode: 0o700 });
        const missingAdmin = await run([process.execPath, join(built, 'tools', 'naru-preview.mjs'), '--root', installed, 'stop'], { cwd: fixture });
        assert.equal(missingAdmin.ok, false); assert.match(missingAdmin.stderr, /admin/);
    } finally { await rm(fixture, { recursive: true, force: true }); }
});

test('private commands reject caller connection overrides but retain login selection flags', () => {
    assert.doesNotThrow(() => assertNoPrivateConnectionFlags(['login', 'openai', '--method', 'chatgpt-browser', '--format', 'json']));
    for (const args of [['login', '--server', 'http://example.invalid'], ['login', '--server=http://example.invalid'], ['login', '--standalone'], ['login', '--hostname=0.0.0.0'], ['login', '--port', '1234']]) {
        assert.throws(() => assertNoPrivateConnectionFlags(args), /managed by Naru/);
    }
});

async function readinessApi(responses: unknown[]) {
    let integrationRequests = 0, modelRequests = 0;
    const server = (await import('node:http')).createServer((request, response) => {
        response.setHeader('content-type', 'application/json');
        if (request.url?.startsWith('/api/model/default')) { modelRequests++; response.end('{}'); return; }
        if (request.url?.startsWith('/api/integration')) {
            const value = responses[Math.min(integrationRequests++, responses.length - 1)];
            if (value === 'http-error') { response.writeHead(503).end('{}'); return; }
            if (value === 'malformed-json') { response.end('{'); return; }
            response.end(JSON.stringify(value)); return;
        }
        response.writeHead(404).end('{}');
    });
    await new Promise<void>(resolvePromise => server.listen(0, '127.0.0.1', resolvePromise));
    const address = server.address(); assert.ok(address && typeof address === 'object');
    return { url: `http://127.0.0.1:${address.port}`, counts: () => ({ integrationRequests, modelRequests }), close: () => new Promise<void>((resolvePromise, reject) => server.close(error => error ? reject(error) : resolvePromise())) };
}

test('auth readiness waits for an interactive method and uses model discovery only as a hint', async () => {
    const api = await readinessApi([{ data: [] }, { data: [{ methods: [{ type: 'env', names: ['FIXTURE_KEY'] }] }] }, { data: [{ methods: [{ type: 'oauth', id: 'fixture' }] }] }]);
    try {
        await waitForPreviewReadiness(api.url, '/synthetic/workspace', {}, 'auth', { deadlineMs: 1000, requestTimeoutMs: 100, pollIntervalMs: 5 });
        assert.deepEqual(api.counts(), { integrationRequests: 3, modelRequests: 1 });
    } finally { await api.close(); }
});

test('auth readiness accepts every interactive method in the pinned beta schema', async () => {
    for (const type of ['command', 'key', 'oauth']) {
        const api = await readinessApi([{ data: [{ methods: [{ type }] }] }]);
        try { await waitForPreviewReadiness(api.url, '/synthetic/workspace', {}, 'auth', { deadlineMs: 100, requestTimeoutMs: 20, pollIntervalMs: 5 }); }
        finally { await api.close(); }
    }
});

test('auth readiness fails closed at its deadline for empty and env-only catalogues', async () => {
    for (const response of [{ data: [] }, { data: [{ methods: [{ type: 'env', names: ['FIXTURE_KEY'] }] }] }]) {
        const api = await readinessApi([response]);
        try { await assert.rejects(waitForPreviewReadiness(api.url, '/synthetic/workspace', {}, 'auth', { deadlineMs: 40, requestTimeoutMs: 20, pollIntervalMs: 5 }), /readiness timed out/); }
        finally { await api.close(); }
    }
});

test('auth readiness rejects HTTP errors and malformed API responses', async () => {
    for (const response of ['http-error', 'malformed-json', { data: [{ methods: [{}] }] }, { data: [{ methods: [{ type: '' }] }] }, { data: [{ methods: [{ type: 'pending' }] }] }]) {
        const api = await readinessApi([response]);
        try { await assert.rejects(waitForPreviewReadiness(api.url, '/synthetic/workspace', {}, 'auth', { deadlineMs: 100, requestTimeoutMs: 20, pollIntervalMs: 5 }), /auth readiness failed/); }
        finally { await api.close(); }
    }
});

test('catalogue readiness uses the authenticated public activation endpoint with the exact location', async () => {
    const requests: Array<{ method: string | undefined; url: string | undefined; authorization: string | undefined }> = [];
    const server = (await import('node:http')).createServer((request, response) => {
        requests.push({ method: request.method, url: request.url, authorization: request.headers.authorization });
        response.writeHead(204).end();
    });
    await new Promise<void>(resolvePromise => server.listen(0, '127.0.0.1', resolvePromise));
    const address = server.address(); assert.ok(address && typeof address === 'object');
    try {
        await waitForPreviewReadiness(`http://127.0.0.1:${address.port}`, '/synthetic workspace/ü', { authorization: 'Basic synthetic' }, 'catalogue', { deadlineMs: 100, requestTimeoutMs: 100 });
        assert.deepEqual(requests, [{ method: 'POST', url: '/api/plugin/await-activation?location%5Bdirectory%5D=%2Fsynthetic%20workspace%2F%C3%BC', authorization: 'Basic synthetic' }]);
    } finally { await new Promise<void>((resolvePromise, reject) => server.close(error => error ? reject(error) : resolvePromise())); }
});

test('catalogue readiness requires an exact 204 response', async () => {
    const http = await import('node:http');
    const server = http.createServer((_request, response) => { response.writeHead(200).end('{}'); });
    await new Promise<void>(resolvePromise => server.listen(0, '127.0.0.1', resolvePromise));
    const address = server.address(); assert.ok(address && typeof address === 'object');
    try { await assert.rejects(waitForPreviewReadiness(`http://127.0.0.1:${address.port}`, '/fixture', {}, 'catalogue', { deadlineMs: 100, requestTimeoutMs: 50 }), /activation failed \(200\)/); }
    finally { server.closeAllConnections(); await new Promise<void>(resolvePromise => server.close(() => resolvePromise())); }
});

test('catalogue readiness bounds stalled requests by per-request and overall timeouts', async () => {
    for (const timing of [{ deadlineMs: 100, requestTimeoutMs: 20 }, { deadlineMs: 20, requestTimeoutMs: 100 }]) {
        const server = (await import('node:http')).createServer((_request, response) => { setTimeout(() => response.writeHead(204).end(), 60); });
        await new Promise<void>(resolvePromise => server.listen(0, '127.0.0.1', resolvePromise));
        const address = server.address(); assert.ok(address && typeof address === 'object');
        try { await assert.rejects(waitForPreviewReadiness(`http://127.0.0.1:${address.port}`, '/fixture', {}, 'catalogue', timing), /activation timed out/); }
        finally { await new Promise<void>(resolvePromise => server.close(() => resolvePromise())); }
    }
});

test('catalogue readiness rejects malformed HTTP responses', async () => {
    const malformed = (await import('node:net')).createServer(socket => socket.destroy());
    await new Promise<void>(resolvePromise => malformed.listen(0, '127.0.0.1', resolvePromise));
    const address = malformed.address(); assert.ok(address && typeof address === 'object');
    try {
        await assert.rejects(waitForPreviewReadiness(`http://127.0.0.1:${address.port}`, '/fixture', {}, 'catalogue', { deadlineMs: 100, requestTimeoutMs: 50 }), /activation failed/);
    } finally { await new Promise<void>(resolvePromise => malformed.close(() => resolvePromise())); }
});

test('structured catalogue uses providerID/id, filters ineligible entries, and redacts raw metadata', async () => {
    const requests: string[] = [];
    const server = (await import('node:http')).createServer((request, response) => {
        requests.push(request.url ?? ''); response.setHeader('content-type', 'application/json');
        if (request.url?.startsWith('/api/provider')) response.end(JSON.stringify({ location: {}, data: [
            { id: 'fixture', name: 'Fixture', activation: 'enabled', package: '@fixture/provider', credential: 'SYNTHETIC_SECRET' },
            { id: 'disabled', name: 'Disabled', activation: 'disabled', package: '@fixture/disabled' },
        ] }));
        else if (request.url?.startsWith('/api/model')) response.end(JSON.stringify({ location: {}, data: [
            { id: 'team/alpha', modelID: 'tool-worker-upstream', providerID: 'fixture', name: 'Tool Worker', capabilities: { tools: true, input: ['text'], output: ['text'] }, variants: [{ id: 'fast', settings: { secret: 'SYNTHETIC_SECRET' }, body: { token: 'SYNTHETIC_SECRET' } }], time: { released: 1 }, cost: [], status: 'active', enabled: true, limit: { context: 1000 } },
            { id: 'disabled_model', modelID: 'disabled-model', providerID: 'disabled', name: 'Disabled Model', capabilities: { tools: true, input: ['text'], output: ['text'] }, variants: [], time: { released: 1 }, cost: [], status: 'active', enabled: true, limit: { context: 1000 } },
            { id: 'no_tools', modelID: 'no-tools', providerID: 'fixture', name: 'No Tools', capabilities: { tools: false, input: ['text'], output: ['text'] }, variants: [], time: { released: 1 }, cost: [], status: 'active', enabled: true, limit: { context: 1000 } },
        ] }));
        else response.writeHead(404).end('{}');
    });
    await new Promise<void>(resolvePromise => server.listen(0, '127.0.0.1', resolvePromise));
    const address = server.address(); assert.ok(address && typeof address === 'object');
    try {
        const result = await fetchPreviewCatalogue(`http://127.0.0.1:${address.port}`, '/repo subdir', { authorization: 'Basic synthetic' });
        assert.deepEqual(result.models, [{ id: 'team/alpha', providerID: 'fixture', name: 'Tool Worker', reference: 'fixture/team/alpha', capabilities: { tools: true, input: ['text'], output: ['text'] }, variantIDs: ['fast'] }]);
        assert.equal(result.metadataFreshness, 'unknown'); assert.equal(result.accountAccess, 'unknown');
        assert.ok(requests.every(value => value.endsWith('location%5Bdirectory%5D=%2Frepo%20subdir')));
        assert.doesNotMatch(JSON.stringify(result), /tool-worker-upstream|SYNTHETIC_SECRET|credential|settings|body/);
    } finally { await new Promise<void>(resolvePromise => server.close(() => resolvePromise())); }
});

test('catalogue model IDs allow safe namespaces without weakening provider IDs or traversal checks', () => {
    for (const value of ['alpha', 'team/alpha', 'org/team/model:v2']) assert.equal(isSafeCatalogueModelID(value), true);
    for (const value of ['', '/alpha', 'alpha/', 'team//alpha', '.', '..', 'team/../alpha', 'team/./alpha', 'team/alpha#high', 'team/alpha\nspoof']) assert.equal(isSafeCatalogueModelID(value), false);
});

test('structured catalogue fails closed on duplicate IDs, malformed records, oversized bodies, and timeouts', async () => {
    const validProvider = { location: {}, data: [{ id: 'fixture', name: 'Fixture', activation: 'enabled', package: '@fixture/provider' }] };
    const validModel = { id: 'worker', modelID: 'upstream', providerID: 'fixture', name: 'Worker', capabilities: { tools: true, input: ['text'], output: ['text'] }, variants: [], time: { released: 1 }, cost: [], status: 'active', enabled: true, limit: { context: 1000 } };
    for (const mode of ['duplicate', 'malformed', 'oversized', 'timeout']) {
        const server = (await import('node:http')).createServer((request, response) => {
            if (mode === 'timeout') return void setTimeout(() => response.end('{}'), 100);
            response.setHeader('content-type', 'application/json');
            if (request.url?.startsWith('/api/provider')) response.end(JSON.stringify(validProvider));
            else if (mode === 'oversized') { response.setHeader('content-length', String(17 * 1024 * 1024)); response.end('{}'); }
            else response.end(JSON.stringify({ location: {}, data: mode === 'duplicate' ? [validModel, validModel] : [{ ...validModel, capabilities: { tools: 'yes', input: ['text'], output: ['text'] } }] }));
        });
        await new Promise<void>(resolvePromise => server.listen(0, '127.0.0.1', resolvePromise));
        const address = server.address(); assert.ok(address && typeof address === 'object');
        try { await assert.rejects(fetchPreviewCatalogue(`http://127.0.0.1:${address.port}`, '/repo', {}, { deadlineMs: 30, requestTimeoutMs: 20 }), /duplicate|invalid schema|byte limit|timed out/); }
        finally { server.closeAllConnections(); await new Promise<void>(resolvePromise => server.close(() => resolvePromise())); }
    }
});

test('catalogue diagnostics distinguish every eligibility filter from host absence without exposing raw fields', async () => {
    const provider = (id: string, activation: string) => ({ id, name: id, activation, package: `@fixture/${id}`, credential: 'SYNTHETIC_SECRET' });
    const model = (id: string, providerID = 'enabled', overrides: Record<string, unknown> = {}) => ({ id, modelID: `raw-${id}-SYNTHETIC_SECRET`, providerID, name: id, capabilities: { tools: true, input: ['text'], output: ['text'] }, variants: [], time: { released: 1 }, cost: [], status: 'active', enabled: true, limit: { context: 1000 }, ...overrides });
    const providers = [provider('enabled', 'enabled'), provider('disabled', 'disabled')];
    const models = [model('eligible'), model('provider_off', 'disabled'), model('model_off', 'enabled', { enabled: false }), model('old', 'enabled', { status: 'deprecated' }), model('no_tools', 'enabled', { capabilities: { tools: false, input: ['text'], output: ['text'] } }), model('no_text_in', 'enabled', { capabilities: { tools: true, input: ['image'], output: ['text'] } }), model('no_text_out', 'enabled', { capabilities: { tools: true, input: ['text'], output: ['image'] } })];
    const server = (await import('node:http')).createServer((request, response) => { response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ location: {}, data: request.url?.startsWith('/api/provider') ? providers : models })); });
    await new Promise<void>(resolvePromise => server.listen(0, '127.0.0.1', resolvePromise));
    const address = server.address(); assert.ok(address && typeof address === 'object');
    try {
        const catalogue = await fetchPreviewCatalogue(`http://127.0.0.1:${address.port}`, '/repo', {});
        assert.deepEqual(catalogue.entries?.map(entry => [entry.reference, entry.reason ?? 'eligible']), [
            ['enabled/eligible', 'eligible'], ['disabled/provider_off', 'provider-disabled'], ['enabled/model_off', 'model-disabled'], ['enabled/old', 'deprecated'], ['enabled/no_tools', 'tools-unsupported'], ['enabled/no_text_in', 'text-input-unsupported'], ['enabled/no_text_out', 'text-output-unsupported'],
        ]);
        const excluded = diagnosePreviewCatalogue('', catalogue, [{ reference: 'opencode-go/deepseek-v4.1-flash', name: 'DeepSeek V4.1 Flash' }]);
        assert.ok(excluded.matches.some(match => match.eligibility === 'absent-from-host-catalogue' && match.sourcePresence === 'source-present-host-absent'));
        assert.doesNotMatch(JSON.stringify(excluded), /raw-|SYNTHETIC_SECRET|credential|package/);
    } finally { await new Promise<void>(resolvePromise => server.close(() => resolvePromise())); }
});

test('exact catalogue diagnostics do not broaden references and report variant availability honestly', () => {
    const catalogue = { models: [{ id: 'worker', providerID: 'fixture', reference: 'fixture/worker', name: 'Worker', capabilities: { tools: true, input: ['text'], output: ['text'] }, variantIDs: ['fast'] }], providers: [], entries: [{ id: 'worker', upstreamModelID: 'upstream-worker', reference: 'fixture/worker', name: 'Worker', providerID: 'fixture', eligibility: 'eligible' as const, capabilities: { tools: true, input: ['text'], output: ['text'] }, limit: { context: 1000 }, releasedAt: 1, variantIDs: ['fast'] }], observedAt: 'synthetic', metadataFreshness: 'unknown' as const, accountAccess: 'unknown' as const };
    assert.equal(diagnoseExactPreviewCatalogue({ providerID: 'fixture', model: 'worker', variant: 'fast' }, catalogue).matches[0]?.variantAvailability, 'observed-in-host');
    const missing = diagnoseExactPreviewCatalogue({ providerID: 'fixture', model: 'worker', variant: 'missing' }, catalogue).matches[0];
    assert.equal(missing && 'reason' in missing ? missing.reason : undefined, 'variant-unavailable');
    assert.deepEqual(diagnoseExactPreviewCatalogue({ providerID: 'fixture', model: 'work' }, catalogue).matches.map(match => match.reference), ['fixture/work']);
    const sourceModes = [{ reference: 'fixture/worker', name: 'Worker' }, { reference: 'fixture/worker-fast', name: 'Worker Fast' }];
    const absentMode = diagnoseExactPreviewCatalogue({ providerID: 'fixture', model: 'worker-fast', variant: 'high' }, { ...catalogue, models: [], entries: [] }, sourceModes).matches[0];
    assert.deepEqual(absentMode, { reference: 'fixture/worker-fast#high', name: 'Worker Fast', eligibility: 'absent-from-host-catalogue', sourcePresence: 'source-present-host-absent', variantAvailability: 'unknown' });
    const unknownMode = diagnoseExactPreviewCatalogue({ providerID: 'fixture', model: 'worker-custom', variant: 'high' }, { ...catalogue, models: [], entries: [] }, sourceModes).matches[0];
    assert.equal(unknownMode && 'sourcePresence' in unknownMode ? unknownMode.sourcePresence : undefined, 'source-presence-unknown');
});

test('differential catalogue proof requires candidate-bound source metadata', () => {
    const source = [{ providerID: 'fixture', modelID: 'upstream-worker', reference: 'fixture/worker', name: 'Worker', tools: true, modalities: { input: ['text'], output: ['text'] }, limit: { context: 1000, output: 200 } }];
    const entry = { id: 'worker', upstreamModelID: 'upstream-worker', reference: 'fixture/worker', name: 'Worker', providerID: 'fixture', eligibility: 'eligible' as const, capabilities: { tools: true, input: ['text'], output: ['text'] }, limit: { context: 1000, output: 200 }, releasedAt: 1, variantIDs: [] };
    const catalogue = (entries: Array<typeof entry & { validationMode?: { cost: Array<{ input: number; output: number; cache: { read: number; write: number } }>; body?: { service_tier: 'priority' } } }>) => ({ models: entries.map(item => ({ id: item.id, providerID: item.providerID, reference: item.reference, name: item.name, capabilities: item.capabilities, variantIDs: item.variantIDs })), providers: [], entries, observedAt: 'synthetic', metadataFreshness: 'unknown' as const, accountAccess: 'unknown' as const });
    assert.deepEqual(differentialCatalogueWitness(source, catalogue([]), catalogue([entry])), { providerID: 'fixture', reference: 'fixture/worker', name: 'Worker', distinction: 'candidate-only' });
    assert.equal(differentialCatalogueWitness(source, catalogue([entry]), catalogue([entry])), null);
    assert.equal(differentialCatalogueWitness(source, catalogue([]), catalogue([{ ...entry, capabilities: { ...entry.capabilities, tools: false } }])), null);
    const mode = { id: 'fast', cost: [{ input: 8, output: 40, cache: { read: 0.8, write: 10 } }], body: { service_tier: 'priority' as const } };
    const modeSource = [{ ...source[0]!, reference: 'fixture/worker-fast', name: 'Worker Fast', mode }];
    const modeEntry = { ...entry, id: 'worker-fast', reference: 'fixture/worker-fast', name: 'Worker Fast', validationMode: { cost: mode.cost, body: mode.body } };
    assert.deepEqual(differentialCatalogueWitness(modeSource, catalogue([]), catalogue([modeEntry])), { providerID: 'fixture', reference: 'fixture/worker-fast', name: 'Worker Fast', distinction: 'candidate-only' });
    assert.equal(differentialCatalogueWitness(modeSource, catalogue([]), catalogue([{ ...modeEntry, upstreamModelID: 'worker-fast' }])), null);
    const sourceWithUnrelatedBaseWitness = [...source, ...modeSource];
    for (const invalidMode of [
        { cost: mode.cost },
        { cost: mode.cost, body: { service_tier: 'priority-other' as never } },
        { cost: [{ input: 7, output: 40, cache: { read: 0.8, write: 10 } }], body: mode.body },
    ]) assert.equal(differentialCatalogueWitness(sourceWithUnrelatedBaseWitness, catalogue([]), catalogue([entry, { ...modeEntry, validationMode: invalidMode }])), null);
});

test('structured catalogue rejects terminal control, ANSI, bidi, and incompatible reference identifiers', async () => {
    const baseProvider = { id: 'fixture', name: 'Fixture', activation: 'enabled', package: '@fixture/provider' };
    const baseModel = { id: 'worker', modelID: 'upstream-worker', providerID: 'fixture', name: 'Worker', capabilities: { tools: true, input: ['text'], output: ['text'] }, variants: [{ id: 'fast' }], time: { released: 1 }, cost: [], status: 'active', enabled: true, limit: { context: 1000 } };
    const cases = [
        { provider: { ...baseProvider, name: 'Trusted\n1. Spoof' }, model: baseModel },
        { provider: baseProvider, model: { ...baseModel, name: 'Trusted\u001b[2Jspoof' } },
        { provider: baseProvider, model: { ...baseModel, name: 'worker\u202Espoof' } },
        { provider: { ...baseProvider, id: 'fixture:spoof' }, model: { ...baseModel, providerID: 'fixture:spoof' } },
        { provider: baseProvider, model: { ...baseModel, variants: [{ id: 'fast:spoof' }] } },
        { provider: baseProvider, model: { ...baseModel, capabilities: { tools: true, input: ['text\rspoof'], output: ['text'] } } },
    ];
    for (const fixture of cases) {
        const server = (await import('node:http')).createServer((request, response) => {
            response.setHeader('content-type', 'application/json');
            response.end(JSON.stringify({ location: {}, data: request.url?.startsWith('/api/provider') ? [fixture.provider] : [fixture.model] }));
        });
        await new Promise<void>(resolvePromise => server.listen(0, '127.0.0.1', resolvePromise));
        const address = server.address(); assert.ok(address && typeof address === 'object');
        try { await assert.rejects(fetchPreviewCatalogue(`http://127.0.0.1:${address.port}`, '/repo', {}), /invalid schema/); }
        finally { await new Promise<void>(resolvePromise => server.close(() => resolvePromise())); }
    }
});

test('models output distinguishes settled empty catalogues, command failures, timeouts and truncation', () => {
    const empty = modelsOutput({ ok: true, code: 0, stdout: '', stderr: '' });
    assert.equal(empty.exitCode, 0); assert.match(empty.stderr, /catalogue settled.*no eligible models.*legitimate account state.*remain unknown/i);
    assert.doesNotMatch(empty.stderr, /credential/i);
    const failure = modelsOutput({ ok: false, code: 2, stdout: '', stderr: 'unknown option --fixture\n' });
    assert.deepEqual(failure, { stdout: '', stderr: 'unknown option --fixture\n', exitCode: 2 });
    const bounded = modelsOutput({ ok: false, code: null, stdout: 'partial', stderr: '', stdoutTruncated: true });
    assert.equal(bounded.stdout, 'partial'); assert.equal(bounded.exitCode, 1); assert.match(bounded.stderr, /stdout exceeded the capture limit/);
    const timeout = modelsOutput({ ok: false, code: null, stdout: '', stderr: '', timedOut: true });
    assert.match(timeout.stderr, /listing timed out/);
});

test('models listing activates an owned server then forwards argv with server after the command', async () => {
    const root = await realpath(await mkdtemp('/tmp/naru-model-listing-test-'));
    const executable = join(root, 'fake-opencode'), argvFile = join(root, 'argv');
    await writeFile(executable, `#!${process.execPath}\nconst fs=require('node:fs'),http=require('node:http');if(process.argv[2]==='serve'){const server=http.createServer((req,res)=>{if(req.method==='POST'&&req.url.startsWith('/api/plugin/await-activation?'))res.writeHead(204).end();else res.writeHead(404).end()});server.listen(0,'127.0.0.1',()=>console.log(JSON.stringify({url:'http://127.0.0.1:'+server.address().port})));setInterval(()=>{},1000)}else{fs.writeFileSync(process.env.ARGV_FILE,JSON.stringify(process.argv.slice(2)));process.stdout.write('fixture/fixture\\n')}\n`);
    await chmod(executable, 0o755);
    try {
        const result = await runModelsListing(executable, root, { ...process.env, ARGV_FILE: argvFile }, ['--format', 'json']);
        assert.equal(result.ok, true, result.stderr); assert.equal(result.stdout, 'fixture/fixture\n');
        const argv = JSON.parse(await readFile(argvFile, 'utf8'));
        assert.deepEqual(argv.slice(0, 3), ['models', '--format', 'json']);
        assert.equal(argv[3], '--server'); assert.match(argv[4], /^http:\/\/127\.0\.0\.1:\d+$/); assert.ok(!argv.includes('--standalone'));
    } finally { await rm(root, { recursive: true, force: true }); }
});

test('models help stays server-free and still rejects caller connection overrides', async () => {
    const root = await realpath(await mkdtemp('/tmp/naru-model-help-test-'));
    const executable = join(root, 'fake-opencode'), argvFile = join(root, 'argv');
    await writeFile(executable, `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(argvFile)},JSON.stringify(process.argv.slice(2)));process.stdout.write('synthetic models help\\n')\n`);
    await chmod(executable, 0o755);
    await writeFile(join(root, 'host.json'), JSON.stringify({ root, executable, executableHash: digest(await readFile(executable)), node: process.execPath, cli: join(built, 'tools', 'naru-preview.mjs') }));
    const run = nodeSpawner(process.env);
    try {
        const help = await run([process.execPath, join(built, 'tools', 'naru-preview.mjs'), '--root', root, 'models', '--help'], { cwd: root });
        assert.equal(help.ok, true, help.stderr); assert.equal(help.stdout, 'synthetic models help\n');
        assert.deepEqual(JSON.parse(await readFile(argvFile, 'utf8')), ['models', '--help']);
        const override = await run([process.execPath, join(built, 'tools', 'naru-preview.mjs'), '--root', root, 'models', '--help', '--server', 'http://example.invalid'], { cwd: root });
        assert.equal(override.ok, false); assert.match(override.stderr, /--server is managed by Naru/);
    } finally { await rm(root, { recursive: true, force: true }); }
});

test('the shared updater guard excludes startup and direct host launches', async () => {
    const root = await realpath(await mkdtemp('/tmp/naru-preview-update-guard-test-'));
    const executable = join(root, 'fake-opencode'), argvFile = join(root, 'argv');
    await writeFile(executable, `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(argvFile)},JSON.stringify(process.argv.slice(2)))\n`);
    await chmod(executable, 0o755);
    await writeFile(join(root, 'host.json'), JSON.stringify({ root, executable, executableHash: digest(await readFile(executable)), node: process.execPath, cli: join(built, 'tools', 'naru-preview.mjs') }));
    const guard = await acquirePreviewUpdateGuard(root), run = nodeSpawner(process.env);
    try {
        assert.deepEqual(JSON.parse(await readFile(join(root, 'start.lock', 'phase.json'), 'utf8')), {
            schemaVersion: 1, phase: 'preparing', recoveryPath: null, backupPaths: null, validatedBackups: false,
        });
        const backupPaths = { tools: '/synthetic/tools', host: '/synthetic/host', wrapper: '/synthetic/wrapper', launcher: '/synthetic/launcher' };
        await guard.setPhase({ phase: 'switching', recoveryPath: '/synthetic/recovery', backupPaths, validatedBackups: true });
        assert.deepEqual(JSON.parse(await readFile(join(root, 'start.lock', 'phase.json'), 'utf8')), {
            schemaVersion: 1, phase: 'switching', recoveryPath: '/synthetic/recovery', backupPaths, validatedBackups: true,
        });
        await assert.rejects(acquirePreviewUpdateGuard(root), /startup or update is already in progress/);
        for (const argv of [['models', '--help'], ['auth', '--help'], ['open', root], ['daemon']]) {
            const result = await run([process.execPath, join(built, 'tools', 'naru-preview.mjs'), '--root', root, ...argv], { cwd: root });
            assert.equal(result.ok, false, argv.join(' '));
            assert.match(result.stderr, /startup or update is already in progress/);
        }
        await assert.rejects(lstat(argvFile), { code: 'ENOENT' });
    } finally { await guard.release(); await rm(root, { recursive: true, force: true }); }
});

test('preview server keeps MCP readiness as its default and cleans up after auth and catalogue readiness failures', async () => {
    const root = await realpath(await mkdtemp('/tmp/naru-readiness-process-test-'));
    const executable = join(root, 'fake-opencode');
    const pidFile = join(root, 'pid');
    await writeFile(executable, `#!${process.execPath}\nconst http=require('node:http'),fs=require('node:fs');fs.writeFileSync(process.env.PID_FILE,String(process.pid));let requests=0;const server=http.createServer((req,res)=>{res.setHeader('content-type','application/json');if(req.method==='POST'&&req.url.startsWith('/api/plugin/await-activation')){res.writeHead(204).end();return}if(req.url.startsWith('/api/mcp')){requests++;res.end(JSON.stringify({data:[{name:'naru',status:{status:'connected'}}]}));return}if(req.url.startsWith('/api/model/default')){res.end('{}');return}if(req.url.startsWith('/api/integration')){res.end(JSON.stringify({data:[]}));return}res.writeHead(404).end('{}')});server.listen(0,'127.0.0.1',()=>console.log(JSON.stringify({url:'http://127.0.0.1:'+server.address().port})));setInterval(()=>{},1000);\n`);
    await chmod(executable, 0o755);
    try {
        const environment = { ...process.env, PID_FILE: pidFile };
        const server = await startPreviewServer(executable, root, environment, 'mcp', { deadlineMs: 1000, requestTimeoutMs: 100, pollIntervalMs: 110 });
        server.stop();
        await assert.rejects(startPreviewServer(executable, root, environment, 'auth', { deadlineMs: 50, requestTimeoutMs: 20, pollIntervalMs: 5 }), /readiness timed out|aborted due to timeout/);
        const catalogue = await startPreviewServer(executable, root, environment, 'catalogue', { deadlineMs: 50, requestTimeoutMs: 20 }); catalogue.stop();
        const pid = Number(await readFile(pidFile, 'utf8'));
        await new Promise(resolvePromise => setTimeout(resolvePromise, 20));
        assert.throws(() => process.kill(pid, 0));
    } finally { await rm(root, { recursive: true, force: true }); }
});

test('preview file access rejects secret paths, symlink escapes, and special files', async () => {
    const root = await realpath(await mkdtemp('/tmp/naru-path-test-'));
    try {
        await mkdir(join(root, 'repo')); await symlink('/tmp', join(root, 'repo', 'escape'));
        for (const path of ['../outside', '.env', '.env.production.local', '.env.template', '.env.example/nested', '.git/config', 'secrets/token.txt', 'credentials/service.json', 'keys/private.key', 'escape/file']) await assert.rejects(safeWorkspacePath(join(root, 'repo'), path, true));
        assert.equal(await safeWorkspacePath(join(root, 'repo'), '.env.example', true), join(root, 'repo', '.env.example'));
        assert.equal(await safeWorkspacePath(join(root, 'repo'), 'src/new.ts', true), join(root, 'repo', 'src/new.ts'));
    } finally { await rm(root, { recursive: true, force: true }); }
});

test('verification copies omit dependencies and every denied secret path, including aliases', async () => {
    const root = await realpath(await mkdtemp('/tmp/naru-copy-policy-test-'));
    try {
        const repository = join(root, 'repo'), snapshot = join(root, 'snapshot');
        await mkdir(join(repository, 'node_modules', 'fixture'), { recursive: true });
        await mkdir(join(repository, 'secrets'), { recursive: true });
        await mkdir(join(repository, 'credentials'), { recursive: true });
        await writeFile(join(repository, 'source.txt'), 'source');
        await writeFile(join(repository, '.env.example'), 'SAFE_TEMPLATE=true\n');
        await writeFile(join(repository, '.env.production.local'), 'SYNTHETIC_DENIED=true\n');
        await writeFile(join(repository, 'secrets', 'token.txt'), 'synthetic');
        await writeFile(join(repository, 'credentials', 'service.json'), '{}');
        await writeFile(join(repository, 'node_modules', 'fixture', 'index.js'), 'throw new Error()');
        await symlink('.env.production.local', join(repository, 'environment-alias'));
        await copyVerificationSnapshot(repository, snapshot);
        assert.equal(await readFile(join(snapshot, 'source.txt'), 'utf8'), 'source');
        assert.equal(await readFile(join(snapshot, '.env.example'), 'utf8'), 'SAFE_TEMPLATE=true\n');
        for (const path of ['.env.production.local', 'secrets', 'credentials', 'node_modules', 'environment-alias']) {
            await assert.rejects(lstat(join(snapshot, path)), { code: 'ENOENT' });
        }
        const oversized = join(repository, 'oversized.bin');
        await writeFile(oversized, '');
        await truncate(oversized, 512 * 1024 * 1024 + 1);
        await assert.rejects(copyVerificationSnapshot(repository, join(root, 'too-large')), /exceeds preview limits/);
    } finally { await rm(root, { recursive: true, force: true }); }
});

test('path containment and verification snapshot boundaries handle filesystem roots', async () => {
    assert.equal(pathContains('/', '/tmp/example'), true);
    assert.equal(pathContains('/tmp/example', '/'), false);
    assert.equal(pathContains('/tmp/example', '/tmp/example-child'), false);
    assert.equal(protectedPathContains('runtime/state', 'RUNTIME/state/child'), true);
    assert.equal(protectedPathContains('runtimé/state', `RUNTIM${'É'.normalize('NFD')}/state/child`), true);
    assert.equal(protectedPathContains('runtime/state', 'runtime/state-sibling'), false);
    const root = await mkdtemp('/tmp/naru-root-snapshot-test-');
    try { await assert.rejects(copyVerificationSnapshot('/', join(root, 'snapshot')), /filesystem root.*narrower/i); }
    finally { await rm(root, { recursive: true, force: true }); }
});

test('verification snapshots prune protected runtime and nested output before metadata reads', async () => {
    const root = await realpath(await mkdtemp('/tmp/naru-copy-runtime-test-'));
    try {
        const source = join(root, 'source'), runtime = join(source, 'RUNTIME-STATE'), normalizedAlias = join(source, `runtim${'é'.normalize('NFD')}`), output = join(source, 'output-scratch'), snapshot = join(root, 'snapshot');
        await mkdir(runtime, { recursive: true }); await mkdir(normalizedAlias); await mkdir(output); await writeFile(join(source, 'ordinary.txt'), 'ordinary'); await writeFile(join(runtime, 'marker.txt'), 'synthetic runtime marker'); await writeFile(join(normalizedAlias, 'marker.txt'), 'synthetic normalized marker'); await writeFile(join(output, 'partial.txt'), 'partial');
        await copyVerificationSnapshot(source, snapshot, ['runtime-state', 'runtimé', 'output-scratch']);
        assert.equal(await readFile(join(snapshot, 'ordinary.txt'), 'utf8'), 'ordinary');
        await assert.rejects(lstat(join(snapshot, 'RUNTIME-STATE')), { code: 'ENOENT' });
        await assert.rejects(lstat(join(snapshot, `runtim${'é'.normalize('NFD')}`)), { code: 'ENOENT' });
        await assert.rejects(lstat(join(snapshot, 'output-scratch')), { code: 'ENOENT' });
    } finally { await rm(root, { recursive: true, force: true }); }
});

test('runtime read roots reject shallow executables but allow the current Node installation', async () => {
    const root = await realpath(await mkdtemp('/tmp/naru-runtime-root-test-'));
    try {
        const shallow = join(root, 'node'); await writeFile(shallow, 'synthetic runtime');
        await assert.rejects(runtimeReadRoot(shallow), /too broad/);
        const current = await runtimeReadRoot(process.execPath);
        assert.ok(process.execPath.startsWith(current + '/'));
    } finally { await rm(root, { recursive: true, force: true }); }
});

test('approved integration uses captured bytes even if the writer worktree changes afterward', async () => {
    const root = await realpath(await mkdtemp('/tmp/naru-approved-integration-test-'));
    const repository = join(root, 'repo'); await mkdir(repository);
    const git = nodeSpawner(cleanProcessEnvironment(process.execPath));
    const runGit = async (cwd: string, argv: string[]) => { const result = await git(['git', ...argv], { cwd }); assert.equal(result.ok, true, result.stderr); return result.stdout; };
    try {
        await runGit(repository, ['init', '-q']); await runGit(repository, ['config', 'user.name', 'Fixture']); await runGit(repository, ['config', 'user.email', 'fixture@example.invalid']);
        await writeFile(join(repository, 'file.txt'), 'original\n'); await runGit(repository, ['add', 'file.txt']); await runGit(repository, ['commit', '-qm', 'fixture']);
        const registry: WorktreeRegistry = new Map();
        const run = await createWorktreeRun({ directory: repository, runId: 'approved-race', maxWriters: 1, worktreeRoot: join(root, 'worktrees'), spawn: git, stateRegistry: registry });
        const writer = await createWriterWorktree({ runId: 'approved-race', itemId: 'writer', ownedWriteScope: ['file.txt', 'new.txt'], spawn: git, stateRegistry: registry });
        await writeFile(join(writer.path, 'file.txt'), 'approved\n'); await writeFile(join(writer.path, 'new.txt'), 'approved new\n');
        const patch = await runGit(writer.path, ['diff', '--binary', '--full-index', '--no-ext-diff', 'HEAD', '--', '.']);
        const approved = { patch, changedPaths: ['file.txt', 'new.txt'], files: [{ path: 'new.txt', content: 'approved new\n' }] };
        const authorization = digest(JSON.stringify(approved)); assert.match(authorization, /^[a-f0-9]{64}$/);
        await writeFile(join(writer.path, 'file.txt'), 'unapproved\n'); await writeFile(join(writer.path, 'new.txt'), 'unapproved new\n');
        await integrateWriterWorktree({ runId: 'approved-race', itemId: 'writer', approved, spawn: git, stateRegistry: registry });
        await writeFile(join(run.integrationPath, 'file.txt'), 'unapproved integration\n');
        await writeFile(join(run.integrationPath, 'new.txt'), 'unapproved integration new\n');
        await finalizeWorktreeRun({ runId: 'approved-race', approved, spawn: git, stateRegistry: registry });
        assert.equal(await readFile(join(repository, 'file.txt'), 'utf8'), 'approved\n');
        assert.equal(await readFile(join(repository, 'new.txt'), 'utf8'), 'approved new\n');
    } finally { await rm(root, { recursive: true, force: true }); }
});

test('isolated checks may change their copy but cannot change/read outside files or use the network', { skip: process.platform !== 'darwin' }, async () => {
    const root = await realpath(await mkdtemp('/tmp/naru-containment-test-'));
    try {
        const repository = join(root, 'repo'); await mkdir(repository);
        await writeFile(join(repository, 'source.txt'), 'original');
        const outside = join(root, 'outside'); await writeFile(outside, 'private');
        const code = `const fs=require('fs'),assert=require('assert/strict'); fs.writeFileSync('source.txt','copy-only'); for(const f of [()=>fs.readFileSync(${JSON.stringify(outside)}),()=>fs.writeFileSync(${JSON.stringify(join(repository, 'source.txt'))},'escaped')]) assert.throws(f); const s=require('net').connect(1,'127.0.0.1');s.on('connect',()=>process.exit(9));s.on('error',e=>{assert.ok(['EPERM','EACCES'].includes(e.code));console.log('contained')});`;
        const result = await isolatedCheck(repository, [process.execPath, '-e', code], process.execPath, join(root, 'scratch'));
        assert.equal(result.ok, true, JSON.stringify(result)); assert.match(result.stdout, /contained/);
        assert.equal(await readFile(join(repository, 'source.txt'), 'utf8'), 'original');
    } finally { await rm(root, { recursive: true, force: true }); }
});

test('broker freezes one managed model source for a parent and later workers while the next parent uses the refreshed source', async () => {
    const root = await realpath(await mkdtemp('/tmp/naru-broker-model-source-test-')), repository = join(root, 'repo'), stateRoot = join(root, 'state');
    await mkdir(repository); await mkdir(stateRoot, { mode: 0o700 });
    const executable = join(root, 'fake-host'); await writeFile(executable, `#!${process.execPath}\nsetInterval(()=>{},1000)\n`); await chmod(executable, 0o755);
    const git = nodeSpawner(cleanProcessEnvironment(process.execPath));
    const runGit = async (argv: string[]) => { const result = await git(['git', ...argv], { cwd: repository }); assert.equal(result.ok, true, result.stderr); };
    const feed = (provider: string, id: string, name = id) => JSON.stringify({ [provider]: { id: provider, name: provider, env: ['FIXTURE_KEY'], npm: '@fixture/provider', models: { [id]: { id, name, release_date: '2026-09-11', attachment: false, reasoning: true, tool_call: true, limit: { context: 1000, output: 100 } } } } });
    const broker = new PreviewBroker({ root: stateRoot, executable, node: process.execPath, cli: join(built, 'tools', 'naru-preview.mjs') }, 'admin', { platform: 'darwin', arch: 'arm64' });
    try {
        await runGit(['init', '-q']); await runGit(['config', 'user.name', 'Fixture']); await runGit(['config', 'user.email', 'fixture@example.invalid']); await writeFile(join(repository, 'file.txt'), 'fixture'); await runGit(['add', '.']); await runGit(['commit', '-qm', 'fixture']);
        await broker.load(); await broker.request('admin', 'configure-global', { models: ['fixture/old'], expectedRevision: null }); await broker.request('admin', 'enroll', { path: repository, access: 'check', writeScopes: [], expectedRevision: null, expectedGlobalRevision: 1 });
        const oldSource = await refreshManagedModelSource(stateRoot, async () => {}, { fetch: (async () => new Response(feed('fixture', 'old'))) as typeof fetch });
        const first = await broker.request('admin', 'open', { path: repository }) as { env: NodeJS.ProcessEnv };
        const firstConfig = JSON.parse(await readFile(join(first.env.XDG_CONFIG_HOME!, 'opencode', 'opencode.json'), 'utf8')), control = firstConfig.mcp.servers.control.environment.NARU_PREVIEW_CAPABILITY;
        const newSource = await refreshManagedModelSource(stateRoot, async () => {}, { fetch: (async () => new Response(feed('opencode-go', 'deepseek-v4.1-flash', 'DeepSeek V4.1 Flash'))) as typeof fetch });
        assert.notEqual(oldSource.digest, newSource.digest);
        assert.ok((await readManagedModelFeed(newSource)).entries.some(entry => entry.reference === 'opencode-go/deepseek-v4.1-flash'));
        const task = await broker.request(control, 'start', { requestId: 'source-freeze', role: 'runner', model: 'fixture/old', prompt: 'synthetic' }) as { id: string };
        const attempt = JSON.parse(await readFile(join(stateRoot, 'hosts', task.id, 'attempt.json'), 'utf8'));
        assert.equal(first.env.OPENCODE_MODELS_PATH, oldSource.path); assert.equal(attempt.env.OPENCODE_MODELS_PATH, oldSource.path);
        assert.equal(first.env.NARU_PREVIEW_MODEL_SOURCE_SHA256, oldSource.digest); assert.equal(attempt.env.NARU_PREVIEW_MODEL_SOURCE_SHA256, oldSource.digest);
        const next = await broker.request('admin', 'open', { path: repository }) as { env: NodeJS.ProcessEnv };
        assert.equal(next.env.OPENCODE_MODELS_PATH, newSource.path); assert.equal(next.env.NARU_PREVIEW_MODEL_SOURCE_SHA256, newSource.digest);
        assert.deepEqual((await broker.request(control, 'status', {}) as { workerModelProfile: { models: string[] } }).workerModelProfile.models, ['fixture/old']);
    } finally { broker.shutdown(); await rm(root, { recursive: true, force: true }); }
});

test('broker enforces enrollment, leaf capabilities, exact routing, idempotency and restart revocation', async () => {
    const root = await realpath(await mkdtemp('/tmp/naru-broker-test-'));
    const node = process.execPath, git = nodeSpawner(cleanProcessEnvironment(node));
    const repository = join(root, 'repo'); await mkdir(repository);
    const runGit = async (argv: string[]) => { const value = await git(['git', ...argv], { cwd: repository }); assert.equal(value.ok, true, value.stderr); };
    const stateRoot = join(root, 'state'); await mkdir(stateRoot, { mode: 0o700 });
    const executable = join(root, 'fake-host');
    await writeFile(executable, `#!${node}\nsetInterval(()=>{},1000);\n`); await chmod(executable, 0o755);
    const host = { root: stateRoot, node, cli: join(built, 'tools', 'naru-preview.mjs'), executable };
    assert.equal(hostEnvironment(host, 'setup').OPENCODE_DB, hostEnvironment(host, 'worker').OPENCODE_DB);
    assert.notEqual(hostEnvironment(host, 'setup').XDG_CONFIG_HOME, hostEnvironment(host, 'worker').XDG_CONFIG_HOME);
    const broker = new PreviewBroker(host, 'admin-test-only');
    try {
        await runGit(['init', '-q']); await runGit(['config', 'user.name', 'Fixture']); await runGit(['config', 'user.email', 'fixture@example.invalid']);
        await mkdir(join(repository, 'secrets')); await mkdir(join(repository, 'credentials'));
        await writeFile(join(repository, 'file.txt'), 'original');
        await writeFile(join(repository, '.env.example'), 'SAFE_TEMPLATE=true\n');
        await writeFile(join(repository, '.env.production.local'), 'SYNTHETIC_DENIED=true\n');
        await writeFile(join(repository, 'secrets', 'token.txt'), 'synthetic');
        await writeFile(join(repository, 'credentials', 'service.json'), '{}');
        await writeFile(join(repository, 'invalid.bin'), Buffer.from([0xc3, 0x28]));
        await symlink('.env.production.local', join(repository, 'environment-alias'));
        await runGit(['add', '.']); await runGit(['commit', '-qm', 'fixture']);
        await broker.load();
        await assert.rejects(broker.request('untrusted', 'enroll', {}), /Capability/);
        await broker.request('admin-test-only', 'configure-global', { models: ['fixture/model'], expectedRevision: null });
        await broker.request('admin-test-only', 'enroll', { path: repository, access: 'write', writeScopes: ['file.txt'], expectedRevision: null, expectedGlobalRevision: 1 });
        const opened = await broker.request('admin-test-only', 'open', { path: repository }) as { env: NodeJS.ProcessEnv };
        const config = JSON.parse(await readFile(join(opened.env.XDG_CONFIG_HOME!, 'opencode', 'opencode.json'), 'utf8'));
        const control = config.mcp.servers.control.environment.NARU_PREVIEW_CAPABILITY;
        const repo = config.mcp.servers.repo.environment.NARU_PREVIEW_CAPABILITY;
        await assert.rejects(broker.request(control, 'configure-global', { models: ['fixture/forged'], expectedRevision: null, role: 'admin', _meta: { role: 'admin' } }), /not available to the orchestrator/);
        await assert.rejects(broker.request(control, 'setup-status', { path: repository }), /not available to the orchestrator/);
        await assert.rejects(broker.request(control, 'read', { path: 'file.txt' }), /orchestrator/);
        await assert.rejects(broker.request(repo, 'start', { requestId: 'forged', role: 'writer', model: 'fixture/model', prompt: 'work' }), /repository reader/);
        const listed = await broker.request(repo, 'files', {}) as { files: string[] };
        assert.ok(listed.files.includes('.env.example'));
        for (const denied of ['.env.production.local', 'secrets/token.txt', 'credentials/service.json', 'environment-alias']) assert.ok(!listed.files.includes(denied));
        await assert.rejects(broker.request(repo, 'read', { path: '.env.production.local' }), /secret/);
        await assert.rejects(broker.request(repo, 'read', { path: 'secrets/token.txt' }), /secret/);
        await assert.rejects(broker.request(repo, 'read', { path: 'environment-alias' }), /symlinks/);
        await assert.rejects(broker.request(repo, 'read', { path: 'invalid.bin' }), /UTF-8/);
        assert.equal((await broker.request(repo, 'read', { path: '.env.example' }) as { content: string }).content, 'SAFE_TEMPLATE=true\n');
        await assert.rejects(broker.request(control, 'integrate', {}), /not available/);
        await assert.rejects(broker.request(control, 'start', { requestId: 'reader', role: 'reader', model: 'fixture/model', prompt: 'inspect' }), /native subagents/);
        await assert.rejects(broker.request(control, 'start', { requestId: 'a', role: 'writer', model: 'other/model', prompt: 'work' }), /frozen worker pool/);
        const task = await broker.request(control, 'start', { requestId: 'a', role: 'writer', model: 'fixture/model', prompt: 'work' }) as { id: string; directory: string; state: string };
        assert.equal(task.state, 'running'); assert.notEqual(task.directory, repository);
        const again = await broker.request(control, 'start', { requestId: 'a', role: 'writer', model: 'fixture/model', prompt: 'work' }) as { id: string };
        assert.equal(again.id, task.id);
        const workerConfig = JSON.parse(await readFile(join(stateRoot, 'hosts', task.id, 'config', 'opencode', 'opencode.json'), 'utf8'));
        assert.deepEqual(Object.keys(workerConfig.mcp.servers), ['worker']);
        const worker = workerConfig.mcp.servers.worker.environment.NARU_PREVIEW_CAPABILITY;
        await assert.rejects(broker.request(worker, 'start', {}), /not available/);
        await assert.rejects(broker.request(worker, 'write', { path: 'other.txt', content: 'no', expectedHash: null }), /scope/);
        await assert.rejects(broker.request(worker, 'write', { path: '.env.production.local', content: 'no', expectedHash: digest('SYNTHETIC_DENIED=true\n') }), /scope|secret/);
        await assert.rejects(broker.request(worker, 'write', { path: 'file.txt', content: 'new', expectedHash: null }), /changed/);
        await broker.request(worker, 'write', { path: 'file.txt', content: 'new', expectedHash: digest('original') });
        assert.equal(await readFile(join(repository, 'file.txt'), 'utf8'), 'original');
        assert.equal(await readFile(join(task.directory, 'file.txt'), 'utf8'), 'new');
        const restarted = new PreviewBroker(host, 'admin-test-only'); await restarted.load();
        const status = await restarted.request('admin-test-only', 'status', {}) as { nativeReaders: { lifecycle: string }; managedWorkers: Array<{ state: string }> };
        assert.equal(status.nativeReaders.lifecycle, 'host-native'); assert.equal(status.managedWorkers[0]?.state, 'interrupted');
        await assert.rejects(restarted.request(worker, 'write', {}), /Capability/);
        await assert.rejects(restarted.request('admin-test-only', 'integrate', { id: task.id, digest: 'stale' }), /completed/);
    } finally {
        broker.shutdown();
        await new Promise(resolve => setTimeout(resolve, 100));
        await rm(root, { recursive: true, force: true });
    }
});

test('non-Git enrollment uses managed direct writers with atomic scoped CAS and no Git task operations', { skip: process.platform !== 'darwin' || process.arch !== 'arm64' }, async () => {
    const root = await realpath(await mkdtemp('/tmp/naru-direct-writer-test-')), workspace = join(root, 'workspace'), stateRoot = join(root, 'state');
    await mkdir(workspace); await mkdir(stateRoot, { mode: 0o700 });
    const cli = join(root, 'stub-cli.mjs'); await writeFile(cli, `process.on('disconnect',()=>process.exit(0));setInterval(()=>{},1000);\n`);
    const file = join(workspace, 'file.txt'); await writeFile(file, 'original', { mode: 0o640 });
    await writeFile(join(workspace, '.env.production.local'), 'SYNTHETIC_DENIED=true\n'); await symlink('/tmp', join(workspace, 'escape'));
    const broker = new PreviewBroker({ root: stateRoot, executable: process.execPath, node: process.execPath, cli }, 'admin', { platform: 'darwin', arch: 'arm64' });
    try {
        await broker.load(); await broker.request('admin', 'configure-global', { models: ['fixture/model'], expectedRevision: null });
        const runtimeOverlap = await broker.request('admin', 'setup-status', { path: stateRoot }) as { repository: { path: string }; blockers: string[] };
        assert.equal(runtimeOverlap.repository.path, stateRoot); assert.deepEqual(runtimeOverlap.blockers, []);
        const setup = await broker.request('admin', 'setup-status', { path: workspace }) as { repository: { path: string; kind: string; dirty: null } };
        assert.deepEqual(setup.repository, { path: workspace, kind: 'directory', dirty: null, enrollment: null, effectiveWorkerPool: null });
        const enrollment = await broker.request('admin', 'enroll', { path: workspace, kind: 'directory', access: 'write', writeScopes: ['file.txt', 'src/**', 'escape/**'], expectedRevision: null, expectedGlobalRevision: 1 }) as Enrollment;
        assert.equal(enrollment.kind, 'directory'); assert.ok(enrollment.rootIdentity);
        const opened = await broker.request('admin', 'open', { path: workspace }) as { env: NodeJS.ProcessEnv };
        const config = JSON.parse(await readFile(join(opened.env.XDG_CONFIG_HOME!, 'opencode', 'opencode.json'), 'utf8'));
        assert.equal(config.default_agent, 'naru'); assert.ok(config.agents.naru); assert.equal(config.agents['naru-preview'], undefined);
        const control = config.mcp.servers.control.environment.NARU_PREVIEW_CAPABILITY;
        const gitOperation = broker.git;
        (broker as unknown as { git: (...args: unknown[]) => never }).git = () => { throw new Error('Git must not run after directory enrollment'); };
        const task = await broker.request(control, 'start', { requestId: 'direct-one', role: 'writer', model: 'fixture/model', prompt: 'write' }) as { id: string; mode: string; directory: string };
        assert.equal(task.mode, 'direct'); assert.equal(task.directory, workspace);
        assert.equal((await broker.request(control, 'start', { requestId: 'direct-one', role: 'writer', model: 'fixture/model', prompt: 'write' }) as { id: string }).id, task.id);
        await assert.rejects(broker.request(control, 'start', { requestId: 'direct-one', role: 'writer', model: 'fixture/model', prompt: 'different work' }), /different work/);
        await assert.rejects(broker.request(control, 'start', { requestId: 'direct-two', role: 'writer', model: 'fixture/model', prompt: 'write' }), /direct writer is already active/);
        const workerConfig = JSON.parse(await readFile(join(stateRoot, 'hosts', task.id, 'config', 'opencode', 'opencode.json'), 'utf8'));
        const worker = workerConfig.mcp.servers.worker.environment.NARU_PREVIEW_CAPABILITY;
        assert.match(JSON.parse(await readFile(join(stateRoot, 'hosts', task.id, 'attempt.json'), 'utf8')).argv.join(' '), /--agent naru/);
        await assert.rejects(broker.request(worker, 'write', { path: 'file.txt', content: 'stale', expectedHash: null }), /changed since inspection/);
        await broker.request(worker, 'write', { path: 'file.txt', content: 'changed', expectedHash: digest('original') });
        assert.equal(await readFile(file, 'utf8'), 'changed'); assert.equal((await lstat(file)).mode & 0o777, 0o640);
        await assert.rejects(broker.request(worker, 'write', { path: 'file.txt', content: 'raced', expectedHash: digest('original') }), /changed since inspection/);
        await assert.rejects(broker.request(worker, 'write', { path: 'outside.txt', content: 'no', expectedHash: null }), /scope/);
        await assert.rejects(broker.request(worker, 'write', { path: '.env.production.local', content: 'no', expectedHash: digest('SYNTHETIC_DENIED=true\n') }), /scope|secret/);
        await assert.rejects(broker.request(worker, 'write', { path: 'escape/file.txt', content: 'no', expectedHash: null }), /scope|symlink/);
        assert.equal((await broker.request(worker, 'check', { argv: [process.execPath, '-e', "require('node:fs').accessSync('file.txt')"] }) as { ok: boolean }).ok, true);
        const cancelled = await broker.request(control, 'cancel', { id: task.id }) as { state: string; warning: string };
        assert.equal(cancelled.state, 'cancelled'); assert.match(cancelled.warning, /partial edits may remain/);
        const internals = broker as unknown as { state: { tasks: Array<{ id: string; state: string }> } };
        internals.state.tasks.find(value => value.id === task.id)!.state = 'completed';
        const bundle = await broker.request('admin', 'bundle', { id: task.id }) as { mode: string; applied: boolean; message: string };
        assert.equal(bundle.mode, 'direct'); assert.equal(bundle.applied, true); assert.match(bundle.message, /not a multi-file transaction/i);
        assert.match(JSON.stringify(await broker.request('admin', 'integrate', { id: task.id })), /already applied/);
        (broker as unknown as { git: typeof gitOperation }).git = gitOperation;
        await rename(workspace, join(root, 'replaced-workspace')); await mkdir(workspace);
        await assert.rejects(broker.request('admin', 'open', { path: workspace }), /identity changed/);
    } finally { broker.shutdown(); await new Promise(resolve => setTimeout(resolve, 30)); await rm(root, { recursive: true, force: true }); }
});

test('broker opens ancestor and runtime workspaces while enforcing protected filesystem capabilities', { skip: process.platform !== 'darwin' || process.arch !== 'arm64' }, async () => {
    const root = await realpath(await mkdtemp('/tmp/naru-overlap-policy-test-')), workspace = join(root, 'workspace'), stateRoot = join(workspace, 'runtime-state');
    await mkdir(stateRoot, { recursive: true, mode: 0o700 }); await writeFile(join(workspace, 'ordinary.txt'), 'ordinary'); await writeFile(join(stateRoot, 'marker.txt'), 'synthetic runtime marker');
    const cli = join(root, 'stub-cli.mjs'); await writeFile(cli, `process.on('disconnect',()=>process.exit(0));setInterval(()=>{},1000);\n`);
    const broker = new PreviewBroker({ root: stateRoot, executable: process.execPath, node: process.execPath, cli }, 'admin', { platform: 'darwin', arch: 'arm64' });
    try {
        await broker.load(); await broker.request('admin', 'configure-global', { models: ['fixture/model'], expectedRevision: null });
        await broker.request('admin', 'enroll', { path: workspace, kind: 'directory', access: 'write', writeScopes: ['**'], expectedRevision: null, expectedGlobalRevision: 1 });
        const opened = await broker.request('admin', 'open', { path: workspace }) as { env: NodeJS.ProcessEnv };
        const config = JSON.parse(await readFile(join(opened.env.XDG_CONFIG_HOME!, 'opencode', 'opencode.json'), 'utf8'));
        const repo = config.mcp.servers.repo.environment.NARU_PREVIEW_CAPABILITY, control = config.mcp.servers.control.environment.NARU_PREVIEW_CAPABILITY;
        const listed = await broker.request(repo, 'files', {}) as { files: string[] };
        assert.ok(listed.files.includes('ordinary.txt')); assert.ok(!listed.files.some(path => path === 'runtime-state' || path.startsWith('runtime-state/')));
        await assert.rejects(broker.request(repo, 'read', { path: 'RUNTIME-STATE/marker.txt' }), /protected Naru runtime state/);
        const task = await broker.request(control, 'start', { requestId: 'ancestor-writer', role: 'writer', model: 'fixture/model', prompt: 'synthetic' }) as { id: string };
        const workerConfig = JSON.parse(await readFile(join(stateRoot, 'hosts', task.id, 'config', 'opencode', 'opencode.json'), 'utf8'));
        const worker = workerConfig.mcp.servers.worker.environment.NARU_PREVIEW_CAPABILITY;
        await assert.rejects(broker.request(worker, 'write', { path: 'RUNTIME-STATE/marker.txt', content: 'changed', expectedHash: digest('synthetic runtime marker') }), /protected Naru runtime state/);
        assert.equal(await readFile(join(stateRoot, 'marker.txt'), 'utf8'), 'synthetic runtime marker');
        const check = await broker.request(worker, 'check', { argv: [process.execPath, '-e', "const fs=require('fs');if(fs.existsSync('runtime-state'))process.exit(9)"] }) as { ok: boolean };
        assert.equal(check.ok, true, JSON.stringify(check));
        await broker.request('admin', 'cancel', { id: task.id });

        await broker.request('admin', 'enroll', { path: stateRoot, kind: 'directory', access: 'write', writeScopes: ['**'], expectedRevision: null, expectedGlobalRevision: 1 });
        const inside = await broker.request('admin', 'open', { path: stateRoot }) as { env: NodeJS.ProcessEnv };
        const insideConfig = JSON.parse(await readFile(join(inside.env.XDG_CONFIG_HOME!, 'opencode', 'opencode.json'), 'utf8'));
        const insideRepo = insideConfig.mcp.servers.repo.environment.NARU_PREVIEW_CAPABILITY, insideControl = insideConfig.mcp.servers.control.environment.NARU_PREVIEW_CAPABILITY;
        assert.deepEqual(await broker.request(insideRepo, 'files', {}), { files: [], truncated: false });
        await assert.rejects(broker.request(insideRepo, 'read', { path: 'marker.txt' }), /Filesystem access is disabled/);
        const insideTask = await broker.request(insideControl, 'start', { requestId: 'inside-writer', role: 'writer', model: 'fixture/model', prompt: 'synthetic' }) as { id: string };
        const insideWorkerConfig = JSON.parse(await readFile(join(stateRoot, 'hosts', insideTask.id, 'config', 'opencode', 'opencode.json'), 'utf8'));
        const insideWorker = insideWorkerConfig.mcp.servers.worker.environment.NARU_PREVIEW_CAPABILITY;
        await assert.rejects(broker.request(insideWorker, 'write', { path: 'marker.txt', content: 'changed', expectedHash: digest('synthetic runtime marker') }), /Filesystem access is disabled/);
        await assert.rejects(broker.request(insideWorker, 'check', { argv: [process.execPath, '-e', 'process.exit(0)'] }), /Filesystem access is disabled/);
    } finally { broker.shutdown(); await new Promise(resolve => setTimeout(resolve, 30)); await rm(root, { recursive: true, force: true }); }
});

test('broker rejects a real case alias of nested runtime state on case-insensitive volumes', async t => {
    const root = await realpath(await mkdtemp('/tmp/naru-case-alias-test-')), workspace = join(root, 'workspace'), stateRoot = join(workspace, 'runtime-state');
    await mkdir(stateRoot, { recursive: true, mode: 0o700 }); await writeFile(join(stateRoot, 'marker.txt'), 'synthetic runtime marker');
    let aliasInfo;
    try { aliasInfo = await lstat(join(workspace, 'RUNTIME-STATE', 'marker.txt')); }
    catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'ENOENT') { t.skip('temporary volume is case-sensitive'); await rm(root, { recursive: true, force: true }); return; }
        throw error;
    }
    assert.equal(aliasInfo.isFile(), true);
    const broker = new PreviewBroker({ root: stateRoot, executable: process.execPath, node: process.execPath, cli: join(built, 'tools', 'naru-preview.mjs') }, 'admin');
    try {
        await broker.load(); await broker.request('admin', 'configure-global', { models: ['fixture/model'], expectedRevision: null });
        await broker.request('admin', 'enroll', { path: workspace, kind: 'directory', access: 'inspect', writeScopes: [], expectedRevision: null, expectedGlobalRevision: 1 });
        const opened = await broker.request('admin', 'open', { path: workspace }) as { env: NodeJS.ProcessEnv };
        const config = JSON.parse(await readFile(join(opened.env.XDG_CONFIG_HOME!, 'opencode', 'opencode.json'), 'utf8')), repo = config.mcp.servers.repo.environment.NARU_PREVIEW_CAPABILITY;
        await assert.rejects(broker.request(repo, 'read', { path: 'RUNTIME-STATE/marker.txt' }), /protected Naru runtime state/);
        const listed = await broker.request(repo, 'files', {}) as { files: string[] };
        assert.ok(!listed.files.some(path => protectedPathContains('runtime-state', path)));
    } finally { broker.shutdown(); await rm(root, { recursive: true, force: true }); }
});

test('broker file listing is bounded by visited entries even when contains has no matches', async () => {
    const root = await realpath(await mkdtemp('/tmp/naru-list-bound-test-')), workspace = join(root, 'workspace'), stateRoot = join(root, 'state');
    await mkdir(workspace); await mkdir(stateRoot, { mode: 0o700 });
    const broker = new PreviewBroker({ root: stateRoot, executable: process.execPath, node: process.execPath, cli: join(built, 'tools', 'naru-preview.mjs') }, 'admin');
    try {
        await broker.load(); await broker.request('admin', 'configure-global', { models: ['fixture/model'], expectedRevision: null });
        await broker.request('admin', 'enroll', { path: workspace, kind: 'directory', access: 'inspect', writeScopes: [], expectedRevision: null, expectedGlobalRevision: 1 });
        const opened = await broker.request('admin', 'open', { path: workspace }) as { env: NodeJS.ProcessEnv };
        const config = JSON.parse(await readFile(join(opened.env.XDG_CONFIG_HOME!, 'opencode', 'opencode.json'), 'utf8'));
        const repo = config.mcp.servers.repo.environment.NARU_PREVIEW_CAPABILITY;
        const blocked = join(workspace, 'blocked'); await mkdir(blocked); await chmod(blocked, 0);
        assert.deepEqual(await broker.request(repo, 'files', { contains: 'absent-needle' }), { files: [], truncated: false });
        await chmod(blocked, 0o700);
        await Promise.all(Array.from({ length: 10010 }, (_, index) => writeFile(join(workspace, `entry-${index}`), 'x')));
        assert.deepEqual(await broker.request(repo, 'files', { contains: 'absent-needle' }), { files: [], truncated: true });
    } finally { broker.shutdown(); await rm(root, { recursive: true, force: true }); }
});

test('Git workers project runtime exclusions and integrate literal metacharacter paths', { skip: process.platform !== 'darwin' || process.arch !== 'arm64' }, async () => {
    const root = await realpath(await mkdtemp('/tmp/naru-git-runtime-policy-test-')), repository = join(root, 'repo'), stateRoot = join(repository, 'runtime-state');
    const metacharacterPath = ':literal.txt';
    await mkdir(repository); const git = nodeSpawner(cleanProcessEnvironment(process.execPath));
    const runGit = async (argv: string[]) => { const result = await git(['git', ...argv], { cwd: repository }); assert.equal(result.ok, true, result.stderr); };
    await runGit(['init', '-q']); await runGit(['config', 'user.name', 'Fixture']); await runGit(['config', 'user.email', 'fixture@example.invalid']);
    await writeFile(join(repository, '.gitignore'), 'runtime-state/\n'); await writeFile(join(repository, 'ordinary.txt'), 'original'); await writeFile(join(repository, metacharacterPath), 'literal original'); await runGit(['add', '.']); await runGit(['commit', '-qm', 'fixture']);
    await mkdir(stateRoot, { mode: 0o700 }); await writeFile(join(stateRoot, 'marker.txt'), 'synthetic runtime marker');
    const cli = join(root, 'stub-cli.mjs'); await writeFile(cli, `process.on('disconnect',()=>process.exit(0));setInterval(()=>{},1000);\n`);
    const broker = new PreviewBroker({ root: stateRoot, executable: process.execPath, node: process.execPath, cli }, 'admin', { platform: 'darwin', arch: 'arm64' });
    try {
        await broker.load(); await broker.request('admin', 'configure-global', { models: ['fixture/model'], expectedRevision: null });
        await broker.request('admin', 'enroll', { path: repository, kind: 'git', access: 'write', writeScopes: ['**'], expectedRevision: null, expectedGlobalRevision: 1 });
        const opened = await broker.request('admin', 'open', { path: repository }) as { env: NodeJS.ProcessEnv };
        const config = JSON.parse(await readFile(join(opened.env.XDG_CONFIG_HOME!, 'opencode', 'opencode.json'), 'utf8')), control = config.mcp.servers.control.environment.NARU_PREVIEW_CAPABILITY;
        const task = await broker.request(control, 'start', { requestId: 'git-writer', role: 'writer', model: 'fixture/model', prompt: 'synthetic' }) as { id: string; directory: string };
        assert.ok(task.directory.startsWith(stateRoot + '/'));
        const workerConfig = JSON.parse(await readFile(join(stateRoot, 'hosts', task.id, 'config', 'opencode', 'opencode.json'), 'utf8')), worker = workerConfig.mcp.servers.worker.environment.NARU_PREVIEW_CAPABILITY;
        await broker.request(worker, 'write', { path: 'ordinary.txt', content: 'approved', expectedHash: digest('original') });
        await broker.request(worker, 'write', { path: metacharacterPath, content: 'literal approved', expectedHash: digest('literal original') });
        await assert.rejects(broker.request(worker, 'write', { path: 'RUNTIME-STATE/new.txt', content: 'denied', expectedHash: null }), /protected Naru runtime state/);
        await mkdir(join(task.directory, 'RUNTIME-STATE')); await writeFile(join(task.directory, 'RUNTIME-STATE', 'synthetic.txt'), 'must not enter bundle');
        const internals = broker as unknown as { state: { tasks: Array<{ id: string; state: string }> } }; internals.state.tasks.find(value => value.id === task.id)!.state = 'completed';
        const bundle = await broker.request('admin', 'bundle', { id: task.id }) as { digest: string; changedPaths: string[]; files: unknown[] };
        assert.deepEqual(bundle.changedPaths, [metacharacterPath, 'ordinary.txt']); assert.deepEqual(bundle.files, []);
        await rm(join(task.directory, 'RUNTIME-STATE'), { recursive: true });
        await broker.request('admin', 'integrate', { id: task.id, digest: bundle.digest });
        assert.equal(await readFile(join(repository, 'ordinary.txt'), 'utf8'), 'approved'); assert.equal(await readFile(join(repository, metacharacterPath), 'utf8'), 'literal approved'); assert.equal(await readFile(join(stateRoot, 'marker.txt'), 'utf8'), 'synthetic runtime marker');
    } finally { broker.shutdown(); await new Promise(resolve => setTimeout(resolve, 30)); await rm(root, { recursive: true, force: true }); }
});

test('atomic direct writes reject concurrent metadata changes and never replace a concurrently created target', async () => {
    const root = await realpath(await mkdtemp('/tmp/naru-safe-write-test-'));
    try {
        const existing = join(root, 'existing.txt'); await writeFile(existing, 'original', { mode: 0o640 });
        const rootIdentity = await directoryIdentity(root);
        await assert.rejects(atomicWorkspaceWrite(root, rootIdentity, 'existing.txt', 'replacement', digest('original'), {
            beforeCommitValidation: () => chmod(existing, 0o600),
        }), /changed since inspection/);
        assert.equal(await readFile(existing, 'utf8'), 'original'); assert.equal((await lstat(existing)).mode & 0o777, 0o600);

        const created = join(root, 'created.txt');
        await assert.rejects(atomicWorkspaceWrite(root, rootIdentity, 'created.txt', 'replacement', null, {
            beforeInstall: () => writeFile(created, 'external', { flag: 'wx' }),
        }), /changed since inspection/);
        assert.equal(await readFile(created, 'utf8'), 'external');
    } finally { await rm(root, { recursive: true, force: true }); }
});

test('atomic direct writes revalidate an existing ancestor immediately before creating a parent', async () => {
    const root = await realpath(await mkdtemp('/tmp/naru-safe-parent-race-test-'));
    try {
        const ancestor = join(root, 'ancestor'), moved = join(root, 'moved'); await mkdir(ancestor);
        const rootIdentity = await directoryIdentity(root);
        await assert.rejects(atomicWorkspaceWrite(root, rootIdentity, 'ancestor/new/file.txt', 'replacement', null, {
            beforeParentCreate: async path => {
                assert.equal(path, join(ancestor, 'new'));
                await rename(ancestor, moved); await mkdir(ancestor);
            },
        }), /parent changed before directory creation/);
        await assert.rejects(lstat(join(ancestor, 'new')), { code: 'ENOENT' });
        await assert.rejects(lstat(join(moved, 'new')), { code: 'ENOENT' });
    } finally { await rm(root, { recursive: true, force: true }); }
});

test('broker migrates validated v1 access without model overrides, reports canonical setup state, and enforces policy CAS', async () => {
    const root = await realpath(await mkdtemp('/tmp/naru-broker-policy-test-'));
    const repository = join(root, 'repo'), subdir = join(repository, 'subdir'), stateRoot = join(root, 'state');
    await mkdir(subdir, { recursive: true }); await mkdir(stateRoot, { mode: 0o700 });
    const git = nodeSpawner(cleanProcessEnvironment(process.execPath));
    const runGit = async (argv: string[]) => { const result = await git(['git', ...argv], { cwd: repository }); assert.equal(result.ok, true, result.stderr); };
    const host = { root: stateRoot, executable: process.execPath, node: process.execPath, cli: join(built, 'tools', 'naru-preview.mjs') };
    try {
        await runGit(['init', '-q']); await runGit(['config', 'user.name', 'Fixture']); await runGit(['config', 'user.email', 'fixture@example.invalid']); await writeFile(join(repository, 'tracked.txt'), 'tracked'); await runGit(['add', '.']); await runGit(['commit', '-qm', 'fixture']);
        await writeFile(join(stateRoot, 'state.json'), JSON.stringify({ schemaVersion: 1, repositories: [
            { path: repository, models: ['fixture/check'], writeScopes: [] },
            { path: '/legacy/write', models: ['fixture/write'], writeScopes: ['src/**'] },
        ], tasks: [] }));
        const broker = new PreviewBroker(host, 'admin'); await broker.load();
        const migrated = JSON.parse(await readFile(join(stateRoot, 'state.json'), 'utf8'));
        assert.equal(migrated.schemaVersion, 6); assert.equal(migrated.globalWorkerPool, null); assert.deepEqual(migrated.globalInstructions, { revision: 0, source: null }); assert.deepEqual(migrated.repositories[0], { path: repository, kind: 'git', access: 'check', writeScopes: [], revision: 1 });
        assert.deepEqual(migrated.repositories[1], { path: '/legacy/write', kind: 'git', access: 'write', writeScopes: ['src/**'], revision: 1 });
        const setup = await broker.request('admin', 'setup-status', { path: subdir }) as { repository: { path: string; dirty: boolean; enrollment: { revision: number } }; maximumAccess: string };
        assert.equal(setup.repository.path, await realpath(repository)); assert.equal(setup.repository.dirty, false); assert.equal(setup.repository.enrollment.revision, 1);
        const alias = join(root, 'repo-alias'); await symlink(repository, alias);
        const aliased = await broker.request('admin', 'setup-status', { path: join(alias, 'subdir') }) as { repository: { path: string } }; assert.equal(aliased.repository.path, await realpath(repository));
        await assert.rejects(broker.request('admin', 'open', { path: repository }), /Global worker models are not configured/);
        await broker.request('admin', 'configure-global', { models: ['fixture/global'], expectedRevision: null });
        await assert.rejects(broker.request('admin', 'enroll', { path: repository, models: ['fixture/injected'], access: 'inspect', writeScopes: [], expectedRevision: 1, expectedGlobalRevision: 1 }), /unknown fields: models/);
        await assert.rejects(broker.request('admin', 'enroll', { path: repository, workerPool: { source: 'repository', models: ['fixture/injected'] }, access: 'inspect', writeScopes: [], expectedRevision: 1, expectedGlobalRevision: 1 }), /unknown fields: workerPool/);
        await assert.rejects(broker.request('admin', 'enroll', { path: repository, access: 'inspect', writeScopes: [], expectedRevision: null, expectedGlobalRevision: 1 }), /changed since setup status/);
        const unchanged = await broker.request('admin', 'setup-status', { path: repository }) as { repository: { enrollment: Enrollment } }; assert.equal(unchanged.repository.enrollment.access, 'check');
        const updated = await broker.request('admin', 'enroll', { path: repository, access: 'inspect', writeScopes: [], expectedRevision: 1, expectedGlobalRevision: 1 }) as { revision: number };
        assert.equal(updated.revision, 2);
        await assert.rejects(broker.request('admin', 'enroll', { path: repository, access: 'inspect', writeScopes: [], expectedRevision: 1, expectedGlobalRevision: 1 }), /changed since setup status/);
        const profile = await broker.request('admin', 'open', { path: repository }) as { env: NodeJS.ProcessEnv };
        const hostConfig = JSON.parse(await readFile(join(profile.env.XDG_CONFIG_HOME!, 'opencode', 'opencode.json'), 'utf8'));
        const repo = hostConfig.mcp.servers.repo.environment.NARU_PREVIEW_CAPABILITY, control = hostConfig.mcp.servers.control.environment.NARU_PREVIEW_CAPABILITY;
        assert.equal((await broker.request(repo, 'read', { path: 'tracked.txt' }) as { content: string }).content, 'tracked');
        await assert.rejects(broker.request(control, 'start', { requestId: 'runner', role: 'runner', model: 'fixture/global', prompt: 'check' }), /inspect workers only/);
        assert.equal(maximumPreviewAccess('linux', 'arm64'), 'inspect'); assert.equal(maximumPreviewAccess('darwin', 'x64'), 'inspect'); assert.equal(maximumPreviewAccess('darwin', 'arm64'), 'write');
        await writeFile(join(repository, 'dirty.txt'), 'dirty');
        const dirty = await broker.request('admin', 'setup-status', { path: repository }) as { repository: { dirty: boolean } }; assert.equal(dirty.repository.dirty, true);
    } finally { await rm(root, { recursive: true, force: true }); }
});

test('global worker policy is admin-only, CAS-bound, inherited explicitly, and frozen per open session', async () => {
    const root = await realpath(await mkdtemp('/tmp/naru-global-worker-policy-test-')), repository = join(root, 'repo'), stateRoot = join(root, 'state');
    await mkdir(repository); await mkdir(stateRoot, { mode: 0o700 });
    const git = nodeSpawner(cleanProcessEnvironment(process.execPath));
    const runGit = async (argv: string[]) => { const result = await git(['git', ...argv], { cwd: repository }); assert.equal(result.ok, true, result.stderr); };
    const broker = new PreviewBroker({ root: stateRoot, executable: process.execPath, node: process.execPath, cli: '/fixture/cli' }, 'admin');
    try {
        await runGit(['init', '-q']); await runGit(['config', 'user.name', 'Fixture']); await runGit(['config', 'user.email', 'fixture@example.invalid']); await writeFile(join(repository, 'tracked.txt'), 'tracked'); await runGit(['add', '.']); await runGit(['commit', '-qm', 'fixture']); await broker.load();
        await assert.rejects(broker.request('forged', 'configure-global', { models: ['fixture/a'], expectedRevision: null, role: 'admin', _meta: { role: 'admin' } }), /Capability/);
        await assert.rejects(broker.request('admin', 'enroll', { path: repository, access: 'inspect', writeScopes: [], expectedRevision: null, expectedGlobalRevision: 0 }), /not configured/);
        await assert.rejects(broker.request('admin', 'configure-global', { models: [], expectedRevision: null }), /1 to 32/);
        for (const models of [['fixture/../model'], ['fixture/a', 'fixture/a'], Array.from({ length: 33 }, (_, index) => `fixture/model-${index}`)]) await assert.rejects(broker.request('admin', 'configure-global', { models, expectedRevision: null }), /1 to 32/);
        const first = await broker.request('admin', 'configure-global', { models: ['fixture/a'], expectedRevision: null }) as { revision: number };
        assert.equal(first.revision, 1);
        await assert.rejects(broker.request('admin', 'configure-global', { models: ['fixture/stale'], expectedRevision: null }), /changed since setup status/);
        await assert.rejects(broker.request('admin', 'enroll', { path: repository, access: 'inspect', writeScopes: [], expectedRevision: null, expectedGlobalRevision: 0 }), /changed since setup status/);
        await broker.request('admin', 'enroll', { path: repository, access: 'check', writeScopes: [], expectedRevision: null, expectedGlobalRevision: 1 });
        const oldProfile = await broker.request('admin', 'open', { path: repository }) as { cwd: string; env: NodeJS.ProcessEnv };
        await broker.request('admin', 'configure-global', { models: ['fixture/b'], expectedRevision: 1 });
        const newProfile = await broker.request('admin', 'open', { path: repository }) as { cwd: string; env: NodeJS.ProcessEnv };
        assert.notEqual(oldProfile.env.XDG_CONFIG_HOME, newProfile.env.XDG_CONFIG_HOME);
        assert.equal(oldProfile.env.XDG_STATE_HOME, newProfile.env.XDG_STATE_HOME); assert.equal(oldProfile.cwd, newProfile.cwd);
        const oldConfig = JSON.parse(await readFile(join(oldProfile.env.XDG_CONFIG_HOME!, 'opencode', 'opencode.json'), 'utf8'));
        const newConfig = JSON.parse(await readFile(join(newProfile.env.XDG_CONFIG_HOME!, 'opencode', 'opencode.json'), 'utf8'));
        const oldControl = oldConfig.mcp.servers.control.environment.NARU_PREVIEW_CAPABILITY, newControl = newConfig.mcp.servers.control.environment.NARU_PREVIEW_CAPABILITY;
        assert.deepEqual((await broker.request(oldControl, 'status', {}) as { workerModelProfile: { models: string[]; globalWorkerPoolRevision: number } }).workerModelProfile, { models: ['fixture/a'], globalWorkerPoolRevision: 1, repositoryRevision: 1 });
        assert.deepEqual((await broker.request(newControl, 'status', {}) as { workerModelProfile: { models: string[] } }).workerModelProfile.models, ['fixture/b']);
        await assert.rejects(broker.request(oldControl, 'start', { requestId: 'new-model', role: 'runner', model: 'fixture/b', prompt: 'no' }), /frozen worker pool/);
        await broker.request('admin', 'enroll', { path: repository, access: 'inspect', writeScopes: [], expectedRevision: 1, expectedGlobalRevision: 2 });
        await assert.rejects(broker.request(oldControl, 'start', { requestId: 'old-model', role: 'runner', model: 'fixture/a', prompt: 'no' }), /inspect workers only/);
        const setup = await broker.request('admin', 'setup-status', { path: repository }) as { globalProfile: { models: string[]; revision: number }; repository: { effectiveWorkerPool: { models: string[] } } };
        assert.deepEqual(setup.globalProfile, { models: ['fixture/b'], revision: 2 }); assert.deepEqual(setup.repository.effectiveWorkerPool, { models: ['fixture/b'], revision: 2 });
    } finally { broker.shutdown(); await rm(root, { recursive: true, force: true }); }
});

test('global instructions are admin-only, independently CAS-bound, and frozen across parent and managed worker creation', async () => {
    const fixture = await realpath(await mkdtemp('/tmp/naru-global-instructions-broker-'));
    const home = join(fixture, 'home'), repository = join(fixture, 'repo'), stateRoot = join(fixture, 'state');
    await mkdir(home); await mkdir(repository); await mkdir(stateRoot, { mode: 0o700 });
    const source = join(home, 'AGENTS.md'); await writeFile(source, 'SYNTHETIC_OLD_SESSION_MARKER\n');
    const cli = join(fixture, 'stub-cli.mjs'); await writeFile(cli, `process.on('disconnect',()=>process.exit(0));setInterval(()=>{},1000);\n`);
    const git = nodeSpawner(cleanProcessEnvironment(process.execPath));
    const runGit = async (argv: string[]) => { const result = await git(['git', ...argv], { cwd: repository }); assert.equal(result.ok, true, result.stderr); };
    const broker = new PreviewBroker({ root: stateRoot, executable: process.execPath, node: process.execPath, cli }, 'admin', { platform: 'darwin', arch: 'arm64', home });
    try {
        await runGit(['init', '-q']); await runGit(['config', 'user.name', 'Fixture']); await runGit(['config', 'user.email', 'fixture@example.invalid']); await writeFile(join(repository, 'tracked.txt'), 'tracked'); await runGit(['add', '.']); await runGit(['commit', '-qm', 'fixture']);
        await broker.load(); await broker.request('admin', 'configure-global', { models: ['fixture/model'], expectedRevision: null });
        const prepared = await broker.request('admin', 'prepare-global-instructions', { sourcePath: source }) as { sourcePath: string; canonicalPath: string; sha256: string; byteLength: number };
        assert.doesNotMatch(JSON.stringify(prepared), /SYNTHETIC_OLD_SESSION_MARKER/);
        await assert.rejects(broker.request('forged', 'configure-global-instructions', { ...prepared, expectedRevision: 0 }), /Capability/);
        const configured = await broker.request('admin', 'configure-global-instructions', { ...prepared, expectedRevision: 0 }) as { revision: number; loadStatus: string };
        assert.equal(configured.revision, 1); assert.equal(configured.loadStatus, 'loaded');
        await broker.request('admin', 'enroll', { path: repository, access: 'check', writeScopes: [], expectedRevision: null, expectedGlobalRevision: 1 });
        const oldProfile = await broker.request('admin', 'open', { path: repository }) as { env: NodeJS.ProcessEnv };
        const oldConfig = JSON.parse(await readFile(join(oldProfile.env.XDG_CONFIG_HOME!, 'opencode', 'opencode.json'), 'utf8'));
        assert.match(oldConfig.agents.naru.system, /SYNTHETIC_OLD_SESSION_MARKER/);
        for (const name of Object.keys(oldConfig.agents).filter(name => name !== 'naru')) assert.match(oldConfig.agents[name].system, /SYNTHETIC_OLD_SESSION_MARKER/);
        await writeFile(source, 'SYNTHETIC_NEW_SESSION_MARKER\n');
        const oldControl = oldConfig.mcp.servers.control.environment.NARU_PREVIEW_CAPABILITY;
        assert.doesNotMatch(JSON.stringify(await broker.request(oldControl, 'status', {})), /SYNTHETIC_(?:OLD|NEW)_SESSION_MARKER/);
        const task = await broker.request(oldControl, 'start', { requestId: 'frozen', role: 'runner', model: 'fixture/model', prompt: 'synthetic task' }) as { id: string };
        const oldWorker = JSON.parse(await readFile(join(stateRoot, 'hosts', task.id, 'config', 'opencode', 'opencode.json'), 'utf8'));
        assert.match(oldWorker.agents.naru.system, /SYNTHETIC_OLD_SESSION_MARKER/); assert.doesNotMatch(oldWorker.agents.naru.system, /SYNTHETIC_NEW_SESSION_MARKER/);
        const newProfile = await broker.request('admin', 'open', { path: repository }) as { env: NodeJS.ProcessEnv };
        const newConfig = JSON.parse(await readFile(join(newProfile.env.XDG_CONFIG_HOME!, 'opencode', 'opencode.json'), 'utf8'));
        assert.match(newConfig.agents.naru.system, /SYNTHETIC_NEW_SESSION_MARKER/);
        const disabled = await broker.request('admin', 'disable-global-instructions', { expectedRevision: 1 }) as { revision: number; sourcePath: null };
        assert.deepEqual(disabled, { revision: 2, sourcePath: null, loadStatus: 'disabled' });
        assert.deepEqual(await broker.request('admin', 'disable-global-instructions', { expectedRevision: 2 }), { revision: 3, sourcePath: null, loadStatus: 'disabled' });
        await assert.rejects(broker.request('admin', 'disable-global-instructions', { expectedRevision: 2 }), /changed since setup status/);
        await assert.rejects(broker.request('admin', 'configure-global-instructions', { ...prepared, expectedRevision: 0 }), /changed since setup status/);
        const setup = await broker.request('admin', 'setup-status', { path: repository }) as { globalProfile: { revision: number }; globalInstructions: { revision: number; loadStatus: string } };
        assert.equal(setup.globalProfile.revision, 1); assert.deepEqual(setup.globalInstructions, { revision: 3, sourcePath: null, loadStatus: 'disabled' });
        const adminStatus = await broker.request('admin', 'status', {}); const persisted = await readFile(join(stateRoot, 'state.json'), 'utf8');
        assert.doesNotMatch(JSON.stringify(adminStatus), /SYNTHETIC_(?:OLD|NEW)_SESSION_MARKER/); assert.doesNotMatch(persisted, /SYNTHETIC_(?:OLD|NEW)_SESSION_MARKER/);
    } finally { broker.shutdown(); await new Promise(resolve => setTimeout(resolve, 50)); await rm(fixture, { recursive: true, force: true }); }
});

test('configured missing global instructions remain diagnosable in setup but fail new session open', async () => {
    const fixture = await realpath(await mkdtemp('/tmp/naru-global-instructions-missing-')), home = join(fixture, 'home'), repository = join(fixture, 'repo');
    await mkdir(home); await mkdir(repository); const source = join(home, 'AGENTS.md'); await writeFile(source, 'SYNTHETIC_MISSING_MARKER\n');
    const git = nodeSpawner(cleanProcessEnvironment(process.execPath)); const runGit = async (argv: string[]) => { const result = await git(['git', ...argv], { cwd: repository }); assert.equal(result.ok, true, result.stderr); };
    const broker = new PreviewBroker({ root: fixture, executable: process.execPath, node: process.execPath, cli: '/fixture/cli' }, 'admin', { home });
    try {
        await runGit(['init', '-q']); await runGit(['config', 'user.name', 'Fixture']); await runGit(['config', 'user.email', 'fixture@example.invalid']); await writeFile(join(repository, 'tracked'), 'x'); await runGit(['add', '.']); await runGit(['commit', '-qm', 'fixture']); await broker.load();
        await broker.request('admin', 'configure-global', { models: ['fixture/model'], expectedRevision: null });
        const prepared = await broker.request('admin', 'prepare-global-instructions', { sourcePath: source }) as Record<string, unknown>;
        await broker.request('admin', 'configure-global-instructions', { ...prepared, expectedRevision: 0 }); await broker.request('admin', 'enroll', { path: repository, access: 'inspect', writeScopes: [], expectedRevision: null, expectedGlobalRevision: 1 }); await rm(source);
        const setup = await broker.request('admin', 'setup-status', { path: repository }) as { globalInstructions: { loadStatus: string; sourcePath: string } };
        assert.equal(setup.globalInstructions.loadStatus, 'missing'); assert.equal(setup.globalInstructions.sourcePath, source);
        await assert.rejects(broker.request('admin', 'open', { path: repository }), /GLOBAL_INSTRUCTIONS_MISSING/);
        assert.equal((await broker.request('admin', 'disable-global-instructions', { expectedRevision: 1 }) as { revision: number }).revision, 2);
    } finally { await rm(fixture, { recursive: true, force: true }); }
});

test('maximum-length global model references pass managed start while longer references and pools above 32 fail', async () => {
    const root = await realpath(await mkdtemp('/tmp/naru-long-model-reference-test-')), repository = join(root, 'repo');
    await mkdir(repository);
    const cli = join(root, 'stub-cli.mjs'); await writeFile(cli, 'process.exit(0);\n');
    const broker = new PreviewBroker({ root, executable: process.execPath, node: process.execPath, cli }, 'admin', { platform: 'darwin', arch: 'arm64' });
    const provider = 'p'.repeat(128), model = ['m'.repeat(128), 'n'.repeat(128), 'o'.repeat(128), 'q'.repeat(125)].join('/'), variant = 'v'.repeat(128);
    const reference = `${provider}/${model}#${variant}`;
    assert.equal(reference.length, MAX_CATALOGUE_REFERENCE_LENGTH);
    try {
        await broker.load();
        const configured = await broker.request('admin', 'configure-global', { models: [reference], expectedRevision: null }) as { models: string[]; revision: number };
        assert.deepEqual(configured, { models: [reference], revision: 1 });
        await assert.rejects(broker.request('admin', 'configure-global', { models: [reference + 'x'], expectedRevision: 1 }), /1 to 32 unique exact provider\/model references/);
        assert.deepEqual(await broker.request('admin', 'global-status', {}), configured);
        const internals = broker as unknown as { state: { repositories: Enrollment[] }; capabilities: Map<string, unknown> };
        internals.state.repositories = [{ path: repository, access: 'check', writeScopes: [], revision: 1 }];
        internals.capabilities.set(digest('control'), { kind: 'orchestrator', repository, models: [reference], globalWorkerPoolRevision: 1, repositoryRevision: 1 });
        const task = await broker.request('control', 'start', { requestId: 'long-reference', role: 'runner', model: reference, prompt: 'stubbed check' }) as { model: string; state: string };
        assert.equal(task.model, reference); assert.equal(task.state, 'running');
        const pool = Array.from({ length: 32 }, (_, index) => `fixture/model-${index}`);
        assert.equal(((await broker.request('admin', 'configure-global', { models: pool, expectedRevision: 1 })) as { models: string[] }).models.length, 32);
        await assert.rejects(broker.request('admin', 'configure-global', { models: [...pool, 'fixture/model-32'], expectedRevision: 2 }), /1 to 32/);
    } finally { broker.shutdown(); await rm(root, { recursive: true, force: true }); }
});

test('validated v2 and v3 state preserve tasks, access, revisions, and the existing global pool while dropping repository models', async () => {
    const root = await realpath(await mkdtemp('/tmp/naru-state-v2-v3-test-')), now = new Date().toISOString();
    const task = { id: 'task', requestId: 'request', requestHash: digest('request'), repository: '/repo', role: 'runner', model: 'fixture/model', prompt: 'prompt', state: 'completed', createdAt: now, updatedAt: now, directory: '/repo', capabilityHash: digest('token'), summary: 'done', evidence: [] };
    const writerTask = { ...task, id: 'writer-task', requestId: 'writer-request', role: 'writer', requestHash: digest('writer-request') };
    try {
        const v2 = join(root, 'v2'); await mkdir(v2);
        await writeFile(join(v2, 'state.json'), JSON.stringify({ schemaVersion: 2, repositories: [{ path: '/repo', models: ['fixture/model'], access: 'inspect', writeScopes: [], revision: 4 }], tasks: [task, writerTask] }));
        await new PreviewBroker({ root: v2, executable: process.execPath, node: process.execPath, cli: '/fixture/cli' }, 'admin').load();
        assert.deepEqual(JSON.parse(await readFile(join(v2, 'state.json'), 'utf8')), { schemaVersion: 6, globalWorkerPool: null, globalInstructions: { revision: 0, source: null }, repositories: [{ path: '/repo', kind: 'git', access: 'inspect', writeScopes: [], revision: 4 }], tasks: [{ ...task, mode: 'direct' }, { ...writerTask, mode: 'worktree' }] });

        const v3 = join(root, 'v3'); await mkdir(v3);
        const globalWorkerPool = { models: ['fixture/global#high'], revision: 9 };
        await writeFile(join(v3, 'state.json'), JSON.stringify({ schemaVersion: 3, globalWorkerPool, repositories: [
            { path: '/repo-a', workerPool: { source: 'repository', models: ['fixture/old-a'] }, access: 'inspect', writeScopes: [], revision: 2 },
            { path: '/repo-b', workerPool: { source: 'repository', models: ['fixture/old-b'] }, access: 'write', writeScopes: ['src/**'], revision: 7 },
        ], tasks: [task] }));
        await new PreviewBroker({ root: v3, executable: process.execPath, node: process.execPath, cli: '/fixture/cli' }, 'admin').load();
        const migrated = JSON.parse(await readFile(join(v3, 'state.json'), 'utf8'));
        assert.deepEqual(migrated, { schemaVersion: 6, globalWorkerPool, globalInstructions: { revision: 0, source: null }, repositories: [
            { path: '/repo-a', kind: 'git', access: 'inspect', writeScopes: [], revision: 2 },
            { path: '/repo-b', kind: 'git', access: 'write', writeScopes: ['src/**'], revision: 7 },
        ], tasks: [{ ...task, mode: 'direct' }] });
        const reloaded = new PreviewBroker({ root: v3, executable: process.execPath, node: process.execPath, cli: '/fixture/cli' }, 'admin'); await reloaded.load();
        assert.deepEqual(JSON.parse(await readFile(join(v3, 'state.json'), 'utf8')), migrated);
    } finally { await rm(root, { recursive: true, force: true }); }
});

test('schema v3 rejects orphan global inheritance before any migration write', async () => {
    const root = await realpath(await mkdtemp('/tmp/naru-state-v3-cross-record-test-'));
    const host = (directory: string) => ({ root: directory, executable: process.execPath, node: process.execPath, cli: '/fixture/cli' });
    try {
        const orphan = join(root, 'orphan'); await mkdir(orphan);
        const orphanBytes = Buffer.from(JSON.stringify({ schemaVersion: 3, globalWorkerPool: null, repositories: [{ path: '/repo', workerPool: { source: 'global' }, access: 'inspect', writeScopes: [], revision: 1 }], tasks: [] }));
        await writeFile(join(orphan, 'state.json'), orphanBytes);
        await assert.rejects(new PreviewBroker(host(orphan), 'admin').load(), /Invalid preview state: repository inherits an absent global worker pool/);
        assert.deepEqual(await readFile(join(orphan, 'state.json')), orphanBytes);

        const override = join(root, 'override'); await mkdir(override);
        await writeFile(join(override, 'state.json'), JSON.stringify({ schemaVersion: 3, globalWorkerPool: null, repositories: [{ path: '/repo', workerPool: { source: 'repository', models: ['fixture/override'] }, access: 'inspect', writeScopes: [], revision: 2 }], tasks: [] }));
        await new PreviewBroker(host(override), 'admin').load();
        assert.deepEqual(JSON.parse(await readFile(join(override, 'state.json'), 'utf8')), { schemaVersion: 6, globalWorkerPool: null, globalInstructions: { revision: 0, source: null }, repositories: [{ path: '/repo', kind: 'git', access: 'inspect', writeScopes: [], revision: 2 }], tasks: [] });

        const inherited = join(root, 'inherited'); await mkdir(inherited);
        await writeFile(join(inherited, 'state.json'), JSON.stringify({ schemaVersion: 3, globalWorkerPool: { models: ['fixture/global'], revision: 3 }, repositories: [{ path: '/repo', workerPool: { source: 'global' }, access: 'inspect', writeScopes: [], revision: 2 }], tasks: [] }));
        await new PreviewBroker(host(inherited), 'admin').load();
        const valid = JSON.parse(await readFile(join(inherited, 'state.json'), 'utf8'));
        assert.deepEqual(valid, { schemaVersion: 6, globalWorkerPool: { models: ['fixture/global'], revision: 3 }, globalInstructions: { revision: 0, source: null }, repositories: [{ path: '/repo', kind: 'git', access: 'inspect', writeScopes: [], revision: 2 }], tasks: [] });
    } finally { await rm(root, { recursive: true, force: true }); }
});

test('broker rejects malformed persisted enrollment records instead of casting them', async () => {
    const root = await realpath(await mkdtemp('/tmp/naru-broker-invalid-state-test-'));
    try {
        await writeFile(join(root, 'state.json'), JSON.stringify({ schemaVersion: 2, repositories: [{ path: '/repo', models: ['fixture/model'], access: 'write', writeScopes: [], revision: '1' }], tasks: [] }));
        await assert.rejects(new PreviewBroker({ root, executable: process.execPath, node: process.execPath, cli: '/fixture/cli' }, 'admin').load(), /Invalid preview enrollment/);
        const home = join(root, 'home'); await mkdir(home);
        const malformed = Buffer.from(JSON.stringify({ schemaVersion: 5, globalWorkerPool: null, globalInstructions: { revision: 1, source: { sourcePath: '/outside/AGENTS.md', canonicalPath: '/outside/AGENTS.md' } }, repositories: [], tasks: [] }));
        await writeFile(join(root, 'state.json'), malformed);
        await assert.rejects(new PreviewBroker({ root, executable: process.execPath, node: process.execPath, cli: '/fixture/cli' }, 'admin', { home }).load(), /Invalid global instructions setting/);
        assert.deepEqual(await readFile(join(root, 'state.json')), malformed);
    } finally { await rm(root, { recursive: true, force: true }); }
});

test('historical managed reader task records remain loadable but are reported separately from native readers', async () => {
    const root = await realpath(await mkdtemp('/tmp/naru-historical-reader-test-'));
    const now = new Date().toISOString();
    try {
        await writeFile(join(root, 'state.json'), JSON.stringify({ schemaVersion: 2, repositories: [{ path: '/historical/repo', models: ['fixture/model'], access: 'inspect', writeScopes: [], revision: 1 }], tasks: [{
            id: 'old-reader', requestId: 'old-request', requestHash: digest('old'), repository: '/historical/repo', role: 'reader', model: 'fixture/model', prompt: 'historical', state: 'completed', createdAt: now, updatedAt: now, directory: '/historical/repo', capabilityHash: digest('expired'), summary: 'done', evidence: [],
        }] }));
        const broker = new PreviewBroker({ root, executable: process.execPath, node: process.execPath, cli: '/fixture/cli' }, 'admin'); await broker.load();
        const status = await broker.request('admin', 'status', {}) as { nativeReaders: { lifecycle: string }; managedWorkers: Array<{ role: string; id: string }> };
        assert.equal(status.nativeReaders.lifecycle, 'host-native'); assert.deepEqual(status.managedWorkers.map(task => [task.id, task.role]), [['old-reader', 'reader']]);
    } finally { await rm(root, { recursive: true, force: true }); }
});

test('worker file and check APIs re-enforce repository access instead of trusting a leaf role', async () => {
    const root = await realpath(await mkdtemp('/tmp/naru-broker-worker-policy-test-'));
    const repository = join(root, 'repo'), stateRoot = join(root, 'state'); await mkdir(repository); await mkdir(stateRoot); await writeFile(join(repository, 'file.txt'), 'original');
    const broker = new PreviewBroker({ root: stateRoot, executable: process.execPath, node: process.execPath, cli: '/fixture/cli' }, 'admin');
    await broker.load();
    const base = { requestId: 'request', requestHash: digest('request'), repository, model: 'fixture/model', prompt: 'fixture', state: 'running', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), directory: repository, summary: '', evidence: [] } as const;
    const writer = { ...base, id: 'writer', role: 'writer', capabilityHash: digest('writer-token') };
    const runner = { ...base, id: 'runner', role: 'runner', capabilityHash: digest('runner-token') };
    const internals = broker as unknown as { state: { schemaVersion: 5; globalWorkerPool: null; globalInstructions: { revision: 0; source: null }; repositories: unknown[]; tasks: unknown[] }; capabilities: Map<string, { kind: 'managed-worker'; repository: string; task: string }> };
    internals.state.repositories = [{ path: repository, access: 'inspect', writeScopes: [], revision: 1 }];
    internals.state.tasks = [writer, runner];
    internals.capabilities.set(digest('writer-token'), { kind: 'managed-worker', repository, task: writer.id }); internals.capabilities.set(digest('runner-token'), { kind: 'managed-worker', repository, task: runner.id });
    assert.equal((await broker.request('writer-token', 'read', { path: 'file.txt' }) as { content: string }).content, 'original');
    await assert.rejects(broker.request('writer-token', 'write', { path: 'file.txt', content: 'changed', expectedHash: digest('original') }), /does not allow writes/);
    await assert.rejects(broker.request('runner-token', 'check', { argv: [process.execPath, '-e', ''] }), /does not allow checks/);
    assert.equal(await readFile(join(repository, 'file.txt'), 'utf8'), 'original');
    await rm(root, { recursive: true, force: true });
});

test('write enrollment rechecks repository cleanliness at the serialized policy mutation', async () => {
    const root = await realpath(await mkdtemp('/tmp/naru-broker-clean-grant-test-')), repository = join(root, 'repo'), stateRoot = join(root, 'state');
    await mkdir(repository); await mkdir(stateRoot, { mode: 0o700 });
    const git = nodeSpawner(cleanProcessEnvironment(process.execPath));
    const runGit = async (argv: string[]) => { const result = await git(['git', ...argv], { cwd: repository }); assert.equal(result.ok, true, result.stderr); };
    const broker = new PreviewBroker({ root: stateRoot, executable: process.execPath, node: process.execPath, cli: '/fixture/cli' }, 'admin', { platform: 'darwin', arch: 'arm64' });
    try {
        await runGit(['init', '-q']); await runGit(['config', 'user.name', 'Fixture']); await runGit(['config', 'user.email', 'fixture@example.invalid']); await writeFile(join(repository, 'tracked.txt'), 'tracked'); await runGit(['add', '.']); await runGit(['commit', '-qm', 'fixture']); await broker.load(); await broker.request('admin', 'configure-global', { models: ['fixture/model'], expectedRevision: null });
        await writeFile(join(repository, 'direct-dirty.txt'), 'dirty');
        await assert.rejects(broker.request('admin', 'enroll', { path: repository, access: 'write', writeScopes: ['tracked.txt'], expectedRevision: null, expectedGlobalRevision: 1 }), /clean repository.*no policy change was saved/);
        let setup = await broker.request('admin', 'setup-status', { path: repository }) as { repository: { enrollment: unknown; dirty: boolean } }; assert.equal(setup.repository.enrollment, null);
        await rm(join(repository, 'direct-dirty.txt'));
        setup = await broker.request('admin', 'setup-status', { path: repository }) as { repository: { enrollment: unknown; dirty: boolean } }; assert.equal(setup.repository.dirty, false);
        await writeFile(join(repository, 'became-dirty.txt'), 'dirty after setup');
        await assert.rejects(broker.request('admin', 'enroll', { path: repository, access: 'write', writeScopes: ['tracked.txt'], expectedRevision: null, expectedGlobalRevision: 1 }), /clean repository.*no policy change was saved/);
        setup = await broker.request('admin', 'setup-status', { path: repository }) as { repository: { enrollment: unknown; dirty: boolean } }; assert.equal(setup.repository.enrollment, null);
    } finally { await rm(root, { recursive: true, force: true }); }
});

test('darwin x64 exposes inspect only and rejects elevated admission before an attempt can spawn', async () => {
    const root = await realpath(await mkdtemp('/tmp/naru-broker-arch-gate-test-')), repository = join(root, 'repo'), stateRoot = join(root, 'state');
    await mkdir(repository); await mkdir(stateRoot, { mode: 0o700 });
    const git = nodeSpawner(cleanProcessEnvironment(process.execPath));
    const runGit = async (argv: string[]) => { const result = await git(['git', ...argv], { cwd: repository }); assert.equal(result.ok, true, result.stderr); };
    try {
        await runGit(['init', '-q']); await runGit(['config', 'user.name', 'Fixture']); await runGit(['config', 'user.email', 'fixture@example.invalid']); await writeFile(join(repository, 'tracked.txt'), 'tracked'); await runGit(['add', '.']); await runGit(['commit', '-qm', 'fixture']);
        await writeFile(join(stateRoot, 'state.json'), JSON.stringify({ schemaVersion: 1, repositories: [{ path: repository, models: ['fixture/model'], writeScopes: [] }], tasks: [] }));
        const broker = new PreviewBroker({ root: stateRoot, executable: process.execPath, node: process.execPath, cli: '/fixture/never-spawn' }, 'admin', { platform: 'darwin', arch: 'x64' }); await broker.load();
        const setup = await broker.request('admin', 'setup-status', { path: repository }) as { maximumAccess: string; installation: { hostCapabilities: { check: boolean; write: boolean } } };
        assert.equal(setup.maximumAccess, 'inspect'); assert.deepEqual(setup.installation.hostCapabilities, { inspect: true, check: false, write: false });
        await broker.request('admin', 'configure-global', { models: ['fixture/model'], expectedRevision: null });
        await assert.rejects(broker.request('admin', 'enroll', { path: repository, access: 'check', writeScopes: [], expectedRevision: 1, expectedGlobalRevision: 1 }), /platform and architecture/);
        const profile = await broker.request('admin', 'open', { path: repository }) as { env: NodeJS.ProcessEnv };
        const token = JSON.parse(await readFile(join(profile.env.XDG_CONFIG_HOME!, 'opencode', 'opencode.json'), 'utf8')).mcp.servers.control.environment.NARU_PREVIEW_CAPABILITY;
        await assert.rejects(broker.request(token, 'start', { requestId: 'must-not-spawn', role: 'runner', model: 'fixture/model', prompt: 'check' }), /platform and architecture/);
        assert.deepEqual(await broker.request('admin', 'status', {}), { nativeReaders: { lifecycle: 'host-native', tracking: 'OpenCode child sessions and host UI' }, managedWorkers: [] });
        const workerToken = 'unsupported-runner', now = new Date().toISOString();
        const task = { id: 'injected-runner', requestId: 'injected', requestHash: digest('injected'), repository, role: 'runner', model: 'fixture/model', prompt: 'check', state: 'running', createdAt: now, updatedAt: now, directory: repository, capabilityHash: digest(workerToken), summary: '', evidence: [] };
        const internals = broker as unknown as { state: { tasks: unknown[] }; capabilities: Map<string, { kind: 'managed-worker'; repository: string; task: string }> };
        internals.state.tasks.push(task); internals.capabilities.set(digest(workerToken), { kind: 'managed-worker', repository, task: task.id });
        await assert.rejects(broker.request(workerToken, 'check', { argv: [process.execPath, '-e', 'throw new Error("must not run")'] }), /platform and architecture/);
        await assert.rejects(lstat(join(stateRoot, 'checks')), { code: 'ENOENT' });
    } finally { await rm(root, { recursive: true, force: true }); }
});
