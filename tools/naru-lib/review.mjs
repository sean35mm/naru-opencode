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
const MAX_FAILED_SPECIALISTS = 20;
const MAX_GH_BYTES = 32 * 1024 * 1024;
const PRIORITIES = ['P0', 'P1', 'P2', 'P3'];
const SEVERITIES = ['Critical', 'High', 'Medium', 'Low'];
const CONFIDENCE = ['High', 'Medium', 'Low'];
const WORKFLOW_STATUSES = ['complete', 'partial', 'incomplete'];
const SNAPSHOT_ID = /^naru-snap-[0-9a-f]{64}$/;
const DIGEST = /^[0-9a-f]{64}$/;

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

function validateWorkflow(raw) {
  assertPlainObject(raw, 'reviewResult.workflow');
  validateAllowedKeys(raw, ['status', 'degraded', 'failedSpecialists']);
  const status = requireField(raw, 'status', (value) => WORKFLOW_STATUSES.includes(value));
  const degraded = requireField(raw, 'degraded', isBoolean);
  const failedSpecialists = requireStringArray(
    requireField(raw, 'failedSpecialists', Array.isArray),
    'reviewResult.workflow.failedSpecialists',
    MAX_FAILED_SPECIALISTS,
  );
  if (status === 'complete' && (degraded || failedSpecialists.length > 0)) {
    throw new Error('complete workflow cannot be degraded or have failed specialists');
  }
  if (status !== 'complete' && !degraded) throw new Error('partial or incomplete workflow must be degraded');
  return { status, degraded, failedSpecialists };
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
    'workflow',
    'body',
    'inlineComments',
    'skippedInlineComments',
  ]);
  if (result.schemaVersion !== 1) throw new Error('reviewResult.schemaVersion must be 1');

  const target = validateTarget(requireField(result, 'target', (value) => value !== null && typeof value === 'object'));
  const snapshot = validateSnapshot(requireField(result, 'snapshot', (value) => value !== null && typeof value === 'object'));
  const workflow = validateWorkflow(requireField(result, 'workflow', (value) => value !== null && typeof value === 'object'));
  const body = requireField(result, 'body', (value) => isBoundedText(value, MAX_BODY_LENGTH - 256));
  if (/<!--\s*naru-review:/i.test(body)) throw new Error('reviewResult.body contains a reserved Naru marker');

  const commentsRaw = requireField(result, 'inlineComments', Array.isArray);
  if (commentsRaw.length > MAX_COMMENTS) throw new Error(`inlineComments exceeds ${MAX_COMMENTS}`);
  const inlineComments = commentsRaw.map(validateComment);
  const skippedRaw = requireField(result, 'skippedInlineComments', Array.isArray);
  if (skippedRaw.length > MAX_COMMENTS) throw new Error(`skippedInlineComments exceeds ${MAX_COMMENTS}`);
  const skippedInlineComments = skippedRaw.map(validateSkippedComment);
  return { target, snapshot, workflow, body, inlineComments, skippedInlineComments };
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

async function currentSnapshot(payload, spawn) {
  return pullSnapshot({
    owner: payload.target.owner,
    repo: payload.target.repo,
    number: payload.target.number,
  }, { spawn });
}

export async function postReview(rawPayload, context, { spawn } = {}) {
  let payload;
  try {
    payload = validateReviewPayload(rawPayload);
  } catch (error) {
    return errEnvelope('naru-github-post-review', `invalid input: ${safeError(error)}`);
  }

  if (!context || typeof context !== 'object' || context.agent !== 'naru-review-post') {
    return errEnvelope('naru-github-post-review', 'caller agent identity mismatch');
  }
  if (payload.workflow.status === 'incomplete') {
    return errEnvelope('naru-github-post-review', 'review workflow is incomplete; refusing to post');
  }
  const degraded = payload.workflow.degraded || !payload.snapshot.complete;
  if (degraded) {
    return errEnvelope('naru-github-post-review', 'degraded or incomplete review snapshots cannot be posted');
  }

  let snapshot;
  try {
    snapshot = await currentSnapshot(payload, spawn);
  } catch (error) {
    return errEnvelope('naru-github-post-review', `snapshot failed: ${safeError(error)}`);
  }
  if (snapshot.headSha !== payload.snapshot.headSha) {
    return errEnvelope('naru-github-post-review', 'snapshot head SHA mismatch');
  }
  if (
    snapshot.owner.toLowerCase() !== payload.target.owner.toLowerCase() ||
    snapshot.repo.toLowerCase() !== payload.target.repo.toLowerCase()
  ) {
    return errEnvelope('naru-github-post-review', 'canonical repository identity mismatch');
  }
  payload.target = { ...payload.target, owner: snapshot.owner, repo: snapshot.repo };

  let actor;
  try {
    actor = await fetchAuthenticatedLogin({ spawn });
  } catch (error) {
    return errEnvelope('naru-github-post-review', `could not resolve authenticated GitHub identity: ${safeError(error)}`);
  }

  const { valid: validComments, dropped: droppedComments } = validateCurrentComments(payload.inlineComments, snapshot);
  const digest = markerDigest(payload, validComments);
  const existing = markerOnHead(snapshot.reviews, payload.target, snapshot.headSha, actor);
  if (existing) {
    if (existing.digest === digest) {
      return okEnvelope('naru-github-post-review', {
        posted: false,
        reason: 'alreadyPosted',
        reviewId: existing.reviewId,
        reviewUrl: existing.url,
      });
    }
    return errEnvelope('naru-github-post-review', 'a different Naru review already exists on this head; duplicate refused');
  }

  if (snapshot.snapshotId !== payload.snapshot.id) {
    return errEnvelope('naru-github-post-review', 'snapshot ID mismatch');
  }
  if (snapshot.feedbackDigest !== payload.snapshot.feedbackDigest) {
    return errEnvelope('naru-github-post-review', 'snapshot feedback digest mismatch');
  }
  if (!snapshot.complete) {
    return errEnvelope('naru-github-post-review', 'current snapshot is incomplete; refusing to post');
  }

  const marker = markerTag(payload, digest);
  const body = `${marker}\n${payload.body}`;
  const ghPayload = {
    body,
    event: 'COMMENT',
    commit_id: snapshot.headSha,
    comments: validComments.map((comment) => ({
      path: comment.path,
      line: comment.line,
      side: comment.side,
      body: comment.body,
    })),
  };
  const endpoint = `repos/${payload.target.owner}/${payload.target.repo}/pulls/${payload.target.number}/reviews`;

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
    const recovered = markerOnHead(fresh.reviews, payload.target, snapshot.headSha, actor);
    if (recovered?.digest === digest) {
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
