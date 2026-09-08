import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmod, lstat, mkdtemp, mkdir, readFile, realpath, rm, symlink, truncate, writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { assertNoPrivateConnectionFlags, modelsOutput, runModelsListing, stopBroker } from '../tools/naru-preview.mjs';
import { PreviewBroker, safeWorkspacePath, digest } from '../tools/naru-lib/preview-broker.mjs';
import { copyVerificationSnapshot, isolatedCheck, nodeSpawner, cleanProcessEnvironment, runtimeReadRoot, startPreviewServer, waitForPreviewReadiness } from '../tools/naru-lib/preview-process.mjs';
import { hostEnvironment } from '../tools/naru-lib/preview-host.mjs';
import { createWorktreeRun, createWriterWorktree, finalizeWorktreeRun, integrateWriterWorktree, type WorktreeRegistry } from '../tools/naru-lib/worktree.mjs';

const built = join(dirname(fileURLToPath(import.meta.url)), '..');

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

test('models output distinguishes settled empty catalogues, command failures, timeouts and truncation', () => {
    const empty = modelsOutput({ ok: true, code: 0, stdout: '', stderr: '' });
    assert.equal(empty.exitCode, 1); assert.match(empty.stderr, /catalogue is ready.*no models are available.*check the provider connection/i);
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

test('preview server keeps MCP readiness as its default and cleans up after auth and catalogue readiness failures', async () => {
    const root = await realpath(await mkdtemp('/tmp/naru-readiness-process-test-'));
    const executable = join(root, 'fake-opencode');
    const pidFile = join(root, 'pid');
    await writeFile(executable, `#!${process.execPath}\nconst http=require('node:http'),fs=require('node:fs');fs.writeFileSync(process.env.PID_FILE,String(process.pid));let requests=0;const server=http.createServer((req,res)=>{res.setHeader('content-type','application/json');if(req.url.startsWith('/api/mcp')){requests++;res.end(JSON.stringify({data:[{name:'naru',status:{status:'connected'}}]}));return}if(req.url.startsWith('/api/model/default')){res.end('{}');return}if(req.url.startsWith('/api/integration')){res.end(JSON.stringify({data:[]}));return}res.writeHead(404).end('{}')});server.listen(0,'127.0.0.1',()=>console.log(JSON.stringify({url:'http://127.0.0.1:'+server.address().port})));setInterval(()=>{},1000);\n`);
    await chmod(executable, 0o755);
    try {
        const environment = { ...process.env, PID_FILE: pidFile };
        const server = await startPreviewServer(executable, root, environment, 'mcp', { deadlineMs: 1000, requestTimeoutMs: 100, pollIntervalMs: 110 });
        server.stop();
        await assert.rejects(startPreviewServer(executable, root, environment, 'auth', { deadlineMs: 50, requestTimeoutMs: 20, pollIntervalMs: 5 }), /readiness timed out|aborted due to timeout/);
        await assert.rejects(startPreviewServer(executable, root, environment, 'catalogue', { deadlineMs: 50, requestTimeoutMs: 20 }), /activation failed \(404\)/);
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
        await broker.request('admin-test-only', 'enroll', { path: repository, models: ['fixture/model'], writeScopes: ['file.txt'] });
        await broker.request('admin-test-only', 'open', { path: repository });
        const profile = (await import('../tools/naru-lib/preview-broker.mjs')).digest(repository).slice(0, 12);
        const config = JSON.parse(await readFile(join(stateRoot, 'hosts', 'orchestrator-' + profile, 'config', 'opencode', 'opencode.json'), 'utf8'));
        const capability = config.mcp.servers.naru.environment.NARU_PREVIEW_CAPABILITY;
        const listed = await broker.request(capability, 'files', {}) as { files: string[] };
        assert.ok(listed.files.includes('.env.example'));
        for (const denied of ['.env.production.local', 'secrets/token.txt', 'credentials/service.json', 'environment-alias']) assert.ok(!listed.files.includes(denied));
        await assert.rejects(broker.request(capability, 'read', { path: '.env.production.local' }), /secret/);
        await assert.rejects(broker.request(capability, 'read', { path: 'secrets/token.txt' }), /secret/);
        await assert.rejects(broker.request(capability, 'read', { path: 'environment-alias' }), /symlinks/);
        await assert.rejects(broker.request(capability, 'read', { path: 'invalid.bin' }), /UTF-8/);
        assert.equal((await broker.request(capability, 'read', { path: '.env.example' }) as { content: string }).content, 'SAFE_TEMPLATE=true\n');
        await assert.rejects(broker.request(capability, 'integrate', {}), /not available/);
        await assert.rejects(broker.request(capability, 'start', { requestId: 'a', role: 'writer', model: 'other/model', prompt: 'work' }), /allowlisted/);
        const task = await broker.request(capability, 'start', { requestId: 'a', role: 'writer', model: 'fixture/model', prompt: 'work' }) as { id: string; directory: string; state: string };
        assert.equal(task.state, 'running'); assert.notEqual(task.directory, repository);
        const again = await broker.request(capability, 'start', { requestId: 'a', role: 'writer', model: 'fixture/model', prompt: 'work' }) as { id: string };
        assert.equal(again.id, task.id);
        const worker = JSON.parse(await readFile(join(stateRoot, 'hosts', task.id, 'config', 'opencode', 'opencode.json'), 'utf8')).mcp.servers.naru.environment.NARU_PREVIEW_CAPABILITY;
        await assert.rejects(broker.request(worker, 'start', {}), /not available/);
        await assert.rejects(broker.request(worker, 'write', { path: 'other.txt', content: 'no', expectedHash: null }), /scope/);
        await assert.rejects(broker.request(worker, 'write', { path: '.env.production.local', content: 'no', expectedHash: digest('SYNTHETIC_DENIED=true\n') }), /scope|secret/);
        await assert.rejects(broker.request(worker, 'write', { path: 'file.txt', content: 'new', expectedHash: null }), /changed/);
        await broker.request(worker, 'write', { path: 'file.txt', content: 'new', expectedHash: digest('original') });
        assert.equal(await readFile(join(repository, 'file.txt'), 'utf8'), 'original');
        assert.equal(await readFile(join(task.directory, 'file.txt'), 'utf8'), 'new');
        const reader = await broker.request(capability, 'start', { requestId: 'b', role: 'reader', model: 'fixture/model', prompt: 'inspect' }) as { id: string };
        const readerToken = JSON.parse(await readFile(join(stateRoot, 'hosts', reader.id, 'config', 'opencode', 'opencode.json'), 'utf8')).mcp.servers.naru.environment.NARU_PREVIEW_CAPABILITY;
        await assert.rejects(broker.request(readerToken, 'write', { path: 'file.txt', content: 'no', expectedHash: digest('original') }), /Only writer/);
        await assert.rejects(broker.request(readerToken, 'check', { argv: ['node', '-e', ''] }), /Reader/);
        await broker.request(capability, 'cancel', { id: reader.id });
        await assert.rejects(broker.request(readerToken, 'read', { path: 'file.txt' }), /Capability/);
        const restarted = new PreviewBroker(host, 'admin-test-only'); await restarted.load();
        const status = await restarted.request('admin-test-only', 'status', {}) as Array<{ state: string }>;
        assert.equal(status[0]?.state, 'interrupted');
        await assert.rejects(restarted.request(worker, 'write', {}), /Capability/);
        await assert.rejects(restarted.request('admin-test-only', 'integrate', { id: task.id, digest: 'stale' }), /completed/);
    } finally {
        broker.shutdown();
        await new Promise(resolve => setTimeout(resolve, 100));
        await rm(root, { recursive: true, force: true });
    }
});
