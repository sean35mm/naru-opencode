import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { chmod, lstat, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { projectOc2NativeAgents } from '../tools/naru-lib/oc2-native-projection.mjs';

import {
  compareSemver,
  COMPATIBILITY_POLICY,
  REQUIRED_COMPATIBILITY_CHECKS,
  createCompatibilityEvidence,
  evaluateOpenCodeVersion,
  evaluateObservedVersion,
  evaluatePlatformTarget,
  sanitizeObservedVersion,
} from '../tools/naru-lib/compatibility.mjs';
import {
  OPENCODE_SAFE_COMMANDS,
  checkNativeHostRoutes,
  nativeWorkerPoolValid,
  runBoundedProcess,
  runCompatibilitySmoke,
} from '../scripts/naru-compat-smoke.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
test('compatibility policy fixes approved targets without inventing Git or gh floors', () => {
  assert.deepEqual(Object.keys(COMPATIBILITY_POLICY.profiles), ['native-v2']);
  assert.deepEqual(COMPATIBILITY_POLICY.profiles['native-v2'].recognizedBuilds, ['2.0.15']);
  assert.deepEqual(COMPATIBILITY_POLICY.profiles['native-v2'].candidateRange, { floor: '2.0.15', below: '2.1.0' });
  assert.deepEqual(COMPATIBILITY_POLICY.targets.platforms.map(target => target.id), ['macos-arm64', 'ubuntu-x64']);
  assert.equal(COMPATIBILITY_POLICY.targets.runtimes.node.major, 24);
  assert.equal(COMPATIBILITY_POLICY.targets.runtimes.bun.exact, '1.3.9');
  assert.equal(COMPATIBILITY_POLICY.features.reviewPosting.git.versionFloor, null);
  assert.equal(COMPATIBILITY_POLICY.features.reviewPosting.gh.versionFloor, null);
  assert.equal(COMPATIBILITY_POLICY.features.core.providerCalls, false);
});

test('semantic versions accept the tested 2.0.15 host and flag other 2.0.x patches as candidates', () => {
  assert.equal(compareSemver('2.0.15', '2.0.15'), 0);
  assert.equal(compareSemver('2.0.16', '2.0.15'), 1);
  assert.equal(compareSemver('2.0.15-rc.1', '2.0.15'), -1);
  assert.equal(sanitizeObservedVersion(' \t2.0.15\n'), '2.0.15');
  assert.equal(sanitizeObservedVersion('\nopencode2 v0.0.0-beta-19086 \t'), '0.0.0-beta-19086');
  assert.equal(sanitizeObservedVersion('v24.4.0'), '24.4.0');
  for (const output of [
    'opencode version v2.0.15',
    'release 2.0.15',
    '2.0.15 release',
    '2.0.15\n0.0.0-beta-19086',
    'opencode2 v0.0.0-beta-19086 (beta)',
    '2.0.15+',
    '2.0.15 banner v2.0.15',
  ]) assert.equal(sanitizeObservedVersion(output), null, output);
  assert.equal(sanitizeObservedVersion('TOKEN=do-not-copy'), null);
  assert.deepEqual(
    evaluateObservedVersion('opencode', '1.18.28'),
    {
      component: 'opencode',
      observed: '1.18.28',
      status: 'unsupported',
      requirement: { kind: 'explicit-builds', version: null, builds: ['2.0.15'] },
    },
  );
  assert.equal(evaluateObservedVersion('opencode', '2.0.15').status, 'supported');
  assert.equal(evaluateObservedVersion('opencode', '2.0.16').status, 'candidate');
  assert.equal(evaluateObservedVersion('opencode', '2.0.14').status, 'unsupported');
  assert.equal(evaluateObservedVersion('opencode', '2.1.0').status, 'unsupported');
  assert.equal(evaluateObservedVersion('opencode', '2.0.16-beta.1').status, 'unsupported');
  assert.equal(evaluateObservedVersion('opencode', 'not-a-version').status, 'unrecognized');
  assert.equal(sanitizeObservedVersion('opencode v2.0.15\n'), '2.0.15');
  assert.equal(evaluateOpenCodeVersion('native-v2', ' \nopencode v2.0.15\t').status, 'supported');
  assert.equal(evaluateOpenCodeVersion('native-v2', 'opencode2 v0.0.0-beta-19425').status, 'unsupported');
  assert.equal(evaluateOpenCodeVersion('native-v2', '0.0.0-beta-19086').status, 'unsupported');
  assert.throws(() => evaluateOpenCodeVersion('stable', '1.18.28'), /unknown compatibility profile/);
  assert.equal(evaluateObservedVersion('node', 'v24.4.0').status, 'targeted');
  assert.equal(evaluateObservedVersion('bun', '1.3.8').status, 'non-target');
});

test('unsupported and unverified hosts cannot become successful local evidence', () => {
  assert.equal(evaluatePlatformTarget({ platform: 'win32', arch: 'x64' }).reason, 'native-windows-unclaimed');
  assert.equal(evaluatePlatformTarget({ platform: 'linux', arch: 'x64', osId: 'debian' }).status, 'unverified');
  assert.equal(evaluatePlatformTarget({ platform: 'linux', arch: 'x64', osId: 'ubuntu', wsl: true }).reason, 'wsl-unclaimed');
  const evidence = createCompatibilityEvidence({
    profile: 'native-v2',
    platform: evaluatePlatformTarget({ platform: 'freebsd', arch: 'x64' }),
    versions: { node: '24.0.0', opencode: '2.0.15' },
    checks: [],
  });
  assert.equal(evidence.status, 'failed-local-smoke');
  assert.equal(evidence.releaseQualification, 'not-established');
  assert.equal(evidence.versionEvidence.localProbe, 'failed');
});

test('native-v2 qualification requires exact 2.0.15 and all packaged checks', () => {
  const required = REQUIRED_COMPATIBILITY_CHECKS['native-v2'].map(id => ({ id, status: 'passed' as const, durationMs: 0, diagnostic: null }));
  const base = { profile: 'native-v2' as const, platform: evaluatePlatformTarget({ platform: 'darwin', arch: 'arm64' }), versions: { node: '24.0.0', opencode: '2.0.15' } };
  assert.equal(createCompatibilityEvidence({ ...base, checks: required }).status, 'passed-local-smoke');
  assert.equal(createCompatibilityEvidence({ ...base, checks: required }).releaseQualification, 'not-established');
  for (const id of REQUIRED_COMPATIBILITY_CHECKS['native-v2']) {
    assert.equal(createCompatibilityEvidence({ ...base, checks: required.filter(check => check.id !== id) }).status, 'failed-local-smoke', id);
  }
  for (const version of ['2.0.16', '2.0.15-beta.1', '1.18.28', 'unknown']) {
    assert.equal(createCompatibilityEvidence({ ...base, versions: { node: '24.0.0', opencode: version }, checks: required }).status, 'failed-local-smoke', version);
  }
});

test('native worker pool cannot pass empty, unowned, or mismatched model and effort', () => {
  const worker = { mode: 'subagent', model: { providerID: 'fixture', model: 'worker', variant: 'high' } };
  const name = 'naru-worker-fixture-worker-high-';
  const projected = projectOc2NativeAgents(['fixture/worker#high']).workers[0]!.name;
  assert.ok(projected.startsWith(name));
  assert.equal(nativeWorkerPoolValid([], { [projected]: worker }, { [projected]: worker }), false);
  assert.equal(nativeWorkerPoolValid(['fixture/worker#high'], {}, {}), false);
  assert.equal(nativeWorkerPoolValid(['fixture/worker#high'], { [projected]: worker }, {}), false);
  assert.equal(nativeWorkerPoolValid(['fixture/worker#high'], { [projected]: { ...worker, model: { ...worker.model, variant: 'low' } } }, { [projected]: worker }), false);
  assert.equal(nativeWorkerPoolValid(['fixture/worker#high'], { [projected]: worker }, { [projected]: worker }), true);
});

test('native qualification reads the private 2.0.15 API response shapes and fails closed on missing registration', async () => {
  const configPath = '/fixture/config/opencode.json', plugin = '/fixture/config/.naru-native/package/tools/oc2-native-plugin';
  const responses: Record<string, unknown> = {
    '/api/config': [{ path: configPath }],
    '/api/agent': { data: [{ id: 'naru', mode: 'primary' }, { id: 'naru-worker-fixture', mode: 'subagent', model: { providerID: 'fixture', id: 'worker', variant: 'high' } }] },
    '/api/plugin': { data: [{ id: 'naru.oc2-native', source: { type: 'local', path: `${plugin}/index.mjs` }, state: { status: 'active' } }] },
    '/api/skill': { data: [{ name: 'naru-coordinate' }] },
    '/api/command': { data: [{ name: 'naru' }] },
  };
  const requests: string[] = [];
  const server = createServer((request, response) => {
    requests.push(request.url ?? '');
    const route = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
    if (route === '/api/plugin' && request.headers.authorization !== 'Basic isolated') { response.writeHead(401).end(); return; }
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify(responses[route] ?? {}));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address(); assert.ok(address && typeof address !== 'string');
    const url = `http://127.0.0.1:${address.port}`;
    const worker = { name: 'naru-worker-fixture', model: { providerID: 'fixture', id: 'worker', variant: 'high' } };
    const run = () => checkNativeHostRoutes(url, { authorization: 'Basic isolated' }, '/fixture/project', configPath, plugin, [worker], 1000);
    assert.deepEqual((await run()).map(check => [check.id, check.status]), [
      ['native-config-source', 'passed'], ['native-host-agents', 'passed'], ['native-host-plugin', 'passed'], ['native-host-skills', 'passed'], ['native-host-command', 'passed'],
    ]);
    assert.deepEqual(requests, ['/api/config', '/api/agent', '/api/plugin', '/api/skill', '/api/command'].map(route => `${route}?location%5Bdirectory%5D=%2Ffixture%2Fproject`));
    assert.equal((await checkNativeHostRoutes(url, { authorization: 'Basic isolated' }, '/fixture/project', configPath, plugin, [], 1000)).find(check => check.id === 'native-host-agents')?.status, 'failed');
    responses['/api/agent'] = { data: [{ id: 'naru' }, { id: worker.name, model: { ...worker.model, variant: 'low' } }] };
    assert.equal((await run()).find(check => check.id === 'native-host-agents')?.diagnostic, 'native-host-agents-missing-registration');
    responses['/api/config'] = { data: [{ path: configPath }] };
    responses['/api/agent'] = { data: [{ id: 'naru' }] };
    responses['/api/plugin'] = { data: [{ source: { type: 'local', path: `${plugin}/index.mjs` }, status: 'active' }] };
    responses['/api/skill'] = { data: [] };
    responses['/api/command'] = { data: [] };
    assert.deepEqual((await run()).map(check => check.diagnostic), [
      'native-config-source-missing-registration', 'native-host-agents-missing-registration', 'native-host-plugin-missing-registration', 'native-host-skills-missing-registration', 'native-host-command-missing-registration',
    ]);
    responses['/api/plugin'] = { data: [{ source: { type: 'local', path: `${plugin}/other.mjs` }, state: { status: 'active' } }] };
    assert.equal((await run()).find(check => check.id === 'native-host-plugin')?.diagnostic, 'native-host-plugin-missing-registration');
    assert.equal((await checkNativeHostRoutes(url, {}, '/fixture/project', configPath, plugin, [], 1000)).find(check => check.id === 'native-host-plugin')?.diagnostic, 'native-host-plugin-http-401');
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

test('missing, omitted, failed, and duplicate required checks cannot produce passing evidence', () => {
  const required = REQUIRED_COMPATIBILITY_CHECKS['native-v2'].map(id => ({ id, status: 'passed', durationMs: 0, diagnostic: null }));
  const base = { profile: 'native-v2' as const, platform: evaluatePlatformTarget({ platform: 'darwin', arch: 'arm64' }), versions: { node: '24.0.0', opencode: 'opencode v2.0.15' } };
  for (const checks of [[], required.slice(1), required.map(check => ({ ...check, status: 'omitted' })), required.map(check => ({ ...check, status: 'failed' }))]) {
    assert.match(createCompatibilityEvidence({ ...base, checks }).status, /^failed-/);
  }
  assert.throws(() => createCompatibilityEvidence({ ...base, checks: [...required, required[0]] }), /unique/);
});

test('smoke API rejects an unknown profile before inspecting paths', async () => {
  await assert.rejects(runCompatibilitySmoke({
    opencodePath: '/not/inspected',
    profile: 'unknown' as never,
    sourcePath: '/not/inspected',
  }), /unknown compatibility profile/);
});

test('OpenCode command allowlist contains only the provider-free version probe', () => {
  assert.deepEqual(OPENCODE_SAFE_COMMANDS.map(command => command.args), [['--version']]);
  const serialized = JSON.stringify(OPENCODE_SAFE_COMMANDS);
  for (const forbidden of ['auth', 'model', 'run', 'prompt']) assert.doesNotMatch(serialized, new RegExp(`"${forbidden}"`));
});

async function fakeOpenCode(directory: string, version: string): Promise<string> {
  const executable = path.join(directory, 'fake-opencode.mjs');
  await writeFile(executable, `#!${process.execPath}\nif (process.argv.slice(2).join(' ') === '--version') console.log(${JSON.stringify(version)}); else process.exit(64);\n`);
  await chmod(executable, 0o755);
  return executable;
}

test('native-v2 profile rejects non-target versions before installing, then cleans up', async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'naru-compat-rejected-'));
  try {
    for (const version of ['1.18.28', '2.0.16', '2.0.15-beta.1', 'invalid']) {
      let disposable: string | undefined;
      const report = await runCompatibilitySmoke({
        opencodePath: await fakeOpenCode(temporary, version),
        profile: 'native-v2', sourcePath: root,
        platformEvidence: { platform: 'darwin', arch: 'arm64' },
      }, { onDisposableRoot: value => { disposable = value; } });
      assert.equal(report.status, 'failed-local-smoke', version);
      assert.deepEqual(report.checks.map(check => check.id), ['target-platform', 'opencode-version', 'cleanup'], version);
      assert.equal(report.versionEvidence.classification, 'rejected', version);
      assert.ok(disposable);
      await assert.rejects(lstat(disposable), (error: unknown) => error instanceof Error && 'code' in error && error.code === 'ENOENT');
    }
  } finally { await rm(temporary, { recursive: true, force: true }); }
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
