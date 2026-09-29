#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { constants as fsConstants } from 'node:fs';
import { chmod, lstat, mkdir, mkdtemp, open, realpath, symlink, writeFile, } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCompatibilityEvidence, evaluateOpenCodeVersion, evaluatePlatformTarget, isCompatibilityProfile, sanitizeObservedVersion, } from '../tools/naru-lib/compatibility.mjs';
import type { CompatibilityCheck, CompatibilityEvidence, CompatibilityProfile } from '../tools/naru-lib/compatibility.mjs';
import { guardedRemoveDisposableRoot, PROCESS_TIMEOUT_MS, runBoundedProcess } from '../tools/naru-lib/bounded-process.mjs';
import { startHostServer } from '../tools/naru-lib/host-process.mjs';
import { projectOc2NativeAgents } from '../tools/naru-lib/oc2-native-projection.mjs';
export { runBoundedProcess } from '../tools/naru-lib/bounded-process.mjs';

interface CompatibilityCliOptions {
    help?: boolean;
    json: boolean;
    opencodePath: string | null;
    output: string | null;
    profile: CompatibilityProfile | null;
    sourcePath: string | null;
}
interface PlatformEvidence { platform?: unknown; arch?: unknown; osId?: unknown; wsl?: unknown }
export interface CompatibilitySmokeOptions {
    opencodePath: string;
    profile: CompatibilityProfile;
    sourcePath: string;
    timeoutMs?: number;
    platformEvidence?: PlatformEvidence;
}
interface CompatibilitySmokeHooks { onDisposableRoot?(root: string): void }
interface CommandResult { durationMs: number; status: 'passed' | 'failed'; reason: string | null }
interface SafeCommand {
    id: string;
    args: readonly string[];
    maxOutputBytes?: number;
    retainOutput?: boolean;
}

function errorCode(error: unknown): string | undefined {
    return error instanceof Error && 'code' in error && typeof error.code === 'string' ? error.code : undefined;
}
function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : 'unknown error';
}
function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}
const DEFAULT_TIMEOUT_MS = PROCESS_TIMEOUT_MS;
const MAX_AGENT_LIST_OUTPUT_BYTES = 1024 * 1024;
const CONFIG_MAX_BYTES = 64 * 1024;
export const OPENCODE_SAFE_COMMANDS: readonly SafeCommand[] = Object.freeze([
    Object.freeze({ id: 'opencode-version', args: Object.freeze(['--version']) }),
]);
function usage() {
    return 'Usage: node scripts/naru-compat-smoke.mjs --profile native-v2 --opencode PATH --source PATH [--json] [--output PATH]\n';
}
function parseArgs(argv: string[]): CompatibilityCliOptions {
    const options: CompatibilityCliOptions = { json: false, opencodePath: null, output: null, profile: null, sourcePath: null };
    for (let index = 0; index < argv.length; index += 1) {
        const argument = argv[index];
        if (argument === undefined)
            throw new Error('unknown option');
        if (argument === '--json')
            options.json = true;
        else if (['--opencode', '--source', '--output', '--profile'].includes(argument)) {
            const value = argv[index + 1];
            if (value === undefined || value.startsWith('-'))
                throw new Error(`${argument} requires a value`);
            index += 1;
            if (argument === '--opencode')
                options.opencodePath = value;
            else if (argument === '--source')
                options.sourcePath = value;
            else if (argument === '--output')
                options.output = value;
            else if (argument === '--profile') {
                if (!isCompatibilityProfile(value))
                    throw new Error(`unknown compatibility profile: ${value}`);
                options.profile = value;
            }
        }
        else if (argument === '--help' || argument === '-h')
            options.help = true;
        else
            throw new Error(`unknown option: ${argument}`);
    }
    if (!options.help && (!options.profile || !options.opencodePath || !options.sourcePath))
        throw new Error('--profile, --opencode, and --source are required');
    return options;
}
async function executablePath(value: string, label: string): Promise<string> {
    if (typeof value !== 'string' || value.length === 0 || value.length > 4096 || /[\u0000-\u001f\u007f]/.test(value)) {
        throw new Error(`${label} path is invalid`);
    }
    const resolved = await realpath(path.resolve(value));
    const stats = await lstat(resolved);
    if (!stats.isFile() || (stats.mode & 0o111) === 0)
        throw new Error(`${label} must be an executable file`);
    return resolved;
}
async function sourceRoot(value: string): Promise<string> {
    if (typeof value !== 'string' || value.length === 0 || value.length > 4096 || /[\u0000-\u001f\u007f]/.test(value)) {
        throw new Error('source path is invalid');
    }
    const resolved = await realpath(path.resolve(value));
    const stats = await lstat(resolved);
    if (!stats.isDirectory())
        throw new Error('source must be a directory');
    const installer = await lstat(path.join(resolved, 'install.sh'));
    if (!installer.isFile() || installer.isSymbolicLink())
        throw new Error('source install.sh must be a regular file');
    return resolved;
}
function validateTimeout(value: unknown): number {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 50 || value > 30_000) {
        throw new Error('timeout must be from 50 to 30000 milliseconds');
    }
    return value;
}
function isolatedEnvironment(root: string, privateBin: string): NodeJS.ProcessEnv & Record<string, string> {
    const home = path.join(root, 'home');
    const tmp = path.join(root, 'tmp');
    return {
        BUN_INSTALL_CACHE_DIR: path.join(root, 'cache', 'bun'),
        CI: '1',
        GH_CONFIG_DIR: path.join(root, 'config', 'gh'),
        HOME: home,
        LANG: 'C',
        LC_ALL: 'C',
        NO_COLOR: '1',
        OPENCODE_DB: path.join(root, 'state', 'opencode.db'),
        OPENCODE_DISABLE_AUTOUPDATE: 'true',
        PATH: [privateBin, path.dirname(process.execPath), '/usr/bin', '/bin'].join(path.delimiter),
        TEMP: tmp,
        TERM: 'dumb',
        TMP: tmp,
        TMPDIR: tmp,
        XDG_CACHE_HOME: path.join(root, 'cache'),
        XDG_CONFIG_HOME: path.join(home, '.config'),
        XDG_DATA_HOME: path.join(root, 'data'),
        XDG_STATE_HOME: path.join(root, 'state'),
    };
}
function commandCheck(id: string, result: CommandResult): CompatibilityCheck {
    return {
        id,
        status: result.status,
        durationMs: result.durationMs,
        diagnostic: result.status === 'passed' ? null : `${id}-${result.reason ?? 'failed'}`,
    };
}
async function boundedJson(file: string): Promise<unknown> {
    const stats = await lstat(file);
    if (!stats.isFile() || stats.isSymbolicLink() || stats.size > CONFIG_MAX_BYTES)
        throw new Error('unsafe generated config');
    const handle = await open(file, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    try {
        const opened = await handle.stat();
        if (!opened.isFile() || opened.size > CONFIG_MAX_BYTES)
            throw new Error('unsafe generated config');
        return JSON.parse(await handle.readFile('utf8'));
    }
    finally {
        await handle.close();
    }
}
async function linuxIdentity(): Promise<{ osId: string | null; wsl: boolean }> {
    if (process.platform !== 'linux')
        return { osId: null, wsl: false };
    try {
        const resolved = await realpath('/etc/os-release');
        if (!['/etc/os-release', '/usr/lib/os-release'].includes(resolved))
            return { osId: null, wsl: false };
        const stats = await lstat(resolved);
        if (!stats.isFile() || stats.size > 16 * 1024)
            return { osId: null, wsl: false };
        const handle = await open(resolved, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
        let source;
        try {
            source = await handle.readFile('utf8');
        }
        finally {
            await handle.close();
        }
        const id = source.match(/^ID=([A-Za-z0-9._-]+)$/m)?.[1]?.toLowerCase() ?? null;
        const wsl = /microsoft/i.test(os.release());
        return { osId: id, wsl };
    }
    catch {
        return { osId: null, wsl: /microsoft/i.test(os.release()) };
    }
}
type NativeApiRoute = '/api/config' | '/api/agent' | '/api/plugin' | '/api/skill' | '/api/command';
const NATIVE_FIXTURE_WORKER = 'fixture/worker#high';
const NATIVE_FIXTURE_MODEL = { providerID: 'fixture', model: 'worker', variant: 'high' };
const NATIVE_HOST_MODEL = { providerID: 'fixture', id: 'worker', variant: 'high' };
const NATIVE_WORKER_NAME = projectOc2NativeAgents([NATIVE_FIXTURE_WORKER]).workers[0]!.name;
export function nativeWorkerPoolValid(models: readonly string[], agents: Record<string, unknown>, owned: Record<string, unknown>): boolean {
    const worker = agents[NATIVE_WORKER_NAME];
    return models.length === 1 && models[0] === NATIVE_FIXTURE_WORKER && isRecord(worker) && worker.mode === 'subagent'
        && JSON.stringify(worker.model) === JSON.stringify(NATIVE_FIXTURE_MODEL) && JSON.stringify(worker) === JSON.stringify(owned[NATIVE_WORKER_NAME]);
}
export async function checkNativeHostRoutes(url: string, headers: Record<string, string>, cwd: string, configPath: string, pluginPath: string, workers: readonly { name: string; model: { providerID: string; id: string; variant: string } }[], timeoutMs: number): Promise<CompatibilityCheck[]> {
    const routes: Array<{ id: string; route: NativeApiRoute; validate: (body: unknown) => boolean }> = [
        { id: 'native-config-source', route: '/api/config', validate: body => Array.isArray(body) && body.some(entry => isRecord(entry) && entry.path === configPath) },
        { id: 'native-host-agents', route: '/api/agent', validate: body => {
            const data = isRecord(body) ? body.data : undefined;
            return workers.length > 0 && Array.isArray(data) && workers.every(worker => data.some((entry: unknown) => isRecord(entry) && entry.id === worker.name && isRecord(entry.model)
                && entry.model.providerID === worker.model.providerID && entry.model.id === worker.model.id && entry.model.variant === worker.model.variant))
                && data.some((entry: unknown) => isRecord(entry) && entry.id === 'naru' && !Object.hasOwn(entry, 'model'));
        } },
        { id: 'native-host-plugin', route: '/api/plugin', validate: body => isRecord(body) && Array.isArray(body.data) && body.data.some((entry: unknown) => {
            if (!isRecord(entry)) return false;
            return isRecord(entry.source) && entry.source.type === 'local' && entry.source.path === path.join(pluginPath, 'index.mjs')
                && isRecord(entry.state) && entry.state.status === 'active';
        }) },
        { id: 'native-host-skills', route: '/api/skill', validate: body => isRecord(body) && Array.isArray(body.data) && body.data.some((entry: unknown) => isRecord(entry) && (entry.name === 'naru-coordinate' || entry.id === 'naru-coordinate')) },
        { id: 'native-host-command', route: '/api/command', validate: body => isRecord(body) && Array.isArray(body.data) && body.data.some((entry: unknown) => isRecord(entry) && entry.name === 'naru') },
    ];
    const checks: CompatibilityCheck[] = [];
    for (const { id, route, validate } of routes) {
        const started = Date.now();
        let diagnostic: string | null = null;
        try {
            const response = await fetch(`${url}${route}?location%5Bdirectory%5D=${encodeURIComponent(cwd)}`, { headers, signal: AbortSignal.timeout(timeoutMs) });
            if (response.status !== 200) { diagnostic = `${id}-http-${response.status}`; await response.body?.cancel(); }
            else {
                const reader = response.body?.getReader();
                const chunks: Uint8Array[] = [];
                let total = 0;
                if (!reader) diagnostic = `${id}-invalid-json`;
                else for (;;) {
                    const part = await reader.read();
                    if (part.done) break;
                    total += part.value.byteLength;
                    if (total > MAX_AGENT_LIST_OUTPUT_BYTES) { diagnostic = `${id}-response-too-large`; await reader.cancel(); break; }
                    chunks.push(part.value);
                }
                if (!diagnostic) {
                    const bytes = Buffer.concat(chunks);
                    let parsed: unknown;
                    try { parsed = JSON.parse(bytes.toString('utf8')); } catch { diagnostic = `${id}-invalid-json`; }
                    if (!diagnostic && !validate(parsed)) diagnostic = `${id}-missing-registration`;
                }
            }
        } catch (error) {
            diagnostic = error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError') ? `${id}-timeout` : `${id}-request-failed`;
        }
        checks.push({ id, status: diagnostic ? 'failed' : 'passed', durationMs: Date.now() - started, diagnostic });
    }
    return checks;
}
async function checkNativeInstalledHost(opencode: string, project: string, env: NodeJS.ProcessEnv, root: string, configPath: string, pluginPath: string, models: readonly string[], timeoutMs: number): Promise<CompatibilityCheck[]> {
    const started = Date.now();
    let server: Awaited<ReturnType<typeof startHostServer>> | undefined;
    try {
        const source = path.join(root, 'native-models.json');
        server = await startHostServer(opencode, project, { ...env, OPENCODE_DISABLE_MODELS_FETCH: 'true', OPENCODE_MODELS_PATH: source }, 'catalogue');
        const startup: CompatibilityCheck = { id: 'native-host-startup', status: 'passed', durationMs: Date.now() - started, diagnostic: null };
        return [startup, ...await checkNativeHostRoutes(server.url, server.headers, project, configPath, pluginPath,
            models.length === 1 && models[0] === NATIVE_FIXTURE_WORKER ? [{ name: NATIVE_WORKER_NAME, model: NATIVE_HOST_MODEL }] : [], timeoutMs)];
    } catch (error) {
        const diagnostic = error instanceof Error && /timed out/i.test(error.message) ? 'native-host-startup-timeout' : 'native-host-startup-failed';
        return [{ id: 'native-host-startup', status: 'failed', durationMs: Date.now() - started, diagnostic }];
    } finally { server?.stop(); }
}
export async function runCompatibilitySmoke(options: CompatibilitySmokeOptions, hooks: CompatibilitySmokeHooks = {}): Promise<CompatibilityEvidence> {
    if (!isCompatibilityProfile(options.profile))
        throw new Error(`unknown compatibility profile: ${String(options.profile)}`);
    const timeoutMs = validateTimeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    const opencode = await executablePath(options.opencodePath, 'OpenCode');
    const source = await sourceRoot(options.sourcePath);
    const detected = options.platformEvidence ?? { platform: process.platform, arch: process.arch, ...(await linuxIdentity()) };
    const platform = evaluatePlatformTarget(detected);
    const checks: CompatibilityCheck[] = [{
            id: 'target-platform',
            status: platform.status === 'targeted' ? 'passed' : 'failed',
            durationMs: 0,
            diagnostic: platform.reason,
        }];
    const versions = { bun: '', gh: '', git: '', node: process.versions.node, opencode: '' };
    if (platform.status === 'targeted') {
        const root = await mkdtemp(path.join(await realpath(os.tmpdir()), 'naru-compat-'));
        const privateBin = path.join(root, 'bin');
        const home = path.join(root, 'home');
        const target = path.join(home, '.config', 'opencode');
        const project = path.join(root, 'project');
        const env = isolatedEnvironment(root, privateBin);
        const versionEnv = isolatedEnvironment(path.join(root, 'version-check'), privateBin);
        try {
            await chmod(root, 0o700);
            hooks.onDisposableRoot?.(root);
            for (const directory of [privateBin, home, project, env.TMPDIR, env.XDG_CACHE_HOME, env.XDG_CONFIG_HOME, env.XDG_DATA_HOME, env.XDG_STATE_HOME, env.GH_CONFIG_DIR, versionEnv.HOME, versionEnv.TMPDIR, versionEnv.XDG_CACHE_HOME, versionEnv.XDG_CONFIG_HOME, versionEnv.XDG_DATA_HOME, versionEnv.XDG_STATE_HOME, versionEnv.GH_CONFIG_DIR]) {
                if (directory === undefined)
                    throw new Error('isolated environment directory is unavailable');
                await mkdir(directory, { recursive: true, mode: 0o700 });
            }
            await symlink(opencode, path.join(privateBin, 'opencode'));
            const versionCommand = OPENCODE_SAFE_COMMANDS[0];
            if (!versionCommand)
                throw new Error('OpenCode version command is unavailable');
            let result = await runBoundedProcess(opencode, versionCommand.args, { cwd: project, env: versionEnv, timeoutMs });
            versions.opencode = sanitizeObservedVersion(result.output) ?? '';
            const versionEvaluation = evaluateOpenCodeVersion(options.profile, result.output);
            const versionAccepted = versionEvaluation.status === 'supported';
            checks.push({
                id: versionCommand.id,
                status: result.status === 'passed' && versionAccepted ? 'passed' : 'failed',
                durationMs: result.durationMs,
                diagnostic: result.status !== 'passed' ? `opencode-version-${result.reason}` : versionAccepted ? null : versionEvaluation.status === 'unrecognized' ? 'opencode-version-invalid' : 'opencode-version-not-eligible-for-profile',
            });
            if (result.status === 'passed' && versionAccepted) {
                const cli = path.join(source, 'bin', 'naru');
                const invoke = (args: string[]) => runBoundedProcess('/bin/sh', [cli, ...args], { cwd: project, env, timeoutMs });
                result = await invoke(['install', '--preview']);
                let mutated = false;
                for (const name of ['.naru-native', 'opencode.json']) {
                    try { await lstat(path.join(target, name)); mutated = true; } catch (error) { if (errorCode(error) !== 'ENOENT') throw error; }
                }
                checks.push(commandCheck('install-preview', mutated ? { ...result, status: 'failed', reason: 'preview-mutated-native-assets' } : result));
                if (result.status === 'failed') {
                    const known = ['Native install requires OpenCode 2.0.15', 'Unsafe native install directory', 'Native agent name', 'Native install requires the compiled release', 'Normal OpenCode config must be strict JSON', 'OC2 native setup requires HOME', 'Missing compiled Naru tools'];
                    checks.at(-1)!.diagnostic = known.find(message => result.output.includes(message)) ?? checks.at(-1)!.diagnostic;
                }
                if (result.status === 'passed' && !mutated) {
                    result = await invoke(['install', '--apply']);
                    checks.push(commandCheck('install-apply', result));
                    if (result.status === 'passed') {
                        const native = await import('../tools/naru-lib/native-install.mjs');
                        const paths = native.getNativeInstallPaths(target);
                        const sourceFile = path.join(root, 'native-models.json');
                        await writeFile(sourceFile, JSON.stringify({ fixture: { id: 'fixture', name: 'Fixture', env: [], npm: '@ai-sdk/openai-compatible', models: {
                            worker: { id: 'worker', name: 'Synthetic worker', release_date: '2026-09-13', attachment: false, reasoning: true, tool_call: true, modalities: { input: ['text'], output: ['text'] }, limit: { context: 200000, output: 8000 }, provider: { npm: '@ai-sdk/openai' } },
                        } } }), { mode: 0o600 });
                        const configBefore = await boundedJson(paths.configPath);
                        if (!isRecord(configBefore)) throw new Error('native fixture config missing');
                        configBefore.providers = { fixture: { canonical: 'openai', settings: { baseURL: 'http://127.0.0.1:9/v1', apiKey: 'local-fixture-only' }, models: {
                            worker: { modelID: 'synthetic-worker', capabilities: { tools: true, input: ['text'], output: ['text'] }, limit: { context: 200000, output: 8000 }, variants: [{ id: 'high', settings: { reasoningEffort: 'high' } }] },
                        } } };
                        await writeFile(paths.configPath, JSON.stringify(configBefore, null, 2) + '\n', { mode: 0o600 });
                        const modelEnv = { ...env, OPENCODE_DISABLE_MODELS_FETCH: 'true', OPENCODE_MODELS_PATH: sourceFile };
                        const configure = (args: string[]) => runBoundedProcess('/bin/sh', [cli, ...args], { cwd: project, env: modelEnv, timeoutMs });
                        result = await configure(['models', '--set', NATIVE_FIXTURE_WORKER]);
                        checks.push(commandCheck('models-preview', result));
                        if (result.status === 'passed') {
                            result = await configure(['models', '--set', NATIVE_FIXTURE_WORKER, '--apply']);
                            checks.push(commandCheck('models-apply', result));
                        }
                        const inspected = await native.inspectNativeInstall(target);
                        const packageValid = inspected.installed && (await lstat(path.join(paths.packageRoot, 'tools', 'oc2-native-plugin', 'index.mjs'))).isFile();
                        checks.push({ id: 'native-package', status: packageValid ? 'passed' : 'failed', durationMs: 0, diagnostic: packageValid ? null : 'native-package-missing' });
                        const config = await boundedJson(paths.configPath);
                        const agents = isRecord(config) && isRecord(config.agents) ? config.agents : {};
                        const owned = await boundedJson(paths.ownershipPath);
                        const ownedAgents = isRecord(owned) && isRecord(owned.agents) ? owned.agents : {};
                        const workersValid = nativeWorkerPoolValid(inspected.models, agents, ownedAgents) && result.status === 'passed';
                        checks.push({ id: 'native-worker-pool', status: workersValid ? 'passed' : 'failed', durationMs: 0, diagnostic: workersValid ? null : 'native-worker-pool-missing-or-mismatched' });
                        const agentsValid = workersValid && isRecord(agents.naru) && agents.naru.mode === 'primary' && !Object.hasOwn(agents.naru, 'model') && JSON.stringify(agents.naru) === JSON.stringify(ownedAgents.naru);
                        checks.push({ id: 'native-agents', status: agentsValid ? 'passed' : 'failed', durationMs: 0, diagnostic: agentsValid ? null : 'native-agent-projection-invalid' });
                        const plugin = path.join(paths.packageRoot, 'tools', 'oc2-native-plugin');
                        const registered = isRecord(config) && Array.isArray(config.plugins) && config.plugins.includes(plugin) && Array.isArray(config.skills) && config.skills.includes(path.join(plugin, 'skills'));
                        checks.push({ id: 'native-registration', status: registered ? 'passed' : 'failed', durationMs: 0, diagnostic: registered ? null : 'native-registration-invalid' });
                        result = await invoke(['doctor', '--json']);
                        let doctorValid = false;
                        try { const report = JSON.parse(result.stdout); doctorValid = report.native?.package === 'valid' && report.native?.agents === 'valid' && report.native?.registration === 'valid' && report.native?.runtimeEvidence === 'not-run' && report.compatibility?.opencode?.version === '2.0.15'; } catch {}
                        checks.push({ id: 'naru-doctor', status: doctorValid && result.status === 'passed' ? 'passed' : 'failed', durationMs: result.durationMs, diagnostic: doctorValid && result.status === 'passed' ? null : 'normal-doctor-failed' });
                        checks.push(...await checkNativeInstalledHost(opencode, project, env, root, paths.configPath, plugin, inspected.models, timeoutMs));
                    }
                }
            }
        }
        catch {
            checks.push({ id: 'harness', status: 'failed', durationMs: 0, diagnostic: 'harness-failed-safely' });
        }
        finally {
            try {
                await guardedRemoveDisposableRoot(root);
                checks.push({ id: 'cleanup', status: 'passed', durationMs: 0, diagnostic: null });
            }
            catch {
                checks.push({ id: 'cleanup', status: 'failed', durationMs: 0, diagnostic: 'disposable-root-cleanup-failed' });
            }
        }
    }
    return createCompatibilityEvidence({ profile: options.profile, platform, versions, checks });
}
async function writeOutput(file: string, report: CompatibilityEvidence): Promise<void> {
    const resolved = path.resolve(file);
    const parent = path.dirname(resolved);
    const stats = await lstat(parent);
    if (!stats.isDirectory())
        throw new Error('output parent must be a directory');
    try {
        const existing = await lstat(resolved);
        if (existing.isSymbolicLink() || !existing.isFile())
            throw new Error('output must not be a symlink or special file');
    }
    catch (error) {
        if (errorCode(error) !== 'ENOENT')
            throw error;
    }
    const handle = await open(resolved, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_TRUNC | (fsConstants.O_NOFOLLOW ?? 0), 0o600);
    try {
        await handle.writeFile(`${JSON.stringify(report, null, 2)}\n`);
    }
    finally {
        await handle.close();
    }
}
async function main() {
    let options;
    try {
        options = parseArgs(process.argv.slice(2));
    }
    catch (error) {
        process.stderr.write(`naru-compat-smoke: ${errorMessage(error)}\n${usage()}`);
        process.exitCode = 2;
        return;
    }
    if (options.help) {
        process.stdout.write(usage());
        return;
    }
    if (!options.profile || !options.opencodePath || !options.sourcePath)
        throw new Error('required smoke paths are unavailable');
    try {
        const report = await runCompatibilitySmoke({
            ...options,
            opencodePath: options.opencodePath,
            profile: options.profile,
            sourcePath: options.sourcePath,
        });
        if (options.output)
            await writeOutput(options.output, report);
        if (options.json)
            process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
        else
            process.stdout.write(`Naru compatibility smoke: ${report.status}; profile ${report.profile}; qualification ${report.qualification}; release qualification ${report.releaseQualification}\n`);
        if (report.status !== 'passed-local-smoke')
            process.exitCode = 1;
    }
    catch {
        process.stderr.write('naru-compat-smoke: failed safely; output and external tool diagnostics omitted\n');
        process.exitCode = 1;
    }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
    await main();
