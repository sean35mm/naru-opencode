import assert from 'node:assert/strict';
import { chmod, lstat, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { fetchPreviewCatalogue, isSafeCatalogueModelID, nodeSpawner, cleanProcessEnvironment, startPreviewServer, waitForPreviewReadiness } from '../tools/naru-lib/preview-process.mjs';
const built = join(dirname(fileURLToPath(import.meta.url)), '..');

test('native smoke scripts reject wrappers before execution or fixture root creation', { skip: process.platform !== 'darwin' }, async () => {
    const fixture = await realpath(await mkdtemp('/tmp/naru-smoke-wrapper-test-'));
    const wrapper = join(fixture, 'opencode-wrapper'), marker = join(fixture, 'executed');
    const fixtureRoots = async () => (await readdir('/tmp')).filter(name => name.startsWith('naru-native-capabilities-')).sort();
    try {
        await writeFile(wrapper, `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(marker)},'executed')\n`, { mode: 0o755 }); await chmod(wrapper, 0o755);
        const before = await fixtureRoots();
        for (const script of ['naru-native-capabilities-smoke.mjs']) {
            const result = await nodeSpawner(cleanProcessEnvironment(process.execPath))([process.execPath, join(built, 'scripts', script), wrapper], { cwd: fixture });
            assert.equal(result.ok, false); assert.match(result.stderr, /Mach-O or ELF native executable, not a wrapper/);
            await assert.rejects(lstat(marker), { code: 'ENOENT' });
        }
        assert.deepEqual(await fixtureRoots(), before);
    } finally { await rm(fixture, { recursive: true, force: true }); }
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

test('catalogue readiness waits for plugin activation when v2 omits the old endpoint', async () => {
    const requests: string[] = [];
    let polls = 0;
    const server = (await import('node:http')).createServer((request, response) => {
        requests.push(`${request.method} ${request.url}`);
        response.setHeader('content-type', 'application/json');
        if (request.url?.startsWith('/api/plugin?')) response.end(JSON.stringify({ data: ++polls > 1 ? [{ id: 'opencode.models.dev' }] : [] }));
        else response.writeHead(404).end('{}');
    });
    await new Promise<void>(resolvePromise => server.listen(0, '127.0.0.1', resolvePromise));
    const address = server.address(); assert.ok(address && typeof address === 'object');
    try {
        await waitForPreviewReadiness(`http://127.0.0.1:${address.port}`, '/fixture', {}, 'catalogue', { pollIntervalMs: 1 });
        assert.deepEqual(requests, ['POST /api/plugin/await-activation?location%5Bdirectory%5D=%2Ffixture', 'GET /api/plugin?location%5Bdirectory%5D=%2Ffixture', 'GET /api/plugin?location%5Bdirectory%5D=%2Ffixture']);
    } finally { await new Promise<void>(resolvePromise => server.close(() => resolvePromise())); }
});

test('catalogue fallback retries stalled requests within its deadline, including stalled response bodies', async () => {
    let polls = 0;
    const server = (await import('node:http')).createServer((request, response) => {
        if (request.method === 'POST') { response.writeHead(404).end(); return; }
        polls++;
        if (polls === 1) return; // No headers until the per-request timeout.
        if (polls === 2) { response.writeHead(200, { 'content-type': 'application/json' }); response.write('{'); return; }
        response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ data: [{ id: 'fixture' }] }));
    });
    await new Promise<void>(resolvePromise => server.listen(0, '127.0.0.1', resolvePromise));
    const address = server.address(); assert.ok(address && typeof address === 'object');
    try {
        await waitForPreviewReadiness(`http://127.0.0.1:${address.port}`, '/fixture', {}, 'catalogue', { deadlineMs: 1000, requestTimeoutMs: 50, pollIntervalMs: 1 });
        assert.equal(polls, 3);
    } finally { server.closeAllConnections(); await new Promise<void>(resolvePromise => server.close(() => resolvePromise())); }
});

test('catalogue fallback labels permanent timeouts and rejects auth failures without retries', async () => {
    for (const status of ['stall', '401']) {
        let polls = 0;
        const server = (await import('node:http')).createServer((request, response) => {
            if (request.method === 'POST') { response.writeHead(404).end(); return; }
            polls++;
            if (status === '401') response.writeHead(401).end();
        });
        await new Promise<void>(resolvePromise => server.listen(0, '127.0.0.1', resolvePromise));
        const address = server.address(); assert.ok(address && typeof address === 'object');
        try {
            await assert.rejects(waitForPreviewReadiness(`http://127.0.0.1:${address.port}`, '/fixture', {}, 'catalogue', { deadlineMs: 120, requestTimeoutMs: 25, pollIntervalMs: 1 }), status === '401' ? /activation failed \(401\)/ : /catalogue activation timed out/);
            if (status === '401') assert.equal(polls, 1);
            else assert.ok(polls > 1);
        } finally { server.closeAllConnections(); await new Promise<void>(resolvePromise => server.close(() => resolvePromise())); }
    }
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
