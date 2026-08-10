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

function pullMeta(head = HEAD, base = BASE, changedFiles = 1, number = 42) {
  return {
    number,
    title: 'Safe change',
    body: 'Description',
    state: 'open',
    html_url: `https://github.com/owner/repo/pull/${number}`,
    user: { login: 'author' },
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
} = {}) {
  return [
    { match: (argv) => argv[3] === 'GET' && argv[4] === 'user', reply: response({ login: 'viewer' }) },
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
    'schemaVersion', 'target', 'snapshot', 'coverage', 'body', 'inlineComments', 'skippedInlineComments',
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

test('coverage.complete false still refuses to post', async () => {
  const result = await postReview(
    reviewInput({ status: 'incomplete', degraded: true }),
    { agent: 'naru-orchestrator' },
    { spawn: async () => { throw new Error('unexpected I/O'); } },
  );
  assert.match(result.error, /incomplete/);
});

test('review policy permits correction only from explicit pre-POST state', async () => {
  const [orchestrator, skill, userGuide, agentsGuide] = await Promise.all([
    readFile(new URL('../agents/naru-orchestrator.md', import.meta.url), 'utf8'),
    readFile(new URL('../skills/naru-review/SKILL.md', import.meta.url), 'utf8'),
    readFile(new URL('../docs/user-guide.md', import.meta.url), 'utf8'),
    readFile(new URL('../docs/src/content/docs/workflows/agents.md', import.meta.url), 'utf8'),
  ]);
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
    assert.match(policy, /comment-only/);
  }
  for (const policy of [userGuide, agentsGuide]) assert.match(policy, /Never use another posting mechanism/);
});
