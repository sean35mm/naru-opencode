import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { loadOc2NativeModelProfile, updateOc2NativeProfile } from '../tools/naru-lib/oc2-native-config.mjs';
import { LEGACY_STANDALONE_NARU_AGENT, oc2NativePaths } from '../tools/naru-lib/oc2-profile.mjs';

async function fixture() {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'naru-oc2-native-config-')));
    const home = join(root, 'home'), instructions = join(home, 'instructions.md'); await mkdir(home, { mode: 0o700 }); await writeFile(instructions, 'Explicit native preferences.\n', { mode: 0o600 });
    await writeFile(join(root, 'state.json'), JSON.stringify({ schemaVersion: 6, globalWorkerPool: { models: ['fixture/team/model#high'], revision: 9 }, globalInstructions: { revision: 4, source: { sourcePath: instructions, canonicalPath: instructions } }, repositories: [{ path: '/history' }], tasks: [{ id: 'historical' }] }), { mode: 0o600 });
    await mkdir(join(root, 'worktrees', 'old'), { recursive: true }); await writeFile(join(root, 'worktrees', 'old', 'keep'), 'history');
    await mkdir(join(root, 'host-data'), { recursive: true, mode: 0o700 }); await writeFile(join(root, 'host-data', 'opencode.db'), Buffer.from([0, 1, 255]));
    return { root, home, instructions };
}

async function crashUpdate(root: string, home: string, hook: 'afterLockStaged' | 'afterLockAcquired' | 'afterTransactionPublished' | 'afterTransactionStageFile'): Promise<void> {
    const moduleUrl = new URL('../tools/naru-lib/oc2-native-config.mjs', import.meta.url).href;
    const callback = hook === 'afterTransactionStageFile' ? 'async index => { if (index === 2) process.exit(71); }' : 'async () => process.exit(71)';
    const source = `const { updateOc2NativeProfile } = await import(${JSON.stringify(moduleUrl)}); await updateOc2NativeProfile(${JSON.stringify(root)}, ['fixture/crashed'], { home: ${JSON.stringify(home)}, ${hook}: ${callback} });`;
    const child = spawn(process.execPath, ['--input-type=module', '--eval', source], { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = ''; child.stderr.setEncoding('utf8'); child.stderr.on('data', chunk => { stderr += chunk; });
    const code = await new Promise<number | null>((resolvePromise, reject) => { child.once('error', reject); child.once('exit', resolvePromise); });
    assert.equal(code, 71, stderr);
}

test('native profile imports only validated global models and preserves config, history, MCP, and database bytes', async () => {
    const { root, home, instructions } = await fixture(), paths = oc2NativePaths(root);
    try {
        await mkdir(paths.configDirectory, { recursive: true, mode: 0o700 });
        const original = { instructions: ['USER INSTRUCTIONS'], plugins: ['/user/plugin'], skills: ['/user/skills'], agents: { custom: { mode: 'primary', system: 'custom' }, naru: LEGACY_STANDALONE_NARU_AGENT }, providers: { fixture: { settings: { baseURL: 'https://example.invalid' } } }, mcp: { servers: { future: { type: 'remote', url: 'https://example.invalid/mcp' } } } };
        await writeFile(paths.configFile, JSON.stringify(original), { mode: 0o600 });
        const stateBefore = await readFile(join(root, 'state.json')), databaseBefore = await readFile(paths.database);
        const profile = await updateOc2NativeProfile(root, undefined, { home });
        assert.deepEqual(profile, { schemaVersion: 2, models: ['fixture/team/model#high'], preferences: {}, instructions: { sourcePath: instructions, canonicalPath: instructions, sha256: createHash('sha256').update('Explicit native preferences.\n').digest('hex'), byteLength: 29 } });
        assert.deepEqual(await loadOc2NativeModelProfile(root), profile);
        const config = JSON.parse(await readFile(paths.configFile, 'utf8'));
        assert.deepEqual(config.instructions, original.instructions); assert.deepEqual(config.providers, original.providers); assert.deepEqual(config.mcp, original.mcp);
        assert.deepEqual(config.plugins, ['/user/plugin', join(root, 'lib', 'tools', 'oc2-native-plugin')]);
        assert.deepEqual(config.skills, ['/user/skills', join(root, 'lib', 'tools', 'oc2-native-plugin', 'skills')]);
        assert.deepEqual(config.agents.custom, original.agents.custom); assert.notDeepEqual(config.agents.naru, LEGACY_STANDALONE_NARU_AGENT);
        assert.equal(Object.keys(config.agents).filter(name => name.startsWith('naru-reader-')).length, 1);
        assert.equal(Object.keys(config.agents).filter(name => name.startsWith('naru-runner-')).length, 1);
        assert.equal(Object.keys(config.agents).filter(name => name.startsWith('naru-writer-')).length, 1);
        for (const agent of Object.values(config.agents) as Array<{ system?: string }>) if (agent.system?.includes('native Naru') || agent.system?.includes('primary native OC2')) assert.match(agent.system, /Explicit native preferences/);
        assert.deepEqual(await readFile(join(root, 'state.json')), stateBefore); assert.deepEqual(await readFile(paths.database), databaseBefore);
        assert.equal(await readFile(join(root, 'worktrees', 'old', 'keep'), 'utf8'), 'history');

        config.mcp.servers.novel = { type: 'local', command: ['/future/tool'] };
        await writeFile(paths.configFile, JSON.stringify(config), { mode: 0o600 });
        await updateOc2NativeProfile(root, ['fixture/second'], { home });
        const refreshed = JSON.parse(await readFile(paths.configFile, 'utf8'));
        assert.deepEqual(refreshed.mcp.servers.novel, { type: 'local', command: ['/future/tool'] });
        assert.equal(Object.keys(refreshed.agents).some(name => name.includes('team-model-high')), false);
    } finally { await rm(root, { recursive: true, force: true }); }
});

test('native profile refuses malformed config, invalid asset paths, and unrelated managed-name collisions', async () => {
    for (const content of ['{', JSON.stringify({ plugins: '/user/plugin' }), JSON.stringify({ agents: { naru: { mode: 'primary', system: 'user-owned' } } })]) {
        const { root, home } = await fixture(), paths = oc2NativePaths(root);
        try {
            await mkdir(paths.configDirectory, { recursive: true, mode: 0o700 }); await writeFile(paths.configFile, content, { mode: 0o600 });
            await assert.rejects(updateOc2NativeProfile(root, undefined, { home }), /malformed JSON|array of paths|collides with an unrelated/);
            assert.equal(await readFile(paths.configFile, 'utf8'), content);
        } finally { await rm(root, { recursive: true, force: true }); }
    }
});

test('native config update is a byte-for-byte no-op and rolls back second-file failures', async () => {
    const { root, home } = await fixture(), paths = oc2NativePaths(root);
    try {
        await updateOc2NativeProfile(root, undefined, { home });
        const original = await readFile(paths.configFile, 'utf8'), before = await lstat(paths.configFile, { bigint: true });
        await updateOc2NativeProfile(root, undefined, { home });
        const after = await lstat(paths.configFile, { bigint: true }); assert.equal(after.ino, before.ino); assert.equal(after.mtimeNs, before.mtimeNs);
        const concurrent = JSON.stringify({ ...(JSON.parse(original) as object), concurrent: true }) + '\n';
        await assert.rejects(updateOc2NativeProfile(root, ['fixture/new'], { home, beforeConfigCommit: () => writeFile(paths.configFile, concurrent, { mode: 0o600 }) }), /changed concurrently/);
        assert.equal(await readFile(paths.configFile, 'utf8'), concurrent);
        assert.deepEqual((await readdir(dirname(paths.lock))).filter(name => name.includes('.lock') || name.includes('.oc2-') || name.includes('transaction')), []);

        const snapshots = await Promise.all([paths.configFile, paths.ownership, paths.profileState].map(path => readFile(path)));
        await assert.rejects(updateOc2NativeProfile(root, ['fixture/new'], { home, afterCommitFile: async index => { if (index === 2) throw new Error('synthetic second-file failure'); } }), /synthetic second-file failure/);
        for (const [index, path] of [paths.configFile, paths.ownership, paths.profileState].entries()) assert.deepEqual(await readFile(path), snapshots[index]);
        assert.equal(await readFile(paths.configFile, 'utf8'), concurrent);
        assert.deepEqual((await readdir(dirname(paths.lock))).filter(name => name.includes('.lock') || name.includes('.oc2-') || name.includes('transaction')), []);
    } finally { await rm(root, { recursive: true, force: true }); }
});

test('third-file completion is finalized and rollback never overwrites a newer external edit', async () => {
    const first = await fixture(), firstPaths = oc2NativePaths(first.root);
    try {
        await updateOc2NativeProfile(first.root, undefined, { home: first.home });
        await updateOc2NativeProfile(first.root, ['fixture/committed'], { home: first.home, afterCommitFile: async index => { if (index === 3) throw new Error('after complete'); } });
        assert.deepEqual((await loadOc2NativeModelProfile(first.root))?.models, ['fixture/committed']);
        await assert.rejects(lstat(firstPaths.transaction), { code: 'ENOENT' });
    } finally { await rm(first.root, { recursive: true, force: true }); }

    const second = await fixture(), paths = oc2NativePaths(second.root);
    try {
        await updateOc2NativeProfile(second.root, undefined, { home: second.home });
        const external = JSON.stringify({ externallyEdited: true }) + '\n';
        await assert.rejects(updateOc2NativeProfile(second.root, ['fixture/new'], { home: second.home, afterCommitFile: async index => { if (index === 2) { await writeFile(paths.configFile, external, { mode: 0o600 }); throw new Error('concurrent rollback edit'); } } }), /preserved a newer edit/);
        assert.equal(await readFile(paths.configFile, 'utf8'), external);
        await assert.rejects(loadOc2NativeModelProfile(second.root), /interrupted transaction/);
    } finally { await rm(second.root, { recursive: true, force: true }); }
});

test('native profile refuses symlinked root and profile ancestors before writing', async () => {
    const container = await mkdtemp(join(tmpdir(), 'naru-oc2-native-symlink-')), real = join(container, 'real'), linked = join(container, 'linked');
    try {
        await mkdir(real, { mode: 0o700 }); await symlink(real, linked);
        await assert.rejects(updateOc2NativeProfile(linked, ['fixture/model'], { home: container }), /not a symlink/);
        const profile = join(real, 'profile'), outside = join(container, 'outside'); await mkdir(profile, { mode: 0o700 }); await mkdir(outside, { mode: 0o700 }); await symlink(outside, join(profile, 'config'));
        await assert.rejects(updateOc2NativeProfile(real, ['fixture/model'], { home: container }), /not a symlink/);
        assert.deepEqual(await readdir(outside), []);
    } finally { await rm(container, { recursive: true, force: true }); }
});

test('verified lock ownership blocks active or malformed locks and reclaims dead crash owners', async () => {
    const { root, home } = await fixture(), paths = oc2NativePaths(root);
    try {
        await updateOc2NativeProfile(root, undefined, { home });
        await updateOc2NativeProfile(root, undefined, { home, afterLockAcquired: async () => {
            const before = await lstat(paths.lock, { bigint: true });
            await assert.rejects(updateOc2NativeProfile(root, ['fixture/blocked'], { home }), /active \(PID [0-9]+, matching process identity\)/);
            const after = await lstat(paths.lock, { bigint: true }); assert.equal(after.dev, before.dev); assert.equal(after.ino, before.ino);
        } });

        await writeFile(paths.lock, 'historical-unverifiable-lock\n', { mode: 0o600 });
        await assert.rejects(updateOc2NativeProfile(root, ['fixture/blocked'], { home }), /lock.*malformed|lock.*malformed JSON/i);
        assert.equal(await readFile(paths.lock, 'utf8'), 'historical-unverifiable-lock\n');
        await rm(paths.lock);

        await crashUpdate(root, home, 'afterLockAcquired');
        await lstat(paths.lock);
        const recovered = await updateOc2NativeProfile(root, ['fixture/recovered-lock'], { home });
        assert.deepEqual(recovered.models, ['fixture/recovered-lock']);
        await assert.rejects(lstat(paths.lock), { code: 'ENOENT' });
    } finally { await rm(root, { recursive: true, force: true }); }
});

test('lock owner bytes are synced before no-replace publication and dead staging is cleaned', async () => {
    const { root, home } = await fixture(), paths = oc2NativePaths(root), profileDirectory = dirname(paths.lock);
    try {
        await crashUpdate(root, home, 'afterLockStaged');
        await assert.rejects(lstat(paths.lock), { code: 'ENOENT' });
        assert.equal((await readdir(profileDirectory)).filter(name => name.startsWith('.native-profile.lock.staging-')).length, 1);
        const profile = await updateOc2NativeProfile(root, ['fixture/after-lock-stage-crash'], { home });
        assert.deepEqual(profile.models, ['fixture/after-lock-stage-crash']);
        await assert.rejects(lstat(paths.lock), { code: 'ENOENT' });
        assert.equal((await readdir(profileDirectory)).some(name => name.startsWith('.native-profile.lock.staging-')), false);
    } finally { await rm(root, { recursive: true, force: true }); }
});

test('crash-safe transaction publication cleans private staging and recovers a published generation', async () => {
    const { root, home } = await fixture(), paths = oc2NativePaths(root), profileDirectory = dirname(paths.transaction);
    try {
        await updateOc2NativeProfile(root, undefined, { home });

        await crashUpdate(root, home, 'afterTransactionStageFile');
        assert.ok((await readdir(profileDirectory)).some(name => name.startsWith('.native-profile-transaction.staging-')));
        await updateOc2NativeProfile(root, ['fixture/after-staging-crash'], { home });
        assert.equal((await readdir(profileDirectory)).some(name => name.startsWith('.native-profile-transaction.staging-')), false);

        await crashUpdate(root, home, 'afterTransactionPublished');
        await lstat(paths.transaction); await lstat(paths.lock);
        const recovered = await updateOc2NativeProfile(root, ['fixture/after-published-crash'], { home });
        assert.deepEqual(recovered.models, ['fixture/after-published-crash']);
        await assert.rejects(lstat(paths.transaction), { code: 'ENOENT' });
        await assert.rejects(lstat(paths.lock), { code: 'ENOENT' });
    } finally { await rm(root, { recursive: true, force: true }); }
});

test('historical pre-manifest transaction recovery removes only recognized private files', async () => {
    const first = await fixture(), firstPaths = oc2NativePaths(first.root);
    try {
        await updateOc2NativeProfile(first.root, undefined, { home: first.home });
        await mkdir(firstPaths.transaction, { mode: 0o700 });
        await writeFile(join(firstPaths.transaction, 'config.new'), '{}\n', { mode: 0o600 });
        await updateOc2NativeProfile(first.root, ['fixture/recovered-incomplete'], { home: first.home });
        await assert.rejects(lstat(firstPaths.transaction), { code: 'ENOENT' });
    } finally { await rm(first.root, { recursive: true, force: true }); }

    const second = await fixture(), secondPaths = oc2NativePaths(second.root);
    try {
        await updateOc2NativeProfile(second.root, undefined, { home: second.home });
        await mkdir(secondPaths.transaction, { mode: 0o700 });
        await writeFile(join(secondPaths.transaction, 'unrelated'), 'keep\n', { mode: 0o600 });
        await assert.rejects(updateOc2NativeProfile(second.root, ['fixture/refused'], { home: second.home }), /unexpected data/);
        assert.equal(await readFile(join(secondPaths.transaction, 'unrelated'), 'utf8'), 'keep\n');
    } finally { await rm(second.root, { recursive: true, force: true }); }
});
