import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  LIVE_EVALUATION_REDACTION,
  NARU_RUNTIME_ARTIFACT_PATHS,
  aggregateSanitizedLiveRuns,
  createIsolatedLiveEnvironment,
  createLiveRunContract,
  inspectCandidateArtifacts,
  inspectSyntheticFixture,
  loadAuthorizedLiveContract,
  materializeSyntheticFixture,
  runAuthorizedLiveEvaluation,
  validateLiveRunContract,
} from '../tools/naru-lib/live-evaluation.mjs';
import {
  inspectOpenCodeExecutable,
  requestOpenCode,
  runOpenCodeLiveEvaluation,
} from '../tools/naru-lib/opencode-live-evaluation.mjs';

const specificationPath = fileURLToPath(new URL('./fixtures/live-evals.json', import.meta.url));
const fixturesRoot = fileURLToPath(new URL('./fixtures/live-evals', import.meta.url));
const fakeOpenCodePath = fileURLToPath(new URL('./fixtures/live-evals/fake-opencode.mjs', import.meta.url));
const liveCliPath = fileURLToPath(new URL('../scripts/naru-live-eval.mjs', import.meta.url));
const specification = JSON.parse(await readFile(specificationPath, 'utf8'));
const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));
const candidateInspection = await inspectCandidateArtifacts(repositoryRoot);

function sha(value) {
  return createHash('sha256').update(value).digest('hex');
}

async function makeContract(overrides = {}) {
  return createLiveRunContract({
    specification,
    fixturesRoot,
    candidate: { id: 'candidate-a', revision: 'revision-a', digest: candidateInspection.digest },
    opencode: { id: 'opencode', version: '2.0.0', executableDigest: 'b'.repeat(64) },
    provider: { id: 'none', version: 'not-invoked' },
    model: { id: 'none', version: 'not-invoked' },
    ...overrides,
  });
}

async function writeContract(directory, contract) {
  const text = `${JSON.stringify(contract, null, 2)}\n`;
  const path = join(directory, 'live-contract.json');
  await writeFile(path, text, { mode: 0o600 });
  return { path, confirmation: sha(text) };
}

function passingResult(rubricIds) {
  return {
    passed: true,
    stopCode: null,
    metrics: {
      elapsedMs: 10, childCount: 2, peakConcurrency: 2, requestCount: 3,
      capturedBytes: 128, inputTokens: 20, outputTokens: 10,
    },
    usageCostUsdMicros: null,
    rubric: rubricIds.map((id) => ({ id, passed: true })),
    safety: {
      deadlineMet: 'observed', networkContained: 'observed', noPersistentDataWrite: 'observed', noPost: 'observed',
      noRawOutput: 'observed', noSecret: 'observed', scopeContained: 'observed',
    },
    limitations: ['structural-only'],
  };
}

test('live contracts bind exact fixtures, matched topology, limits, and canonical digest', async () => {
  const first = await makeContract();
  const second = await makeContract();
  assert.deepEqual(first, second);
  assert.equal(validateLiveRunContract(first).contractDigest, first.contractDigest);
  assert.equal(first.case.ids.length, 7);
  assert.equal(Object.keys(first.fixtureDigests).length, 7);
  assert.equal(first.baseline.sameInputs, true);
  assert.equal(first.mutation.fixtureOnly, true);
  assert.equal(first.cleanup.verify, true);
  assert.equal(first.spend.maxUsdMicros, 0);
  const changed = structuredClone(first);
  changed.model.version = 'other';
  assert.throws(() => validateLiveRunContract(changed), /contractDigest does not match/);
  await assert.rejects(() => makeContract({ repetitions: 4 }), /repetition.count must be an integer/);
});

test('synthetic fixtures reject remote, secret, dependency, oversized, linked, and traversal inputs', async () => {
  const inspected = await inspectSyntheticFixture(fixturesRoot, specification.cases[0].fixture);
  assert.equal(inspected.fileCount, 1);
  assert.match(inspected.digest, /^[a-f0-9]{64}$/);
  const temporary = await mkdtemp(join(tmpdir(), 'naru-fixture-safety-'));
  try {
    await mkdir(join(temporary, 'remote'));
    await writeFile(join(temporary, 'remote', 'project.txt'), 'fetch https://example.com/repository');
    await assert.rejects(() => inspectSyntheticFixture(temporary, { id: 'remote', path: 'remote' }), /remote reference/);
    await mkdir(join(temporary, 'secret'));
    await writeFile(join(temporary, 'secret', '.env'), 'VALUE=example');
    await assert.rejects(() => inspectSyntheticFixture(temporary, { id: 'secret', path: 'secret' }), /prohibited path name/);
    await mkdir(join(temporary, 'dependency'));
    await writeFile(join(temporary, 'dependency', 'package.json'), '{"dependencies":{"example":"1.0.0"}}');
    await assert.rejects(() => inspectSyntheticFixture(temporary, { id: 'dependency', path: 'dependency' }), /declares dependencies/);
    await mkdir(join(temporary, 'oversize'));
    await writeFile(join(temporary, 'oversize', 'large.txt'), 'x'.repeat(16 * 1024 + 1));
    await assert.rejects(() => inspectSyntheticFixture(temporary, { id: 'oversize', path: 'oversize' }), /exceeds 16384 bytes/);
    await mkdir(join(temporary, 'linked'));
    await writeFile(join(temporary, 'outside.txt'), 'outside');
    await symlink(join(temporary, 'outside.txt'), join(temporary, 'linked', 'value.txt'));
    await assert.rejects(() => inspectSyntheticFixture(temporary, { id: 'linked', path: 'linked' }), /symbolic link/);
    await assert.rejects(() => inspectSyntheticFixture(temporary, { id: 'traversal', path: '../remote' }), /safe relative directory/);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test('materialization isolates environment and verifies cleanup', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'naru-materialization-'));
  try {
    const sandbox = await materializeSyntheticFixture({
      fixturesRoot,
      fixture: specification.cases[0].fixture,
      temporaryParent: temporary,
      baseEnvironment: { PATH: '/bin', LANG: 'C', AWS_SECRET_ACCESS_KEY: 'not-forwarded', HOME: '/outside' },
    });
    assert.equal((await stat(sandbox.runnerRoot)).mode & 0o777, 0o700);
    assert.equal(sandbox.environment.PATH, '/bin');
    assert.equal(Object.hasOwn(sandbox.environment, 'AWS_SECRET_ACCESS_KEY'), false);
    assert.ok(sandbox.environment.HOME.startsWith(`${sandbox.runnerRoot}/`));
    await sandbox.cleanup();
    await assert.rejects(() => lstat(sandbox.runnerRoot), { code: 'ENOENT' });
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test('authorization rejects mismatched confirmations before execution', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'naru-authorization-'));
  try {
    const contract = await makeContract();
    const authorization = await writeContract(temporary, contract);
    let executions = 0;
    await assert.rejects(() => runAuthorizedLiveEvaluation({
      contractPath: authorization.path,
      confirmationSha256: '0'.repeat(64),
      contractDigestConfirmation: contract.contractDigest,
      specification,
      fixturesRoot,
      temporaryParent: temporary,
      execute: async () => { executions += 1; },
    }), /confirmation mismatch/);
    assert.equal(executions, 0);
    await assert.rejects(() => loadAuthorizedLiveContract(authorization.path, 'not-a-digest'), /exact lowercase SHA-256/);
    await assert.rejects(() => runOpenCodeLiveEvaluation({}), /live contract file is required/);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test('candidate artifact bytes and OpenCode executable provenance block mismatched execution', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'naru-provenance-'));
  try {
    const contract = await makeContract({ baselineKind: 'none' });
    const authorization = await writeContract(temporary, contract);
    const changedRoot = join(temporary, 'changed-candidate');
    for (const path of NARU_RUNTIME_ARTIFACT_PATHS) {
      await mkdir(join(changedRoot, ...path.split('/').slice(0, -1)), { recursive: true });
      await copyFile(join(repositoryRoot, ...path.split('/')), join(changedRoot, ...path.split('/')));
    }
    await writeFile(join(changedRoot, ...NARU_RUNTIME_ARTIFACT_PATHS[0].split('/')), '// changed\n');
    await assert.rejects(() => inspectCandidateArtifacts(changedRoot, ['../outside']), /unknown or prohibited path/);
    await assert.rejects(() => inspectCandidateArtifacts(changedRoot, ['missing.mjs']), { code: 'ENOENT' });
    await symlink(
      join(changedRoot, ...NARU_RUNTIME_ARTIFACT_PATHS[0].split('/')),
      join(changedRoot, 'linked.mjs'),
    );
    await assert.rejects(() => inspectCandidateArtifacts(changedRoot, ['linked.mjs']), /non-symlink file/);
    await writeFile(join(changedRoot, 'oversized.mjs'), Buffer.alloc(512 * 1024 + 1));
    await assert.rejects(() => inspectCandidateArtifacts(changedRoot, ['oversized.mjs']), /exceeds 524288 bytes/);
    let executions = 0;
    await assert.rejects(() => runAuthorizedLiveEvaluation({
      contractPath: authorization.path,
      confirmationSha256: authorization.confirmation,
      contractDigestConfirmation: contract.contractDigest,
      specification,
      fixturesRoot,
      candidateRoot: changedRoot,
      temporaryParent: temporary,
      execute: async () => { executions += 1; },
    }), (error) => error?.code === 'NARU_LIVE_PROVENANCE_FAILURE');
    assert.equal(executions, 0);

    let runCommands = 0;
    const runWithObservedOpenCode = (opencode) => runOpenCodeLiveEvaluation({
      contractPath: authorization.path,
      confirmationSha256: authorization.confirmation,
      contractDigestConfirmation: contract.contractDigest,
      specification,
      fixturesRoot,
      temporaryParent: temporary,
      opencodeExecutable: fakeOpenCodePath,
      opencodePreflightImplementation: async () => opencode,
      spawnImplementation: () => { runCommands += 1; throw new Error('run command must not start'); },
    });
    await assert.rejects(() => runWithObservedOpenCode({
      version: '2.0.1', executableDigest: 'b'.repeat(64),
    }), (error) => error?.code === 'NARU_LIVE_PROVENANCE_FAILURE');
    await assert.rejects(() => runWithObservedOpenCode({
      version: '2.0.0', executableDigest: 'c'.repeat(64),
    }), (error) => error?.code === 'NARU_LIVE_PROVENANCE_FAILURE');
    assert.equal(runCommands, 0);

    const swappedRoot = join(temporary, 'swapped-candidate');
    for (const path of NARU_RUNTIME_ARTIFACT_PATHS) {
      await mkdir(join(swappedRoot, ...path.split('/').slice(0, -1)), { recursive: true });
      await copyFile(join(repositoryRoot, ...path.split('/')), join(swappedRoot, ...path.split('/')));
    }
    const swappedInspection = await inspectCandidateArtifacts(swappedRoot);
    const swappedContract = await makeContract({
      baselineKind: 'none',
      candidateRoot: swappedRoot,
      candidate: { id: 'candidate-a', revision: 'revision-a', digest: swappedInspection.digest },
    });
    const swappedAuthorization = await writeContract(temporary, swappedContract);
    let swappedPreflights = 0;
    let swappedExecutions = 0;
    const executeAfterSwap = async () => { swappedExecutions += 1; };
    executeAfterSwap.preflight = async () => {
      swappedPreflights += 1;
      await writeFile(join(swappedRoot, ...NARU_RUNTIME_ARTIFACT_PATHS[0].split('/')), '// replaced after preflight\n');
      return {
        opencode: { version: '2.0.0', executableDigest: 'b'.repeat(64) },
        providerBudget: { status: 'not-required', maxOutputTokens: 0, maxCostPerRequestUsdMicros: 0 },
      };
    };
    await assert.rejects(() => runAuthorizedLiveEvaluation({
      contractPath: swappedAuthorization.path,
      confirmationSha256: swappedAuthorization.confirmation,
      contractDigestConfirmation: swappedContract.contractDigest,
      specification,
      fixturesRoot,
      candidateRoot: swappedRoot,
      temporaryParent: temporary,
      execute: executeAfterSwap,
    }), (error) => error?.code === 'NARU_LIVE_PROVENANCE_FAILURE');
    assert.equal(swappedPreflights, 1);
    assert.equal(swappedExecutions, 0);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test('simulated out-of-root mutation and unauthorized egress claims cannot pass containment', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'naru-containment-'));
  try {
    const contract = await makeContract({ baselineKind: 'none' });
    const authorization = await writeContract(temporary, contract);
    let simulatedEgress = false;
    const report = await runAuthorizedLiveEvaluation({
      contractPath: authorization.path,
      confirmationSha256: authorization.confirmation,
      contractDigestConfirmation: contract.contractDigest,
      specification,
      fixturesRoot,
      temporaryParent: temporary,
      async execute(context) {
        await writeFile(join(temporary, 'out-of-root.txt'), 'mutation outside disposable workspace');
        simulatedEgress = true;
        return passingResult(context.execution.rubricIds);
      },
    });
    assert.equal(simulatedEgress, true);
    assert.equal(report.runs[0].passed, false);
    assert.equal(report.runs[0].safety.scopeContained, 'unknown');
    assert.equal(report.runs[0].safety.networkContained, 'unknown');
    assert.equal(report.aggregate.passed, false);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test('provider-free injected execution remains sanitized and fails closed on unattested containment', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'naru-execution-'));
  try {
    const contract = await makeContract();
    const authorization = await writeContract(temporary, contract);
    const invocations = [];
    const report = await runAuthorizedLiveEvaluation({
      contractPath: authorization.path,
      confirmationSha256: authorization.confirmation,
      contractDigestConfirmation: contract.contractDigest,
      specification,
      fixturesRoot,
      temporaryParent: temporary,
      baseEnvironment: { PATH: '/bin', HOME: '/outside', GITHUB_TOKEN: 'not-forwarded' },
      async execute(context) {
        invocations.push({ caseId: context.caseDefinition.id, baseline: context.baseline });
        return passingResult(context.execution.rubricIds);
      },
    });
    assert.equal(invocations.length, 1);
    assert.equal(report.runs.length, 1);
    assert.equal(report.aggregate.passedRunCount, 0);
    assert.equal(report.aggregate.passed, false);
    assert.equal(report.provenance.opencode.status, 'unknown');
    assert.equal(report.runs[0].safety.scopeContained, 'unknown');
    assert.equal(report.runs[0].safety.networkContained, 'unknown');
    assert.ok(report.runs[0].limitations.includes('runtime-bytes-not-bound'));
    assert.equal(report.aggregate.cleanup.complete, true);
    assert.equal(report.aggregate.usageCostUsdMicros, null);
    assert.deepEqual(report.redaction, LIVE_EVALUATION_REDACTION);
    assert.doesNotMatch(JSON.stringify(report), /not-forwarded|\/outside|GITHUB_TOKEN|"parts"|"text"/);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test('read-only mutation and timeout fail closed after verified cleanup', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'naru-fail-closed-'));
  try {
    const mutationContract = await makeContract();
    const mutationAuthorization = await writeContract(temporary, mutationContract);
    const mutation = await runAuthorizedLiveEvaluation({
      contractPath: mutationAuthorization.path,
      confirmationSha256: mutationAuthorization.confirmation,
      contractDigestConfirmation: mutationContract.contractDigest,
      specification,
      fixturesRoot,
      temporaryParent: temporary,
      async execute(context) {
        await writeFile(join(context.workspace, 'project.json'), '{"changed":true}\n');
        return passingResult(context.execution.rubricIds);
      },
    });
    assert.equal(mutation.runs[0].stopCode, 'mutation-detected');
    assert.equal(mutation.runs[0].cleanup.complete, true);

    const timeoutContract = await makeContract({ caseTimeoutMs: 100, requestTimeoutMs: 50 });
    const timeoutAuthorization = await writeContract(temporary, timeoutContract);
    const timeout = await runAuthorizedLiveEvaluation({
      contractPath: timeoutAuthorization.path,
      confirmationSha256: timeoutAuthorization.confirmation,
      contractDigestConfirmation: timeoutContract.contractDigest,
      specification,
      fixturesRoot,
      temporaryParent: temporary,
      async execute(context) {
        return new Promise((resolve) => context.registerCleanup(() => resolve(passingResult(context.execution.rubricIds))));
      },
    });
    assert.equal(timeout.runs[0].stopCode, 'timeout');
    assert.equal(timeout.runs[0].cleanup.complete, true);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test('request and spend preflights stop before unauthorized work', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'naru-live-bounds-'));
  try {
    const requestContract = await makeContract({ maxRequestCount: 1 });
    const requestAuthorization = await writeContract(temporary, requestContract);
    let requestExecutions = 0;
    const requestReport = await runAuthorizedLiveEvaluation({
      contractPath: requestAuthorization.path,
      confirmationSha256: requestAuthorization.confirmation,
      contractDigestConfirmation: requestContract.contractDigest,
      specification,
      fixturesRoot,
      temporaryParent: temporary,
      async execute(context) {
        requestExecutions += 1;
        context.runtime.beforeRequest();
        context.runtime.beforeRequest();
      },
    });
    assert.equal(requestExecutions, 1);
    assert.equal(requestReport.runs[0].stopCode, 'request-limit');

    const costContract = await makeContract({
      provider: { id: 'fake-provider', version: '1' },
      network: { mode: 'provider', target: 'fake-provider' },
      maxSpendUsdMicros: 10,
      maxCostPerRequestUsdMicros: 5,
    });
    const costAuthorization = await writeContract(temporary, costContract);
    let providerExecutions = 0;
    await assert.rejects(() => runAuthorizedLiveEvaluation({
      contractPath: costAuthorization.path,
      confirmationSha256: costAuthorization.confirmation,
      contractDigestConfirmation: costContract.contractDigest,
      specification,
      fixturesRoot,
      temporaryParent: temporary,
      async execute(context) {
        providerExecutions += 1;
        return passingResult(context.execution.rubricIds);
      },
    }), (error) => error?.code === 'NARU_LIVE_BUDGET_UNENFORCED');
    assert.equal(providerExecutions, 0);

    let localRunCommands = 0;
    await assert.rejects(() => runOpenCodeLiveEvaluation({
      contractPath: costAuthorization.path,
      confirmationSha256: costAuthorization.confirmation,
      contractDigestConfirmation: costContract.contractDigest,
      specification,
      fixturesRoot,
      temporaryParent: temporary,
      opencodeExecutable: fakeOpenCodePath,
      opencodePreflightImplementation: async () => ({
        version: '2.0.0', executableDigest: 'b'.repeat(64),
      }),
      spawnImplementation: () => { localRunCommands += 1; throw new Error('run command must not start'); },
    }), (error) => error?.code === 'NARU_LIVE_BUDGET_UNENFORCED');
    assert.equal(localRunCommands, 0);

    const enforcedExecutor = async () => { providerExecutions += 1; };
    enforcedExecutor.preflight = async () => ({
      opencode: { version: '2.0.0', executableDigest: 'b'.repeat(64) },
      providerBudget: { status: 'enforced', maxOutputTokens: 10, maxCostPerRequestUsdMicros: 5 },
    });
    await assert.rejects(() => runAuthorizedLiveEvaluation({
      contractPath: costAuthorization.path,
      confirmationSha256: costAuthorization.confirmation,
      contractDigestConfirmation: costContract.contractDigest,
      specification,
      fixturesRoot,
      temporaryParent: temporary,
      execute: enforcedExecutor,
    }), /conservatively reserve/);
    assert.equal(providerExecutions, 0);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test('aggregation and isolated environments expose only sanitized bounded evidence', async () => {
  const contract = await makeContract();
  const result = passingResult(['correctness', 'safety']);
  const run = {
    schemaVersion: 1,
    contractDigest: contract.contractDigest,
    candidateId: contract.candidate.id,
    caseId: contract.case.ids[0],
    repetition: 1,
    baseline: false,
    matchDigest: 'a'.repeat(64),
    topologyDigest: 'b'.repeat(64),
    passed: true,
    stopCode: null,
    metrics: result.metrics,
    usageCostUsdMicros: null,
    usageCostMissing: true,
    rubric: result.rubric,
    safety: { ...result.safety, cleanupComplete: true },
    cleanup: { attempted: true, complete: true, mutationContained: true },
    limitations: ['structural-only'],
  };
  const aggregate = aggregateSanitizedLiveRuns(contract, [run], false);
  assert.deepEqual(aggregate.ranges.elapsedMs, { minimum: 10, maximum: 10 });
  assert.equal(aggregate.usageCostUsdMicros, null);
  assert.equal(aggregate.safety.noSecret, 'observed');
  assert.doesNotMatch(JSON.stringify(aggregate), /retained prompt|retained source|retained diff|retained output|absolute path|credential value|session identifier/i);

  const environment = createIsolatedLiveEnvironment({ PATH: '/bin', TOKEN: 'excluded' }, {
    home: '/owned/home', xdgConfig: '/owned/config', xdgCache: '/owned/cache', xdgData: '/owned/data',
    xdgState: '/owned/state', opencode: '/owned/opencode', sessions: '/owned/sessions',
    worktrees: '/owned/worktrees', tmp: '/owned/tmp',
  });
  assert.equal(environment.TOKEN, undefined);
});

test('local adapter rejects replaced explicit and PATH-resolved executables before inspection, execution, or request', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'naru-local-unavailable-'));
  try {
    const executable = join(temporary, 'opencode');
    await writeFile(executable, '#!/usr/bin/env node\nconsole.log("opencode 2.0.0");\n');
    await chmod(executable, 0o700);
    const explicitPreflight = await inspectOpenCodeExecutable({ executable });
    const pathPreflight = await inspectOpenCodeExecutable({
      executable: 'opencode',
      environment: { PATH: `${temporary}${delimiter}${process.env.PATH}` },
    });
    assert.deepEqual(pathPreflight, explicitPreflight);
    const contract = await makeContract({
      baselineKind: 'none',
      opencode: { id: 'opencode', ...explicitPreflight },
    });
    const authorization = await writeContract(temporary, contract);
    await writeFile(executable, '#!/usr/bin/env node\nthrow new Error("replacement must not execute");\n');
    let inspections = 0;
    let runCommands = 0;
    let requests = 0;
    const runUnavailable = (opencodeExecutable, baseEnvironment = process.env) => runOpenCodeLiveEvaluation({
      contractPath: authorization.path,
      confirmationSha256: authorization.confirmation,
      contractDigestConfirmation: contract.contractDigest,
      specification,
      fixturesRoot,
      temporaryParent: temporary,
      opencodeExecutable,
      baseEnvironment,
      opencodePreflightImplementation: async () => {
        inspections += 1;
        return { version: '2.0.0', executableDigest: 'b'.repeat(64) };
      },
      spawnImplementation: () => { runCommands += 1; throw new Error('run command must not start'); },
      fetchImplementation: async () => { requests += 1; throw new Error('request must not start'); },
    });
    await assert.rejects(() => runUnavailable(executable), (error) => error?.code === 'NARU_LIVE_PROVENANCE_FAILURE');
    await assert.rejects(
      () => runUnavailable('opencode', { PATH: `${temporary}${delimiter}${process.env.PATH}` }),
      (error) => error?.code === 'NARU_LIVE_PROVENANCE_FAILURE',
    );
    assert.equal(inspections, 0);
    assert.equal(runCommands, 0);
    assert.equal(requests, 0);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test('OpenCode adapter refuses non-loopback and fake CLI remains provider-free', async () => {
  let fetched = false;
  await assert.rejects(() => requestOpenCode({
    baseUrl: 'https://example.com/', path: '/global/health', timeoutMs: 50, maxCaptureBytes: 128,
    fetchImplementation: async () => { fetched = true; },
  }), /loopback HTTP/);
  assert.equal(fetched, false);

  const temporary = await mkdtemp(join(tmpdir(), 'naru-live-cli-'));
  try {
    const executable = join(temporary, 'fake-opencode');
    await copyFile(fakeOpenCodePath, executable);
    await chmod(executable, 0o700);
    const contract = await makeContract({ baselineKind: 'none' });
    const authorization = await writeContract(temporary, contract);
    const result = spawnSync(process.execPath, [
      liveCliPath, '--live', '--manifest', specificationPath, '--fixtures', fixturesRoot,
      '--contract', authorization.path, '--contract-sha256', authorization.confirmation,
      '--confirm-contract-digest', contract.contractDigest, '--confirm-provider-cost',
      '--opencode-executable', executable,
    ], { encoding: 'utf8', timeout: 30_000 });
    assert.equal(result.status, 2);
    assert.match(result.stderr, /local OpenCode live execution is unavailable because candidate and executable bytes are not bound through execution/);
    assert.equal(result.stdout, '');
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});
