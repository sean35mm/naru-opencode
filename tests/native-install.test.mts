import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile, chmod, stat, lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { getNativeInstallPaths, installNative, nativeModels, uninstallNative } from '../tools/naru-lib/native-install.mjs';

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
        assert.match(await installNative(root, source, false), /Dry run; no files changed/);
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

test('normal CLI applies by default, and --dry-run writes nothing', async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'naru-native-cli-'));
    const bin = join(tmp, 'bin'), root = join(tmp, 'custom-config');
    try {
        await mkdir(bin);
        const host = join(bin, 'opencode'); await writeFile(host, '#!/bin/sh\nprintf "2.0.15\\n"\n'); await chmod(host, 0o700);
        const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, HOME: tmp };
        const command = join(source, 'bin', 'naru'), paths = getNativeInstallPaths(root);
        // --dry-run and its --preview alias print the plan and leave the config directory absent.
        for (const flag of ['--dry-run', '--preview']) {
            const dryRun = await run(command, ['install', '--dir', root, flag], { env });
            assert.match(dryRun.stdout, /Dry run; no files changed\. Rerun without --dry-run to apply\./);
            await assert.rejects(lstat(root), { code: 'ENOENT' });
        }
        await assert.rejects(run(command, ['install', '--dir', root, '--dry-run', '--apply'], { env }), /--dry-run and --apply cannot be combined/);
        await assert.rejects(run(command, ['uninstall', '--dir', root, '--preview', '--apply'], { env }), /cannot be combined/);
        await assert.rejects(lstat(root), { code: 'ENOENT' });
        // The default applies immediately, with stdin closed and no prompt.
        const applied = await run(command, ['install', '--dir', root], { env });
        assert.match(applied.stdout, /Installed native Naru.*registered: naru agents/s);
        assert.doesNotMatch(applied.stdout, /\[y\/N\]|Rerun/);
        assert.equal(JSON.parse(await readFile(paths.configPath, 'utf8')).agents.naru.mode, 'primary');
        // Dry-run uninstall leaves the config directory byte-identical.
        const snapshot = async () => Promise.all([paths.configPath, paths.ownershipPath, paths.profilePath, paths.manifestPath].map(path => readFile(path)));
        const before = await snapshot(), stateBefore = await readdir(paths.state);
        const uninstallDryRun = await run(command, ['uninstall', '--dir', root, '--dry-run'], { env });
        assert.match(uninstallDryRun.stdout, /Native uninstall dry run.*remove agents: naru.*Dry run; no files changed/s);
        assert.deepEqual(await snapshot(), before);
        assert.deepEqual(await readdir(paths.state), stateBefore);
        const removed = await run(command, ['uninstall', '--dir', root], { env });
        assert.match(removed.stdout, /Removed native Naru.*removed agents: naru/s);
        assert.deepEqual(JSON.parse(await readFile(paths.configPath, 'utf8')), {});
        // --apply stays accepted as a no-op.
        assert.match((await run(command, ['install', '--dir', root, '--apply'], { env })).stdout, /Installed native Naru/);
        assert.match((await run(command, ['uninstall', '--dir', root, '--apply'], { env })).stdout, /Removed native Naru/);
        for (const args of [['uninstall', '--dir', root], ['uninstall', '--dir', root, '--dry-run']]) assert.match((await run(command, args, { env })).stdout, /not installed.*Nothing to remove/);
        await assert.rejects(run(command, ['doctor', '--dir', root, '--json'], { env }), (error: { stdout?: string }) => {
            const report = JSON.parse(error.stdout ?? '{}');
            assert.deepEqual([report.native.installed, report.native.package, report.native.agents, report.native.registration], [false, 'absent', 'absent', 'absent']);
            return true;
        });
        await assert.rejects(run(command, ['rollback'], { env }), (error: { code?: number; stderr?: string }) => error.code === 2 && /not available.*Nothing was changed/.test(error.stderr ?? ''));
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
        await assert.rejects(run(cli, ['install', '--dry-run'], { env }), /requires OpenCode 2.0.15/);
        const { stdout } = await run(cli, ['install', '--dry-run', '--opencode', v2], { env });
        assert.match(stdout, /Native install dry run/);
        assert.ok(stdout.includes(root));
        assert.doesNotMatch(stdout, /Apply these changes\?/);
        await assert.rejects(lstat(root), { code: 'ENOENT' });
        for (const args of [['--opencode'], ['--opencode', 'relative/path'], ['--opencode', join(tmp, 'missing')], ['--opencode', v1]]) {
            await assert.rejects(run(cli, ['install', '--dry-run', ...args], { env }), /--opencode|requires OpenCode 2.0.15/);
        }
        await assert.rejects(run(cli, ['install', '--dry-run', '--apply', '--opencode', v2], { env }), /cannot be combined/);
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
        const { stdout } = await run(join(source, 'bin', 'naru'), ['install', '--dry-run', '--opencode', host], { env });
        assert.match(stdout, /Dry run; no files changed/);
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
        const { stdout } = await run(join(source, 'bin', 'naru'), ['install', '--dry-run', '--opencode', process.env.NARU_NATIVE_TEST_REAL_OPENCODE!], { env });
        assert.match(stdout, /Dry run; no files changed/);
        await assert.rejects(lstat(root), { code: 'ENOENT' });
        assert.deepEqual(await readdir(probes), []);
        await run(join(source, 'bin', 'naru'), ['install', '--dir', root, '--opencode', process.env.NARU_NATIVE_TEST_REAL_OPENCODE!], { env });
        const refs = 'fixture/previously-working,fixture/other#fast', cli = join(source, 'bin', 'naru');
        const before = await Promise.all([getNativeInstallPaths(root).configPath, getNativeInstallPaths(root).profilePath].map(path => readFile(path)));
        const preview = await run(cli, ['models', '--dir', root, '--set', refs, '--dry-run', '--opencode', process.env.NARU_NATIVE_TEST_REAL_OPENCODE!], { env });
        assert.match(preview.stdout, /Availability not checked/);
        for (const [index, path] of [getNativeInstallPaths(root).configPath, getNativeInstallPaths(root).profilePath].entries()) assert.deepEqual(await readFile(path), before[index]);
        await run(cli, ['models', '--dir', root, '--set', refs, '--opencode', process.env.NARU_NATIVE_TEST_REAL_OPENCODE!], { env });
        assert.deepEqual(await nativeModels(root), refs.split(','));
        await run(cli, ['uninstall', '--dir', root], { env });
        assert.deepEqual(JSON.parse(await readFile(getNativeInstallPaths(root).configPath, 'utf8')), {});
        await assert.rejects(lstat(getNativeInstallPaths(root).state), { code: 'ENOENT' });
    } finally { await rm(tmp, { recursive: true, force: true }); }
});

test('normal CLI explicit models --set dry-runs and saves exact references offline', async () => {
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
        await run(command, ['install', '--dir', root, '--opencode', host], { env });
        const before = await run(command, ['models', '--dir', root, '--list'], { env });
        assert.match(before.stdout, /No native workers selected/);
        await assert.rejects(run(command, ['models', '--dir', root, '--set', 'fixture/model#fast', '--dry-run'], { env }), /requires OpenCode 2.0.15/);
        const paths = getNativeInstallPaths(root), original = await Promise.all([paths.configPath, paths.profilePath].map(path => readFile(path)));
        const refs = 'fixture/model#fast,absent/previously-working';
        const preview = await run(command, ['models', '--dir', root, '--set', refs, '--dry-run', '--opencode', host], { env });
        assert.match(preview.stdout, /Dry run; no files changed.*Availability not checked/s);
        assert.deepEqual(await nativeModels(root), []);
        for (const [index, path] of [paths.configPath, paths.profilePath].entries()) assert.deepEqual(await readFile(path), original[index]);
        const saved = await run(command, ['models', '--dir', root, '--set', refs, '--opencode', host], { env });
        assert.match(saved.stdout, /Saved native worker configuration:.*Availability not checked/s);
        const after = await run(command, ['models', '--dir', root, '--list'], { env });
        assert.equal(after.stdout.trim(), refs.replace(',', '\n'));
        assert.deepEqual(JSON.parse(await readFile(paths.profilePath, 'utf8')).models, refs.split(','));
        const stable = await Promise.all([paths.configPath, paths.profilePath].map(path => readFile(path)));
        for (const invalid of ['fixture/one,fixture/one', 'fixture/one,', 'fixture/../unsafe', 'fixture/one, fixture/two', Array.from({ length: 33 }, (_, index) => `fixture/model${index}`).join(',')]) {
            await assert.rejects(run(command, ['models', '--dir', root, '--set', invalid, '--opencode', host], { env }), /Duplicate native model reference|exact comma-separated|Invalid enrolled catalogue reference|at most 32/);
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
        await assert.rejects(installNative(root, source, true), /requires OpenCode 2.0.15/);
        for (const version of ['2.1.0', '2.0.16-beta.1', 'opencode v2.0.15 extra']) {
            await writeFile(host, `#!/bin/sh\nprintf "${version}\\n"\n`);
            await assert.rejects(installNative(root, source, false), /requires OpenCode 2.0.15/);
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

test('native uninstall dry-runs, removes only unmodified owned registration, and round-trips', async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'naru-native-uninstall-'));
    const bin = join(tmp, 'bin'), root = join(tmp, 'config'), paths = getNativeInstallPaths(root), oldPath = process.env.PATH;
    try {
        await mkdir(bin); await mkdir(root);
        const host = join(bin, 'opencode'); await writeFile(host, '#!/bin/sh\nprintf "2.0.15\\n"\n'); await chmod(host, 0o700);
        process.env.PATH = `${bin}:${oldPath}`;
        assert.match((await uninstallNative(root, true)).text, /not installed/);
        assert.deepEqual(await readdir(root), []);
        const user = { theme: 'user-theme', agent: { custom: { mode: 'subagent' } }, agents: { mine: { mode: 'subagent', prompt: 'keep' } }, plugins: ['user-plugin', { package: 'user-package', options: { level: 1 } }], skills: ['/user/skills'], provider: { fixture: { key: 'public-placeholder' } } };
        await writeFile(paths.configPath, JSON.stringify(user), { mode: 0o644 });
        await installNative(root, source, true);
        await nativeModels(root, ['fixture/model#fast']);
        const installed = JSON.parse(await readFile(paths.configPath, 'utf8'));
        const workers = Object.keys(installed.agents).filter(name => name.startsWith('naru-worker-'));
        assert.equal(workers.length, 1);
        installed.agents[workers[0]!].description = 'edited by the user';
        await writeFile(paths.configPath, JSON.stringify(installed, null, 2));
        const snapshot = async () => Promise.all([paths.configPath, paths.ownershipPath, paths.profilePath, paths.manifestPath].map(path => readFile(path)));
        const before = await snapshot(), stateBefore = await readdir(paths.state);
        const preview = await uninstallNative(root, false);
        assert.match(preview.text, /Dry run; no files changed/);
        assert.match(preview.text, new RegExp(`keep agents edited since install.*${workers[0]}`));
        assert.deepEqual(await snapshot(), before);
        assert.deepEqual(await readdir(paths.state), stateBefore);
        const applied = await uninstallNative(root, true);
        assert.match(applied.text, /Removed native Naru/);
        assert.match(applied.text, /removed agents: naru\b/);
        assert.match(applied.text, new RegExp(`kept agents edited since install.*${workers[0]}`));
        await assert.rejects(lstat(paths.state), { code: 'ENOENT' });
        assert.deepEqual(await readdir(root), ['opencode.json']);
        const after = JSON.parse(await readFile(paths.configPath, 'utf8'));
        assert.deepEqual(after, { ...user, agents: { mine: user.agents.mine, [workers[0]!]: installed.agents[workers[0]!] } });
        assert.equal((await stat(paths.configPath)).mode & 0o777, 0o644);
        assert.match((await uninstallNative(root, false)).text, /not installed/);
        await installNative(root, source, true);
        await assert.rejects(nativeModels(root, ['fixture/model#fast']), /collides/);
        const reinstalled = JSON.parse(await readFile(paths.configPath, 'utf8'));
        delete reinstalled.agents[workers[0]!];
        await writeFile(paths.configPath, JSON.stringify(reinstalled));
        await nativeModels(root, ['fixture/model#fast']);
        await uninstallNative(root, true);
        const roundTrip = JSON.parse(await readFile(paths.configPath, 'utf8'));
        assert.deepEqual(roundTrip, user);
    } finally { process.env.PATH = oldPath; await rm(tmp, { recursive: true, force: true }); }
});

test('native uninstall fails closed on partial state, dangling registration, and v1 leftovers', async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'naru-native-uninstall-refusal-'));
    const bin = join(tmp, 'bin'), root = join(tmp, 'config'), paths = getNativeInstallPaths(root), oldPath = process.env.PATH;
    try {
        await mkdir(bin);
        const host = join(bin, 'opencode'); await writeFile(host, '#!/bin/sh\nprintf "2.0.15\\n"\n'); await chmod(host, 0o700);
        process.env.PATH = `${bin}:${oldPath}`;
        await installNative(root, source, true);
        const config = await readFile(paths.configPath);
        await writeFile(join(paths.state, 'package-backup-1'), 'unknown');
        for (const apply of [false, true]) await assert.rejects(uninstallNative(root, apply), /unexpected entries \(package-backup-1\)/);
        await rm(join(paths.state, 'package-backup-1'));
        const ownership = await readFile(paths.ownershipPath);
        await rm(paths.ownershipPath);
        for (const apply of [false, true]) await assert.rejects(uninstallNative(root, apply), /incomplete/);
        await writeFile(paths.ownershipPath, '{"schemaVersion":1', { mode: 0o600 });
        for (const apply of [false, true]) await assert.rejects(uninstallNative(root, apply), /malformed JSON/);
        await writeFile(paths.ownershipPath, ownership, { mode: 0o600 });
        await writeFile(join(paths.packageRoot, 'tools', 'package.json'), 'modified');
        await assert.rejects(uninstallNative(root, true), /modified/);
        assert.deepEqual(await readFile(paths.configPath), config);
        await rm(paths.state, { recursive: true });
        await assert.rejects(uninstallNative(root, true), /still references/);
        assert.deepEqual(await readFile(paths.configPath), config);
        await writeFile(paths.configPath, '{}');
        await writeFile(join(root, '.naru-install.json'), '{}');
        await assert.rejects(uninstallNative(root, true), /v1 files remain \(\.naru-install\.json\).*--legacy/);
        assert.equal(await readFile(join(root, '.naru-install.json'), 'utf8'), '{}');
    } finally { process.env.PATH = oldPath; await rm(tmp, { recursive: true, force: true }); }
});
