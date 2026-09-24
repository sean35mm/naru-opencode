import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, cp, lstat, mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { applyPreparedOc2CodeRefresh, applyPreparedOc2Update, cleanupCommittedOc2CodeRefresh, installOc2, OC2_UPDATE_RELEASE, updateOc2, validateOc2PredecessorVersion, validateOc2UpdaterTarget } from '../tools/install-oc2.mjs';
import { callBroker, stopBroker } from '../tools/naru-preview.mjs';
import { cleanProcessEnvironment, nodeSpawner } from '../tools/naru-lib/preview-process.mjs';
import { oc2Dispatch } from '../tools/oc2.mjs';

const built = join(dirname(fileURLToPath(import.meta.url)), '..');

test('oc2 keeps every command on one native root and exposes legacy only as explicit recovery', () => {
    const targets = { root: '/private/native profile', legacy: '/private/legacy preview' };
    assert.deepEqual(oc2Dispatch(['run', 'two words', "quote'and;$HOME"], targets), { ...targets, argv: ['run', 'two words', "quote'and;$HOME"] });
    assert.deepEqual(oc2Dispatch(['naru'], targets), { ...targets, argv: ['naru'] });
    assert.deepEqual(oc2Dispatch(['naru', 'legacy', 'status'], targets), { ...targets, argv: ['naru', 'legacy', 'status'] });
    assert.throws(() => oc2Dispatch([], { root: 'relative' }), /absolute paths/);
});

test('bare and configure preview commands refuse non-TTY input with actionable scripting help', async () => {
    const root = await mkdtemp(join(tmpdir(), 'naru-oc2-nontty-test-'));
    try {
        for (const argv of [[], ['configure']]) {
            const child = spawn(process.execPath, [join(built, 'tools', 'naru-preview.mjs'), '--root', join(root, 'absent'), ...argv], { stdio: ['ignore', 'pipe', 'pipe'] });
            let stderr = ''; child.stderr.setEncoding('utf8'); child.stderr.on('data', chunk => { stderr += chunk; });
            const code = await new Promise<number | null>((resolvePromise, reject) => { child.once('error', reject); child.once('exit', resolvePromise); });
            assert.equal(code, 1); assert.match(stderr, /requires a TTY/); assert.match(stderr, /oc2 naru enroll/);
            await assert.rejects(lstat(join(root, 'absent')), { code: 'ENOENT' });
        }
    } finally { await rm(root, { recursive: true, force: true }); }
});

test('legacy enroll --model fails with global migration guidance before starting or changing preview state', async () => {
    const root = await mkdtemp(join(tmpdir(), 'naru-oc2-model-rejection-'));
    try {
        const preview = join(root, 'absent-preview');
        const result = await nodeSpawner(process.env)([process.execPath, join(built, 'tools', 'naru-preview.mjs'), '--root', preview, 'enroll', '/tmp/repo', '--model', 'fixture/old'], { timeout: 10_000 });
        assert.equal(result.ok, false); assert.match(result.stderr, /no longer creates repository worker overrides/); assert.match(result.stderr, /oc2 naru configure/);
        await assert.rejects(lstat(preview), { code: 'ENOENT' });
    } finally { await rm(root, { recursive: true, force: true }); }
});

test('oc2 process dispatch preserves argument boundaries without a shell', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'naru-oc2-test-')));
    try {
        const capture = join(root, 'capture.json');
        const target = join(root, 'fake target');
        await writeFile(target, `#!${process.execPath}\nrequire('fs').writeFileSync(process.env.CAPTURE, JSON.stringify(process.argv.slice(2)))\n`); await chmod(target, 0o755);
        await writeFile(join(root, 'host.json'), JSON.stringify({ root, executable: target, executableHash: createHash('sha256').update(await readFile(target)).digest('hex'), node: process.execPath, cli: join(root, 'legacy') }), { mode: 0o600 });
        const child = spawn(process.execPath, [join(built, 'tools', 'oc2.mjs'), '--version', '/tmp/two words', "quote'and;$HOME"], {
            env: { ...process.env, CAPTURE: capture, NARU_OC2_PREVIEW: join(root, 'naru-preview') }, stdio: 'pipe',
        });
        const code = await new Promise<number | null>((resolvePromise, reject) => { child.once('error', reject); child.once('exit', resolvePromise); });
        assert.equal(code, 0);
        assert.deepEqual(JSON.parse(await readFile(capture, 'utf8')), ['--version', '/tmp/two words', "quote'and;$HOME"]);
    } finally { await rm(root, { recursive: true, force: true }); }
});

test('CLI launches release start.lock after live startup so catalogue, policy changes, and a second open can proceed', { skip: process.platform !== 'darwin' || process.arch !== 'arm64', timeout: 45_000 }, async () => {
    const temporary = await realpath(await mkdtemp('/tmp/naru-cli-open-'));
    const root = join(temporary, 'preview'), repository = join(temporary, 'repo'), executable = join(temporary, 'fake-opencode');
    const cli = join(built, 'tools', 'naru-preview.mjs'), admin = 'synthetic-admin', socket = join(root, 'broker.sock');
    await mkdir(root, { mode: 0o700 }); await mkdir(repository);
    const fake = `#!${process.execPath}
const fs=require('node:fs'),http=require('node:http'),path=require('node:path');const command=process.argv[2];const root=path.dirname(path.dirname(process.env.OPENCODE_DB));fs.appendFileSync(path.join(root,'processes.log'),process.pid+' '+command+'\\n');
if(command==='serve'){const server=http.createServer((req,res)=>{if(req.method==='POST'&&req.url.startsWith('/api/plugin/await-activation'))return res.writeHead(204).end();if(req.url.startsWith('/api/mcp')){for(const file of (process.env.NARU_PREVIEW_MCP_READY_FILES||'').split(':').filter(Boolean)){fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,'ready\\n')}const names=(process.env.NARU_PREVIEW_REQUIRED_MCP||'').split(',').filter(Boolean);res.setHeader('content-type','application/json');return res.end(JSON.stringify({data:names.map(name=>({name,status:{status:'connected'}}))}))}res.writeHead(404).end('{}')});server.listen(0,'127.0.0.1',()=>console.log(JSON.stringify({url:'http://127.0.0.1:'+server.address().port})));setInterval(()=>{},1000)}
else if(command==='models'){process.stdout.write('fixture/old\\nfixture/new\\n')}
else if(command==='run'){process.stdout.write(JSON.stringify({type:'text',part:{text:'synthetic managed completion'}})+'\\n')}
else if(command==='--server'){fs.appendFileSync(path.join(root,'tuis.log'),process.env.XDG_CONFIG_HOME+'\\n');setInterval(()=>{},1000)}
else process.exit(2);
`;
    await writeFile(executable, fake, { mode: 0o755 }); await chmod(executable, 0o755);
    const host = { root, executable, executableHash: createHash('sha256').update(await readFile(executable)).digest('hex'), node: process.execPath, cli };
    await writeFile(join(root, 'host.json'), JSON.stringify(host), { mode: 0o600 }); await writeFile(join(root, 'admin'), admin, { mode: 0o600 });
    await writeFile(join(root, 'state.json'), JSON.stringify({ schemaVersion: 5, globalWorkerPool: { models: ['fixture/old'], revision: 1 }, globalInstructions: { revision: 0, source: null }, repositories: [{ path: repository, access: 'check', writeScopes: [], revision: 1 }], tasks: [] }), { mode: 0o600 });
    const git = nodeSpawner(cleanProcessEnvironment(process.execPath));
    for (const argv of [['init', '-q'], ['config', 'user.name', 'Fixture'], ['config', 'user.email', 'fixture@example.invalid']]) assert.equal((await git(['git', ...argv], { cwd: repository })).ok, true);
    const launched: ReturnType<typeof spawn>[] = [];
    const waitFor = async (condition: () => Promise<boolean>, message: string) => {
        for (let attempt = 0; attempt < 200; attempt++) { if (await condition()) return; await new Promise(resolvePromise => setTimeout(resolvePromise, 25)); }
        throw new Error(message);
    };
    const open = () => { const child = spawn(process.execPath, [cli, '--root', root, 'open', repository], { stdio: ['ignore', 'pipe', 'pipe'] }); launched.push(child); return child; };
    const output = new Map<ReturnType<typeof spawn>, string>();
    const track = (child: ReturnType<typeof spawn>) => { output.set(child, ''); for (const stream of [child.stdout, child.stderr]) stream?.on('data', chunk => output.set(child, output.get(child)! + chunk)); };
    try {
        const first = open(); track(first);
        await waitFor(async () => { if (first.exitCode !== null || first.signalCode !== null) throw new Error(`first CLI host exited: ${output.get(first)}`); try { return (await readFile(join(root, 'tuis.log'), 'utf8')).trim().split('\n').length >= 1; } catch { return false; } }, 'first CLI host did not become live');
        await waitFor(async () => { try { await lstat(join(root, 'start.lock')); return false; } catch (error) { return error instanceof Error && 'code' in error && error.code === 'ENOENT'; } }, 'first CLI host retained start.lock');

        const catalogue = await nodeSpawner(process.env)([process.execPath, cli, '--root', root, 'models'], { cwd: repository, timeout: 10_000 });
        assert.equal(catalogue.ok, true, catalogue.stderr); assert.match(catalogue.stdout, /fixture\/old/);
        await callBroker(socket, admin, 'configure-global', { models: ['fixture/new'], expectedRevision: 1 });

        const firstConfigHome = (await readFile(join(root, 'tuis.log'), 'utf8')).trim().split('\n')[0]!;
        const firstConfig = JSON.parse(await readFile(join(firstConfigHome, 'opencode', 'opencode.json'), 'utf8'));
        const firstControl = firstConfig.mcp.servers.control.environment.NARU_PREVIEW_CAPABILITY;
        assert.ok(Object.values(firstConfig.agents).some(agent => (agent as { model?: { model?: string } }).model?.model === 'old'));
        await assert.rejects(callBroker(socket, firstControl, 'start', { requestId: 'new-on-old', role: 'runner', model: 'fixture/new', prompt: 'no' }), /frozen worker pool/);
        const oldTask = await callBroker(socket, firstControl, 'start', { requestId: 'old-on-old', role: 'runner', model: 'fixture/old', prompt: 'synthetic' }) as { id: string };
        await waitFor(async () => ((await callBroker(socket, admin, 'status', {}) as { managedWorkers: Array<{ id: string; state: string }> }).managedWorkers.find(task => task.id === oldTask.id)?.state === 'completed'), 'managed worker did not complete on the first frozen pool');

        const second = open(); track(second);
        await waitFor(async () => (await readFile(join(root, 'tuis.log'), 'utf8')).trim().split('\n').length >= 2, 'second CLI host did not become live');
        const secondConfigHome = (await readFile(join(root, 'tuis.log'), 'utf8')).trim().split('\n')[1]!;
        const secondConfig = JSON.parse(await readFile(join(secondConfigHome, 'opencode', 'opencode.json'), 'utf8'));
        const secondControl = secondConfig.mcp.servers.control.environment.NARU_PREVIEW_CAPABILITY;
        assert.ok(Object.values(secondConfig.agents).some(agent => (agent as { model?: { model?: string } }).model?.model === 'new'));
        assert.deepEqual((await callBroker(socket, secondControl, 'status', {}) as { workerModelProfile: { models: string[] } }).workerModelProfile.models, ['fixture/new']);

        const trueExecutable = join(temporary, 'owned-native'); await cp('/usr/bin/true', trueExecutable); await chmod(trueExecutable, 0o755);
        await writeFile(join(root, 'host.json'), JSON.stringify({ ...host, cli: join(root, 'lib', 'tools', 'naru-preview.mjs'), executable: trueExecutable, executableHash: createHash('sha256').update(await readFile(trueExecutable)).digest('hex') }), { mode: 0o600 });
        await assert.rejects(applyPreparedOc2CodeRefresh({ previewCli: cli, root }), /broker\.sock exists|daemon is running|preview process is running/i);

        first.kill('SIGTERM'); await new Promise<void>((resolvePromise, reject) => { first.once('exit', () => resolvePromise()); first.once('error', reject); });
        assert.equal(second.exitCode, null, output.get(second));
        second.kill('SIGTERM'); await new Promise<void>((resolvePromise, reject) => { second.once('exit', () => resolvePromise()); second.once('error', reject); });
    } finally {
        for (const child of launched) if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
        try {
            for (const line of (await readFile(join(root, 'processes.log'), 'utf8')).trim().split('\n')) {
                const pid = Number(line.split(' ', 1)[0]);
                if (Number.isSafeInteger(pid) && pid > 1) try { process.kill(pid, 'SIGKILL'); } catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ESRCH')) throw error; }
            }
        } catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error; }
        try { await stopBroker(socket, admin); } catch {}
        await rm(temporary, { recursive: true, force: true });
    }
});

test('open filesystem root launches with a synthetic host without enumerating root', { timeout: 20_000 }, async () => {
    const temporary = await realpath(await mkdtemp(join(tmpdir(), 'naru-root-open-'))), root = join(temporary, 'preview'), executable = join(temporary, 'fake-opencode');
    const cli = join(built, 'tools', 'naru-preview.mjs'), admin = 'synthetic-admin', socket = join(root, 'broker.sock');
    await mkdir(root, { mode: 0o700 });
    const fake = `#!${process.execPath}
const fs=require('node:fs'),http=require('node:http'),path=require('node:path');const command=process.argv[2];const root=path.dirname(path.dirname(process.env.OPENCODE_DB));
if(command==='serve'){const server=http.createServer((req,res)=>{if(req.method==='POST'&&req.url.startsWith('/api/plugin/await-activation'))return res.writeHead(204).end();if(req.url.startsWith('/api/mcp')){for(const file of (process.env.NARU_PREVIEW_MCP_READY_FILES||'').split(':').filter(Boolean)){fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,'ready\\n')}const names=(process.env.NARU_PREVIEW_REQUIRED_MCP||'').split(',').filter(Boolean);res.setHeader('content-type','application/json');return res.end(JSON.stringify({data:names.map(name=>({name,status:{status:'connected'}}))}))}res.writeHead(404).end('{}')});server.listen(0,'127.0.0.1',()=>console.log(JSON.stringify({url:'http://127.0.0.1:'+server.address().port})));setInterval(()=>{},1000)}
else if(command==='--server'){fs.writeFileSync(path.join(root,'root-opened'),'launched without repository file requests\\n');setInterval(()=>{},1000)}
else process.exit(2);
`;
    await writeFile(executable, fake, { mode: 0o755 }); await chmod(executable, 0o755);
    const host = { root, executable, executableHash: createHash('sha256').update(await readFile(executable)).digest('hex'), node: process.execPath, cli };
    const rootInfo = await lstat('/', { bigint: true });
    await writeFile(join(root, 'host.json'), JSON.stringify(host), { mode: 0o600 }); await writeFile(join(root, 'admin'), admin, { mode: 0o600 });
    await writeFile(join(root, 'state.json'), JSON.stringify({ schemaVersion: 6, globalWorkerPool: { models: ['fixture/model'], revision: 1 }, globalInstructions: { revision: 0, source: null }, repositories: [{ path: '/', kind: 'directory', access: 'inspect', writeScopes: [], revision: 1, rootIdentity: { dev: String(rootInfo.dev), ino: String(rootInfo.ino) } }], tasks: [] }), { mode: 0o600 });
    const child = spawn(process.execPath, [cli, '--root', root, 'open', '/'], { stdio: ['ignore', 'pipe', 'pipe'] });
    let output = ''; for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { output += chunk; });
    try {
        for (let attempt = 0; attempt < 200; attempt++) {
            try { if ((await readFile(join(root, 'root-opened'), 'utf8')).includes('without repository file requests')) break; }
            catch {}
            if (child.exitCode !== null || child.signalCode !== null) throw new Error(`root open exited: ${output}`);
            if (attempt === 199) throw new Error(`root open did not launch: ${output}`);
            await new Promise(resolvePromise => setTimeout(resolvePromise, 25));
        }
    } finally {
        if (child.exitCode === null && child.signalCode === null) {
            child.kill('SIGTERM');
            await new Promise(resolvePromise => child.once('exit', resolvePromise));
        }
        try { await stopBroker(socket, admin); } catch {}
        await rm(temporary, { recursive: true, force: true });
    }
});

test('oc2 installer refuses an existing launcher before creating a preview root', async () => {
    const root = await mkdtemp(join(tmpdir(), 'naru-oc2-install-test-'));
    try {
        const bin = join(root, 'oc2'); await writeFile(bin, 'existing');
        const installRoot = join(root, 'preview');
        await assert.rejects(installOc2({ previewCli: '/missing/preview', opencode: '/missing/raw', v2Wrapper: '/missing/wrapper', root: installRoot, bin }), /refusing to overwrite/);
        await assert.rejects(readFile(installRoot), { code: 'ENOENT' });
    } finally { await rm(root, { recursive: true, force: true }); }
});

test('fresh installer stages native profile and launcher while retaining legacy recovery explicitly', async () => {
    const temporary = await realpath(await mkdtemp(join(tmpdir(), 'naru-oc2-native-install-')));
    try {
        const root = join(temporary, 'preview'), bin = join(temporary, 'oc2'), previewCli = join(temporary, 'setup.mjs');
        const wrapper = join(temporary, 'opencode2-naru'); await writeFile(wrapper, '#!/bin/sh\nexit 0\n', { mode: 0o755 }); await chmod(wrapper, 0o755);
        await writeFile(previewCli, `import{mkdir,writeFile}from'node:fs/promises';import{join}from'node:path';const a=process.argv.slice(2),root=a[a.indexOf('--root')+1],opencode=a[a.indexOf('--opencode')+1];await mkdir(join(root,'lib','tools'),{recursive:true});await writeFile(join(root,'lib','tools','oc2.mjs'),'// staged native launcher module\\n');await writeFile(join(root,'naru-preview'),'#!/bin/sh\\nexit 0\\n',{mode:0o755});await writeFile(join(root,'host.json'),JSON.stringify({root,executable:opencode,executableHash:'0'.repeat(64),node:process.execPath,cli:join(root,'lib','tools','naru-preview.mjs')}),{mode:0o600});\n`, { mode: 0o600 });
        await installOc2({ previewCli, opencode: '/usr/bin/true', v2Wrapper: wrapper, root, bin });
        const launcher = await readFile(bin, 'utf8');
        assert.match(launcher, /NARU_OC2_ROOT=/); assert.match(launcher, /NARU_OC2_LEGACY=/); assert.doesNotMatch(launcher, /NARU_OC2_V2_WRAPPER|NARU_OC2_PREVIEW/);
        const config = JSON.parse(await readFile(join(root, 'profile', 'config', 'opencode', 'opencode.json'), 'utf8'));
        assert.equal(config.agents.naru.mode, 'primary'); assert.equal(config.agents.naru.model, undefined);
        assert.equal(await readFile(join(root, 'naru-preview'), 'utf8'), '#!/bin/sh\nexit 0\n');
    } finally { await rm(temporary, { recursive: true, force: true }); }
});

test('oc2 updater pins exact public artifacts and requires the exact predecessor', () => {
    assert.equal(OC2_UPDATE_RELEASE.predecessorVersion, '0.0.0-beta-19425');
    assert.equal(OC2_UPDATE_RELEASE.version, '2.0.15');
    assert.equal(OC2_UPDATE_RELEASE.wrapper.package, '@opencode/cli');
    assert.equal(OC2_UPDATE_RELEASE.wrapper.sri, 'sha512-Ynxz9HRJiHQBotBrQeEt3T/3TyEpkwdZkMTE7HPxT2nB1IU3WAqFXBYiIpWTYLKifXga4L5UG0sXEDISe/rJxg==');
    assert.equal(OC2_UPDATE_RELEASE.native['darwin-arm64'].package, '@opencode/cli-darwin-arm64');
    assert.equal(OC2_UPDATE_RELEASE.native['darwin-arm64'].sri, 'sha512-qIFmkv6f01Deih/DH+OvblNQEZrAUal54PjUHLu61zS5OYCpXnRjkYWHV3RiEZhP5DtfQZsJeitmMW5v6f2NTw==');
    assert.equal(OC2_UPDATE_RELEASE.native['linux-x64'].package, '@opencode/cli-linux-x64');
    assert.equal(OC2_UPDATE_RELEASE.native['linux-x64'].sri, 'sha512-PGVHuIb6uDgCx19zbD3wGwDYBZLeZnZY89c28SCcB87ckAgfOp+L2o7rra1TMbyQVLhZAqccbymWDeqrynfOCA==');
    assert.doesNotThrow(() => validateOc2PredecessorVersion('opencode2 v0.0.0-beta-19425\n'));
    for (const value of ['opencode v2.0.15', 'v0.0.0-beta-19425', 'opencode2 v0.0.0-beta-19271']) assert.throws(() => validateOc2PredecessorVersion(value), /exact predecessor/);
    assert.doesNotThrow(() => validateOc2UpdaterTarget('2.0.15', ['2.0.15']));
    assert.throws(() => validateOc2UpdaterTarget('0.0.0-beta-19425', ['2.0.15']), /does not target exact/);
    assert.throws(() => validateOc2UpdaterTarget('2.0.15', ['0.0.0-beta-19425']), /does not target exact/);
});

test('built --update CLI dispatch accepts its action while rejecting missing or unsafe paths', async () => {
    const temporary = await realpath(await mkdtemp(join(tmpdir(), 'naru-oc2-cli-update-')));
    try {
        const root = join(temporary, 'preview'); await mkdir(root, { mode: 0o700 });
        const previewCli = join(built, 'tools', 'naru-preview.mjs'), v2Wrapper = join(temporary, 'missing-wrapper'), nativeRoot = join(temporary, 'missing-native');
        const cli = join(built, 'tools', 'install-oc2.mjs');
        const args = ['--update', '--preview-cli', previewCli, '--v2-wrapper', v2Wrapper, '--root', root, '--native-root', nativeRoot];
        const run = (argv: string[]) => nodeSpawner(process.env)([process.execPath, cli, ...argv], { timeout: 10_000 });
        const missing = await run(args);
        assert.equal(missing.ok, false); assert.doesNotMatch(missing.stderr, /action must be an absolute path/);
        assert.match(missing.stderr, /ENOENT.*host\.json/);
        await assert.rejects(lstat(join(root, 'start.lock')), { code: 'ENOENT' });
        const requiredPath = await run(args.slice(0, -1));
        assert.equal(requiredPath.ok, false); assert.match(requiredPath.stderr, /--native-root requires a value/);
        for (const label of ['previewCli', 'v2Wrapper', 'root', 'nativeRoot'] as const) {
            await assert.rejects(updateOc2({ previewCli, v2Wrapper, root, nativeRoot, [label]: 'relative' }), new RegExp(`${label} must be an absolute path`));
        }
        await assert.rejects(lstat(join(root, 'start.lock')), { code: 'ENOENT' });
    } finally { await rm(temporary, { recursive: true, force: true }); }
});

test('oc2 updater changes only technical host targets and preserves preview state byte-for-byte', async () => {
    const temporary = await mkdtemp(join(tmpdir(), 'naru-oc2-update-test-'));
    try {
        const root = join(temporary, 'preview'); await mkdir(root, { mode: 0o700 });
        const installedTools = join(root, 'lib', 'tools'); await mkdir(installedTools, { recursive: true }); await writeFile(join(installedTools, 'old.txt'), 'old snapshot');
        const previewCli = join(built, 'tools', 'naru-preview.mjs');
        const arbitraryTools = join(temporary, 'candidate-tools'); await mkdir(arbitraryTools); const arbitraryPreviewCli = join(arbitraryTools, 'naru-preview.mjs'); await writeFile(arbitraryPreviewCli, 'candidate preview');
        const oldExecutable = join(temporary, 'opencode-19425'); await cp(process.execPath, oldExecutable);
        const newDirectory = join(temporary, 'versions', '2.0.15'); await mkdir(newDirectory, { recursive: true });
        let executable = join(newDirectory, 'opencode2'); await cp(process.execPath, executable); await chmod(executable, 0o755); executable = await realpath(executable);
        const wrapper = join(temporary, 'opencode2-naru');
        const wrapperPrefix = '#!/bin/sh\nset -eu\nroot=/isolated\nexport HOME="$root/home"\nexport OPENCODE_DB="$root/state/opencode.db"\n';
        await writeFile(wrapper, `${wrapperPrefix}exec '${oldExecutable}' "$@"\n`, { mode: 0o755 });
        const host = { root, executable: oldExecutable, executableHash: createHash('sha256').update(await readFile(oldExecutable)).digest('hex'), node: process.execPath, cli: join(root, 'lib', 'tools', 'naru-preview.mjs') };
        await writeFile(join(root, 'host.json'), JSON.stringify(host, null, 2) + '\n', { mode: 0o600 });
        await writeFile(join(root, 'naru-preview'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });

        const preserved = new Map<string, Buffer>();
        for (const [relative, bytes] of [
            ['admin', Buffer.from('synthetic-admin-token')],
            ['state.json', Buffer.from(JSON.stringify({ schemaVersion: 5, globalWorkerPool: { models: ['provider/worker'], revision: 6 }, globalInstructions: { revision: 3, source: { sourcePath: '/fixture/home/AGENTS.md', canonicalPath: '/fixture/home/AGENTS.md' } }, repositories: [{ path: '/synthetic/repo', access: 'inspect', writeScopes: [], revision: 3 }], tasks: [] }))],
            ['host-data/opencode.db', Buffer.from([0, 1, 2, 3, 255])],
            ['hosts/main/config/opencode/opencode.json', Buffer.from(JSON.stringify({ model: 'provider/astra', preferences: { reasoning: 'high' } }))],
            ['worktrees/attempt-1/keep.txt', Buffer.from('unchanged worktree')],
        ] as const) {
            const target = join(root, relative); await mkdir(dirname(target), { recursive: true }); await writeFile(target, bytes); preserved.set(relative, bytes);
        }

        await assert.rejects(applyPreparedOc2Update({ previewCli: arbitraryPreviewCli, v2Wrapper: wrapper, root, executable }), /updater own compiled tree/);
        await assert.rejects(lstat(join(root, 'start.lock')), { code: 'ENOENT' });
        assert.equal(await readFile(join(root, 'lib', 'tools', 'old.txt'), 'utf8'), 'old snapshot');
        await applyPreparedOc2Update({ previewCli, v2Wrapper: wrapper, root, executable });

        for (const [relative, bytes] of preserved) assert.deepEqual(await readFile(join(root, relative)), bytes, relative);
        assert.ok((await readFile(join(root, 'lib', 'tools', 'naru-preview.mjs'), 'utf8')).length > 0);
        await assert.rejects(readFile(join(root, 'lib', 'tools', 'old.txt')), { code: 'ENOENT' });
        const updatedHost = JSON.parse(await readFile(join(root, 'host.json'), 'utf8'));
        assert.deepEqual(Object.keys(updatedHost).sort(), ['cli', 'executable', 'executableHash', 'node', 'root']);
        assert.equal(updatedHost.executable, executable);
        assert.equal(updatedHost.executableHash, createHash('sha256').update(await readFile(executable)).digest('hex'));
        assert.equal(await readFile(wrapper, 'utf8'), `${wrapperPrefix}exec '${executable}' "$@"\n`);
        assert.deepEqual(await readFile(oldExecutable), await readFile(process.execPath));
        const recovery = join(root, 'update-recovery-0.0.0-beta-19425');
        assert.equal(await readFile(join(recovery, 'host.json'), 'utf8'), JSON.stringify(host, null, 2) + '\n');
        assert.equal(await readFile(join(recovery, 'opencode2-naru'), 'utf8'), `${wrapperPrefix}exec '${oldExecutable}' "$@"\n`);
        assert.equal(await readFile(join(root, 'naru-preview'), 'utf8'), '#!/bin/sh\nexit 0\n');
        await writeFile(join(root, 'broker.sock'), 'synthetic occupied socket path');
        await assert.rejects(applyPreparedOc2Update({ previewCli, v2Wrapper: wrapper, root, executable }), /broker\.sock exists/);
    } finally { await rm(temporary, { recursive: true, force: true }); }
});

const actualPredecessor = process.env.NARU_OC2_UPDATE_E2E_PREDECESSOR;
test('public native updater preserves committed and rolled-back generations and upgrades via the built CLI', {
    skip: process.platform !== 'darwin' || process.arch !== 'arm64' || !actualPredecessor,
    timeout: 240_000,
}, async () => {
    const temporary = await realpath(await mkdtemp(join(tmpdir(), 'naru-oc2-public-update-')));
    try {
        const nativeRoot = join(temporary, 'native'), predecessorDirectory = join(nativeRoot, 'versions', '0.0.0-beta-19425');
        await mkdir(predecessorDirectory, { recursive: true, mode: 0o700 });
        const predecessor = join(predecessorDirectory, 'opencode2'); await cp(actualPredecessor!, predecessor); await chmod(predecessor, 0o755);
        const version = await nodeSpawner(cleanProcessEnvironment(process.execPath))([predecessor, '--version'], { cwd: temporary, timeout: 10_000 });
        assert.equal(version.ok, true, version.stderr); assert.equal(version.stdout.trim(), 'opencode2 v0.0.0-beta-19425');

        const root = join(temporary, 'preview'); await mkdir(join(root, 'lib', 'tools'), { recursive: true, mode: 0o700 });
        await writeFile(join(root, 'lib', 'tools', 'old.txt'), 'beta-19425 compiled snapshot');
        const previewCli = join(built, 'tools', 'naru-preview.mjs'), wrapper = join(temporary, 'opencode2-naru');
        const wrapperPrefix = '#!/bin/sh\nset -eu\numask 077\nroot=/synthetic-isolated\n';
        const host = { root, executable: predecessor, executableHash: createHash('sha256').update(await readFile(predecessor)).digest('hex'), node: process.execPath, cli: join(root, 'lib', 'tools', 'naru-preview.mjs') };
        await writeFile(join(root, 'naru-preview'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
        const misplaced = join(nativeRoot, 'opencode2'); await cp(predecessor, misplaced); await chmod(misplaced, 0o755);
        const misplacedHost = { ...host, executable: misplaced, executableHash: createHash('sha256').update(await readFile(misplaced)).digest('hex') };
        await writeFile(join(root, 'host.json'), JSON.stringify(misplacedHost, null, 2) + '\n', { mode: 0o600 });
        await writeFile(wrapper, `${wrapperPrefix}exec '${misplaced}' "$@"\n`, { mode: 0o755 });
        await assert.rejects(updateOc2({ previewCli, v2Wrapper: wrapper, root, nativeRoot }), /exact versioned predecessor/);
        await writeFile(join(root, 'host.json'), JSON.stringify(host, null, 2) + '\n', { mode: 0o600 });
        await writeFile(wrapper, `${wrapperPrefix}exec '${predecessor}' "$@"\n`, { mode: 0o755 });
        const preserved = new Map<string, Buffer>();
        for (const [relative, bytes] of [
            ['admin', Buffer.from('synthetic-admin-token')],
            ['state.json', Buffer.from(JSON.stringify({ schemaVersion: 5, globalWorkerPool: { models: ['fixture/alpha#high'], revision: 7 }, globalInstructions: { revision: 5, source: { sourcePath: '/synthetic/home/AGENTS.md', canonicalPath: '/synthetic/home/AGENTS.md' } }, repositories: [{ path: '/synthetic/repository', access: 'write', writeScopes: ['src/**'], revision: 4 }], tasks: [] }))],
            ['host-data/opencode.db', Buffer.from([83, 81, 76, 105, 116, 101, 0, 255])],
            ['hosts/main/config/opencode/opencode.json', Buffer.from(JSON.stringify({ model: 'fixture/gpt-5.4', variant: 'high', preferences: { theme: 'synthetic' } }))],
            ['worktrees/attempt-5/keep.txt', Buffer.from('synthetic worktree bytes')],
        ] as const) {
            const target = join(root, relative); await mkdir(dirname(target), { recursive: true }); await writeFile(target, bytes); preserved.set(relative, bytes);
        }

        const cleanupWarnings: string[] = [];
        const executable = await updateOc2({ previewCli, v2Wrapper: wrapper, root, nativeRoot }, {
            cleanupCommittedSwap: async () => { throw new Error('synthetic committed cleanup failure'); },
            report: message => cleanupWarnings.push(message),
        });
        assert.equal(executable, join(nativeRoot, 'versions', '2.0.15', 'opencode2'));
        const updatedVersion = await nodeSpawner(cleanProcessEnvironment(process.execPath))([executable, '--version'], { cwd: temporary, timeout: 10_000 });
        assert.equal(updatedVersion.ok, true, updatedVersion.stderr); assert.equal(updatedVersion.stdout.trim(), 'opencode v2.0.15');
        const updatedHost = JSON.parse(await readFile(join(root, 'host.json'), 'utf8'));
        assert.equal(updatedHost.executable, executable); assert.equal(updatedHost.executableHash, createHash('sha256').update(await readFile(executable)).digest('hex'));
        assert.equal(await readFile(wrapper, 'utf8'), `${wrapperPrefix}exec '${executable}' "$@"\n`);
        const wrapperVersion = await nodeSpawner(cleanProcessEnvironment(process.execPath))([wrapper, '--version'], { cwd: temporary, timeout: 10_000 });
        assert.equal(wrapperVersion.ok, true, wrapperVersion.stderr); assert.equal(wrapperVersion.stdout.trim(), 'opencode v2.0.15');
        assert.ok((await readFile(join(root, 'lib', 'tools', 'naru-preview.mjs'), 'utf8')).length > 0);
        await assert.rejects(lstat(join(root, 'start.lock')), { code: 'ENOENT' });
        assert.deepEqual(cleanupWarnings, ['oc2 native update committed successfully, but old-generation staging could not be removed; the active generation was not rolled back']);
        assert.deepEqual(await readFile(predecessor), await readFile(actualPredecessor!));
        for (const [relative, bytes] of preserved) assert.deepEqual(await readFile(join(root, relative)), bytes, relative);
        assert.equal(await readFile(join(root, 'update-recovery-0.0.0-beta-19425', 'host.json'), 'utf8'), JSON.stringify(host, null, 2) + '\n');

        const rollbackNativeRoot = join(temporary, 'rollback-native'), rollbackPredecessorDirectory = join(rollbackNativeRoot, 'versions', '0.0.0-beta-19425');
        await mkdir(rollbackPredecessorDirectory, { recursive: true, mode: 0o700 });
        const rollbackPredecessor = join(rollbackPredecessorDirectory, 'opencode2'); await cp(actualPredecessor!, rollbackPredecessor); await chmod(rollbackPredecessor, 0o755);
        const rollbackRoot = join(temporary, 'rollback-preview'), rollbackTools = join(rollbackRoot, 'lib', 'tools'); await mkdir(rollbackTools, { recursive: true, mode: 0o700 });
        await writeFile(join(rollbackTools, 'old.txt'), 'working beta-19425 tools');
        const rollbackWrapper = join(temporary, 'rollback-opencode2-naru'), rollbackPrefix = '#!/bin/sh\nset -eu\n';
        await writeFile(rollbackWrapper, `${rollbackPrefix}exec '${rollbackPredecessor}' "$@"\n`, { mode: 0o755 });
        const rollbackHost = { root: rollbackRoot, executable: rollbackPredecessor, executableHash: createHash('sha256').update(await readFile(rollbackPredecessor)).digest('hex'), node: process.execPath, cli: join(rollbackRoot, 'lib', 'tools', 'naru-preview.mjs') };
        await writeFile(join(rollbackRoot, 'host.json'), JSON.stringify(rollbackHost, null, 2) + '\n', { mode: 0o600 });
        await writeFile(join(rollbackRoot, 'naru-preview'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
        const rollbackTarget = join(rollbackNativeRoot, 'versions', '2.0.15', 'opencode2');
        await assert.rejects(updateOc2({ previewCli, v2Wrapper: rollbackWrapper, root: rollbackRoot, nativeRoot: rollbackNativeRoot }, {
            prepareNative: async () => {
                await mkdir(dirname(rollbackTarget), { recursive: true, mode: 0o700 }); await cp(executable, rollbackTarget); await chmod(rollbackTarget, 0o755);
                return { executable: rollbackTarget, cleanup: async () => {} };
            },
            beforeSwitch: async () => { throw new Error('synthetic pre-commit failure'); },
        }), /synthetic pre-commit failure/);
        await assert.rejects(lstat(dirname(rollbackTarget)), { code: 'ENOENT' });
        assert.equal(await readFile(join(rollbackTools, 'old.txt'), 'utf8'), 'working beta-19425 tools');
        assert.equal(JSON.parse(await readFile(join(rollbackRoot, 'host.json'), 'utf8')).executable, rollbackPredecessor);
        assert.equal(await readFile(rollbackWrapper, 'utf8'), `${rollbackPrefix}exec '${rollbackPredecessor}' "$@"\n`);
        const rollbackVersion = await nodeSpawner(cleanProcessEnvironment(process.execPath))([rollbackWrapper, '--version'], { cwd: temporary, timeout: 10_000 });
        assert.equal(rollbackVersion.ok, true, rollbackVersion.stderr); assert.equal(rollbackVersion.stdout.trim(), 'opencode2 v0.0.0-beta-19425');
        await assert.rejects(lstat(join(rollbackRoot, 'start.lock')), { code: 'ENOENT' });
        assert.equal(await readFile(join(rollbackRoot, 'update-recovery-0.0.0-beta-19425', 'host.json'), 'utf8'), JSON.stringify(rollbackHost, null, 2) + '\n');

        const cliNativeRoot = join(temporary, 'cli-native'), cliPredecessor = join(cliNativeRoot, 'versions', '0.0.0-beta-19425', 'opencode2');
        await mkdir(dirname(cliPredecessor), { recursive: true, mode: 0o700 }); await cp(rollbackPredecessor, cliPredecessor); await chmod(cliPredecessor, 0o755);
        const cliRoot = join(temporary, 'cli-preview'), cliTools = join(cliRoot, 'lib', 'tools'); await mkdir(cliTools, { recursive: true, mode: 0o700 });
        await writeFile(join(cliTools, 'old.txt'), 'beta compiled snapshot');
        const cliWrapper = join(temporary, 'cli-opencode2-naru'); await writeFile(cliWrapper, `#!/bin/sh\nexec '${cliPredecessor}' "$@"\n`, { mode: 0o755 });
        await writeFile(join(cliRoot, 'naru-preview'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
        const cliHost = { root: cliRoot, executable: cliPredecessor, executableHash: createHash('sha256').update(await readFile(cliPredecessor)).digest('hex'), node: process.execPath, cli: join(cliTools, 'naru-preview.mjs') };
        await writeFile(join(cliRoot, 'host.json'), JSON.stringify(cliHost, null, 2) + '\n', { mode: 0o600 });
        const cliResult = await nodeSpawner(cleanProcessEnvironment(process.execPath))([process.execPath, join(built, 'tools', 'install-oc2.mjs'), '--update', '--preview-cli', previewCli, '--v2-wrapper', cliWrapper, '--root', cliRoot, '--native-root', cliNativeRoot], { cwd: temporary, timeout: 120_000 });
        assert.equal(cliResult.ok, true, cliResult.stderr);
        const cliExecutable = join(cliNativeRoot, 'versions', '2.0.15', 'opencode2');
        assert.match(cliResult.stdout, /Updated oc2 preview to 2\.0\.15/);
        const cliUpdatedHost = JSON.parse(await readFile(join(cliRoot, 'host.json'), 'utf8'));
        assert.equal(cliUpdatedHost.executable, cliExecutable);
        assert.equal(cliUpdatedHost.executableHash, createHash('sha256').update(await readFile(cliExecutable)).digest('hex'));
        const cliVersion = await nodeSpawner(cleanProcessEnvironment(process.execPath))([cliWrapper, '--version'], { cwd: temporary, timeout: 10_000 });
        assert.equal(cliVersion.ok, true, cliVersion.stderr); assert.equal(cliVersion.stdout.trim(), 'opencode v2.0.15');
        assert.deepEqual(await readFile(cliPredecessor), await readFile(rollbackPredecessor));
        await assert.rejects(lstat(join(cliRoot, 'start.lock')), { code: 'ENOENT' });
    } finally { await rm(temporary, { recursive: true, force: true }); }
});

test('same-pin code refresh replaces only the compiled tools and preserves native host, login, policy, and launcher bytes', async () => {
    const temporary = await mkdtemp(join(tmpdir(), 'naru-oc2-refresh-test-'));
    try {
        const root = join(temporary, 'preview'); await mkdir(join(root, 'lib', 'tools'), { recursive: true, mode: 0o700 });
        await writeFile(join(root, 'lib', 'tools', 'old.txt'), 'old code');
        const executable = join(temporary, 'opencode2'); await cp(process.execPath, executable); await chmod(executable, 0o755);
        const host = { root, executable: await realpath(executable), executableHash: createHash('sha256').update(await readFile(executable)).digest('hex'), node: process.execPath, cli: join(root, 'lib', 'tools', 'naru-preview.mjs') };
        await writeFile(join(root, 'host.json'), JSON.stringify(host), { mode: 0o600 });
        const launcher = Buffer.from('#!/bin/sh\nexit 0\n'); await writeFile(join(root, 'naru-preview'), launcher, { mode: 0o755 });
        const preserved = new Map<string, Buffer>();
        for (const [relative, content] of [['admin', 'synthetic-token'], ['state.json', '{"schemaVersion":5,"globalWorkerPool":{"models":["fixture/worker"],"revision":2},"globalInstructions":{"revision":7,"source":{"sourcePath":"/fixture/home/AGENTS.md","canonicalPath":"/fixture/home/AGENTS.md"}},"repositories":[{"path":"/fixture/repo","access":"inspect","writeScopes":[],"revision":1}],"tasks":[]}'], ['host-data/opencode.db', 'synthetic login db']] as const) {
            const path = join(root, relative); await mkdir(dirname(path), { recursive: true }); const bytes = Buffer.from(content); await writeFile(path, bytes); preserved.set(relative, bytes);
        }
        await applyPreparedOc2CodeRefresh({ previewCli: join(built, 'tools', 'naru-preview.mjs'), root });
        for (const [relative, bytes] of preserved) assert.deepEqual(await readFile(join(root, relative)), bytes);
        assert.deepEqual(await readFile(join(root, 'host.json')), Buffer.from(JSON.stringify(host)));
        assert.deepEqual(await readFile(join(root, 'naru-preview')), launcher);
        const wizard = await readFile(join(root, 'lib', 'tools', 'naru-lib', 'preview-wizard.mjs'), 'utf8');
        assert.ok(wizard.includes('runPreviewWizard')); assert.ok(wizard.includes('autocompleteMultiselect'));
        assert.match(await readFile(join(root, 'lib', 'tools', 'naru-lib', 'global-instructions.mjs'), 'utf8'), /prepareGlobalInstructions/);
        assert.doesNotMatch(wizard, /from ["'](?:@clack|fast-|sisteransi)/);
        assert.match(await readFile(join(root, 'lib', 'tools', 'THIRD_PARTY_NOTICES'), 'utf8'), /@clack\/prompts 1\.8\.0/);
        await assert.rejects(lstat(join(root, 'lib', 'tools', 'node_modules')), { code: 'ENOENT' });
        await assert.rejects(lstat(join(root, 'lib', 'tools', 'old.txt')), { code: 'ENOENT' });
        await assert.rejects(lstat(join(root, 'start.lock')), { code: 'ENOENT' });
    } finally { await rm(temporary, { recursive: true, force: true }); }
});

test('code refresh records switching with validated backups before the first destructive rename', async () => {
    const temporary = await mkdtemp(join(tmpdir(), 'naru-oc2-refresh-phase-test-'));
    try {
        const root = join(temporary, 'preview'), tools = join(root, 'lib', 'tools'); await mkdir(tools, { recursive: true, mode: 0o700 });
        await writeFile(join(tools, 'old.txt'), 'old code');
        const executable = join(temporary, 'opencode2'); await cp(process.execPath, executable); await chmod(executable, 0o755);
        const host = { root, executable: await realpath(executable), executableHash: createHash('sha256').update(await readFile(executable)).digest('hex'), node: process.execPath, cli: join(tools, 'naru-preview.mjs') };
        await writeFile(join(root, 'host.json'), JSON.stringify(host), { mode: 0o600 });
        const launcher = Buffer.from('#!/bin/sh\nexit 0\n'); await writeFile(join(root, 'naru-preview'), launcher, { mode: 0o755 });

        await assert.rejects(applyPreparedOc2CodeRefresh({ previewCli: join(built, 'tools', 'naru-preview.mjs'), root }, { beforeFirstRename: async () => {
            const phase = JSON.parse(await readFile(join(root, 'start.lock', 'phase.json'), 'utf8')) as { phase: string; validatedBackups: boolean; backupPaths: { tools: string; launcher: string } };
            assert.equal(phase.phase, 'switching'); assert.equal(phase.validatedBackups, true);
            assert.equal(await readFile(join(phase.backupPaths.tools, 'old.txt'), 'utf8'), 'old code');
            assert.deepEqual(await readFile(phase.backupPaths.launcher), launcher);
            assert.equal(await readFile(join(tools, 'old.txt'), 'utf8'), 'old code'); assert.deepEqual(await readFile(join(root, 'naru-preview')), launcher);
            throw new Error('synthetic before-first-rename failure');
        } }), /synthetic before-first-rename failure/);
        assert.equal(await readFile(join(tools, 'old.txt'), 'utf8'), 'old code'); assert.deepEqual(await readFile(join(root, 'naru-preview')), launcher);
        await assert.rejects(lstat(join(root, 'start.lock')), { code: 'ENOENT' });
    } finally { await rm(temporary, { recursive: true, force: true }); }
});

test('committed code refresh cleanup failures warn without entering rollback', async () => {
    const reports: string[] = []; let cleanupCalls = 0;
    const result = await cleanupCommittedOc2CodeRefresh(async () => { cleanupCalls++; throw new Error('synthetic cleanup failure'); }, message => reports.push(message));
    assert.equal(cleanupCalls, 1); assert.match(result.warning ?? '', /committed successfully.*not rolled back/); assert.deepEqual(reports, [result.warning]);
});
