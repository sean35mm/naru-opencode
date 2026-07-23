#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { constants as fsConstants } from 'node:fs';
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  realpath,
  rm,
  symlink,
} from 'node:fs/promises';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  classifyDashboardEvidence,
  createCompatibilityEvidence,
  evaluatePlatformTarget,
  sanitizeObservedVersion,
} from '../tools/naru-lib/compatibility.mjs';

const DEFAULT_TIMEOUT_MS = 20_000;
const MAX_OUTPUT_BYTES = 64 * 1024;
const MAX_AGENT_LIST_OUTPUT_BYTES = 1024 * 1024;
const TERMINATION_GRACE_MS = 1_000;
const CONFIG_MAX_BYTES = 64 * 1024;

export const OPENCODE_SAFE_COMMANDS = Object.freeze([
  Object.freeze({ id: 'opencode-version', args: Object.freeze(['--version']) }),
  Object.freeze({ id: 'opencode-help', args: Object.freeze(['--help']) }),
  Object.freeze({ id: 'opencode-debug-paths', args: Object.freeze(['debug', 'paths']) }),
  Object.freeze({
    id: 'opencode-debug-config',
    args: Object.freeze(['debug', 'config']),
    maxOutputBytes: MAX_AGENT_LIST_OUTPUT_BYTES,
    retainOutput: false,
  }),
  Object.freeze({
    id: 'opencode-agent-list',
    args: Object.freeze(['agent', 'list']),
    maxOutputBytes: MAX_AGENT_LIST_OUTPUT_BYTES,
    retainOutput: false,
  }),
  Object.freeze({ id: 'opencode-startup', args: Object.freeze(['serve', '--hostname', '127.0.0.1', '--port', '<ephemeral>']) }),
]);

function usage() {
  return 'Usage: node scripts/naru-compat-smoke.mjs --opencode PATH --source PATH [--json] [--output PATH] [--dashboard --bun PATH]\n';
}

function parseArgs(argv) {
  const options = { bunPath: null, dashboard: false, json: false, opencodePath: null, output: null, sourcePath: null };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--json') options.json = true;
    else if (argument === '--dashboard') options.dashboard = true;
    else if (['--opencode', '--source', '--output', '--bun'].includes(argument)) {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith('-')) throw new Error(`${argument} requires a value`);
      index += 1;
      if (argument === '--opencode') options.opencodePath = value;
      else if (argument === '--source') options.sourcePath = value;
      else if (argument === '--output') options.output = value;
      else options.bunPath = value;
    } else if (argument === '--help' || argument === '-h') options.help = true;
    else throw new Error(`unknown option: ${argument}`);
  }
  if (!options.help && (!options.opencodePath || !options.sourcePath)) throw new Error('--opencode and --source are required');
  if (options.dashboard !== Boolean(options.bunPath)) throw new Error('--dashboard and --bun PATH must be supplied together');
  return options;
}

async function executablePath(value, label) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 4096 || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error(`${label} path is invalid`);
  }
  const resolved = await realpath(path.resolve(value));
  const stats = await lstat(resolved);
  if (!stats.isFile() || (stats.mode & 0o111) === 0) throw new Error(`${label} must be an executable file`);
  return resolved;
}

async function sourceRoot(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 4096 || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error('source path is invalid');
  }
  const resolved = await realpath(path.resolve(value));
  const stats = await lstat(resolved);
  if (!stats.isDirectory()) throw new Error('source must be a directory');
  const installer = await lstat(path.join(resolved, 'install.sh'));
  if (!installer.isFile() || installer.isSymbolicLink()) throw new Error('source install.sh must be a regular file');
  return resolved;
}

function validateTimeout(value) {
  if (!Number.isSafeInteger(value) || value < 50 || value > 30_000) throw new Error('timeout must be from 50 to 30000 milliseconds');
  return value;
}

function validateOutputLimit(value) {
  if (!Number.isSafeInteger(value) || value < MAX_OUTPUT_BYTES || value > MAX_AGENT_LIST_OUTPUT_BYTES) {
    throw new Error(`output limit must be from ${MAX_OUTPUT_BYTES} to ${MAX_AGENT_LIST_OUTPUT_BYTES} bytes`);
  }
  return value;
}

function isolatedEnvironment(root, privateBin) {
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

function waitForExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise(resolve => {
    const timer = setTimeout(() => {
      child.removeListener('exit', onExit);
      resolve(false);
    }, timeoutMs);
    function onExit() {
      clearTimeout(timer);
      resolve(true);
    }
    child.once('exit', onExit);
  });
}

function signalChild(child, signal) {
  try {
    process.kill(-child.pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      // The process already exited.
    }
  }
}

async function stopChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  signalChild(child, 'SIGTERM');
  if (await waitForExit(child, TERMINATION_GRACE_MS)) return;
  signalChild(child, 'SIGKILL');
  await waitForExit(child, 250);
}

export async function runBoundedProcess(executable, args, {
  cwd,
  env,
  maxOutputBytes = MAX_OUTPUT_BYTES,
  retainOutput = true,
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  validateTimeout(timeoutMs);
  validateOutputLimit(maxOutputBytes);
  const started = Date.now();
  let output = Buffer.alloc(0);
  let outputBytes = 0;
  let overflow = false;
  let spawnError = false;
  const child = spawn(executable, args, {
    cwd,
    detached: true,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const append = chunk => {
    if (overflow) return;
    outputBytes += chunk.length;
    if (retainOutput) output = Buffer.concat([output, Buffer.from(chunk)]);
    if (outputBytes > maxOutputBytes) {
      overflow = true;
      output = output.subarray(0, maxOutputBytes);
      signalChild(child, 'SIGTERM');
    }
  };
  child.stdout.on('data', append);
  child.stderr.on('data', append);
  const exited = new Promise(resolve => {
    child.once('error', () => {
      spawnError = true;
      resolve(false);
    });
    child.once('exit', code => resolve(code === 0));
  });
  let timedOut = false;
  let timeout;
  const successful = await Promise.race([
    exited,
    new Promise(resolve => {
      timeout = setTimeout(() => {
        timedOut = true;
        resolve(false);
      }, timeoutMs);
    }),
  ]);
  clearTimeout(timeout);
  if (timedOut || overflow || spawnError) await stopChild(child);
  return {
    durationMs: Date.now() - started,
    output: output.toString('utf8'),
    status: successful && !timedOut && !overflow && !spawnError ? 'passed' : 'failed',
    reason: timedOut ? 'timeout' : overflow ? 'output-limit' : spawnError ? 'spawn-failed' : successful ? null : 'nonzero-exit',
  };
}

function commandCheck(id, result) {
  return {
    id,
    status: result.status,
    durationMs: result.durationMs,
    diagnostic: result.status === 'passed' ? null : `${id}-${result.reason ?? 'failed'}`,
  };
}

async function availablePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  await new Promise(resolve => server.close(resolve));
  if (!address || typeof address === 'string') throw new Error('localhost port allocation failed');
  return address.port;
}

async function startupCheck(executable, { cwd, env, timeoutMs }) {
  const started = Date.now();
  const port = await availablePort();
  const args = ['serve', '--hostname', '127.0.0.1', '--port', String(port)];
  let bytes = 0;
  let overflow = false;
  let exited = false;
  const child = spawn(executable, args, { cwd, detached: true, env, stdio: ['ignore', 'pipe', 'pipe'] });
  const count = chunk => {
    bytes += chunk.length;
    if (bytes > MAX_OUTPUT_BYTES) {
      overflow = true;
      signalChild(child, 'SIGTERM');
    }
  };
  child.stdout.on('data', count);
  child.stderr.on('data', count);
  child.once('error', () => { exited = true; });
  child.once('exit', () => { exited = true; });
  let passed = false;
  let reason = 'startup-timeout';
  const deadline = Date.now() + timeoutMs;
  try {
    while (Date.now() < deadline && !exited && !overflow) {
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), Math.min(500, Math.max(1, deadline - Date.now())));
        const response = await fetch(`http://127.0.0.1:${port}/global/health`, { signal: controller.signal });
        clearTimeout(timer);
        response.body?.cancel().catch(() => {});
        if (response.ok) {
          passed = true;
          reason = null;
          break;
        }
      } catch {
        // The bounded local server may still be starting.
      }
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    if (overflow) reason = 'output-limit';
    else if (exited && !passed) reason = 'early-exit';
  } finally {
    await stopChild(child);
  }
  return { durationMs: Date.now() - started, status: passed ? 'passed' : 'failed', reason };
}

async function boundedJson(file) {
  const stats = await lstat(file);
  if (!stats.isFile() || stats.isSymbolicLink() || stats.size > CONFIG_MAX_BYTES) throw new Error('unsafe generated config');
  const handle = await open(file, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.size > CONFIG_MAX_BYTES) throw new Error('unsafe generated config');
    return JSON.parse(await handle.readFile('utf8'));
  } finally {
    await handle.close();
  }
}

async function linuxIdentity() {
  if (process.platform !== 'linux') return { osId: null, wsl: false };
  try {
    const resolved = await realpath('/etc/os-release');
    if (!['/etc/os-release', '/usr/lib/os-release'].includes(resolved)) return { osId: null, wsl: false };
    const stats = await lstat(resolved);
    if (!stats.isFile() || stats.size > 16 * 1024) return { osId: null, wsl: false };
    const handle = await open(resolved, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    let source;
    try {
      source = await handle.readFile('utf8');
    } finally {
      await handle.close();
    }
    const id = source.match(/^ID=([A-Za-z0-9._-]+)$/m)?.[1]?.toLowerCase() ?? null;
    const wsl = /microsoft/i.test(os.release());
    return { osId: id, wsl };
  } catch {
    return { osId: null, wsl: /microsoft/i.test(os.release()) };
  }
}

export async function runCompatibilitySmoke(options, hooks = {}) {
  const timeoutMs = validateTimeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const opencode = await executablePath(options.opencodePath, 'OpenCode');
  const source = await sourceRoot(options.sourcePath);
  const bun = options.dashboard ? await executablePath(options.bunPath, 'Bun') : null;
  const detected = options.platformEvidence ?? { platform: process.platform, arch: process.arch, ...(await linuxIdentity()) };
  const platform = evaluatePlatformTarget(detected);
  const checks = [{
    id: 'target-platform',
    status: platform.status === 'targeted' ? 'passed' : 'failed',
    durationMs: 0,
    diagnostic: platform.reason,
  }];
  const versions = { bun: '', gh: '', git: '', node: process.versions.node, opencode: '' };
  let dashboardSyntax = 'omitted';
  let dashboardRegistration = 'omitted';
  let root = null;

  if (platform.status === 'targeted') {
    root = await mkdtemp('/tmp/naru-compat-');
    const privateBin = path.join(root, 'bin');
    const home = path.join(root, 'home');
    const target = path.join(home, '.config', 'opencode');
    const project = path.join(root, 'project');
    const env = isolatedEnvironment(root, privateBin);
    try {
      await chmod(root, 0o700);
      hooks.onDisposableRoot?.(root);
      for (const directory of [privateBin, home, project, env.TMPDIR, env.XDG_CACHE_HOME, env.XDG_CONFIG_HOME, env.XDG_DATA_HOME, env.XDG_STATE_HOME, env.GH_CONFIG_DIR]) {
        await mkdir(directory, { recursive: true, mode: 0o700 });
      }
      await symlink(opencode, path.join(privateBin, 'opencode'));

      const installArgs = [path.join(source, 'install.sh'), '--copy', '--configure-subagent-depth'];
      if (options.dashboard) installArgs.push('--with-dashboard');
      let result = await runBoundedProcess('/bin/sh', [...installArgs, '--preview'], { cwd: project, env, timeoutMs });
      let targetExists = true;
      try {
        await lstat(target);
      } catch (error) {
        if (error?.code === 'ENOENT') targetExists = false;
        else throw error;
      }
      if (targetExists) result = { ...result, status: 'failed', reason: 'preview-mutated-target' };
      checks.push(commandCheck('install-preview', result));

      if (result.status === 'passed') {
        result = await runBoundedProcess('/bin/sh', [...installArgs, '--apply'], { cwd: project, env, timeoutMs });
        checks.push(commandCheck('install-apply', result));
      } else {
        checks.push({ id: 'install-apply', status: 'omitted', durationMs: 0, diagnostic: 'preview-failed' });
      }

      const versionCommand = OPENCODE_SAFE_COMMANDS[0];
      result = await runBoundedProcess(opencode, versionCommand.args, { cwd: project, env, timeoutMs });
      versions.opencode = sanitizeObservedVersion(result.output) ?? '';
      checks.push(commandCheck(versionCommand.id, result));

      const doctorPath = path.join(target, 'tools', 'naru-doctor.js');
      result = await runBoundedProcess(process.execPath, [doctorPath, '--json', '--project-root', project, '--source', source], {
        cwd: project,
        env,
        timeoutMs,
      });
      let doctorValid = false;
      if (result.output.length <= CONFIG_MAX_BYTES) {
        try {
          const report = JSON.parse(result.output);
          const scope = report.scopes?.find(item => item.id === 'global');
          doctorValid = report.providerFree === true
            && report.readOnly === true
            && report.depth?.effective >= 2
            && scope?.runtime?.schedulerMode === 'off';
        } catch {
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
          maxOutputBytes: command.maxOutputBytes,
          retainOutput: command.retainOutput,
          timeoutMs,
        });
        checks.push(commandCheck(command.id, result));
      }
      result = await startupCheck(opencode, { cwd: project, env, timeoutMs });
      checks.push(commandCheck('opencode-startup', result));

      if (options.dashboard) {
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
          const matches = Array.isArray(config.plugin)
            ? config.plugin.filter(entry => entry === './plugins/naru-minions-dashboard.tsx')
            : [];
          dashboardRegistration = matches.length === 1 ? 'passed' : 'failed';
        } catch {
          dashboardRegistration = 'failed';
        }
        checks.push({
          id: 'dashboard-registration',
          status: dashboardRegistration,
          durationMs: 0,
          diagnostic: dashboardRegistration === 'passed' ? null : 'dashboard-registration-invalid',
        });
      }
    } catch {
      checks.push({ id: 'harness', status: 'failed', durationMs: 0, diagnostic: 'harness-failed-safely' });
    } finally {
      try {
        await rm(root, { recursive: true, force: true });
        checks.push({ id: 'cleanup', status: 'passed', durationMs: 0, diagnostic: null });
      } catch {
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
  return createCompatibilityEvidence({ platform, versions, checks, dashboard });
}

async function writeOutput(file, report) {
  const resolved = path.resolve(file);
  const parent = path.dirname(resolved);
  const stats = await lstat(parent);
  if (!stats.isDirectory()) throw new Error('output parent must be a directory');
  try {
    const existing = await lstat(resolved);
    if (existing.isSymbolicLink() || !existing.isFile()) throw new Error('output must not be a symlink or special file');
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  const handle = await open(
    resolved,
    fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_TRUNC | (fsConstants.O_NOFOLLOW ?? 0),
    0o600,
  );
  try {
    await handle.writeFile(`${JSON.stringify(report, null, 2)}\n`);
  } finally {
    await handle.close();
  }
}

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`naru-compat-smoke: ${error.message}\n${usage()}`);
    process.exitCode = 2;
    return;
  }
  if (options.help) {
    process.stdout.write(usage());
    return;
  }
  try {
    const report = await runCompatibilitySmoke(options);
    if (options.output) await writeOutput(options.output, report);
    if (options.json) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    else process.stdout.write(`Naru compatibility smoke: ${report.status}; release qualification not established\n`);
    if (report.status !== 'passed-local-smoke') process.exitCode = 1;
  } catch {
    process.stderr.write('naru-compat-smoke: failed safely; output and external tool diagnostics omitted\n');
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
