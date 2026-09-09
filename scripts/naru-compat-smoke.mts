#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { constants as fsConstants } from 'node:fs';
import { chmod, lstat, mkdir, mkdtemp, open, realpath, symlink, writeFile, } from 'node:fs/promises';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { classifyDashboardEvidence, COMPATIBILITY_POLICY, createCompatibilityEvidence, evaluateOpenCodeVersion, evaluatePlatformTarget, isCompatibilityProfile, sanitizeObservedVersion, } from '../tools/naru-lib/compatibility.mjs';
import type { CompatibilityCheck, CompatibilityEvidence, CompatibilityCheckStatus, CompatibilityProfile } from '../tools/naru-lib/compatibility.mjs';
import { coreConfigContractFailures, guardedRemoveDisposableRoot, HOST_CONTRACT_TIMEOUT_MS, runBoundedProcess, runHostContractProbe, signalProcessGroup, stopProcessGroup, validateCoreConfigContract, writeHostContractFixtures, } from '../tools/naru-lib/host-contract-probe.mjs';
export { runBoundedProcess } from '../tools/naru-lib/host-contract-probe.mjs';

interface CompatibilityCliOptions {
    bunPath: string | null;
    dashboard: boolean;
    help?: boolean;
    json: boolean;
    opencodePath: string | null;
    output: string | null;
    profile: CompatibilityProfile | null;
    sourcePath: string | null;
}
interface PlatformEvidence { platform?: unknown; arch?: unknown; osId?: unknown; wsl?: unknown }
export interface CompatibilitySmokeOptions {
    bunPath?: string | null;
    dashboard?: boolean;
    opencodePath: string;
    profile: CompatibilityProfile;
    sourcePath: string;
    timeoutMs?: number;
    platformEvidence?: PlatformEvidence;
}
interface CompatibilitySmokeHooks { onDisposableRoot?(root: string): void }
interface StartupOptions { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number }
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
const DEFAULT_TIMEOUT_MS = HOST_CONTRACT_TIMEOUT_MS;
const MAX_OUTPUT_BYTES = 64 * 1024;
const MAX_AGENT_LIST_OUTPUT_BYTES = 1024 * 1024;
const CONFIG_MAX_BYTES = 64 * 1024;
export const OPENCODE_SAFE_COMMANDS: readonly SafeCommand[] = Object.freeze([
    Object.freeze({ id: 'opencode-version', args: Object.freeze(['--version']) }),
    Object.freeze({ id: 'opencode-help', args: Object.freeze(['--help']) }),
    Object.freeze({ id: 'opencode-debug-paths', args: Object.freeze(['debug', 'paths']) }),
    Object.freeze({
        id: 'opencode-debug-config',
        args: Object.freeze(['debug', 'config']),
        maxOutputBytes: MAX_AGENT_LIST_OUTPUT_BYTES,
        retainOutput: true,
    }),
    Object.freeze({
        id: 'opencode-agent-list',
        args: Object.freeze(['agent', 'list']),
        maxOutputBytes: MAX_AGENT_LIST_OUTPUT_BYTES,
        retainOutput: false,
    }),
    Object.freeze({ id: 'opencode-startup', args: Object.freeze(['serve', '--hostname', '127.0.0.1', '--port', '<ephemeral>']) }),
]);
export const OPENCODE_V2_EXPLORATORY_COMMANDS: readonly SafeCommand[] = Object.freeze([
    Object.freeze({ id: 'opencode-version', args: Object.freeze(['--version']) }),
    Object.freeze({ id: 'opencode-help', args: Object.freeze(['--help']) }),
]);
function usage() {
    return 'Usage: node scripts/naru-compat-smoke.mjs --profile stable|v2-beta-exploratory --opencode PATH --source PATH [--json] [--output PATH] [--dashboard --bun PATH]\n';
}
function parseArgs(argv: string[]): CompatibilityCliOptions {
    const options: CompatibilityCliOptions = { bunPath: null, dashboard: false, json: false, opencodePath: null, output: null, profile: null, sourcePath: null };
    for (let index = 0; index < argv.length; index += 1) {
        const argument = argv[index];
        if (argument === undefined)
            throw new Error('unknown option');
        if (argument === '--json')
            options.json = true;
        else if (argument === '--dashboard')
            options.dashboard = true;
        else if (['--opencode', '--source', '--output', '--bun', '--profile'].includes(argument)) {
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
            else
                options.bunPath = value;
        }
        else if (argument === '--help' || argument === '-h')
            options.help = true;
        else
            throw new Error(`unknown option: ${argument}`);
    }
    if (!options.help && (!options.profile || !options.opencodePath || !options.sourcePath))
        throw new Error('--profile, --opencode, and --source are required');
    if (options.profile === 'v2-beta-exploratory' && options.dashboard)
        throw new Error('--dashboard is unavailable for the v2 beta exploratory profile');
    if (options.dashboard !== Boolean(options.bunPath))
        throw new Error('--dashboard and --bun PATH must be supplied together');
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
export const validStableNaruConfig = validateCoreConfigContract;
function commandCheck(id: string, result: CommandResult): CompatibilityCheck {
    return {
        id,
        status: result.status,
        durationMs: result.durationMs,
        diagnostic: result.status === 'passed' ? null : `${id}-${result.reason ?? 'failed'}`,
    };
}
async function availablePort() {
    const server = createServer();
    await new Promise<void>((resolvePromise, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => resolvePromise());
    });
    const address = server.address();
    await new Promise<void>(resolvePromise => server.close(() => resolvePromise()));
    if (!address || typeof address === 'string')
        throw new Error('localhost port allocation failed');
    return address.port;
}
async function startupCheck(executable: string, { cwd, env, timeoutMs }: StartupOptions): Promise<CommandResult> {
    const started = Date.now();
    const port = await availablePort();
    const args = ['serve', '--hostname', '127.0.0.1', '--port', String(port)];
    let bytes = 0;
    let overflow = false;
    let exited = false;
    const child = spawn(executable, args, { cwd, detached: true, env, stdio: ['ignore', 'pipe', 'pipe'] });
    const count = (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > MAX_OUTPUT_BYTES) {
            overflow = true;
            signalProcessGroup(child, 'SIGTERM');
        }
    };
    child.stdout.on('data', count);
    child.stderr.on('data', count);
    child.once('error', () => { exited = true; });
    child.once('exit', () => { exited = true; });
    let passed = false;
    let reason: string | null = 'startup-timeout';
    const deadline = Date.now() + timeoutMs;
    try {
        while (Date.now() < deadline && !exited && !overflow) {
            try {
                const controller = new AbortController();
                const timer = setTimeout(() => controller.abort(), Math.min(500, Math.max(1, deadline - Date.now())));
                const response = await fetch(`http://127.0.0.1:${port}/global/health`, { signal: controller.signal });
                clearTimeout(timer);
                response.body?.cancel().catch(() => { });
                if (response.ok) {
                    passed = true;
                    reason = null;
                    break;
                }
            }
            catch {
                // The bounded local server may still be starting.
            }
            await new Promise(resolve => setTimeout(resolve, 50));
        }
        if (overflow)
            reason = 'output-limit';
        else if (exited && !passed)
            reason = 'early-exit';
    }
    finally {
        await stopProcessGroup(child);
    }
    return { durationMs: Date.now() - started, status: passed ? 'passed' : 'failed', reason };
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
export async function runCompatibilitySmoke(options: CompatibilitySmokeOptions, hooks: CompatibilitySmokeHooks = {}): Promise<CompatibilityEvidence> {
    if (!isCompatibilityProfile(options.profile))
        throw new Error(`unknown compatibility profile: ${String(options.profile)}`);
    const timeoutMs = validateTimeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    const opencode = await executablePath(options.opencodePath, 'OpenCode');
    const source = await sourceRoot(options.sourcePath);
    const bun = options.dashboard
        ? await executablePath(typeof options.bunPath === 'string' ? options.bunPath : '', 'Bun')
        : null;
    const detected = options.platformEvidence ?? { platform: process.platform, arch: process.arch, ...(await linuxIdentity()) };
    const platform = evaluatePlatformTarget(detected);
    const checks: CompatibilityCheck[] = [{
            id: 'target-platform',
            status: platform.status === 'targeted' ? 'passed' : 'failed',
            durationMs: 0,
            diagnostic: platform.reason,
        }];
    const versions = { bun: '', gh: '', git: '', node: process.versions.node, opencode: '' };
    let dashboardSyntax: CompatibilityCheckStatus = 'omitted';
    let dashboardRegistration: CompatibilityCheckStatus = 'omitted';
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
            const versionCommand = options.profile === 'stable' ? OPENCODE_SAFE_COMMANDS[0] : OPENCODE_V2_EXPLORATORY_COMMANDS[0];
            if (!versionCommand)
                throw new Error('OpenCode version command is unavailable');
            let result = await runBoundedProcess(opencode, versionCommand.args, { cwd: project, env: versionEnv, timeoutMs });
            versions.opencode = sanitizeObservedVersion(result.output) ?? '';
            const versionEvaluation = evaluateOpenCodeVersion(options.profile, result.output);
            const versionAccepted = versionEvaluation.status === 'supported' || (options.profile === 'stable' && versionEvaluation.status === 'candidate');
            checks.push({
                id: versionCommand.id,
                status: result.status === 'passed' && versionAccepted ? 'passed' : 'failed',
                durationMs: result.durationMs,
                diagnostic: result.status !== 'passed' ? `opencode-version-${result.reason}` : versionAccepted ? null : versionEvaluation.status === 'unrecognized' ? 'opencode-version-invalid' : 'opencode-version-not-eligible-for-profile',
            });
            if (result.status === 'passed' && versionEvaluation.status === 'supported' && options.profile === 'v2-beta-exploratory') {
                const helpCommand = OPENCODE_V2_EXPLORATORY_COMMANDS[1];
                if (!helpCommand)
                    throw new Error('OpenCode exploratory help command is unavailable');
                result = await runBoundedProcess(opencode, helpCommand.args, { cwd: project, env: versionEnv, timeoutMs });
                checks.push(commandCheck(helpCommand.id, result));
            }
            let hostContractMarker = '';
            if (result.status === 'passed' && (versionEvaluation.status === 'supported' || versionEvaluation.status === 'candidate') && options.profile === 'stable') {
                const installArgs = [path.join(source, 'install.sh'), '--copy'];
                if (options.dashboard)
                    installArgs.push('--with-dashboard');
                result = await runBoundedProcess('/bin/sh', [...installArgs, '--preview'], { cwd: project, env, timeoutMs });
            let targetExists = true;
            try {
                await lstat(target);
            }
            catch (error) {
                if (errorCode(error) === 'ENOENT')
                    targetExists = false;
                else
                    throw error;
            }
            if (targetExists)
                result = { ...result, status: 'failed', reason: 'preview-mutated-target' };
            checks.push(commandCheck('install-preview', result));
            if (result.status === 'passed') {
                result = await runBoundedProcess('/bin/sh', [...installArgs, '--apply'], { cwd: project, env, timeoutMs });
                checks.push(commandCheck('install-apply', result));
                if (result.status === 'passed') await writeFile(path.join(target, 'naru-runtime.json'), JSON.stringify({
                    schemaVersion: 1,
                    models: { smoke: { use: 'Provider-free configuration fixture; never execute', chain: ['openai/naru-compat-fixture@high'] } },
                    review: { defaultProfile: 'release-critical', defaultDecision: 'comment-only', defaultOutput: 'concise' },
                    mcp: { configuredTools: 'ask' },
                }), { mode: 0o600 });
                if (result.status === 'passed') hostContractMarker = await writeHostContractFixtures(target, project);
            }
            else {
                checks.push({ id: 'install-apply', status: 'omitted', durationMs: 0, diagnostic: 'preview-failed' });
            }
            const doctorPath = path.join(target, 'tools', 'naru-doctor.js');
            const doctorEntry = path.join(root, 'doctor-static.mjs');
            await writeFile(doctorEntry, `import { buildStaticDoctorReport } from ${JSON.stringify(pathToFileURL(doctorPath).href)};\nconst report = await buildStaticDoctorReport({ customDir: null, projectRoot: process.argv[2], sourceRoot: process.argv[3], json: true });\nprocess.stdout.write(JSON.stringify(report));\n`, { mode: 0o600 });
            result = await runBoundedProcess(process.execPath, [doctorEntry, project, source], {
                cwd: project,
                env,
                timeoutMs,
            });
            let doctorValid = false;
            if (result.output.length <= CONFIG_MAX_BYTES) {
                try {
                    const report = JSON.parse(result.output);
                    const reportRecord = isRecord(report) ? report : {};
                    const scopes = Array.isArray(reportRecord.scopes) ? reportRecord.scopes.filter(isRecord) : [];
                    const scope = scopes.find(item => item.id === 'global');
                    const depth = isRecord(reportRecord.depth) ? reportRecord.depth : {};
                    const runtime = isRecord(scope?.runtime) ? scope.runtime : {};
                    doctorValid = reportRecord.providerFree === true
                        && reportRecord.readOnly === true
                        && typeof depth.effective === 'number'
                        && depth.effective >= COMPATIBILITY_POLICY.features.core.minimumSubagentDepth
                        && typeof runtime.workspaceMode === 'string';
                }
                catch {
                    doctorValid = false;
                }
            }
            checks.push({
                id: 'naru-doctor',
                status: result.status === 'passed' && doctorValid ? 'passed' : 'failed',
                durationMs: result.durationMs,
                diagnostic: result.status !== 'passed' ? `naru-doctor-${result.reason}` : doctorValid ? null : 'naru-doctor-contract-failed',
            });
            for (const command of OPENCODE_SAFE_COMMANDS.slice(1, -1)) {
                result = await runBoundedProcess(opencode, command.args, {
                    cwd: project,
                    env,
                    ...(command.maxOutputBytes === undefined ? {} : { maxOutputBytes: command.maxOutputBytes }),
                    ...(command.retainOutput === undefined ? {} : { retainOutput: command.retainOutput }),
                    timeoutMs,
                });
                checks.push(commandCheck(command.id, result));
                if (command.id === 'opencode-debug-config') {
                    let parsed: unknown;
                    try { parsed = result.status === 'passed' ? JSON.parse(result.stdout) : undefined; } catch { /* Invalid effective config fails both contracts. */ }
                    const coreFailures = result.status === 'passed' ? coreConfigContractFailures(parsed) : ['debug-config-command-failed'];
                    const coreValid = coreFailures.length === 0;
                    checks.push({ id: 'core-config', status: coreValid ? 'passed' : 'failed', durationMs: 0, diagnostic: coreValid ? null : coreFailures.join(',') });
                }
            }
            const hostContract = hostContractMarker
                ? await runHostContractProbe({ executable: opencode, cwd: project, env, marker: hostContractMarker, timeoutMs })
                : { status: 'failed' as const, diagnostic: 'host-contract-fixture-unavailable', observations: [] };
            checks.push({ id: 'mcp-contract', status: hostContract.status, durationMs: 0, diagnostic: hostContract.diagnostic });
            const startupResult = await startupCheck(opencode, { cwd: project, env, timeoutMs });
            checks.push(commandCheck('opencode-startup', startupResult));
            if (options.dashboard) {
                if (!bun)
                    throw new Error('Bun executable is unavailable');
                result = await runBoundedProcess(bun, ['--version'], { cwd: project, env, timeoutMs });
                versions.bun = sanitizeObservedVersion(result.output) ?? '';
                checks.push(commandCheck('bun-version', result));
                const output = path.join(root, 'dashboard-build.js');
                result = await runBoundedProcess(bun, [
                    'build',
                    path.join(target, 'plugins', 'naru-minions-dashboard.tsx'),
                    '--target=bun',
                    `--outfile=${output}`,
                    '--external=solid-js',
                    '--external=@opentui/solid',
                ], { cwd: project, env, timeoutMs });
                dashboardSyntax = result.status;
                checks.push(commandCheck('dashboard-bun-syntax', result));
                try {
                    const config = await boundedJson(path.join(target, 'tui.json'));
                    const plugins = isRecord(config) ? config.plugin : undefined;
                    const matches = Array.isArray(plugins)
                        ? plugins.filter(entry => entry === './plugins/naru-minions-dashboard.tsx')
                        : [];
                    dashboardRegistration = matches.length === 1 ? 'passed' : 'failed';
                }
                catch {
                    dashboardRegistration = 'failed';
                }
                checks.push({
                    id: 'dashboard-registration',
                    status: dashboardRegistration,
                    durationMs: 0,
                    diagnostic: dashboardRegistration === 'passed' ? null : 'dashboard-registration-invalid',
                });
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
    const dashboard = classifyDashboardEvidence({
        requested: Boolean(options.dashboard),
        bun: versions.bun,
        syntax: dashboardSyntax,
        registration: dashboardRegistration,
    });
    return createCompatibilityEvidence({ profile: options.profile, platform, versions, checks, dashboard });
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
        if (report.status !== 'passed-local-smoke' && report.status !== 'passed-exploratory-smoke')
            process.exitCode = 1;
    }
    catch {
        process.stderr.write('naru-compat-smoke: failed safely; output and external tool diagnostics omitted\n');
        process.exitCode = 1;
    }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
    await main();
