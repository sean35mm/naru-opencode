import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import * as validate from '../tools/naru-lib/validate.mjs';
import { runGit, validateGitInput } from '../tools/naru-lib/git.mjs';
import {
  parseReference,
  pullSnapshot,
  pullManifest,
  pullFilesAtHead,
  pullFileBatchesAtManifest,
  fetchSourceAtSha,
  snapshotId,
  digestSnapshot,
  digestEvidence,
  digestRawFileBatch,
  digestFeedbackPage,
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

function denseContextFile(filename, lines) {
  return {
    ...changedFile(filename, `@@ -1,${lines} +1,${lines} @@\n${' x\n'.repeat(lines)}`),
    additions: 0,
    deletions: 0,
    changes: 0,
  };
}

function evidenceFile(file) {
  const missing = typeof file.patch !== 'string' || file.patch.length === 0;
  const redacted = !validate.isSafeRelativePath(file.filename)
    || (file.previous_filename !== undefined && !validate.isSafeRelativePath(file.previous_filename));
  return {
    filename: file.filename,
    previousFilename: file.previous_filename ?? null,
    status: file.status,
    sha: file.sha,
    additions: file.additions,
    deletions: file.deletions,
    changes: file.changes,
    patch: missing || redacted ? undefined : file.patch,
    patchEvidence: redacted
      ? { status: 'unavailable', reason: 'redacted-path', retention: 'none', validation: { structural: false, metadata: false } }
      : missing
        ? { status: 'unavailable', reason: 'missing-patch', retention: 'none', validation: { structural: false, metadata: false } }
        : { status: 'complete', reason: 'complete', retention: 'full', validation: { structural: true, metadata: true } },
  };
}

function coverageLedger(files, limited = false, limitation = 'review coverage is incomplete') {
  return files.map((file, index) => {
    const patchComplete = typeof file.patch === 'string'
      && validate.isSafeRelativePath(file.filename)
      && (file.previous_filename === undefined || validate.isSafeRelativePath(file.previous_filename));
    const blocked = !patchComplete || (limited && index === 0);
    return {
      path: file.filename,
      status: blocked ? 'blocked' : 'reviewed',
      evidence: blocked ? 'none' : 'current-patch',
      ...(blocked ? { note: !patchComplete ? 'patch evidence is unavailable' : limitation } : {}),
    };
  });
}
function provenance(identity, files, reviews, reviewComments, issueComments) {
  const fileBatches = [];
  for (let index = 0; index < files.length; index += 100) {
    const chunk = files.slice(index, index + 100);
    const paths = chunk.map(file => file.filename);
    fileBatches.push({ paths, batchDigest: digestRawFileBatch(identity, paths, chunk) });
  }
  const normalize = item => ({
    id: item.id, state: item.state, commitId: item.commit_id, body: item.body ?? '', author: item.user?.login,
    path: item.path, line: item.line, side: item.side, updatedAt: item.updated_at ?? item.submitted_at,
    url: item.html_url ?? item.url,
  });
  const feedbackPages = [];
  for (const [kind, items] of [['reviews', reviews], ['review-comments', reviewComments], ['issue-comments', issueComments]]) {
    for (let index = 0; index < items.length; index += 100) {
      const page = index / 100 + 1;
      feedbackPages.push({ kind, page, pageDigest: digestFeedbackPage(identity, kind, page, items.slice(index, index + 100).map(normalize)) });
    }
  }
  return { fileBatches, feedbackPages };
}
function fixtureIdentity(head, files, { base = BASE, reviews = [], reviewComments = [], issueComments = [] } = {}) {
  const meta = pullMeta(head, base, files.length);
  return {
    baseSha: base, headSha: head,
    snapshotId: snapshotId('owner', 'repo', 42, head, base, files),
    feedbackDigest: digestSnapshot(meta, files, reviews, reviewComments, issueComments),
    evidenceDigest: digestEvidence(head, base, files.map(evidenceFile)),
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
  const requestedPage = argv => {
    const endpoint = argv.find(value => typeof value === 'string' && /[?&]per_page=\d+&page=\d+/.test(value));
    const page = endpoint?.match(/[?&]page=(\d+)/)?.[1];
    const pageSize = endpoint?.match(/[?&]per_page=(\d+)/)?.[1];
    return page === undefined || pageSize === undefined ? undefined : { page: Number(page), pageSize: Number(pageSize) };
  };
  const pageItems = (items, request) => request === undefined
    ? items : items.slice((request.page - 1) * request.pageSize, request.page * request.pageSize);
  const feedbackReply = items => argv => {
    const page = requestedPage(argv);
    return page === undefined ? response([items]) : response(pageItems(items, page));
  };
  return [
    { match: (argv) => argv[3] === 'GET' && argv[4] === 'user', reply: response({ login: actor }) },
    {
      match: (argv) => argv[3] === 'GET' && has(argv, `pulls/${number}`) && !has(argv, '/files') && !has(argv, '/reviews') && !has(argv, '/comments'),
      reply: metadataReply ?? response(meta),
    },
    { match: (argv) => argv[3] === 'GET' && has(argv, `pulls/${number}/files`), reply: (argv) => {
      const jqIndex = argv.indexOf('--jq');
      if (jqIndex === -1) return response([files]);
      const jq = argv[jqIndex + 1];
      const page = requestedPage(argv);
      const sourceFiles = pageItems(files, page);
      const projected = jq.includes('.filename as $filename')
        ? sourceFiles.filter(file => jq.includes(JSON.stringify(file.filename)))
        : sourceFiles;
      if (jq.includes('patch_base64')) {
        return response(projected.map(file => {
          const patch = typeof file.patch === 'string' ? file.patch : null;
          const patchBytes = patch === null ? 0 : Buffer.byteLength(patch);
          return {
            filename: file.filename,
            previous_filename: file.previous_filename,
            status: file.status,
            sha: file.sha,
            additions: file.additions,
            deletions: file.deletions,
            changes: file.changes,
            patch_bytes: patchBytes,
            patch_oversized: patchBytes > 1024 * 1024,
            patch_base64: patchBytes <= 1024 * 1024 && patch !== null ? Buffer.from(patch).toString('base64') : null,
          };
        }));
      }
      return response(projected.map(file => ({
        filename: file.filename,
        previous_filename: file.previous_filename,
        status: file.status,
        sha: file.sha,
        additions: file.additions,
        deletions: file.deletions,
        changes: file.changes,
        ...(jq.includes(',patch}') ? { patch: file.patch } : {}),
      })));
    } },
    { match: (argv) => argv[3] === 'GET' && has(argv, `pulls/${number}/reviews`), reply: feedbackReply(reviews) },
    { match: (argv) => argv[3] === 'GET' && has(argv, `pulls/${number}/comments`), reply: feedbackReply(reviewComments) },
    { match: (argv) => argv[3] === 'GET' && has(argv, `issues/${number}/comments`), reply: feedbackReply(issueComments) },
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
  const feedbackDigest = digestSnapshot(meta, files, reviews, reviewComments, issueComments);
  const identity = { owner: 'owner', repo: 'repo', number, baseSha: base, headSha: head,
    snapshotId: snapshotId('owner', 'repo', number, head, base, files), feedbackDigest,
    evidenceDigest: digestEvidence(head, base, files.map(evidenceFile)) };
  const limited = status !== 'complete' || degraded || snapshotComplete === false
    || files.some(file => typeof file.patch !== 'string');
  return {
    reviewResult: {
      schemaVersion: 4,
      target: { owner: 'owner', repo: 'repo', pullNumber: number },
      snapshot: {
        id: identity.snapshotId,
        baseSha: base,
        headSha: head,
        feedbackDigest,
        evidenceDigest: identity.evidenceDigest,
        warnings: [],
      },
      coverage: {
        ledger: coverageLedger(files, limited),
        ...provenance(identity, files, reviews, reviewComments, issueComments),
        feedbackAcknowledged: true,
        feedbackDigest,
      },
      submissionMode: limited ? 'limited' : 'complete',
      summary: body,
      submissionPolicy: 'comment-only',
      conclusion: 'informational',
      findings: comments ?? [{
        path: 'src/index.js',
        line: 1,
        side: 'RIGHT',
        body: 'This changed line can fail.',
        priority: 'P1',
        severity: 'High',
        confidence: 'High',
      }],
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
  const feedbackDigest = digestSnapshot(meta, files, reviews, reviewComments, issueComments);
  const identity = { owner: 'owner', repo: 'repo', number, baseSha: base, headSha: head,
    snapshotId: snapshotId('owner', 'repo', number, head, base, files), feedbackDigest,
    evidenceDigest: digestEvidence(head, base, files.map(evidenceFile)) };
  const limited = posture === 'limited' || snapshotComplete === false
    || files.some(file => typeof file.patch !== 'string');
  return {
    reviewResult: {
      schemaVersion: 4,
      target: { owner: 'owner', repo: 'repo', pullNumber: number },
      snapshot: {
        id: identity.snapshotId,
        baseSha: base,
        headSha: head,
        feedbackDigest,
        evidenceDigest: identity.evidenceDigest,
        warnings: snapshotWarnings,
      },
      coverage: {
        ledger: coverageLedger(files, limited, limitations[0]),
        ...provenance(identity, files, reviews, reviewComments, issueComments),
        feedbackAcknowledged: true,
        feedbackDigest,
      },
      submissionMode: limited ? 'limited' : 'complete',
      summary: body,
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

test('large structurally complete patches below the line-map ceiling do not use changes count as a truncation heuristic', async () => {
  for (const changes of [343, 501, 1000]) {
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
  assert.equal(snapshot.reviewability.status, 'unpostable');
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

test('changed-file immutable metadata matrix fails compact and full reviewability closed', async () => {
  const head = '41'.repeat(20);
  const invalidFiles = [
    { label: 'missing filename', file: { ...changedFile(), filename: undefined } },
    { label: 'unsafe filename', file: { ...changedFile(), filename: '../unsafe.js' } },
    { label: 'missing status', file: { ...changedFile(), status: undefined } },
    { label: 'invalid status', file: { ...changedFile(), status: 'mystery' } },
    { label: 'missing sha', file: { ...changedFile(), sha: undefined } },
    { label: 'invalid sha', file: { ...changedFile(), sha: 'not-a-blob' } },
    { label: 'missing additions', file: { ...changedFile(), additions: undefined } },
    { label: 'negative additions', file: { ...changedFile(), additions: -1 } },
    { label: 'fractional additions', file: { ...changedFile(), additions: 0.5 } },
    { label: 'missing deletions', file: { ...changedFile(), deletions: undefined } },
    { label: 'negative deletions', file: { ...changedFile(), deletions: -1 } },
    { label: 'missing changes', file: { ...changedFile(), changes: undefined } },
    { label: 'negative changes', file: { ...changedFile(), changes: -1 } },
    { label: 'inconsistent totals', file: { ...changedFile(), changes: 3 } },
    { label: 'rename missing previous path', file: { ...changedFile(), status: 'renamed' } },
    { label: 'rename unsafe previous path', file: { ...changedFile(), status: 'renamed', previous_filename: '../old.js' } },
  ];
  for (const { label, file } of invalidFiles) {
    const handlers = snapshotHandlers({ meta: pullMeta(head), files: [file] });
    const manifest = await pullManifest({ owner: 'owner', repo: 'repo', number: 42 }, { spawn: fakeSpawn(handlers).spawn });
    assert.equal(manifest.reviewability.status, 'unpostable', label);
    assert.equal(manifest.reviewability.inventoryComplete, false, label);
    const snapshot = await pullSnapshot({ owner: 'owner', repo: 'repo', number: 42 }, { spawn: fakeSpawn(handlers).spawn });
    assert.equal(snapshot.reviewability.status, 'unpostable', label);
    assert.equal(snapshot.reviewability.inventoryComplete, false, label);
    assert.equal(snapshot.files[0].patchEvidence.validation.metadata, false, label);
  }
});

test('valid added, modified, renamed, removed, and binary files preserve legitimate reviewability', async () => {
  const head = '42'.repeat(20);
  const files = [
    { ...changedFile('src/added.js', '@@ -0,0 +1 @@\n+new'), status: 'added', additions: 1, deletions: 0, changes: 1 },
    changedFile('src/modified.js'),
    { ...changedFile('src/renamed.js'), status: 'renamed', previous_filename: 'src/old-name.js' },
    { ...changedFile('src/removed.js', '@@ -1 +0,0 @@\n-old'), status: 'removed', additions: 0, deletions: 1, changes: 1 },
    { ...changedFile('assets/binary.png'), patch: undefined, additions: 0, deletions: 0, changes: 0 },
  ];
  const handlers = snapshotHandlers({ meta: pullMeta(head, BASE, files.length), files });
  const manifest = await pullManifest({ owner: 'owner', repo: 'repo', number: 42 }, { spawn: fakeSpawn(handlers).spawn });
  assert.equal(manifest.reviewability.status, 'manifest');
  assert.equal(manifest.reviewability.inventoryComplete, true);
  assert.equal(manifest.files[1].previousPath, null);
  const snapshot = await pullSnapshot({ owner: 'owner', repo: 'repo', number: 42 }, { spawn: fakeSpawn(handlers).spawn });
  assert.equal(snapshot.reviewability.status, 'limited-comment');
  assert.equal(snapshot.reviewability.inventoryComplete, true);
  assert.equal(snapshot.files.slice(0, 4).every(file => file.patchEvidence.status === 'complete'), true);
  assert.equal(snapshot.files[4].patchEvidence.reason, 'missing-patch');
  assert.match(snapshot.files[3].sha, /^[0-9a-f]{40}$/);
});

test('rename source path binds snapshot, feedback, evidence, and batch identities', async () => {
  const head = '44'.repeat(20);
  const first = { ...changedFile('src/renamed.js'), status: 'renamed', previous_filename: 'src/old-a.js' };
  const second = { ...first, previous_filename: 'src/old-b.js' };
  const meta = pullMeta(head);
  const firstIdentity = {
    owner: 'owner', repo: 'repo', number: 42, baseSha: BASE, headSha: head,
    snapshotId: snapshotId('owner', 'repo', 42, head, BASE, [first]),
    feedbackDigest: digestSnapshot(meta, [first], [], [], []),
    evidenceDigest: digestEvidence(head, BASE, [first]),
  };
  const secondIdentity = {
    owner: 'owner', repo: 'repo', number: 42, baseSha: BASE, headSha: head,
    snapshotId: snapshotId('owner', 'repo', 42, head, BASE, [second]),
    feedbackDigest: digestSnapshot(meta, [second], [], [], []),
    evidenceDigest: digestEvidence(head, BASE, [second]),
  };
  assert.notEqual(firstIdentity.snapshotId, secondIdentity.snapshotId);
  assert.notEqual(firstIdentity.feedbackDigest, secondIdentity.feedbackDigest);
  assert.notEqual(firstIdentity.evidenceDigest, secondIdentity.evidenceDigest);
  assert.notEqual(
    digestRawFileBatch(firstIdentity, [first.filename], [first]),
    digestRawFileBatch(firstIdentity, [second.filename], [second]),
  );

  const firstManifest = await pullManifest({ owner: 'owner', repo: 'repo', number: 42 }, {
    spawn: fakeSpawn(snapshotHandlers({ meta, files: [first] })).spawn,
  });
  const secondManifest = await pullManifest({ owner: 'owner', repo: 'repo', number: 42 }, {
    spawn: fakeSpawn(snapshotHandlers({ meta, files: [second] })).spawn,
  });
  assert.equal(firstManifest.files[0].previousPath, 'src/old-a.js');
  assert.equal(secondManifest.files[0].previousPath, 'src/old-b.js');
  assert.notEqual(firstManifest.snapshotId, secondManifest.snapshotId);
  assert.notEqual(firstManifest.feedbackDigest, secondManifest.feedbackDigest);
  assert.notEqual(firstManifest.evidenceDigest, secondManifest.evidenceDigest);
});

test('same-head rename source drift rejects stale v4 provenance without POST', async () => {
  const head = '45'.repeat(20);
  const reviewed = { ...changedFile(), status: 'renamed', previous_filename: 'src/original-a.js' };
  const drifted = { ...reviewed, previous_filename: 'src/original-b.js' };
  const fake = fakeSpawn([
    ...snapshotHandlers({ meta: pullMeta(head), files: [drifted] }),
    { match: argv => argv.includes('POST'), reply: response({ id: 450 }) },
  ]);
  const result = await postReview(reviewInput({ head, files: [reviewed], comments: [] }),
    { agent: 'naru-orchestrator' }, { spawn: fake.spawn });
  assert.equal(result.ok, false);
  assert.match(result.error, /bounded manifest (?:snapshotId|feedbackDigest|evidenceDigest) mismatch/);
  assert.equal(fake.calls.some(call => call.argv.includes('POST')), false);
});

test('formal v4 posting cannot derive complete evidence from malformed file metadata', async () => {
  const head = '43'.repeat(20);
  const files = [{ ...changedFile(), sha: undefined }];
  const fake = fakeSpawn([
    ...snapshotHandlers({ meta: pullMeta(head), files }),
    { match: argv => argv.includes('POST'), reply: response({ id: 430 }) },
  ]);
  const result = await postReview(reviewInput({ head, files, comments: [] }), { agent: 'naru-orchestrator' }, { spawn: fake.spawn });
  assert.equal(result.ok, false);
  assert.match(result.error, /unpostable/);
  assert.equal(fake.calls.some(call => call.argv.includes('POST')), false);
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

test('v4 payload validation enforces version-specific findings and rejects caller events', () => {
  const input = reviewInputV3({ findings: [
    { body: 'General observation', priority: 'P3', severity: 'Low', confidence: 'Medium' },
    { path: 'src/index.js', body: 'Path-level blocker', priority: 'P1', severity: 'High', confidence: 'High' },
    { path: 'src/index.js', line: 1, side: 'RIGHT', body: 'Inline issue', priority: 'P2', severity: 'Medium', confidence: 'High' },
  ] });
  const canonical = validateReviewPayload(input);
  assert.equal(canonical.schemaVersion, 4);
  assert.equal(canonical.findings.length, 3);
  assert.throws(() => validateReviewPayload({
    reviewResult: { ...input.reviewResult, event: 'APPROVE' },
  }), /unknown fields/);
  const partialLocation = structuredClone(input);
  partialLocation.reviewResult.findings[0] = {
    path: 'src/index.js', line: 1, body: 'Missing side', priority: 'P1', severity: 'High', confidence: 'High',
  };
  assert.throws(() => validateReviewPayload(partialLocation), /line and side together/);
  const callerAssertsPosture = reviewInputV3({ posture: 'limited' });
  callerAssertsPosture.reviewResult.coverage.complete = false;
  assert.throws(() => validateReviewPayload(callerAssertsPosture), /unknown fields/);
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
  const input = reviewInput({ status: 'incomplete', degraded: true });
  input.reviewResult.submissionMode = 'complete';
  const fake = fakeSpawn(snapshotHandlers());
  const result = await postReview(input, { agent: 'naru-orchestrator' }, { spawn: fake.spawn });
  assert.match(result.error, /submissionMode=limited/);
  assert.equal(fake.calls.some(call => call.argv.includes('POST')), false);
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

test('post tool rejects initial mode for incomplete and degraded reviews before POST', async () => {
  for (const status of ['incomplete', 'partial']) {
    const input = reviewInput({ status, degraded: true });
    input.reviewResult.submissionMode = 'complete';
    const fake = fakeSpawn(snapshotHandlers());
    assert.match((await postReview(input, { agent: 'naru-orchestrator' }, { spawn: fake.spawn })).error, /submissionMode=limited/);
    assert.equal(fake.calls.some(call => call.argv.includes('POST')), false);
  }
});

test('post tool rejects initial submissionMode for limited coverage before POST', async () => {
  const input = reviewInput({ snapshotComplete: false });
  input.reviewResult.submissionMode = 'complete';
  const fake = fakeSpawn(snapshotHandlers());
  const result = await postReview(input, { agent: 'naru-orchestrator' }, { spawn: fake.spawn });
  assert.equal(result.postAttempted, false);
  assert.equal(result.correctable, true);
  assert.equal(result.outcomeUnknown, false);
  assert.match(result.error, /explicit review request/);
  assert.equal(fake.calls.some(call => call.argv.includes('POST')), false);
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
    assert.match(posted.body, /review coverage is incomplete/);
    assert.equal(calls.filter((call) => call.argv.includes('POST')).length, 1);
  }
});

test('payload-incomplete evidence requires limited posture before any POST', async () => {
  const head = '8d'.repeat(20);
  const { spawn, calls } = fakeSpawn(snapshotHandlers({ meta: pullMeta(head) }));
  const input = reviewInputV3({
    head,
    posture: 'complete',
    snapshotComplete: false,
    snapshotWarnings: ['Material evidence was unavailable'],
    submissionPolicy: 'approve-if-clear',
    conclusion: 'clear',
  });
  input.reviewResult.submissionMode = 'complete';
  const result = await postReview(input, { agent: 'naru-orchestrator' }, { spawn });
  assert.equal(result.ok, false);
  assert.equal(result.correctable, true);
  assert.match(result.error, /submissionMode=limited/);
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
    body: 'Review complete. Browser suite was not run.',
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

test('v4 renders every non-inline finding safely and refuses redacted paths', async () => {
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
  const redacted = fakeSpawn([
    ...snapshotHandlers({ meta: pullMeta(redactedHead), files }),
  ]);
  const redactedResult = await postReview(reviewInputV3({
    head: redactedHead,
    files,
    posture: 'limited',
    limitations: ['One path was redacted'],
    findings: [{ path: 'src/safe.js', body: 'Redacted-path observation', priority: 'P2', severity: 'Medium', confidence: 'High' }],
  }), { agent: 'naru-orchestrator' }, { spawn: redacted.spawn });
  assert.equal(redactedResult.ok, false);
  assert.match(redactedResult.error, /unpostable/);
  assert.equal(redacted.calls.some(call => call.argv.includes('POST')), false);
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
  assert.match((await postReview(reviewInput({ head: expectedHead }), { agent: 'naru-orchestrator' }, { spawn: headDrift.spawn })).error, /(?:head SHA|headSha) mismatch/);

  const feedbackHead = '7'.repeat(40);
  const comments = [{ id: 10, body: 'new feedback', updated_at: 'now' }];
  const feedbackDrift = fakeSpawn(snapshotHandlers({ meta: pullMeta(feedbackHead), issueComments: comments }));
  assert.match((await postReview(reviewInput({ head: feedbackHead }), { agent: 'naru-orchestrator' }, { spawn: feedbackDrift.spawn })).error, /(?:feedback digest|feedbackDigest) mismatch/);
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
  assert.match(initialResult.error, /(?:feedback digest|feedbackDigest) mismatch/);
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
  assert.match(finalResult.error, /(?:final snapshot feedback digest|file batch manifest identity|bounded manifest feedbackDigest) mismatch/);
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
  assert.match(headResult.error, /(?:final snapshot head SHA|file batch manifest identity|bounded manifest headSha) mismatch/);
  assert.equal(headDrift.calls.filter((call) => call.argv.includes('POST')).length, 0);

  const feedbackHead = 'c'.repeat(40);
  let issueCalls = 0;
  const finalFeedback = [{ id: 20, body: 'late feedback', updated_at: 'later' }];
  const feedbackDrift = fakeSpawn([
    {
      match: (argv) => argv[3] === 'GET' && has(argv, 'issues/42/comments'),
      reply: argv => {
        const items = issueCalls++ === 0 ? [] : finalFeedback;
        return response(has(argv, '?per_page=100&page=') ? items : [items]);
      },
    },
    ...snapshotHandlers({ meta: pullMeta(feedbackHead) }),
  ]);
  const feedbackResult = await postReview(reviewInput({ head: feedbackHead }), { agent: 'naru-orchestrator' }, { spawn: feedbackDrift.spawn });
  assert.equal(feedbackResult.ok, false);
  assert.match(feedbackResult.error, /(?:final snapshot feedback digest|file batch manifest identity|bounded manifest feedbackDigest) mismatch/);
  assert.equal(feedbackDrift.calls.filter((call) => call.argv.includes('POST')).length, 0);
});

test('post tool refuses final patch-evidence and pull-state drift without POST', async () => {
  const head = '51'.repeat(20);
  let evidenceCalls = 0;
  const evidenceDrift = fakeSpawn([
    {
      match: (argv) => argv[3] === 'GET' && has(argv, 'pulls/42/files'),
      reply: argv => {
        const jq = argv[argv.indexOf('--jq') + 1] ?? '';
        const file = jq.includes('patch_base64') && evidenceCalls++ > 0
          ? { ...changedFile(), patch: undefined } : changedFile();
        if (jq.includes('patch_base64')) {
          const patch = file.patch ?? null;
          return response([{ ...file, patch_bytes: patch === null ? 0 : Buffer.byteLength(patch), patch_oversized: false,
            patch_base64: patch === null ? null : Buffer.from(patch).toString('base64') }]);
        }
        return response([{ filename: file.filename, status: file.status, sha: file.sha,
          additions: file.additions, deletions: file.deletions, changes: file.changes }]);
      },
    },
    ...snapshotHandlers({ meta: pullMeta(head) }),
  ]);
  const evidenceResult = await postReview(
    reviewInputV3({ head }), { agent: 'naru-orchestrator' }, { spawn: evidenceDrift.spawn },
  );
  assert.match(evidenceResult.error, /(?:review evidence.*changed|evidence digest mismatch|file batch digest mismatch)/);
  assert.equal(evidenceDrift.calls.some((call) => call.argv.includes('POST')), false);

  const stateHead = '52'.repeat(20);
  let metadataCalls = 0;
  const stateDrift = fakeSpawn(snapshotHandlers({
    metadataReply: () => response(pullMeta(stateHead, BASE, 1, 42, { draft: metadataCalls++ >= 2 })),
  }));
  const stateResult = await postReview(
    reviewInputV3({ head: stateHead }), { agent: 'naru-orchestrator' }, { spawn: stateDrift.spawn },
  );
  assert.match(stateResult.error, /(?:state changed|compact manifest changed)/);
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

test('post tool refuses a prior marker after same-head feedback identity changes', async () => {
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
  assert.equal(sameResult.ok, false);
  assert.match(sameResult.error, /different Naru review/);
  assert.equal(same.calls.some(call => call.argv.includes('POST')), false);

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

test('v4 dedupe binds same-head reviews to base and evidence identities', async () => {
  for (const [seed, changedInput, changedHandlers] of [
    ['35', head => reviewInput({ head, base: 'a1'.repeat(20) }), head => snapshotHandlers({ meta: pullMeta(head, 'a1'.repeat(20)) })],
    ['36', head => {
      const files = [changedFile('src/index.js', '@@ -1 +1 @@\n-before\n+after')];
      return reviewInput({ head, files });
    }, head => {
      const files = [changedFile('src/index.js', '@@ -1 +1 @@\n-before\n+after')];
      return snapshotHandlers({ meta: pullMeta(head), files });
    }],
  ]) {
    const head = seed.repeat(20);
    const initial = fakeSpawn([
      ...snapshotHandlers({ meta: pullMeta(head) }),
      { match: argv => argv.includes('POST'), reply: response({ id: Number.parseInt(seed, 16) }) },
    ]);
    const initialResult = await postReview(reviewInput({ head }), { agent: 'naru-orchestrator' }, { spawn: initial.spawn });
    assert.equal(initialResult.ok, true, initialResult.error);

    const changed = fakeSpawn(changedHandlers(head));
    const changedResult = await postReview(changedInput(head), { agent: 'naru-orchestrator' }, { spawn: changed.spawn });
    assert.equal(changedResult.ok, false);
    assert.match(changedResult.error, /different Naru review/);
    assert.equal(changed.calls.some(call => call.argv.includes('POST')), false);
  }
});

test('v4 dedupe binds provenance digests and canonicalizes declaration ordering', async () => {
  const head = '37'.repeat(20);
  const files = [changedFile('src/index.js'), changedFile('src/other.js')];
  const reviews = [{ id: 71, state: 'COMMENTED', commit_id: head, body: 'prior feedback', user: { login: 'reviewer' } }];
  const issueComments = [{ id: 72, body: 'issue feedback', user: { login: 'reviewer' } }];
  const input = reviewInput({ head, files, reviews, issueComments, comments: [] });
  const identity = {
    owner: 'owner', repo: 'repo', number: 42,
    baseSha: input.reviewResult.snapshot.baseSha,
    headSha: input.reviewResult.snapshot.headSha,
    snapshotId: input.reviewResult.snapshot.id,
    feedbackDigest: input.reviewResult.snapshot.feedbackDigest,
    evidenceDigest: input.reviewResult.snapshot.evidenceDigest,
  };
  input.reviewResult.coverage.fileBatches = files.map(file => ({
    paths: [file.filename],
    batchDigest: digestRawFileBatch(identity, [file.filename], [file]),
  }));
  const initial = fakeSpawn([
    ...snapshotHandlers({ meta: pullMeta(head, BASE, files.length), files, reviews, issueComments }),
    { match: argv => argv.includes('POST'), reply: response({ id: 73 }) },
  ]);
  assert.equal((await postReview(input, { agent: 'naru-orchestrator' }, { spawn: initial.spawn })).ok, true);

  const reordered = structuredClone(input);
  reordered.reviewResult.coverage.fileBatches.reverse();
  reordered.reviewResult.coverage.feedbackPages.reverse();
  const identical = fakeSpawn(snapshotHandlers({ meta: pullMeta(head, BASE, files.length), files, reviews, issueComments }));
  const identicalResult = await postReview(reordered, { agent: 'naru-orchestrator' }, { spawn: identical.spawn });
  assert.equal(identicalResult.ok, true, identicalResult.error);
  assert.equal(identicalResult.data.reason, 'alreadyPosted');
  assert.equal(identical.calls.some(call => call.argv.includes('POST')), false);

  const repartitioned = reviewInput({ head, files, reviews, issueComments, comments: [] });
  const changed = fakeSpawn(snapshotHandlers({ meta: pullMeta(head, BASE, files.length), files, reviews, issueComments }));
  const changedResult = await postReview(repartitioned, { agent: 'naru-orchestrator' }, { spawn: changed.spawn });
  assert.equal(changedResult.ok, false);
  assert.match(changedResult.error, /different Naru review/);
  assert.equal(changed.calls.some(call => call.argv.includes('POST')), false);
});

test('v4 dedupe canonicalizes semantically identical coverage ledger ordering', async () => {
  const head = '38'.repeat(20);
  const files = [changedFile('src/index.js'), changedFile('src/other.js')];
  const input = reviewInput({ head, files, comments: [] });
  const initial = fakeSpawn([
    ...snapshotHandlers({ meta: pullMeta(head, BASE, files.length), files }),
    { match: argv => argv.includes('POST'), reply: response({ id: 74 }) },
  ]);
  assert.equal((await postReview(input, { agent: 'naru-orchestrator' }, { spawn: initial.spawn })).ok, true);

  const reordered = structuredClone(input);
  reordered.reviewResult.coverage.ledger.reverse();
  const repeated = fakeSpawn(snapshotHandlers({ meta: pullMeta(head, BASE, files.length), files }));
  const repeatedResult = await postReview(reordered, { agent: 'naru-orchestrator' }, { spawn: repeated.spawn });
  assert.equal(repeatedResult.ok, true, repeatedResult.error);
  assert.equal(repeatedResult.data.reason, 'alreadyPosted');
  assert.equal(repeated.calls.some(call => call.argv.includes('POST')), false);
});

test('v4 dedupe binds coverage ledger status, evidence, and reason', async () => {
  const head = '39'.repeat(20);
  const files = [changedFile('src/index.js')];
  const input = reviewInput({ head, files, comments: [] });
  input.reviewResult.coverage.ledger[0].note = 'initial review rationale';
  const initial = fakeSpawn([
    ...snapshotHandlers({ meta: pullMeta(head), files }),
    { match: argv => argv.includes('POST'), reply: response({ id: 75 }) },
  ]);
  assert.equal((await postReview(input, { agent: 'naru-orchestrator' }, { spawn: initial.spawn })).ok, true);

  const variants = [
    ledger => { ledger.status = 'blocked'; },
    ledger => { ledger.evidence = 'alternate'; },
    ledger => { ledger.note = 'materially changed rationale'; },
  ];
  for (const mutate of variants) {
    const changedInput = structuredClone(input);
    mutate(changedInput.reviewResult.coverage.ledger[0]);
    if (changedInput.reviewResult.coverage.ledger[0].status !== 'reviewed'
      || changedInput.reviewResult.coverage.ledger[0].evidence !== 'current-patch') {
      changedInput.reviewResult.submissionMode = 'limited';
    }
    const changed = fakeSpawn(snapshotHandlers({ meta: pullMeta(head), files }));
    const result = await postReview(changedInput, { agent: 'naru-orchestrator' }, { spawn: changed.spawn });
    assert.equal(result.ok, false);
    assert.match(result.error, /different Naru review/);
    assert.equal(changed.calls.some(call => call.argv.includes('POST')), false);
  }
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
    'schemaVersion', 'target', 'snapshot', 'coverage', 'submissionMode', 'summary', 'submissionPolicy', 'conclusion', 'findings',
  ]);
  assert.equal(reviewSchema.additionalProperties, false);
  assert.deepEqual(Object.keys(reviewSchema.properties.target.properties), ['owner', 'repo', 'pullNumber', 'number']);
  assert.deepEqual(reviewSchema.properties.target.required, ['owner', 'repo']);
  assert.deepEqual(Object.keys(reviewSchema.properties.snapshot.properties), [
    'id', 'snapshotId', 'baseSha', 'headSha', 'feedbackDigest', 'evidenceDigest', 'warnings',
  ]);
  assert.deepEqual(reviewSchema.properties.snapshot.required, [
    'baseSha', 'headSha', 'feedbackDigest', 'evidenceDigest', 'warnings',
  ]);
  assert.match(reviewSchema.properties.target.description, /exactly one of pullNumber or number/);
  assert.match(reviewSchema.properties.target.properties.pullNumber.description, /exactly one/);
  assert.match(reviewSchema.properties.target.properties.number.description, /exactly one/);
  assert.match(reviewSchema.properties.snapshot.description, /exactly one of id or snapshotId/);
  assert.match(reviewSchema.properties.snapshot.properties.id.description, /exactly one/);
  assert.match(reviewSchema.properties.snapshot.properties.snapshotId.description, /exactly one/);
  assert.equal(reviewSchema.properties.target.oneOf, undefined);
  assert.equal(reviewSchema.properties.snapshot.oneOf, undefined);
  assert.deepEqual(reviewSchema.properties.coverage.required, [
    'ledger', 'fileBatches', 'feedbackPages', 'feedbackAcknowledged', 'feedbackDigest',
  ]);
  assert.deepEqual(reviewSchema.properties.coverage.properties.ledger.items.required, ['path', 'status', 'evidence']);
  assert.deepEqual(reviewSchema.properties.coverage.properties.fileBatches.items.required, ['paths', 'batchDigest']);
  assert.deepEqual(reviewSchema.properties.coverage.properties.feedbackPages.items.required, ['kind', 'page', 'pageDigest']);
  assert.deepEqual(reviewSchema.properties.schemaVersion.enum, [4]);
  assert.deepEqual(reviewSchema.properties.findings.items.required, ['body', 'priority', 'severity', 'confidence']);
  assert.match(reviewSchema.properties.findings.description, /path-level/);
  assert.match(reviewSchema.properties.submissionPolicy.description, /current-message authorization/);
  assert.match(reviewSchema.properties.submissionPolicy.description, /comment-only allows COMMENT/);
  assert.match(reviewSchema.properties.submissionMode.description, /derived only from the current user request/);
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

test('honest non-material limitations in the bounded summary do not imply incomplete file coverage', async () => {
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
  input.reviewResult.summary = '## Review limitations\n\n- Did not run the browser suite\n- Native build not exercised';
  const result = await postReview(input, { agent: 'naru-orchestrator' }, { spawn });
  assert.equal(result.ok, true, result.error);
  assert.match(posted.body, /## Review limitations/);
  assert.match(posted.body, /Did not run the browser suite/);
  assert.match(posted.body, /Native build not exercised/);
});

test('bounded summary changes alter the dedupe digest', async () => {
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
  initial.reviewResult.summary = 'Browser suite not run';
  assert.equal((await postReview(initial, { agent: 'naru-orchestrator' }, { spawn: first.spawn })).ok, true);

  const marker = posted.body.match(/^<!-- naru-review:[^>]+-->/)[0];
  const reviews = [{ id: 302, commit_id: head, body: marker, user: { login: 'viewer' } }];
  const changed = reviewInput({ head, reviews });
  changed.reviewResult.summary = 'Native build not run';
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

test('oversized summary is a correctable pre-POST failure with no I/O', async () => {
  let ioCalls = 0;
  const input = reviewInput({ body: 'x'.repeat(8193) });
  const result = await postReview(input, { agent: 'naru-orchestrator' }, {
    spawn: async () => { ioCalls += 1; },
  });
  assert.match(result.error, /invalid value for summary/);
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
    body: 'Bounded summary',
    findings: [
      { body: 'x'.repeat(30 * 1024), priority: 'P2', severity: 'Medium', confidence: 'High' },
      { body: 'y'.repeat(30 * 1024), priority: 'P2', severity: 'Medium', confidence: 'High' },
    ],
  });
  const result = await postReview(input, { agent: 'naru-orchestrator' }, { spawn });
  assert.match(result.error, /rendered non-inline findings exceed/);
  assert.equal(result.correctable, true);
  assert.equal(calls.some((call) => call.argv.includes('POST')), false);
});

test('initial submissionMode still refuses derived limited coverage', async () => {
  const input = reviewInput({ status: 'incomplete', degraded: true });
  input.reviewResult.submissionMode = 'complete';
  const fake = fakeSpawn(snapshotHandlers());
  const result = await postReview(input, { agent: 'naru-orchestrator' }, { spawn: fake.spawn });
  assert.match(result.error, /submissionMode=limited/);
  assert.equal(fake.calls.some(call => call.argv.includes('POST')), false);
});

test('v4 609-file/37-missing incident manifest stays metadata-only with patch evidence unknown', async () => {
  const head = '91'.repeat(20);
  const files = Array.from({ length: 609 }, (_, index) => index < 37
    ? { ...changedFile(`src/missing-${index}.js`), patch: undefined }
    : changedFile(`src/file-${index}.js`));
  const fake = fakeSpawn(snapshotHandlers({ meta: pullMeta(head, BASE, files.length), files }));
  const result = JSON.parse(await githubReadTool.execute({
    input: { operation: 'pull-manifest', owner: 'owner', repo: 'repo', number: 42 },
  }, { spawn: fake.spawn }));
  assert.equal(result.ok, true, result.error);
  assert.equal(result.data.files.length, 609);
  assert.deepEqual(result.data.evidenceSummary, {
    total: 609, acquired: 0, complete: 0, limited: 0, unknown: 609,
  });
  assert.equal(result.data.recovery.status, 'not-attempted');
  assert.match(result.data.evidenceDigest, /^[0-9a-f]{64}$/);
  assert.equal(Object.hasOwn(result.data.files[0], 'patch'), false);
});

test('v4 posting reacquires multiple finite batches and never uses the monolithic pull snapshot', async () => {
  const head = '90'.repeat(20);
  const files = Array.from({ length: 101 }, (_, index) => changedFile(`src/file-${index}.js`));
  const fake = fakeSpawn([
    ...snapshotHandlers({ meta: pullMeta(head, BASE, files.length), files }),
    { match: argv => argv.includes('POST'), reply: response({ id: 900 }) },
  ]);
  const input = reviewInput({ head, files, comments: [] });
  const result = await postReview(input, { agent: 'naru-orchestrator' }, { spawn: fake.spawn });
  assert.equal(result.ok, true, result.error);
  const fileReads = fake.calls.filter(call => call.argv[3] === 'GET' && has(call.argv, 'pulls/42/files'));
  assert.ok(fileReads.length > 4);
  assert.equal(fileReads.every(call => call.argv.includes('--jq')), true);
  const evidenceReads = fileReads.filter(call => call.argv[call.argv.indexOf('--jq') + 1]?.includes('patch_base64'));
  assert.equal(evidenceReads.length, 14);
  assert.equal(fileReads.length, 22);
  assert.equal(fake.calls.filter(call => call.argv.includes('POST')).length, 1);
});

test('v4 posting acquires a 3000-file, 30-batch review with linear file-list traffic', async () => {
  const head = '89'.repeat(20);
  const files = Array.from({ length: 3000 }, (_, index) => changedFile(`src/scale-${index}.js`));
  const fake = fakeSpawn([
    ...snapshotHandlers({ meta: pullMeta(head, BASE, files.length), files }),
    { match: argv => argv.includes('POST'), reply: response({ id: 899 }) },
  ]);
  const result = await postReview(reviewInput({ head, files, comments: [] }), { agent: 'naru-orchestrator' }, { spawn: fake.spawn });
  assert.equal(result.ok, true, result.error);
  const fileReads = fake.calls.filter(call => call.argv[3] === 'GET' && has(call.argv, 'pulls/42/files'));
  const compactReads = fileReads.filter(call => call.argv[call.argv.indexOf('--jq') + 1]?.includes('map({filename'));
  const evidenceReads = fileReads.filter(call => call.argv[call.argv.indexOf('--jq') + 1]?.includes('patch_base64'));
  assert.equal(compactReads.length, 120);
  assert.equal(evidenceReads.length, 376);
  assert.equal(fileReads.length, 496);
  assert.ok(fileReads.length < 500);
  assert.equal(fake.calls.filter(call => call.argv.includes('POST')).length, 1);
});

test('streamed 3000-file near-limit evidence retains no raw patches across 16-file pages', async () => {
  const head = '8f'.repeat(20);
  const patch = `@@ -1 +1 @@\n ${'x'.repeat(1024 * 1024 - 128)}`;
  const files = Array.from({ length: 3000 }, (_, index) => ({
    ...changedFile(`src/resident-${index}.js`, patch), additions: 0, deletions: 0, changes: 0,
  }));
  const target = { owner: 'owner', repo: 'repo', number: 42 };
  const manifest = await pullManifest(target, {
    spawn: fakeSpawn(snapshotHandlers({ meta: pullMeta(head, BASE, files.length), files })).spawn,
  });
  const declarations = Array.from({ length: 30 }, (_, index) => ({
    paths: files.slice(index * 100, index * 100 + 100).map(file => file.filename),
  }));
  const pageMetrics = [];
  const fake = fakeSpawn(snapshotHandlers({ meta: pullMeta(head, BASE, files.length), files }));
  const acquired = await pullFileBatchesAtManifest(manifest, declarations, {
    spawn: fake.spawn,
    onEvidencePage: metric => pageMetrics.push(metric),
  });
  assert.equal(pageMetrics.length, 188);
  assert.equal(Math.max(...pageMetrics.map(metric => metric.files)), 16);
  assert.ok(Math.max(...pageMetrics.map(metric => metric.inFlightPatchBytes)) < 16 * 1024 * 1024);
  assert.ok(Math.max(...pageMetrics.map(metric => metric.inFlightBase64Bytes)) < 32 * 1024 * 1024);
  assert.equal(pageMetrics.every(metric => metric.retainedPatchBytes === 0), true);
  assert.equal(acquired.batches.length, 30);
  for (let index = 0; index < acquired.batches.length; index += 1) {
    const batch = acquired.batches[index];
    const rawBatch = files.slice(index * 100, index * 100 + 100);
    assert.deepEqual(batch.files.map(file => file.filename), declarations[index].paths);
    assert.equal(batch.files.every(file => file.patch === undefined), true);
    assert.equal(batch.files.filter(file => file.patchEvidence.reason === 'complete').length, 16);
    assert.equal(batch.files.filter(file => file.patchEvidence.reason === 'aggregate-byte-limit').length, 84);
    assert.equal(batch.batchDigest, digestRawFileBatch(manifest, declarations[index].paths, rawBatch));
  }
  const evidenceCalls = fake.calls.filter(call => call.argv.includes('--jq')
    && call.argv[call.argv.indexOf('--jq') + 1].includes('patch_base64'));
  assert.equal(evidenceCalls.length, 188);
});

test('midstream evidence failure stops later pages and prevents POST', async () => {
  const head = '81'.repeat(20);
  const files = Array.from({ length: 33 }, (_, index) => changedFile(`src/midstream-${index}.js`));
  const truncated = { ...response('[{"filename":"partial"}'), stdoutTruncated: true };
  const fake = fakeSpawn([
    { match: argv => argv.includes('--jq')
      && argv[argv.indexOf('--jq') + 1].includes('patch_base64')
      && has(argv, 'per_page=16&page=2'), reply: truncated },
    ...snapshotHandlers({ meta: pullMeta(head, BASE, files.length), files }),
    { match: argv => argv.includes('POST'), reply: response({ id: 810 }) },
  ]);
  const result = await postReview(reviewInput({ head, files, comments: [] }),
    { agent: 'naru-orchestrator' }, { spawn: fake.spawn });
  assert.equal(result.ok, false);
  assert.match(result.error, /truncated/);
  assert.equal(fake.calls.some(call => has(call.argv, 'per_page=16&page=3')), false);
  assert.equal(fake.calls.some(call => call.argv.includes('POST')), false);
});

test('v4 3000-file partition reconciliation uses set membership without repeated array scans', async () => {
  const source = await readFile(new URL('../tools/naru-lib/review.mjs', import.meta.url), 'utf8');
  const start = source.indexOf('async function boundedV4Evidence');
  const end = source.indexOf('const identity = manifestIdentity(first)', start);
  assert.ok(start >= 0 && end > start);
  const reconciliation = source.slice(start, end);
  assert.match(reconciliation, /const manifestPaths = new Set/);
  assert.match(reconciliation, /const declaredPathSet = new Set/);
  assert.match(reconciliation, /manifestPaths\.has\(path\)/);
  assert.match(reconciliation, /declaredPathSet\.has\(path\)/);
  assert.doesNotMatch(reconciliation, /\.includes\(/);
});

test('v4 posting reconstructs scattered declared batches from one ordered evidence acquisition', async () => {
  const head = '8a'.repeat(20);
  const files = Array.from({ length: 33 }, (_, index) => changedFile(`src/scattered-${index}.js`));
  const input = reviewInput({ head, files, comments: [] });
  const identity = {
    owner: 'owner', repo: 'repo', number: 42,
    baseSha: input.reviewResult.snapshot.baseSha, headSha: head,
    snapshotId: input.reviewResult.snapshot.id,
    feedbackDigest: input.reviewResult.snapshot.feedbackDigest,
    evidenceDigest: input.reviewResult.snapshot.evidenceDigest,
  };
  const groups = [files.filter((_, index) => index % 2 === 1), files.filter((_, index) => index % 2 === 0)];
  input.reviewResult.coverage.fileBatches = groups.map(group => {
    const paths = group.map(file => file.filename);
    return { paths, batchDigest: digestRawFileBatch(identity, paths, group) };
  });
  const fake = fakeSpawn([
    ...snapshotHandlers({ meta: pullMeta(head, BASE, files.length), files }),
    { match: argv => argv.includes('POST'), reply: response({ id: 898 }) },
  ]);
  const result = await postReview(input, { agent: 'naru-orchestrator' }, { spawn: fake.spawn });
  assert.equal(result.ok, true, result.error);
  const evidenceReads = fake.calls.filter(call => call.argv.includes('--jq')
    && call.argv[call.argv.indexOf('--jq') + 1].includes('patch_base64'));
  assert.equal(evidenceReads.length, 6);
});

test('internal v4 evidence reapplies the 16 MiB aggregate limit per declared batch', async () => {
  const head = '8b'.repeat(20);
  const files = Array.from({ length: 17 }, (_, index) => ({
    ...changedFile(`src/aggregate-${index}.js`, `@@ -1 +1 @@\n ${'x'.repeat(1024 * 1024 - 128)}`),
    additions: 0, deletions: 0, changes: 0,
  }));
  const input = reviewInput({ head, files, comments: [] });
  input.reviewResult.coverage.ledger[16] = {
    path: files[16].filename, status: 'blocked', evidence: 'none', note: 'aggregate patch evidence limit',
  };
  input.reviewResult.submissionMode = 'limited';
  const fake = fakeSpawn([
    ...snapshotHandlers({ meta: pullMeta(head, BASE, files.length), files }),
    { match: argv => argv.includes('POST'), reply: response({ id: 897 }) },
  ]);
  const result = await postReview(input, { agent: 'naru-orchestrator' }, { spawn: fake.spawn });
  assert.equal(result.ok, true, result.error);
  assert.equal(result.data.evidencePosture, 'limited');
  assert.match(result.data.limitations.join('\n'), /aggregate patch evidence limit/);
});

test('line-map parsing accepts the exact 1024-entry boundary and stops at boundary plus one', async () => {
  const head = 'a4'.repeat(20);
  const files = [denseContextFile('src/exact-lines.js', 512), denseContextFile('src/over-lines.js', 2048)];
  const target = { owner: 'owner', repo: 'repo', number: 42 };
  const manifest = await pullManifest(target, {
    spawn: fakeSpawn(snapshotHandlers({ meta: pullMeta(head, BASE, files.length), files })).spawn,
  });
  const paths = files.map(file => file.filename);
  const metrics = [];
  const batch = await pullFilesAtHead({ ...target, baseSha: manifest.baseSha, headSha: manifest.headSha,
    snapshotId: manifest.snapshotId, feedbackDigest: manifest.feedbackDigest,
    evidenceDigest: manifest.evidenceDigest, paths }, {
    spawn: fakeSpawn(snapshotHandlers({ meta: pullMeta(head, BASE, files.length), files })).spawn,
    onEvidencePage: metric => metrics.push(metric),
  });
  assert.equal(batch.files[0].patchEvidence.reason, 'complete');
  assert.equal(batch.files[0].lineMap.left.length + batch.files[0].lineMap.right.length, 1024);
  assert.equal(batch.files[1].patchEvidence.reason, 'per-file-line-map-limit');
  assert.deepEqual(batch.files[1].lineMap, { left: [], right: [], hunks: [] });
  assert.equal(batch.files[1].patch, undefined);
  assert.equal(metrics.length, 1);
  assert.equal(metrics[0].visitedPatchLines, 513 + 514);
  assert.equal(metrics[0].retainedLineMapEntries, 1024);
  assert.equal(metrics[0].retainedLineMapHunkObjects, 0);
  assert.equal(batch.batchDigest, digestRawFileBatch(manifest, paths, files));

  const source = await readFile(new URL('../tools/naru-lib/github.mjs', import.meta.url), 'utf8');
  const parser = source.slice(source.indexOf('function assessPatch'), source.indexOf('function summarizeFile'));
  assert.doesNotMatch(parser, /patch\.split\(/);
});

test('the 16384-entry batch ceiling follows requested order with public/internal digest parity', async () => {
  const head = 'a5'.repeat(20);
  const files = Array.from({ length: 17 }, (_, index) => denseContextFile(`src/batch-lines-${index}.js`, 512));
  const paths = files.map(file => file.filename).reverse();
  const target = { owner: 'owner', repo: 'repo', number: 42 };
  const manifest = await pullManifest(target, {
    spawn: fakeSpawn(snapshotHandlers({ meta: pullMeta(head, BASE, files.length), files })).spawn,
  });
  const publicMetrics = [];
  const publicBatch = await pullFilesAtHead({ ...target, baseSha: manifest.baseSha, headSha: manifest.headSha,
    snapshotId: manifest.snapshotId, feedbackDigest: manifest.feedbackDigest,
    evidenceDigest: manifest.evidenceDigest, paths }, {
    spawn: fakeSpawn(snapshotHandlers({ meta: pullMeta(head, BASE, files.length), files })).spawn,
    onEvidencePage: metric => publicMetrics.push(metric),
  });
  const internalMetrics = [];
  const internal = await pullFileBatchesAtManifest(manifest, [{ paths }], {
    spawn: fakeSpawn(snapshotHandlers({ meta: pullMeta(head, BASE, files.length), files })).spawn,
    onEvidencePage: metric => internalMetrics.push(metric),
  });
  assert.equal(publicBatch.batchDigest, internal.batches[0].batchDigest);
  assert.deepEqual(
    publicBatch.files.map(({ patch: _patch, ...file }) => file),
    internal.batches[0].files.map(({ patch: _patch, ...file }) => file),
  );
  assert.equal(publicBatch.files.slice(0, 16).every(file => file.patchEvidence.reason === 'complete'), true);
  assert.equal(publicBatch.files.slice(0, 16).reduce((total, file) => total
    + file.lineMap.left.length + file.lineMap.right.length, 0), 16_384);
  assert.equal(publicBatch.files[16].filename, paths[16]);
  assert.equal(publicBatch.files[16].patchEvidence.reason, 'batch-line-map-limit');
  assert.deepEqual(publicBatch.files[16].lineMap, { left: [], right: [], hunks: [] });
  assert.equal(publicBatch.files[16].patch, undefined);
  assert.equal(publicMetrics.every(metric => metric.retainedLineMapHunkObjects === 0), true);
  assert.equal(internalMetrics.every(metric => metric.retainedLineMapHunkObjects === 0), true);
  assert.equal(publicMetrics.at(-1).retainedLineMapEntries, 17 * 1024);
  assert.equal(internalMetrics.at(-1).retainedLineMapEntries, 17 * 1024);
});

test('3000 dense files retain only capped flat numeric line entries and zero hunk objects', async () => {
  const head = 'a6'.repeat(20);
  const patchFile = denseContextFile('unused', 512);
  const files = Array.from({ length: 3000 }, (_, index) => ({
    ...patchFile,
    filename: `src/dense-scale-${index}.js`,
  }));
  const target = { owner: 'owner', repo: 'repo', number: 42 };
  const manifest = await pullManifest(target, {
    spawn: fakeSpawn(snapshotHandlers({ meta: pullMeta(head, BASE, files.length), files })).spawn,
  });
  const declarations = Array.from({ length: 30 }, (_, index) => ({
    paths: files.slice(index * 100, index * 100 + 100).map(file => file.filename),
  }));
  const metrics = [];
  const acquired = await pullFileBatchesAtManifest(manifest, declarations, {
    spawn: fakeSpawn(snapshotHandlers({ meta: pullMeta(head, BASE, files.length), files })).spawn,
    onEvidencePage: metric => metrics.push(metric),
  });
  assert.equal(metrics.length, 188);
  assert.equal(metrics.every(metric => metric.retainedPatchBytes === 0), true);
  assert.equal(metrics.every(metric => metric.retainedBase64Bytes === 0), true);
  assert.equal(metrics.every(metric => metric.retainedLineMapHunkObjects === 0), true);
  assert.equal(metrics.at(-1).retainedLineMapEntries, 3000 * 1024);
  assert.ok(Math.max(...metrics.map(metric => metric.retainedLineMapEntries)) <= 3000 * 1024);
  assert.ok(Math.max(...metrics.map(metric => metric.visitedPatchLines)) <= 16 * 513);
  for (const batch of acquired.batches) {
    assert.equal(batch.files.slice(0, 16).every(file => file.patchEvidence.reason === 'complete'), true);
    assert.equal(batch.files.slice(16).every(file => file.patchEvidence.reason === 'batch-line-map-limit'), true);
    assert.equal(batch.files.reduce((total, file) => total
      + file.lineMap.left.length + file.lineMap.right.length, 0), 16_384);
    assert.equal(batch.files.every(file => file.patch === undefined && file.lineMap.hunks.length === 0), true);
  }
  const source = await readFile(new URL('../tools/naru-lib/github.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /SUMMARY_LINE_MAP_HUNKS/);
});

test('complete-mode formal posting refuses line-map-limited evidence before POST', async () => {
  const head = 'a7'.repeat(20);
  const files = [denseContextFile('src/formal-lines.js', 2048)];
  const input = reviewInput({ head, files, comments: [] });
  const fake = fakeSpawn([
    ...snapshotHandlers({ meta: pullMeta(head, BASE, files.length), files }),
    { match: argv => argv.includes('POST'), reply: response({ id: 1001 }) },
  ]);
  const result = await postReview(input, { agent: 'naru-orchestrator' }, { spawn: fake.spawn });
  assert.match(result.error, /submissionMode=limited/);
  assert.equal(result.postAttempted, false);
  assert.equal(fake.calls.some(call => call.argv.includes('POST')), false);
});

test('v4 pull-files batches are exact-head, safe, distinct, bounded, and inventory-bound', async () => {
  const head = '92'.repeat(20);
  const files = [changedFile('src/a.js'), changedFile('src/b.js')];
  const identity = fixtureIdentity(head, files);
  const good = fakeSpawn(snapshotHandlers({ meta: pullMeta(head, BASE, 2), files }));
  const result = JSON.parse(await githubReadTool.execute({ input: {
    operation: 'pull-files', owner: 'owner', repo: 'repo', number: 42, ...identity, paths: ['src/b.js'],
  } }, { spawn: good.spawn }));
  assert.deepEqual(result.data.files.map(file => file.filename), ['src/b.js']);
  const selectedCall = good.calls.find(call => call.argv.includes('--jq') && call.argv[call.argv.indexOf('--jq') + 1].includes('.filename as $filename'));
  assert.ok(selectedCall);
  const selectedJq = selectedCall.argv[selectedCall.argv.indexOf('--jq') + 1];
  assert.match(selectedJq, /"src\/b\.js"/);
  assert.doesNotMatch(selectedJq, /"src\/a\.js"/);

  for (const [paths, expected] of [
    [['src/a.js', 'src/a.js'], /duplicate/],
    [['src/unknown.js'], /not members/],
    [['../unsafe'], /safe relative/],
  ]) {
    const fake = fakeSpawn(snapshotHandlers({ meta: pullMeta(head, BASE, 2), files }));
    const parsed = JSON.parse(await githubReadTool.execute({ input: {
      operation: 'pull-files', owner: 'owner', repo: 'repo', number: 42, ...identity, paths,
    } }, { spawn: fake.spawn }));
    assert.match(parsed.error, expected);
  }
  const drift = fakeSpawn(snapshotHandlers({ meta: pullMeta('93'.repeat(20), BASE, 2), files }));
  assert.match(JSON.parse(await githubReadTool.execute({ input: {
    operation: 'pull-files', owner: 'owner', repo: 'repo', number: 42, ...identity, paths: ['src/a.js'],
  } }, { spawn: drift.spawn })).error, /manifest identity mismatch/);
  const tooMany = Array.from({ length: 101 }, (_, index) => `src/${index}.js`);
  assert.match(JSON.parse(await githubReadTool.execute({ input: {
    operation: 'pull-files', owner: 'owner', repo: 'repo', number: 42, ...identity, paths: tooMany,
  } })).error, /1-100/);
});

test('internal one-pass evidence produces the same declared batch digest as public pull-files', async () => {
  const head = '8c'.repeat(20);
  const files = Array.from({ length: 21 }, (_, index) => changedFile(`src/equivalent-${index}.js`));
  const target = { owner: 'owner', repo: 'repo', number: 42 };
  const manifestFake = fakeSpawn(snapshotHandlers({ meta: pullMeta(head, BASE, files.length), files }));
  const manifest = await pullManifest(target, { spawn: manifestFake.spawn });
  const paths = ['src/equivalent-20.js', 'src/equivalent-0.js', 'src/equivalent-11.js'];
  const publicFake = fakeSpawn(snapshotHandlers({ meta: pullMeta(head, BASE, files.length), files }));
  const publicBatch = await pullFilesAtHead({
    ...target, baseSha: manifest.baseSha, headSha: manifest.headSha, snapshotId: manifest.snapshotId,
    feedbackDigest: manifest.feedbackDigest, evidenceDigest: manifest.evidenceDigest, paths,
  }, { spawn: publicFake.spawn });
  const internalFake = fakeSpawn(snapshotHandlers({ meta: pullMeta(head, BASE, files.length), files }));
  const internal = await pullFileBatchesAtManifest(manifest, [{ paths }], { spawn: internalFake.spawn });
  assert.equal(internal.batches[0].batchDigest, publicBatch.batchDigest);
  assert.deepEqual(
    internal.batches[0].files.map(({ patch: _patch, ...file }) => file),
    publicBatch.files.map(({ patch: _patch, ...file }) => file),
  );
});

test('public pull-files bounds 100 near-limit paths into fixed 16-file evidence pages', async () => {
  const head = '8d'.repeat(20);
  const patch = `@@ -1 +1 @@\n ${'x'.repeat(1024 * 1024 - 128)}`;
  const files = Array.from({ length: 100 }, (_, index) => ({
    ...changedFile(`src/bounded-${index}.js`, patch), additions: 0, deletions: 0, changes: 0,
  }));
  const identity = fixtureIdentity(head, files);
  const fake = fakeSpawn(snapshotHandlers({ meta: pullMeta(head, BASE, files.length), files }));
  const batch = await pullFilesAtHead({ owner: 'owner', repo: 'repo', number: 42, ...identity,
    paths: files.map(file => file.filename) }, { spawn: fake.spawn });
  assert.equal(batch.files.length, 100);
  assert.equal(batch.files.filter(file => file.patchEvidence.reason === 'complete').length, 16);
  assert.equal(batch.files.filter(file => file.patchEvidence.reason === 'aggregate-byte-limit').length, 84);
  const selectedCalls = fake.calls.filter(call => call.argv.includes('--jq')
    && call.argv[call.argv.indexOf('--jq') + 1].includes('.filename as $filename'));
  assert.equal(selectedCalls.length, 7);
  assert.equal(selectedCalls.every(call => has(call.argv, 'per_page=16')), true);
  assert.equal(selectedCalls.every(call => !call.argv.includes('--slurp')), true);
});

test('reversed 17-file near-limit batch has identical public/internal aggregate assignment and digest', async () => {
  const head = '8e'.repeat(20);
  const patch = `@@ -1 +1 @@\n ${'x'.repeat(1024 * 1024 - 128)}`;
  const files = Array.from({ length: 17 }, (_, index) => ({
    ...changedFile(`src/reversed-${index}.js`, patch), additions: 0, deletions: 0, changes: 0,
  }));
  const paths = files.map(file => file.filename).reverse();
  const target = { owner: 'owner', repo: 'repo', number: 42 };
  const manifestFake = fakeSpawn(snapshotHandlers({ meta: pullMeta(head, BASE, files.length), files }));
  const manifest = await pullManifest(target, { spawn: manifestFake.spawn });
  const publicFake = fakeSpawn(snapshotHandlers({ meta: pullMeta(head, BASE, files.length), files }));
  const publicBatch = await pullFilesAtHead({ ...target, baseSha: manifest.baseSha, headSha: manifest.headSha,
    snapshotId: manifest.snapshotId, feedbackDigest: manifest.feedbackDigest, evidenceDigest: manifest.evidenceDigest, paths },
  { spawn: publicFake.spawn });
  const internalFake = fakeSpawn(snapshotHandlers({ meta: pullMeta(head, BASE, files.length), files }));
  const internal = await pullFileBatchesAtManifest(manifest, [{ paths }], { spawn: internalFake.spawn });
  assert.equal(publicBatch.batchDigest, internal.batches[0].batchDigest);
  assert.deepEqual(
    publicBatch.files.map(({ patch: _patch, ...file }) => file),
    internal.batches[0].files.map(({ patch: _patch, ...file }) => file),
  );
  assert.deepEqual(publicBatch.files.map(file => file.filename), paths);
  assert.equal(publicBatch.files.at(-1).filename, 'src/reversed-0.js');
  assert.equal(publicBatch.files.at(-1).patchEvidence.reason, 'aggregate-byte-limit');
  assert.equal(publicBatch.files.slice(0, -1).every(file => file.patchEvidence.reason === 'complete'), true);
});

test('public pull-files rejects selected immutable metadata mismatches', async () => {
  const head = '8f'.repeat(20);
  const files = [changedFile('src/metadata.js')];
  const identity = fixtureIdentity(head, files);
  const patch = files[0].patch;
  const mismatch = {
    ...files[0], sha: 'd'.repeat(40), patch_bytes: Buffer.byteLength(patch), patch_oversized: false,
    patch_base64: Buffer.from(patch).toString('base64'),
  };
  const fake = fakeSpawn([
    { match: argv => argv.includes('--jq') && argv[argv.indexOf('--jq') + 1].includes('.filename as $filename'),
      reply: response([mismatch]) },
    ...snapshotHandlers({ meta: pullMeta(head), files }),
  ]);
  await assert.rejects(pullFilesAtHead({ owner: 'owner', repo: 'repo', number: 42, ...identity,
    paths: ['src/metadata.js'] }, { spawn: fake.spawn }), /metadata changed/);
});

test('v4 pull-feedback reads one advertised page with manifest-bound metadata and body digest', async () => {
  const head = '94'.repeat(20);
  const files = [changedFile()];
  const reviews = Array.from({ length: 101 }, (_, index) => ({
    id: index + 1,
    state: 'COMMENTED',
    commit_id: head,
    body: `review ${index + 1}`,
    user: { login: 'reviewer' },
    submitted_at: `2026-01-01T00:${String(index).padStart(2, '0')}:00Z`,
    html_url: `https://github.com/owner/repo/pull/42#pullrequestreview-${index + 1}`,
  }));
  const identity = fixtureIdentity(head, files, { reviews });
  const fake = fakeSpawn([
    {
      match: argv => argv[3] === 'GET' && has(argv, 'pulls/42/reviews?per_page=100&page=2'),
      reply: response([reviews[100]]),
    },
    ...snapshotHandlers({ meta: pullMeta(head), files, reviews }),
  ]);
  const result = JSON.parse(await githubReadTool.execute({ input: {
    operation: 'pull-feedback', owner: 'owner', repo: 'repo', number: 42,
    ...identity, kind: 'reviews', page: 2,
  } }, { spawn: fake.spawn }));
  assert.equal(result.ok, true, result.error);
  assert.equal(result.data.pages, 2);
  assert.equal(result.data.items.length, 1);
  assert.equal(result.data.items[0].body, 'review 101');
  assert.match(result.data.pageDigest, /^[0-9a-f]{64}$/);
  const pageCall = fake.calls.find(call => has(call.argv, 'pulls/42/reviews?per_page=100&page=2'));
  assert.ok(pageCall);
  assert.equal(pageCall.argv.includes('--paginate'), false);
  assert.ok(pageCall.argv.includes('--jq'));
});

test('compact manifest excludes huge patches at the gh boundary and shares full-snapshot identity digests', async () => {
  const head = '9d'.repeat(20);
  const huge = `@@ -1,1 +1,1 @@\n-old\n+${'x'.repeat(2 * 1024 * 1024)}`;
  const files = [{ ...changedFile('src/huge.js', huge), additions: 1, deletions: 1, changes: 2 }];
  const manifestFake = fakeSpawn(snapshotHandlers({ meta: pullMeta(head), files }));
  const manifestResult = JSON.parse(await githubReadTool.execute({ input: {
    operation: 'pull-manifest', owner: 'owner', repo: 'repo', number: 42,
  } }, { spawn: manifestFake.spawn }));
  assert.equal(manifestResult.ok, true, manifestResult.error);
  assert.equal(JSON.stringify(manifestResult).includes('x'.repeat(1024)), false);
  const projectedCalls = manifestFake.calls.filter(call => call.argv.includes('--jq'));
  assert.equal(projectedCalls.some(call => call.argv.includes('--slurp') || call.argv.includes('--template')), false);
  const fileProjection = projectedCalls.find(call => has(call.argv, 'pulls/42/files'));
  assert.ok(fileProjection);
  assert.doesNotMatch(fileProjection.argv[fileProjection.argv.indexOf('--jq') + 1], /patch/);
  for (const call of projectedCalls.filter(item => !has(item.argv, 'pulls/42/files'))) {
    assert.doesNotMatch(call.argv[call.argv.indexOf('--jq') + 1], /body/);
  }

  const fullFake = fakeSpawn(snapshotHandlers({ meta: pullMeta(head), files }));
  const snapshot = await pullSnapshot({ owner: 'owner', repo: 'repo', number: 42 }, { spawn: fullFake.spawn });
  assert.equal(manifestResult.data.snapshotId, snapshot.snapshotId);
  assert.equal(manifestResult.data.feedbackDigest, snapshot.feedbackDigest);
  assert.equal(manifestResult.data.evidenceDigest, snapshot.evidenceDigest);
});

test('compact pagination preserves manifest order while batches return requested order only', async () => {
  const head = '9e'.repeat(20);
  const files = Array.from({ length: 101 }, (_, index) => changedFile(`src/file-${index}.js`));
  const identity = fixtureIdentity(head, files);
  const handlers = snapshotHandlers({ meta: pullMeta(head, BASE, files.length), files });
  const manifestFake = fakeSpawn(handlers);
  const manifest = JSON.parse(await githubReadTool.execute({ input: {
    operation: 'pull-manifest', owner: 'owner', repo: 'repo', number: 42,
  } }, { spawn: manifestFake.spawn }));
  assert.equal(manifest.ok, true, manifest.error);
  assert.deepEqual(manifest.data.files.map(file => file.path), files.map(file => file.filename));
  const manifestFileCalls = manifestFake.calls.filter(call => call.argv.includes('--jq') && has(call.argv, 'pulls/42/files'));
  assert.deepEqual(manifestFileCalls.map(call => call.argv.find(arg => arg.includes('pulls/42/files?'))), [
    'repos/owner/repo/pulls/42/files?per_page=100&page=1',
    'repos/owner/repo/pulls/42/files?per_page=100&page=2',
  ]);
  assert.equal(manifestFake.calls.some(call => call.argv.includes('--jq') && call.argv.includes('--slurp')), false);

  const batchFake = fakeSpawn(handlers);
  const batch = JSON.parse(await githubReadTool.execute({ input: {
    operation: 'pull-files', owner: 'owner', repo: 'repo', number: 42,
    ...identity, paths: ['src/file-100.js', 'src/file-0.js'],
  } }, { spawn: batchFake.spawn }));
  assert.equal(batch.ok, true, batch.error);
  assert.deepEqual(batch.data.files.map(file => file.filename), ['src/file-100.js', 'src/file-0.js']);
  const selectedCalls = batchFake.calls.filter(call => call.argv.includes('--jq')
    && call.argv[call.argv.indexOf('--jq') + 1].includes('.filename as $filename'));
  assert.deepEqual(selectedCalls.map(call => call.argv.find(arg => arg.includes('pulls/42/files?'))),
    Array.from({ length: 7 }, (_, index) => `repos/owner/repo/pulls/42/files?per_page=16&page=${index + 1}`));
});

test('multi-page selected projections reject missing and duplicate response membership', async () => {
  const head = 'a2'.repeat(20);
  const files = Array.from({ length: 101 }, (_, index) => changedFile(`src/member-${index}.js`));
  const identity = fixtureIdentity(head, files);
  const selectedProjection = argv => argv.includes('--jq')
    && argv[argv.indexOf('--jq') + 1].includes('.filename as $filename');

  const missing = fakeSpawn([
    { match: selectedProjection, reply: response([]) },
    ...snapshotHandlers({ meta: pullMeta(head, BASE, files.length), files }),
  ]);
  const missingResult = JSON.parse(await githubReadTool.execute({ input: {
    operation: 'pull-files', owner: 'owner', repo: 'repo', number: 42,
    ...identity, paths: ['src/member-100.js'],
  } }, { spawn: missing.spawn }));
  assert.match(missingResult.error, /omitted requested paths/);

  const duplicatePatch = files[100].patch;
  const duplicateProjection = {
    ...files[100], patch_bytes: Buffer.byteLength(duplicatePatch), patch_oversized: false,
    patch_base64: Buffer.from(duplicatePatch).toString('base64'),
  };
  const duplicate = fakeSpawn([
    { match: selectedProjection, reply: response([duplicateProjection]) },
    ...snapshotHandlers({ meta: pullMeta(head, BASE, files.length), files }),
  ]);
  const duplicateResult = JSON.parse(await githubReadTool.execute({ input: {
    operation: 'pull-files', owner: 'owner', repo: 'repo', number: 42,
    ...identity, paths: ['src/member-100.js'],
  } }, { spawn: duplicate.spawn }));
  assert.match(duplicateResult.error, /duplicated path/);
});

test('selected-file jq embeds validated paths only as a JSON value', async () => {
  const head = '9f'.repeat(20);
  const path = 'src/a") | error("boom.js';
  assert.equal(validate.isSafeRelativePath(path), true);
  const files = [changedFile(path)];
  const identity = fixtureIdentity(head, files);
  const fake = fakeSpawn(snapshotHandlers({ meta: pullMeta(head), files }));
  const result = JSON.parse(await githubReadTool.execute({ input: {
    operation: 'pull-files', owner: 'owner', repo: 'repo', number: 42, ...identity, paths: [path],
  } }, { spawn: fake.spawn }));
  assert.equal(result.ok, true, result.error);
  const selectedCall = fake.calls.find(call => call.argv.includes('--jq') && call.argv[call.argv.indexOf('--jq') + 1].includes('.filename as $filename'));
  const jq = selectedCall.argv[selectedCall.argv.indexOf('--jq') + 1];
  const encoded = jq.match(/\$filename \| (.+) \| index\(\$filename\)/)[1];
  assert.deepEqual(JSON.parse(encoded), [path]);
  assert.equal(selectedCall.argv.includes('--paginate'), false);
  assert.equal(selectedCall.argv.includes('--slurp'), false);
  assert.ok(has(selectedCall.argv, 'pulls/42/files?per_page=16&page=1'));
});

test('projected compact file pagination enforces the 3000-file page ceiling', async () => {
  const head = 'a1'.repeat(20);
  const files = Array.from({ length: 3000 }, (_, index) => changedFile(`src/ceiling-${index}.js`));
  const fake = fakeSpawn(snapshotHandlers({ meta: pullMeta(head, BASE, 3001), files }));
  const result = JSON.parse(await githubReadTool.execute({ input: {
    operation: 'pull-manifest', owner: 'owner', repo: 'repo', number: 42,
  } }, { spawn: fake.spawn }));
  assert.equal(result.ok, true, result.error);
  assert.equal(result.data.reviewability.inventoryComplete, false);
  const fileCalls = fake.calls.filter(call => call.argv.includes('--jq') && has(call.argv, 'pulls/42/files?'));
  assert.equal(fileCalls.length, 30);
  assert.ok(has(fileCalls.at(-1).argv, 'pulls/42/files?per_page=100&page=30'));
  assert.equal(fake.calls.some(call => has(call.argv, 'pulls/42/files?per_page=100&page=31')), false);
});

test('compact manifest fails closed when changed_files metadata is missing or invalid', async () => {
  const head = 'a3'.repeat(20);
  const smallFiles = [changedFile('src/a.js'), changedFile('src/b.js')];
  for (const changedFiles of [undefined, -1, 1.5]) {
    const meta = { ...pullMeta(head, BASE, smallFiles.length), changed_files: changedFiles };
    const fake = fakeSpawn(snapshotHandlers({ meta, files: smallFiles }));
    const result = JSON.parse(await githubReadTool.execute({ input: {
      operation: 'pull-manifest', owner: 'owner', repo: 'repo', number: 42,
    } }, { spawn: fake.spawn }));
    assert.equal(result.ok, true, result.error);
    assert.equal(result.data.reviewability.status, 'unpostable');
    assert.equal(result.data.reviewability.inventoryComplete, false);
    assert.match(result.data.warnings.join('\n'), /inventory integrity is unknown/);
  }

  const validSmall = fakeSpawn(snapshotHandlers({ meta: pullMeta(head, BASE, smallFiles.length), files: smallFiles }));
  const validSmallResult = JSON.parse(await githubReadTool.execute({ input: {
    operation: 'pull-manifest', owner: 'owner', repo: 'repo', number: 42,
  } }, { spawn: validSmall.spawn }));
  assert.equal(validSmallResult.data.reviewability.inventoryComplete, true);

  const ceilingFiles = Array.from({ length: 3000 }, (_, index) => changedFile(`src/unknown-${index}.js`));
  const missingMeta = { ...pullMeta(head, BASE, 3000), changed_files: undefined };
  const missingCeiling = fakeSpawn(snapshotHandlers({ meta: missingMeta, files: ceilingFiles }));
  const missingCeilingResult = JSON.parse(await githubReadTool.execute({ input: {
    operation: 'pull-manifest', owner: 'owner', repo: 'repo', number: 42,
  } }, { spawn: missingCeiling.spawn }));
  assert.equal(missingCeilingResult.data.fetchedFiles, 3000);
  assert.equal(missingCeilingResult.data.reviewability.status, 'unpostable');
  assert.equal(missingCeilingResult.data.reviewability.inventoryComplete, false);
  assert.equal(missingCeiling.calls.some(call => has(call.argv, 'pulls/42/files?per_page=100&page=31')), false);

  const validCeiling = fakeSpawn(snapshotHandlers({ meta: pullMeta(head, BASE, 3000), files: ceilingFiles }));
  const validCeilingResult = JSON.parse(await githubReadTool.execute({ input: {
    operation: 'pull-manifest', owner: 'owner', repo: 'repo', number: 42,
  } }, { spawn: validCeiling.spawn }));
  assert.equal(validCeilingResult.data.fetchedFiles, 3000);
  assert.equal(validCeilingResult.data.reviewability.status, 'manifest');
  assert.equal(validCeilingResult.data.reviewability.inventoryComplete, true);
});

test('compact GitHub acquisition reports stdout truncation before JSON parsing', async () => {
  const truncated = {
    ...response('[{"filename":"src/a.js"'),
    stdoutTruncated: true,
  };
  const fake = fakeSpawn([
    { match: argv => argv[3] === 'GET' && has(argv, 'pulls/42/files') && argv.includes('--jq'), reply: truncated },
    ...snapshotHandlers(),
  ]);
  const result = JSON.parse(await githubReadTool.execute({ input: {
    operation: 'pull-manifest', owner: 'owner', repo: 'repo', number: 42,
  } }, { spawn: fake.spawn }));
  assert.match(result.error, /bounded GitHub response was truncated/);
  assert.doesNotMatch(result.error, /non-JSON/);
});

test('v4 ledger and feedback acknowledgement are exact and caller completeness is forbidden', async () => {
  const head = '94'.repeat(20);
  const files = [changedFile('src/a.js'), changedFile('src/b.js')];
  const baseInput = reviewInputV3({ head, files });
  const mismatch = structuredClone(baseInput);
  mismatch.reviewResult.coverage.feedbackDigest = 'f'.repeat(64);
  assert.throws(() => validateReviewPayload(mismatch), /not bound/);
  const asserted = structuredClone(baseInput);
  asserted.reviewResult.coverage.complete = true;
  assert.throws(() => validateReviewPayload(asserted), /unknown fields/);

  const cases = [
    { ledger: [baseInput.reviewResult.coverage.ledger[0]], error: /missing 1/ },
    { ledger: [baseInput.reviewResult.coverage.ledger[0], baseInput.reviewResult.coverage.ledger[0]], error: /duplicate path/ },
    { ledger: [baseInput.reviewResult.coverage.ledger[0], { path: 'src/no.js', status: 'reviewed', evidence: 'current-patch' }], error: /unknown path/ },
  ];
  for (const item of cases) {
    const input = structuredClone(baseInput);
    input.reviewResult.coverage.ledger = item.ledger;
    const fake = fakeSpawn(snapshotHandlers({ meta: pullMeta(head, BASE, 2), files }));
    const result = await postReview(input, { agent: 'naru-orchestrator' }, { spawn: fake.spawn });
    assert.match(result.error, item.error);
    assert.equal(fake.calls.some(call => call.argv.includes('POST')), false);
  }
});

test('legacy v2 and v3 payloads are recognized but cannot create reviews', async () => {
  const v3 = {
    reviewResult: {
      schemaVersion: 3,
      target: { owner: 'owner', repo: 'repo', pullNumber: 42 },
      snapshot: { id: `naru-snap-${'a'.repeat(64)}`, baseSha: BASE, headSha: HEAD, feedbackDigest: 'd'.repeat(64), complete: true, warnings: [] },
      coverage: { posture: 'complete', limitations: [] },
      body: 'Legacy', submissionPolicy: 'comment-only', conclusion: 'informational', findings: [],
    },
  };
  const v2 = {
    reviewResult: {
      schemaVersion: 2,
      target: { owner: 'owner', repo: 'repo', pullNumber: 42 },
      snapshot: { id: `naru-snap-${'b'.repeat(64)}`, baseSha: BASE, headSha: HEAD, feedbackDigest: 'e'.repeat(64), complete: true, warnings: [] },
      coverage: { complete: true, limitations: [] }, body: 'Legacy', inlineComments: [], skippedInlineComments: [],
    },
  };
  for (const input of [v2, v3]) {
    assert.ok([2, 3].includes(validateReviewPayload(input).schemaVersion));
    let io = 0;
    const result = await postReview(input, { agent: 'naru-orchestrator' }, { spawn: async () => { io += 1; } });
    assert.match(result.error, /schema v2\/v3/);
    assert.equal(result.correctable, true);
    assert.equal(result.postAttempted, false);
    assert.equal(io, 0);
  }
});

test('current-head duplicate blockers are suppressed only from posting and retained for decisions', async () => {
  const finding = { path: 'src/index.js', line: 1, side: 'RIGHT', body: 'Current blocker', priority: 'P1', severity: 'High', confidence: 'High' };
  const cases = [
    { seed: '95', commentHead: 'same', policy: 'approve-if-clear', conclusion: 'clear', event: 'COMMENT', dropped: 1, comments: 0 },
    { seed: '96', commentHead: 'stale', policy: 'approve-if-clear', conclusion: 'clear', event: 'COMMENT', dropped: 0, comments: 1 },
    { seed: '9b', commentHead: 'same', policy: 'request-changes-if-blocked', conclusion: 'blocking', event: 'REQUEST_CHANGES', dropped: 1, comments: 0 },
    { seed: '9c', commentHead: 'same', policy: 'select-state', conclusion: 'blocking', event: 'REQUEST_CHANGES', dropped: 1, comments: 0 },
  ];
  for (const item of cases) {
    const head = item.seed.repeat(20);
    const reviewComments = [{ id: 10, path: finding.path, line: finding.line, side: finding.side, body: finding.body, commit_id: item.commentHead === 'same' ? head : '0'.repeat(40) }];
    let posted;
    const fake = fakeSpawn([
      ...snapshotHandlers({ meta: pullMeta(head), reviewComments }),
      { match: argv => argv.includes('POST'), reply: (_argv, options) => { posted = JSON.parse(options.input); return response({ id: Number.parseInt(item.seed, 16) }); } },
    ]);
    const result = await postReview(reviewInputV3({
      head, reviewComments, submissionPolicy: item.policy, conclusion: item.conclusion, findings: [finding],
    }), { agent: 'naru-orchestrator' }, { spawn: fake.spawn });
    assert.equal(result.ok, true, result.error);
    assert.equal(posted.event, item.event);
    assert.equal(posted.comments.length, item.comments);
    assert.equal(result.data.droppedFindings.length, item.dropped);
    if (item.dropped) {
      assert.deepEqual({
        suppressedFromPosting: result.data.droppedFindings[0].suppressedFromPosting,
        retainedForDecision: result.data.droppedFindings[0].retainedForDecision,
        eligibleBlocker: result.data.droppedFindings[0].eligibleBlocker,
      }, { suppressedFromPosting: true, retainedForDecision: true, eligibleBlocker: true });
    }
  }
});

test('redacted changed paths are unpostable and never reach POST', async () => {
  const head = '97'.repeat(20);
  const files = [{ ...changedFile('src/safe.js'), previous_filename: '.env' }];
  const fake = fakeSpawn(snapshotHandlers({ meta: pullMeta(head), files }));
  const snapshot = await pullSnapshot({ owner: 'owner', repo: 'repo', number: 42 }, { spawn: fake.spawn });
  assert.equal(snapshot.reviewability.status, 'unpostable');
  assert.match(snapshot.reviewability.limitations.join('\n'), /redacted/);

  const postFake = fakeSpawn(snapshotHandlers({ meta: pullMeta(head), files }));
  const result = await postReview(reviewInputV3({ head, files, posture: 'limited' }), { agent: 'naru-orchestrator' }, { spawn: postFake.spawn });
  assert.match(result.error, /unpostable/);
  assert.equal(postFake.calls.some(call => call.argv.includes('POST')), false);
});

test('supersession ambiguous outcomes are terminal for identical and altered follow-ups', async () => {
  const head = '98'.repeat(20);
  const missingFiles = [{ ...changedFile(), patch: undefined }];
  let firstBody;
  const first = fakeSpawn([
    ...snapshotHandlers({ meta: pullMeta(head), files: missingFiles }),
    { match: argv => argv.includes('POST'), reply: (_argv, options) => { firstBody = JSON.parse(options.input).body; return response({ id: 801 }); } },
  ]);
  assert.equal((await postReview(reviewInputV3({ head, files: missingFiles, posture: 'limited' }), { agent: 'naru-orchestrator' }, { spawn: first.spawn })).ok, true);
  const marker = firstBody.match(/^<!-- naru-review:[^>]+-->/)[0];
  const digest = marker.match(/digest=([0-9a-f]{64})/)[1];
  const predecessor = { id: 801, state: 'COMMENTED', commit_id: head, body: marker, user: { login: 'viewer' } };
  let posts = 0;
  const ambiguous = fakeSpawn([
    ...snapshotHandlers({ meta: pullMeta(head), reviews: [predecessor] }),
    { match: argv => argv.includes('POST'), reply: () => { posts += 1; return response('timeout', false); } },
  ]);
  const input = reviewInputV3({ head, reviews: [predecessor] });
  input.reviewResult.supersedes = { reviewId: 801, digest };
  const firstAttempt = await postReview(input, { agent: 'naru-orchestrator' }, { spawn: ambiguous.spawn });
  assert.equal(firstAttempt.outcomeUnknown, true);
  assert.equal(firstAttempt.postAttempted, true);
  const identical = await postReview(input, { agent: 'naru-orchestrator' }, { spawn: ambiguous.spawn });
  assert.equal(identical.outcomeUnknown, true);
  assert.equal(identical.postAttempted, false);
  const altered = structuredClone(input);
  altered.reviewResult.summary = 'Altered superseding review';
  const alteredResult = await postReview(altered, { agent: 'naru-orchestrator' }, { spawn: ambiguous.spawn });
  assert.equal(alteredResult.postAttempted, false);
  assert.match(alteredResult.error, /different Naru review/);
  assert.equal(posts, 1);
});

test('ambiguous supersession recovery finds the expected successor in either marker order', async () => {
  for (const [seed, successorFirst] of [['9d', false], ['9e', true]]) {
    const head = seed.repeat(20);
    const predecessorDigest = seed.repeat(32);
    const predecessor = {
      id: Number.parseInt(seed, 16),
      state: 'COMMENTED',
      commit_id: head,
      body: `<!-- naru-review:owner/repo#42 head=${head} digest=${predecessorDigest} v=4 posture=limited -->`,
      user: { login: 'viewer' },
    };
    let postedBody;
    const dynamicReviews = {
      match: argv => argv[3] === 'GET' && has(argv, 'pulls/42/reviews'),
      reply: (argv) => {
        if (!postedBody) return has(argv, '?per_page=100&page=') ? response([predecessor]) : response([[predecessor]]);
        const successor = {
          id: predecessor.id + 1000,
          state: 'APPROVED',
          commit_id: head,
          body: postedBody,
          user: { login: 'viewer' },
        };
        const items = successorFirst ? [successor, predecessor] : [predecessor, successor];
        return has(argv, '?per_page=100&page=') ? response(items) : response([items]);
      },
    };
    const fake = fakeSpawn([
      dynamicReviews,
      ...snapshotHandlers({ meta: pullMeta(head), reviews: [predecessor] }),
      { match: argv => argv.includes('POST'), reply: (_argv, options) => {
        postedBody = JSON.parse(options.input).body;
        return response('timeout', false);
      } },
    ]);
    const input = reviewInputV3({ head, reviews: [predecessor] });
    input.reviewResult.supersedes = { reviewId: predecessor.id, digest: predecessorDigest };
    const result = await postReview(input, { agent: 'naru-orchestrator' }, { spawn: fake.spawn });
    assert.equal(result.ok, true, result.error);
    assert.equal(result.data.recovered, true);
    assert.equal(result.data.reviewId, predecessor.id + 1000);
    assert.equal(fake.calls.filter(call => call.argv.includes('POST')).length, 1);
  }
});

test('ambiguous supersession recovery stays unknown without one conflict-free expected successor', async () => {
  for (const [seed, recoveryKind] of [['9f', 'missing'], ['a0', 'conflict']]) {
    const head = seed.repeat(20);
    const predecessorDigest = seed.repeat(32);
    const predecessor = {
      id: Number.parseInt(seed, 16),
      state: 'COMMENTED',
      commit_id: head,
      body: `<!-- naru-review:owner/repo#42 head=${head} digest=${predecessorDigest} v=4 posture=limited -->`,
      user: { login: 'viewer' },
    };
    let postedBody;
    const dynamicReviews = {
      match: argv => argv[3] === 'GET' && has(argv, 'pulls/42/reviews'),
      reply: (argv) => {
        if (!postedBody || recoveryKind === 'missing') return has(argv, '?per_page=100&page=') ? response([predecessor]) : response([[predecessor]]);
        const expected = { id: predecessor.id + 1000, state: 'APPROVED', commit_id: head, body: postedBody, user: { login: 'viewer' } };
        const conflicting = {
          id: predecessor.id + 2000,
          state: 'APPROVED',
          commit_id: head,
          body: `<!-- naru-review:owner/repo#42 head=${head} digest=${'f'.repeat(64)} v=4 posture=complete supersedes=${predecessor.id} -->`,
          user: { login: 'viewer' },
        };
        const items = [predecessor, expected, conflicting];
        return has(argv, '?per_page=100&page=') ? response(items) : response([items]);
      },
    };
    const fake = fakeSpawn([
      dynamicReviews,
      ...snapshotHandlers({ meta: pullMeta(head), reviews: [predecessor] }),
      { match: argv => argv.includes('POST'), reply: (_argv, options) => {
        postedBody = JSON.parse(options.input).body;
        return response('timeout', false);
      } },
    ]);
    const input = reviewInputV3({ head, reviews: [predecessor] });
    input.reviewResult.supersedes = { reviewId: predecessor.id, digest: predecessorDigest };
    const result = await postReview(input, { agent: 'naru-orchestrator' }, { spawn: fake.spawn });
    assert.equal(result.outcomeUnknown, true);
    assert.equal(result.postAttempted, true);
    const repeated = await postReview(input, { agent: 'naru-orchestrator' }, { spawn: fake.spawn });
    if (recoveryKind === 'missing') assert.equal(repeated.outcomeUnknown, true);
    assert.equal(repeated.postAttempted, false);
    assert.equal(fake.calls.filter(call => call.argv.includes('POST')).length, 1);
  }
});

test('same-head limited v4 can be superseded once, while legacy predecessors are rejected', async () => {
  const head = '99'.repeat(20);
  const missingFiles = [{ ...changedFile(), patch: undefined }];
  let limitedBody;
  const limited = fakeSpawn([
    ...snapshotHandlers({ meta: pullMeta(head), files: missingFiles }),
    { match: argv => argv.includes('POST'), reply: (_argv, options) => { limitedBody = JSON.parse(options.input).body; return response({ id: 901 }); } },
  ]);
  assert.equal((await postReview(reviewInputV3({ head, files: missingFiles, posture: 'limited' }), { agent: 'naru-orchestrator' }, { spawn: limited.spawn })).ok, true);
  const marker = limitedBody.match(/^<!-- naru-review:[^>]+-->/)[0];
  const digest = marker.match(/digest=([0-9a-f]{64})/)[1];
  const predecessor = { id: 901, state: 'COMMENTED', commit_id: head, body: marker, user: { login: 'viewer' } };
  let completeBody;
  const complete = fakeSpawn([
    ...snapshotHandlers({ meta: pullMeta(head), reviews: [predecessor] }),
    { match: argv => argv.includes('POST'), reply: (_argv, options) => { completeBody = JSON.parse(options.input).body; return response({ id: 902 }); } },
  ]);
  const completeInput = reviewInputV3({ head, reviews: [predecessor] });
  completeInput.reviewResult.supersedes = { reviewId: 901, digest };
  const completeResult = await postReview(completeInput, { agent: 'naru-orchestrator' }, { spawn: complete.spawn });
  assert.equal(completeResult.ok, true, completeResult.error);
  assert.match(completeBody, /v=4 posture=complete supersedes=901/);
  assert.equal(complete.calls.filter(call => call.argv.includes('POST')).length, 1);

  const legacyHead = '9a'.repeat(20);
  const legacyDigest = 'f'.repeat(64);
  const legacy = { id: 903, state: 'COMMENTED', commit_id: legacyHead, body: `<!-- naru-review:owner/repo#42 head=${legacyHead} digest=${legacyDigest} -->`, user: { login: 'viewer' } };
  const rejected = fakeSpawn(snapshotHandlers({ meta: pullMeta(legacyHead), reviews: [legacy] }));
  const rejectedInput = reviewInputV3({ head: legacyHead, reviews: [legacy] });
  rejectedInput.reviewResult.supersedes = { reviewId: 903, digest: legacyDigest };
  const rejectedResult = await postReview(rejectedInput, { agent: 'naru-orchestrator' }, { spawn: rejected.spawn });
  assert.match(rejectedResult.error, /limited v4 COMMENT/);
  assert.equal(rejected.calls.some(call => call.argv.includes('POST')), false);
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
    assert.match(policy, /limited(?: v3| v4| patch)? evidence[\s\S]{0,100}`?COMMENT`?/i);
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
  }
  for (const policy of [userGuide, reviewLane]) {
    assert.match(policy, /(?:schema )?v4[\s\S]{0,100}(?:required|only contract)[\s\S]{0,80}new (?:review )?mutation|only contract[\s\S]{0,80}new review/i);
    assert.match(policy, /(?:historical[\s\S]{0,160}v2\/v3|v2\/v3[\s\S]{0,120}historical)[\s\S]{0,80}compatibility/i);
  }
  for (const policy of [orchestrator, skill]) {
    assert.match(policy, /v2\/v3[\s\S]{0,100}(?:legacy|compatibility)/i);
    assert.match(policy, /v4[\s\S]{0,80}(?:canonical|only contract)/i);
    assert.match(policy, /(?:current-user[\s\S]{0,160}submissionMode|submissionMode[\s\S]{0,200}current user)/i);
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
