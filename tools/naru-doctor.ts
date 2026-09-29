#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants as fsConstants, realpathSync } from 'node:fs';
import { lstat, open, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { evaluateOpenCodeVersion } from './naru-lib/compatibility.mjs';
import { defaultNativeConfigRoot, getNativeInstallPaths, inspectNativeInstall } from './naru-lib/native-install.mjs';
import { projectOc2NativeAgents } from './naru-lib/oc2-native-projection.mjs';
const REPORT_SCHEMA_VERSION = 4;
// Native projections put ~4 KB per worker into opencode.json; 32 workers plus user config exceed 64 KiB.
const MAX_CONFIG_BYTES = 1024 * 1024;
const MAX_ISSUES = 32;

export interface DoctorOptions {
    customDir: string | null;
    json: boolean;
    help?: boolean;
}
interface DoctorIssue { code: string; scope: string; detail: string }
interface OpenCodeCompatibility {
    status: 'not-found' | 'unsupported' | 'probe-required';
    version: string | null;
    profile: 'native-v2';
    recognizedBuilds: readonly string[];
    versionPolicy: 'current-target' | 'candidate' | 'unsupported';
}
export interface DoctorReport {
    schemaVersion: 4;
    diagnostic: 'naru-doctor';
    providerFree: true;
    readOnly: true;
    status: 'healthy' | 'warning';
    compatibility: { opencode: OpenCodeCompatibility; runtime: { name: 'bun' | 'node'; version: string } };
    issues: DoctorIssue[];
    native: { installed: boolean; package: 'absent' | 'valid' | 'invalid'; agents: 'absent' | 'valid' | 'invalid'; registration: 'absent' | 'valid' | 'invalid'; workers: number; runtimeEvidence: 'not-run' };
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function recordValue(value: unknown): Record<string, unknown> | null {
    return isRecord(value) ? value : null;
}
function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
function usage() {
    return `Usage: node tools/naru-doctor.js [--dir PATH] [--json]\n\n` +
        'Reads the native installation without changing user state. Static checks do not prove runtime behavior or account entitlement.\n';
}
function parseArgs(argv: string[]): DoctorOptions {
    const options: DoctorOptions = { customDir: null, json: false };
    for (let index = 0; index < argv.length; index += 1) {
        const argument = argv[index];
        if (argument === '--json')
            options.json = true;
        else if (argument === '--dir') {
            const value = argv[index + 1];
            if (value === undefined || value.startsWith('-'))
                throw new Error(`${argument} requires a PATH`);
            index += 1;
            options.customDir = path.resolve(value);
        }
        else if (argument === '--help' || argument === '-h') {
            options.help = true;
        }
        else {
            throw new Error(`unknown option: ${argument}`);
        }
    }
    return options;
}
async function statOrNull(value: string) {
    try {
        return await lstat(value);
    }
    catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'ENOENT')
            return null;
        throw error;
    }
}
async function readBoundedConfig(file: string): Promise<string | null> {
    const stats = await statOrNull(file);
    if (stats === null)
        return null;
    if (stats.isSymbolicLink() || !stats.isFile() || stats.size > MAX_CONFIG_BYTES) {
        throw new Error('unsafe config file');
    }
    const handle = await open(file, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    try {
        const opened = await handle.stat();
        if (!opened.isFile() || opened.size > MAX_CONFIG_BYTES)
            throw new Error('unsafe config file');
        return await handle.readFile({ encoding: 'utf8' });
    }
    finally {
        await handle.close();
    }
}
async function loadJsonConfig(file: string): Promise<Record<string, unknown> | null> {
    const source = await readBoundedConfig(file);
    if (source === null)
        return null;
    const record = recordValue(JSON.parse(source));
    if (!record) {
        throw new Error('config root must be an object');
    }
    return record;
}
function addIssue(issues: DoctorIssue[], code: string, scope: string, detail: string): void {
    if (issues.length >= MAX_ISSUES)
        return;
    issues.push({ code, scope, detail });
}
export async function buildDoctorReport(options: DoctorOptions): Promise<DoctorReport> {
    const root = options.customDir ?? defaultNativeConfigRoot();
    const paths = getNativeInstallPaths(root);
    const issues: DoctorIssue[] = [];
    const native: NonNullable<DoctorReport['native']> = { installed: false, package: 'absent', agents: 'absent', registration: 'absent', workers: 0, runtimeEvidence: 'not-run' };
    const host = spawnSync('opencode', ['--version'], { encoding: 'utf8', timeout: 2_000, maxBuffer: 4096, stdio: ['ignore', 'pipe', 'pipe'] });
    const evaluation = evaluateOpenCodeVersion('native-v2', host.status === 0 ? `${host.stdout ?? ''}\n${host.stderr ?? ''}` : '');
    const exact = evaluation.status === 'supported', accepted = exact || evaluation.status === 'candidate';
    const compatibility: DoctorReport['compatibility'] = {
        opencode: { status: accepted ? 'probe-required' : host.error && 'code' in host.error && host.error.code === 'ENOENT' ? 'not-found' : 'unsupported', version: evaluation.observed, profile: 'native-v2', recognizedBuilds: ['2.0.15'], versionPolicy: exact ? 'current-target' : accepted ? 'candidate' : 'unsupported' },
        runtime: { name: Reflect.get(globalThis, 'Bun') ? 'bun' : 'node', version: process.versions.node },
    };
    if (!accepted) addIssue(issues, 'opencode-compatibility', 'host', 'native install requires observed OpenCode 2.0.15 or a newer 2.0.x patch release; no runtime qualification was inferred');
    if (await statOrNull(path.join(root, 'agents', 'naru.md')) !== null) addIssue(issues, 'native-agent-collision', 'global', 'filesystem agents/naru.md is ambiguous with the native naru definition; manual cutover required');
    try {
        const inspected = await inspectNativeInstall(root);
        native.installed = inspected.installed;
        native.workers = inspected.models.length;
        const packageStat = await lstat(paths.packageRoot);
        if (!packageStat.isDirectory() || packageStat.isSymbolicLink()) throw new Error('unsafe native package directory');
        const manifest = JSON.parse(await readFile(paths.manifestPath, 'utf8')) as { schemaVersion?: unknown; files?: unknown };
        if (manifest.schemaVersion !== 1 || !isRecord(manifest.files) || Object.keys(manifest.files).length < 2 || Object.keys(manifest.files).length > 2048) throw new Error('invalid package inventory');
        const files = manifest.files;
        for (const [name, hash] of Object.entries(files)) {
            if (!/^[a-zA-Z0-9._/-]+$/.test(name) || name.split('/').some(part => part === '..' || part === '.' || !part) || typeof hash !== 'string' || !/^[a-f0-9]{64}$/.test(hash)) throw new Error('invalid package entry');
            const file = path.join(paths.packageRoot, name), stat = await lstat(file);
            if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 8 * 1024 * 1024 || createHash('sha256').update(await readFile(file)).digest('hex') !== hash) throw new Error('package inventory mismatch');
        }
        const observed: string[] = [];
        async function walk(directory: string, prefix = ''): Promise<void> {
            for (const item of await readdir(directory, { withFileTypes: true })) {
                const relative = prefix ? `${prefix}/${item.name}` : item.name;
                if (item.isDirectory() && !item.isSymbolicLink()) await walk(path.join(directory, item.name), relative);
                else if (item.isFile() && !item.isSymbolicLink() && observed.length < 2049) observed.push(relative);
                else throw new Error('unsafe native package entry');
            }
        }
        await walk(paths.packageRoot);
        if (observed.length !== Object.keys(files).length || observed.some(name => !(name in files))) throw new Error('native package inventory differs');
        for (const name of ['tools/oc2-native-plugin/index.mjs', 'tools/oc2-native-plugin/command.md', 'tools/oc2-native-plugin/skills/naru-coordinate/SKILL.md']) if (!(name in files)) throw new Error('missing native asset');
        native.package = 'valid';
        const owned = await loadJsonConfig(paths.ownershipPath);
        const config = await loadJsonConfig(paths.configPath);
        const agents = owned?.agents, configured = config?.agents;
        if (owned?.schemaVersion !== 1 || !isRecord(agents) || !isRecord(configured) || !native.installed || !('naru' in agents) || !Object.keys(agents).every(name => JSON.stringify(agents[name]) === JSON.stringify(configured[name]))) throw new Error('native agent projection missing or changed');
        const parent = recordValue(configured.naru);
        const projected = projectOc2NativeAgents(inspected.models);
        if (parent?.mode !== 'primary' || Object.hasOwn(parent, 'model') || projected.workers.some(worker => {
            const expected = recordValue(projected.agents[worker.name]);
            const actual = recordValue(agents[worker.name]);
            return actual?.mode !== 'subagent' || JSON.stringify(actual.model) !== JSON.stringify(expected?.model);
        })) throw new Error('native worker pool missing or changed');
        native.agents = 'valid';
        if (Object.entries(projected.agents).some(([name, expected]) => JSON.stringify(recordValue(agents[name])?.permissions) !== JSON.stringify(expected.permissions))) addIssue(issues, 'native-agent-permissions', 'global', 'native Naru agents lack current skill and worker guardrail permission rules; rerun naru install to refresh the projection');
        const plugin = path.join(paths.packageRoot, 'tools', 'oc2-native-plugin');
        if (!config || !Array.isArray(config.plugins) || config.plugins.filter(value => value === plugin).length !== 1 || !Array.isArray(config.skills) || config.skills.filter(value => value === path.join(plugin, 'skills')).length !== 1 || await statOrNull(path.join(root, 'agents', 'naru.md')) !== null || await statOrNull(path.join(root, 'opencode.jsonc')) !== null || await statOrNull(path.join(root, '.naru-install.json')) !== null) throw new Error('native plugin or skills not registered or v1 configuration collides');
        native.registration = 'valid';
    } catch (error) {
        const message = error instanceof Error && 'code' in error && error.code === 'ENOENT' ? 'native install is missing or incomplete' : 'native install is invalid, modified, or collides with user configuration';
        addIssue(issues, 'native-install', 'global', message);
        if (native.package === 'absent' && !(error instanceof Error && 'code' in error && error.code === 'ENOENT' && !native.installed)) native.package = 'invalid';
        else if (native.agents === 'absent') native.agents = 'invalid';
        else native.registration = 'invalid';
    }
    return { schemaVersion: REPORT_SCHEMA_VERSION, diagnostic: 'naru-doctor', providerFree: true, readOnly: true, status: issues.length ? 'warning' : 'healthy', compatibility, native, issues };
}
function renderPlain(report: DoctorReport): string {
    return `Naru native doctor: ${report.status}\nOpenCode: ${report.compatibility.opencode.version ?? 'unknown'} (2.0.15 tested; 2.0.x patch accepted)\nNative package: ${report.native.package}; agents: ${report.native.agents}; registration: ${report.native.registration}; workers: ${report.native.workers}\nRuntime evidence: not run; platform, live invocation and account entitlement are not qualified\n${report.issues.map(issue => `${issue.code}: ${issue.detail}\n`).join('')}`;
}
async function main() {
    let options;
    try {
        options = parseArgs(process.argv.slice(2));
    }
    catch (error) {
        process.stderr.write(`naru-doctor: ${errorMessage(error)}\n${usage()}`);
        process.exitCode = 2;
        return;
    }
    if (options.help) {
        process.stdout.write(usage());
        return;
    }
    try {
        const report = await buildDoctorReport(options);
        process.stdout.write(options.json ? `${JSON.stringify(report, null, 2)}\n` : renderPlain(report));
        if (report.status !== 'healthy')
            process.exitCode = 1;
    }
    catch {
        process.stderr.write('naru-doctor: local inspection failed safely; no files were changed\n');
        process.exitCode = 1;
    }
}
function realpathOrNull(value: string): string | null {
    try {
        return realpathSync(value);
    }
    catch {
        return null;
    }
}
const invokedPath = process.argv[1] === undefined ? null : realpathOrNull(process.argv[1]);
if (invokedPath !== null && invokedPath === realpathSync(fileURLToPath(import.meta.url)))
    await main();
