// Validated PR review posting. This module exposes no caller-
// controlled command, HTTP method, endpoint, environment, or working directory.
import { createHash } from 'node:crypto';
import { run } from './transport.mjs';
import { okEnvelope, errEnvelope } from './output.mjs';
import { fetchAuthenticatedLogin, pullSnapshot } from './github.mjs';
import { assertPlainObject, validateAllowedKeys, isSafeOwner, isSafeRepo, isPositiveInteger, is40HexSha, isSafeRelativePath, isNonEmptyString, isBoolean, safeError, stripSecrets, requireField, } from './validate.mjs';
const MAX_BODY_LENGTH = 64 * 1024;
const MAX_COMMENT_BODY_LENGTH = 32 * 1024;
const MAX_COMMENTS = 100;
const MAX_WARNINGS = 100;
const MAX_RENDERED_FINDINGS_LENGTH = 48 * 1024;
const MAX_GH_BYTES = 32 * 1024 * 1024;
const PRIORITIES = ['P0', 'P1', 'P2', 'P3'];
const SEVERITIES = ['Critical', 'High', 'Medium', 'Low'];
const CONFIDENCE = ['High', 'Medium', 'Low'];
const SUBMISSION_POLICY_EVENTS = Object.freeze({
    'comment-only': new Set(['COMMENT']),
    'approve-if-clear': new Set(['COMMENT', 'APPROVE']),
    'request-changes-if-blocked': new Set(['COMMENT', 'REQUEST_CHANGES']),
    'select-state': new Set(['COMMENT', 'APPROVE', 'REQUEST_CHANGES']),
});
const SNAPSHOT_ID = /^naru-snap-[0-9a-f]{64}$/;
const DIGEST = /^[0-9a-f]{64}$/;
const POSTING_AGENTS = new Set(['naru-orchestrator']);
const MAX_TRACKED_POST_TARGETS = 128;
const postLocks = new Map();
const postRecords = new Map();
function hash(value) {
    return createHash('sha256').update(value).digest('hex');
}
function postState(result, { postAttempted = false, correctable = false, outcomeUnknown = false } = {}) {
    return { ...result, postAttempted, correctable, outcomeUnknown };
}
function postError(error, state) {
    return postState(errEnvelope('naru-github-post-review', error), state);
}
function isUnknownRecord(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function isUnknownArray(value) {
    return Array.isArray(value);
}
function isBoundedText(value, max) {
    return typeof value === 'string' && value.length > 0 && value.length <= max && !value.includes('\0');
}
function isPriority(value) {
    return typeof value === 'string' && PRIORITIES.some(priority => priority === value);
}
function isSeverity(value) {
    return typeof value === 'string' && SEVERITIES.some(severity => severity === value);
}
function isConfidence(value) {
    return typeof value === 'string' && CONFIDENCE.some(confidence => confidence === value);
}
function isReviewSide(value) {
    return value === 'LEFT' || value === 'RIGHT';
}
function requireStringArray(value, name, max) {
    if (!Array.isArray(value) || value.length > max)
        throw new Error(`${name} must be an array with at most ${max} items`);
    for (let index = 0; index < value.length; index += 1) {
        if (!isNonEmptyString(value[index], { max: 4096 }))
            throw new Error(`${name}[${index}] is invalid`);
    }
    return value;
}
// naru-github-read emits `number` and `snapshotId`; this tool's canonical
// names are `pullNumber` and `id`. Accept both spellings so a snapshot can be
// carried straight into a posting payload without a silent rename trap.
function normalizeTargetAliases(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return raw;
    if (Object.hasOwn(raw, 'pullNumber') && Object.hasOwn(raw, 'number'))
        throw new Error('reviewResult.target cannot contain both pullNumber and number');
    if (!Object.hasOwn(raw, 'pullNumber') && Object.hasOwn(raw, 'number')) {
        const { number, ...rest } = raw;
        return { ...rest, pullNumber: number };
    }
    return raw;
}
function normalizeSnapshotAliases(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return raw;
    if (Object.hasOwn(raw, 'id') && Object.hasOwn(raw, 'snapshotId'))
        throw new Error('reviewResult.snapshot cannot contain both id and snapshotId');
    if (!Object.hasOwn(raw, 'id') && Object.hasOwn(raw, 'snapshotId')) {
        const { snapshotId, ...rest } = raw;
        return { ...rest, id: snapshotId };
    }
    return raw;
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
        warnings: requireStringArray(requireField(raw, 'warnings', isUnknownArray), 'reviewResult.snapshot.warnings', MAX_WARNINGS),
    };
}
function validateCoverage(raw) {
    assertPlainObject(raw, 'reviewResult.coverage');
    validateAllowedKeys(raw, ['complete', 'limitations']);
    return {
        complete: requireField(raw, 'complete', isBoolean),
        limitations: requireStringArray(requireField(raw, 'limitations', isUnknownArray), 'reviewResult.coverage.limitations', MAX_WARNINGS),
    };
}
function validateV3Coverage(raw, snapshotWarnings) {
    assertPlainObject(raw, 'reviewResult.coverage');
    validateAllowedKeys(raw, ['posture', 'limitations']);
    const posture = requireField(raw, 'posture', value => value === 'complete' || value === 'limited');
    const limitations = requireStringArray(requireField(raw, 'limitations', isUnknownArray), 'reviewResult.coverage.limitations', MAX_WARNINGS);
    if (posture === 'limited' && limitations.length === 0 && snapshotWarnings.length === 0)
        throw new Error('limited review evidence requires at least one coverage limitation or snapshot warning');
    return { posture, limitations };
}
function validateComment(raw, index) {
    assertPlainObject(raw, `reviewResult.inlineComments[${index}]`);
    validateAllowedKeys(raw, ['path', 'line', 'side', 'body', 'priority', 'severity', 'confidence']);
    const path = requireField(raw, 'path', isSafeRelativePath);
    const line = requireField(raw, 'line', isPositiveInteger);
    const side = requireField(raw, 'side', isReviewSide);
    const body = requireField(raw, 'body', (value) => isBoundedText(value, MAX_COMMENT_BODY_LENGTH));
    const priority = requireField(raw, 'priority', isPriority);
    const severity = requireField(raw, 'severity', isSeverity);
    const confidence = requireField(raw, 'confidence', isConfidence);
    return { path, line, side, body, priority, severity, confidence };
}
function validateSkippedComment(raw, index) {
    assertPlainObject(raw, `reviewResult.skippedInlineComments[${index}]`);
    validateAllowedKeys(raw, ['path', 'line', 'side', 'reason']);
    return {
        path: requireField(raw, 'path', isSafeRelativePath),
        line: requireField(raw, 'line', isPositiveInteger),
        side: requireField(raw, 'side', isReviewSide),
        reason: requireField(raw, 'reason', (value) => isBoundedText(value, 4096)),
    };
}
function validateFinding(raw, index) {
    assertPlainObject(raw, `reviewResult.findings[${index}]`);
    validateAllowedKeys(raw, ['path', 'line', 'side', 'body', 'priority', 'severity', 'confidence']);
    const hasPath = Object.hasOwn(raw, 'path');
    const hasLine = Object.hasOwn(raw, 'line');
    const hasSide = Object.hasOwn(raw, 'side');
    if (hasLine !== hasSide || (!hasPath && (hasLine || hasSide)))
        throw new Error(`reviewResult.findings[${index}] must omit path, line, and side together, or provide path with line and side together`);
    const finding = {
        body: requireField(raw, 'body', value => isBoundedText(value, MAX_COMMENT_BODY_LENGTH)),
        priority: requireField(raw, 'priority', isPriority),
        severity: requireField(raw, 'severity', isSeverity),
        confidence: requireField(raw, 'confidence', isConfidence),
    };
    if (hasPath)
        finding.path = requireField(raw, 'path', isSafeRelativePath);
    if (hasLine) {
        finding.line = requireField(raw, 'line', isPositiveInteger);
        finding.side = requireField(raw, 'side', isReviewSide);
    }
    return finding;
}
export function validateReviewPayload(raw) {
    assertPlainObject(raw, 'input');
    validateAllowedKeys(raw, ['reviewResult']);
    const result = requireField(raw, 'reviewResult', isUnknownRecord);
    assertPlainObject(result, 'reviewResult');
    if (result.schemaVersion !== 2 && result.schemaVersion !== 3)
        throw new Error('reviewResult.schemaVersion must be 2 or 3');
    const version = result.schemaVersion;
    validateAllowedKeys(result, version === 2
        ? ['schemaVersion', 'target', 'snapshot', 'coverage', 'body', 'inlineComments', 'skippedInlineComments']
        : ['schemaVersion', 'target', 'snapshot', 'coverage', 'body', 'submissionPolicy', 'conclusion', 'findings']);
    const target = validateTarget(normalizeTargetAliases(requireField(result, 'target', isUnknownRecord)));
    const snapshot = validateSnapshot(normalizeSnapshotAliases(requireField(result, 'snapshot', isUnknownRecord)));
    const body = requireField(result, 'body', (value) => isBoundedText(value, MAX_BODY_LENGTH - 256));
    if (/<!--\s*naru-review:/i.test(body))
        throw new Error('reviewResult.body contains a reserved Naru marker');
    if (version === 3) {
        const coverage = validateV3Coverage(requireField(result, 'coverage', isUnknownRecord), snapshot.warnings);
        const submissionPolicy = result.submissionPolicy;
        if (typeof submissionPolicy !== 'string' || !Object.hasOwn(SUBMISSION_POLICY_EVENTS, submissionPolicy)) {
            throw new Error('reviewResult.submissionPolicy must assert current user authorization as comment-only, approve-if-clear, request-changes-if-blocked, or select-state');
        }
        const conclusion = requireField(result, 'conclusion', value => ['informational', 'clear', 'blocking'].includes(value));
        const findingsRaw = requireField(result, 'findings', isUnknownArray);
        if (findingsRaw.length > MAX_COMMENTS)
            throw new Error(`findings exceeds ${MAX_COMMENTS}`);
        return { schemaVersion: 3, target, snapshot, coverage, body, submissionPolicy, conclusion, findings: findingsRaw.map(validateFinding) };
    }
    const coverage = validateCoverage(requireField(result, 'coverage', isUnknownRecord));
    const commentsRaw = requireField(result, 'inlineComments', isUnknownArray);
    if (commentsRaw.length > MAX_COMMENTS)
        throw new Error(`inlineComments exceeds ${MAX_COMMENTS}`);
    const inlineComments = commentsRaw.map(validateComment);
    const skippedRaw = requireField(result, 'skippedInlineComments', isUnknownArray);
    if (skippedRaw.length > MAX_COMMENTS)
        throw new Error(`skippedInlineComments exceeds ${MAX_COMMENTS}`);
    const skippedInlineComments = skippedRaw.map(validateSkippedComment);
    return { schemaVersion: 2, target, snapshot, coverage, body, inlineComments, skippedInlineComments };
}
function markerDigest(payload, comments, decision, renderedFindings = '') {
    const normalized = comments.map(comment => ({
        path: comment.path,
        line: comment.line,
        side: comment.side,
        body: comment.body,
    })).sort((a, b) => `${a.path}:${a.side}:${a.line}`.localeCompare(`${b.path}:${b.side}:${b.line}`));
    const legacy = {
        ...payload.target,
        headSha: payload.snapshot.headSha,
        body: payload.body,
        limitations: payload.coverage.limitations,
        comments: normalized,
    };
    if (payload.schemaVersion === 2)
        return hash(JSON.stringify(legacy));
    return hash(JSON.stringify({
        ...legacy,
        schemaVersion: 3,
        event: decision.event,
        evidencePosture: decision.evidencePosture,
        limitations: decision.limitations,
        coveragePosture: payload.coverage.posture,
        conclusion: payload.conclusion,
        submissionPolicy: payload.submissionPolicy,
        authorizationPolicy: decision.authorizationPolicy,
        findings: payload.findings,
        renderedFindings,
    }));
}
function markerTag(payload, digest) {
    const { owner, repo, number } = payload.target;
    return `<!-- naru-review:${owner}/${repo}#${number} head=${payload.snapshot.headSha} digest=${digest} -->`;
}
function extractMarker(body) {
    if (typeof body !== 'string')
        return null;
    const match = body.match(/<!--\s*naru-review:([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+)#(\d+) head=([0-9a-f]{40}) digest=([0-9a-f]{64})\s*-->/i);
    if (!match)
        return null;
    const owner = match[1];
    const repo = match[2];
    const number = Number(match[3]);
    const headSha = match[4];
    const digest = match[5];
    if (!owner || !repo || !headSha || !digest)
        return null;
    return { owner, repo, number, headSha, digest };
}
function markerOnHead(reviews, target, headSha, actor) {
    for (const review of reviews) {
        const commitId = review.commitId ?? review.commit_id;
        if (commitId !== headSha)
            continue;
        if (typeof review.author !== 'string' || review.author.toLowerCase() !== actor.toLowerCase())
            continue;
        const marker = extractMarker(review.body);
        if (!marker)
            continue;
        if (marker.owner.toLowerCase() === target.owner.toLowerCase()
            && marker.repo.toLowerCase() === target.repo.toLowerCase()
            && marker.number === target.number) {
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
    const current = new Promise(resolve => { release = resolve; });
    entry.tail = current;
    await previous;
    try {
        return await operation();
    }
    finally {
        release();
        entry.queued -= 1;
        if (entry.queued === 0 && entry.tail === current)
            postLocks.delete(key);
    }
}
function postRecord(key) {
    const record = postRecords.get(key);
    if (!record)
        return null;
    postRecords.delete(key);
    postRecords.set(key, record);
    return record;
}
function rememberPost(key, record) {
    postRecords.delete(key);
    postRecords.set(key, record);
    while (postRecords.size > MAX_TRACKED_POST_TARGETS) {
        const oldest = postRecords.keys().next();
        if (oldest.done)
            break;
        postRecords.delete(oldest.value);
    }
}
function alreadyPosted(reviewId, reviewUrl, decision = {}) {
    return postState(okEnvelope('naru-github-post-review', {
        posted: false,
        reason: 'alreadyPosted',
        reviewId,
        reviewUrl,
        event: decision.event,
        evidencePosture: decision.evidencePosture,
        limitations: decision.limitations,
        submissionPolicy: decision.authorizationPolicy,
    }));
}
function recordedPostResult(key, payload, actor, digest) {
    const record = postRecord(key);
    if (!record || record.headSha !== payload.snapshot.headSha)
        return null;
    if (record.actor !== actor.toLowerCase()) {
        return postError('a review post is already recorded for this head under a different actor; duplicate refused');
    }
    if (record.digest !== digest) {
        return postError('a different Naru review already exists on this head; duplicate refused');
    }
    if (record.status === 'succeeded')
        return alreadyPosted(record.reviewId, record.reviewUrl, record);
    return postError('outcomeUnknown: a prior in-process POST attempt on this head has an unknown outcome; duplicate refused', { outcomeUnknown: true });
}
function validateCurrentComments(comments, snapshot) {
    const files = new Map(snapshot.files.map(file => [file.filename, file]));
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
function isCompletePatch(file) {
    return Boolean(file && !file.patchRedacted && !file.patchTruncated && file.patchAvailable
        && (!file.patchEvidence || file.patchEvidence.status === 'complete'));
}
function isApprovalBlocker(finding) {
    return (finding.priority === 'P0' || finding.priority === 'P1')
        && (finding.severity === 'Critical' || finding.severity === 'High')
        && finding.confidence === 'High';
}
function validateCurrentFindings(findings, snapshot) {
    const files = new Map(snapshot.files.map(file => [file.filename, file]));
    const validInline = [];
    const invalid = [];
    const nonInline = [];
    const eligibleBlockers = [];
    for (const finding of findings) {
        const file = finding.path ? files.get(finding.path) : undefined;
        let reason;
        let displayPath = finding.path;
        let blockerEvidenceValid = false;
        let invalidLocation = false;
        if (!finding.path)
            reason = 'no path or inline location was supplied';
        else if (!isCompletePatch(file)) {
            reason = 'current path does not have complete patch evidence';
            invalidLocation = true;
        }
        else if (finding.line !== undefined) {
            const lines = finding.side === 'LEFT' ? file?.lineMap?.left : file?.lineMap?.right;
            if (!Array.isArray(lines) || !lines.includes(finding.line)) {
                reason = 'line and side are not present in the current patch';
                invalidLocation = true;
            }
            else {
                validInline.push(finding);
                blockerEvidenceValid = true;
            }
        }
        else {
            reason = 'no inline location was supplied for this path-level finding';
            blockerEvidenceValid = true;
        }
        if (file?.patchRedacted)
            displayPath = undefined;
        if (invalidLocation)
            invalid.push({ finding, reason });
        if (!validInline.includes(finding))
            nonInline.push({ finding, reason, displayPath });
        if (isApprovalBlocker(finding) && blockerEvidenceValid)
            eligibleBlockers.push(finding);
    }
    return { validInline, invalid, nonInline, eligibleBlockers };
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
function findingValidationDigest(validation) {
    return hash(JSON.stringify({
        validInline: validation.validInline.map(({ path, line, side }) => ({ path, line, side })),
        invalid: validation.invalid.map(({ finding, reason }) => ({ path: finding.path, line: finding.line, side: finding.side, reason })),
        nonInline: validation.nonInline.map(({ finding, reason, displayPath }) => ({ body: finding.body, displayPath, line: finding.line, side: finding.side, reason })),
        eligibleBlockers: validation.eligibleBlockers.map(({ path, line, side, body }) => ({ path, line, side, body })),
    }));
}
function boundedSafeMarkdown(value, max) {
    const normalized = value.replace(/\r\n?/g, '\n').replace(/[\u0001-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, ' ');
    const escaped = normalized
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('`', '&#96;');
    return escaped.length > max ? `${escaped.slice(0, max)}…` : escaped;
}
function renderNonInlineFindings(entries) {
    if (entries.length === 0)
        return '';
    const bodyLimit = Math.max(64, Math.min(256, Math.floor(16 * 1024 / entries.length)));
    const rendered = entries.map(({ finding, reason, displayPath }, index) => {
        const location = displayPath
            ? `${boundedSafeMarkdown(displayPath, 96)}${finding.line !== undefined ? `:${finding.line} (${finding.side})` : ''}`
            : 'not available';
        const body = boundedSafeMarkdown(finding.body, bodyLimit).split('\n').map(line => `> ${line}`).join('\n');
        return [
            `### Finding ${index + 1}: ${finding.priority} · ${finding.severity} · ${finding.confidence} confidence`,
            `Location: ${location}`,
            `Location unavailable: ${boundedSafeMarkdown(reason || 'not emitted as an inline comment', 128)}`,
            body,
        ].join('\n\n');
    }).join('\n\n');
    const section = `\n\n---\n\n## Findings not posted inline\n\n${rendered}`;
    if (section.length > MAX_RENDERED_FINDINGS_LENGTH)
        throw new Error('rendered non-inline findings exceed the safe body allowance');
    return section;
}
function snapshotEvidenceDigest(snapshot) {
    return hash(JSON.stringify({
        state: snapshot.pull?.state,
        draft: snapshot.pull?.draft,
        author: snapshot.pull?.author,
        contentDigest: snapshot.pull?.contentDigest,
        reviewability: snapshot.reviewability,
        files: snapshot.files.map(file => ({
            filename: file.filename,
            patchEvidence: file.patchEvidence,
            patchAvailable: file.patchAvailable,
            patchTruncated: file.patchTruncated,
            patchRedacted: file.patchRedacted,
            lineMap: file.lineMap,
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
    if (snapshot.number !== payload.target.number
        || snapshot.owner.toLowerCase() !== payload.target.owner.toLowerCase()
        || snapshot.repo.toLowerCase() !== payload.target.repo.toLowerCase()) {
        return 'canonical repository identity mismatch';
    }
    if (snapshot.headSha !== payload.snapshot.headSha)
        return 'snapshot head SHA mismatch';
    return null;
}
function snapshotFreshnessError(payload, snapshot) {
    if (snapshot.snapshotId !== payload.snapshot.id)
        return 'snapshot ID mismatch';
    if (snapshot.feedbackDigest !== payload.snapshot.feedbackDigest)
        return 'snapshot feedback digest mismatch';
    if (payload.schemaVersion === 2 && !snapshot.complete)
        return 'current snapshot is incomplete; refusing to post';
    return null;
}
function reviewability(snapshot) {
    if (snapshot.reviewability)
        return snapshot.reviewability;
    return {
        status: snapshot.complete ? 'complete' : 'unpostable',
        inventoryComplete: Boolean(snapshot.completeness?.allFilesIncluded),
        feedbackComplete: Boolean(snapshot.completeness?.feedbackComplete),
        patchesComplete: Boolean(snapshot.completeness?.patchesComplete),
        limitations: snapshot.warnings ?? [],
    };
}
function deriveReviewSubmission(payload, initialSnapshot, finalSnapshot, actor, validation) {
    const currentEvidence = reviewability(initialSnapshot);
    const finalEvidence = reviewability(finalSnapshot);
    if (finalSnapshot.pull?.state?.toLowerCase() !== 'open')
        throw new Error('pull request is not open');
    if (currentEvidence.status === 'unpostable' || finalEvidence.status === 'unpostable')
        throw new Error('snapshot reviewability is unpostable');
    if (payload.schemaVersion === 2) {
        if (currentEvidence.status !== 'complete' || finalEvidence.status !== 'complete')
            throw new Error('v2 requires complete review evidence');
        return {
            event: 'COMMENT', evidencePosture: 'complete', limitations: payload.coverage.limitations,
            authorizationPolicy: 'comment-only',
        };
    }
    const payloadEvidenceLimited = payload.snapshot.complete !== true;
    if ((payloadEvidenceLimited || currentEvidence.status === 'limited-comment' || finalEvidence.status === 'limited-comment')
        && payload.coverage.posture !== 'limited') {
        throw new Error('limited snapshot evidence requires limited coverage posture');
    }
    const evidencePosture = payload.snapshot.complete === true
        && currentEvidence.status === 'complete' && finalEvidence.status === 'complete'
        && payload.coverage.posture === 'complete' ? 'complete' : 'limited';
    const payloadWarnings = evidencePosture === 'limited'
        ? payload.snapshot.warnings.map(warning => `Payload snapshot warning: ${warning}`)
        : [];
    const snapshotLimitations = [...new Set([
        ...payloadWarnings,
        ...(currentEvidence.limitations ?? []),
        ...(finalEvidence.limitations ?? []),
    ])].slice(0, MAX_WARNINGS);
    const limitations = [...new Set([...snapshotLimitations, ...payload.coverage.limitations])].slice(0, MAX_WARNINGS);
    if (evidencePosture === 'limited' && limitations.length === 0)
        throw new Error('limited review evidence requires at least one limitation');
    const declaredBlockers = payload.findings.filter(isApprovalBlocker);
    const droppedBlocker = declaredBlockers.some(finding => !validation.eligibleBlockers.includes(finding));
    const formalEligible = evidencePosture === 'complete'
        && finalSnapshot.pull?.draft === false
        && typeof finalSnapshot.pull?.author === 'string'
        && finalSnapshot.pull.author.toLowerCase() !== actor.toLowerCase();
    let event = 'COMMENT';
    if (payload.submissionPolicy === 'approve-if-clear'
        && formalEligible && payload.conclusion === 'clear' && declaredBlockers.length === 0 && !droppedBlocker) {
        event = 'APPROVE';
    }
    else if (payload.submissionPolicy === 'request-changes-if-blocked'
        && formalEligible && payload.conclusion === 'blocking' && validation.eligibleBlockers.length > 0) {
        event = 'REQUEST_CHANGES';
    }
    else if (payload.submissionPolicy === 'select-state') {
        if (formalEligible && payload.conclusion === 'blocking' && validation.eligibleBlockers.length > 0)
            event = 'REQUEST_CHANGES';
        else if (formalEligible && payload.conclusion === 'clear' && declaredBlockers.length === 0 && !droppedBlocker)
            event = 'APPROVE';
    }
    if (!SUBMISSION_POLICY_EVENTS[payload.submissionPolicy].has(event))
        throw new Error('derived review event exceeds the asserted submission authorization policy');
    return {
        event, evidencePosture, limitations, droppedBlocker,
        authorizationPolicy: payload.submissionPolicy,
    };
}
async function postReviewLocked(payload, spawn, key) {
    let snapshot;
    try {
        snapshot = await currentSnapshot(payload, spawn);
    }
    catch (error) {
        return postError(`snapshot failed: ${safeError(error)}`, { correctable: true });
    }
    const identityError = snapshotIdentityError(payload, snapshot);
    if (identityError)
        return postError(identityError, { correctable: true });
    payload.target = { ...payload.target, owner: snapshot.owner, repo: snapshot.repo };
    let actor;
    try {
        actor = await fetchAuthenticatedLogin({ spawn });
    }
    catch (error) {
        return postError(`could not resolve authenticated GitHub identity: ${safeError(error)}`);
    }
    const freshnessError = snapshotFreshnessError(payload, snapshot);
    if (freshnessError)
        return postError(freshnessError, { correctable: true });
    let finalSnapshot;
    try {
        finalSnapshot = await currentSnapshot(payload, spawn);
    }
    catch (error) {
        return postError(`final snapshot failed: ${safeError(error)}`, { correctable: true });
    }
    const finalIdentityError = snapshotIdentityError(payload, finalSnapshot);
    if (finalIdentityError)
        return postError(`final ${finalIdentityError}`, { correctable: true });
    const finalFreshnessError = snapshotFreshnessError(payload, finalSnapshot);
    if (finalFreshnessError)
        return postError(`final ${finalFreshnessError}`, { correctable: true });
    if (snapshotEvidenceDigest(snapshot) !== snapshotEvidenceDigest(finalSnapshot))
        return postError('review evidence or pull request state changed during final validation; refusing to post', { correctable: true });
    const initialValidation = payload.schemaVersion === 2
        ? validateCurrentComments(payload.inlineComments, snapshot)
        : validateCurrentFindings(payload.findings, snapshot);
    const finalValidation = payload.schemaVersion === 2
        ? validateCurrentComments(payload.inlineComments, finalSnapshot)
        : validateCurrentFindings(payload.findings, finalSnapshot);
    const validationChanged = payload.schemaVersion === 2
        ? locationValidationDigest(finalValidation) !== locationValidationDigest(initialValidation)
        : findingValidationDigest(finalValidation) !== findingValidationDigest(initialValidation);
    if (validationChanged)
        return postError('finding locations or evidence changed during final validation; refusing to post', { correctable: true });
    let decision;
    try {
        decision = deriveReviewSubmission(payload, snapshot, finalSnapshot, actor, finalValidation);
    }
    catch (error) {
        return postError(safeError(error), { correctable: true });
    }
    const validComments = payload.schemaVersion === 2 ? finalValidation.valid : finalValidation.validInline;
    const droppedComments = payload.schemaVersion === 2 ? finalValidation.dropped : finalValidation.invalid;
    let findingsSection = '';
    try {
        findingsSection = payload.schemaVersion === 3 ? renderNonInlineFindings(finalValidation.nonInline) : '';
    }
    catch (error) {
        return postError(safeError(error), { correctable: true });
    }
    const digest = markerDigest(payload, validComments, decision, findingsSection);
    const existing = markerOnHead(finalSnapshot.reviews, payload.target, finalSnapshot.headSha, actor);
    if (existing) {
        if (existing.digest === digest) {
            rememberPost(key, {
                actor: actor.toLowerCase(), headSha: finalSnapshot.headSha, digest,
                status: 'succeeded', reviewId: existing.reviewId, reviewUrl: existing.url,
                event: decision.event, evidencePosture: decision.evidencePosture,
                limitations: decision.limitations,
                authorizationPolicy: decision.authorizationPolicy,
            });
            return alreadyPosted(existing.reviewId, existing.url, decision);
        }
        return postError('a different Naru review already exists on this head; duplicate refused');
    }
    const recorded = recordedPostResult(key, payload, actor, digest);
    if (recorded)
        return recorded;
    const marker = markerTag(payload, digest);
    const limitationsNote = decision.limitations.length > 0
        ? `\n\n---\n\n**Review limitations**\n${decision.limitations.map(item => `- ${item}`).join('\n')}`
        : '';
    const limitedBanner = payload.schemaVersion === 3 && decision.evidencePosture === 'limited'
        ? `\n> [!WARNING]\n> **Limited review:** This review was forced to COMMENT because complete evidence was unavailable.\n> ${decision.limitations.join('; ')}\n`
        : '';
    const formalBody = decision.event !== 'COMMENT' && payload.body.trim().length === 0
        ? 'Naru identified review findings requiring a formal decision.' : payload.body;
    const body = `${marker}${limitedBanner}\n${formalBody}${findingsSection}${limitationsNote}`;
    if (body.length > MAX_BODY_LENGTH)
        return postError(`composed review body exceeds ${MAX_BODY_LENGTH} characters`, { correctable: true });
    const ghPayload = {
        body,
        event: decision.event,
        commit_id: finalSnapshot.headSha,
        comments: validComments.map(comment => ({
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
        event: decision.event,
        evidencePosture: decision.evidencePosture,
        limitations: decision.limitations,
        authorizationPolicy: decision.authorizationPolicy,
    });
    let postResult;
    try {
        postResult = await run(['gh', 'api', '--method', 'POST', endpoint, '--input', '-'], { spawn, input: JSON.stringify(ghPayload), maxBytes: MAX_GH_BYTES });
    }
    catch (error) {
        postResult = { ok: false, stderr: safeError(error), stdout: '' };
    }
    if (postResult.ok) {
        try {
            const result = JSON.parse(postResult.stdout);
            if (isUnknownRecord(result) && result.id) {
                const reviewUrl = typeof result.html_url === 'string'
                    ? result.html_url
                    : typeof result.url === 'string' ? result.url : undefined;
                rememberPost(key, {
                    actor: actor.toLowerCase(),
                    headSha: finalSnapshot.headSha,
                    digest,
                    status: 'succeeded',
                    reviewId: result.id,
                    reviewUrl,
                    event: decision.event,
                    evidencePosture: decision.evidencePosture,
                    limitations: decision.limitations,
                    authorizationPolicy: decision.authorizationPolicy,
                });
                return postState(okEnvelope('naru-github-post-review', {
                    posted: true,
                    reviewId: result.id,
                    reviewUrl,
                    commentsPosted: ghPayload.comments.length,
                    droppedComments,
                    event: decision.event,
                    evidencePosture: decision.evidencePosture,
                    limitations: decision.limitations,
                    submissionPolicy: decision.authorizationPolicy,
                }, {
                    warnings: droppedComments.length ? [`dropped ${droppedComments.length} invalid inline comments`] : [],
                }), { postAttempted: true });
            }
        }
        catch {
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
                event: decision.event,
                evidencePosture: decision.evidencePosture,
                limitations: decision.limitations,
                authorizationPolicy: decision.authorizationPolicy,
            });
            return postState(okEnvelope('naru-github-post-review', {
                posted: true,
                recovered: true,
                reviewId: recovered.reviewId,
                reviewUrl: recovered.url,
                commentsPosted: ghPayload.comments.length,
                droppedComments,
                event: decision.event,
                evidencePosture: decision.evidencePosture,
                limitations: decision.limitations,
                submissionPolicy: decision.authorizationPolicy,
            }), { postAttempted: true });
        }
    }
    catch {
        // Preserve the unknown outcome below.
    }
    return postState(errEnvelope('naru-github-post-review', 'outcomeUnknown: the review may or may not have been posted', {
        warnings: [stripSecrets(postResult.stderr || postResult.stdout || '')].filter(Boolean),
    }), { postAttempted: true, outcomeUnknown: true });
}
export async function postReview(rawPayload, context, { spawn } = {}) {
    if (!context || typeof context !== 'object' || !POSTING_AGENTS.has(typeof context.agent === 'string' ? context.agent : '')) {
        return postError('caller agent identity mismatch');
    }
    let payload;
    try {
        payload = validateReviewPayload(rawPayload);
    }
    catch (error) {
        return postError(`invalid input: ${safeError(error)}`, { correctable: true });
    }
    if (payload.schemaVersion === 2 && (!payload.coverage.complete || !payload.snapshot.complete)) {
        return postError('incomplete coverage or snapshot cannot be posted', { correctable: true });
    }
    const preflightMarker = markerTag(payload, '0'.repeat(64));
    const preflightLimitations = payload.coverage.limitations.length > 0
        ? `\n\n---\n\n**Review limitations**\n${payload.coverage.limitations.map(item => `- ${item}`).join('\n')}`
        : '';
    if (`${preflightMarker}\n${payload.body}${preflightLimitations}`.length > MAX_BODY_LENGTH)
        return postError(`composed review body exceeds ${MAX_BODY_LENGTH} characters`, { correctable: true });
    const key = targetKey(payload.target);
    try {
        return await withPostLock(key, () => postReviewLocked(payload, spawn, key));
    }
    catch (error) {
        return postError(`review post coordination failed: ${safeError(error)}`);
    }
}
