import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmod, lstat, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  classifyDashboardEvidence,
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
  OPENCODE_V2_EXPLORATORY_COMMANDS,
  runBoundedProcess,
  runCompatibilitySmoke,
} from '../scripts/naru-compat-smoke.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const AGENT_LIST_OUTPUT_MARKER = 'NARU_AGENT_LIST_OUTPUT_MARKER';
const DEBUG_CONFIG_OUTPUT_MARKER = 'NARU_DEBUG_CONFIG_OUTPUT_MARKER';

interface FakeOpenCodeOptions {
  agentListOutputBytes?: number;
  debugConfigOutputBytes?: number;
  failDebugConfig?: boolean;
  disablePlugin?: boolean;
  version?: string;
}

test('compatibility policy fixes approved targets without inventing Git or gh floors', () => {
  assert.deepEqual(COMPATIBILITY_POLICY.release.opencode, {
    floor: '1.18.4', current: '1.18.28', testedBuilds: ['1.18.4', '1.18.28'], recognizedBuilds: ['1.18.4', '1.18.28'],
  });
  assert.deepEqual(COMPATIBILITY_POLICY.profiles.stable.recognizedBuilds, ['1.18.4', '1.18.28']);
  assert.deepEqual(COMPATIBILITY_POLICY.profiles['v2-beta-exploratory'].recognizedBuilds, ['0.0.0-beta-19425']);
  assert.deepEqual(COMPATIBILITY_POLICY.targets.platforms.map(target => target.id), ['macos-arm64', 'ubuntu-x64']);
  assert.equal(COMPATIBILITY_POLICY.targets.runtimes.node.major, 24);
  assert.equal(COMPATIBILITY_POLICY.targets.runtimes.bun.exact, '1.3.9');
  assert.equal(COMPATIBILITY_POLICY.features.reviewPosting.git.versionFloor, null);
  assert.equal(COMPATIBILITY_POLICY.features.reviewPosting.gh.versionFloor, null);
  assert.equal(COMPATIBILITY_POLICY.features.dashboard.miniTui, 'excluded');
  assert.equal(COMPATIBILITY_POLICY.features.core.providerCalls, false);
  assert.equal(COMPATIBILITY_POLICY.features.core.minimumSubagentDepth, 1);
});

test('semantic versions distinguish tested history from stable probe candidates', () => {
  assert.equal(compareSemver('1.18.4', '1.18.4'), 0);
  assert.equal(compareSemver('1.18.5', '1.18.4'), 1);
  assert.equal(compareSemver('1.18.4-rc.1', '1.18.4'), -1);
  assert.equal(sanitizeObservedVersion(' \t1.18.28\n'), '1.18.28');
  assert.equal(sanitizeObservedVersion('\nopencode2 v0.0.0-beta-19086 \t'), '0.0.0-beta-19086');
  assert.equal(sanitizeObservedVersion('v24.4.0'), '24.4.0');
  for (const output of [
    'opencode version v1.18.4',
    'release 1.18.28',
    '1.18.28 release',
    '1.18.28\n0.0.0-beta-19086',
    'opencode2 v0.0.0-beta-19086 (beta)',
    '1.18.28+',
    '1.18.28 banner v1.18.28',
  ]) assert.equal(sanitizeObservedVersion(output), null, output);
  assert.equal(sanitizeObservedVersion('TOKEN=do-not-copy'), null);
  assert.deepEqual(
    evaluateObservedVersion('opencode', '1.18.3'),
    {
      component: 'opencode',
      observed: '1.18.3',
      status: 'unsupported',
      requirement: { kind: 'stable-floor-probe', version: '1.18.4', builds: ['1.18.4', '1.18.28'] },
      exactCurrent: false,
    },
  );
  assert.equal(evaluateObservedVersion('opencode', '1.18.4').status, 'supported');
  assert.equal(evaluateObservedVersion('opencode', '1.18.28').status, 'supported');
  assert.equal(evaluateObservedVersion('opencode', '1.18.5').status, 'candidate');
  assert.equal(evaluateObservedVersion('opencode', '1.18.5').exactCurrent, false);
  assert.equal(evaluateObservedVersion('opencode', '1.18.29').status, 'candidate');
  assert.equal(evaluateObservedVersion('opencode', '1.99.0').status, 'candidate');
  assert.equal(evaluateObservedVersion('opencode', '2.0.0').status, 'candidate');
  assert.equal(evaluateObservedVersion('opencode', '2.0.0-beta.1').status, 'unsupported');
  assert.equal(evaluateObservedVersion('opencode', 'not-a-version').status, 'unrecognized');
  assert.equal(evaluateOpenCodeVersion('v2-beta-exploratory', ' \nopencode2 v0.0.0-beta-19425\t').status, 'supported');
  assert.equal(evaluateOpenCodeVersion('v2-beta-exploratory', '0.0.0-beta-19086').status, 'unsupported');
  assert.throws(() => evaluateOpenCodeVersion('unknown-profile', '1.18.28'), /unknown compatibility profile/);
  assert.equal(evaluateObservedVersion('node', 'v24.4.0').status, 'targeted');
  assert.equal(evaluateObservedVersion('bun', '1.3.8').status, 'non-target');
});

test('unsupported and unverified hosts cannot become successful local evidence', () => {
  assert.equal(evaluatePlatformTarget({ platform: 'win32', arch: 'x64' }).reason, 'native-windows-unclaimed');
  assert.equal(evaluatePlatformTarget({ platform: 'linux', arch: 'x64', osId: 'debian' }).status, 'unverified');
  assert.equal(evaluatePlatformTarget({ platform: 'linux', arch: 'x64', osId: 'ubuntu', wsl: true }).reason, 'wsl-unclaimed');
  const evidence = createCompatibilityEvidence({
    profile: 'stable',
    platform: evaluatePlatformTarget({ platform: 'freebsd', arch: 'x64' }),
    versions: { node: '24.0.0', opencode: '1.18.4' },
    checks: [],
    dashboard: classifyDashboardEvidence({ requested: false }),
  });
  assert.equal(evidence.status, 'failed-local-smoke');
  assert.equal(evidence.releaseQualification, 'not-established');
  assert.equal(evidence.versionEvidence.localProbe, 'failed');
});

test('exploratory evidence is visibly distinct and never release-qualified', () => {
  const evidence = createCompatibilityEvidence({
    profile: 'v2-beta-exploratory',
    platform: evaluatePlatformTarget({ platform: 'darwin', arch: 'arm64' }),
    versions: { node: '24.0.0', opencode: '0.0.0-beta-19425' },
    checks: REQUIRED_COMPATIBILITY_CHECKS['v2-beta-exploratory'].map(id => ({ id, status: 'passed', durationMs: 0, diagnostic: null })),
  });
  assert.equal(evidence.status, 'passed-exploratory-smoke');
  assert.equal(evidence.profile, 'v2-beta-exploratory');
  assert.equal(evidence.qualification, 'exploratory');
  assert.equal(evidence.releaseQualification, 'ineligible-exploratory');
  assert.equal(evidence.versionEvidence.classification, 'exploratory-exact');
});

test('missing, omitted, failed, and duplicate required checks cannot produce passing evidence', () => {
  for (const profile of ['stable', 'v2-beta-exploratory'] as const) {
    const required = REQUIRED_COMPATIBILITY_CHECKS[profile].map(id => ({ id, status: 'passed', durationMs: 0, diagnostic: null }));
    const base = { profile, platform: evaluatePlatformTarget({ platform: 'darwin', arch: 'arm64' }), versions: { node: '24.0.0', opencode: profile === 'stable' ? '1.18.28' : '0.0.0-beta-19425' } };
    for (const checks of [[], required.slice(1), required.map(check => ({ ...check, status: 'omitted' })), required.map(check => ({ ...check, status: 'failed' }))]) {
      assert.match(createCompatibilityEvidence({ ...base, checks }).status, /^failed-/);
    }
    assert.throws(() => createCompatibilityEvidence({ ...base, checks: [...required, required[0]] }), /unique/);
  }
});

test('smoke API rejects an unknown profile before inspecting paths', async () => {
  await assert.rejects(runCompatibilitySmoke({
    opencodePath: '/not/inspected',
    profile: 'unknown' as never,
    sourcePath: '/not/inspected',
  }), /unknown compatibility profile/);
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
  assert.deepEqual(OPENCODE_V2_EXPLORATORY_COMMANDS.map(command => command.args), [['--version'], ['--help']]);
});

async function fakeOpenCode(directory: string, {
  agentListOutputBytes = 0,
  debugConfigOutputBytes = 0,
  failDebugConfig = false,
  disablePlugin = false,
  version = '1.18.4',
}: FakeOpenCodeOptions = {}): Promise<string> {
  const executable = path.join(directory, 'fake-opencode.mjs');
  const source = `#!${process.execPath}
import http from 'node:http';
import path from 'node:path';
import { readFileSync } from 'node:fs';
const args = process.argv.slice(2);
const agentListOutputBytes = ${agentListOutputBytes};
const agentListOutputMarker = ${JSON.stringify(AGENT_LIST_OUTPUT_MARKER)};
const debugConfigOutputBytes = ${debugConfigOutputBytes};
const debugConfigOutputMarker = ${JSON.stringify(DEBUG_CONFIG_OUTPUT_MARKER)};
const agent = { 'naru-orchestrator': { mode: 'primary', permission: { '*': 'deny', 'safe_tools_*': 'ask', 'codebase_*': 'ask', 'codebase-memory-mcp_search_graph': 'allow', safe_tools_delete: 'deny', task: { '*': 'deny' } }, prompt: ${disablePlugin ? "'Plugin disabled'" : "'Effective defaults: profile=release-critical; decision=comment-only; output=concise.'"} } };
for (const role of ['naru-reader', 'naru-runner', 'naru-writer']) {
  agent[role] = { mode: 'subagent', permission: { '*': 'deny', ...(role === 'naru-writer' ? { 'safe_tools_*': 'ask', 'codebase_*': 'ask', 'codebase-memory-mcp_search_graph': 'allow' } : {}), task: 'deny', edit: role === 'naru-writer' ? 'allow' : 'deny', ...(role === 'naru-runner' ? { bash: 'deny', 'naru-check': 'allow' } : {}), ...(role === 'naru-writer' ? { safe_tools_delete: 'deny' } : {}) } };
  agent['naru-orchestrator'].permission.task[role] = 'allow';
  if (!${disablePlugin}) {
    agent[role + '-smoke'] = { ...agent[role], model: 'openai/naru-compat-fixture', variant: 'high' };
    agent['naru-orchestrator'].permission.task[role + '-smoke'] = 'allow';
  }
}
const required = ['HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'XDG_STATE_HOME', 'TMPDIR', 'GH_CONFIG_DIR'];
const boundary = path.dirname(process.env.HOME || '');
if (!boundary || required.some(key => !process.env[key]?.startsWith(boundary + path.sep))) process.exit(70);
if (Object.keys(process.env).some(key => /(?:API_KEY|TOKEN|SECRET|PASSWORD|AUTH)$/i.test(key))) process.exit(71);
if (args.length === 1 && args[0] === '--version') console.log(${JSON.stringify(version)}.startsWith('0.0.0-beta-') ? 'opencode2 v' + ${JSON.stringify(version)} : ${JSON.stringify(version)});
else if (args.length === 1 && args[0] === '--help') console.log('safe help');
else if (args.join(' ') === 'debug paths') console.log('isolated paths');
else if (args.join(' ') === 'debug config') {
  ${failDebugConfig ? "console.error('SUPER_SECRET_VALUE'); process.exit(9);" : "console.log(JSON.stringify({agent, padding: debugConfigOutputMarker.repeat(Math.ceil(debugConfigOutputBytes / debugConfigOutputMarker.length)).slice(0, debugConfigOutputBytes)}));"}
} else if (args.join(' ') === 'agent list') {
  if (agentListOutputBytes === 0) console.log('naru-orchestrator');
  else process.stdout.write(agentListOutputMarker.repeat(Math.ceil(agentListOutputBytes / agentListOutputMarker.length)).slice(0, agentListOutputBytes));
}
else if (args[0] === 'serve' && args[1] === '--hostname' && args[2] === '127.0.0.1' && args[3] === '--port') {
  let sequence = 0;
  const sessions = new Map();
  const pending = new Map();
  const attempted = new Map();
  const body = request => new Promise(resolve => { let value=''; request.on('data', chunk => value += chunk); request.on('end', () => resolve(value ? JSON.parse(value) : {})); });
  const send = (response, value) => { response.writeHead(200, {'content-type':'application/json'}); response.end(JSON.stringify(value)); };
  const rules = name => [{permission:'*',pattern:'*',action:'deny'},{permission:'edit',pattern:'*',action:'deny'},{permission:'task',pattern:'*',action:'deny'},...(['naru-orchestrator','naru-writer','naru-writer-smoke'].includes(name)?[{permission:'safe_tools_*',pattern:'*',action:'ask'},{permission:'codebase_*',pattern:'*',action:'ask'},{permission:'safe_tools_delete',pattern:'*',action:'deny'}]:[]),...(name==='naru-orchestrator'?[{permission:'codebase-memory-mcp_search_graph',pattern:'*',action:'allow'}]:[])];
  const hostAgents = ['naru-orchestrator','naru-reader','naru-runner','naru-writer'].flatMap(name => [{name,permission:rules(name),options:{}},...(name==='naru-orchestrator'?[]:[{name,permission:rules(name+'-smoke'),variant:'high',options:{naruVariant:true}}])]);
  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    if (url.pathname === '/global/health') send(response, {healthy:true});
    else if (url.pathname === '/doc') send(response, {paths:{'/api/session/{sessionID}/permission':{post:{operationId:'v2.session.permission.create'}}}});
    else if (url.pathname === '/agent') send(response, hostAgents);
    else if ((url.pathname === '/api/session' || url.pathname === '/session') && request.method === 'POST') {
      const input = await body(request); const id = 'ses_' + (++sequence); sessions.set(id, input.agent); pending.set(id, []); send(response, url.pathname === '/session' ? {id} : {data:{id}});
    } else if (url.pathname === '/permission' && request.method === 'GET') send(response, [...pending.values()].flat());
    else {
      const promptParts = url.pathname.split('/'); const prompt = promptParts.length === 4 && promptParts[1] === 'session' && promptParts[3] === 'prompt_async' ? [url.pathname, promptParts[2]] : null;
      const messageParts = url.pathname.split('/'); const messages = messageParts.length === 4 && messageParts[1] === 'session' && messageParts[3] === 'message' ? messageParts[2] : null;
      if (messages && request.method === 'GET') { send(response, [{parts:[{type:'tool',tool:attempted.get(messages),state:{status:'error'}}]}]); return; }
      if (prompt && request.method === 'POST') {
        const input = await body(request); const agentName = sessions.get(prompt[1]); const action = String(input.parts?.[0]?.text || '').split(':').at(-1); attempted.set(prompt[1], action);
        const config = JSON.parse(readFileSync(path.join(process.cwd(), 'opencode.json'), 'utf8'));
        await fetch(config.provider.openai.options.baseURL + '/responses', {method:'POST', body:'{}'});
        if (['naru-orchestrator','naru-writer','naru-writer-smoke'].includes(agentName) && ['safe_tools_read','codebase_read'].includes(action)) pending.get(prompt[1]).push({sessionID:prompt[1],permission:action});
        response.writeHead(204); response.end(); return;
      }
      const parts = url.pathname.split('/'); const match = parts.length === 5 && parts[1] === 'api' && parts[2] === 'session' && parts[4] === 'permission' ? [url.pathname, parts[3]] : null;
      if (!match) { response.writeHead(404); response.end('{}'); return; }
      const sessionID = match[1];
      if (request.method === 'GET') { send(response, {data:pending.get(sessionID) || []}); return; }
      const input = await body(request); const agentName = sessions.get(sessionID); const eligible = ['naru-orchestrator','naru-writer','naru-writer-smoke'].includes(agentName);
      const effect = eligible && ['safe_tools_read','codebase_read'].includes(input.action) ? 'ask'
        : agentName === 'naru-orchestrator' && input.action === 'codebase-memory-mcp_search_graph' ? 'allow' : 'deny';
      const item = {id:'per_' + (++sequence), action:input.action, effect};
      if (effect === 'ask') pending.get(sessionID).push(item);
      send(response, {data:item});
    }
  });
  server.listen(Number(args[4]), '127.0.0.1');
  process.on('SIGTERM', () => server.close(() => process.exit(0)));
} else process.exit(64);
`;
  await writeFile(executable, source);
  await chmod(executable, 0o755);
  const syntax = spawnSync(process.execPath, ['--check', executable], { encoding: 'utf8' });
  assert.equal(syntax.status, 0, syntax.stderr);
  return executable;
}

test('provider-free fake OpenCode smoke isolates environment, checks depth/default-off, and cleans up', async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'naru-compat-test-'));
  let disposable: string | undefined;
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
      profile: 'stable',
      sourcePath: root,
      platformEvidence,
    }, { onDisposableRoot: value => { disposable = value; } });
    assert.equal(report.status, 'passed-local-smoke', JSON.stringify(report));
    assert.equal(report.providerFree, true);
    assert.equal(report.candidateIdentity, 'unverified');
    assert.equal(report.versionEvidence.classification, 'historical-tested');
    assert.equal(report.capabilities.hostContract.coreConfig, 'passed');
    assert.equal(report.capabilities.hostContract.mcpPermissions, 'passed');
    assert.ok(report.checks.every(check => check.status !== 'failed'));
    assert.equal(report.capabilities.dashboard.nativeTuiLoad, 'omitted');
    assert.doesNotMatch(JSON.stringify(report), new RegExp(AGENT_LIST_OUTPUT_MARKER));
    assert.doesNotMatch(JSON.stringify(report), new RegExp(DEBUG_CONFIG_OUTPUT_MARKER));
    assert.ok(disposable);
    await assert.rejects(lstat(disposable), (error: unknown) => (
      error instanceof Error && 'code' in error && error.code === 'ENOENT'
    ));
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test('an unlisted stable version runs the full probe without becoming release-qualified', async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'naru-compat-candidate-'));
  try {
    const report = await runCompatibilitySmoke({
      opencodePath: await fakeOpenCode(temporary, { version: '1.18.29' }),
      profile: 'stable', sourcePath: root,
      platformEvidence: { platform: 'darwin', arch: 'arm64' },
    });
    assert.equal(report.status, 'passed-local-smoke', JSON.stringify(report));
    assert.equal(report.versions.opencode.status, 'candidate');
    assert.equal(report.versionEvidence.classification, 'candidate-probe-required');
    assert.equal(report.versionEvidence.localProbe, 'passed');
    assert.equal(report.releaseQualification, 'not-established');
    assert.ok(REQUIRED_COMPATIBILITY_CHECKS.stable.every(id => report.checks.some(check => check.id === id && check.status === 'passed')));

    const noProbe = createCompatibilityEvidence({
      profile: 'stable',
      platform: evaluatePlatformTarget({ platform: 'darwin', arch: 'arm64' }),
      versions: { node: '24.0.0', opencode: '9.0.0' },
      checks: [],
    });
    assert.equal(noProbe.status, 'failed-local-smoke');
    assert.equal(noProbe.versions.opencode.status, 'candidate');
  } finally { await rm(temporary, { recursive: true, force: true }); }
});

test('stable profile rejects prerelease and invalid version output before host probing', async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'naru-compat-rejected-'));
  try {
    for (const version of ['2.0.0-beta.1', 'invalid'] as const) {
      const report = await runCompatibilitySmoke({
        opencodePath: await fakeOpenCode(temporary, { version }),
        profile: 'stable', sourcePath: root,
        platformEvidence: { platform: 'darwin', arch: 'arm64' },
      });
      assert.equal(report.status, 'failed-local-smoke');
      assert.deepEqual(report.checks.map(check => check.id), ['target-platform', 'opencode-version', 'cleanup']);
      assert.equal(report.versionEvidence.classification, 'rejected');
    }
  } finally { await rm(temporary, { recursive: true, force: true }); }
});

test('failed tool output is redacted from bounded evidence', async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'naru-compat-redact-'));
  try {
    const fake = await fakeOpenCode(temporary, { failDebugConfig: true });
    const report = await runCompatibilitySmoke({
      opencodePath: fake,
      profile: 'stable',
      sourcePath: root,
      platformEvidence: { platform: 'darwin', arch: 'arm64', osId: null, wsl: false },
    });
    assert.equal(report.status, 'failed-local-smoke');
    assert.equal(report.checks.find(check => check.id === 'opencode-debug-config')?.status, 'failed');
    assert.doesNotMatch(JSON.stringify(report), /SUPER_SECRET_VALUE/);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test('successful host commands cannot hide a disabled dispatch plugin', async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'naru-compat-no-plugin-'));
  try {
    const report = await runCompatibilitySmoke({
      opencodePath: await fakeOpenCode(temporary, { disablePlugin: true }),
      profile: 'stable', sourcePath: root,
      platformEvidence: { platform: 'darwin', arch: 'arm64' },
    });
    assert.equal(report.status, 'failed-local-smoke');
    assert.equal(report.checks.find(check => check.id === 'core-config')?.diagnostic, 'review-defaults-missing');
  } finally { await rm(temporary, { recursive: true, force: true }); }
});

test('v2 beta smoke is exact-build exploratory and runs only confirmed commands', async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'naru-compat-v2-'));
  try {
    const fake = await fakeOpenCode(temporary, { version: '0.0.0-beta-19425' });
    const report = await runCompatibilitySmoke({
      opencodePath: fake,
      profile: 'v2-beta-exploratory',
      sourcePath: root,
      platformEvidence: { platform: 'darwin', arch: 'arm64', osId: null, wsl: false },
    });
    assert.equal(report.status, 'passed-exploratory-smoke');
    assert.deepEqual(report.checks.map(check => check.id), ['target-platform', 'opencode-version', 'opencode-help', 'cleanup']);

    const drift = await fakeOpenCode(temporary, { version: '0.0.0-beta-19271' });
    const failed = await runCompatibilitySmoke({
      opencodePath: drift,
      profile: 'v2-beta-exploratory',
      sourcePath: root,
      platformEvidence: { platform: 'darwin', arch: 'arm64', osId: null, wsl: false },
    });
    assert.equal(failed.status, 'failed-exploratory-smoke');
    assert.deepEqual(failed.checks.map(check => check.id), ['target-platform', 'opencode-version', 'cleanup']);
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
