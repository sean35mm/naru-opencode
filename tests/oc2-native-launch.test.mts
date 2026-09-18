import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { planOc2NativeLaunch, runOc2Native } from '../tools/naru-lib/oc2-native-launch.mjs';
import { loadOc2NativeModelProfile } from '../tools/naru-lib/oc2-native-config.mjs';
import { oc2NativePaths } from '../tools/naru-lib/oc2-profile.mjs';

async function fixture() {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'naru-oc2-native-launch-'))), executable = join(root, 'fake-opencode');
    await writeFile(executable, `#!${process.execPath}\nconst fs=require('fs'),path=require('path'),argv=process.argv.slice(2),record={argv,cwd:process.cwd(),env:{HOME:process.env.HOME,PATH:process.env.PATH,XDG_CONFIG_HOME:process.env.XDG_CONFIG_HOME,XDG_DATA_HOME:process.env.XDG_DATA_HOME,XDG_CACHE_HOME:process.env.XDG_CACHE_HOME,XDG_STATE_HOME:process.env.XDG_STATE_HOME,OPENCODE_DB:process.env.OPENCODE_DB,OPENCODE_CONFIG:process.env.OPENCODE_CONFIG,OPENCODE_CONFIG_DIR:process.env.OPENCODE_CONFIG_DIR,OPENCODE_CONFIG_CONTENT:process.env.OPENCODE_CONFIG_CONTENT,OPENCODE_DISABLE_PROJECT_CONFIG:process.env.OPENCODE_DISABLE_PROJECT_CONFIG}};if(argv[0]==='api'){if(process.env.CAPTURE)fs.appendFileSync(process.env.CAPTURE,JSON.stringify({...record,kind:'api'})+'\\n');process.stdout.write(JSON.stringify({data:{id:'ses_'+path.basename(process.cwd()),agent:'naru'}})+'\\n')}else if(process.env.CAPTURE)fs.appendFileSync(process.env.CAPTURE,JSON.stringify({...record,kind:'host'})+'\\n');\n`, { mode: 0o755 });
    await chmod(executable, 0o755);
    await writeFile(join(root, 'host.json'), JSON.stringify({ root, executable, executableHash: createHash('sha256').update(await readFile(executable)).digest('hex'), node: process.execPath, cli: join(root, 'lib', 'tools', 'naru-preview.mjs') }), { mode: 0o600 });
    return { root, executable };
}

async function crashPublishedUpdate(root: string): Promise<void> {
    const moduleUrl = new URL('../tools/naru-lib/oc2-native-config.mjs', import.meta.url).href;
    const source = `const { updateOc2NativeProfile } = await import(${JSON.stringify(moduleUrl)}); await updateOc2NativeProfile(${JSON.stringify(root)}, ['fixture/crashed'], { afterTransactionPublished: async () => process.exit(72) });`;
    const child = spawn(process.execPath, ['--input-type=module', '--eval', source], { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = ''; child.stderr.setEncoding('utf8'); child.stderr.on('data', chunk => { stderr += chunk; });
    const code = await new Promise<number | null>((resolvePromise, reject) => { child.once('error', reject); child.once('exit', resolvePromise); });
    assert.equal(code, 72, stderr);
}

test('native launch preserves cwd, HOME, PATH, and arguments while routing only OC2 XDG state', async () => {
    const { root } = await fixture(), workspace = join(root, 'workspace'), capture = join(root, 'capture.json'); await mkdir(workspace);
    try {
        const source = { HOME: '/normal/home', PATH: '/normal/path', CAPTURE: capture, OPENCODE_CONFIG: '/stable/config.json', OPENCODE_CONFIG_DIR: '/stable/config', OPENCODE_CONFIG_CONTENT: JSON.stringify({ theme: 'stable' }), OPENCODE_DISABLE_PROJECT_CONFIG: 'true' };
        const plan = await planOc2NativeLaunch(['naru', 'run', 'two words', "quote'and;$HOME"], { root }, workspace, source);
        const paths = oc2NativePaths(root);
        assert.equal(plan.cwd, workspace); assert.equal(plan.env.HOME, source.HOME); assert.equal(plan.env.PATH, source.PATH);
        assert.equal(plan.env.XDG_CONFIG_HOME, paths.configRoot); assert.equal(plan.env.XDG_DATA_HOME, paths.dataRoot); assert.equal(plan.env.XDG_CACHE_HOME, paths.cacheRoot); assert.equal(plan.env.XDG_STATE_HOME, paths.stateRoot); assert.equal(plan.env.OPENCODE_DB, paths.database);
        for (const key of ['OPENCODE_CONFIG', 'OPENCODE_CONFIG_DIR', 'OPENCODE_CONFIG_CONTENT', 'OPENCODE_DISABLE_PROJECT_CONFIG']) assert.equal(plan.env[key], undefined);
        assert.deepEqual(plan.argv, ['run', '--agent', 'naru', 'two words', "quote'and;$HOME"]);

        const tui = await planOc2NativeLaunch(['naru'], { root }, workspace, source);
        assert.equal(tui.selectNaruSession, true); assert.equal(tui.env.OPENCODE_CONFIG_CONTENT, undefined);
        const plain = await planOc2NativeLaunch([], { root }, workspace, source);
        assert.equal(plain.env.OPENCODE_CONFIG_CONTENT, undefined); assert.deepEqual(plain.argv, []);
        await assert.rejects(lstat(join(root, 'profile')), { code: 'ENOENT' });
    } finally { await rm(root, { recursive: true, force: true }); }
});

test('naru creates an agent-selected native session after a bare host and keeps concurrent directory cwd', async () => {
    const { root } = await fixture(), capture = join(root, 'capture.json'), one = join(root, 'one'), two = join(root, 'two');
    await mkdir(one); await mkdir(two);
    const previous = process.env.CAPTURE; process.env.CAPTURE = capture;
    try {
        await runOc2Native(['naru', 'models', '--set', 'fixture/model#high'], { root });
        assert.equal(await runOc2Native([], { root }), 0);
        await Promise.all([runOc2Native(['naru', one], { root }), runOc2Native(['naru', two], { root })]);
        const records = (await readFile(capture, 'utf8')).trim().split('\n').map(line => JSON.parse(line) as { kind: string; cwd: string; argv: string[] });
        assert.ok(records.some(record => record.kind === 'host' && record.argv.length === 0), 'bare native host did not start first');
        for (const directory of [one, two]) {
            const api = records.find(record => record.kind === 'api' && record.cwd === directory && record.argv.includes('/api/session'));
            assert.ok(api); assert.deepEqual(JSON.parse(api.argv[api.argv.indexOf('--data') + 1]!), { agent: 'naru', location: { directory } });
            assert.ok(records.some(record => record.kind === 'host' && record.cwd === directory && record.argv.join(' ') === `--session ses_${directory.split('/').at(-1)}`));
        }
    } finally {
        if (previous === undefined) delete process.env.CAPTURE; else process.env.CAPTURE = previous;
        await rm(root, { recursive: true, force: true });
    }
});

test('initialized ordinary launches do not rewrite or lock profile files', async () => {
    const { root } = await fixture(), paths = oc2NativePaths(root), capture = join(root, 'capture.json');
    const previous = process.env.CAPTURE; process.env.CAPTURE = capture;
    try {
        await runOc2Native(['naru', 'models', '--set', 'fixture/model'], { root });
        const before = await Promise.all([paths.configFile, paths.ownership, paths.profileState].map(path => lstat(path, { bigint: true })));
        await writeFile(paths.lock, 'synthetic other editor\n', { mode: 0o600 });
        await Promise.all([runOc2Native(['auth', '--help'], { root }), runOc2Native(['debug', '--help'], { root }), runOc2Native([], { root })]);
        const after = await Promise.all([paths.configFile, paths.ownership, paths.profileState].map(path => lstat(path, { bigint: true })));
        for (let index = 0; index < before.length; index++) { assert.equal(after[index]!.ino, before[index]!.ino); assert.equal(after[index]!.mtimeNs, before[index]!.mtimeNs); }
    } finally {
        if (previous === undefined) delete process.env.CAPTURE; else process.env.CAPTURE = previous;
        await rm(root, { recursive: true, force: true });
    }
});

test('concurrent first bare launches share one bounded profile initialization', async () => {
    const { root } = await fixture(), capture = join(root, 'capture.json');
    const previous = process.env.CAPTURE; process.env.CAPTURE = capture;
    try {
        assert.deepEqual(await Promise.all([runOc2Native([], { root }), runOc2Native([], { root })]), [0, 0]);
        const profile = JSON.parse(await readFile(oc2NativePaths(root).profileState, 'utf8'));
        assert.deepEqual(profile.models, []);
    } finally {
        if (previous === undefined) delete process.env.CAPTURE; else process.env.CAPTURE = previous;
        await rm(root, { recursive: true, force: true });
    }
});

test('read-only help/version do not create native profile, while explicit models setup is broker-free and workspace-free', async () => {
    const { root } = await fixture(), paths = oc2NativePaths(root);
    try {
        await planOc2NativeLaunch(['--version'], { root }, root, { HOME: '/normal', PATH: '/bin' });
        await assert.rejects(lstat(join(root, 'profile')), { code: 'ENOENT' });
        assert.equal(await runOc2Native(['naru', 'models', '--set', 'fixture/a#high,fixture/b'], { root }), 0);
        const profile = JSON.parse(await readFile(paths.profileState, 'utf8'));
        assert.deepEqual(profile.models, ['fixture/a#high', 'fixture/b']);
        await assert.rejects(lstat(join(root, 'broker.sock')), { code: 'ENOENT' });
        await assert.rejects(lstat(join(root, 'worktrees')), { code: 'ENOENT' });
    } finally { await rm(root, { recursive: true, force: true }); }
});

test('legacy recovery is explicit and normal native plans never use it', async () => {
    const { root } = await fixture();
    try {
        const legacy = await planOc2NativeLaunch(['naru', 'legacy', 'status'], { root, legacy: '/legacy/naru-preview' }, '/caller', { HOME: '/home' });
        assert.equal(legacy.legacy, true); assert.equal(legacy.executable, '/legacy/naru-preview'); assert.deepEqual(legacy.argv, ['status']);
        const normal = await planOc2NativeLaunch(['auth', 'login'], { root, legacy: '/legacy/naru-preview' }, '/caller', { HOME: '/home', PATH: '/bin' });
        assert.equal(normal.executable.includes('fake-opencode'), true); assert.equal(normal.legacy, undefined); assert.deepEqual(normal.argv, ['auth', 'login']);
    } finally { await rm(root, { recursive: true, force: true }); }
});

test('all explicit Naru execution requires workers and run cannot override the Naru agent', async () => {
    const { root } = await fixture(), paths = oc2NativePaths(root);
    try {
        await assert.rejects(runOc2Native(['naru', 'run', 'do work'], { root }), /Naru has no global native models.*models --set.*Bare oc2 remains available/s);
        assert.deepEqual(JSON.parse(await readFile(paths.profileState, 'utf8')).models, []);
        for (const args of [['naru', 'run', '--agent', 'other', 'work'], ['naru', 'run', '-a', 'other'], ['naru', 'run', '--agent=other', 'work']]) {
            await assert.rejects(planOc2NativeLaunch(args, { root }), /always uses agent "naru"/);
        }
        assert.equal(await runOc2Native([], { root }), 0);
    } finally { await rm(root, { recursive: true, force: true }); }
});

test('native service stop routes without profile initialization or legacy broker use', async () => {
    const { root } = await fixture(), capture = join(root, 'service-stop.json');
    const previous = process.env.CAPTURE; process.env.CAPTURE = capture;
    try {
        assert.equal(await runOc2Native(['service', 'stop'], { root, legacy: '/legacy/naru-preview' }), 0);
        const record = JSON.parse((await readFile(capture, 'utf8')).trim()) as { argv: string[]; kind: string };
        assert.deepEqual(record.argv, ['service', 'stop']); assert.equal(record.kind, 'host');
        await assert.rejects(lstat(join(root, 'profile')), { code: 'ENOENT' });
    } finally {
        if (previous === undefined) delete process.env.CAPTURE; else process.env.CAPTURE = previous;
        await rm(root, { recursive: true, force: true });
    }
});

test('bare oc2 reclaims a dead update lock and recovers its published transaction', async () => {
    const { root } = await fixture(), paths = oc2NativePaths(root);
    try {
        await runOc2Native(['naru', 'models', '--set', 'fixture/model'], { root });
        await crashPublishedUpdate(root);
        await lstat(paths.lock); await lstat(paths.transaction);
        assert.equal(await runOc2Native([], { root }), 0);
        assert.deepEqual((await loadOc2NativeModelProfile(root))?.models, ['fixture/model']);
        await assert.rejects(lstat(paths.lock), { code: 'ENOENT' }); await assert.rejects(lstat(paths.transaction), { code: 'ENOENT' });
    } finally { await rm(root, { recursive: true, force: true }); }
});
