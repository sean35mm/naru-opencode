// Validated COMMENT-only PR review posting. This module exposes no caller-
// controlled command, HTTP method, endpoint, environment, or working directory.

import { createHash } from 'node:crypto';
import { run } from './transport.mjs';
import { okEnvelope, errEnvelope } from './output.mjs';
import { fetchAuthenticatedLogin, pullSnapshot } from './github.mjs';
import {
  assertPlainObject,
  validateAllowedKeys,
  isSafeOwner,
  isSafeRepo,
  isPositiveInteger,
  is40HexSha,
  isSafeRelativePath,
  isNonEmptyString,
  isBoolean,
  safeError,
  stripSecrets,
  requireField,
} from './validate.mjs';

const MAX_BODY_LENGTH = 64 * 1024;
const MAX_COMMENT_BODY_LENGTH = 32 * 1024;
const MAX_COMMENTS = 100;
const MAX_WARNINGS = 100;
const MAX_GH_BYTES = 32 * 1024 * 1024;
const PRIORITIES = ['P0', 'P1', 'P2', 'P3'];
const SEVERITIES = ['Critical', 'High', 'Medium', 'Low'];
const CONFIDENCE = ['High', 'Medium', 'Low'];
const SNAPSHOT_ID = /^naru-snap-[0-9a-f]{64}$/;
const DIGEST = /^[0-9a-f]{64}$/;
const POSTING_AGENTS = new Set(['naru-orchestrator']);
const MAX_TRACKED_POST_TARGETS = 128;
const postLocks = new Map();
const postRecords = new Map();

function hash(value) {
  return createHash('sha256').update(value).digest('hex');
}

function isBoundedText(value, max) {
  return typeof value === 'string' && value.length > 0 && value.length <= max && !value.includes('\0');
}

function requireStringArray(value, name, max) {
  if (!Array.isArray(value) || value.length > max) throw new Error(`${name} must be an array with at most ${max} items`);
  for (let index = 0; index < value.length; index += 1) {
    if (!isNonEmptyString(value[index], { max: 4096 })) throw new Error(`${name}[${index}] is invalid`);
  }
  return value;
}

function validateTarget(raw) {
  assertPlainObject(raw, 'reviewResult.target');
  validateAllowedKeys(raw, ['owner', 'repo', 'pullNumber']);
  return {
    owner: requireField(raw, 'owner', isSafeOwner),
    repo: requireField(raw, 'repo', isSafeRepo),
    number: requireField(raw, 'pullNumber', isPositiveInteger),
  };
}

function validateSnapshot(raw) {
  assertPlainObject(raw, 'reviewResult.snapshot');
  validateAllowedKeys(raw, ['id', 'baseSha', 'headSha', 'feedbackDigest', 'complete', 'warnings']);
  return {
    id: requireField(raw, 'id', (value) => typeof value === 'string' && SNAPSHOT_ID.test(value)),
    baseSha: requireField(raw, 'baseSha', is40HexSha),
    headSha: requireField(raw, 'headSha', is40HexSha),
    feedbackDigest: requireField(raw, 'feedbackDigest', (value) => typeof value === 'string' && DIGEST.test(value)),
    complete: requireField(raw, 'complete', isBoolean),
    warnings: requireStringArray(requireField(raw, 'warnings', Array.isArray), 'reviewResult.snapshot.warnings', MAX_WARNINGS),
  };
}

function validateCoverage(raw) {
  assertPlainObject(raw, 'reviewResult.coverage');
  validateAllowedKeys(raw, ['complete', 'limitations']);
  return {
    complete: requireField(raw, 'complete', isBoolean),
    limitations: requireStringArray(
      requireField(raw, 'limitations', Array.isArray),
      'reviewResult.coverage.limitations',
      MAX_WARNINGS,
    ),
  };
}

function validateComment(raw, index) {
  assertPlainObject(raw, `reviewResult.inlineComments[${index}]`);
  validateAllowedKeys(raw, ['path', 'line', 'side', 'body', 'priority', 'severity', 'confidence']);
  const path = requireField(raw, 'path', isSafeRelativePath);
  const line = requireField(raw, 'line', isPositiveInteger);
  const side = requireField(raw, 'side', (value) => value === 'LEFT' || value === 'RIGHT');
  const body = requireField(raw, 'body', (value) => isBoundedText(value, MAX_COMMENT_BODY_LENGTH));
  const priority = requireField(raw, 'priority', (value) => PRIORITIES.includes(value));
  const severity = requireField(raw, 'severity', (value) => SEVERITIES.includes(value));
  const confidence = requireField(raw, 'confidence', (value) => CONFIDENCE.includes(value));
  return { path, line, side, body, priority, severity, confidence };
}

function validateSkippedComment(raw, index) {
  assertPlainObject(raw, `reviewResult.skippedInlineComments[${index}]`);
  validateAllowedKeys(raw, ['path', 'line', 'side', 'reason']);
  return {
    path: requireField(raw, 'path', isSafeRelativePath),
    line: requireField(raw, 'line', isPositiveInteger),
    side: requireField(raw, 'side', (value) => value === 'LEFT' || value === 'RIGHT'),
    reason: requireField(raw, 'reason', (value) => isBoundedText(value, 4096)),
  };
}

export function validateReviewPayload(raw) {
  assertPlainObject(raw, 'input');
  validateAllowedKeys(raw, ['reviewResult']);
  const result = requireField(raw, 'reviewResult', (value) => value !== null && typeof value === 'object');
  assertPlainObject(result, 'reviewResult');
  validateAllowedKeys(result, [
    'schemaVersion',
    'target',
    'snapshot',
    'coverage',
    'body',
    'inlineComments',
    'skippedInlineComments',
  ]);
  if (result.schemaVersion !== 2) throw new Error('reviewResult.schemaVersion must be 2');

  const target = validateTarget(requireField(result, 'target', (value) => value !== null && typeof value === 'object'));
  const snapshot = validateSnapshot(requireField(result, 'snapshot', (value) => value !== null && typeof value === 'object'));
  const coverage = validateCoverage(requireField(result, 'coverage', (value) => value !== null && typeof value === 'object'));
  const body = requireField(result, 'body', (value) => isBoundedText(value, MAX_BODY_LENGTH - 256));
  if (/<!--\s*naru-review:/i.test(body)) throw new Error('reviewResult.body contains a reserved Naru marker');

  const commentsRaw = requireField(result, 'inlineComments', Array.isArray);
  if (commentsRaw.length > MAX_COMMENTS) throw new Error(`inlineComments exceeds ${MAX_COMMENTS}`);
  const inlineComments = commentsRaw.map(validateComment);
  const skippedRaw = requireField(result, 'skippedInlineComments', Array.isArray);
  if (skippedRaw.length > MAX_COMMENTS) throw new Error(`skippedInlineComments exceeds ${MAX_COMMENTS}`);
  const skippedInlineComments = skippedRaw.map(validateSkippedComment);
  return { target, snapshot, coverage, body, inlineComments, skippedInlineComments };
}

function markerDigest(payload, comments) {
  const normalized = comments.map((comment) => ({
    path: comment.path,
    line: comment.line,
    side: comment.side,
    body: comment.body,
  })).sort((a, b) => `${a.path}:${a.side}:${a.line}`.localeCompare(`${b.path}:${b.side}:${b.line}`));
  return hash(JSON.stringify({
    ...payload.target,
    headSha: payload.snapshot.headSha,
    body: payload.body,
    comments: normalized,
  }));
}

function markerTag(payload, digest) {
  const { owner, repo, number } = payload.target;
  return `<!-- naru-review:${owner}/${repo}#${number} head=${payload.snapshot.headSha} digest=${digest} -->`;
}

function extractMarker(body) {
  if (typeof body !== 'string') return null;
  const match = body.match(/<!--\s*naru-review:([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+)#(\d+) head=([0-9a-f]{40}) digest=([0-9a-f]{64})\s*-->/i);
  if (!match) return null;
  return { owner: match[1], repo: match[2], number: Number(match[3]), headSha: match[4], digest: match[5] };
}

function markerOnHead(reviews, target, headSha, actor) {
  for (const review of reviews) {
    const commitId = review.commitId ?? review.commit_id;
    if (commitId !== headSha) continue;
    if (typeof review.author !== 'string' || review.author.toLowerCase() !== actor.toLowerCase()) continue;
    const marker = extractMarker(review.body);
    if (!marker) continue;
    if (
      marker.owner.toLowerCase() === target.owner.toLowerCase() &&
      marker.repo.toLowerCase() === target.repo.toLowerCase() &&
      marker.number === target.number
    ) {
      return { reviewId: review.id, url: review.url ?? review.html_url, ...marker };
    }
  }
  return null;
}

function targetKey(target) {
  return `${target.owner.toLowerCase()}/${target.repo.toLowerCase()}#${target.number}`;
}

async function withPostLock(key, operation) {
  let entry = postLocks.get(key);
  if (!entry) {
    if (postLocks.size >= MAX_TRACKED_POST_TARGETS) {
      throw new Error('too many review post targets are active');
    }
    entry = { tail: Promise.resolve(), queued: 0 };
    postLocks.set(key, entry);
  }

  entry.queued += 1;
  const previous = entry.tail;
  let release;
  const current = new Promise((resolve) => { release = resolve; });
  entry.tail = current;
  await previous;

  try {
    return await operation();
  } finally {
    release();
    entry.queued -= 1;
    if (entry.queued === 0 && entry.tail === current) postLocks.delete(key);
  }
}

function postRecord(key) {
  const record = postRecords.get(key);
  if (!record) return null;
  postRecords.delete(key);
  postRecords.set(key, record);
  return record;
}

function rememberPost(key, record) {
  postRecords.delete(key);
  postRecords.set(key, record);
  while (postRecords.size > MAX_TRACKED_POST_TARGETS) {
    postRecords.delete(postRecords.keys().next().value);
  }
}

function alreadyPosted(reviewId, reviewUrl) {
  return okEnvelope('naru-github-post-review', {
    posted: false,
    reason: 'alreadyPosted',
    reviewId,
    reviewUrl,
  });
}

function recordedPostResult(key, payload, actor, digest) {
  const record = postRecord(key);
  if (!record || record.headSha !== payload.snapshot.headSha) return null;
  if (record.actor !== actor.toLowerCase()) {
    return errEnvelope('naru-github-post-review', 'a review post is already recorded for this head under a different actor; duplicate refused');
  }
  if (record.digest !== digest) {
    return errEnvelope('naru-github-post-review', 'a different Naru review already exists on this head; duplicate refused');
  }
  if (record.status === 'succeeded') return alreadyPosted(record.reviewId, record.reviewUrl);
  return errEnvelope(
    'naru-github-post-review',
    'outcomeUnknown: a prior in-process POST attempt on this head has an unknown outcome; duplicate refused',
  );
}

function validateCurrentComments(comments, snapshot) {
  const files = new Map(snapshot.files.map((file) => [file.filename, file]));
  const valid = [];
  const dropped = [];
  for (const comment of comments) {
    const file = files.get(comment.path);
    if (!file || file.patchRedacted || file.patchTruncated || !file.patchAvailable) {
      dropped.push({ comment, reason: 'current patch is missing, truncated, or redacted' });
      continue;
    }
    const lines = comment.side === 'LEFT' ? file.lineMap?.left : file.lineMap?.right;
    if (!Array.isArray(lines) || !lines.includes(comment.line)) {
      dropped.push({ comment, reason: 'line and side are not present in the current patch' });
      continue;
    }
    valid.push(comment);
  }
  return { valid, dropped };
}

function locationValidationDigest(validation) {
  return hash(JSON.stringify({
    valid: validation.valid.map(({ path, line, side }) => ({ path, line, side })),
    dropped: validation.dropped.map(({ comment, reason }) => ({
      path: comment.path,
      line: comment.line,
      side: comment.side,
      reason,
    })),
  }));
}

async function currentSnapshot(payload, spawn) {
  return pullSnapshot({
    owner: payload.target.owner,
    repo: payload.target.repo,
    number: payload.target.number,
  }, { spawn });
}

function snapshotIdentityError(payload, snapshot) {
  if (
    snapshot.number !== payload.target.number ||
    snapshot.owner.toLowerCase() !== payload.target.owner.toLowerCase() ||
    snapshot.repo.toLowerCase() !== payload.target.repo.toLowerCase()
  ) {
    return 'canonical repository identity mismatch';
  }
  if (snapshot.headSha !== payload.snapshot.headSha) return 'snapshot head SHA mismatch';
  return null;
}

function snapshotFreshnessError(payload, snapshot) {
  if (snapshot.snapshotId !== payload.snapshot.id) return 'snapshot ID mismatch';
  if (snapshot.feedbackDigest !== payload.snapshot.feedbackDigest) return 'snapshot feedback digest mismatch';
  if (!snapshot.complete) return 'current snapshot is incomplete; refusing to post';
  return null;
}

async function postReviewLocked(payload, spawn, key) {
  let snapshot;
  try {
    snapshot = await currentSnapshot(payload, spawn);
  } catch (error) {
    return errEnvelope('naru-github-post-review', `snapshot failed: ${safeError(error)}`);
  }
  const identityError = snapshotIdentityError(payload, snapshot);
  if (identityError) return errEnvelope('naru-github-post-review', identityError);
  payload.target = { ...payload.target, owner: snapshot.owner, repo: snapshot.repo };

  let actor;
  try {
    actor = await fetchAuthenticatedLogin({ spawn });
  } catch (error) {
    return errEnvelope('naru-github-post-review', `could not resolve authenticated GitHub identity: ${safeError(error)}`);
  }

  const initialValidation = validateCurrentComments(payload.inlineComments, snapshot);
  const digest = markerDigest(payload, initialValidation.valid);
  const existing = markerOnHead(snapshot.reviews, payload.target, snapshot.headSha, actor);
  if (existing) {
    if (existing.digest === digest) {
      rememberPost(key, {
        actor: actor.toLowerCase(),
        headSha: snapshot.headSha,
        digest,
        status: 'succeeded',
        reviewId: existing.reviewId,
        reviewUrl: existing.url,
      });
      return alreadyPosted(existing.reviewId, existing.url);
    }
    return errEnvelope('naru-github-post-review', 'a different Naru review already exists on this head; duplicate refused');
  }

  const recorded = recordedPostResult(key, payload, actor, digest);
  if (recorded) return recorded;
  const freshnessError = snapshotFreshnessError(payload, snapshot);
  if (freshnessError) return errEnvelope('naru-github-post-review', freshnessError);

  let finalSnapshot;
  try {
    finalSnapshot = await currentSnapshot(payload, spawn);
  } catch (error) {
    return errEnvelope('naru-github-post-review', `final snapshot failed: ${safeError(error)}`);
  }
  const finalIdentityError = snapshotIdentityError(payload, finalSnapshot);
  if (finalIdentityError) return errEnvelope('naru-github-post-review', `final ${finalIdentityError}`);

  const finalValidation = validateCurrentComments(payload.inlineComments, finalSnapshot);
  const finalDigest = markerDigest(payload, finalValidation.valid);
  const finalExisting = markerOnHead(finalSnapshot.reviews, payload.target, finalSnapshot.headSha, actor);
  if (finalExisting) {
    if (finalExisting.digest === finalDigest) {
      rememberPost(key, {
        actor: actor.toLowerCase(),
        headSha: finalSnapshot.headSha,
        digest: finalDigest,
        status: 'succeeded',
        reviewId: finalExisting.reviewId,
        reviewUrl: finalExisting.url,
      });
      return alreadyPosted(finalExisting.reviewId, finalExisting.url);
    }
    return errEnvelope('naru-github-post-review', 'a different Naru review already exists on this head; duplicate refused');
  }
  const finalRecorded = recordedPostResult(key, payload, actor, finalDigest);
  if (finalRecorded) return finalRecorded;
  const finalFreshnessError = snapshotFreshnessError(payload, finalSnapshot);
  if (finalFreshnessError) return errEnvelope('naru-github-post-review', `final ${finalFreshnessError}`);
  if (finalDigest !== digest || locationValidationDigest(finalValidation) !== locationValidationDigest(initialValidation)) {
    return errEnvelope('naru-github-post-review', 'inline comment locations changed during final validation; refusing to post');
  }

  const validComments = finalValidation.valid;
  const droppedComments = finalValidation.dropped;

  const marker = markerTag(payload, digest);
  const body = `${marker}\n${payload.body}`;
  const ghPayload = {
    body,
    event: 'COMMENT',
    commit_id: finalSnapshot.headSha,
    comments: validComments.map((comment) => ({
      path: comment.path,
      line: comment.line,
      side: comment.side,
      body: comment.body,
    })),
  };
  const endpoint = `repos/${payload.target.owner}/${payload.target.repo}/pulls/${payload.target.number}/reviews`;

  rememberPost(key, {
    actor: actor.toLowerCase(),
    headSha: finalSnapshot.headSha,
    digest,
    status: 'unknown',
  });
  let postResult;
  try {
    postResult = await run(
      ['gh', 'api', '--method', 'POST', endpoint, '--input', '-'],
      { spawn, input: JSON.stringify(ghPayload), maxBytes: MAX_GH_BYTES },
    );
  } catch (error) {
    postResult = { ok: false, stderr: safeError(error), stdout: '' };
  }

  if (postResult.ok) {
    try {
      const result = JSON.parse(postResult.stdout);
      if (result && result.id) {
        rememberPost(key, {
          actor: actor.toLowerCase(),
          headSha: finalSnapshot.headSha,
          digest,
          status: 'succeeded',
          reviewId: result.id,
          reviewUrl: result.html_url ?? result.url,
        });
        return okEnvelope('naru-github-post-review', {
          posted: true,
          reviewId: result.id,
          reviewUrl: result.html_url ?? result.url,
          commentsPosted: ghPayload.comments.length,
          droppedComments,
        }, {
          warnings: droppedComments.length ? [`dropped ${droppedComments.length} invalid inline comments`] : [],
        });
      }
    } catch {
      // Treat a successful status without a parseable review ID as ambiguous.
    }
  }

  // Never retry the mutation. A fresh read may only confirm whether it landed.
  try {
    const fresh = await currentSnapshot(payload, spawn);
    const recovered = markerOnHead(fresh.reviews, payload.target, finalSnapshot.headSha, actor);
    if (recovered?.digest === digest) {
      rememberPost(key, {
        actor: actor.toLowerCase(),
        headSha: finalSnapshot.headSha,
        digest,
        status: 'succeeded',
        reviewId: recovered.reviewId,
        reviewUrl: recovered.url,
      });
      return okEnvelope('naru-github-post-review', {
        posted: true,
        recovered: true,
        reviewId: recovered.reviewId,
        reviewUrl: recovered.url,
        commentsPosted: ghPayload.comments.length,
        droppedComments,
      });
    }
  } catch {
    // Preserve the unknown outcome below.
  }

  return errEnvelope('naru-github-post-review', 'outcomeUnknown: the review may or may not have been posted', {
    warnings: [stripSecrets(postResult.stderr || postResult.stdout || '')].filter(Boolean),
  });
}

export async function postReview(rawPayload, context, { spawn } = {}) {
  if (!context || typeof context !== 'object' || !POSTING_AGENTS.has(context.agent)) {
    return errEnvelope('naru-github-post-review', 'caller agent identity mismatch');
  }

  let payload;
  try {
    payload = validateReviewPayload(rawPayload);
  } catch (error) {
    return errEnvelope('naru-github-post-review', `invalid input: ${safeError(error)}`);
  }

  if (!payload.coverage.complete || payload.coverage.limitations.length > 0 || !payload.snapshot.complete) {
    return errEnvelope('naru-github-post-review', 'incomplete coverage or snapshot cannot be posted');
  }

  const key = targetKey(payload.target);
  try {
    return await withPostLock(key, () => postReviewLocked(payload, spawn, key));
  } catch (error) {
    return errEnvelope('naru-github-post-review', `review post coordination failed: ${safeError(error)}`);
  }
}
