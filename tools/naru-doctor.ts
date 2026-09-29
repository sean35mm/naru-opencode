#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { accessSync, constants as fsConstants, realpathSync } from 'node:fs';
import { lstat, mkdir, mkdtemp, open, readFile, readdir, realpath } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { INSTALL_MANIFEST_FILE, inferInstallSourceRoot, inspectInstallManifest, loadInstallManifest, } from './naru-lib/install-manifest.mjs';
import type { InstallOptions } from './naru-lib/install-manifest.mjs';
import { loadRuntimeConfigFile } from './naru-lib/runtime-config.mjs';
import { analyzeConfiguredMcp, parseModelsConfig } from './naru-lib/dispatch.mjs';
import { COMPATIBILITY_POLICY, evaluateOpenCodeVersion } from './naru-lib/compatibility.mjs';
import { defaultNativeConfigRoot, getNativeInstallPaths, inspectNativeInstall } from './naru-lib/native-install.mjs';
import { projectOc2NativeAgents } from './naru-lib/oc2-native-projection.mjs';
import { guardedRemoveDisposableRoot, HOST_CONTRACT_LIMITATION, HOST_CONTRACT_TIMEOUT_MS, runHostContractProbe, stageHostContractAssets, writeHostContractFixtures, } from './naru-lib/host-contract-probe.mjs';
const REPORT_SCHEMA_VERSION = 3;
// Native projections put ~4 KB per worker into opencode.json; 32 workers plus user config exceed 64 KiB.
const MAX_CONFIG_BYTES = 1024 * 1024;
const MAX_ISSUES = 32;
const MAX_REPORTED_PATHS = 10;

export interface DoctorOptions {
    customDir: string | null;
    projectRoot: string;
    sourceRoot: string | null;
    json: boolean;
    help?: boolean;
    hostContractRoot?: string | null;
    legacy?: boolean;
}
interface DoctorIssue { code: string; scope: string; detail: string }
interface ScopeCandidate { id: string; loadState: string; target: string }
interface StaticMcpState { status: 'absent' | 'available'; basis: 'scope-only'; categories: Record<string, number>; notes: string[] }
interface OpenCodeConfigState { status: 'absent' | 'invalid' | 'valid'; file: string | null; depth: number | null; configuredMcp: StaticMcpState }
interface OpenCodeConfigInspection extends OpenCodeConfigState { mcp: unknown }
interface EffectiveMcpState { status: 'known' | 'unknown'; source: string; toolInventory: 'unknown'; categories: Record<string, number>; notes: string[] }
interface RuntimeState { status: 'default' | 'custom-valid' | 'invalid'; workspaceMode: string | null; configuredMcpTools: string | null; reviewProfile: string | null; reviewDecision: string | null; reviewOutput: string | null; modelClasses?: string[] | null; modelsError?: string | null }
interface ScopeAssets {
    total: number;
    installed: Record<string, number>;
    source: Record<string, number>;
    sourceCompared: boolean;
    inspectionStatus: 'complete' | 'failed';
}
interface ScopeReport {
    id: string;
    loadState: string;
    installed: boolean;
    manifestStatus: 'absent' | 'invalid' | 'valid';
    sourceVersion: string | null;
    locationMode: string | null;
    installMode: string | null;
    options: InstallOptions | null;
    assets: ScopeAssets | null;
    issuePaths: string[];
    configuredMcpPolicy: 'installed' | 'incomplete' | 'untracked' | 'unknown';
    runtime: RuntimeState;
}
interface DepthReport {
    status: 'known' | 'unknown';
    effective: number | null;
    source: string;
    global: OpenCodeConfigState;
    project: OpenCodeConfigState;
    custom: OpenCodeConfigState | null;
    configuredMcp: EffectiveMcpState;
}
interface HostContractProbe { status: 'not-run' | 'passed' | 'failed' | 'unavailable'; checks: { id: 'mcp-contract'; status: 'passed' | 'failed'; diagnostic: string | null }[]; actions: string[]; limitation: string }
interface OpenCodeCompatibility {
    status: 'not-found' | 'timeout' | 'unknown' | 'unsupported' | 'supported' | 'probe-required' | 'local-tested' | 'contract-failed';
    version: string | null;
    profile: 'stable' | 'native-v2';
    testedBuilds: readonly string[];
    recognizedBuilds: readonly string[];
    versionPolicy: 'historical-tested' | 'current-target' | 'candidate' | 'invalid' | 'unsupported';
    probe: HostContractProbe;
}
export interface DoctorReport {
    schemaVersion: 3;
    diagnostic: 'naru-doctor';
    providerFree: true;
    readOnly: true;
    status: 'healthy' | 'warning';
    compatibility: { opencode: OpenCodeCompatibility; runtime: { name: 'bun' | 'node'; version: string } };
    depth: DepthReport;
    scopes: ScopeReport[];
    issues: DoctorIssue[];
    native?: { installed: boolean; package: 'absent' | 'valid' | 'invalid'; agents: 'absent' | 'valid' | 'invalid'; registration: 'absent' | 'valid' | 'invalid'; workers: number; runtimeEvidence: 'not-run' };
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
    return `Usage: node tools/naru-doctor.js [--dir PATH] [--project-root PATH] [--source PATH] [--host-contract-root PATH] [--json]\n\n` +
        'Reads the normal native installation without changing user state. --legacy inspects historical v1 dispatch assets. Static checks do not prove runtime behavior or account entitlement.\n';
}
function parseArgs(argv: string[]): DoctorOptions {
    const options: DoctorOptions = {
        customDir: null,
        projectRoot: process.cwd(),
        sourceRoot: null,
        json: false,
        hostContractRoot: null,
    };
    for (let index = 0; index < argv.length; index += 1) {
        const argument = argv[index];
        if (argument === '--json')
            options.json = true;
        else if (argument === '--legacy') options.legacy = true;
        else if (argument === '--dir' || argument === '--project-root' || argument === '--source' || argument === '--host-contract-root') {
            const value = argv[index + 1];
            if (value === undefined || value.startsWith('-'))
                throw new Error(`${argument} requires a PATH`);
            index += 1;
            if (argument === '--dir')
                options.customDir = path.resolve(value);
            else if (argument === '--project-root')
                options.projectRoot = path.resolve(value);
            else if (argument === '--host-contract-root')
                options.hostContractRoot = path.resolve(value);
            else
                options.sourceRoot = path.resolve(value);
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
function stripJsonc(source: string): string {
    let result = '';
    let string = false;
    let escaped = false;
    for (let index = 0; index < source.length; index += 1) {
        const character = source[index];
        const next = source[index + 1];
        if (string) {
            result += character;
            if (escaped)
                escaped = false;
            else if (character === '\\')
                escaped = true;
            else if (character === '"')
                string = false;
        }
        else if (character === '"') {
            string = true;
            result += character;
        }
        else if (character === '/' && next === '/') {
            result += '  ';
            index += 1;
            while (index + 1 < source.length && source[index + 1] !== '\n') {
                result += ' ';
                index += 1;
            }
        }
        else if (character === '/' && next === '*') {
            result += '  ';
            index += 1;
            while (index + 1 < source.length && !(source[index + 1] === '*' && source[index + 2] === '/')) {
                index += 1;
                result += source[index] === '\n' ? '\n' : ' ';
            }
            if (index + 2 >= source.length)
                throw new Error('unterminated block comment');
            result += '  ';
            index += 2;
        }
        else {
            result += character;
        }
    }
    if (string)
        throw new Error('unterminated string');
    let normalized = '';
    string = false;
    escaped = false;
    for (let index = 0; index < result.length; index += 1) {
        const character = result[index];
        if (string) {
            normalized += character;
            if (escaped)
                escaped = false;
            else if (character === '\\')
                escaped = true;
            else if (character === '"')
                string = false;
        }
        else if (character === '"') {
            string = true;
            normalized += character;
        }
        else if (character === ',') {
            let cursor = index + 1;
            while (/\s/.test(result.charAt(cursor)))
                cursor += 1;
            if (result[cursor] !== '}' && result[cursor] !== ']')
                normalized += character;
        }
        else {
            normalized += character;
        }
    }
    return normalized;
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
async function loadJsonConfig(file: string, { jsonc = false }: { jsonc?: boolean } = {}): Promise<Record<string, unknown> | null> {
    const source = await readBoundedConfig(file);
    if (source === null)
        return null;
    const value = JSON.parse(jsonc ? stripJsonc(source) : source);
    const record = recordValue(value);
    if (!record) {
        throw new Error('config root must be an object');
    }
    return record;
}
function mcpAnalysisState(value: unknown, present: boolean): StaticMcpState {
    const analysis = analyzeConfiguredMcp(value);
    return {
        status: present ? 'available' : 'absent',
        basis: 'scope-only',
        categories: countBy(analysis.diagnostics, 'category'),
        notes: analysis.diagnostics.some(entry => entry.category === 'protected')
            ? ['protected namespaces remain explicitly curated; absent administrative tools stay unavailable']
            : [],
    };
}
function minimalMcpConfig(value: Record<string, unknown>): unknown {
    if (!Object.hasOwn(value, 'mcp')) return undefined;
    const mcp = value.mcp;
    if (!isRecord(mcp)) return [];
    const result: Record<string, unknown> = {};
    for (const name of Object.keys(mcp)) {
        const server = mcp[name];
        if (!isRecord(server)) result[name] = null;
        else result[name] = Object.hasOwn(server, 'enabled') ? { enabled: server.enabled } : {};
    }
    return result;
}
function mergeMinimalMcp(globalMcp: unknown, projectMcp: unknown): unknown {
    if (projectMcp === undefined) return globalMcp;
    if (!isRecord(globalMcp) || !isRecord(projectMcp)) return projectMcp;
    const merged: Record<string, unknown> = { ...globalMcp };
    for (const [name, projectServer] of Object.entries(projectMcp)) {
        const globalServer = merged[name];
        if (isRecord(globalServer) && isRecord(projectServer)) merged[name] = { ...globalServer, ...projectServer };
        else merged[name] = projectServer;
    }
    return merged;
}
function publicConfigState(inspection: OpenCodeConfigInspection): OpenCodeConfigState {
    const { mcp: _mcp, ...state } = inspection;
    return state;
}
async function openCodeConfigAt(root: string): Promise<OpenCodeConfigInspection> {
    const candidates = [
        { name: 'opencode.jsonc', jsonc: true },
        { name: 'opencode.json', jsonc: false },
    ];
    const present = [];
    for (const candidate of candidates) {
        const stats = await statOrNull(path.join(root, candidate.name));
        if (stats !== null)
            present.push(candidate);
    }
    if (present.length === 0)
        return { status: 'absent', file: null, depth: null, configuredMcp: mcpAnalysisState(undefined, false), mcp: undefined };
    if (present.length > 1)
        return { status: 'invalid', file: 'ambiguous', depth: null, configuredMcp: mcpAnalysisState(undefined, false), mcp: undefined };
    const selected = present[0];
    if (!selected)
        return { status: 'absent', file: null, depth: null, configuredMcp: mcpAnalysisState(undefined, false), mcp: undefined };
    try {
        const value = await loadJsonConfig(path.join(root, selected.name), { jsonc: selected.jsonc });
        if (!value)
            throw new Error('config root must be an object');
        const depth = Object.hasOwn(value, 'subagent_depth') ? value.subagent_depth : null;
        if (depth !== null && (typeof depth !== 'number' || !Number.isSafeInteger(depth) || depth < 0)) {
            return { status: 'invalid', file: selected.name, depth: null, configuredMcp: mcpAnalysisState(undefined, false), mcp: undefined };
        }
        const mcp = minimalMcpConfig(value);
        return {
            status: 'valid',
            file: selected.name,
            depth,
            configuredMcp: mcpAnalysisState(mcp, Object.hasOwn(value, 'mcp')),
            mcp,
        };
    }
    catch {
        return { status: 'invalid', file: selected.name, depth: null, configuredMcp: mcpAnalysisState(undefined, false), mcp: undefined };
    }
}
export function evaluateDoctorOpenCodeOutput(output: unknown, successful = true): OpenCodeCompatibility {
    const profile = 'stable';
    const recognizedBuilds = COMPATIBILITY_POLICY.profiles.stable.recognizedBuilds;
    const testedBuilds = COMPATIBILITY_POLICY.profiles.stable.testedBuilds;
    const probe: HostContractProbe = { status: 'not-run', checks: [], actions: [], limitation: HOST_CONTRACT_LIMITATION };
    const evaluation = evaluateOpenCodeVersion(profile, output);
    if (!successful || evaluation.status === 'unrecognized')
        return { status: 'unknown', version: null, profile, testedBuilds, recognizedBuilds, versionPolicy: 'invalid', probe };
    const versionPolicy = evaluation.status === 'unsupported' ? 'unsupported'
        : evaluation.exactCurrent ? 'current-target'
            : evaluation.status === 'supported' ? 'historical-tested' : 'candidate';
    return {
        status: evaluation.status === 'unsupported' ? 'unsupported' : evaluation.status === 'supported' ? 'supported' : 'probe-required',
        version: evaluation.observed,
        profile,
        testedBuilds,
        recognizedBuilds,
        versionPolicy,
        probe,
    };
}
function openCodeCompatibility(): OpenCodeCompatibility {
    const profile = 'stable';
    const recognizedBuilds = COMPATIBILITY_POLICY.profiles.stable.recognizedBuilds;
    const testedBuilds = COMPATIBILITY_POLICY.profiles.stable.testedBuilds;
    const probe: HostContractProbe = { status: 'not-run', checks: [], actions: [], limitation: HOST_CONTRACT_LIMITATION };
    const result = spawnSync('opencode', ['--version'], {
        encoding: 'utf8',
        timeout: 2_000,
        maxBuffer: 4 * 1024,
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (result.error && 'code' in result.error && result.error.code === 'ENOENT') {
        return { status: 'not-found', version: null, profile, testedBuilds, recognizedBuilds, versionPolicy: 'invalid', probe };
    }
    if (result.error && 'code' in result.error && result.error.code === 'ETIMEDOUT') {
        return { status: 'timeout', version: null, profile, testedBuilds, recognizedBuilds, versionPolicy: 'invalid', probe };
    }
    return evaluateDoctorOpenCodeOutput(`${result.stdout ?? ''}\n${result.stderr ?? ''}`, result.status === 0);
}

function executableOnPath(name: string): string | null {
    for (const directory of (process.env.PATH ?? '').split(path.delimiter)) {
        if (!directory) continue;
        const candidate = path.join(directory, name);
        try {
            accessSync(candidate, fsConstants.X_OK);
            return realpathSync(candidate);
        }
        catch { /* Try the next PATH entry. */ }
    }
    return null;
}

async function probeHostContract(sourceRoot: string): Promise<HostContractProbe> {
    const executable = executableOnPath('opencode');
    if (executable === null) return { status: 'unavailable', checks: [], actions: [], limitation: HOST_CONTRACT_LIMITATION };
    const temporaryRoot = await realpath(os.tmpdir());
    const root = await mkdtemp(path.join(temporaryRoot, 'naru-doctor-probe-'));
    const home = path.join(root, 'home');
    const globalRoot = path.join(home, '.config', 'opencode');
    const project = path.join(root, 'project');
    const tmp = path.join(root, 'tmp');
    try {
        for (const directory of [home, globalRoot, project, tmp]) await mkdir(directory, { recursive: true, mode: 0o700 });
        await stageHostContractAssets(sourceRoot, globalRoot);
        const marker = await writeHostContractFixtures(globalRoot, project);
        const env = {
            CI: '1', HOME: home, LANG: 'C', LC_ALL: 'C', NO_COLOR: '1', OPENCODE_DISABLE_AUTOUPDATE: 'true',
            PATH: [path.dirname(executable), path.dirname(process.execPath), '/usr/bin', '/bin'].join(path.delimiter),
            TEMP: tmp, TERM: 'dumb', TMP: tmp, TMPDIR: tmp,
            XDG_CACHE_HOME: path.join(root, 'cache'), XDG_CONFIG_HOME: path.join(home, '.config'),
            XDG_DATA_HOME: path.join(root, 'data'), XDG_STATE_HOME: path.join(root, 'state'),
        };
        for (const directory of [env.XDG_CACHE_HOME, env.XDG_CONFIG_HOME, env.XDG_DATA_HOME, env.XDG_STATE_HOME]) {
            await mkdir(directory, { recursive: true, mode: 0o700 });
        }
        const result = await runHostContractProbe({ executable, cwd: project, env, marker, timeoutMs: HOST_CONTRACT_TIMEOUT_MS });
        return {
            status: result.status,
            checks: [{ id: 'mcp-contract', status: result.status, diagnostic: result.diagnostic }],
            actions: result.observations.map(item => `${item.agent}:${item.action}:${item.effect}`),
            limitation: HOST_CONTRACT_LIMITATION,
        };
    }
    catch {
        return { status: 'unavailable', checks: [], actions: [], limitation: HOST_CONTRACT_LIMITATION };
    }
    finally {
        await guardedRemoveDisposableRoot(root);
    }
}
function addIssue(issues: DoctorIssue[], code: string, scope: string, detail: string): void {
    if (issues.length >= MAX_ISSUES)
        return;
    issues.push({ code, scope, detail });
}
function canonicalCandidate(value: string): string {
    try {
        return realpathSync(value);
    }
    catch {
        return path.resolve(value);
    }
}
function scopeCandidates(options: DoctorOptions): ScopeCandidate[] {
    const globalTarget = canonicalCandidate(path.join(os.homedir(), '.config', 'opencode'));
    const projectTarget = canonicalCandidate(path.join(options.projectRoot, '.opencode'));
    const candidates = [
        { id: 'global', loadState: 'automatic', target: globalTarget },
        { id: 'project', loadState: 'automatic-for-project-root', target: projectTarget },
    ];
    if (options.customDir !== null) {
        candidates.push({ id: 'custom', loadState: 'explicit-unconfirmed', target: canonicalCandidate(options.customDir) });
    }
    else {
        const ownTarget = canonicalCandidate(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
        if (ownTarget !== globalTarget && ownTarget !== projectTarget) {
            candidates.push({ id: 'custom-self', loadState: 'installed-script-unconfirmed', target: ownTarget });
        }
    }
    const seen = new Set();
    return candidates.filter(candidate => {
        const key = canonicalCandidate(candidate.target);
        if (seen.has(key))
            return false;
        seen.add(key);
        candidate.target = key;
        return true;
    });
}
function countBy<T, K extends keyof T>(values: readonly T[], field: K): Record<string, number> {
    const counts: Record<string, number> = {};
    for (const value of values) {
        const key = String(value[field]);
        counts[key] = (counts[key] ?? 0) + 1;
    }
    return counts;
}
async function runtimeState(target: string): Promise<RuntimeState> {
    const file = path.join(target, 'naru-runtime.json');
    if (await statOrNull(file) === null) {
        return { status: 'default', workspaceMode: 'auto', configuredMcpTools: 'off', reviewProfile: 'standard', reviewDecision: 'comment-only', reviewOutput: 'detailed' };
    }
    try {
        const value = await loadRuntimeConfigFile(file);
        // The dispatch plugin fails open on a malformed models block, which
        // silently removes every variant. Surface that here instead.
        let modelClasses = null;
        let modelsError = null;
        if (value.models !== undefined) {
            try {
                modelClasses = Object.keys(parseModelsConfig(value.models)).sort();
            }
            catch (error) {
                modelsError = error instanceof Error ? error.message : String(error);
            }
        }
        return {
            status: 'custom-valid',
            workspaceMode: value.implementation.workspaceMode,
            configuredMcpTools: value.mcp.configuredTools,
            reviewProfile: value.review.defaultProfile,
            reviewDecision: value.review.defaultDecision,
            reviewOutput: value.review.defaultOutput,
            modelClasses,
            modelsError,
        };
    }
    catch {
        return { status: 'invalid', workspaceMode: null, configuredMcpTools: null, reviewProfile: null, reviewDecision: null, reviewOutput: null, modelClasses: null, modelsError: null };
    }
}
async function inspectScope(candidate: ScopeCandidate, options: DoctorOptions, issues: DoctorIssue[]): Promise<ScopeReport> {
    let manifest;
    try {
        manifest = await loadInstallManifest(candidate.target);
    }
    catch {
        addIssue(issues, 'invalid-install-manifest', candidate.id, `${INSTALL_MANIFEST_FILE} is invalid`);
        return {
            id: candidate.id,
            loadState: candidate.loadState,
            installed: true,
            manifestStatus: 'invalid',
            sourceVersion: null,
            locationMode: null,
            installMode: null,
            options: null,
            assets: null,
            issuePaths: [],
            configuredMcpPolicy: 'unknown',
            runtime: await runtimeState(candidate.target),
        };
    }
    if (manifest === null) {
        return {
            id: candidate.id,
            loadState: candidate.loadState,
            installed: false,
            manifestStatus: 'absent',
            sourceVersion: null,
            locationMode: null,
            installMode: null,
            options: null,
            assets: null,
            issuePaths: [],
            configuredMcpPolicy: 'untracked',
            runtime: await runtimeState(candidate.target),
        };
    }
    let sourceRoot;
    let inspected;
    try {
        sourceRoot = options.sourceRoot ?? await inferInstallSourceRoot(candidate.target, manifest);
        inspected = await inspectInstallManifest({
            targetRoot: candidate.target,
            manifest,
            sourceRoot,
        });
    }
    catch {
        addIssue(issues, 'managed-asset-inspection-failed', candidate.id, 'managed assets could not be inspected within safety limits');
        return {
            id: candidate.id,
            loadState: candidate.loadState,
            installed: true,
            manifestStatus: 'valid',
            sourceVersion: manifest.sourceVersion,
            locationMode: manifest.locationMode,
            installMode: manifest.installMode,
            options: manifest.options,
            assets: {
                total: manifest.managed.length,
                installed: {},
                source: {},
                sourceCompared: false,
                inspectionStatus: 'failed',
            },
            issuePaths: [],
            configuredMcpPolicy: 'unknown',
            runtime: await runtimeState(candidate.target),
        };
    }
    const installedCounts = countBy(inspected, 'installedStatus');
    const sourceCounts = countBy(inspected, 'sourceStatus');
    const issuePaths = inspected
        .filter(entry => entry.installedStatus !== 'healthy' || entry.sourceStatus === 'copy-stale' || entry.sourceStatus === 'missing')
        .slice(0, MAX_REPORTED_PATHS)
        .map(entry => entry.path);
    if ((installedCounts.missing ?? 0) > 0)
        addIssue(issues, 'managed-assets-missing', candidate.id, 'one or more managed assets are missing');
    if ((installedCounts.modified ?? 0) > 0)
        addIssue(issues, 'managed-assets-modified', candidate.id, 'one or more managed assets changed after installation');
    if ((sourceCounts['copy-stale'] ?? 0) > 0)
        addIssue(issues, 'copy-pinned-assets-stale', candidate.id, 'copy-pinned assets differ from the selected source');
    if ((sourceCounts['copy-stale'] ?? 0) > 0 && inspected.some(entry => entry.method === 'symlink')) {
        addIssue(issues, 'mixed-generation-install', candidate.id, 'live symlinks and copy-pinned assets are from different source generations');
    }
    const mcpPolicyPaths = new Set(['plugins/naru-dispatch.js', 'tools/naru-lib']);
    const configuredMcpPolicy = inspected.filter(entry => mcpPolicyPaths.has(entry.path)).every(entry => entry.installedStatus === 'healthy') &&
        inspected.filter(entry => mcpPolicyPaths.has(entry.path)).length === mcpPolicyPaths.size ? 'installed' : 'incomplete';
    const runtime = await runtimeState(candidate.target);
    if (runtime.status === 'invalid')
        addIssue(issues, 'invalid-runtime-config', candidate.id, 'naru-runtime.json is invalid');
    if (runtime.modelsError)
        addIssue(issues, 'invalid-models-block', candidate.id, 'models block is invalid, so no agent variants are generated: ' + runtime.modelsError);
    return {
        id: candidate.id,
        loadState: candidate.loadState,
        installed: true,
        manifestStatus: 'valid',
        sourceVersion: manifest.sourceVersion,
        locationMode: manifest.locationMode,
        installMode: manifest.installMode,
        options: manifest.options,
        assets: {
            total: inspected.length,
            installed: installedCounts,
            source: sourceCounts,
            sourceCompared: sourceRoot !== null,
            inspectionStatus: 'complete',
        },
        issuePaths,
        configuredMcpPolicy,
        runtime,
    };
}
async function depthState(options: DoctorOptions, issues: DoctorIssue[]): Promise<DepthReport> {
    const globalRoot = path.join(os.homedir(), '.config', 'opencode');
    const global = await openCodeConfigAt(globalRoot);
    const project = await openCodeConfigAt(options.projectRoot);
    const custom = options.customDir === null ? null : await openCodeConfigAt(options.customDir);
    if (global.status === 'invalid')
        addIssue(issues, 'invalid-opencode-config', 'global', 'global OpenCode config is invalid or ambiguous');
    if (project.status === 'invalid')
        addIssue(issues, 'invalid-opencode-config', 'project', 'project OpenCode config is invalid or ambiguous');
    if (custom?.status === 'invalid')
        addIssue(issues, 'invalid-opencode-config', 'custom', 'custom OpenCode config is invalid or ambiguous');
    let configuredMcp: EffectiveMcpState = {
        status: 'unknown',
        source: 'global/project config invalid',
        toolInventory: 'unknown',
        categories: {},
        notes: ['effective configured MCP policy could not be derived'],
    };
    if (global.status !== 'invalid' && project.status !== 'invalid') {
        const analysis = analyzeConfiguredMcp(mergeMinimalMcp(global.mcp, project.mcp));
        configuredMcp = {
            status: 'known',
            source: 'global+project deep merge',
            toolInventory: 'unknown',
            categories: countBy(analysis.diagnostics, 'category'),
            notes: analysis.diagnostics.some(entry => entry.category === 'protected')
                ? ['protected namespaces remain explicitly curated; absent administrative tools stay unavailable']
                : [],
        };
        if ((configuredMcp.categories.collision ?? 0) > 0)
            addIssue(issues, 'configured-mcp-collision', 'effective', 'merged configured MCP namespaces collide; affected generated rules fail closed');
        if ((configuredMcp.categories.malformed ?? 0) > 0)
            addIssue(issues, 'configured-mcp-malformed', 'effective', 'one or more merged MCP server entries are malformed');
    }
    let effective: number | null = 1;
    let source = 'opencode-default';
    let status: 'known' | 'unknown' = 'known';
    if (global.status === 'invalid' || project.status === 'invalid') {
        effective = null;
        source = 'unknown';
        status = 'unknown';
    }
    else {
        if (global.depth !== null) {
            effective = global.depth;
            source = `global:${global.file}`;
        }
        if (project.depth !== null) {
            effective = project.depth;
            source = `project:${project.file}`;
        }
        if (effective < 1)
            addIssue(issues, 'subagent-depth-too-low', 'effective', 'effective subagent_depth must be at least 1');
    }
    return { status, effective, source, global: publicConfigState(global), project: publicConfigState(project), custom: custom ? publicConfigState(custom) : null, configuredMcp };
}
export async function buildDoctorReport(options: DoctorOptions): Promise<DoctorReport> {
    if (!options.legacy) return buildNativeDoctorReport(options);
    const issues: DoctorIssue[] = [];
    const bun = recordValue(Reflect.get(globalThis, 'Bun'));
    const bunVersion = typeof bun?.version === 'string' ? bun.version : '';
    const compatibility: DoctorReport['compatibility'] = {
        opencode: openCodeCompatibility(),
        runtime: {
            name: bun ? 'bun' : 'node',
            version: bun ? bunVersion : process.versions.node,
        },
    };
    if ((compatibility.opencode.status === 'supported' || compatibility.opencode.status === 'probe-required') && options.hostContractRoot) {
        compatibility.opencode.probe = await probeHostContract(options.hostContractRoot);
        compatibility.opencode.status = compatibility.opencode.probe.status === 'passed' ? 'local-tested'
            : compatibility.opencode.probe.status === 'failed' ? 'contract-failed' : 'probe-required';
    }
    if (compatibility.opencode.status !== 'local-tested') {
        const detail = compatibility.opencode.status === 'contract-failed'
            ? `bounded host contract failed: ${compatibility.opencode.probe.checks.filter(check => check.status === 'failed').map(check => `${check.id}:${check.diagnostic}`).join(', ')}`
            : compatibility.opencode.status === 'probe-required' || compatibility.opencode.status === 'supported'
                ? 'stable OpenCode requires a successful current bounded host-contract probe'
                : `stable OpenCode ${COMPATIBILITY_POLICY.release.opencode.floor} or newer was not confirmed`;
        addIssue(issues, 'opencode-compatibility', 'host', detail);
    }
    const depth = await depthState(options, issues);
    const scopes: ScopeReport[] = [];
    for (const candidate of scopeCandidates(options)) {
        scopes.push(await inspectScope(candidate, options, issues));
    }
    if (!scopes.some(scope => scope.installed && scope.manifestStatus === 'valid')) {
        addIssue(issues, 'no-valid-installation', 'host', 'no valid manifest-backed Naru installation was found');
    }
    return {
        schemaVersion: REPORT_SCHEMA_VERSION,
        diagnostic: 'naru-doctor',
        providerFree: true,
        readOnly: true,
        status: issues.length === 0 ? 'healthy' : 'warning',
        compatibility,
        depth,
        scopes,
        issues,
    };
}
async function buildNativeDoctorReport(options: DoctorOptions): Promise<DoctorReport> {
    const root = options.customDir ?? defaultNativeConfigRoot();
    const paths = getNativeInstallPaths(root);
    const issues: DoctorIssue[] = [];
    const native: NonNullable<DoctorReport['native']> = { installed: false, package: 'absent', agents: 'absent', registration: 'absent', workers: 0, runtimeEvidence: 'not-run' };
    const host = spawnSync('opencode', ['--version'], { encoding: 'utf8', timeout: 2_000, maxBuffer: 4096, stdio: ['ignore', 'pipe', 'pipe'] });
    const evaluation = evaluateOpenCodeVersion('native-v2', host.status === 0 ? `${host.stdout ?? ''}\n${host.stderr ?? ''}` : '');
    const exact = evaluation.status === 'supported', accepted = exact || evaluation.status === 'candidate';
    const probe: HostContractProbe = { status: 'not-run', checks: [], actions: [], limitation: 'Native runtime, platform, provider entitlement and live agent invocation were not tested by this read-only doctor.' };
    const compatibility: DoctorReport['compatibility'] = {
        opencode: { status: accepted ? 'probe-required' : host.error && 'code' in host.error && host.error.code === 'ENOENT' ? 'not-found' : 'unsupported', version: evaluation.observed, profile: 'native-v2', testedBuilds: [], recognizedBuilds: ['2.0.15'], versionPolicy: exact ? 'current-target' : accepted ? 'candidate' : 'unsupported', probe },
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
    const emptyMcp: StaticMcpState = { status: 'absent', basis: 'scope-only', categories: {}, notes: [] };
    const absent: OpenCodeConfigState = { status: 'absent', file: null, depth: null, configuredMcp: emptyMcp };
    return { schemaVersion: REPORT_SCHEMA_VERSION, diagnostic: 'naru-doctor', providerFree: true, readOnly: true, status: issues.length ? 'warning' : 'healthy', compatibility, native,
        depth: { status: 'unknown', effective: null, source: 'native-v2-no-v1-depth-contract', global: absent, project: absent, custom: null, configuredMcp: { status: 'unknown', source: 'native-v2', toolInventory: 'unknown', categories: {}, notes: [] } }, scopes: [], issues };
}
export async function buildStaticDoctorReport(options: DoctorOptions): Promise<DoctorReport> {
    return buildDoctorReport({ ...options, hostContractRoot: null });
}
function renderPlain(report: DoctorReport): string {
    if (report.native) return `Naru native doctor: ${report.status}\nOpenCode: ${report.compatibility.opencode.version ?? 'unknown'} (2.0.15 tested; 2.0.x patch accepted)\nNative package: ${report.native.package}; agents: ${report.native.agents}; registration: ${report.native.registration}; workers: ${report.native.workers}\nRuntime evidence: not run; platform, live invocation and account entitlement are not qualified\n${report.issues.map(issue => `${issue.code}: ${issue.detail}\n`).join('')}`;
    const lines = [
        `Naru doctor: ${report.status}`,
        `OpenCode: ${report.compatibility.opencode.status}${report.compatibility.opencode.version ? ` (${report.compatibility.opencode.version})` : ''}; version evidence ${report.compatibility.opencode.versionPolicy}; tested history ${report.compatibility.opencode.testedBuilds.join(', ')}`,
        `Host contract probe: ${report.compatibility.opencode.probe.status}; ${report.compatibility.opencode.probe.limitation}`,
        `Runtime: ${report.compatibility.runtime.name} ${report.compatibility.runtime.version}`,
        `Effective subagent_depth: ${report.depth.effective ?? 'unknown'} (${report.depth.source})`,
    ];
    for (const scope of report.scopes) {
        if (!scope.installed) {
            lines.push(`${scope.id}: not installed (${scope.loadState})`);
            continue;
        }
        lines.push(`${scope.id}: ${scope.manifestStatus} ${scope.locationMode ?? 'unknown'}/${scope.installMode ?? 'unknown'} ${scope.sourceVersion ?? ''}`.trim());
        if (scope.assets !== null) {
            lines.push(`  assets: ${scope.assets.installed.healthy ?? 0}/${scope.assets.total} healthy; source comparison ${scope.assets.sourceCompared ? 'available' : 'unavailable'}`);
        }
        lines.push(`  runtime: ${scope.runtime.status}; workspace mode: ${scope.runtime.workspaceMode ?? 'unknown'}; configured MCP tools: ${scope.runtime.configuredMcpTools ?? 'unknown'}; MCP policy hook: ${scope.configuredMcpPolicy}; review: ${scope.runtime.reviewProfile ?? 'unknown'}/${scope.runtime.reviewDecision ?? 'unknown'}/${scope.runtime.reviewOutput ?? 'unknown'}; model classes: ${scope.runtime.modelsError ? 'INVALID' : (scope.runtime.modelClasses ? scope.runtime.modelClasses.join(', ') : 'none')}`);
        if (scope.issuePaths.length > 0)
            lines.push(`  issue paths: ${scope.issuePaths.join(', ')}`);
    }
    for (const [scope, state] of [['global', report.depth.global], ['project', report.depth.project], ['custom', report.depth.custom]] as const) {
        if (!state || state.configuredMcp.status === 'absent') continue;
        const categories = Object.entries(state.configuredMcp.categories).map(([category, count]) => `${category}=${count}`).join(', ') || 'none';
        lines.push(`${scope} raw MCP config: ${categories}; scope-only, not an effective policy result`);
        for (const note of state.configuredMcp.notes) lines.push(`  ${note}`);
    }
    const effectiveCategories = Object.entries(report.depth.configuredMcp.categories).map(([category, count]) => `${category}=${count}`).join(', ') || 'none';
    lines.push(`Merged global/project MCP config: ${report.depth.configuredMcp.status}; ${effectiveCategories}; registered tool inventory unknown`);
    for (const note of report.depth.configuredMcp.notes) lines.push(`  ${note}`);
    if (report.issues.length > 0) {
        lines.push('Issues:');
        for (const issue of report.issues)
            lines.push(`  ${issue.code} [${issue.scope}]: ${issue.detail}`);
    }
    lines.push('Read-only local inspection; the isolated fixture plugin and loopback synthetic provider probe uses no external provider, credentials, account, real user configuration, user-state mutations, or uploads.');
    return `${lines.join('\n')}\n`;
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
