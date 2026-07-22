import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';

import {
  LIVE_EVALUATION_CASES,
  LIVE_EVALUATION_REDACTION,
  evaluateLiveCapture,
} from '../tools/naru-lib/live-evaluation.mjs';
import {
  requestOpenCode,
  runOpenCodeLiveEvaluation,
} from '../tools/naru-lib/opencode-live-evaluation.mjs';

const root = { id: 'root', createdAt: 1000, completedAt: 2000 };

function session(id, parentID, agent, createdAt, completedAt, extra = {}) {
  return {
    id,
    parentID,
    agent,
    provider: 'openai',
    model: agent.includes('architecture') || agent.includes('risk') || agent.includes('judge')
      ? 'gpt-5.6-sol-fast'
      : 'gpt-5.6-terra-fast',
    variant: 'high',
    createdAt,
    completedAt,
    ...extra,
  };
}

function completeCapture() {
  return {
    caseId: 'plan-fanout',
    root,
    sessions: [
      session('plan', 'root', 'naru-plan', 1010, 1900),
      session('architecture', 'plan', 'naru-plan-architecture', 1100, 1400),
      session('minimal', 'plan', 'naru-delegate-sol-plan-minimal-change', 1101, 1450),
      session('risk', 'plan', 'naru-plan-risk', 1102, 1425),
      session('tests', 'plan', 'naru-plan-tests', 1103, 1410),
      session('judge', 'plan', 'naru-plan-judge', 1500, 1800),
    ],
    observation: { polls: 20, statusTransitions: 12 },
  };
}

async function localServer(handler) {
  const server = createServer(handler);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}`,
    async close() {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

test('live evaluator proves nested fan-out, route choice, concurrency, and judge ordering', () => {
  const report = evaluateLiveCapture(completeCapture());
  assert.equal(report.passed, true);
  assert.equal(report.metrics.childCount, 6);
  assert.equal(report.metrics.maximumDepth, 2);
  assert.equal(report.metrics.peakDescendantConcurrency, 5);
  assert.equal(report.metrics.peakSpecialistConcurrency, 4);
  assert.equal(report.metrics.observationPolls, 20);
  assert.equal(report.agents.find((agent) => agent.agent === 'naru-plan-minimal-change').route, 'naru-delegate-sol-plan-minimal-change');
  assert.deepEqual(report.failures, []);
});

test('live evaluator fails closed for missing roles, serialized specialists, early judge, and excessive depth', () => {
  const capture = completeCapture();
  capture.sessions = capture.sessions.filter((entry) => entry.agent !== 'naru-plan-tests');
  capture.sessions.find((entry) => entry.agent === 'naru-plan-risk').createdAt = 1450;
  capture.sessions.find((entry) => entry.agent === 'naru-plan-risk').completedAt = 1600;
  capture.sessions.find((entry) => entry.agent === 'naru-plan-judge').createdAt = 1300;
  capture.sessions.push(session('nested', 'judge', 'naru-plan-minimal-change', 1650, 1700));

  const report = evaluateLiveCapture(capture);
  assert.equal(report.passed, false);
  assert.ok(report.failures.some((item) => item.code === 'missing-required-agent' && item.detail === 'naru-plan-tests'));
  assert.ok(report.failures.some((item) => item.code === 'invalid-depth'));
  assert.ok(report.failures.some((item) => item.code === 'insufficient-specialist-concurrency'));
  assert.ok(report.failures.some((item) => item.code === 'judge-started-before-specialists-completed'));
});

test('live evaluator output is structural and omits captured prompts, code, diffs, and outputs', () => {
  const capture = completeCapture();
  capture.sessions[0].prompt = 'secret prompt marker';
  capture.sessions[0].output = 'secret output marker';
  capture.sessions[0].diff = 'secret diff marker';
  capture.sessions[0].code = 'secret code marker';
  const report = evaluateLiveCapture(capture, LIVE_EVALUATION_CASES['plan-fanout']);
  const text = JSON.stringify(report);
  assert.deepEqual(report.redaction, LIVE_EVALUATION_REDACTION);
  for (const marker of ['secret prompt marker', 'secret output marker', 'secret diff marker', 'secret code marker']) {
    assert.ok(!text.includes(marker));
  }
  assert.deepEqual(Object.keys(report.agents[0]).sort(), [
    'agent', 'depth', 'durationMs', 'model', 'provider', 'route', 'startMs', 'status', 'variant',
  ]);
});

test('live evaluator HTTP requests abort a hung local response within their request deadline', async () => {
  const server = await localServer(() => {});
  const startedAt = Date.now();
  try {
    await assert.rejects(
      requestOpenCode(server.url, '/tmp', 'GET', '/hung', undefined, { timeoutMs: 50 }),
      /OpenCode GET \/hung request timed out after 50ms/,
    );
    assert.ok(Date.now() - startedAt < 500, 'hung response exceeded its request deadline bound');
  } finally {
    await server.close();
  }
});

test('live evaluator omits secret-bearing non-2xx response bodies from bounded diagnostics', async () => {
  const markers = [
    'secret prompt marker',
    'secret output marker',
    'bearer ghp_abcdefghijklmnopqrstuvwxyz123456',
  ];
  const server = await localServer((_request, response) => {
    response.writeHead(503, { 'content-type': 'text/plain' });
    response.end(markers.join('\n'));
  });
  try {
    let failure;
    await assert.rejects(
      requestOpenCode(server.url, '/tmp', 'POST', '/session/example/command', {}, { timeoutMs: 500 }),
      (error) => {
        failure = error;
        return /OpenCode POST \/session\/example\/command failed \(503\); response body omitted/.test(error.message);
      },
    );
    assert.ok(failure.message.length <= 512);
    for (const marker of markers) assert.ok(!failure.message.includes(marker));
  } finally {
    await server.close();
  }
});

test('live evaluator validates request timeout bounds before starting OpenCode', async () => {
  await assert.rejects(
    runOpenCodeLiveEvaluation({
      caseId: 'plan-fanout',
      directory: '/tmp',
      requestTimeoutMs: 99,
    }),
    /live evaluation request timeout must be from 100 to 900000 milliseconds/,
  );
  await assert.rejects(
    runOpenCodeLiveEvaluation({
      caseId: 'plan-fanout',
      directory: '/tmp',
      requestTimeoutMs: 900001,
    }),
    /live evaluation request timeout must be from 100 to 900000 milliseconds/,
  );
});
