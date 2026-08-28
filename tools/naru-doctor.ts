#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { constants as fsConstants, realpathSync } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { INSTALL_MANIFEST_FILE, inferInstallSourceRoot, inspectInstallManifest, loadInstallManifest, } from './naru-lib/install-manifest.mjs';
import type { InstallOptions } from './naru-lib/install-manifest.mjs';
import { loadRuntimeConfigFile } from './naru-lib/runtime-config.mjs';
import { parseModelsConfig } from './naru-lib/dispatch.mjs';
const REPORT_SCHEMA_VERSION = 1;
const MIN_OPENCODE_VERSION = '1.18.4';
const MAX_CONFIG_BYTES = 64 * 1024;
const MAX_ISSUES = 32;
const MAX_REPORTED_PATHS = 10;

export interface DoctorOptions {
    customDir: string | null;
    projectRoot: string;
    sourceRoot: string | null;
    json: boolean;
    help?: boolean;
}
interface DoctorIssue { code: string; scope: string; detail: string }
interface ScopeCandidate { id: string; loadState: string; target: string }
interface OpenCodeConfigState { status: 'absent' | 'invalid' | 'valid'; file: string | null; depth: number | null }
interface RuntimeState { status: 'default' | 'custom-valid' | 'invalid'; workspaceMode: string | null; reviewProfile: string | null; reviewDecision: string | null; reviewOutput: string | null; modelClasses?: string[] | null; modelsError?: string | null }
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
    runtime: RuntimeState;
}
interface DepthReport {
    status: 'known' | 'unknown';
    effective: number | null;
    source: string;
    global: OpenCodeConfigState;
    project: OpenCodeConfigState;
    custom: OpenCodeConfigState | null;
}
interface OpenCodeCompatibility { status: 'not-found' | 'timeout' | 'unknown' | 'supported' | 'unsupported'; version: string | null; minimum: string }
export interface DoctorReport {
    schemaVersion: 1;
    diagnostic: 'naru-doctor';
    providerFree: true;
    readOnly: true;
    status: 'healthy' | 'warning';
    compatibility: { opencode: OpenCodeCompatibility; runtime: { name: 'bun' | 'node'; version: string } };
    depth: DepthReport;
    scopes: ScopeReport[];
    issues: DoctorIssue[];
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
    return `Usage: node tools/naru-doctor.js [--dir PATH] [--project-root PATH] [--source PATH] [--json]\n\n` +
        'Reads local installation and configuration state only. It never loads plugins, credentials, providers, or remote services.\n';
}
function parseArgs(argv: string[]): DoctorOptions {
    const options: DoctorOptions = {
        customDir: null,
        projectRoot: process.cwd(),
        sourceRoot: null,
        json: false,
    };
    for (let index = 0; index < argv.length; index += 1) {
        const argument = argv[index];
        if (argument === '--json')
            options.json = true;
        else if (argument === '--dir' || argument === '--project-root' || argument === '--source') {
            const value = argv[index + 1];
            if (value === undefined || value.startsWith('-'))
                throw new Error(`${argument} requires a PATH`);
            index += 1;
            if (argument === '--dir')
                options.customDir = path.resolve(value);
            else if (argument === '--project-root')
                options.projectRoot = path.resolve(value);
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
async function openCodeConfigAt(root: string): Promise<OpenCodeConfigState> {
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
        return { status: 'absent', file: null, depth: null };
    if (present.length > 1)
        return { status: 'invalid', file: 'ambiguous', depth: null };
    const selected = present[0];
    if (!selected)
        return { status: 'absent', file: null, depth: null };
    try {
        const value = await loadJsonConfig(path.join(root, selected.name), { jsonc: selected.jsonc });
        if (!value)
            throw new Error('config root must be an object');
        const depth = Object.hasOwn(value, 'subagent_depth') ? value.subagent_depth : null;
        if (depth !== null && (typeof depth !== 'number' || !Number.isSafeInteger(depth) || depth < 0)) {
            return { status: 'invalid', file: selected.name, depth: null };
        }
        return { status: 'valid', file: selected.name, depth };
    }
    catch {
        return { status: 'invalid', file: selected.name, depth: null };
    }
}
function compareVersions(left: string, right: string): number {
    const a = left.split('.').map(Number);
    const b = right.split('.').map(Number);
    for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
        const difference = (a[index] ?? 0) - (b[index] ?? 0);
        if (difference !== 0)
            return Math.sign(difference);
    }
    return 0;
}
function openCodeCompatibility(): OpenCodeCompatibility {
    const result = spawnSync('opencode', ['--version'], {
        encoding: 'utf8',
        timeout: 2_000,
        maxBuffer: 4 * 1024,
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (result.error && 'code' in result.error && result.error.code === 'ENOENT') {
        return { status: 'not-found', version: null, minimum: MIN_OPENCODE_VERSION };
    }
    if (result.error && 'code' in result.error && result.error.code === 'ETIMEDOUT') {
        return { status: 'timeout', version: null, minimum: MIN_OPENCODE_VERSION };
    }
    const match = `${result.stdout ?? ''}\n${result.stderr ?? ''}`.match(/\b(\d+\.\d+\.\d+)\b/);
    if (result.status !== 0 || match === null) {
        return { status: 'unknown', version: null, minimum: MIN_OPENCODE_VERSION };
    }
    const version = match[1];
    if (!version)
        return { status: 'unknown', version: null, minimum: MIN_OPENCODE_VERSION };
    return {
        status: compareVersions(version, MIN_OPENCODE_VERSION) >= 0 ? 'supported' : 'unsupported',
        version,
        minimum: MIN_OPENCODE_VERSION,
    };
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
        return { status: 'default', workspaceMode: 'auto', reviewProfile: 'standard', reviewDecision: 'comment-only', reviewOutput: 'detailed' };
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
            reviewProfile: value.review.defaultProfile,
            reviewDecision: value.review.defaultDecision,
            reviewOutput: value.review.defaultOutput,
            modelClasses,
            modelsError,
        };
    }
    catch {
        return { status: 'invalid', workspaceMode: null, reviewProfile: null, reviewDecision: null, reviewOutput: null, modelClasses: null, modelsError: null };
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
    return { status, effective, source, global, project, custom };
}
export async function buildDoctorReport(options: DoctorOptions): Promise<DoctorReport> {
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
    if (compatibility.opencode.status !== 'supported') {
        addIssue(issues, 'opencode-compatibility', 'host', `OpenCode ${MIN_OPENCODE_VERSION} or later was not confirmed`);
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
function renderPlain(report: DoctorReport): string {
    const lines = [
        `Naru doctor: ${report.status}`,
        `OpenCode: ${report.compatibility.opencode.status}${report.compatibility.opencode.version ? ` (${report.compatibility.opencode.version})` : ''}; minimum ${report.compatibility.opencode.minimum}`,
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
        lines.push(`  runtime: ${scope.runtime.status}; workspace mode: ${scope.runtime.workspaceMode ?? 'unknown'}; review: ${scope.runtime.reviewProfile ?? 'unknown'}/${scope.runtime.reviewDecision ?? 'unknown'}/${scope.runtime.reviewOutput ?? 'unknown'}; model classes: ${scope.runtime.modelsError ? 'INVALID' : (scope.runtime.modelClasses ? scope.runtime.modelClasses.join(', ') : 'none')}`);
        if (scope.issuePaths.length > 0)
            lines.push(`  issue paths: ${scope.issuePaths.join(', ')}`);
    }
    if (report.issues.length > 0) {
        lines.push('Issues:');
        for (const issue of report.issues)
            lines.push(`  ${issue.code} [${issue.scope}]: ${issue.detail}`);
    }
    lines.push('Provider-free, read-only local inspection; no credentials, plugins, providers, mutations, or uploads.');
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
