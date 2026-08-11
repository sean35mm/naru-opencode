import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import * as validate from '../tools/naru-lib/validate.mjs';
import { runGit, validateGitInput } from '../tools/naru-lib/git.mjs';
import {
  parseReference,
  pullSnapshot,
  fetchSourceAtSha,
  snapshotId,
  digestSnapshot,
} from '../tools/naru-lib/github.mjs';
import { postReview, validateReviewPayload } from '../tools/naru-lib/review.mjs';
import gitReadTool from '../tools/naru-git-read.js';
import githubReadTool from '../tools/naru-github-read.js';
import githubPostReviewTool from '../tools/naru-github-post-review.js';
const NON_POSTING_AGENTS = Object.freeze([
  'naru-reader',
  'naru-runner',
  'naru-writer',
  'naru-reader-sol',
  'naru-writer-sol',
  'naru-minion-implement',
  'naru-minion-judge',
]);

const HEAD = 'a'.repeat(40);
const BASE = 'b'.repeat(40);

function response(value, ok = true) {
  return {
    ok,
    code: ok ? 0 : 1,
    stdout: typeof value === 'string' ? value : JSON.stringify(value),
    stderr: ok ? '' : String(value),
    stdoutTruncated: false,
    stderrTruncated: false,
  };
}

function fakeSpawn(handlers) {
  const calls = [];
  const spawn = async (argv, options = {}) => {
    calls.push({ argv, options });
    const handler = handlers.find((candidate) => candidate.match(argv, options));
    if (!handler) throw new Error(`unexpected spawn: ${argv.join(' ')}`);
    return typeof handler.reply === 'function' ? handler.reply(argv, options) : handler.reply;
  };
  return { spawn, calls };
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function has(argv, value) {
  return argv.some((item) => item.includes(value));
}

function pullMeta(head = HEAD, base = BASE, changedFiles = 1, number = 42, overrides = {}) {
  return {
    number,
    title: overrides.title ?? 'Safe change',
    body: overrides.body ?? 'Description',
    state: overrides.state ?? 'open',
    draft: Object.hasOwn(overrides, 'draft') ? overrides.draft : false,
    html_url: `https://github.com/owner/repo/pull/${number}`,
    user: { login: overrides.author ?? 'author' },
    head: { sha: head, ref: 'feature' },
    base: { sha: base, ref: 'main' },
    changed_files: changedFiles,
  };
}

function changedFile(filename = 'src/index.js', patch = '@@ -1,1 +1,1 @@\n-old\n+new') {
  return {
    filename,
    status: 'modified',
    sha: 'c'.repeat(40),
    additions: 1,
    deletions: 1,
    changes: 2,
    patch,
  };
}

function snapshotHandlers({
  number = 42,
  meta = pullMeta(),
  files = [changedFile()],
  reviews = [],
  reviewComments = [],
  issueComments = [],
  metadataReply,
  actor = 'viewer',
} = {}) {
  return [
    { match: (argv) => argv[3] === 'GET' && argv[4] === 'user', reply: response({ login: actor }) },
    {
      match: (argv) => argv[3] === 'GET' && has(argv, `pulls/${number}`) && !has(argv, '/files') && !has(argv, '/reviews') && !has(argv, '/comments'),
      reply: metadataReply ?? response(meta),
    },
    { match: (argv) => argv[3] === 'GET' && has(argv, `pulls/${number}/files`), reply: response([files]) },
    { match: (argv) => argv[3] === 'GET' && has(argv, `pulls/${number}/reviews`), reply: response([reviews]) },
    { match: (argv) => argv[3] === 'GET' && has(argv, `pulls/${number}/comments`), reply: response([reviewComments]) },
    { match: (argv) => argv[3] === 'GET' && has(argv, `issues/${number}/comments`), reply: response([issueComments]) },
  ];
}

function reviewInput({
  number = 42,
  head = HEAD,
  base = BASE,
  files = [changedFile()],
  reviews = [],
  reviewComments = [],
  issueComments = [],
  status = 'complete',
  degraded = false,
  snapshotComplete = true,
  comments,
  body = '## Verdict\n\nNo actionable findings.',
} = {}) {
  const meta = pullMeta(head, base, files.length, number);
  return {
    reviewResult: {
      schemaVersion: 2,
      target: { owner: 'owner', repo: 'repo', pullNumber: number },
      snapshot: {
        id: snapshotId('owner', 'repo', number, head, base, files),
        baseSha: base,
        headSha: head,
        feedbackDigest: digestSnapshot(meta, files, reviews, reviewComments, issueComments),
        complete: snapshotComplete,
        warnings: [],
      },
      coverage: {
        complete: status === 'complete' && !degraded,
        limitations: status === 'complete' && !degraded ? [] : ['review coverage is incomplete'],
      },
      body,
      inlineComments: comments ?? [{
        path: 'src/index.js',
        line: 1,
        side: 'RIGHT',
        body: 'This changed line can fail.',
        priority: 'P1',
        severity: 'High',
        confidence: 'High',
      }],
      skippedInlineComments: [],
    },
  };
}

function reviewInputV3({
  number = 42,
  head = HEAD,
  base = BASE,
  files = [changedFile()],
  reviews = [],
  reviewComments = [],
  issueComments = [],
  posture = 'complete',
  limitations = posture === 'complete' ? [] : ['Patch evidence is unavailable'],
  snapshotComplete = posture === 'complete',
  snapshotWarnings = [],
  submissionPolicy = 'comment-only',
  conclusion = 'informational',
  findings = [],
  body = '## Verdict\n\nReview findings are listed below.',
} = {}) {
  const meta = pullMeta(head, base, files.length, number);
  return {
    reviewResult: {
      schemaVersion: 3,
      target: { owner: 'owner', repo: 'repo', pullNumber: number },
      snapshot: {
        id: snapshotId('owner', 'repo', number, head, base, files),
        baseSha: base,
        headSha: head,
        feedbackDigest: digestSnapshot(meta, files, reviews, reviewComments, issueComments),
        complete: snapshotComplete,
        warnings: snapshotWarnings,
      },
      coverage: { posture, limitations },
      body,
      submissionPolicy,
      conclusion,
      findings,
    },
  };
}

function largeMatchingPatch(changes, targetBytes = 16 * 1024) {
  const deletions = Math.floor(changes / 2);
  const additions = changes - deletions;
  const context = 2;
  const lines = [`@@ -1,${deletions + context} +1,${additions + context} @@`];
  lines.push(` ${'context'.repeat(Math.max(1, Math.ceil(targetBytes / 7)))}`);
  for (let index = 0; index < deletions; index += 1) lines.push(`-old-${index}`);
  for (let index = 0; index < additions; index += 1) lines.push(`+new-${index}`);
  lines.push(' tail');
  return { patch: lines.join('\n'), additions, deletions };
}

test('validators reject traversal, controls, secret paths, and option-like refs', () => {
  assert.equal(validate.isSafeRelativePath('src/index.js'), true);
  assert.equal(validate.isSafeRelativePath('.env.example'), true);
  assert.equal(validate.isSafeRelativePath('../secret'), false);
  assert.equal(validate.isSafeRelativePath('.git/config'), false);
  assert.equal(validate.isSafeRelativePath('src/.env'), false);
  assert.equal(validate.isSafeRelativePath('private.pem'), false);
  assert.equal(validate.isSafeGitRef('-output=bad'), false);
  assert.equal(validate.noControlChars('bad\nvalue'), false);
});

test('git input rejects unknown fields and secret paths before spawning', async () => {
  assert.throws(() => validateGitInput({ operation: 'status', unknown: true }), /unknown fields/);
  const result = await runGit({ directory: '/tmp/repo' }, { operation: 'file', ref: 'main', path: '.env' });
  assert.equal(result.ok, false);
});

test('git status uses valid fixed argv', async () => {
  const expected = ['git', '--no-pager', '-c', 'color.ui=false', 'status', '--short', '--branch'];
  const { spawn, calls } = fakeSpawn([{ match: (argv) => JSON.stringify(argv) === JSON.stringify(expected), reply: response(' M src/index.js') }]);
  const result = await runGit({ directory: '/tmp/repo' }, { operation: 'status' }, { spawn });
  assert.equal(result.ok, true, result.error);
  assert.deepEqual(calls[0].argv, expected);
});

test('git diff keeps refs and paths as argv data', async () => {
  const { spawn, calls } = fakeSpawn([{
    match: (argv) => argv[4] === 'diff',
    reply: response('diff'),
  }]);
  const result = await runGit(
    { directory: '/tmp/repo' },
    { operation: 'diff', base: 'main', head: 'feature/topic', path: 'src/a b.js' },
    { spawn },
  );
  assert.equal(result.ok, true, result.error);
  assert.deepEqual(calls[0].argv.slice(0, 12), [
    'git', '--no-pager', '-c', 'color.ui=false', 'diff', '--no-ext-diff', '--no-textconv',
    '--no-renames', 'main', 'feature/topic', '--', 'src/a b.js',
  ]);
  assert.ok(calls[0].argv.includes(':(exclude,glob)**/.env'));
  assert.ok(calls[0].argv.includes(':(exclude,glob)**/*.pem'));
});

test('git file and grep use non-shell argv with option separators', async () => {
  const { spawn, calls } = fakeSpawn([
    { match: (argv) => argv[4] === 'show', reply: response('source') },
    { match: (argv) => argv[4] === 'grep', reply: response('src/a.js:1:needle') },
  ]);
  assert.equal((await runGit({ directory: '/tmp/repo' }, { operation: 'file', ref: 'main', path: 'src/a.js' }, { spawn })).ok, true);
  assert.equal((await runGit({ directory: '/tmp/repo' }, { operation: 'grep', pattern: 'needle', path: 'src' }, { spawn })).ok, true);
  assert.equal(calls[0].argv.at(-1), 'main:src/a.js');
  assert.deepEqual(calls[1].argv.slice(4, 9), ['grep', '-n', '-e', 'needle', '--']);
  assert.equal(calls[1].argv[9], 'src');
  assert.ok(calls[1].argv.includes(':(exclude,glob)**/secrets/**'));
});

test('GitHub references require exact github.com URLs', () => {
  assert.deepEqual(parseReference('https://github.com/owner/repo/pull/42'), {
    owner: 'owner', repo: 'repo', number: 42, kind: 'pull',
  });
  assert.equal(parseReference('https://github.com/owner/repo/issues/7').kind, 'issue');
  assert.throws(() => parseReference('https://evilgithub.com/owner/repo/pull/42'), /github\.com/);
  assert.throws(() => parseReference('https://github.com/owner/repo/pull/42?x=1'), /github\.com/);
});

test('pull snapshots use GET, normalize pagination, and serialize line maps', async () => {
  const { spawn, calls } = fakeSpawn(snapshotHandlers());
  const snapshot = await pullSnapshot({ owner: 'owner', repo: 'repo', number: 42 }, { spawn });
  assert.equal(snapshot.complete, true);
  assert.equal(snapshot.headSha, HEAD);
  assert.deepEqual(snapshot.files[0].lineMap.left, [1]);
  assert.deepEqual(snapshot.files[0].lineMap.right, [1]);
  assert.doesNotThrow(() => JSON.stringify(snapshot));
  for (const call of calls) {
    assert.deepEqual(call.argv.slice(0, 4), ['gh', 'api', '--method', 'GET']);
  }
});

test('pull snapshots retry once and reject a second moving head', async () => {
  let metadataCalls = 0;
  const metadataReply = () => {
    metadataCalls += 1;
    const head = metadataCalls <= 1 ? '1'.repeat(40) : '2'.repeat(40);
    return response(pullMeta(head));
  };
  const first = fakeSpawn(snapshotHandlers({ metadataReply }));
  const snapshot = await pullSnapshot({ owner: 'owner', repo: 'repo', number: 42 }, { spawn: first.spawn });
  assert.equal(snapshot.headSha, '2'.repeat(40));
  assert.equal(snapshot.headChangedDuringAcquisition, true);

  let movingCalls = 0;
  const movingReply = () => response(pullMeta(String(++movingCalls).padStart(40, '0')));
  const moving = fakeSpawn(snapshotHandlers({ metadataReply: movingReply }));
  await assert.rejects(
    pullSnapshot({ owner: 'owner', repo: 'repo', number: 42 }, { spawn: moving.spawn }),
    /both snapshot attempts/,
  );
});

test('pull snapshots flag API file limits and redact secret-like patches', async () => {
  const files = [changedFile('.env', '@@ -1 +1 @@\n-secret\n+secret')];
  const { spawn } = fakeSpawn(snapshotHandlers({ meta: pullMeta(HEAD, BASE, 5000), files }));
  const snapshot = await pullSnapshot({ owner: 'owner', repo: 'repo', number: 42 }, { spawn });
  assert.equal(snapshot.complete, false);
  assert.equal(snapshot.files[0].patchRedacted, true);
  assert.equal(snapshot.files[0].patch, undefined);
});

test('large structurally complete patches do not use changes count as a truncation heuristic', async () => {
  for (const changes of [343, 501, 1105]) {
    const generated = largeMatchingPatch(changes, 16 * 1024);
    const file = changedFile(`src/large-${changes}.js`, generated.patch);
    Object.assign(file, { additions: generated.additions, deletions: generated.deletions, changes });
    const { spawn } = fakeSpawn(snapshotHandlers({ files: [file] }));
    const snapshot = await pullSnapshot({ owner: 'owner', repo: 'repo', number: 42 }, { spawn });
    assert.equal(snapshot.reviewability.status, 'complete', String(changes));
    assert.equal(snapshot.files[0].patchEvidence.status, 'complete', String(changes));
    assert.equal(snapshot.files[0].patchTruncated, false, String(changes));
    assert.equal(snapshot.files[0].lineMap.left.length > 0, true, String(changes));
    assert.equal(snapshot.files[0].lineMap.right.length > 0, true, String(changes));
    assert.equal(snapshot.files[0].patchBytes >= 16 * 1024, true, String(changes));
  }
});

test('malformed, missing, metadata-mismatched, and redacted patches retain no trusted line map', async () => {
  const files = [
    { ...changedFile('src/cut.js', '@@ -1,2 +1,2 @@\n-old\n+new'), additions: 1, deletions: 1, changes: 2 },
    { ...changedFile('src/mismatch.js'), additions: 2, deletions: 1, changes: 3 },
    { ...changedFile('src/missing.js'), patch: undefined },
    changedFile('.env', '@@ -1 +1 @@\n-old\n+new'),
  ];
  const { spawn } = fakeSpawn(snapshotHandlers({ meta: pullMeta(HEAD, BASE, files.length), files }));
  const snapshot = await pullSnapshot({ owner: 'owner', repo: 'repo', number: 42 }, { spawn });
  assert.equal(snapshot.reviewability.status, 'limited-comment');
  for (const file of snapshot.files) {
    assert.notEqual(file.patchEvidence.status, 'complete');
    assert.deepEqual(file.lineMap.left, []);
    assert.deepEqual(file.lineMap.right, []);
  }
  assert.equal(snapshot.files[0].patchEvidence.retention, 'full');
  assert.equal(snapshot.files[1].patchEvidence.reason, 'metadata-mismatch');
  assert.equal(snapshot.files[2].patchEvidence.reason, 'missing-patch');
  assert.equal(snapshot.files[3].patchEvidence.reason, 'redacted-path');
});

test('per-file and aggregate patch byte limits are authoritative', async () => {
  const oversized = changedFile('src/oversized.js', `@@ -1 +1 @@\n ${'x'.repeat(1024 * 1024)}`);
  Object.assign(oversized, { additions: 0, deletions: 0, changes: 0 });
  const perFile = fakeSpawn(snapshotHandlers({ files: [oversized] }));
  const perFileSnapshot = await pullSnapshot({ owner: 'owner', repo: 'repo', number: 42 }, { spawn: perFile.spawn });
  assert.equal(perFileSnapshot.files[0].patchEvidence.reason, 'per-file-byte-limit');
  assert.deepEqual(perFileSnapshot.files[0].lineMap.right, []);

  const files = Array.from({ length: 17 }, (_, index) => {
    const file = changedFile(`src/budget-${index}.js`, `@@ -1 +1 @@\n ${'x'.repeat(1024 * 1024 - 128)}`);
    return { ...file, additions: 0, deletions: 0, changes: 0 };
  });
  const aggregate = fakeSpawn(snapshotHandlers({ meta: pullMeta(HEAD, BASE, files.length), files }));
  const aggregateSnapshot = await pullSnapshot({ owner: 'owner', repo: 'repo', number: 42 }, { spawn: aggregate.spawn });
  assert.equal(aggregateSnapshot.files.at(-1).patchEvidence.reason, 'aggregate-byte-limit');
  assert.equal(aggregateSnapshot.files.at(-1).patch, undefined);
  assert.deepEqual(aggregateSnapshot.files.at(-1).lineMap.left, []);
});

test('snapshot reviewability distinguishes complete, patch-limited, and integrity failures', async () => {
  const complete = fakeSpawn(snapshotHandlers());
  assert.deepEqual(
    (await pullSnapshot({ owner: 'owner', repo: 'repo', number: 42 }, { spawn: complete.spawn })).reviewability,
    { status: 'complete', inventoryComplete: true, feedbackComplete: true, patchesComplete: true, limitations: [] },
  );
  const missing = fakeSpawn(snapshotHandlers({ files: [{ ...changedFile(), patch: undefined }] }));
  const limited = await pullSnapshot({ owner: 'owner', repo: 'repo', number: 42 }, { spawn: missing.spawn });
  assert.equal(limited.reviewability.status, 'limited-comment');
  assert.equal(limited.complete, false);
  assert.equal(limited.contentTruncated, true);
  const inventory = fakeSpawn(snapshotHandlers({ meta: pullMeta(HEAD, BASE, 2), files: [changedFile()] }));
  const unpostable = await pullSnapshot({ owner: 'owner', repo: 'repo', number: 42 }, { spawn: inventory.spawn });
  assert.equal(unpostable.reviewability.status, 'unpostable');
  assert.equal(unpostable.reviewability.inventoryComplete, false);
});

test('source-at-SHA rejects secret paths and bounds content', async () => {
  await assert.rejects(fetchSourceAtSha({ owner: 'owner', repo: 'repo', sha: HEAD, path: '.env' }), /path/);
  const large = Buffer.from('x'.repeat(1024 * 1024 + 10)).toString('base64');
  const { spawn } = fakeSpawn([{
    match: (argv) => has(argv, 'contents/src%2Fbig.js') || has(argv, 'contents/src/big.js'),
    reply: response({ name: 'big.js', size: 1024 * 1024 + 10, encoding: 'base64', content: large }),
  }]);
  const source = await fetchSourceAtSha({ owner: 'owner', repo: 'repo', sha: HEAD, path: 'src/big.js' }, { spawn });
  assert.equal(source.contentTruncated, true);
});

test('strict review payload validates nested schema and rejects unknown fields', () => {
  const input = reviewInput();
  const canonical = validateReviewPayload(input);
  assert.equal(canonical.target.number, 42);
  assert.match(canonical.snapshot.id, /^naru-snap-/);
  assert.throws(() => validateReviewPayload({ ...input, endpoint: 'evil' }), /unknown fields/);
  assert.throws(() => validateReviewPayload({
    ...input,
    reviewResult: { ...input.reviewResult, event: 'APPROVE' },
  }), /unknown fields/);
});

test('v3 payload validation enforces version-specific findings and rejects caller events', () => {
  const input = reviewInputV3({ findings: [
    { body: 'General observation', priority: 'P3', severity: 'Low', confidence: 'Medium' },
    { path: 'src/index.js', body: 'Path-level blocker', priority: 'P1', severity: 'High', confidence: 'High' },
    { path: 'src/index.js', line: 1, side: 'RIGHT', body: 'Inline issue', priority: 'P2', severity: 'Medium', confidence: 'High' },
  ] });
  const canonical = validateReviewPayload(input);
  assert.equal(canonical.schemaVersion, 3);
  assert.equal(canonical.findings.length, 3);
  assert.throws(() => validateReviewPayload({
    reviewResult: { ...input.reviewResult, event: 'APPROVE' },
  }), /unknown fields/);
  const partialLocation = structuredClone(input);
  partialLocation.reviewResult.findings[0] = {
    path: 'src/index.js', line: 1, body: 'Missing side', priority: 'P1', severity: 'High', confidence: 'High',
  };
  assert.throws(() => validateReviewPayload(partialLocation), /line and side together/);
  const dishonestLimited = reviewInputV3({ posture: 'limited', limitations: [] });
  assert.throws(() => validateReviewPayload(dishonestLimited), /at least one/);
});

test('review payload accepts aliases but rejects dual canonical and alias keys', () => {
  const aliased = structuredClone(reviewInput());
  aliased.reviewResult.target.number = aliased.reviewResult.target.pullNumber;
  delete aliased.reviewResult.target.pullNumber;
  aliased.reviewResult.snapshot.snapshotId = aliased.reviewResult.snapshot.id;
  delete aliased.reviewResult.snapshot.id;
  assert.equal(validateReviewPayload(aliased).target.number, 42);

  const dualTarget = structuredClone(reviewInput());
  dualTarget.reviewResult.target.number = dualTarget.reviewResult.target.pullNumber;
  assert.throws(() => validateReviewPayload(dualTarget), /both pullNumber and number/);
  const dualSnapshot = structuredClone(reviewInput());
  dualSnapshot.reviewResult.snapshot.snapshotId = dualSnapshot.reviewResult.snapshot.id;
  assert.throws(() => validateReviewPayload(dualSnapshot), /both id and snapshotId/);
});

test('post tool accepts only the orchestrator identity and rejects all others before I/O', async () => {
  const denied = [
    undefined,
    'other',
    'naru-review-post',
    ...NON_POSTING_AGENTS,
  ];
  for (const agent of denied) {
    let ioCalls = 0;
    const result = await postReview(reviewInput(), agent ? { agent } : undefined, {
      spawn: async () => {
        ioCalls += 1;
        throw new Error('unexpected I/O');
      },
    });
    assert.match(result.error, /identity/, String(agent));
    assert.deepEqual(
      { postAttempted: result.postAttempted, correctable: result.correctable, outcomeUnknown: result.outcomeUnknown },
      { postAttempted: false, correctable: false, outcomeUnknown: false },
      String(agent),
    );
    assert.equal(ioCalls, 0, String(agent));
  }
  const result = await postReview(reviewInput({ status: 'incomplete', degraded: true }), { agent: 'naru-orchestrator' });
  assert.match(result.error, /incomplete/);
});

test('a correctable invalid preflight can be corrected with exactly one POST total', async () => {
  const head = '9'.repeat(40);
  const { spawn, calls } = fakeSpawn([
    ...snapshotHandlers({ meta: pullMeta(head) }),
    { match: (argv) => argv.includes('POST'), reply: response({ id: 301 }) },
  ]);
  const invalid = structuredClone(reviewInput({ head }));
  invalid.reviewResult.unknown = true;
  const rejected = await postReview(invalid, { agent: 'naru-orchestrator' }, { spawn });
  assert.equal(rejected.postAttempted, false);
  assert.equal(rejected.correctable, true);
  assert.equal(rejected.outcomeUnknown, false);
  const posted = await postReview(reviewInput({ head }), { agent: 'naru-orchestrator' }, { spawn });
  assert.equal(posted.ok, true, posted.error);
  assert.equal(posted.postAttempted, true);
  assert.equal(posted.correctable, false);
  assert.equal(posted.outcomeUnknown, false);
  assert.equal(calls.filter((call) => call.argv.includes('POST')).length, 1);
});

test('post tool rejects incomplete and degraded reviews before I/O', async () => {
  assert.match((await postReview(reviewInput({ status: 'incomplete', degraded: true }), { agent: 'naru-orchestrator' })).error, /incomplete/);
  assert.match((await postReview(reviewInput({ status: 'partial', degraded: true }), { agent: 'naru-orchestrator' })).error, /cannot be posted/);
});

test('post tool rejects snapshot.complete false as correctable before I/O', async () => {
  let ioCalls = 0;
  const result = await postReview(reviewInput({ snapshotComplete: false }), { agent: 'naru-orchestrator' }, {
    spawn: async () => { ioCalls += 1; },
  });
  assert.equal(result.postAttempted, false);
  assert.equal(result.correctable, true);
  assert.equal(result.outcomeUnknown, false);
  assert.equal(ioCalls, 0);
});

test('post tool preserves body, hard-codes COMMENT and commit_id, and posts once', async () => {
  let posted;
  const handlers = [
    ...snapshotHandlers(),
    {
      match: (argv) => argv.includes('POST'),
      reply: (_argv, options) => {
        posted = JSON.parse(options.input);
        return response({ id: 99, html_url: 'https://github.com/owner/repo/pull/42#pullrequestreview-99' });
      },
    },
  ];
  const { spawn, calls } = fakeSpawn(handlers);
  const input = reviewInput();
  const result = await postReview(input, { agent: 'naru-orchestrator' }, { spawn });
  assert.equal(result.ok, true, result.error);
  assert.equal(result.postAttempted, true);
  assert.equal(result.outcomeUnknown, false);
  assert.equal(posted.event, 'COMMENT');
  assert.equal(posted.commit_id, HEAD);
  assert.match(posted.body, /## Verdict/);
  assert.match(posted.body, /^<!-- naru-review:/);
  assert.equal(calls.filter((call) => call.argv.includes('POST')).length, 1);
});

test('v3 limited patch evidence posts one COMMENT with a generated banner and no inline comment', async () => {
  const head = '01'.repeat(20);
  const files = [{ ...changedFile(), patch: undefined }];
  let posted;
  const { spawn, calls } = fakeSpawn([
    ...snapshotHandlers({ meta: pullMeta(head), files }),
    { match: (argv) => argv.includes('POST'), reply: (_argv, options) => {
      posted = JSON.parse(options.input);
      return response({ id: 401 });
    } },
  ]);
  const input = reviewInputV3({
    head, files, posture: 'limited', limitations: ['GitHub did not provide the file patch'],
    submissionPolicy: 'approve-if-clear', conclusion: 'clear',
    findings: [{ path: 'src/index.js', line: 1, side: 'RIGHT', body: 'Potential issue', priority: 'P1', severity: 'High', confidence: 'High' }],
  });
  const result = await postReview(input, { agent: 'naru-orchestrator' }, { spawn });
  assert.equal(result.ok, true, result.error);
  assert.equal(posted.event, 'COMMENT');
  assert.equal(posted.comments.length, 0);
  assert.match(posted.body, /\*\*Limited review:\*\*/);
  assert.equal(result.data.evidencePosture, 'limited');
  assert.equal(calls.filter((call) => call.argv.includes('POST')).length, 1);
});

test('payload-incomplete evidence forces every formal policy to one visible limited COMMENT', async () => {
  const blocker = { path: 'src/index.js', body: 'Eligible blocker', priority: 'P1', severity: 'High', confidence: 'High' };
  const cases = [
    { seed: '8a', policy: 'approve-if-clear', conclusion: 'clear', findings: [] },
    { seed: '8b', policy: 'request-changes-if-blocked', conclusion: 'blocking', findings: [blocker] },
    { seed: '8c', policy: 'select-state', conclusion: 'blocking', findings: [blocker] },
  ];
  for (const item of cases) {
    const head = item.seed.repeat(20);
    let posted;
    const { spawn, calls } = fakeSpawn([
      ...snapshotHandlers({ meta: pullMeta(head) }),
      { match: (argv) => argv.includes('POST'), reply: (_argv, options) => {
        posted = JSON.parse(options.input);
        return response({ id: Number.parseInt(item.seed, 16) });
      } },
    ]);
    const result = await postReview(reviewInputV3({
      head,
      posture: 'limited',
      limitations: [],
      snapshotComplete: false,
      snapshotWarnings: ['Original review snapshot omitted material evidence'],
      submissionPolicy: item.policy,
      conclusion: item.conclusion,
      findings: item.findings,
    }), { agent: 'naru-orchestrator' }, { spawn });
    assert.equal(result.ok, true, result.error);
    assert.equal(posted.event, 'COMMENT');
    assert.equal(result.data.evidencePosture, 'limited');
    assert.match(posted.body, /\*\*Limited review:\*\*/);
    assert.match(posted.body, /Payload snapshot warning: Original review snapshot omitted material evidence/);
    assert.equal(calls.filter((call) => call.argv.includes('POST')).length, 1);
  }
});

test('payload-incomplete evidence requires limited posture before any POST', async () => {
  const head = '8d'.repeat(20);
  const { spawn, calls } = fakeSpawn(snapshotHandlers({ meta: pullMeta(head) }));
  const result = await postReview(reviewInputV3({
    head,
    posture: 'complete',
    snapshotComplete: false,
    snapshotWarnings: ['Material evidence was unavailable'],
    submissionPolicy: 'approve-if-clear',
    conclusion: 'clear',
  }), { agent: 'naru-orchestrator' }, { spawn });
  assert.equal(result.ok, false);
  assert.equal(result.correctable, true);
  assert.match(result.error, /requires limited coverage posture/);
  assert.equal(calls.some((call) => call.argv.includes('POST')), false);
});

test('complete v3 evidence with honest non-material limitations remains formally eligible', async () => {
  const head = '8e'.repeat(20);
  let posted;
  const { spawn, calls } = fakeSpawn([
    ...snapshotHandlers({ meta: pullMeta(head) }),
    { match: (argv) => argv.includes('POST'), reply: (_argv, options) => {
      posted = JSON.parse(options.input);
      return response({ id: 814 });
    } },
  ]);
  const result = await postReview(reviewInputV3({
    head,
    posture: 'complete',
    limitations: ['Browser suite was not run'],
    snapshotComplete: true,
    submissionPolicy: 'approve-if-clear',
    conclusion: 'clear',
  }), { agent: 'naru-orchestrator' }, { spawn });
  assert.equal(result.ok, true, result.error);
  assert.equal(posted.event, 'APPROVE');
  assert.equal(result.data.evidencePosture, 'complete');
  assert.match(posted.body, /Browser suite was not run/);
  assert.doesNotMatch(posted.body, /\*\*Limited review:\*\*/);
  assert.equal(calls.filter((call) => call.argv.includes('POST')).length, 1);
});

test('inventory and feedback integrity gaps refuse every v3 submission policy', async () => {
  for (const [index, submissionPolicy] of ['comment-only', 'approve-if-clear', 'request-changes-if-blocked', 'select-state'].entries()) {
    const head = `1${index}`.repeat(20);
    const files = [changedFile()];
    const { spawn, calls } = fakeSpawn(snapshotHandlers({ meta: pullMeta(head, BASE, 2), files }));
    const input = reviewInputV3({ head, files, submissionPolicy, conclusion: 'blocking' });
    const result = await postReview(input, { agent: 'naru-orchestrator' }, { spawn });
    assert.equal(result.ok, false);
    assert.match(result.error, /unpostable/);
    assert.equal(calls.some((call) => call.argv.includes('POST')), false);
  }
  const head = '15'.repeat(20);
  const issueComments = Array.from({ length: 1001 }, (_, id) => ({ id, body: 'feedback' }));
  const { spawn, calls } = fakeSpawn(snapshotHandlers({ meta: pullMeta(head), issueComments }));
  const result = await postReview(
    reviewInputV3({ head, issueComments }),
    { agent: 'naru-orchestrator' },
    { spawn },
  );
  assert.match(result.error, /unpostable/);
  assert.equal(calls.some((call) => call.argv.includes('POST')), false);
});

test('APPROVE is derived only for complete clear non-draft non-self reviews without blockers', async () => {
  const cases = [
    { seed: '21', expected: 'APPROVE' },
    { seed: '22', expected: 'COMMENT', findings: [{ path: 'src/index.js', body: 'Blocker', priority: 'P1', severity: 'High', confidence: 'High' }] },
    { seed: '23', expected: 'COMMENT', draft: true },
    { seed: '24', expected: 'COMMENT', actor: 'AUTHOR' },
    { seed: '26', expected: 'COMMENT', findings: [{ body: 'Unlocated blocker', priority: 'P0', severity: 'Critical', confidence: 'High' }] },
    { seed: '27', expected: 'COMMENT', findings: [{ path: 'src/index.js', line: 999, side: 'RIGHT', body: 'Dropped blocker', priority: 'P1', severity: 'High', confidence: 'High' }] },
    { seed: '28', expected: 'COMMENT', draft: undefined },
    { seed: '29', expected: 'COMMENT', draft: 'unknown' },
  ];
  for (const item of cases) {
    const head = item.seed.repeat(20);
    let posted;
    const meta = pullMeta(head, BASE, 1, 42, Object.hasOwn(item, 'draft') ? { draft: item.draft } : {});
    const { spawn } = fakeSpawn([
      ...snapshotHandlers({ meta, actor: item.actor }),
      { match: (argv) => argv.includes('POST'), reply: (_argv, options) => {
        posted = JSON.parse(options.input);
        return response({ id: Number(item.seed) });
      } },
    ]);
    const result = await postReview(reviewInputV3({
      head, submissionPolicy: 'approve-if-clear', conclusion: 'clear', findings: item.findings,
    }), { agent: 'naru-orchestrator' }, { spawn });
    assert.equal(result.ok, true, result.error);
    assert.equal(posted.event, item.expected);
    assert.equal(result.data.event, item.expected);
    assert.equal(result.data.submissionPolicy, 'approve-if-clear');
  }
  const head = '25'.repeat(20);
  const closed = fakeSpawn(snapshotHandlers({ meta: pullMeta(head, BASE, 1, 42, { state: 'closed' }) }));
  const result = await postReview(
    reviewInputV3({ head, submissionPolicy: 'approve-if-clear', conclusion: 'clear' }),
    { agent: 'naru-orchestrator' }, { spawn: closed.spawn },
  );
  assert.match(result.error, /not open/);
  assert.equal(closed.calls.some((call) => call.argv.includes('POST')), false);
});

test('REQUEST_CHANGES requires a final eligible blocker and otherwise falls back to COMMENT', async () => {
  const cases = [
    {
      seed: '31', expected: 'REQUEST_CHANGES',
      finding: { path: 'src/index.js', body: 'Blocking path issue', priority: 'P0', severity: 'Critical', confidence: 'High' },
    },
    {
      seed: '32', expected: 'COMMENT',
      finding: { path: 'src/index.js', line: 999, side: 'RIGHT', body: 'Stale location', priority: 'P1', severity: 'High', confidence: 'High' },
    },
    {
      seed: '33', expected: 'COMMENT',
      finding: { path: 'src/index.js', body: 'Uncertain', priority: 'P1', severity: 'High', confidence: 'Medium' },
    },
    {
      seed: '34', expected: 'COMMENT',
      finding: { path: 'src/missing.js', body: 'Missing path', priority: 'P1', severity: 'High', confidence: 'High' },
    },
    {
      seed: '37', expected: 'COMMENT', draft: undefined,
      finding: { path: 'src/index.js', body: 'Unknown-draft blocker', priority: 'P1', severity: 'High', confidence: 'High' },
    },
    {
      seed: '38', expected: 'COMMENT', draft: 'malformed',
      finding: { path: 'src/index.js', body: 'Malformed-draft blocker', priority: 'P1', severity: 'High', confidence: 'High' },
    },
    {
      seed: '39', expected: 'COMMENT', conclusion: 'clear',
      finding: { path: 'src/index.js', body: 'Clear-conclusion blocker', priority: 'P1', severity: 'High', confidence: 'High' },
    },
    {
      seed: '3a', expected: 'COMMENT', conclusion: 'informational',
      finding: { path: 'src/index.js', body: 'Informational-conclusion blocker', priority: 'P1', severity: 'High', confidence: 'High' },
    },
  ];
  for (const item of cases) {
    const head = item.seed.repeat(20);
    let posted;
    const meta = pullMeta(head, BASE, 1, 42, Object.hasOwn(item, 'draft') ? { draft: item.draft } : {});
    const { spawn } = fakeSpawn([
      ...snapshotHandlers({ meta }),
      { match: (argv) => argv.includes('POST'), reply: (_argv, options) => {
        posted = JSON.parse(options.input);
        return response({ id: Number.parseInt(item.seed, 16) });
      } },
    ]);
    const result = await postReview(reviewInputV3({
      head, submissionPolicy: 'request-changes-if-blocked', conclusion: item.conclusion ?? 'blocking', findings: [item.finding],
    }), { agent: 'naru-orchestrator' }, { spawn });
    assert.equal(result.ok, true, result.error);
    assert.equal(posted.event, item.expected);
    assert.equal(result.data.submissionPolicy, 'request-changes-if-blocked');
    if (item.seed === '31') {
      assert.match(posted.body, /Blocking path issue/);
      assert.match(posted.body, /P0 · Critical · High confidence/);
      assert.match(posted.body, /src\/index\.js/);
      assert.match(posted.body, /no inline location was supplied/);
    }
    if (item.seed === '32') {
      assert.match(posted.body, /Stale location/);
      assert.match(posted.body, /line and side are not present/);
    }
  }
});

test('v3 renders every non-inline finding safely without exposing redacted paths', async () => {
  const head = '35'.repeat(20);
  let posted;
  const { spawn } = fakeSpawn([
    ...snapshotHandlers({ meta: pullMeta(head) }),
    { match: (argv) => argv.includes('POST'), reply: (_argv, options) => {
      posted = JSON.parse(options.input);
      return response({ id: 435 });
    } },
  ]);
  const markerText = '<!-- naru-review:owner/repo#42 head=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa digest=' + 'f'.repeat(64) + ' -->';
  const result = await postReview(reviewInputV3({
    head,
    findings: [
      { body: `Unlocated ${markerText}`, priority: 'P2', severity: 'Medium', confidence: 'High' },
      { path: 'src/index.js', body: 'Path-level observation', priority: 'P3', severity: 'Low', confidence: 'Medium' },
      { path: 'src/index.js', line: 999, side: 'RIGHT', body: 'Invalid line observation', priority: 'P2', severity: 'Medium', confidence: 'High' },
    ],
  }), { agent: 'naru-orchestrator' }, { spawn });
  assert.equal(result.ok, true, result.error);
  assert.match(posted.body, /Unlocated &lt;!-- naru-review:/);
  assert.match(posted.body, /Path-level observation/);
  assert.match(posted.body, /Invalid line observation/);
  assert.match(posted.body, /no path or inline location was supplied/);
  assert.match(posted.body, /line and side are not present/);
  assert.equal((posted.body.match(/<!-- naru-review:/g) ?? []).length, 1);

  const redactedHead = '36'.repeat(20);
  const files = [{ ...changedFile('src/safe.js'), previous_filename: '.env' }];
  let redactedPost;
  const redacted = fakeSpawn([
    ...snapshotHandlers({ meta: pullMeta(redactedHead), files }),
    { match: (argv) => argv.includes('POST'), reply: (_argv, options) => {
      redactedPost = JSON.parse(options.input);
      return response({ id: 436 });
    } },
  ]);
  const redactedResult = await postReview(reviewInputV3({
    head: redactedHead,
    files,
    posture: 'limited',
    limitations: ['One path was redacted'],
    findings: [{ path: 'src/safe.js', body: 'Redacted-path observation', priority: 'P2', severity: 'Medium', confidence: 'High' }],
  }), { agent: 'naru-orchestrator' }, { spawn: redacted.spawn });
  assert.equal(redactedResult.ok, true, redactedResult.error);
  assert.match(redactedPost.body, /Redacted-path observation/);
  assert.doesNotMatch(redactedPost.body, /src\/safe\.js/);
  assert.match(redactedPost.body, /Location: not available/);
});

test('comment-only and informational select-state policies stay COMMENT', async () => {
  for (const [index, submissionPolicy] of ['comment-only', 'select-state'].entries()) {
    const head = `4${index}`.repeat(20);
    let posted;
    const { spawn } = fakeSpawn([
      ...snapshotHandlers({ meta: pullMeta(head) }),
      { match: (argv) => argv.includes('POST'), reply: (_argv, options) => {
        posted = JSON.parse(options.input);
        return response({ id: 440 + index });
      } },
    ]);
    const result = await postReview(
      reviewInputV3({ head, submissionPolicy, conclusion: 'informational' }),
      { agent: 'naru-orchestrator' }, { spawn },
    );
    assert.equal(result.ok, true, result.error);
    assert.equal(posted.event, 'COMMENT');
  }
});

test('each submission authorization policy derives only events in its exact allowed set', async () => {
  const blocker = { path: 'src/index.js', body: 'Eligible blocker', priority: 'P1', severity: 'High', confidence: 'High' };
  const cases = [
    { seed: '81', policy: 'comment-only', conclusion: 'clear', findings: [], expected: 'COMMENT' },
    { seed: '82', policy: 'comment-only', conclusion: 'blocking', findings: [blocker], expected: 'COMMENT' },
    { seed: '83', policy: 'approve-if-clear', conclusion: 'blocking', findings: [blocker], expected: 'COMMENT' },
    { seed: '84', policy: 'request-changes-if-blocked', conclusion: 'clear', findings: [], expected: 'COMMENT' },
    { seed: '85', policy: 'select-state', conclusion: 'clear', findings: [], expected: 'APPROVE' },
    { seed: '86', policy: 'select-state', conclusion: 'blocking', findings: [blocker], expected: 'REQUEST_CHANGES' },
  ];
  const allowed = {
    'comment-only': new Set(['COMMENT']),
    'approve-if-clear': new Set(['COMMENT', 'APPROVE']),
    'request-changes-if-blocked': new Set(['COMMENT', 'REQUEST_CHANGES']),
    'select-state': new Set(['COMMENT', 'APPROVE', 'REQUEST_CHANGES']),
  };
  for (const item of cases) {
    const head = item.seed.repeat(20);
    let posted;
    const { spawn } = fakeSpawn([
      ...snapshotHandlers({ meta: pullMeta(head) }),
      { match: (argv) => argv.includes('POST'), reply: (_argv, options) => {
        posted = JSON.parse(options.input);
        return response({ id: Number(item.seed) });
      } },
    ]);
    const result = await postReview(reviewInputV3({
      head, submissionPolicy: item.policy, conclusion: item.conclusion, findings: item.findings,
    }), { agent: 'naru-orchestrator' }, { spawn });
    assert.equal(result.ok, true, result.error);
    assert.equal(posted.event, item.expected);
    assert.equal(allowed[item.policy].has(posted.event), true);
    assert.equal(result.data.submissionPolicy, item.policy);
  }
});

test('concurrent identical review posts serialize and use the process-local success record', async () => {
  const head = 'e'.repeat(40);
  const postStarted = deferred();
  const releasePost = deferred();
  let postCalls = 0;
  const { spawn } = fakeSpawn([
    ...snapshotHandlers({ meta: pullMeta(head) }),
    {
      match: (argv) => argv.includes('POST'),
      reply: async () => {
        postCalls += 1;
        postStarted.resolve();
        await releasePost.promise;
        return response({ id: 201, html_url: 'review-201' });
      },
    },
  ]);
  const input = reviewInput({ head });
  const first = postReview(input, { agent: 'naru-orchestrator' }, { spawn });
  const second = postReview(input, { agent: 'naru-orchestrator' }, { spawn });

  await postStarted.promise;
  assert.equal(postCalls, 1);
  releasePost.resolve();
  const [firstResult, secondResult] = await Promise.all([first, second]);
  assert.equal(firstResult.data.posted, true);
  assert.equal(secondResult.data.posted, false);
  assert.equal(secondResult.data.reason, 'alreadyPosted');
  assert.equal(secondResult.data.reviewId, 201);
  assert.equal(postCalls, 1);
});

test('concurrent differing review posts on one head refuse the second digest', async () => {
  const head = 'f'.repeat(40);
  const postStarted = deferred();
  const releasePost = deferred();
  let postCalls = 0;
  const { spawn } = fakeSpawn([
    ...snapshotHandlers({ meta: pullMeta(head) }),
    {
      match: (argv) => argv.includes('POST'),
      reply: async () => {
        postCalls += 1;
        postStarted.resolve();
        await releasePost.promise;
        return response({ id: 202 });
      },
    },
  ]);
  const first = postReview(reviewInput({ head, body: 'first result' }), { agent: 'naru-orchestrator' }, { spawn });
  const second = postReview(reviewInput({ head, body: 'different result' }), { agent: 'naru-orchestrator' }, { spawn });

  await postStarted.promise;
  releasePost.resolve();
  const [firstResult, secondResult] = await Promise.all([first, second]);
  assert.equal(firstResult.ok, true, firstResult.error);
  assert.equal(secondResult.ok, false);
  assert.match(secondResult.error, /different Naru review/);
  assert.equal(postCalls, 1);
});

test('review post lock releases after a snapshot failure', async () => {
  const head = '0'.repeat(40);
  let metadataCalls = 0;
  let postCalls = 0;
  const { spawn } = fakeSpawn([
    ...snapshotHandlers({
      meta: pullMeta(head),
      metadataReply: () => {
        metadataCalls += 1;
        return metadataCalls === 1 ? response('temporary failure', false) : response(pullMeta(head));
      },
    }),
    { match: (argv) => argv.includes('POST'), reply: () => {
      postCalls += 1;
      return response({ id: 203 });
    } },
  ]);
  const input = reviewInput({ head });
  const [failed, succeeded] = await Promise.all([
    postReview(input, { agent: 'naru-orchestrator' }, { spawn }),
    postReview(input, { agent: 'naru-orchestrator' }, { spawn }),
  ]);
  assert.equal(failed.ok, false);
  assert.match(failed.error, /snapshot failed/);
  assert.equal(succeeded.ok, true, succeeded.error);
  assert.equal(postCalls, 1);
});

test('different pull request keys can post concurrently', { timeout: 1000 }, async () => {
  const head = 'd'.repeat(40);
  const bothPostsStarted = deferred();
  let started = 0;
  const { spawn } = fakeSpawn([
    ...snapshotHandlers({ number: 50, meta: pullMeta(head, BASE, 1, 50) }),
    ...snapshotHandlers({ number: 51, meta: pullMeta(head, BASE, 1, 51) }),
    {
      match: (argv) => argv.includes('POST'),
      reply: async (argv) => {
        started += 1;
        if (started === 2) bothPostsStarted.resolve();
        await bothPostsStarted.promise;
        return response({ id: has(argv, '/50/') ? 250 : 251 });
      },
    },
  ]);
  const results = await Promise.all([
    postReview(reviewInput({ number: 50, head }), { agent: 'naru-orchestrator' }, { spawn }),
    postReview(reviewInput({ number: 51, head }), { agent: 'naru-orchestrator' }, { spawn }),
  ]);
  assert.equal(started, 2);
  assert.ok(results.every((result) => result.ok), results.map((result) => result.error).join('\n'));
});

test('orchestrator caller posts through the same fixed one-POST path', async () => {
  const head = '1'.repeat(40);
  const { spawn, calls } = fakeSpawn([
    ...snapshotHandlers({ meta: pullMeta(head) }),
    { match: (argv) => argv.includes('POST'), reply: response({ id: 100 }) },
  ]);
  const result = await postReview(reviewInput({ head }), { agent: 'naru-orchestrator' }, { spawn });
  assert.equal(result.ok, true, result.error);
  assert.equal(calls.filter((call) => call.argv.includes('POST')).length, 1);
});

test('post tool rejects head and feedback drift', async () => {
  const expectedHead = '6'.repeat(40);
  const otherHead = 'd'.repeat(40);
  const headDrift = fakeSpawn(snapshotHandlers({ meta: pullMeta(otherHead) }));
  assert.match((await postReview(reviewInput({ head: expectedHead }), { agent: 'naru-orchestrator' }, { spawn: headDrift.spawn })).error, /head SHA mismatch/);

  const feedbackHead = '7'.repeat(40);
  const comments = [{ id: 10, body: 'new feedback', updated_at: 'now' }];
  const feedbackDrift = fakeSpawn(snapshotHandlers({ meta: pullMeta(feedbackHead), issueComments: comments }));
  assert.match((await postReview(reviewInput({ head: feedbackHead }), { agent: 'naru-orchestrator' }, { spawn: feedbackDrift.spawn })).error, /feedback digest mismatch/);
});

test('PR title and description participate in snapshot freshness', async () => {
  const meta = pullMeta();
  assert.notEqual(
    digestSnapshot(meta, [changedFile()], [], [], []),
    digestSnapshot({ ...meta, body: 'Materially changed description' }, [changedFile()], [], [], []),
  );
  assert.notEqual(
    digestSnapshot(meta, [changedFile()], [], [], []),
    digestSnapshot({ ...meta, title: 'Materially changed title' }, [changedFile()], [], [], []),
  );

  const head = '53'.repeat(20);
  const initialDrift = fakeSpawn(snapshotHandlers({
    meta: pullMeta(head, BASE, 1, 42, { body: 'Changed before posting' }),
  }));
  const initialResult = await postReview(
    reviewInputV3({ head }), { agent: 'naru-orchestrator' }, { spawn: initialDrift.spawn },
  );
  assert.match(initialResult.error, /feedback digest mismatch/);
  assert.equal(initialDrift.calls.some((call) => call.argv.includes('POST')), false);

  const finalHead = '54'.repeat(20);
  let metadataCalls = 0;
  const finalDrift = fakeSpawn(snapshotHandlers({
    metadataReply: () => response(pullMeta(finalHead, BASE, 1, 42, {
      body: metadataCalls++ < 2 ? 'Description' : 'Changed during final validation',
    })),
  }));
  const finalResult = await postReview(
    reviewInputV3({ head: finalHead }), { agent: 'naru-orchestrator' }, { spawn: finalDrift.spawn },
  );
  assert.match(finalResult.error, /final snapshot feedback digest mismatch/);
  assert.equal(finalDrift.calls.some((call) => call.argv.includes('POST')), false);
});

test('post tool refuses final head and feedback drift without POST', async () => {
  const head = '8'.repeat(40);
  const movedHead = '9'.repeat(40);
  let metadataCalls = 0;
  const headDrift = fakeSpawn(snapshotHandlers({
    metadataReply: () => response(pullMeta((metadataCalls++ < 2) ? head : movedHead)),
  }));
  const headResult = await postReview(reviewInput({ head }), { agent: 'naru-orchestrator' }, { spawn: headDrift.spawn });
  assert.equal(headResult.ok, false);
  assert.match(headResult.error, /final snapshot head SHA mismatch/);
  assert.equal(headDrift.calls.filter((call) => call.argv.includes('POST')).length, 0);

  const feedbackHead = 'c'.repeat(40);
  let issueCalls = 0;
  const finalFeedback = [{ id: 20, body: 'late feedback', updated_at: 'later' }];
  const feedbackDrift = fakeSpawn([
    {
      match: (argv) => argv[3] === 'GET' && has(argv, 'issues/42/comments'),
      reply: () => response([issueCalls++ === 0 ? [] : finalFeedback]),
    },
    ...snapshotHandlers({ meta: pullMeta(feedbackHead) }),
  ]);
  const feedbackResult = await postReview(reviewInput({ head: feedbackHead }), { agent: 'naru-orchestrator' }, { spawn: feedbackDrift.spawn });
  assert.equal(feedbackResult.ok, false);
  assert.match(feedbackResult.error, /final snapshot feedback digest mismatch/);
  assert.equal(feedbackDrift.calls.filter((call) => call.argv.includes('POST')).length, 0);
});

test('post tool refuses final patch-evidence and pull-state drift without POST', async () => {
  const head = '51'.repeat(20);
  let fileCalls = 0;
  const evidenceDrift = fakeSpawn([
    {
      match: (argv) => argv[3] === 'GET' && has(argv, 'pulls/42/files'),
      reply: () => response([[fileCalls++ === 0 ? changedFile() : { ...changedFile(), patch: undefined }]]),
    },
    ...snapshotHandlers({ meta: pullMeta(head) }),
  ]);
  const evidenceResult = await postReview(
    reviewInputV3({ head }), { agent: 'naru-orchestrator' }, { spawn: evidenceDrift.spawn },
  );
  assert.match(evidenceResult.error, /review evidence.*changed/);
  assert.equal(evidenceDrift.calls.some((call) => call.argv.includes('POST')), false);

  const stateHead = '52'.repeat(20);
  let metadataCalls = 0;
  const stateDrift = fakeSpawn(snapshotHandlers({
    metadataReply: () => response(pullMeta(stateHead, BASE, 1, 42, { draft: metadataCalls++ >= 2 })),
  }));
  const stateResult = await postReview(
    reviewInputV3({ head: stateHead }), { agent: 'naru-orchestrator' }, { spawn: stateDrift.spawn },
  );
  assert.match(stateResult.error, /state changed/);
  assert.equal(stateDrift.calls.some((call) => call.argv.includes('POST')), false);
});

test('post tool drops invalid inline locations', async () => {
  const head = '2'.repeat(40);
  let posted;
  const { spawn } = fakeSpawn([
    ...snapshotHandlers({ meta: pullMeta(head) }),
    { match: (argv) => argv.includes('POST'), reply: (_argv, options) => {
      posted = JSON.parse(options.input);
      return response({ id: 5 });
    } },
  ]);
  const input = reviewInput({ head, comments: [
    { path: 'src/index.js', line: 1, side: 'RIGHT', body: 'valid', priority: 'P1', severity: 'High', confidence: 'High' },
    { path: 'src/index.js', line: 999, side: 'RIGHT', body: 'invalid', priority: 'P2', severity: 'Medium', confidence: 'Medium' },
  ] });
  const result = await postReview(input, { agent: 'naru-orchestrator' }, { spawn });
  assert.equal(result.ok, true, result.error);
  assert.equal(posted.comments.length, 1);
  assert.equal(result.data.droppedComments.length, 1);
});

test('post tool detects an identical existing marker and refuses a conflicting marker', async () => {
  const head = '3'.repeat(40);
  let firstPost;
  const first = fakeSpawn([
    ...snapshotHandlers({ meta: pullMeta(head) }),
    { match: (argv) => argv.includes('POST'), reply: (_argv, options) => {
      firstPost = JSON.parse(options.input);
      return response({ id: 8 });
    } },
  ]);
  const firstResult = await postReview(reviewInput({ head }), { agent: 'naru-orchestrator' }, { spawn: first.spawn });
  assert.equal(firstResult.ok, true, firstResult.error);
  const marker = firstPost.body.match(/^<!-- naru-review:[^>]+-->/)[0];
  const existingReview = [{ id: 8, commit_id: head, body: marker, html_url: 'review-url', user: { login: 'viewer' } }];
  const same = fakeSpawn(snapshotHandlers({ meta: pullMeta(head), reviews: existingReview }));
  const sameInput = reviewInput({ head, reviews: existingReview });
  const sameResult = await postReview(sameInput, { agent: 'naru-orchestrator' }, { spawn: same.spawn });
  assert.equal(sameResult.ok, true);
  assert.equal(sameResult.data.reason, 'alreadyPosted');

  const conflictReview = [{
    id: 9,
    commit_id: head,
    body: marker.replace(/digest=[0-9a-f]{64}/, `digest=${'f'.repeat(64)}`),
    user: { login: 'viewer' },
  }];
  const conflict = fakeSpawn(snapshotHandlers({ meta: pullMeta(head), reviews: conflictReview }));
  const conflictInput = reviewInput({ head, reviews: conflictReview });
  const conflictResult = await postReview(conflictInput, { agent: 'naru-orchestrator' }, { spawn: conflict.spawn });
  assert.equal(conflictResult.ok, false);
  assert.match(conflictResult.error, /different Naru review/);
});

test('post tool ignores marker-shaped text from another GitHub actor', async () => {
  const head = '4'.repeat(40);
  const foreignReview = [{
    id: 10,
    commit_id: head,
    body: `<!-- naru-review:owner/repo#42 head=${head} digest=${'f'.repeat(64)} -->`,
    user: { login: 'someone-else' },
  }];
  const { spawn } = fakeSpawn([
    ...snapshotHandlers({ meta: pullMeta(head), reviews: foreignReview }),
    { match: (argv) => argv.includes('POST'), reply: response({ id: 11 }) },
  ]);
  const result = await postReview(
    reviewInput({ head, reviews: foreignReview }),
    { agent: 'naru-orchestrator' },
    { spawn },
  );
  assert.equal(result.ok, true, result.error);
  assert.equal(result.data.posted, true);
});

test('ambiguous POST is never retried', async () => {
  const head = '5'.repeat(40);
  let postCalls = 0;
  const { spawn } = fakeSpawn([
    ...snapshotHandlers({ meta: pullMeta(head) }),
    { match: (argv) => argv.includes('POST'), reply: () => {
      postCalls += 1;
      return response('gateway timeout', false);
    } },
  ]);
  const result = await postReview(reviewInput({ head }), { agent: 'naru-orchestrator' }, { spawn });
  assert.equal(result.ok, false);
  assert.match(result.error, /outcomeUnknown/);
  assert.equal(result.postAttempted, true);
  assert.equal(result.correctable, false);
  assert.equal(result.outcomeUnknown, true);
  const priorUnknown = await postReview(reviewInput({ head }), { agent: 'naru-orchestrator' }, { spawn });
  assert.match(priorUnknown.error, /prior in-process POST attempt/);
  assert.equal(priorUnknown.postAttempted, false);
  assert.equal(priorUnknown.correctable, false);
  assert.equal(priorUnknown.outcomeUnknown, true);
  assert.equal(postCalls, 1);
});

test('ambiguous formal review POSTs are attempted exactly once and remain terminal', async () => {
  const cases = [
    {
      head: '61'.repeat(20), policy: 'approve-if-clear', conclusion: 'clear', findings: [], event: 'APPROVE',
    },
    {
      head: '62'.repeat(20), policy: 'request-changes-if-blocked', conclusion: 'blocking',
      findings: [{ path: 'src/index.js', body: 'Blocker', priority: 'P1', severity: 'High', confidence: 'High' }],
      event: 'REQUEST_CHANGES',
    },
  ];
  for (const item of cases) {
    let postedEvent;
    let postCalls = 0;
    const { spawn } = fakeSpawn([
      ...snapshotHandlers({ meta: pullMeta(item.head) }),
      { match: (argv) => argv.includes('POST'), reply: (_argv, options) => {
        postCalls += 1;
        postedEvent = JSON.parse(options.input).event;
        return response('ambiguous failure', false);
      } },
    ]);
    const input = reviewInputV3({
      head: item.head, submissionPolicy: item.policy, conclusion: item.conclusion, findings: item.findings,
    });
    const first = await postReview(input, { agent: 'naru-orchestrator' }, { spawn });
    const second = await postReview(input, { agent: 'naru-orchestrator' }, { spawn });
    assert.equal(postedEvent, item.event);
    assert.equal(first.outcomeUnknown, true);
    assert.equal(first.postAttempted, true);
    assert.equal(second.outcomeUnknown, true);
    assert.equal(second.postAttempted, false);
    assert.equal(postCalls, 1);
  }
});

test('OpenCode wrappers expose one input schema and return JSON text', async () => {
  for (const tool of [gitReadTool, githubReadTool, githubPostReviewTool]) {
    assert.deepEqual(Object.keys(tool.args), ['input']);
    assert.equal(tool.args.input.type, 'object');
    assert.equal(typeof tool.execute, 'function');
  }
  const gitResult = await gitReadTool.execute(
    { input: { operation: 'status', unknown: true } },
    { directory: '/tmp/repo' },
  );
  assert.equal(typeof gitResult, 'string');
  assert.equal(JSON.parse(gitResult).ok, false);
  const postResult = await githubPostReviewTool.execute({ input: reviewInput() }, { agent: 'wrong' });
  assert.equal(typeof postResult, 'string');
  assert.match(JSON.parse(postResult).error, /identity/);
});

test('post tool schema exposes the exact nested review contract and aliases', () => {
  const reviewSchema = githubPostReviewTool.args.input.properties.reviewResult;
  assert.deepEqual(reviewSchema.required, [
    'schemaVersion', 'target', 'snapshot', 'coverage', 'body',
  ]);
  assert.equal(reviewSchema.additionalProperties, false);
  assert.deepEqual(Object.keys(reviewSchema.properties.target.properties), ['owner', 'repo', 'pullNumber', 'number']);
  assert.deepEqual(reviewSchema.properties.target.required, ['owner', 'repo']);
  assert.deepEqual(Object.keys(reviewSchema.properties.snapshot.properties), [
    'id', 'snapshotId', 'baseSha', 'headSha', 'feedbackDigest', 'complete', 'warnings',
  ]);
  assert.deepEqual(reviewSchema.properties.snapshot.required, [
    'baseSha', 'headSha', 'feedbackDigest', 'complete', 'warnings',
  ]);
  assert.match(reviewSchema.properties.target.description, /exactly one of pullNumber or number/);
  assert.match(reviewSchema.properties.target.properties.pullNumber.description, /exactly one/);
  assert.match(reviewSchema.properties.target.properties.number.description, /exactly one/);
  assert.match(reviewSchema.properties.snapshot.description, /exactly one of id or snapshotId/);
  assert.match(reviewSchema.properties.snapshot.properties.id.description, /exactly one/);
  assert.match(reviewSchema.properties.snapshot.properties.snapshotId.description, /exactly one/);
  assert.equal(reviewSchema.properties.target.oneOf, undefined);
  assert.equal(reviewSchema.properties.snapshot.oneOf, undefined);
  assert.deepEqual(reviewSchema.properties.inlineComments.items.required, [
    'path', 'line', 'side', 'body', 'priority', 'severity', 'confidence',
  ]);
  assert.deepEqual(reviewSchema.properties.skippedInlineComments.items.required, ['path', 'line', 'side', 'reason']);
  assert.deepEqual(reviewSchema.properties.schemaVersion.enum, [2, 3]);
  assert.deepEqual(reviewSchema.properties.findings.items.required, ['body', 'priority', 'severity', 'confidence']);
  assert.match(reviewSchema.properties.findings.description, /path-level/);
  assert.match(reviewSchema.properties.submissionPolicy.description, /asserts the current user authorization/);
  assert.match(reviewSchema.properties.submissionPolicy.description, /comment-only allows COMMENT/);
  assert.equal(reviewSchema.properties.event, undefined);
  const visit = (value) => {
    if (!value || typeof value !== 'object') return;
    assert.equal(Object.hasOwn(value, 'oneOf'), false);
    assert.equal(Object.hasOwn(value, 'not'), false);
    for (const nested of Object.values(value)) visit(nested);
  };
  visit(reviewSchema);
});

test('a pull snapshot from naru-github-read feeds the posting tool without renaming fields', async () => {
  // Regression: naru-github-read emits `number`/`snapshotId` while the posting
  // tool's canonical names are `pullNumber`/`id`. Carrying a snapshot straight
  // into a payload used to fail with "unknown fields: number".
  const snapshotShaped = {
    owner: 'sean35mm',
    repo: 'naru-opencode',
    number: 42,
    snapshotId: `naru-snap-${'a'.repeat(64)}`,
    baseSha: 'b'.repeat(40),
    headSha: 'c'.repeat(40),
    feedbackDigest: 'd'.repeat(64),
    complete: true,
    warnings: [],
  };
  const payload = {
    reviewResult: {
      schemaVersion: 2,
      target: { owner: snapshotShaped.owner, repo: snapshotShaped.repo, number: snapshotShaped.number },
      snapshot: {
        id: undefined,
        snapshotId: snapshotShaped.snapshotId,
        baseSha: snapshotShaped.baseSha,
        headSha: snapshotShaped.headSha,
        feedbackDigest: snapshotShaped.feedbackDigest,
        complete: true,
        warnings: [],
      },
      coverage: { complete: true, limitations: [] },
      body: 'Looks good.',
      inlineComments: [],
      skippedInlineComments: [],
    },
  };
  delete payload.reviewResult.snapshot.id;
  const validated = validateReviewPayload(payload);
  assert.equal(validated.target.number, 42);
  assert.equal(validated.snapshot.id, snapshotShaped.snapshotId);
});

test('honest coverage limitations are published, not treated as incomplete coverage', async () => {
  // Regression: any non-empty limitations array blocked posting outright, so an
  // honest "did not run the browser suite" note silently killed the review.
  let posted;
  const { spawn } = fakeSpawn([
    ...snapshotHandlers(),
    {
      match: (argv) => argv.includes('POST'),
      reply: (_argv, options) => {
        posted = JSON.parse(options.input);
        return response({ id: 7, html_url: 'https://github.com/owner/repo/pull/42#pullrequestreview-7' });
      },
    },
  ]);
  const input = reviewInput();
  input.reviewResult.coverage.limitations = ['Did not run the browser suite', 'Native build not exercised'];
  const result = await postReview(input, { agent: 'naru-orchestrator' }, { spawn });
  assert.equal(result.ok, true, result.error);
  assert.match(posted.body, /\*\*Review limitations\*\*/);
  assert.match(posted.body, /Did not run the browser suite/);
  assert.match(posted.body, /Native build not exercised/);
});

test('coverage limitations alter the dedupe digest', async () => {
  const head = 'b'.repeat(40);
  let posted;
  const first = fakeSpawn([
    ...snapshotHandlers({ meta: pullMeta(head) }),
    { match: (argv) => argv.includes('POST'), reply: (_argv, options) => {
      posted = JSON.parse(options.input);
      return response({ id: 302 });
    } },
  ]);
  const initial = reviewInput({ head });
  initial.reviewResult.coverage.limitations = ['Browser suite not run'];
  assert.equal((await postReview(initial, { agent: 'naru-orchestrator' }, { spawn: first.spawn })).ok, true);

  const marker = posted.body.match(/^<!-- naru-review:[^>]+-->/)[0];
  const reviews = [{ id: 302, commit_id: head, body: marker, user: { login: 'viewer' } }];
  const changed = reviewInput({ head, reviews });
  changed.reviewResult.coverage.limitations = ['Native build not run'];
  const second = fakeSpawn(snapshotHandlers({ meta: pullMeta(head), reviews }));
  const result = await postReview(changed, { agent: 'naru-orchestrator' }, { spawn: second.spawn });
  assert.equal(result.ok, false);
  assert.match(result.error, /different Naru review/);
  assert.equal(result.postAttempted, false);
  assert.equal(result.correctable, false);
});

test('v3 derived event and evidence limitations alter same-head dedupe', async () => {
  const eventHead = '71'.repeat(20);
  let eventPost;
  const firstEvent = fakeSpawn([
    ...snapshotHandlers({ meta: pullMeta(eventHead) }),
    { match: (argv) => argv.includes('POST'), reply: (_argv, options) => {
      eventPost = JSON.parse(options.input);
      return response({ id: 701 });
    } },
  ]);
  const approve = reviewInputV3({ head: eventHead, submissionPolicy: 'approve-if-clear', conclusion: 'clear' });
  assert.equal((await postReview(approve, { agent: 'naru-orchestrator' }, { spawn: firstEvent.spawn })).data.event, 'APPROVE');
  const eventMarker = eventPost.body.match(/^<!-- naru-review:[^>]+-->/)[0];
  const eventReviews = [{ id: 701, commit_id: eventHead, body: eventMarker, user: { login: 'viewer' } }];
  const secondEvent = fakeSpawn(snapshotHandlers({ meta: pullMeta(eventHead), reviews: eventReviews }));
  const comment = reviewInputV3({ head: eventHead, reviews: eventReviews, submissionPolicy: 'comment-only', conclusion: 'clear' });
  const eventConflict = await postReview(comment, { agent: 'naru-orchestrator' }, { spawn: secondEvent.spawn });
  assert.match(eventConflict.error, /different Naru review/);

  const limitationHead = '72'.repeat(20);
  let limitationPost;
  const firstLimitation = fakeSpawn([
    ...snapshotHandlers({ meta: pullMeta(limitationHead) }),
    { match: (argv) => argv.includes('POST'), reply: (_argv, options) => {
      limitationPost = JSON.parse(options.input);
      return response({ id: 702 });
    } },
  ]);
  const limited = reviewInputV3({ head: limitationHead, posture: 'limited', limitations: ['Browser suite not run'] });
  assert.equal((await postReview(limited, { agent: 'naru-orchestrator' }, { spawn: firstLimitation.spawn })).ok, true);
  const limitationMarker = limitationPost.body.match(/^<!-- naru-review:[^>]+-->/)[0];
  const limitationReviews = [{ id: 702, commit_id: limitationHead, body: limitationMarker, user: { login: 'viewer' } }];
  const changed = reviewInputV3({
    head: limitationHead, reviews: limitationReviews, posture: 'limited', limitations: ['Native build not run'],
  });
  const secondLimitation = fakeSpawn(snapshotHandlers({ meta: pullMeta(limitationHead), reviews: limitationReviews }));
  const limitationConflict = await postReview(changed, { agent: 'naru-orchestrator' }, { spawn: secondLimitation.spawn });
  assert.match(limitationConflict.error, /different Naru review/);

  const postureHead = '73'.repeat(20);
  let posturePost;
  const firstPosture = fakeSpawn([
    ...snapshotHandlers({ meta: pullMeta(postureHead) }),
    { match: (argv) => argv.includes('POST'), reply: (_argv, options) => {
      posturePost = JSON.parse(options.input);
      return response({ id: 703 });
    } },
  ]);
  assert.equal((await postReview(reviewInputV3({ head: postureHead }), { agent: 'naru-orchestrator' }, { spawn: firstPosture.spawn })).data.evidencePosture, 'complete');
  const postureMarker = posturePost.body.match(/^<!-- naru-review:[^>]+-->/)[0];
  const postureReviews = [{ id: 703, commit_id: postureHead, body: postureMarker, user: { login: 'viewer' } }];
  const secondPosture = fakeSpawn(snapshotHandlers({ meta: pullMeta(postureHead), reviews: postureReviews }));
  const postureConflict = await postReview(
    reviewInputV3({ head: postureHead, reviews: postureReviews, posture: 'limited', limitations: ['Manual coverage was limited'] }),
    { agent: 'naru-orchestrator' }, { spawn: secondPosture.spawn },
  );
  assert.match(postureConflict.error, /different Naru review/);
});

test('oversized composed body is a correctable pre-POST failure with no I/O', async () => {
  let ioCalls = 0;
  const input = reviewInput({ body: 'x'.repeat(64 * 1024 - 257) });
  input.reviewResult.coverage.limitations = ['y'.repeat(512)];
  const result = await postReview(input, { agent: 'naru-orchestrator' }, {
    spawn: async () => { ioCalls += 1; },
  });
  assert.match(result.error, /composed review body exceeds/);
  assert.equal(result.postAttempted, false);
  assert.equal(result.correctable, true);
  assert.equal(result.outcomeUnknown, false);
  assert.equal(ioCalls, 0);
});

test('rendered non-inline findings participate in final review body bounds', async () => {
  const head = '87'.repeat(20);
  const { spawn, calls } = fakeSpawn(snapshotHandlers({ meta: pullMeta(head) }));
  const input = reviewInputV3({
    head,
    body: 'x'.repeat(64 * 1024 - 257),
    findings: [{ body: 'Visible bounded finding', priority: 'P2', severity: 'Medium', confidence: 'High' }],
  });
  const result = await postReview(input, { agent: 'naru-orchestrator' }, { spawn });
  assert.match(result.error, /composed review body exceeds/);
  assert.equal(result.correctable, true);
  assert.equal(calls.some((call) => call.argv.includes('POST')), false);
});

test('coverage.complete false still refuses to post', async () => {
  const result = await postReview(
    reviewInput({ status: 'incomplete', degraded: true }),
    { agent: 'naru-orchestrator' },
    { spawn: async () => { throw new Error('unexpected I/O'); } },
  );
  assert.match(result.error, /incomplete/);
});

test('review policy docs lock authorization, formal gates, and one-POST terminal behavior', async () => {
  const [orchestrator, skill, readme, userGuide, agentsGuide, reviewLane, visualGuide] = await Promise.all([
    readFile(new URL('../agents/naru-orchestrator.md', import.meta.url), 'utf8'),
    readFile(new URL('../skills/naru-review/SKILL.md', import.meta.url), 'utf8'),
    readFile(new URL('../README.md', import.meta.url), 'utf8'),
    readFile(new URL('../docs/user-guide.md', import.meta.url), 'utf8'),
    readFile(new URL('../docs/src/content/docs/workflows/agents.md', import.meta.url), 'utf8'),
    readFile(new URL('../docs/src/content/docs/workflows/review-lane.md', import.meta.url), 'utf8'),
    readFile(new URL('../naru-visual-guide.html', import.meta.url), 'utf8'),
  ]);

  for (const publicDoc of [readme, userGuide, visualGuide]) {
    assert.doesNotMatch(publicDoc, /tool that posts a pull-request review can only leave a comment/i);
    assert.doesNotMatch(publicDoc, /One `COMMENT`-only attempt/i);
    assert.doesNotMatch(publicDoc, /comment-only (?:<b>by construction<\/b>|tool|posting tool)/i);
  }

  for (const policy of [orchestrator, skill, readme, userGuide, agentsGuide, reviewLane]) {
    assert.match(policy, /dry-run (?:is (?:the )?|by )default/i);
    assert.match(policy, /post[\s\S]{0,80}comment[\s\S]{0,80}submit/i);
    assert.match(policy, /approve if clear/i);
    assert.match(policy, /request changes if blocked/i);
    assert.match(policy, /appropriate review decision|select-state/i);
    assert.match(policy, /limited(?: v3| patch)? evidence[\s\S]{0,100}`?COMMENT`?/i);
  }

  for (const policy of [orchestrator, skill, reviewLane]) {
    assert.match(policy, /`comment-only`/);
    assert.match(policy, /`approve-if-clear`/);
    assert.match(policy, /`request-changes-if-blocked`/);
    assert.match(policy, /`select-state`/);
  }

  for (const policy of [orchestrator, skill, userGuide, reviewLane]) {
    assert.match(policy, /prior-message intent/i);
    assert.match(policy, /PR, diff/i);
    assert.match(policy, /no raw event|never include a raw `event`|never supply a raw GitHub event|contains no raw event/i);
    assert.match(policy, /APPROVE/);
    assert.match(policy, /complete (?:snapshot )?evidence/i);
    assert.match(policy, /complete (?:review )?coverage/i);
    assert.match(policy, /clear conclusion/i);
    assert.match(policy, /no declared blockers/i);
    assert.match(policy, /open non-draft PR/i);
    assert.match(policy, /actor (?:!=|different from|other than) (?:the PR |the )?author/i);
    assert.match(policy, /REQUEST_CHANGES/);
    assert.match(policy, /blocking conclusion/i);
    assert.match(policy, /P0\/P1/);
    assert.match(policy, /Critical\/High/);
    assert.match(policy, /High(?:-|\s)confidence/i);
    assert.match(policy, /complete current(?:-|\s)patch evidence/i);
    assert.match(policy, /formal[\s\S]{0,80}(?:gate|ineligib)[\s\S]{0,80}(?:downgrade|downgrades)[\s\S]{0,40}`COMMENT`/i);
    assert.match(policy, /inventory[\s\S]{0,80}feedback[\s\S]{0,100}(?:refus|unpostable)/i);
    assert.match(policy, /v2[\s\S]{0,100}complete(?:-|\s)evidence[\s\S]{0,40}`COMMENT`/i);
    assert.match(policy, /v3[\s\S]{0,80}canonical/i);
  }

  for (const policy of [orchestrator, skill, userGuide, agentsGuide]) {
    assert.match(policy, /(?:Make |allows )?[Aa]t most one GitHub POST attempt(?: is allowed)?, not one tool invocation/);
    assert.match(policy, /`postAttempted: false` and `correctable: true`/);
    assert.match(policy, /[Ww]rong-agent/);
    assert.match(policy, /`postAttempted: true`/);
    assert.match(policy, /`outcomeUnknown: true`/);
  }
  for (const policy of [orchestrator, skill]) {
    assert.match(policy, /Never (retry or\nuse|use) another/);
    assert.match(policy, /orchestrator-only/);
  }
  for (const policy of [userGuide, agentsGuide]) assert.match(policy, /Never use another posting mechanism/);
});
