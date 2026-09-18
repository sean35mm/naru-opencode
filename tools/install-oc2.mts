#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { access, chmod, cp, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { COMPATIBILITY_POLICY } from './naru-lib/compatibility.mjs';
import { cleanupLegacyStandaloneNaruAgent } from './naru-lib/oc2-profile.mjs';
import { updateOc2NativeProfile } from './naru-lib/oc2-native-config.mjs';
import { PREVIEW_VERSION } from './naru-lib/preview-host.mjs';
import { acquirePreviewUpdateGuard, assertPreviewUpdateGuard, type PreviewUpdateGuard } from './naru-lib/preview-update-guard.mjs';

interface InstallOptions { previewCli: string; opencode: string; v2Wrapper: string; root: string; bin: string; node?: string }
interface UpdateOptions { previewCli: string; v2Wrapper: string; root: string; nativeRoot: string; node?: string }
interface CodeRefreshOptions { previewCli: string; root: string; node?: string }
interface CodeRefreshAdapters { beforeFirstRename?: () => Promise<void> }
interface PreviewHostMetadata { root: string; executable: string; executableHash: string; node: string; cli: string }
interface Oc2UpdateAdapters {
    prepareNative?: typeof prepareNativeUpdate;
    beforeSwitch?: () => Promise<void>;
    cleanupCommittedSwap?: () => Promise<void>;
    report?: (message: string) => void;
}
class RolledBackUpdateError extends Error { constructor(readonly original: unknown) { super('oc2 update failed and was rolled back'); } }
class IndeterminateUpdateError extends Error { constructor(readonly original: unknown) { super('oc2 update was interrupted during rollback; start.lock and recovery files were retained'); } }

export const OC2_UPDATE_RELEASE = Object.freeze({
    predecessorVersion: '0.0.0-beta-19271',
    version: '0.0.0-beta-19425',
    wrapper: {
        package: '@opencode/cli',
        url: 'https://registry.npmjs.org/@opencode/cli/-/cli-0.0.0-beta-19425.tgz',
        sri: 'sha512-2cJtOckNpLHs0fpLS1n/JZKoIJ5LWmVvQOhoGJzi7KeVCk0jZ8jiuxIK4WO+9dlYH4tVotwQUNIVKjr/ydD/Ww==',
    },
    native: {
        'darwin-arm64': {
            package: '@opencode/cli-darwin-arm64',
            url: 'https://registry.npmjs.org/@opencode/cli-darwin-arm64/-/cli-darwin-arm64-0.0.0-beta-19425.tgz',
            sri: 'sha512-HevgkocfjHbMVGODmgtTS+ftw50bTYVHlEs/X4mWZEJG3smMaB1LpCEbYF58S+BO3YeR3INo/obnKXRc7+2RLw==',
        },
        'linux-x64': {
            package: '@opencode/cli-linux-x64',
            url: 'https://registry.npmjs.org/@opencode/cli-linux-x64/-/cli-linux-x64-0.0.0-beta-19425.tgz',
            sri: 'sha512-62w+MgyOiInAxuGo9VCjWOrenOkCvmyaKFEUBNRaUqq+BDbizBGsTjn/pqKj9wrst+GtqREWjH8bVn302h3g7w==',
        },
    },
} as const);

function quote(value: string): string { return `'${value.replaceAll("'", "'\\''")}'`; }
async function absent(path: string, label: string): Promise<void> {
    try { await lstat(path); throw new Error(`${label} already exists; refusing to overwrite it`); }
    catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error; }
}
async function runSetup(node: string, previewCli: string, root: string, opencode: string): Promise<void> {
    await new Promise<void>((resolvePromise, reject) => {
        const child = spawn(node, [previewCli, '--root', root, 'setup', '--opencode', opencode], { stdio: 'inherit' });
        child.once('error', reject);
        child.once('exit', code => code === 0 ? resolvePromise() : reject(new Error(`preview setup failed with exit ${code ?? 1}`)));
    });
}

function sha256(value: Buffer): string { return createHash('sha256').update(value).digest('hex'); }
function verifySri(value: Buffer, expected: string): void {
    const actual = `sha512-${createHash('sha512').update(value).digest('base64')}`;
    if (actual !== expected) throw new Error('Downloaded OpenCode artifact failed SRI verification');
}
function parseHostMetadata(value: unknown, root: string): PreviewHostMetadata {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid preview host metadata');
    const record = value as Record<string, unknown>;
    if (Object.keys(record).sort().join(',') !== 'cli,executable,executableHash,node,root') throw new Error('Preview host metadata contains unsupported fields');
    if (record.root !== root || !/^[a-f0-9]{64}$/.test(String(record.executableHash ?? ''))
        || !['executable', 'node', 'cli'].every(key => typeof record[key] === 'string' && isAbsolute(record[key] as string))) throw new Error('Invalid preview host metadata');
    return record as unknown as PreviewHostMetadata;
}
async function regularOwnedFile(path: string, label: string): Promise<Awaited<ReturnType<typeof lstat>>> {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || (process.getuid && info.uid !== process.getuid())) throw new Error(`${label} must be an owned regular file`);
    return info;
}
async function run(executable: string, argv: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv; timeout?: number; maxBytes?: number } = {}): Promise<{ code: number | null; stdout: string }> {
    return new Promise((resolvePromise, reject) => {
        const child = spawn(executable, argv, { cwd: options.cwd, env: options.env, stdio: ['ignore', 'pipe', 'ignore'] });
        let stdout = '', bytes = 0, settled = false;
        const timer = setTimeout(() => { child.kill('SIGTERM'); }, options.timeout ?? 10_000);
        child.stdout.on('data', chunk => { bytes += chunk.length; if (bytes <= (options.maxBytes ?? 64 * 1024)) stdout += chunk; else child.kill('SIGTERM'); });
        child.once('error', error => { if (!settled) { settled = true; clearTimeout(timer); reject(error); } });
        child.once('exit', code => { if (!settled) { settled = true; clearTimeout(timer); resolvePromise({ code, stdout }); } });
    });
}
async function assertPreviewStopped(host: PreviewHostMetadata, guardToken?: string): Promise<void> {
    for (const name of ['broker.sock', ...(guardToken ? [] : ['start.lock'])]) {
        try { await lstat(join(host.root, name)); throw new Error(`Preview ${name} exists; stop the isolated preview before updating`); }
        catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error; }
    }
    if (guardToken) await assertPreviewUpdateGuard(host.root, guardToken);
    try {
        const pid = Number((await readFile(join(host.root, 'daemon.pid'), 'utf8')).trim());
        if (Number.isSafeInteger(pid) && pid > 1) {
            try { process.kill(pid, 0); throw new Error(`Preview daemon is running (PID ${pid}, recorded in daemon.pid); stop it before updating`); }
            catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ESRCH')) throw error; }
        }
    } catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error; }
    const processes = await run('/bin/ps', ['-axo', 'pid=,command='], { maxBytes: 4 * 1024 * 1024 });
    if (processes.code !== 0) throw new Error('Could not verify that preview processes are stopped');
    for (const line of processes.stdout.split('\n')) {
        const match = line.trim().match(/^(\d+)\s+(.*)$/); if (!match) continue;
        const pid = Number(match[1]);
        if (pid === process.pid || pid === process.ppid) continue;
        if (match[2]!.includes(host.root + '/') || match[2]!.includes(host.executable)) throw new Error(`An isolated preview process is running (PID ${pid}, command references the preview root or native executable); stop it before updating`);
    }
}
export function validateOc2PredecessorVersion(output: unknown): void {
    if (typeof output !== 'string' || output.trim() !== `opencode2 v${OC2_UPDATE_RELEASE.predecessorVersion}`) throw new Error(`oc2 update requires exact predecessor ${OC2_UPDATE_RELEASE.predecessorVersion}`);
}
export function validateOc2UpdaterTarget(previewVersion: unknown, recognizedBuilds: readonly string[]): void {
    if (previewVersion !== OC2_UPDATE_RELEASE.version || recognizedBuilds.length !== 1 || recognizedBuilds[0] !== OC2_UPDATE_RELEASE.version) throw new Error(`Compiled oc2 updater does not target exact ${OC2_UPDATE_RELEASE.version}`);
}
async function validateOc2UpdaterBuild(previewCli: string): Promise<string> {
    const ownPreviewCli = join(dirname(fileURLToPath(import.meta.url)), 'naru-preview.mjs');
    if (await realpath(previewCli) !== await realpath(ownPreviewCli)) throw new Error('preview CLI must be naru-preview.mjs from the updater own compiled tree');
    validateOc2UpdaterTarget(PREVIEW_VERSION, COMPATIBILITY_POLICY.profiles['v2-beta-exploratory'].recognizedBuilds);
    return ownPreviewCli;
}
async function validateOc2Predecessor(host: PreviewHostMetadata): Promise<void> {
    const probeRoot = await mkdtemp(join(tmpdir(), 'naru-oc2-predecessor-'));
    try {
        const result = await run(host.executable, ['--version'], { cwd: probeRoot, env: {
            HOME: probeRoot, XDG_CONFIG_HOME: probeRoot, XDG_DATA_HOME: probeRoot, XDG_CACHE_HOME: probeRoot,
            XDG_STATE_HOME: probeRoot, OPENCODE_DB: join(probeRoot, 'opencode.db'), OPENCODE_DISABLE_AUTOUPDATE: 'true',
            OPENCODE_DISABLE_PROJECT_CONFIG: 'true', PATH: '/usr/bin:/bin', LANG: 'en_US.UTF-8',
        } });
        if (result.code !== 0) throw new Error('Could not verify the installed oc2 predecessor');
        validateOc2PredecessorVersion(result.stdout);
    } finally { await rm(probeRoot, { recursive: true, force: true }); }
}
async function validateInstalledPin(host: PreviewHostMetadata): Promise<void> {
    const probeRoot = await mkdtemp(join(tmpdir(), 'naru-oc2-refresh-probe-'));
    try {
        const result = await run(host.executable, ['--version'], { cwd: probeRoot, env: { HOME: probeRoot, XDG_CONFIG_HOME: probeRoot, XDG_DATA_HOME: probeRoot, XDG_CACHE_HOME: probeRoot, XDG_STATE_HOME: probeRoot, OPENCODE_DB: join(probeRoot, 'opencode.db'), OPENCODE_DISABLE_AUTOUPDATE: 'true', OPENCODE_DISABLE_PROJECT_CONFIG: 'true', PATH: '/usr/bin:/bin', LANG: 'en_US.UTF-8' } });
        if (result.code !== 0 || result.stdout.trim() !== `opencode2 v${OC2_UPDATE_RELEASE.version}`) throw new Error(`Code refresh requires exact installed ${OC2_UPDATE_RELEASE.version}`);
    } finally { await rm(probeRoot, { recursive: true, force: true }); }
}
async function loadUpdateHost(root: string): Promise<PreviewHostMetadata> {
    const rootInfo = await lstat(root);
    if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink() || (process.getuid && rootInfo.uid !== process.getuid()) || (rootInfo.mode & 0o077) !== 0) throw new Error('Preview root must be an owned private directory');
    const host = parseHostMetadata(JSON.parse(await readFile(join(root, 'host.json'), 'utf8')), root);
    await regularOwnedFile(host.executable, 'current OpenCode executable');
    const executableBytes = await readFile(host.executable);
    if (!['cffaedfe', 'feedfacf', 'cafebabe', '7f454c46'].includes(executableBytes.subarray(0, 4).toString('hex'))) throw new Error('Current OpenCode executable is not native');
    if (sha256(executableBytes) !== host.executableHash) throw new Error('Current OpenCode executable does not match preview host metadata');
    if (host.cli !== join(root, 'lib', 'tools', 'naru-preview.mjs')) throw new Error('Preview host CLI is outside the installed snapshot');
    return host;
}
async function hashTree(path: string): Promise<string> {
    const hash = createHash('sha256');
    async function visit(current: string, relative: string): Promise<void> {
        const info = await lstat(current);
        if (info.isSymbolicLink() || (!info.isDirectory() && !info.isFile())) throw new Error('Compiled tool recovery contains an unsupported file');
        hash.update(`${info.isDirectory() ? 'd' : 'f'}\0${relative}\0${info.mode & 0o777}\0`);
        if (info.isFile()) { hash.update(await readFile(current)); return; }
        for (const name of (await readdir(current)).sort()) await visit(join(current, name), relative ? `${relative}/${name}` : name);
    }
    await visit(path, ''); return hash.digest('hex');
}
function updatedWrapper(source: string, host: PreviewHostMetadata, executable: string): string {
    if (source.includes('\0')) throw new Error('Invalid v2 wrapper');
    const lines = source.split('\n');
    const indexes = lines.flatMap((line, index) => /^exec .+ "\$@"$/.test(line) ? [index] : []);
    if (indexes.length !== 1 || lines.slice(indexes[0]! + 1).some(Boolean)) throw new Error('v2 wrapper must end in exactly one exec target');
    const current = lines[indexes[0]!]!;
    if (current !== `exec ${quote(host.executable)} "$@"`) throw new Error('v2 wrapper target does not exactly match preview host metadata');
    lines[indexes[0]!] = `exec ${quote(executable)} "$@"`;
    return lines.join('\n');
}
async function download(url: string, sri: string): Promise<Buffer> {
    const maximumBytes = 256 * 1024 * 1024, controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 180_000);
    try {
        const response = await fetch(url, { redirect: 'follow', signal: controller.signal });
        if (!response.ok) throw new Error(`OpenCode artifact download failed with HTTP ${response.status}`);
        const length = Number(response.headers.get('content-length'));
        if (Number.isFinite(length) && length > maximumBytes) throw new Error('OpenCode artifact is too large');
        if (!response.body) throw new Error('OpenCode artifact download returned no body');
        const chunks: Buffer[] = []; let total = 0;
        for await (const chunk of response.body) {
            const bytes = Buffer.from(chunk); total += bytes.length;
            if (total > maximumBytes) throw new Error('OpenCode artifact is too large');
            chunks.push(bytes);
        }
        const bytes = Buffer.concat(chunks, total); verifySri(bytes, sri); return bytes;
    } catch (error) {
        if (controller.signal.aborted) throw new Error('OpenCode artifact download timed out', { cause: error });
        throw error;
    } finally { clearTimeout(timer); }
}
async function archiveEntries(archive: string): Promise<string[]> {
    const result = await run('/usr/bin/tar', ['-tzf', archive]);
    if (result.code !== 0) throw new Error('Could not inspect OpenCode artifact');
    return result.stdout.trim().split('\n');
}
async function verifyPackage(path: string, expectedName: string): Promise<Record<string, unknown>> {
    await regularOwnedFile(path, 'package metadata');
    const value: unknown = JSON.parse(await readFile(path, 'utf8'));
    if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid OpenCode package metadata');
    const record = value as Record<string, unknown>;
    if (record.name !== expectedName || record.version !== OC2_UPDATE_RELEASE.version) throw new Error('OpenCode package identity does not match the update pin');
    return record;
}
async function prepareNativeUpdate(nativeRoot: string): Promise<{ executable: string; cleanup: () => Promise<void> }> {
    const platform = `${process.platform}-${process.arch}` as keyof typeof OC2_UPDATE_RELEASE.native;
    const native = OC2_UPDATE_RELEASE.native[platform];
    if (!native) throw new Error(`No pinned oc2 update artifact for ${platform}`);
    const temporary = await mkdtemp(join(tmpdir(), 'naru-oc2-update-'));
    const cleanup = () => rm(temporary, { recursive: true, force: true });
    try {
        const [wrapperBytes, nativeBytes] = await Promise.all([
            download(OC2_UPDATE_RELEASE.wrapper.url, OC2_UPDATE_RELEASE.wrapper.sri), download(native.url, native.sri),
        ]);
        const wrapperArchive = join(temporary, 'wrapper.tgz'), nativeArchive = join(temporary, 'native.tgz');
        await writeFile(wrapperArchive, wrapperBytes, { mode: 0o600 }); await writeFile(nativeArchive, nativeBytes, { mode: 0o600 });
        if ((await archiveEntries(wrapperArchive)).join('\n') !== ['package/package.json', 'package/bin/opencode2.exe', 'package/postinstall.mjs'].join('\n')) throw new Error('Unexpected OpenCode wrapper archive paths');
        if ((await archiveEntries(nativeArchive)).join('\n') !== ['package/package.json', 'package/bin/opencode2'].join('\n')) throw new Error('Unexpected OpenCode native archive paths');
        const wrapperExtract = join(temporary, 'wrapper'), nativeExtract = join(temporary, 'native');
        await mkdir(wrapperExtract); await mkdir(nativeExtract);
        if ((await run('/usr/bin/tar', ['-xzf', wrapperArchive, '--directory', wrapperExtract, '--no-same-owner', '--no-same-permissions'])).code !== 0
            || (await run('/usr/bin/tar', ['-xzf', nativeArchive, '--directory', nativeExtract, '--no-same-owner', '--no-same-permissions'])).code !== 0) throw new Error('Could not extract OpenCode artifacts');
        const wrapperPackage = await verifyPackage(join(wrapperExtract, 'package', 'package.json'), OC2_UPDATE_RELEASE.wrapper.package);
        const optional = wrapperPackage.optionalDependencies;
        if (optional === null || typeof optional !== 'object' || (optional as Record<string, unknown>)[native.package] !== OC2_UPDATE_RELEASE.version) throw new Error('OpenCode wrapper does not pin the selected native package');
        await verifyPackage(join(nativeExtract, 'package', 'package.json'), native.package);
        const extracted = join(nativeExtract, 'package', 'bin', 'opencode2');
        await regularOwnedFile(extracted, 'native OpenCode executable');
        const bytes = await readFile(extracted);
        if (!['cffaedfe', 'feedfacf', 'cafebabe', '7f454c46'].includes(bytes.subarray(0, 4).toString('hex'))) throw new Error('OpenCode artifact is not a native executable');
        await chmod(extracted, 0o755);
        const probeRoot = join(temporary, 'probe'); await mkdir(probeRoot, { mode: 0o700 });
        const result = await run(extracted, ['--version'], { cwd: probeRoot, env: { HOME: probeRoot, XDG_CONFIG_HOME: probeRoot, XDG_DATA_HOME: probeRoot, XDG_CACHE_HOME: probeRoot, XDG_STATE_HOME: probeRoot, OPENCODE_DB: join(probeRoot, 'opencode.db'), OPENCODE_DISABLE_AUTOUPDATE: 'true', PATH: '/usr/bin:/bin' } });
        if (result.code !== 0 || result.stdout.trim() !== `opencode2 v${OC2_UPDATE_RELEASE.version}`) throw new Error('Pinned OpenCode executable failed its isolated version check');
        const versions = join(nativeRoot, 'versions'); await mkdir(versions, { recursive: true, mode: 0o700 });
        const destination = join(versions, OC2_UPDATE_RELEASE.version); await absent(destination, 'versioned OpenCode destination');
        const staging = join(versions, `.update-${process.pid}-${randomBytes(6).toString('hex')}`); await mkdir(staging, { mode: 0o700 });
        await cp(extracted, join(staging, 'opencode2')); await chmod(join(staging, 'opencode2'), 0o755); await rename(staging, destination);
        return { executable: join(destination, 'opencode2'), cleanup };
    } catch (error) { await cleanup(); throw error; }
}

async function cleanupOc2Operation(cleanup: () => Promise<void>, warning: string, report: (message: string) => void): Promise<void> {
    try { await cleanup(); }
    catch { try { report(warning); } catch { /* Reporting cannot change the committed or rolled-back generation. */ } }
}

async function applyPreparedOc2UpdateWithGuard(options: Omit<UpdateOptions, 'nativeRoot'> & { executable: string }, guard: PreviewUpdateGuard, adapters: Pick<Oc2UpdateAdapters, 'beforeSwitch' | 'cleanupCommittedSwap' | 'report'> = {}): Promise<void> {
    for (const [label, value] of Object.entries(options)) if (label !== 'node' && !isAbsolute(value!)) throw new Error(`${label} must be an absolute path`);
    const host = await loadUpdateHost(options.root);
    await regularOwnedFile(options.v2Wrapper, 'v2 wrapper'); await regularOwnedFile(options.executable, 'new OpenCode executable');
    const previewCli = await validateOc2UpdaterBuild(options.previewCli), executable = await realpath(options.executable), node = await realpath(options.node ?? host.node);
    const sourceTools = dirname(previewCli), tools = join(options.root, 'lib', 'tools');
    if (basename(previewCli) !== 'naru-preview.mjs' || previewCli !== join(sourceTools, 'naru-preview.mjs')) throw new Error('preview CLI must be the compiled naru-preview.mjs snapshot');
    await assertPreviewStopped(host, guard.token);
    const wrapperInfo = await lstat(options.v2Wrapper), wrapperSource = await readFile(options.v2Wrapper, 'utf8');
    const replacementWrapper = updatedWrapper(wrapperSource, host, executable);
    const stage = join(options.root, `.oc2-update-${process.pid}-${randomBytes(6).toString('hex')}`); await mkdir(stage, { mode: 0o700 });
    const stagedTools = join(stage, 'tools'), oldTools = join(stage, 'old-tools');
    const hostPath = join(options.root, 'host.json'), hostBackup = join(stage, 'host.json.old'), hostStaged = join(stage, 'host.json.new');
    const wrapperBackup = `${options.v2Wrapper}.oc2-old-${process.pid}`, wrapperStaged = `${options.v2Wrapper}.oc2-new-${process.pid}`;
    const launcher = join(options.root, 'naru-preview'), disabledLauncher = join(stage, 'naru-preview');
    const recovery = join(options.root, `update-recovery-${OC2_UPDATE_RELEASE.predecessorVersion}`);
    const updatedHost: PreviewHostMetadata = { root: host.root, executable, executableHash: sha256(await readFile(executable)), node, cli: host.cli };
    let launcherDisabled = false, toolsMoved = false, toolsInstalled = false, hostMoved = false, hostInstalled = false, wrapperMoved = false, wrapperInstalled = false;
    let outcome: 'pending' | 'committed' | 'rolled-back' = 'pending', retainStaging = false;
    try {
        await cp(sourceTools, stagedTools, { recursive: true });
        await writeFile(hostStaged, JSON.stringify(updatedHost, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
        await writeFile(wrapperStaged, replacementWrapper, { mode: wrapperInfo.mode & 0o777, flag: 'wx' });
        await regularOwnedFile(launcher, 'preview launcher'); await absent(recovery, 'oc2 update recovery directory');
        await mkdir(recovery, { mode: 0o700 });
        await cp(tools, join(recovery, 'tools'), { recursive: true });
        await cp(hostPath, join(recovery, 'host.json')); await cp(options.v2Wrapper, join(recovery, 'opencode2-naru')); await cp(launcher, join(recovery, 'naru-preview'));
        await writeFile(join(recovery, 'README.txt'), `Recovery files from the ${OC2_UPDATE_RELEASE.predecessorVersion} oc2 generation. Restore all four files together only after verifying no preview process or socket is live. Do not reset preview state.\n`, { mode: 0o600 });
        if (await hashTree(tools) !== await hashTree(join(recovery, 'tools'))
            || !(await readFile(hostPath)).equals(await readFile(join(recovery, 'host.json')))
            || !(await readFile(options.v2Wrapper)).equals(await readFile(join(recovery, 'opencode2-naru')))
            || !(await readFile(launcher)).equals(await readFile(join(recovery, 'naru-preview')))) throw new Error('oc2 recovery generation validation failed');
        const backupPaths = { tools: join(recovery, 'tools'), host: join(recovery, 'host.json'), wrapper: join(recovery, 'opencode2-naru'), launcher: join(recovery, 'naru-preview') };
        await guard.setPhase({ phase: 'pre-switch', recoveryPath: recovery, backupPaths, validatedBackups: true });
        await adapters.beforeSwitch?.();
        await guard.setPhase({ phase: 'switching', recoveryPath: recovery, backupPaths, validatedBackups: true });
        await rename(launcher, disabledLauncher); launcherDisabled = true;
        await rename(options.v2Wrapper, wrapperBackup); wrapperMoved = true;
        await assertPreviewStopped(host, guard.token);
        await rename(tools, oldTools); toolsMoved = true; await rename(stagedTools, tools); toolsInstalled = true;
        await rename(hostPath, hostBackup); hostMoved = true; await rename(hostStaged, hostPath); hostInstalled = true;
        await rename(wrapperStaged, options.v2Wrapper); wrapperInstalled = true;
        await rename(disabledLauncher, launcher); launcherDisabled = false;
        await guard.setPhase({ phase: 'complete', recoveryPath: recovery, backupPaths, validatedBackups: true });
        outcome = 'committed';
    } catch (error) {
        try {
            if (wrapperInstalled) await rm(options.v2Wrapper, { force: true }); if (wrapperMoved) await rename(wrapperBackup, options.v2Wrapper);
            if (hostInstalled) await rm(hostPath, { force: true }); if (hostMoved) await rename(hostBackup, hostPath);
            if (toolsInstalled) await rm(tools, { recursive: true, force: true }); if (toolsMoved) await rename(oldTools, tools);
            if (launcherDisabled) await rename(disabledLauncher, launcher);
        } catch { retainStaging = true; throw new IndeterminateUpdateError(error); }
        outcome = 'rolled-back';
        throw new RolledBackUpdateError(error);
    } finally {
        if (!retainStaging) {
            const cleanup = adapters.cleanupCommittedSwap ?? (() => Promise.all([
                rm(wrapperStaged, { force: true }), rm(wrapperBackup, { force: true }), rm(stage, { recursive: true, force: true }),
            ]).then(() => undefined));
            const warning = outcome === 'committed'
                ? 'oc2 native update committed successfully, but old-generation staging could not be removed; the active generation was not rolled back'
                : 'oc2 native update rolled back successfully, but updater staging could not be removed; the predecessor remains active';
            await cleanupOc2Operation(cleanup, warning, adapters.report ?? (message => process.stderr.write(message + '\n')));
        }
    }
}

export async function applyPreparedOc2Update(options: Omit<UpdateOptions, 'nativeRoot'> & { executable: string }): Promise<void> {
    await validateOc2UpdaterBuild(options.previewCli);
    const guard = await acquirePreviewUpdateGuard(options.root);
    let safeToRelease = true;
    try { await applyPreparedOc2UpdateWithGuard(options, guard); }
    catch (error) {
        if (error instanceof RolledBackUpdateError) throw error.original;
        if (error instanceof IndeterminateUpdateError) safeToRelease = false;
        throw error;
    } finally { if (safeToRelease) await guard.release(); }
}

export async function updateOc2(options: UpdateOptions, adapters: Oc2UpdateAdapters = {}): Promise<string> {
    for (const [label, value] of Object.entries(options)) if (label !== 'node' && !isAbsolute(value!)) throw new Error(`${label} must be an absolute path`);
    if (process.versions.node.split('.')[0] !== '24') throw new Error('Run the oc2 updater with Node 24');
    await validateOc2UpdaterBuild(options.previewCli);
    const guard = await acquirePreviewUpdateGuard(options.root);
    let safeToRelease = true;
    try {
        const host = await loadUpdateHost(options.root);
        await regularOwnedFile(options.v2Wrapper, 'v2 wrapper'); await assertPreviewStopped(host, guard.token);
        const nativeRoot = await realpath(options.nativeRoot);
        const expectedPredecessor = join(nativeRoot, 'versions', OC2_UPDATE_RELEASE.predecessorVersion, 'opencode2');
        await regularOwnedFile(expectedPredecessor, 'predecessor OpenCode executable');
        const canonicalPredecessor = await realpath(expectedPredecessor);
        if (host.executable !== canonicalPredecessor || await realpath(host.executable) !== canonicalPredecessor) throw new Error('Current OpenCode executable is not the exact versioned predecessor under the selected native root');
        await validateOc2Predecessor(host);
        const prepared = await (adapters.prepareNative ?? prepareNativeUpdate)(nativeRoot);
        let updateOutcome: 'committed' | 'rolled-back' | 'indeterminate' = 'committed';
        try { await applyPreparedOc2UpdateWithGuard({ previewCli: options.previewCli, v2Wrapper: options.v2Wrapper, root: options.root, ...(options.node ? { node: options.node } : {}), executable: prepared.executable }, guard, adapters); }
        catch (error) {
            if (error instanceof IndeterminateUpdateError) { safeToRelease = false; updateOutcome = 'indeterminate'; }
            else {
                updateOutcome = 'rolled-back';
                await rm(dirname(prepared.executable), { recursive: true, force: true });
            }
            throw error instanceof RolledBackUpdateError ? error.original : error;
        }
        finally {
            const warning = updateOutcome === 'committed'
                ? 'oc2 native update committed successfully, but downloaded artifact staging could not be removed; the active generation was not rolled back'
                : updateOutcome === 'indeterminate'
                    ? 'oc2 native update is indeterminate and downloaded artifact staging could not be removed; recovery and switch staging were retained'
                    : 'oc2 native update rolled back, but downloaded artifact staging could not be removed';
            await cleanupOc2Operation(prepared.cleanup, warning, adapters.report ?? (message => process.stderr.write(message + '\n')));
        }
        return prepared.executable;
    } finally { if (safeToRelease) await guard.release(); }
}

export async function cleanupCommittedOc2CodeRefresh(cleanup: () => Promise<void>, report: (message: string) => void = message => process.stderr.write(message + '\n')): Promise<{ warning?: string }> {
    const warning = 'oc2 code refresh committed successfully, but its old-code staging directory could not be removed; the active generation was not rolled back';
    let failed = false;
    await cleanupOc2Operation(async () => { try { await cleanup(); } catch (error) { failed = true; throw error; } }, warning, report);
    return failed ? { warning } : {};
}

async function applyOc2CodeRefresh(options: CodeRefreshOptions, requireInstalledPin: boolean, adapters: CodeRefreshAdapters = {}): Promise<void> {
    if (!isAbsolute(options.previewCli) || !isAbsolute(options.root)) throw new Error('previewCli and root must be absolute paths');
    if (process.versions.node.split('.')[0] !== '24') throw new Error('Run the oc2 code refresher with Node 24');
    const previewCli = await validateOc2UpdaterBuild(options.previewCli), sourceTools = dirname(previewCli);
    const guard = await acquirePreviewUpdateGuard(options.root); let retainRecovery = false;
    try {
        const host = await loadUpdateHost(options.root); if (requireInstalledPin) await validateInstalledPin(host); await assertPreviewStopped(host, guard.token);
        const tools = join(options.root, 'lib', 'tools'), launcher = join(options.root, 'naru-preview');
        await regularOwnedFile(launcher, 'preview launcher');
        const stage = join(options.root, `.oc2-code-refresh-${process.pid}-${randomBytes(6).toString('hex')}`);
        const stagedTools = join(stage, 'new-tools'), oldTools = join(stage, 'old-tools'), deployedTools = join(stage, 'deployed-tools');
        const disabledLauncher = join(stage, 'naru-preview'), deployedLauncher = join(stage, 'deployed-naru-preview');
        await mkdir(stage, { mode: 0o700 });
        let launcherDisabled = false, toolsMoved = false, toolsInstalled = false;
        try {
            await cp(sourceTools, stagedTools, { recursive: true });
            await cp(tools, oldTools, { recursive: true }); await cp(launcher, disabledLauncher);
            if (await hashTree(sourceTools) !== await hashTree(stagedTools) || await hashTree(tools) !== await hashTree(oldTools)
                || !(await readFile(launcher)).equals(await readFile(disabledLauncher))) throw new Error('Code refresh staging validation failed');
            await guard.setPhase({ phase: 'pre-switch', recoveryPath: stage, backupPaths: { tools: oldTools, launcher: disabledLauncher }, validatedBackups: true });
            await guard.setPhase({ phase: 'switching', recoveryPath: stage, backupPaths: { tools: oldTools, launcher: disabledLauncher }, validatedBackups: true });
            await adapters.beforeFirstRename?.();
            await assertPreviewStopped(host, guard.token);
            await rename(launcher, deployedLauncher); launcherDisabled = true;
            await rename(tools, deployedTools); toolsMoved = true;
            await rename(stagedTools, tools); toolsInstalled = true;
            await rename(deployedLauncher, launcher); launcherDisabled = false;
            await guard.setPhase({ phase: 'complete', recoveryPath: stage, backupPaths: { tools: oldTools, launcher: disabledLauncher }, validatedBackups: true });
        } catch (error) {
            try {
                if (toolsInstalled) await rm(tools, { recursive: true, force: true });
                if (toolsMoved) await rename(deployedTools, tools);
                if (launcherDisabled) await rename(deployedLauncher, launcher);
                await rm(stage, { recursive: true, force: true });
            } catch { retainRecovery = true; throw new IndeterminateUpdateError(error); }
            throw new RolledBackUpdateError(error);
        }
        await cleanupCommittedOc2CodeRefresh(() => rm(stage, { recursive: true }));
    } catch (error) {
        if (error instanceof RolledBackUpdateError) throw error.original;
        throw error;
    } finally { if (!retainRecovery) await guard.release(); }
}
export function applyPreparedOc2CodeRefresh(options: CodeRefreshOptions, adapters: CodeRefreshAdapters = {}): Promise<void> { return applyOc2CodeRefresh(options, false, adapters); }
export function refreshOc2Code(options: CodeRefreshOptions): Promise<void> { return applyOc2CodeRefresh(options, true); }

export async function installOc2(options: InstallOptions): Promise<void> {
    const node = await realpath(options.node ?? process.execPath);
    for (const [label, value] of [['previewCli', options.previewCli], ['opencode', options.opencode], ['v2Wrapper', options.v2Wrapper], ['root', options.root], ['bin', options.bin]] as const) {
        if (!isAbsolute(value)) throw new Error(`${label} must be an absolute path`);
    }
    await absent(options.root, 'preview install root');
    await absent(options.bin, 'oc2 launcher');
    const previewCli = await realpath(options.previewCli);
    const opencode = await realpath(options.opencode);
    const v2Wrapper = await realpath(options.v2Wrapper);
    if (opencode === v2Wrapper) throw new Error('oc2 must target the isolated v2 wrapper, not the raw binary');
    const wrapperInfo = await lstat(options.v2Wrapper);
    if (wrapperInfo.isSymbolicLink() || !wrapperInfo.isFile()) throw new Error('v2 wrapper must be a regular file, not a symlink');
    await access(v2Wrapper, constants.X_OK);
    await mkdir(options.root, { mode: 0o700 });
    let installed = false;
    try {
        await runSetup(node, previewCli, options.root, opencode);
        const launcherModule = join(options.root, 'lib', 'tools', 'oc2.mjs');
        const preview = join(options.root, 'naru-preview');
        await access(launcherModule, constants.R_OK);
        await access(preview, constants.X_OK);
        await updateOc2NativeProfile(options.root);
        const script = `#!/bin/sh\nset -eu\nexport NARU_OC2_ROOT=${quote(options.root)}\nexport NARU_OC2_LEGACY=${quote(preview)}\nexec ${quote(node)} ${quote(launcherModule)} "$@"\n`;
        await writeFile(options.bin, script, { flag: 'wx', mode: 0o755 });
        installed = true;
    }
    finally {
        if (!installed) {
            await rm(options.root, { recursive: true, force: true });
        }
    }
}

function required(args: string[], name: string): string {
    const index = args.indexOf(name);
    if (index < 0 || !args[index + 1] || args[index + 1]!.startsWith('--')) throw new Error(`${name} requires a value`);
    return resolve(args.splice(index, 2)[1]!);
}

export type Oc2InstallerAction =
    | { action: 'install-agent' }
    | { action: 'cleanup-agent'; profileConfig: string }
    | { action: 'setup-native'; root: string }
    | { action: 'refresh-code'; previewCli: string; root: string }
    | { action: 'update'; previewCli: string; v2Wrapper: string; root: string; nativeRoot: string }
    | { action: 'install'; previewCli: string; opencode: string; v2Wrapper: string; root: string; bin: string };

export function parseOc2InstallerArguments(values: string[]): Oc2InstallerAction {
    const args = [...values];
    const actions = [
        ['--install-agent', 'install-agent'], ['--cleanup-agent', 'cleanup-agent'], ['--setup-native', 'setup-native'], ['--refresh-code', 'refresh-code'], ['--update', 'update'],
    ] as const;
    const selected = actions.filter(([flag]) => args.includes(flag));
    if (selected.length > 1) throw new Error('--install-agent, --cleanup-agent, --setup-native, --update, and --refresh-code are mutually exclusive');
    const action = selected[0]?.[1] ?? 'install';
    if (selected[0]) args.splice(args.indexOf(selected[0][0]), 1);
    if (action === 'install-agent') {
        if (args.length) throw new Error(`unknown retired agent installer arguments: ${args.join(' ')}`);
        const result = { action } as const;
        return result;
    }
    if (action === 'cleanup-agent') {
        const result = { action, profileConfig: required(args, '--profile-config') } as const;
        if (args.length) throw new Error(`unknown agent cleanup arguments: ${args.join(' ')}`);
        return result;
    }
    if (action === 'setup-native') {
        const result = { action, root: required(args, '--root') } as const;
        if (args.length) throw new Error(`unknown native setup arguments: ${args.join(' ')}`);
        return result;
    }
    if (action === 'refresh-code') {
        const result = { action, previewCli: required(args, '--preview-cli'), root: required(args, '--root') } as const;
        if (args.length) throw new Error(`unknown code refresh arguments: ${args.join(' ')}`);
        return result;
    }
    if (action === 'update') {
        const result = { action, previewCli: required(args, '--preview-cli'), v2Wrapper: required(args, '--v2-wrapper'), root: required(args, '--root'), nativeRoot: required(args, '--native-root') } as const;
        if (args.length) throw new Error(`unknown updater arguments: ${args.join(' ')}`);
        return result;
    }
    const result = {
        action, previewCli: required(args, '--preview-cli'), opencode: required(args, '--opencode'),
        v2Wrapper: required(args, '--v2-wrapper'), root: required(args, '--root'), bin: required(args, '--bin'),
    } as const;
    if (args.length) throw new Error(`unknown installer arguments: ${args.join(' ')}`);
    return result;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
    const options = parseOc2InstallerArguments(process.argv.slice(2));
    if (options.action === 'install-agent') {
        process.stderr.write('install-oc2: --install-agent is retired. OC2 now projects native agents into its dedicated profile. Use --setup-native --root PATH after a guarded code refresh; remove an exact legacy static profile entry with --cleanup-agent --profile-config PATH.\n');
        process.exitCode = 1;
    } else if (options.action === 'cleanup-agent') {
        cleanupLegacyStandaloneNaruAgent(options.profileConfig)
            .then(result => console.log(`${result.changed ? 'Removed exact legacy' : 'No exact legacy'} standalone Naru agent in ${options.profileConfig}`))
            .catch(error => { process.stderr.write(`install-oc2: ${error instanceof Error ? error.message : 'failed'}\n`); process.exitCode = 1; });
    } else if (options.action === 'setup-native') {
        updateOc2NativeProfile(options.root)
            .then(profile => console.log(`Prepared OC2 native profile at ${options.root} with ${profile.models.length} imported global model${profile.models.length === 1 ? '' : 's'}; active services were not restarted`))
            .catch(error => { process.stderr.write(`install-oc2: ${error instanceof Error ? error.message : 'failed'}\n`); process.exitCode = 1; });
    } else if (options.action === 'refresh-code') {
        refreshOc2Code(options)
            .then(() => console.log(`Refreshed oc2 preview code at ${options.root}; native ${OC2_UPDATE_RELEASE.version}, login data, and repository policy were preserved`))
            .catch(error => { process.stderr.write(`install-oc2: ${error instanceof Error ? error.message : 'failed'}\n`); process.exitCode = 1; });
    } else if (options.action === 'update') {
        updateOc2(options)
            .then(executable => console.log(`Updated oc2 preview to ${OC2_UPDATE_RELEASE.version} at ${executable}; existing preview state was preserved`))
            .catch(error => { process.stderr.write(`install-oc2: ${error instanceof Error ? error.message : 'failed'}\n`); process.exitCode = 1; });
    } else {
        installOc2(options)
            .then(() => console.log(`Installed oc2 launcher at ${options.bin} with a fresh Naru preview at ${options.root}`))
            .catch(error => { process.stderr.write(`install-oc2: ${error instanceof Error ? error.message : 'failed'}\n`); process.exitCode = 1; });
    }
}
