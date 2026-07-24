#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { constants as fsConstants, realpathSync } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  INSTALL_MANIFEST_FILE,
  inferInstallSourceRoot,
  inspectInstallManifest,
  loadInstallManifest,
} from './naru-lib/install-manifest.mjs';
import { parseRoutingOverrides } from './naru-lib/model-routing.mjs';
import { loadRuntimeConfigFile } from './naru-lib/scheduler-config.mjs';

const REPORT_SCHEMA_VERSION = 1;
const MIN_OPENCODE_VERSION = '1.18.4';
const MAX_CONFIG_BYTES = 64 * 1024;
const MAX_ISSUES = 32;
const MAX_REPORTED_PATHS = 10;

function usage() {
  return `Usage: node tools/naru-doctor.js [--dir PATH] [--project-root PATH] [--source PATH] [--json]\n\n` +
    'Reads local installation and configuration state only. It never loads plugins, credentials, providers, or remote services.\n';
}

function parseArgs(argv) {
  const options = {
    customDir: null,
    projectRoot: process.cwd(),
    sourceRoot: null,
    json: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--json') options.json = true;
    else if (argument === '--dir' || argument === '--project-root' || argument === '--source') {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith('-')) throw new Error(`${argument} requires a PATH`);
      index += 1;
      if (argument === '--dir') options.customDir = path.resolve(value);
      else if (argument === '--project-root') options.projectRoot = path.resolve(value);
      else options.sourceRoot = path.resolve(value);
    } else if (argument === '--help' || argument === '-h') {
      options.help = true;
    } else {
      throw new Error(`unknown option: ${argument}`);
    }
  }
  return options;
}

async function statOrNull(value) {
  try {
    return await lstat(value);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

function stripJsonc(source) {
  let result = '';
  let string = false;
  let escaped = false;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    const next = source[index + 1];
    if (string) {
      result += character;
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') string = false;
    } else if (character === '"') {
      string = true;
      result += character;
    } else if (character === '/' && next === '/') {
      result += '  ';
      index += 1;
      while (index + 1 < source.length && source[index + 1] !== '\n') {
        result += ' ';
        index += 1;
      }
    } else if (character === '/' && next === '*') {
      result += '  ';
      index += 1;
      while (index + 1 < source.length && !(source[index + 1] === '*' && source[index + 2] === '/')) {
        index += 1;
        result += source[index] === '\n' ? '\n' : ' ';
      }
      if (index + 2 >= source.length) throw new Error('unterminated block comment');
      result += '  ';
      index += 2;
    } else {
      result += character;
    }
  }
  if (string) throw new Error('unterminated string');

  let normalized = '';
  string = false;
  escaped = false;
  for (let index = 0; index < result.length; index += 1) {
    const character = result[index];
    if (string) {
      normalized += character;
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') string = false;
    } else if (character === '"') {
      string = true;
      normalized += character;
    } else if (character === ',') {
      let cursor = index + 1;
      while (/\s/.test(result[cursor])) cursor += 1;
      if (result[cursor] !== '}' && result[cursor] !== ']') normalized += character;
    } else {
      normalized += character;
    }
  }
  return normalized;
}

async function readBoundedConfig(file) {
  const stats = await statOrNull(file);
  if (stats === null) return null;
  if (stats.isSymbolicLink() || !stats.isFile() || stats.size > MAX_CONFIG_BYTES) {
    throw new Error('unsafe config file');
  }
  const handle = await open(file, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.size > MAX_CONFIG_BYTES) throw new Error('unsafe config file');
    return await handle.readFile({ encoding: 'utf8' });
  } finally {
    await handle.close();
  }
}

async function loadJsonConfig(file, { jsonc = false } = {}) {
  const source = await readBoundedConfig(file);
  if (source === null) return null;
  const value = JSON.parse(jsonc ? stripJsonc(source) : source);
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('config root must be an object');
  }
  return value;
}

async function openCodeConfigAt(root) {
  const candidates = [
    { name: 'opencode.jsonc', jsonc: true },
    { name: 'opencode.json', jsonc: false },
  ];
  const present = [];
  for (const candidate of candidates) {
    const stats = await statOrNull(path.join(root, candidate.name));
    if (stats !== null) present.push(candidate);
  }
  if (present.length === 0) return { status: 'absent', file: null, depth: null };
  if (present.length > 1) return { status: 'invalid', file: 'ambiguous', depth: null };
  const selected = present[0];
  try {
    const value = await loadJsonConfig(path.join(root, selected.name), { jsonc: selected.jsonc });
    const depth = Object.hasOwn(value, 'subagent_depth') ? value.subagent_depth : null;
    if (depth !== null && (!Number.isSafeInteger(depth) || depth < 0)) {
      return { status: 'invalid', file: selected.name, depth: null };
    }
    return { status: 'valid', file: selected.name, depth };
  } catch {
    return { status: 'invalid', file: selected.name, depth: null };
  }
}

function compareVersions(left, right) {
  const a = left.split('.').map(Number);
  const b = right.split('.').map(Number);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference !== 0) return Math.sign(difference);
  }
  return 0;
}

function openCodeCompatibility() {
  const result = spawnSync('opencode', ['--version'], {
    encoding: 'utf8',
    timeout: 2_000,
    maxBuffer: 4 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.error?.code === 'ENOENT') {
    return { status: 'not-found', version: null, minimum: MIN_OPENCODE_VERSION };
  }
  if (result.error?.code === 'ETIMEDOUT') {
    return { status: 'timeout', version: null, minimum: MIN_OPENCODE_VERSION };
  }
  const match = `${result.stdout ?? ''}\n${result.stderr ?? ''}`.match(/\b(\d+\.\d+\.\d+)\b/);
  if (result.status !== 0 || match === null) {
    return { status: 'unknown', version: null, minimum: MIN_OPENCODE_VERSION };
  }
  const version = match[1];
  return {
    status: compareVersions(version, MIN_OPENCODE_VERSION) >= 0 ? 'supported' : 'unsupported',
    version,
    minimum: MIN_OPENCODE_VERSION,
  };
}

function addIssue(issues, code, scope, detail) {
  if (issues.length >= MAX_ISSUES) return;
  issues.push({ code, scope, detail });
}

function canonicalCandidate(value) {
  try {
    return realpathSync(value);
  } catch {
    return path.resolve(value);
  }
}

function scopeCandidates(options) {
  const globalTarget = canonicalCandidate(path.join(os.homedir(), '.config', 'opencode'));
  const projectTarget = canonicalCandidate(path.join(options.projectRoot, '.opencode'));
  const candidates = [
    { id: 'global', loadState: 'automatic', target: globalTarget },
    { id: 'project', loadState: 'automatic-for-project-root', target: projectTarget },
  ];
  if (options.customDir !== null) {
    candidates.push({ id: 'custom', loadState: 'explicit-unconfirmed', target: canonicalCandidate(options.customDir) });
  } else {
    const ownTarget = canonicalCandidate(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
    if (ownTarget !== globalTarget && ownTarget !== projectTarget) {
      candidates.push({ id: 'custom-self', loadState: 'installed-script-unconfirmed', target: ownTarget });
    }
  }
  const seen = new Set();
  return candidates.filter(candidate => {
    const key = canonicalCandidate(candidate.target);
    if (seen.has(key)) return false;
    seen.add(key);
    candidate.target = key;
    return true;
  });
}

function countBy(values, field) {
  const counts = {};
  for (const value of values) counts[value[field]] = (counts[value[field]] ?? 0) + 1;
  return counts;
}

async function routingState(target) {
  const file = path.join(target, 'naru-models.json');
  if (await statOrNull(file) === null) return { status: 'default', schemaVersion: null };
  try {
    const value = await loadJsonConfig(file);
    const parsed = parseRoutingOverrides(value);
    return { status: 'custom-valid', schemaVersion: parsed.schemaVersion };
  } catch {
    return { status: 'invalid', schemaVersion: null };
  }
}

async function runtimeState(target) {
  const file = path.join(target, 'naru-runtime.json');
  if (await statOrNull(file) === null) {
    return { status: 'default', schedulerMode: 'off', workspaceMode: 'auto' };
  }
  try {
    const value = await loadRuntimeConfigFile(file);
    return {
      status: 'custom-valid',
      schedulerMode: value.scheduler.mode,
      workspaceMode: value.implementation.workspaceMode,
    };
  } catch {
    return { status: 'invalid', schedulerMode: null, workspaceMode: null };
  }
}

function dashboardEntryMatches(entry) {
  const candidate = Array.isArray(entry) ? entry[0] : entry;
  return typeof candidate === 'string'
    && candidate.replaceAll('\\', '/').replace(/^\.\//, '') === 'plugins/naru-minions-dashboard.tsx';
}

async function dashboardState(target) {
  const plugin = await statOrNull(path.join(target, 'plugins', 'naru-minions-dashboard.tsx'));
  const installed = plugin?.isFile() === true;
  let registered = false;
  let configStatus = 'absent';
  const candidates = [
    { name: 'tui.jsonc', jsonc: true },
    { name: 'tui.json', jsonc: false },
  ];
  for (const candidate of candidates) {
    const file = path.join(target, candidate.name);
    if (await statOrNull(file) === null) continue;
    try {
      const value = await loadJsonConfig(file, { jsonc: candidate.jsonc });
      configStatus = 'valid';
      if (Array.isArray(value.plugin) && value.plugin.some(dashboardEntryMatches)) registered = true;
    } catch {
      configStatus = 'invalid';
    }
  }
  return { installed, registered, configStatus };
}

async function inspectScope(candidate, options, issues) {
  let manifest;
  try {
    manifest = await loadInstallManifest(candidate.target);
  } catch {
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
      routing: await routingState(candidate.target),
      runtime: await runtimeState(candidate.target),
      dashboard: await dashboardState(candidate.target),
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
      routing: await routingState(candidate.target),
      runtime: await runtimeState(candidate.target),
      dashboard: await dashboardState(candidate.target),
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
  } catch {
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
      routing: await routingState(candidate.target),
      runtime: await runtimeState(candidate.target),
      dashboard: await dashboardState(candidate.target),
    };
  }
  const installedCounts = countBy(inspected, 'installedStatus');
  const sourceCounts = countBy(inspected, 'sourceStatus');
  const issuePaths = inspected
    .filter(entry => entry.installedStatus !== 'healthy' || entry.sourceStatus === 'copy-stale' || entry.sourceStatus === 'missing')
    .slice(0, MAX_REPORTED_PATHS)
    .map(entry => entry.path);
  if ((installedCounts.missing ?? 0) > 0) addIssue(issues, 'managed-assets-missing', candidate.id, 'one or more managed assets are missing');
  if ((installedCounts.modified ?? 0) > 0) addIssue(issues, 'managed-assets-modified', candidate.id, 'one or more managed assets changed after installation');
  if ((sourceCounts['copy-stale'] ?? 0) > 0) addIssue(issues, 'copy-pinned-assets-stale', candidate.id, 'copy-pinned assets differ from the selected source');
  if ((sourceCounts['copy-stale'] ?? 0) > 0 && inspected.some(entry => entry.method === 'symlink')) {
    addIssue(issues, 'mixed-generation-install', candidate.id, 'live symlinks and copy-pinned assets are from different source generations');
  }

  const routing = await routingState(candidate.target);
  const runtime = await runtimeState(candidate.target);
  const dashboard = await dashboardState(candidate.target);
  if (routing.status === 'invalid') addIssue(issues, 'invalid-routing-config', candidate.id, 'naru-models.json is invalid');
  if (runtime.status === 'invalid') addIssue(issues, 'invalid-runtime-config', candidate.id, 'naru-runtime.json is invalid');
  if (dashboard.configStatus === 'invalid') addIssue(issues, 'invalid-dashboard-config', candidate.id, 'a TUI config is invalid');
  if (dashboard.installed !== dashboard.registered) addIssue(issues, 'dashboard-registration-mismatch', candidate.id, 'dashboard installation and registration do not match');

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
    routing,
    runtime,
    dashboard,
  };
}

async function depthState(options, issues) {
  const globalRoot = path.join(os.homedir(), '.config', 'opencode');
  const global = await openCodeConfigAt(globalRoot);
  const project = await openCodeConfigAt(options.projectRoot);
  const custom = options.customDir === null ? null : await openCodeConfigAt(options.customDir);
  if (global.status === 'invalid') addIssue(issues, 'invalid-opencode-config', 'global', 'global OpenCode config is invalid or ambiguous');
  if (project.status === 'invalid') addIssue(issues, 'invalid-opencode-config', 'project', 'project OpenCode config is invalid or ambiguous');
  if (custom?.status === 'invalid') addIssue(issues, 'invalid-opencode-config', 'custom', 'custom OpenCode config is invalid or ambiguous');

  let effective = 1;
  let source = 'opencode-default';
  let status = 'known';
  if (global.status === 'invalid' || project.status === 'invalid') {
    effective = null;
    source = 'unknown';
    status = 'unknown';
  } else {
    if (global.depth !== null) {
      effective = global.depth;
      source = `global:${global.file}`;
    }
    if (project.depth !== null) {
      effective = project.depth;
      source = `project:${project.file}`;
    }
    if (effective < 1) addIssue(issues, 'subagent-depth-too-low', 'effective', 'effective subagent_depth must be at least 1');
  }
  return { status, effective, source, global, project, custom };
}

export async function buildDoctorReport(options) {
  const issues = [];
  const compatibility = {
    opencode: openCodeCompatibility(),
    runtime: {
      name: typeof globalThis.Bun === 'object' ? 'bun' : 'node',
      version: typeof globalThis.Bun === 'object' ? globalThis.Bun.version : process.versions.node,
    },
  };
  if (compatibility.opencode.status !== 'supported') {
    addIssue(issues, 'opencode-compatibility', 'host', `OpenCode ${MIN_OPENCODE_VERSION} or later was not confirmed`);
  }
  const depth = await depthState(options, issues);
  const scopes = [];
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

function renderPlain(report) {
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
    lines.push(`  routing: ${scope.routing.status}; scheduler: ${scope.runtime.schedulerMode ?? 'unknown'}; dashboard: ${scope.dashboard.installed ? 'installed' : 'not installed'}/${scope.dashboard.registered ? 'registered' : 'not registered'}`);
    if (scope.issuePaths.length > 0) lines.push(`  issue paths: ${scope.issuePaths.join(', ')}`);
  }
  if (report.issues.length > 0) {
    lines.push('Issues:');
    for (const issue of report.issues) lines.push(`  ${issue.code} [${issue.scope}]: ${issue.detail}`);
  }
  lines.push('Provider-free, read-only local inspection; no credentials, plugins, providers, mutations, or uploads.');
  return `${lines.join('\n')}\n`;
}

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`naru-doctor: ${error.message}\n${usage()}`);
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
    if (report.status !== 'healthy') process.exitCode = 1;
  } catch {
    process.stderr.write('naru-doctor: local inspection failed safely; no files were changed\n');
    process.exitCode = 1;
  }
}

const invokedPath = process.argv[1] === undefined ? null : realpathSync(process.argv[1]);
if (invokedPath === realpathSync(fileURLToPath(import.meta.url))) await main();
