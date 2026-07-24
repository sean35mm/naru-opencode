import assert from 'node:assert/strict';
import { chmod, lstat, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  classifyDashboardEvidence,
  compareSemver,
  COMPATIBILITY_POLICY,
  createCompatibilityEvidence,
  evaluateObservedVersion,
  evaluatePlatformTarget,
  sanitizeObservedVersion,
} from '../tools/naru-lib/compatibility.mjs';
import {
  OPENCODE_SAFE_COMMANDS,
  runBoundedProcess,
  runCompatibilitySmoke,
} from '../scripts/naru-compat-smoke.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const AGENT_LIST_OUTPUT_MARKER = 'NARU_AGENT_LIST_OUTPUT_MARKER';
const DEBUG_CONFIG_OUTPUT_MARKER = 'NARU_DEBUG_CONFIG_OUTPUT_MARKER';

test('compatibility policy fixes approved targets without inventing Git or gh floors', () => {
  assert.deepEqual(COMPATIBILITY_POLICY.release.opencode, { floor: '1.18.4', current: '1.18.4' });
  assert.deepEqual(COMPATIBILITY_POLICY.targets.platforms.map(target => target.id), ['macos-arm64', 'ubuntu-x64']);
  assert.equal(COMPATIBILITY_POLICY.targets.runtimes.node.major, 24);
  assert.equal(COMPATIBILITY_POLICY.targets.runtimes.bun.exact, '1.3.9');
  assert.equal(COMPATIBILITY_POLICY.features.reviewPosting.git.versionFloor, null);
  assert.equal(COMPATIBILITY_POLICY.features.reviewPosting.gh.versionFloor, null);
  assert.equal(COMPATIBILITY_POLICY.features.dashboard.miniTui, 'excluded');
  assert.equal(COMPATIBILITY_POLICY.features.core.providerCalls, false);
  assert.equal(COMPATIBILITY_POLICY.features.core.minimumSubagentDepth, 1);
});

test('semantic versions and sanitized observations enforce floor versus exact-current evidence', () => {
  assert.equal(compareSemver('1.18.4', '1.18.4'), 0);
  assert.equal(compareSemver('1.18.5', '1.18.4'), 1);
  assert.equal(compareSemver('1.18.4-rc.1', '1.18.4'), -1);
  assert.equal(sanitizeObservedVersion('opencode version v1.18.4\nTOKEN=do-not-copy'), '1.18.4');
  assert.equal(sanitizeObservedVersion('TOKEN=do-not-copy'), null);
  assert.deepEqual(
    evaluateObservedVersion('opencode', '1.18.3'),
    {
      component: 'opencode',
      observed: '1.18.3',
      status: 'unsupported',
      requirement: { kind: 'minimum', version: '1.18.4' },
      exactCurrent: false,
    },
  );
  assert.equal(evaluateObservedVersion('opencode', '1.18.5').status, 'supported');
  assert.equal(evaluateObservedVersion('opencode', '1.18.5').exactCurrent, false);
  assert.equal(evaluateObservedVersion('node', 'v24.4.0').status, 'targeted');
  assert.equal(evaluateObservedVersion('bun', '1.3.8').status, 'non-target');
});

test('unsupported and unverified hosts cannot become successful local evidence', () => {
  assert.equal(evaluatePlatformTarget({ platform: 'win32', arch: 'x64' }).reason, 'native-windows-unclaimed');
  assert.equal(evaluatePlatformTarget({ platform: 'linux', arch: 'x64', osId: 'debian' }).status, 'unverified');
  assert.equal(evaluatePlatformTarget({ platform: 'linux', arch: 'x64', osId: 'ubuntu', wsl: true }).reason, 'wsl-unclaimed');
  const evidence = createCompatibilityEvidence({
    platform: evaluatePlatformTarget({ platform: 'freebsd', arch: 'x64' }),
    versions: { node: '24.0.0', opencode: '1.18.4' },
    checks: [],
    dashboard: classifyDashboardEvidence({ requested: false }),
  });
  assert.equal(evidence.status, 'failed-local-smoke');
  assert.equal(evidence.releaseQualification, 'not-established');
});

test('OpenCode command allowlist contains only provider-free inspection and localhost startup surfaces', () => {
  assert.deepEqual(OPENCODE_SAFE_COMMANDS.map(command => command.args), [
    ['--version'],
    ['--help'],
    ['debug', 'paths'],
    ['debug', 'config'],
    ['agent', 'list'],
    ['serve', '--hostname', '127.0.0.1', '--port', '<ephemeral>'],
  ]);
  const serialized = JSON.stringify(OPENCODE_SAFE_COMMANDS);
  for (const forbidden of ['auth', 'model', 'run', 'prompt']) assert.doesNotMatch(serialized, new RegExp(`"${forbidden}"`));
});

async function fakeOpenCode(directory, { agentListOutputBytes = 0, debugConfigOutputBytes = 0, failDebugConfig = false } = {}) {
  const executable = path.join(directory, 'fake-opencode.mjs');
  const source = `#!${process.execPath}
import http from 'node:http';
import path from 'node:path';
const args = process.argv.slice(2);
const agentListOutputBytes = ${agentListOutputBytes};
const agentListOutputMarker = ${JSON.stringify(AGENT_LIST_OUTPUT_MARKER)};
const debugConfigOutputBytes = ${debugConfigOutputBytes};
const debugConfigOutputMarker = ${JSON.stringify(DEBUG_CONFIG_OUTPUT_MARKER)};
const required = ['HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'XDG_STATE_HOME', 'TMPDIR', 'GH_CONFIG_DIR'];
const boundary = path.dirname(process.env.HOME || '');
if (!boundary || required.some(key => !process.env[key]?.startsWith(boundary + path.sep))) process.exit(70);
if (Object.keys(process.env).some(key => /(?:API_KEY|TOKEN|SECRET|PASSWORD|AUTH)$/i.test(key))) process.exit(71);
if (args.length === 1 && args[0] === '--version') console.log('opencode 1.18.4');
else if (args.length === 1 && args[0] === '--help') console.log('safe help');
else if (args.join(' ') === 'debug paths') console.log('isolated paths');
else if (args.join(' ') === 'debug config') {
  ${failDebugConfig ? "console.error('SUPER_SECRET_VALUE'); process.exit(9);" : "if (debugConfigOutputBytes === 0) console.log('{}'); else process.stdout.write(debugConfigOutputMarker.repeat(Math.ceil(debugConfigOutputBytes / debugConfigOutputMarker.length)).slice(0, debugConfigOutputBytes));"}
} else if (args.join(' ') === 'agent list') {
  if (agentListOutputBytes === 0) console.log('naru-orchestrator');
  else process.stdout.write(agentListOutputMarker.repeat(Math.ceil(agentListOutputBytes / agentListOutputMarker.length)).slice(0, agentListOutputBytes));
}
else if (args[0] === 'serve' && args[1] === '--hostname' && args[2] === '127.0.0.1' && args[3] === '--port') {
  const server = http.createServer((request, response) => {
    if (request.url === '/global/health') { response.writeHead(200); response.end('{}'); }
    else { response.writeHead(404); response.end(); }
  });
  server.listen(Number(args[4]), '127.0.0.1');
  process.on('SIGTERM', () => server.close(() => process.exit(0)));
} else process.exit(64);
`;
  await writeFile(executable, source);
  await chmod(executable, 0o755);
  return executable;
}

test('provider-free fake OpenCode smoke isolates environment, checks depth/default-off, and cleans up', async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'naru-compat-test-'));
  let disposable;
  try {
    const fake = await fakeOpenCode(temporary, {
      agentListOutputBytes: 128 * 1024,
      debugConfigOutputBytes: 128 * 1024,
    });
    const platformEvidence = process.platform === 'darwin'
      ? { platform: 'darwin', arch: 'arm64', osId: null, wsl: false }
      : { platform: 'linux', arch: 'x64', osId: 'ubuntu', wsl: false };
    const report = await runCompatibilitySmoke({
      opencodePath: fake,
      sourcePath: root,
      platformEvidence,
    }, { onDisposableRoot: value => { disposable = value; } });
    assert.equal(report.status, 'passed-local-smoke');
    assert.equal(report.providerFree, true);
    assert.equal(report.candidateIdentity, 'unverified');
    assert.ok(report.checks.every(check => check.status !== 'failed'));
    assert.equal(report.capabilities.dashboard.nativeTuiLoad, 'omitted');
    assert.doesNotMatch(JSON.stringify(report), new RegExp(AGENT_LIST_OUTPUT_MARKER));
    assert.doesNotMatch(JSON.stringify(report), new RegExp(DEBUG_CONFIG_OUTPUT_MARKER));
    await assert.rejects(lstat(disposable), error => error?.code === 'ENOENT');
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test('failed tool output is redacted from bounded evidence', async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'naru-compat-redact-'));
  try {
    const fake = await fakeOpenCode(temporary, { failDebugConfig: true });
    const report = await runCompatibilitySmoke({
      opencodePath: fake,
      sourcePath: root,
      platformEvidence: { platform: 'darwin', arch: 'arm64', osId: null, wsl: false },
    });
    assert.equal(report.status, 'failed-local-smoke');
    assert.equal(report.checks.find(check => check.id === 'opencode-debug-config').status, 'failed');
    assert.doesNotMatch(JSON.stringify(report), /SUPER_SECRET_VALUE/);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test('process runner bounds time and output without depending on OpenCode', async () => {
  let result = await runBoundedProcess(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    cwd: root,
    env: { PATH: path.dirname(process.execPath) },
    timeoutMs: 75,
  });
  assert.equal(result.status, 'failed');
  assert.equal(result.reason, 'timeout');
  assert.ok(result.durationMs < 2_000);

  result = await runBoundedProcess(process.execPath, ['-e', "process.stdout.write('x'.repeat(65537))"], {
    cwd: root,
    env: { PATH: path.dirname(process.execPath) },
  });
  assert.equal(result.status, 'failed');
  assert.equal(result.reason, 'output-limit');

  for (const maxOutputBytes of [65535, 1024 * 1024 + 1, 65536.5]) {
    await assert.rejects(
      runBoundedProcess(process.execPath, ['--version'], {
        cwd: root,
        env: { PATH: path.dirname(process.execPath) },
        maxOutputBytes,
      }),
      /output limit must be from 65536 to 1048576 bytes/,
    );
  }
});

test('dashboard evidence never equates syntax and registration with native TUI load', () => {
  const omitted = classifyDashboardEvidence({ requested: false });
  assert.equal(omitted.status, 'omitted');
  const partial = classifyDashboardEvidence({ requested: true, bun: '1.3.9', syntax: 'passed', registration: 'passed' });
  assert.equal(partial.status, 'partial');
  assert.equal(partial.nativeTuiLoad, 'omitted');
  assert.equal(partial.limitation, 'native-full-tui-load-not-proven');
  assert.equal(classifyDashboardEvidence({ requested: true, bun: '1.3.8', syntax: 'passed', registration: 'passed' }).status, 'failed');
  assert.equal(classifyDashboardEvidence({ requested: true, bun: '1.3.9', syntax: 'failed', registration: 'passed' }).status, 'failed');
});
