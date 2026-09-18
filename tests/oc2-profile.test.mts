import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { parseOc2InstallerArguments } from '../tools/install-oc2.mjs';
import { cleanupLegacyStandaloneNaruAgent, LEGACY_STANDALONE_NARU_AGENT } from '../tools/naru-lib/oc2-profile.mjs';

const built = join(dirname(fileURLToPath(import.meta.url)), '..');
async function fixture() { const root = await mkdtemp(join(tmpdir(), 'naru-oc2-profile-')); return { root, config: join(root, 'config', 'opencode', 'opencode.json') }; }

test('legacy cleanup removes only the exact managed agents.naru and preserves unrelated configuration', async () => {
    const { root, config } = await fixture();
    try {
        await mkdir(dirname(config), { recursive: true, mode: 0o700 });
        await writeFile(config, JSON.stringify({ update: 'disable', agents: { naru: LEGACY_STANDALONE_NARU_AGENT, review: { mode: 'primary' } }, provider: { fixture: true } }), { mode: 0o600 });
        assert.deepEqual(await cleanupLegacyStandaloneNaruAgent(config), { changed: true });
        assert.deepEqual(JSON.parse(await readFile(config, 'utf8')), { update: 'disable', agents: { review: { mode: 'primary' } }, provider: { fixture: true } });
        assert.deepEqual(await cleanupLegacyStandaloneNaruAgent(config), { changed: false });
    } finally { await rm(root, { recursive: true, force: true }); }
});

test('legacy cleanup preserves custom entries, missing files, malformed bytes, and symlink targets', async () => {
    const missing = await fixture();
    try { assert.deepEqual(await cleanupLegacyStandaloneNaruAgent(missing.config), { changed: false }); }
    finally { await rm(missing.root, { recursive: true, force: true }); }
    for (const source of [JSON.stringify({ agents: { naru: { mode: 'primary', system: 'user-owned' } } }), JSON.stringify({ agents: { other: {} } })]) {
        const { root, config } = await fixture();
        try { await mkdir(dirname(config), { recursive: true, mode: 0o700 }); await writeFile(config, source, { mode: 0o600 }); assert.deepEqual(await cleanupLegacyStandaloneNaruAgent(config), { changed: false }); assert.equal(await readFile(config, 'utf8'), source); }
        finally { await rm(root, { recursive: true, force: true }); }
    }
    const malformed = await fixture();
    try { await mkdir(dirname(malformed.config), { recursive: true, mode: 0o700 }); await writeFile(malformed.config, '{', { mode: 0o600 }); await assert.rejects(cleanupLegacyStandaloneNaruAgent(malformed.config), /malformed JSON/); assert.equal(await readFile(malformed.config, 'utf8'), '{'); }
    finally { await rm(malformed.root, { recursive: true, force: true }); }
    const linked = await fixture();
    try { await mkdir(dirname(linked.config), { recursive: true, mode: 0o700 }); const target = join(linked.root, 'target'); await writeFile(target, '{}', { mode: 0o600 }); await symlink(target, linked.config); await assert.rejects(cleanupLegacyStandaloneNaruAgent(linked.config), /regular file, not a symlink/); assert.equal(await readFile(target, 'utf8'), '{}'); }
    finally { await rm(linked.root, { recursive: true, force: true }); }
});

test('legacy cleanup is lock/CAS safe and removes atomic staging after failures', async () => {
    const { root, config } = await fixture();
    try {
        await mkdir(dirname(config), { recursive: true, mode: 0o700 });
        const original = JSON.stringify({ agents: { naru: LEGACY_STANDALONE_NARU_AGENT }, keep: 'original' }); await writeFile(config, original, { mode: 0o600 });
        const concurrent = JSON.stringify({ agents: { naru: LEGACY_STANDALONE_NARU_AGENT }, keep: 'concurrent' });
        await assert.rejects(cleanupLegacyStandaloneNaruAgent(config, { beforeCommit: () => writeFile(config, concurrent, { mode: 0o600 }) }), /changed during cleanup/);
        assert.equal(await readFile(config, 'utf8'), concurrent); assert.deepEqual((await readdir(dirname(config))).sort(), ['opencode.json']);
        await assert.rejects(cleanupLegacyStandaloneNaruAgent(config, { rename: async () => { throw new Error('synthetic rename failure'); } }), /synthetic rename failure/);
        assert.equal(await readFile(config, 'utf8'), concurrent); assert.deepEqual((await readdir(dirname(config))).sort(), ['opencode.json']);
    } finally { await rm(root, { recursive: true, force: true }); }
});

test('installer retires static install, exposes explicit cleanup, and fresh install needs no profile config', async () => {
    assert.deepEqual(parseOc2InstallerArguments(['--install-agent']), { action: 'install-agent' });
    assert.deepEqual(parseOc2InstallerArguments(['--cleanup-agent', '--profile-config', '/tmp/profile.json']), { action: 'cleanup-agent', profileConfig: '/tmp/profile.json' });
    assert.deepEqual(parseOc2InstallerArguments(['--setup-native', '--root', '/tmp/profile']), { action: 'setup-native', root: '/tmp/profile' });
    assert.deepEqual(parseOc2InstallerArguments(['--preview-cli', '/a', '--opencode', '/b', '--v2-wrapper', '/c', '--root', '/d', '--bin', '/e']), { action: 'install', previewCli: '/a', opencode: '/b', v2Wrapper: '/c', root: '/d', bin: '/e' });
    assert.throws(() => parseOc2InstallerArguments(['--install-agent', '--cleanup-agent']), /mutually exclusive/);
    const child = spawn(process.execPath, [join(built, 'tools', 'install-oc2.mjs'), '--install-agent'], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = ''; child.stderr.setEncoding('utf8'); child.stderr.on('data', chunk => { stderr += chunk; });
    assert.equal(await new Promise<number | null>((resolvePromise, reject) => { child.once('error', reject); child.once('exit', resolvePromise); }), 1);
    assert.match(stderr, /retired.*native agents.*--setup-native.*--cleanup-agent/s);
});
