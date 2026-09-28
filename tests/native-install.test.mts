import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile, chmod, stat, lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { getNativeInstallPaths, installNative, nativeModels } from '../tools/naru-lib/native-install.mjs';

const source = resolve(fileURLToPath(new URL('..', import.meta.url)));
const run = promisify(execFile);

test('normal native preview, registration, reinstallation, and model changes preserve user settings', async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'naru-native-install-'));
    const bin = join(tmp, 'bin'), root = join(tmp, 'config'), paths = getNativeInstallPaths(root);
    const originalPath = process.env.PATH;
    try {
        await mkdir(bin); await mkdir(root);
        await writeFile(join(bin, 'opencode'), '#!/bin/sh\nprintf "opencode v2.0.15\\n"\n'); await chmod(join(bin, 'opencode'), 0o700);
        process.env.PATH = `${bin}:${originalPath}`;
        const original = { theme: 'user-theme', provider: { fixture: { key: 'public-placeholder' } }, agent: { custom: { mode: 'subagent' } } };
        await writeFile(paths.configPath, JSON.stringify(original), { mode: 0o644 });
        const before = await readFile(paths.configPath);
        assert.match(await installNative(root, source, false), /Preview only/);
        assert.deepEqual(await readFile(paths.configPath), before);
        await assert.rejects(readFile(paths.manifestPath), /ENOENT/);
        assert.match(await installNative(root, source, true), /Installed native/);
        const config = JSON.parse(await readFile(paths.configPath, 'utf8'));
        assert.equal(config.theme, original.theme); assert.deepEqual(config.provider, original.provider); assert.deepEqual(config.agent, original.agent);
        assert.equal(config.agents.naru.mode, 'primary'); assert.equal(config.agents.naru.model, undefined);
        assert.equal(config.plugins.includes(join(paths.packageRoot, 'tools', 'oc2-native-plugin')), true);
        assert.equal((await stat(paths.configPath)).mode & 0o777, 0o644);
        assert.equal((await readFile(paths.configPath)).length > 0, true);
        await nativeModels(root, ['fixture/model#fast']);
        assert.deepEqual(await nativeModels(root), ['fixture/model#fast']);
        assert.equal(Object.keys(JSON.parse(await readFile(paths.configPath, 'utf8')).agents).filter(key => key.startsWith('naru-worker-')).length, 1);
        await installNative(root, source, true);
        assert.deepEqual(await nativeModels(root), ['fixture/model#fast']);
        await writeFile(join(paths.packageRoot, 'tools', 'package.json'), 'modified');
        const configBefore = await readFile(paths.configPath), profileBefore = await readFile(paths.profilePath);
        await assert.rejects(nativeModels(root, ['fixture/other']), /modified/);
        assert.deepEqual(await readFile(paths.configPath), configBefore);
        assert.deepEqual(await readFile(paths.profilePath), profileBefore);
        await assert.rejects(installNative(root, source, true), /modified/);
    } finally { process.env.PATH = originalPath; await rm(tmp, { recursive: true, force: true }); }
});

test('normal CLI honors explicit --dir and previews before apply', async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'naru-native-cli-'));
    const bin = join(tmp, 'bin'), root = join(tmp, 'custom-config');
    try {
        await mkdir(bin);
        const host = join(bin, 'opencode'); await writeFile(host, '#!/bin/sh\nprintf "2.0.15\\n"\n'); await chmod(host, 0o700);
        const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, HOME: tmp };
        const command = join(source, 'bin', 'naru');
        const preview = await run(command, ['install', '--dir', root], { env });
        assert.match(preview.stdout, /Preview only/);
        await assert.rejects(readFile(getNativeInstallPaths(root).manifestPath), /ENOENT/);
        const applied = await run(command, ['install', '--dir', root, '--apply'], { env });
        assert.match(applied.stdout, /Installed native Naru/);
        assert.equal(JSON.parse(await readFile(getNativeInstallPaths(root).configPath, 'utf8')).agents.naru.mode, 'primary');
    } finally { await rm(tmp, { recursive: true, force: true }); }
});

test('explicit --opencode selects v2 while PATH remains v1, with a read-only CLI preview', async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'naru-native-selector-'));
    const bin = join(tmp, 'bin'), root = join(tmp, 'xdg', 'opencode');
    try {
        await mkdir(bin);
        const v1 = join(bin, 'opencode'), v2 = join(bin, 'opencode2');
        await writeFile(v1, '#!/bin/sh\nprintf "1.18.32\\n"\n'); await chmod(v1, 0o700);
        await writeFile(v2, '#!/bin/sh\nprintf "opencode v2.0.15\\n"\n'); await chmod(v2, 0o700);
        const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, HOME: tmp, XDG_CONFIG_HOME: join(tmp, 'xdg') };
        const cli = join(source, 'bin', 'naru');
        await assert.rejects(run(cli, ['install', '--preview'], { env }), /exact OpenCode 2.0.15/);
        const { stdout } = await run(cli, ['install', '--preview', '--opencode', v2], { env });
        assert.match(stdout, /Native install preview/);
        assert.ok(stdout.includes(root));
        assert.doesNotMatch(stdout, /Apply these changes\?/);
        await assert.rejects(lstat(root), { code: 'ENOENT' });
        for (const args of [['--opencode'], ['--opencode', 'relative/path'], ['--opencode', join(tmp, 'missing')], ['--opencode', v1]]) {
            await assert.rejects(run(cli, ['install', '--preview', ...args], { env }), /--opencode|exact OpenCode 2.0.15/);
        }
        await assert.rejects(run(cli, ['install', '--preview', '--apply', '--opencode', v2], { env }), /cannot be combined/);
        await assert.rejects(lstat(root), { code: 'ENOENT' });
    } finally { await rm(tmp, { recursive: true, force: true }); }
});

test('version probe isolates a host that creates an empty config directory', async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'naru-native-version-isolation-'));
    const bin = join(tmp, 'bin'), home = join(tmp, 'home'), root = join(home, '.config', 'opencode'), probeHomeFile = join(tmp, 'probe-home'), probes = join(tmp, 'probes');
    try {
        await mkdir(bin); await mkdir(home); await mkdir(probes);
        const host = join(bin, 'opencode2');
        await writeFile(host, `#!/usr/bin/env node
const { mkdirSync, writeFileSync } = await import('node:fs');
const { join } = await import('node:path');
mkdirSync(join(process.env.HOME, '.config', 'opencode'), { recursive: true });
writeFileSync(${JSON.stringify(probeHomeFile)}, process.env.HOME);
console.log('opencode v2.0.15');
`); await chmod(host, 0o700);
        const env = { ...process.env, HOME: home, XDG_CONFIG_HOME: join(home, '.config'), TMPDIR: probes, TMP: probes, TEMP: probes };
        const { stdout } = await run(join(source, 'bin', 'naru'), ['install', '--preview', '--opencode', host], { env });
        assert.match(stdout, /Preview only; no files changed/);
        const probeHome = await readFile(probeHomeFile, 'utf8');
        assert.notEqual(probeHome, home);
        assert.ok(probeHome.startsWith(probes));
        await assert.rejects(lstat(root), { code: 'ENOENT' });
        await assert.rejects(lstat(probeHome), { code: 'ENOENT' });
        assert.deepEqual(await readdir(probes), []);
    } finally { await rm(tmp, { recursive: true, force: true }); }
});

test('real 2.0.15 previews without fixture writes and saves explicit references offline', { skip: !process.env.NARU_NATIVE_TEST_REAL_OPENCODE }, async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'naru-native-real-preview-'));
    const home = join(tmp, 'home'), probes = join(tmp, 'probes'), root = join(home, '.config', 'opencode');
    try {
        await mkdir(home); await mkdir(probes);
        const env = { ...process.env, HOME: home, XDG_CONFIG_HOME: join(home, '.config'), TMPDIR: probes, TMP: probes, TEMP: probes };
        const { stdout } = await run(join(source, 'bin', 'naru'), ['install', '--preview', '--opencode', process.env.NARU_NATIVE_TEST_REAL_OPENCODE!], { env });
        assert.match(stdout, /Preview only; no files changed/);
        await assert.rejects(lstat(root), { code: 'ENOENT' });
        assert.deepEqual(await readdir(probes), []);
        await run(join(source, 'bin', 'naru'), ['install', '--dir', root, '--apply', '--opencode', process.env.NARU_NATIVE_TEST_REAL_OPENCODE!], { env });
        const refs = 'fixture/previously-working,fixture/other#fast', cli = join(source, 'bin', 'naru');
        const before = await Promise.all([getNativeInstallPaths(root).configPath, getNativeInstallPaths(root).profilePath].map(path => readFile(path)));
        const preview = await run(cli, ['models', '--dir', root, '--set', refs, '--preview', '--opencode', process.env.NARU_NATIVE_TEST_REAL_OPENCODE!], { env });
        assert.match(preview.stdout, /Availability not checked/);
        for (const [index, path] of [getNativeInstallPaths(root).configPath, getNativeInstallPaths(root).profilePath].entries()) assert.deepEqual(await readFile(path), before[index]);
        await run(cli, ['models', '--dir', root, '--set', refs, '--apply', '--opencode', process.env.NARU_NATIVE_TEST_REAL_OPENCODE!], { env });
        assert.deepEqual(await nativeModels(root), refs.split(','));
    } finally { await rm(tmp, { recursive: true, force: true }); }
});

test('normal CLI explicit models --set previews and saves exact references offline', async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'naru-native-model-cli-'));
    const bin = join(tmp, 'bin'), root = join(tmp, 'config'), serveMarker = join(tmp, 'serve-invoked');
    try {
        await mkdir(bin);
        const host = join(bin, 'opencode2');
        await writeFile(join(bin, 'opencode'), '#!/bin/sh\nprintf "1.18.32\\n"\n'); await chmod(join(bin, 'opencode'), 0o700);
        await writeFile(host, `#!/usr/bin/env node
if (process.argv[2] === '--version') { console.log('2.0.15'); process.exit(0); }
const { writeFileSync } = await import('node:fs');
writeFileSync(${JSON.stringify(serveMarker)}, process.argv.slice(2).join(' '));
process.exit(1);
`); await chmod(host, 0o700);
        const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, HOME: tmp };
        const command = join(source, 'bin', 'naru');
        await run(command, ['install', '--dir', root, '--apply', '--opencode', host], { env });
        const before = await run(command, ['models', '--dir', root, '--list'], { env });
        assert.match(before.stdout, /No native workers selected/);
        await assert.rejects(run(command, ['models', '--dir', root, '--set', 'fixture/model#fast', '--preview'], { env }), /exact OpenCode 2.0.15/);
        const paths = getNativeInstallPaths(root), original = await Promise.all([paths.configPath, paths.profilePath].map(path => readFile(path)));
        const refs = 'fixture/model#fast,absent/previously-working';
        const preview = await run(command, ['models', '--dir', root, '--set', refs, '--opencode', host], { env });
        assert.match(preview.stdout, /Preview only.*Availability not checked/s);
        assert.deepEqual(await nativeModels(root), []);
        for (const [index, path] of [paths.configPath, paths.profilePath].entries()) assert.deepEqual(await readFile(path), original[index]);
        const saved = await run(command, ['models', '--dir', root, '--set', refs, '--apply', '--opencode', host], { env });
        assert.match(saved.stdout, /Saved native worker configuration:.*Availability not checked/s);
        const after = await run(command, ['models', '--dir', root, '--list'], { env });
        assert.equal(after.stdout.trim(), refs.replace(',', '\n'));
        assert.deepEqual(JSON.parse(await readFile(paths.profilePath, 'utf8')).models, refs.split(','));
        const stable = await Promise.all([paths.configPath, paths.profilePath].map(path => readFile(path)));
        for (const invalid of ['fixture/one,fixture/one', 'fixture/one,', 'fixture/../unsafe', 'fixture/one, fixture/two', Array.from({ length: 33 }, (_, index) => `fixture/model${index}`).join(',')]) {
            await assert.rejects(run(command, ['models', '--dir', root, '--set', invalid, '--apply', '--opencode', host], { env }), /Duplicate native model reference|exact comma-separated|Invalid enrolled catalogue reference|at most 32/);
            for (const [index, path] of [paths.configPath, paths.profilePath].entries()) assert.deepEqual(await readFile(path), stable[index]);
        }
        await assert.rejects(lstat(serveMarker), { code: 'ENOENT' });
    } finally { await rm(tmp, { recursive: true, force: true }); }
});

test('native preflight rejects v1 collisions, JSONC ambiguity, user agent collisions and unsupported host without writes', async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'naru-native-refusal-'));
    const bin = join(tmp, 'bin'), root = join(tmp, 'config');
    const oldPath = process.env.PATH;
    try {
        await mkdir(bin); await mkdir(root); process.env.PATH = `${bin}:${oldPath}`;
        const host = join(bin, 'opencode'); await writeFile(host, '#!/bin/sh\nprintf "1.18.28\\n"\n'); await chmod(host, 0o700);
        await assert.rejects(installNative(root, source, true), /exact OpenCode 2.0.15/);
        for (const version of ['2.0.16', '2.0.15-beta.1', 'opencode v2.0.15 extra']) {
            await writeFile(host, `#!/bin/sh\nprintf "${version}\\n"\n`);
            await assert.rejects(installNative(root, source, false), /exact OpenCode 2.0.15/);
        }
        await writeFile(host, '#!/bin/sh\nprintf "2.0.15\\n"\n');
        const manualAgent = join(root, 'agents', 'naru.md');
        await mkdir(join(root, 'agents'));
        await writeFile(manualAgent, 'user-owned Naru agent\n');
        for (const apply of [false, true]) {
            await assert.rejects(installNative(root, source, apply), /manual cutover: agents\/naru\.md/);
            assert.equal(await readFile(manualAgent, 'utf8'), 'user-owned Naru agent\n');
            await assert.rejects(lstat(getNativeInstallPaths(root).state), { code: 'ENOENT' });
        }
        await rm(manualAgent);
        await writeFile(join(root, 'opencode.jsonc'), '{ // user comment\n}\n');
        await assert.rejects(installNative(root, source, true), /manual cutover/);
        await rm(join(root, 'opencode.jsonc'));
        await writeFile(join(root, '.naru-install.json'), '{}');
        await assert.rejects(installNative(root, source, true), /v1 install/);
        await rm(join(root, '.naru-install.json'));
        const content = '{"agents":{"naru":{"mode":"primary","system":"user-owned"}}}';
        await writeFile(join(root, 'opencode.json'), content);
        await assert.rejects(installNative(root, source, true), /collides/);
        assert.equal(await readFile(join(root, 'opencode.json'), 'utf8'), content);
    } finally { process.env.PATH = oldPath; await rm(tmp, { recursive: true, force: true }); }
});

test('native preflight refuses filesystem and inline naru commands before writing', async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'naru-native-command-collision-'));
    const bin = join(tmp, 'bin'), oldPath = process.env.PATH;
    try {
        await mkdir(bin);
        const host = join(bin, 'opencode'); await writeFile(host, '#!/bin/sh\nprintf "opencode v2.0.15\\n"\n'); await chmod(host, 0o700);
        process.env.PATH = `${bin}:${oldPath}`;
        for (const name of ['commands/naru', 'commands/naru.md', 'command/naru', 'command/naru.md']) {
            const root = join(tmp, `target-${name.replaceAll('/', '-')}`), path = join(root, name);
            await mkdir(join(path, '..'), { recursive: true });
            if (name === 'commands/naru') await mkdir(path);
            else await writeFile(path, 'custom command');
            await assert.rejects(installNative(root, source, true), /manual cutover/);
            await assert.rejects(readFile(getNativeInstallPaths(root).manifestPath), /ENOENT/);
        }
        for (const key of ['command', 'commands']) {
            const root = join(tmp, `inline-${key}`), config = join(root, 'opencode.json');
            await mkdir(root);
            const original = JSON.stringify({ [key]: { naru: { template: 'my custom command' }, other: { template: 'keep' } } });
            await writeFile(config, original);
            await assert.rejects(installNative(root, source, true), /command configuration is ambiguous/);
            assert.equal(await readFile(config, 'utf8'), original);
            await assert.rejects(readFile(getNativeInstallPaths(root).manifestPath), /ENOENT/);
        }
    } finally { process.env.PATH = oldPath; await rm(tmp, { recursive: true, force: true }); }
});

test('unresolved profile recovery retains the newly published package, manifest, and external config edit', async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'naru-native-recovery-'));
    const bin = join(tmp, 'bin'), root = join(tmp, 'config'), paths = getNativeInstallPaths(root), oldPath = process.env.PATH;
    try {
        await mkdir(bin);
        const host = join(bin, 'opencode'); await writeFile(host, '#!/bin/sh\nprintf "2.0.15\\n"\n'); await chmod(host, 0o700);
        process.env.PATH = `${bin}:${oldPath}`;
        const external = '{"agents":{"naru":{"mode":"primary","system":"newer external edit"}}}\n';
        await assert.rejects(installNative(root, source, true, undefined, { afterCommitFile: async index => {
            if (index !== 1) return;
            await writeFile(paths.configPath, external);
            throw new Error('synthetic concurrent edit');
        } }), /indeterminate.*transaction recovery remains/);
        assert.equal(await readFile(paths.configPath, 'utf8'), external);
        await lstat(join(paths.packageRoot, 'tools', 'oc2-native-plugin', 'index.mjs'));
        assert.equal(JSON.parse(await readFile(paths.manifestPath, 'utf8')).schemaVersion, 1);
        await lstat(join(paths.state, '.native-profile-transaction'));
        await assert.rejects(installNative(root, source, false), /interrupted transaction|collides/);
    } finally { process.env.PATH = oldPath; await rm(tmp, { recursive: true, force: true }); }
});

test('confirmed profile rollback restores the prior package and manifest on reinstall failure', async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'naru-native-rollback-'));
    const bin = join(tmp, 'bin'), root = join(tmp, 'config'), paths = getNativeInstallPaths(root), oldPath = process.env.PATH;
    try {
        await mkdir(bin);
        const host = join(bin, 'opencode'); await writeFile(host, '#!/bin/sh\nprintf "2.0.15\\n"\n'); await chmod(host, 0o700);
        process.env.PATH = `${bin}:${oldPath}`;
        await installNative(root, source, true);
        const previousPackage = await lstat(paths.packageRoot);
        const previous = await Promise.all([paths.configPath, paths.profilePath, paths.manifestPath].map(path => readFile(path)));
        await assert.rejects(installNative(root, source, true, ['fixture/changed'], { afterCommitFile: async index => {
            if (index === 1) throw new Error('synthetic known rollback');
        } }), /synthetic known rollback/);
        assert.equal((await lstat(paths.packageRoot)).ino, previousPackage.ino);
        for (const [index, path] of [paths.configPath, paths.profilePath, paths.manifestPath].entries()) assert.deepEqual(await readFile(path), previous[index]);
        await assert.rejects(lstat(join(paths.state, '.native-profile-transaction')), { code: 'ENOENT' });
    } finally { process.env.PATH = oldPath; await rm(tmp, { recursive: true, force: true }); }
});

test('unresolved upgrade keeps both package generations and the new manifest', async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'naru-native-upgrade-recovery-'));
    const bin = join(tmp, 'bin'), root = join(tmp, 'config'), paths = getNativeInstallPaths(root), oldPath = process.env.PATH;
    try {
        await mkdir(bin);
        const host = join(bin, 'opencode'); await writeFile(host, '#!/bin/sh\nprintf "2.0.15\\n"\n'); await chmod(host, 0o700);
        process.env.PATH = `${bin}:${oldPath}`;
        await installNative(root, source, true);
        const prior = await lstat(paths.packageRoot);
        await assert.rejects(installNative(root, source, true, ['fixture/changed'], { afterCommitFile: async index => {
            if (index !== 1) return;
            const newer = JSON.parse(await readFile(paths.configPath, 'utf8')) as Record<string, unknown>;
            await writeFile(paths.configPath, JSON.stringify({ ...newer, externalEdit: true }));
            throw new Error('synthetic concurrent upgrade edit');
        } }), /indeterminate/);
        assert.notEqual((await lstat(paths.packageRoot)).ino, prior.ino);
        assert.equal((await lstat(join(paths.state, `package-backup-${process.pid}`))).ino, prior.ino);
        assert.equal(JSON.parse(await readFile(paths.manifestPath, 'utf8')).schemaVersion, 1);
        await lstat(join(paths.state, '.native-profile-transaction'));
    } finally { process.env.PATH = oldPath; await rm(tmp, { recursive: true, force: true }); }
});
