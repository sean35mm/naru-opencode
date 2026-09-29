import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseRuntimeConfig } from '../tools/naru-lib/runtime-config.mjs';
import { nativeModels } from '../tools/naru-lib/native-install.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

interface DoctorReport {
  status: string;
  native?: { registration: string };
  issues: Array<{ code: string }>;
}

test('runtime review defaults are backward-safe and strictly validated', () => {
  assert.deepEqual(parseRuntimeConfig({}).review, {
    defaultProfile: 'standard', defaultDecision: 'comment-only', defaultOutput: 'detailed',
  });
  assert.deepEqual(parseRuntimeConfig({ review: {
    defaultProfile: 'release-critical', defaultDecision: 'automatic', defaultOutput: 'concise',
  } }).review, {
    defaultProfile: 'release-critical', defaultDecision: 'automatic', defaultOutput: 'concise',
  });
  assert.throws(() => parseRuntimeConfig({ review: { defaultProfile: 'critical' } }), /defaultProfile/);
  assert.throws(() => parseRuntimeConfig({ review: { ticket: true } }), /unknown fields/);
  assert.equal(parseRuntimeConfig({}).mcp.configuredTools, 'off');
  assert.equal(parseRuntimeConfig({ mcp: { configuredTools: 'ask' } }).mcp.configuredTools, 'ask');
  assert.equal(parseRuntimeConfig({ mcp: { configuredTools: 'allow' } }).mcp.configuredTools, 'allow');
  assert.throws(() => parseRuntimeConfig({ mcp: [] }), /plain object/);
  assert.throws(() => parseRuntimeConfig({ mcp: { configuredTools: 'always' } }), /configuredTools/);
  assert.throws(() => parseRuntimeConfig({ mcp: { enabled: true } }), /unknown fields/);
  assert.throws(() => parseRuntimeConfig({ models: {} }), /unknown fields: models/);
});

test('configured MCP runtime policy is backward-safe and strictly validated', () => {
  assert.deepEqual(parseRuntimeConfig({}).mcp, { configuredTools: 'off' });
  assert.deepEqual(parseRuntimeConfig({ mcp: { configuredTools: 'ask' } }).mcp, { configuredTools: 'ask' });
  assert.equal(parseRuntimeConfig({ mcp: { configuredTools: 'allow' } }).mcp.configuredTools, 'allow');
  assert.throws(() => parseRuntimeConfig({ mcp: { configuredTools: true } }), /mcp\.configuredTools/);
  assert.throws(() => parseRuntimeConfig({ mcp: { extra: 'ask' } }), /unknown fields/);
});

test('CLI helper modules tolerate virtual Bun argv when imported as tools', async () => {
  const previousArgv1 = process.argv[1];
  process.argv[1] = '/$bunfs/root/src/cli/tui/worker.js';
  try {
    const nonce = Date.now();
    await import(`${pathToFileURL(path.join(root, 'tools/naru-doctor.js')).href}?virtual-bun-argv=${nonce}`);
  } finally {
    if (previousArgv1 === undefined) delete process.argv[1];
    else process.argv[1] = previousArgv1;
  }
});

test('CLI doctor inspects a packaged native install', async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'naru-normal-doctor-'));
  try {
    const home = path.join(temporary, 'home'), bin = path.join(temporary, 'bin');
    await mkdir(home); await mkdir(bin);
    await writeFile(path.join(bin, 'opencode'), '#!/bin/sh\nprintf "2.0.15\\n"\n', { mode: 0o755 });
    const env = { ...process.env, HOME: home, XDG_CONFIG_HOME: path.join(home, '.config'), PATH: `${bin}:${path.dirname(process.execPath)}:/usr/bin:/bin` };
    const cli = path.join(root, 'bin', 'naru');
    const invoke = (args: string[]) => spawnSync('sh', [cli, ...args], { cwd: temporary, env, encoding: 'utf8', timeout: 30_000 });
    const preview = invoke(['install', '--preview']);
    assert.equal(preview.status, 0, preview.stderr);
    const install = invoke(['install', '--apply']);
    assert.equal(install.status, 0, install.stderr);
    let doctor = invoke(['doctor', '--json']);
    assert.equal(doctor.status, 0, doctor.stderr + doctor.stdout);
    const report = JSON.parse(doctor.stdout);
    assert.equal(report.native.package, 'valid');
    assert.equal(report.native.agents, 'valid');
    assert.equal(report.native.registration, 'valid');
    assert.equal(report.native.runtimeEvidence, 'not-run');
    assert.equal(report.compatibility.opencode.version, '2.0.15');
    assert.equal(report.compatibility.opencode.status, 'probe-required');
    const configRoot = path.join(home, '.config', 'opencode');
    const previousPath = process.env.PATH, previousHome = process.env.HOME;
    try {
      process.env.PATH = env.PATH;
      process.env.HOME = home;
      await nativeModels(configRoot, ['fixture/worker#high'], []);
    } finally {
      if (previousPath === undefined) delete process.env.PATH; else process.env.PATH = previousPath;
      if (previousHome === undefined) delete process.env.HOME; else process.env.HOME = previousHome;
    }
    doctor = invoke(['doctor', '--json']);
    assert.equal(doctor.status, 0, doctor.stderr + doctor.stdout);
    assert.equal(JSON.parse(doctor.stdout).native.workers, 1);
    const manualAgent = path.join(configRoot, 'agents', 'naru.md');
    await mkdir(path.dirname(manualAgent));
    await writeFile(manualAgent, 'user-owned Naru agent\n');
    doctor = invoke(['doctor', '--json']);
    assert.equal(doctor.status, 1);
    const collision = JSON.parse(doctor.stdout) as DoctorReport;
    assert.equal(collision.status, 'warning');
    assert.equal(collision.native?.registration, 'invalid');
    assert.ok(collision.issues.some(issue => issue.code === 'native-agent-collision'));
    assert.equal(await readFile(manualAgent, 'utf8'), 'user-owned Naru agent\n');
    await rm(manualAgent);
    doctor = invoke(['doctor', '--json']);
    assert.equal(doctor.status, 0, doctor.stderr + doctor.stdout);
    const packageFile = path.join(home, '.config/opencode/.naru-native/package/tools/oc2-native-plugin/command.md');
    await appendFile(packageFile, '\nmodified\n');
    doctor = invoke(['doctor', '--json']);
    assert.equal(doctor.status, 1);
    assert.equal(JSON.parse(doctor.stdout).native.package, 'invalid');
  } finally { await rm(temporary, { recursive: true, force: true }); }
});
