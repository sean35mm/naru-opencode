import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { loadOc2NativeModelProfile, NativeProfileRecoveryRequiredError, removeOc2NativeRegistration, updateOc2NativeProfile, type NativeConfigAdapters, type NativeRemovalPlan } from './oc2-native-config.mjs';
import { evaluateOpenCodeVersion } from './compatibility.mjs';
import type { Oc2NativePaths } from './oc2-profile.mjs';

const run = promisify(execFile);
export function getNativeInstallPaths(configRoot: string) {
    if (!isAbsolute(configRoot) || configRoot === '/') throw new Error('Native config root must be an absolute non-root directory');
    const packageRoot = join(configRoot, '.naru-native', 'package');
    const state = join(configRoot, '.naru-native');
    return { configRoot, packageRoot, configPath: join(configRoot, 'opencode.json'), profilePath: join(state, 'profile.json'), ownershipPath: join(state, 'ownership.json'), manifestPath: join(state, 'manifest.json'), state };
}
export function defaultNativeConfigRoot(env: NodeJS.ProcessEnv = process.env): string {
    return join(env.XDG_CONFIG_HOME ? resolve(env.XDG_CONFIG_HOME) : join(env.HOME ?? homedir(), '.config'), 'opencode');
}
function profilePaths(configRoot: string): Oc2NativePaths {
    const paths = getNativeInstallPaths(configRoot), state = paths.state;
    return { root: configRoot, configRoot, configDirectory: configRoot, configFile: paths.configPath, dataRoot: '', cacheRoot: '', stateRoot: state, database: '', profileState: paths.profilePath, ownership: paths.ownershipPath, lock: join(state, '.native-profile.lock'), transaction: join(state, '.native-profile-transaction') };
}
async function safeDirectory(path: string, privateMode = false): Promise<boolean> {
    try {
        const stat = await lstat(path);
        if (!stat.isDirectory() || stat.isSymbolicLink() || process.getuid && stat.uid !== process.getuid() || stat.mode & 0o022 || privateMode && stat.mode & 0o077) throw new Error(`Unsafe native install directory: ${path}`);
        return true;
    } catch (error) { if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return false; throw error; }
}
async function regular(path: string): Promise<boolean> {
    try {
        const stat = await lstat(path);
        if (!stat.isFile() || stat.isSymbolicLink() || process.getuid && stat.uid !== process.getuid() || stat.mode & 0o022) throw new Error(`Unsafe native install file: ${path}`);
        return true;
    } catch (error) { if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return false; throw error; }
}
async function occupied(path: string): Promise<boolean> {
    try { await lstat(path); return true; }
    catch (error) { if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return false; throw error; }
}
function digest(bytes: Buffer): string { return createHash('sha256').update(bytes).digest('hex'); }
async function inventory(root: string): Promise<Record<string, string>> {
    const files: Record<string, string> = {};
    async function visit(directory: string, prefix: string) {
        for (const item of await readdir(directory, { withFileTypes: true })) {
            const relative = prefix ? `${prefix}/${item.name}` : item.name, path = join(directory, item.name);
            if (item.isDirectory() && !item.isSymbolicLink()) await visit(path, relative);
            else if (item.isFile() && !item.isSymbolicLink()) files[relative] = digest(await readFile(path));
            else throw new Error(`Package contains an unsafe entry: ${relative}`);
        }
    }
    await visit(root, '');
    return files;
}
async function verifyNativePackage(paths: ReturnType<typeof getNativeInstallPaths>): Promise<boolean> {
    if (!await safeDirectory(paths.packageRoot)) {
        if (await occupied(paths.manifestPath)) throw new Error('Native package is missing but ownership manifest exists');
        return false;
    }
    if (!await regular(paths.manifestPath)) throw new Error('Native package exists without ownership manifest');
    const prior = JSON.parse(await readFile(paths.manifestPath, 'utf8')) as { schemaVersion?: number; files?: Record<string, string> };
    if (prior.schemaVersion !== 1 || !prior.files || JSON.stringify(await inventory(paths.packageRoot)) !== JSON.stringify(prior.files)) throw new Error('Naru-owned package was modified; refusing to overwrite it');
    return true;
}
export async function validateNativeExecutable(executable: string): Promise<string> {
    if (executable === 'opencode') return executable;
    if (!isAbsolute(executable) || executable.includes('\0')) throw new Error('--opencode requires an absolute executable path');
    let info;
    try { info = await lstat(executable); }
    catch { throw new Error(`--opencode executable does not exist: ${executable}`); }
    if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o111) === 0 || (info.mode & 0o022) !== 0) throw new Error('--opencode must name an executable regular file, not a symlink or writable by others');
    return executable;
}
export async function verifyNativeHostVersion(executable = 'opencode'): Promise<void> {
    let output: string;
    const selected = await validateNativeExecutable(executable);
    const temporary = await mkdtemp(join(tmpdir(), 'naru-native-version-'));
    try {
        const env = {
            PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: temporary,
            XDG_CONFIG_HOME: join(temporary, 'config'), XDG_DATA_HOME: join(temporary, 'data'),
            XDG_CACHE_HOME: join(temporary, 'cache'), XDG_STATE_HOME: join(temporary, 'state'),
            TMPDIR: temporary, TMP: temporary, TEMP: temporary, OPENCODE_DB: join(temporary, 'opencode.db'),
            OPENCODE_DISABLE_AUTOUPDATE: 'true', OPENCODE_DISABLE_MODELS_FETCH: 'true', OPENCODE_DISABLE_PROJECT_CONFIG: 'true',
            LANG: 'C',
        };
        try { output = (await run(selected, ['--version'], { cwd: temporary, env, timeout: 10_000 })).stdout.trim(); }
        catch { throw new Error(`Native install requires OpenCode 2.0.15 at ${selected}; no host binary is installed by Naru`); }
    } finally { await rm(temporary, { recursive: true, force: true }); }
    const version = evaluateOpenCodeVersion('native-v2', output);
    if (version.status !== 'supported' && version.status !== 'candidate') throw new Error(`Native install requires OpenCode 2.0.15 or a newer 2.0.x patch release; found ${version.observed ?? 'unknown'}.`);
}
export async function inspectNativeInstall(configRoot: string): Promise<{ installed: boolean; models: string[] }> {
    const paths = getNativeInstallPaths(configRoot);
    if (!await safeDirectory(configRoot)) return { installed: false, models: [] };
    if (!await safeDirectory(paths.state, true)) return { installed: false, models: [] };
    const profile = await loadOc2NativeModelProfile(configRoot, profilePaths(configRoot));
    return { installed: !!profile, models: profile?.models ?? [] };
}
export async function installNative(configRoot: string, sourceRoot: string, apply: boolean, models?: readonly string[], transactionAdapters: Pick<NativeConfigAdapters, 'afterCommitFile'> = {}, executable = 'opencode'): Promise<string> {
    const paths = getNativeInstallPaths(configRoot), nativePaths = profilePaths(configRoot);
    await verifyNativeHostVersion(executable);
    if (await safeDirectory(configRoot)) {
        for (const directory of ['commands', 'command', 'plugins', 'agents']) await safeDirectory(join(configRoot, directory));
        for (const name of ['opencode.jsonc', 'commands/naru', 'commands/naru.md', 'command/naru', 'command/naru.md', 'plugins/naru-dispatch.js', 'agents/naru', 'agents/naru.md', 'agents/naru-orchestrator.md']) if (await occupied(join(configRoot, name))) throw new Error(`Existing configuration or v1 asset requires explicit manual cutover: ${name}`);
        if (await regular(join(configRoot, '.naru-install.json'))) throw new Error('Existing v1 install requires explicit manual cutover; native install did not modify it');
        if (await regular(paths.configPath)) {
            let config: unknown;
            try { config = JSON.parse(await readFile(paths.configPath, 'utf8')); }
            catch { throw new Error('Normal OpenCode config must be strict JSON; JSONC cannot be rewritten without losing comments'); }
            if (config && typeof config === 'object' && !Array.isArray(config)) {
                const settings = config as Record<string, unknown>, plugins = settings.plugins;
                if (Array.isArray(plugins) && plugins.some(value => typeof value === 'string' && /(?:^|\/)naru-dispatch(?:\.|\/|$)/.test(value))) throw new Error('Existing v1 dispatch plugin requires explicit manual cutover');
                for (const key of ['command', 'commands']) {
                    const definitions = settings[key];
                    if (definitions === undefined) continue;
                    if (!definitions || typeof definitions !== 'object' || Array.isArray(definitions) || Object.hasOwn(definitions, 'naru')) throw new Error(`Existing ${key}.naru command configuration is ambiguous; native install will not replace it`);
                }
            }
        }
    }
    if (await safeDirectory(paths.state, true)) await verifyNativePackage(paths);
    const adapters = { nativePaths, nativeAssetRoot: paths.packageRoot, home: process.env.HOME ?? homedir() };
    await updateOc2NativeProfile(configRoot, models, { ...adapters, preview: true });
    const sourceTools = join(sourceRoot, 'tools');
    if (!await safeDirectory(sourceTools)) throw new Error(`Missing compiled Naru tools: ${sourceTools}`);
    if (!await regular(join(sourceTools, 'oc2-native-plugin', 'index.mjs')) || !await regular(join(sourceTools, 'naru-lib', 'oc2-native-config.mjs'))) throw new Error('Native install requires the compiled release; build it first');
    if (!apply) return `Native install preview: ${configRoot}\n  package: ${paths.packageRoot}\n  register: naru agents, plugin and skills; preserve unrelated config\nPreview only; no files changed. Rerun with --apply.`;
    // Stage assets on the destination filesystem, then publish them before registration.
    await mkdir(configRoot, { recursive: true });
    if (!await safeDirectory(paths.state, true)) await mkdir(paths.state, { mode: 0o700 });
    const staged = join(paths.state, `package-staging-${process.pid}`), backup = join(paths.state, `package-backup-${process.pid}`);
    if (await safeDirectory(staged) || await safeDirectory(backup)) throw new Error('Native package staging path already exists');
    let published = false, backedUp = false;
    const oldManifest = await regular(paths.manifestPath) ? await readFile(paths.manifestPath) : null;
    try {
        await mkdir(staged, { mode: 0o700 });
        await cp(sourceTools, join(staged, 'tools'), { recursive: true });
        await cp(join(sourceRoot, 'commands', 'naru.md'), join(staged, 'tools', 'oc2-native-plugin', 'command.md'));
        const files = await inventory(staged);
        if (await safeDirectory(paths.packageRoot)) { await rename(paths.packageRoot, backup); backedUp = true; }
        await rename(staged, paths.packageRoot); published = true;
        await writeFile(paths.manifestPath, JSON.stringify({ schemaVersion: 1, files }, null, 2) + '\n', { mode: 0o600 });
        await updateOc2NativeProfile(configRoot, models, { ...adapters, ...transactionAdapters });
        if (backedUp) await rm(backup, { recursive: true });
        return `Installed native Naru in ${configRoot}. Restart OpenCode to load updated agents and plugin.`;
    } catch (error) {
        if (error instanceof NativeProfileRecoveryRequiredError) throw new Error(`Native installation is indeterminate: ${error.message}. Keep ${paths.packageRoot}, ${paths.manifestPath}${backedUp ? `, and ${backup}` : ''}; inspect the profile, config, and recovery state before retrying.`, { cause: error });
        if (published) await rm(paths.packageRoot, { recursive: true });
        if (backedUp) await rename(backup, paths.packageRoot);
        if (oldManifest) await writeFile(paths.manifestPath, oldManifest);
        else await rm(paths.manifestPath, { force: true });
        throw error;
    } finally { await rm(staged, { recursive: true, force: true }); }
}
export async function nativeModels(configRoot: string, models?: readonly string[], expectedModels?: readonly string[] | null, executable = 'opencode'): Promise<string[]> {
    const paths = getNativeInstallPaths(configRoot);
    if (!await safeDirectory(configRoot) || !await safeDirectory(paths.state, true) || !await regular(paths.manifestPath) || !await safeDirectory(paths.packageRoot)) throw new Error('Install native Naru before configuring models');
    if (models === undefined) return (await loadOc2NativeModelProfile(configRoot, profilePaths(configRoot)))?.models ?? [];
    await verifyNativePackage(paths);
    if (await regular(join(configRoot, 'opencode.jsonc'))) throw new Error('Ambiguous OpenCode JSON and JSONC configuration; refusing to change native workers');
    await verifyNativeHostVersion(executable);
    return (await updateOc2NativeProfile(configRoot, models, { nativePaths: profilePaths(configRoot), nativeAssetRoot: paths.packageRoot, ...(expectedModels !== undefined ? { expectedModels } : {}) })).models;
}

// v1 files the native uninstall reports but never removes (0.9.0 `naru uninstall --legacy` owns them).
const V1_ASSETS = ['.naru-install.json', 'agents/naru.md', 'agents/naru-orchestrator.md', 'commands/naru.md', 'plugins/naru-dispatch.js'];
const STATE_ENTRIES = new Set(['package', 'manifest.json', 'ownership.json', 'profile.json']);
async function uninstallableState(state: string, allowTransaction: boolean): Promise<void> {
    // Lock and transaction files are handled by the shared locked write path; anything else is not ours to delete.
    const unexpected = (await readdir(state)).filter(name => !STATE_ENTRIES.has(name) && !(allowTransaction && name.startsWith('.native-profile')));
    if (unexpected.length) throw new Error(`${state} contains unexpected entries (${unexpected.sort().join(', ')}); resolve them before uninstalling. No files were removed.`);
}
function describeRemoval(plan: NativeRemovalPlan, state: string, done: boolean): string {
    const verb = (present: string, past: string) => done ? past : present;
    const lines: Array<[string, string[]]> = [
        [`${verb('remove', 'removed')} agents`, plan.removedAgents],
        [`${verb('keep', 'kept')} agents edited since install (now yours; Naru refuses to overwrite them if it needs the name again)`, plan.keptAgents],
        ['agents already absent', plan.absentAgents],
        [`${verb('remove', 'removed')} plugins entries`, plan.removedPlugins],
        [`${verb('remove', 'removed')} skills entries`, plan.removedSkills],
    ];
    return [...lines.filter(([, names]) => names.length).map(([label, names]) => `  ${label}: ${names.join(', ')}`),
        `  ${verb('delete', 'deleted')}: ${state} (package, profile, ownership, manifest)`,
        '  keep: every other opencode.json setting, and the naru command itself'].join('\n');
}
export async function uninstallNative(configRoot: string, apply: boolean, env: NodeJS.ProcessEnv = process.env): Promise<{ installed: boolean; text: string }> {
    const paths = getNativeInstallPaths(configRoot);
    const rootExists = await safeDirectory(configRoot);
    const v1: string[] = [];
    if (rootExists) for (const name of V1_ASSETS) if (await occupied(join(configRoot, name))) v1.push(name);
    const v1Note = v1.length ? `Naru v1 files remain (${v1.join(', ')}). Native uninstall does not remove them: run naru uninstall --legacy from Naru 0.9.0, or delete them by hand.` : '';
    if (!rootExists || !await safeDirectory(paths.state, true)) {
        if (await regular(paths.configPath) && (await readFile(paths.configPath, 'utf8')).includes(JSON.stringify(paths.packageRoot).slice(1, -1))) throw new Error(`${paths.state} is missing but opencode.json still references ${paths.packageRoot}; remove those plugins/skills entries and the naru agents by hand. No files were changed.`);
        if (v1.length) throw new Error(`Native Naru is not installed in ${configRoot}. ${v1Note} No files were changed.`);
        return { installed: false, text: `Native Naru is not installed in ${configRoot}. Nothing to remove; no files were changed.` };
    }
    await uninstallableState(paths.state, true);
    if (!await verifyNativePackage(paths) || !await regular(paths.ownershipPath) || !await regular(paths.profilePath)) throw new Error(`Native install in ${paths.state} is incomplete (package, manifest, ownership, or profile missing); refusing to guess what to remove. No files were changed.`);
    const plan = await removeOc2NativeRegistration({ nativePaths: profilePaths(configRoot), nativeAssetRoot: paths.packageRoot, preview: !apply });
    const footer = v1Note ? `\n${v1Note}` : '';
    if (!apply) return { installed: true, text: `Native uninstall preview: ${configRoot}\n${describeRemoval(plan, paths.state, false)}\nPreview only; no files changed. Rerun with --apply.${footer}` };
    await uninstallableState(paths.state, false);
    // Rename first so the state directory disappears atomically; a failed rm leaves only an inert sibling.
    // ponytail: the profile lock is released before this rename; a concurrent naru install in that window could re-register agents.
    const removing = join(configRoot, `.naru-native.removing-${process.pid}`);
    await rename(paths.state, removing);
    try { await rm(removing, { recursive: true }); }
    catch (error) { throw new Error(`opencode.json no longer references Naru, but ${removing} could not be deleted; delete it by hand`, { cause: error }); }
    const naruHome = env.NARU_HOME ?? join(env.HOME ?? homedir(), '.naru');
    return { installed: true, text: `Removed native Naru from ${configRoot}. Restart OpenCode to unload it.\n${describeRemoval(plan, paths.state, true)}\nThe naru command is still installed. To remove it, delete ${naruHome} and remove ${join(naruHome, 'bin')} from PATH.${footer}` };
}
