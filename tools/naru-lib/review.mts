// Validated PR review posting. This module exposes no caller-
// controlled command, HTTP method, endpoint, environment, or working directory.
import { createHash } from 'node:crypto';
import { run, type Spawn } from './transport.mjs';
import { okEnvelope, errEnvelope } from './output.mjs';
import { fetchAuthenticatedLogin, pullSnapshot, pullManifest, pullFileBatchesAtManifest, pullFeedbackPage, type FeedbackKind, type FileEvidenceSummary, type NormalizedCommentItem, type NormalizedReviewItem, type PullIdentity, type PullManifest, type PullSnapshot, type PullTarget } from './github.mjs';
import { assertPlainObject, validateAllowedKeys, isSafeOwner, isSafeRepo, isPositiveInteger, is40HexSha, isSafeRelativePath, isNonEmptyString, isBoolean, safeError, stripSecrets, requireField, type UnknownRecord, } from './validate.mjs';
const MAX_BODY_LENGTH = 64 * 1024;
const MAX_COMMENT_BODY_LENGTH = 32 * 1024;
const MAX_COMMENTS = 100;
const MAX_WARNINGS = 100;
const MAX_RENDERED_FINDINGS_LENGTH = 48 * 1024;
const MAX_SUMMARY_LENGTH = 8192;
const MAX_COVERAGE_ENTRIES = 3000;
const MAX_LIMITATION_EXAMPLES = 5;
const MAX_GH_BYTES = 32 * 1024 * 1024;
const PRIORITIES = ['P0', 'P1', 'P2', 'P3'];
const SEVERITIES = ['Critical', 'High', 'Medium', 'Low'];
const CONFIDENCE = ['High', 'Medium', 'Low'];
const SUBMISSION_POLICY_EVENTS: Readonly<Record<SubmissionPolicy, ReadonlySet<ReviewEvent>>> = Object.freeze({
    'comment-only': new Set<ReviewEvent>(['COMMENT']),
    'approve-if-clear': new Set<ReviewEvent>(['COMMENT', 'APPROVE']),
    'request-changes-if-blocked': new Set<ReviewEvent>(['COMMENT', 'REQUEST_CHANGES']),
    'select-state': new Set<ReviewEvent>(['COMMENT', 'APPROVE', 'REQUEST_CHANGES']),
});
const SNAPSHOT_ID = /^naru-snap-[0-9a-f]{64}$/;
const DIGEST = /^[0-9a-f]{64}$/;
const POSTING_AGENTS = new Set(['naru-orchestrator']);
const MAX_TRACKED_POST_TARGETS = 128;
export type Priority = 'P0' | 'P1' | 'P2' | 'P3';
export type Severity = 'Critical' | 'High' | 'Medium' | 'Low';
export type Confidence = 'High' | 'Medium' | 'Low';
export type ReviewSide = 'LEFT' | 'RIGHT';
export type SubmissionPolicy = 'comment-only' | 'approve-if-clear' | 'request-changes-if-blocked' | 'select-state';
export type SubmissionMode = 'complete' | 'limited';
export type ReviewConclusion = 'informational' | 'clear' | 'blocking';
export type ReviewEvent = 'COMMENT' | 'APPROVE' | 'REQUEST_CHANGES';
export interface ReviewTarget { owner: string; repo: string; number: number }
export interface ReviewSnapshotV2V3 { id: string; baseSha: string; headSha: string; feedbackDigest: string; complete: boolean; warnings: string[] }
export interface ReviewSnapshotV4 { id: string; baseSha: string; headSha: string; feedbackDigest: string; evidenceDigest: string; warnings: string[] }
export interface CoverageV2 { complete: boolean; limitations: string[]; posture?: never; ledger?: never }
export interface CoverageV3 { posture: SubmissionMode; limitations: string[]; ledger?: never }
export type CoverageStatus = 'reviewed' | 'blocked' | 'excluded';
export type CoverageEvidence = 'current-patch' | 'recovered-patch' | 'alternate' | 'none';
export interface CoverageLedgerEntry { path: string; status: CoverageStatus; evidence: CoverageEvidence; note?: string }
export interface DeclaredFileBatch { paths: string[]; batchDigest: string }
export interface DeclaredFeedbackPage { kind: FeedbackKind; page: number; pageDigest: string }
export interface CoverageV4 {
    ledger: CoverageLedgerEntry[]; fileBatches: DeclaredFileBatch[]; feedbackPages: DeclaredFeedbackPage[];
    feedbackAcknowledged: true; feedbackDigest: string; limitations?: never; posture?: never;
}
interface FindingCore { body: string; priority: Priority; severity: Severity; confidence: Confidence }
export type ReviewFinding = FindingCore & (
    | { path?: undefined; line?: undefined; side?: undefined }
    | { path: string; line?: undefined; side?: undefined }
    | { path: string; line: number; side: ReviewSide }
);
export interface InlineComment extends FindingCore { path: string; line: number; side: ReviewSide }
export interface SkippedInlineComment { path: string; line: number; side: ReviewSide; reason: string }
export interface ReviewPayloadV2 { schemaVersion: 2; target: ReviewTarget; snapshot: ReviewSnapshotV2V3; coverage: CoverageV2; body: string; summary?: never; submissionMode?: never; inlineComments: InlineComment[]; skippedInlineComments: SkippedInlineComment[]; findings?: never; supersedes?: never }
export interface ReviewPayloadV3 { schemaVersion: 3; target: ReviewTarget; snapshot: ReviewSnapshotV2V3; coverage: CoverageV3; body: string; summary?: never; submissionMode?: never; submissionPolicy: SubmissionPolicy; conclusion: ReviewConclusion; findings: ReviewFinding[]; supersedes?: never }
export interface ReviewPayloadV4 { schemaVersion: 4; target: ReviewTarget; snapshot: ReviewSnapshotV4; coverage: CoverageV4; body?: never; inlineComments?: never; submissionMode: SubmissionMode; summary: string; submissionPolicy: SubmissionPolicy; conclusion: ReviewConclusion; findings: ReviewFinding[]; supersedes?: { reviewId: number; digest: string } }
export type ReviewPayload = ReviewPayloadV2 | ReviewPayloadV3 | ReviewPayloadV4;
export interface LocationValidation { valid: InlineComment[]; dropped: Array<{ comment: InlineComment; reason: string }> }
export interface FindingValidation {
    validInline: ReviewFinding[]; invalid: Array<{ finding: ReviewFinding; reason: string | undefined }>;
    nonInline: Array<{ finding: ReviewFinding; reason: string | undefined; displayPath: string | undefined }>;
    eligibleBlockers: ReviewFinding[];
}
export interface SubmissionDecision {
    event: ReviewEvent; evidencePosture: SubmissionMode; limitations: string[];
    limitationDetails?: Array<string | { path: string; reason: string; [key: string]: unknown }>;
    droppedBlocker?: boolean; authorizationPolicy: SubmissionPolicy; droppedFindings?: DroppedFinding[];
}
export interface DroppedFinding { finding: ReviewFinding; reason: string; fingerprint?: string; suppressedFromPosting?: true; retainedForDecision?: true; eligibleBlocker?: boolean }
export type PostOutcomeState =
    | { postAttempted: false; correctable: true; outcomeUnknown: false }
    | { postAttempted: false; correctable: false; outcomeUnknown: false }
    | { postAttempted: true; correctable: false; outcomeUnknown: false }
    | { postAttempted: true; correctable: false; outcomeUnknown: true };
export type ReviewPostOutcome =
    | { ok: false; postAttempted: false; correctable: true; outcomeUnknown: false; error: unknown }
    | { ok: false; postAttempted: false; correctable: false; outcomeUnknown: false; error: unknown }
    | { ok: true; postAttempted: true; correctable: false; outcomeUnknown: false; data: { posted: true; [key: string]: unknown } }
    | { ok: true; postAttempted: false; correctable: false; outcomeUnknown: false; data: { posted: false; reason: 'alreadyPosted'; [key: string]: unknown } }
    | { ok: false; postAttempted: true; correctable: false; outcomeUnknown: true; error: unknown };
export type ReviewValidationResult = LocationValidation | FindingValidation;
export interface PostRecord extends SubmissionDecision { actor: string; headSha: string; digest: string; status: 'unknown' | 'succeeded'; reviewId?: unknown; reviewUrl?: string | undefined }
interface PostLock { tail: Promise<void>; queued: number }
type RuntimeEvidenceFile = Omit<FileEvidenceSummary, 'bytesUsed'> & { bytesUsed?: number };
interface RuntimeSnapshot extends PullIdentity {
    pull: { state?: string | undefined; draft?: boolean | undefined; author?: string | undefined; contentDigest: string; [key: string]: unknown };
    files: RuntimeEvidenceFile[]; reviews: NormalizedReviewItem[]; reviewComments: NormalizedCommentItem[];
    issueComments: NormalizedCommentItem[]; complete: boolean; warnings: string[];
    reviewability: { status: 'complete' | 'limited-comment' | 'manifest' | 'unpostable'; inventoryComplete: boolean; feedbackComplete: boolean; patchesComplete: boolean; limitations: string[] };
    completeness: { allFilesIncluded: boolean; feedbackComplete: boolean; patchesComplete: boolean; [key: string]: unknown };
}
type ReviewMarker = { reviewId: unknown; url?: string | undefined; state?: string | undefined; author?: string | undefined; owner: string; repo: string; number: number; headSha: string; digest: string; version?: number | undefined; posture?: string | undefined; supersedes?: number | undefined };
const postLocks = new Map<string, PostLock>();
const postRecords = new Map<string, PostRecord>();
function hash(value: string): string {
    return createHash('sha256').update(value).digest('hex');
}
function postState<T extends object>(result: T, { postAttempted = false, correctable = false, outcomeUnknown = false }: { postAttempted?: boolean; correctable?: boolean; outcomeUnknown?: boolean } = {}): T & { postAttempted: boolean; correctable: boolean; outcomeUnknown: boolean } {
    return { ...result, postAttempted, correctable, outcomeUnknown };
}
function postError(error: unknown, state?: { postAttempted?: boolean; correctable?: boolean; outcomeUnknown?: boolean }) {
    return postState(errEnvelope('naru-github-post-review', error), state);
}
function isUnknownRecord(value: unknown): value is UnknownRecord {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function isUnknownArray(value: unknown): value is unknown[] {
    return Array.isArray(value);
}
function isBoundedText(value: unknown, max: number): value is string {
    return typeof value === 'string' && value.length > 0 && value.length <= max && !value.includes('\0');
}
function isPriority(value: unknown): value is Priority {
    return typeof value === 'string' && PRIORITIES.some(priority => priority === value);
}
function isSeverity(value: unknown): value is Severity {
    return typeof value === 'string' && SEVERITIES.some(severity => severity === value);
}
function isConfidence(value: unknown): value is Confidence {
    return typeof value === 'string' && CONFIDENCE.some(confidence => confidence === value);
}
function isReviewSide(value: unknown): value is ReviewSide {
    return value === 'LEFT' || value === 'RIGHT';
}
function isSnapshotId(value: unknown): value is string { return typeof value === 'string' && SNAPSHOT_ID.test(value); }
function isDigest(value: unknown): value is string { return typeof value === 'string' && DIGEST.test(value); }
function isCoveragePosture(value: unknown): value is SubmissionMode { return value === 'complete' || value === 'limited'; }
function isCoverageStatus(value: unknown): value is CoverageStatus { return typeof value === 'string' && ['reviewed', 'blocked', 'excluded'].includes(value); }
function isCoverageEvidence(value: unknown): value is CoverageEvidence { return typeof value === 'string' && ['current-patch', 'recovered-patch', 'alternate', 'none'].includes(value); }
function isSubmissionPolicy(value: unknown): value is SubmissionPolicy { return typeof value === 'string' && Object.hasOwn(SUBMISSION_POLICY_EVENTS, value); }
function isConclusion(value: unknown): value is ReviewConclusion { return typeof value === 'string' && ['informational', 'clear', 'blocking'].includes(value); }
function isFeedbackKind(value: unknown): value is FeedbackKind { return typeof value === 'string' && ['reviews', 'review-comments', 'issue-comments'].includes(value); }
function isSchemaVersion(value: unknown): value is 2 | 3 | 4 { return value === 2 || value === 3 || value === 4; }
function requireStringArray(value: unknown, name: string, max: number): string[] {
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
function normalizeTargetAliases(raw: UnknownRecord): UnknownRecord {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return raw;
    if (Object.hasOwn(raw, 'pullNumber') && Object.hasOwn(raw, 'number'))
        throw new Error('reviewResult.target cannot contain both pullNumber and number');
    if (!Object.hasOwn(raw, 'pullNumber') && Object.hasOwn(raw, 'number')) {
        const { number, ...rest } = raw;
        return { ...rest, pullNumber: number };
    }
    return raw;
}
function normalizeSnapshotAliases(raw: UnknownRecord): UnknownRecord {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return raw;
    if (Object.hasOwn(raw, 'id') && Object.hasOwn(raw, 'snapshotId'))
        throw new Error('reviewResult.snapshot cannot contain both id and snapshotId');
    if (!Object.hasOwn(raw, 'id') && Object.hasOwn(raw, 'snapshotId')) {
        const { snapshotId, ...rest } = raw;
        return { ...rest, id: snapshotId };
    }
    return raw;
}
function validateTarget(raw: unknown): ReviewTarget {
    assertPlainObject(raw, 'reviewResult.target');
    validateAllowedKeys(raw, ['owner', 'repo', 'pullNumber']);
    return {
        owner: requireField(raw, 'owner', isSafeOwner),
        repo: requireField(raw, 'repo', isSafeRepo),
        number: requireField(raw, 'pullNumber', isPositiveInteger),
    };
}
function validateSnapshot(raw: unknown): ReviewSnapshotV2V3 {
    assertPlainObject(raw, 'reviewResult.snapshot');
    validateAllowedKeys(raw, ['id', 'baseSha', 'headSha', 'feedbackDigest', 'complete', 'warnings']);
    return {
        id: requireField(raw, 'id', isSnapshotId),
        baseSha: requireField(raw, 'baseSha', is40HexSha),
        headSha: requireField(raw, 'headSha', is40HexSha),
        feedbackDigest: requireField(raw, 'feedbackDigest', isDigest),
        complete: requireField(raw, 'complete', isBoolean),
        warnings: requireStringArray(requireField(raw, 'warnings', isUnknownArray), 'reviewResult.snapshot.warnings', MAX_WARNINGS),
    };
}
function validateCoverage(raw: unknown): CoverageV2 {
    assertPlainObject(raw, 'reviewResult.coverage');
    validateAllowedKeys(raw, ['complete', 'limitations']);
    return {
        complete: requireField(raw, 'complete', isBoolean),
        limitations: requireStringArray(requireField(raw, 'limitations', isUnknownArray), 'reviewResult.coverage.limitations', MAX_WARNINGS),
    };
}
function validateV3Coverage(raw: unknown, snapshotWarnings: string[]): CoverageV3 {
    assertPlainObject(raw, 'reviewResult.coverage');
    validateAllowedKeys(raw, ['posture', 'limitations']);
    const posture = requireField(raw, 'posture', isCoveragePosture);
    const limitations = requireStringArray(requireField(raw, 'limitations', isUnknownArray), 'reviewResult.coverage.limitations', MAX_WARNINGS);
    if (posture === 'limited' && limitations.length === 0 && snapshotWarnings.length === 0)
        throw new Error('limited review evidence requires at least one coverage limitation or snapshot warning');
    return { posture, limitations };
}
function validateV4Snapshot(raw: unknown): ReviewSnapshotV4 {
    assertPlainObject(raw, 'reviewResult.snapshot');
    validateAllowedKeys(raw, ['id', 'baseSha', 'headSha', 'feedbackDigest', 'evidenceDigest', 'warnings']);
    return {
        id: requireField(raw, 'id', isSnapshotId),
        baseSha: requireField(raw, 'baseSha', is40HexSha),
        headSha: requireField(raw, 'headSha', is40HexSha),
        feedbackDigest: requireField(raw, 'feedbackDigest', isDigest),
        evidenceDigest: requireField(raw, 'evidenceDigest', isDigest),
        warnings: requireStringArray(requireField(raw, 'warnings', isUnknownArray), 'reviewResult.snapshot.warnings', MAX_WARNINGS),
    };
}
function validateCoverageEntry(raw: unknown, index: number): CoverageLedgerEntry {
    assertPlainObject(raw, `reviewResult.coverage.ledger[${index}]`);
    validateAllowedKeys(raw, ['path', 'status', 'evidence', 'note']);
    const entry: CoverageLedgerEntry = {
        path: requireField(raw, 'path', isSafeRelativePath),
        status: requireField(raw, 'status', isCoverageStatus),
        evidence: requireField(raw, 'evidence', isCoverageEvidence),
    };
    if (Object.hasOwn(raw, 'note'))
        entry.note = requireField(raw, 'note', value => isBoundedText(value, 4096));
    return entry;
}
function validateV4Coverage(raw: unknown, feedbackDigest: string): CoverageV4 {
    assertPlainObject(raw, 'reviewResult.coverage');
    validateAllowedKeys(raw, ['ledger', 'fileBatches', 'feedbackPages', 'feedbackAcknowledged', 'feedbackDigest']);
    const ledgerRaw = requireField(raw, 'ledger', isUnknownArray);
    if (ledgerRaw.length > MAX_COVERAGE_ENTRIES)
        throw new Error(`coverage ledger exceeds ${MAX_COVERAGE_ENTRIES}`);
    const ledger = ledgerRaw.map(validateCoverageEntry);
    const feedbackAcknowledged = requireField(raw, 'feedbackAcknowledged', (value: unknown): value is true => value === true);
    const acknowledgedDigest = requireField(raw, 'feedbackDigest', isDigest);
    if (acknowledgedDigest !== feedbackDigest)
        throw new Error('coverage feedback acknowledgement is not bound to snapshot feedbackDigest');
    const fileBatchesRaw = requireField(raw, 'fileBatches', isUnknownArray);
    if (fileBatchesRaw.length > MAX_COVERAGE_ENTRIES)
        throw new Error('fileBatches is too large');
    const fileBatches = fileBatchesRaw.map((batch, index) => {
        assertPlainObject(batch, `reviewResult.coverage.fileBatches[${index}]`);
        validateAllowedKeys(batch, ['paths', 'batchDigest']);
        const paths = requireStringArray(requireField(batch, 'paths', isUnknownArray), `reviewResult.coverage.fileBatches[${index}].paths`, 100);
        if (paths.length === 0 || paths.some(path => !isSafeRelativePath(path)) || new Set(paths).size !== paths.length)
            throw new Error(`reviewResult.coverage.fileBatches[${index}].paths must contain 1-100 distinct safe paths`);
        return { paths, batchDigest: requireField(batch, 'batchDigest', isDigest) };
    });
    const feedbackPagesRaw = requireField(raw, 'feedbackPages', isUnknownArray);
    if (feedbackPagesRaw.length > MAX_COVERAGE_ENTRIES)
        throw new Error('feedbackPages is too large');
    const feedbackPages = feedbackPagesRaw.map((page, index) => {
        assertPlainObject(page, `reviewResult.coverage.feedbackPages[${index}]`);
        validateAllowedKeys(page, ['kind', 'page', 'pageDigest']);
        return {
            kind: requireField(page, 'kind', isFeedbackKind),
            page: requireField(page, 'page', isPositiveInteger),
            pageDigest: requireField(page, 'pageDigest', isDigest),
        };
    });
    return { ledger, fileBatches, feedbackPages, feedbackAcknowledged, feedbackDigest: acknowledgedDigest };
}
function validateComment(raw: unknown, index: number): InlineComment {
    assertPlainObject(raw, `reviewResult.inlineComments[${index}]`);
    validateAllowedKeys(raw, ['path', 'line', 'side', 'body', 'priority', 'severity', 'confidence']);
    const path = requireField(raw, 'path', isSafeRelativePath);
    const line = requireField(raw, 'line', isPositiveInteger);
    const side = requireField(raw, 'side', isReviewSide);
    const body = requireField(raw, 'body', (value: unknown): value is string => isBoundedText(value, MAX_COMMENT_BODY_LENGTH));
    const priority = requireField(raw, 'priority', isPriority);
    const severity = requireField(raw, 'severity', isSeverity);
    const confidence = requireField(raw, 'confidence', isConfidence);
    return { path, line, side, body, priority, severity, confidence };
}
function validateSkippedComment(raw: unknown, index: number): SkippedInlineComment {
    assertPlainObject(raw, `reviewResult.skippedInlineComments[${index}]`);
    validateAllowedKeys(raw, ['path', 'line', 'side', 'reason']);
    return {
        path: requireField(raw, 'path', isSafeRelativePath),
        line: requireField(raw, 'line', isPositiveInteger),
        side: requireField(raw, 'side', isReviewSide),
        reason: requireField(raw, 'reason', (value: unknown): value is string => isBoundedText(value, 4096)),
    };
}
function validateFinding(raw: unknown, index: number): ReviewFinding {
    assertPlainObject(raw, `reviewResult.findings[${index}]`);
    validateAllowedKeys(raw, ['path', 'line', 'side', 'body', 'priority', 'severity', 'confidence']);
    const hasPath = Object.hasOwn(raw, 'path');
    const hasLine = Object.hasOwn(raw, 'line');
    const hasSide = Object.hasOwn(raw, 'side');
    if (hasLine !== hasSide || (!hasPath && (hasLine || hasSide)))
        throw new Error(`reviewResult.findings[${index}] must omit path, line, and side together, or provide path with line and side together`);
    const finding: { body: string; priority: Priority; severity: Severity; confidence: Confidence; path?: string; line?: number; side?: ReviewSide } = {
        body: requireField(raw, 'body', (value: unknown): value is string => isBoundedText(value, MAX_COMMENT_BODY_LENGTH)),
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
    return finding as ReviewFinding;
}
export function validateReviewPayload(raw: unknown): ReviewPayload {
    assertPlainObject(raw, 'input');
    validateAllowedKeys(raw, ['reviewResult']);
    const result = requireField(raw, 'reviewResult', isUnknownRecord);
    assertPlainObject(result, 'reviewResult');
    if (!isSchemaVersion(result.schemaVersion))
        throw new Error('reviewResult.schemaVersion must be 2, 3, or 4');
    const version = result.schemaVersion;
    validateAllowedKeys(result, version === 2
        ? ['schemaVersion', 'target', 'snapshot', 'coverage', 'body', 'inlineComments', 'skippedInlineComments']
        : version === 3
            ? ['schemaVersion', 'target', 'snapshot', 'coverage', 'body', 'submissionPolicy', 'conclusion', 'findings']
            : ['schemaVersion', 'target', 'snapshot', 'coverage', 'submissionMode', 'summary', 'submissionPolicy', 'conclusion', 'findings', 'supersedes']);
    const target = validateTarget(normalizeTargetAliases(requireField(result, 'target', isUnknownRecord)));
    const snapshotRaw = normalizeSnapshotAliases(requireField(result, 'snapshot', isUnknownRecord));
    if (version === 4) {
        const snapshot = validateV4Snapshot(snapshotRaw);
        const coverage = validateV4Coverage(requireField(result, 'coverage', isUnknownRecord), snapshot.feedbackDigest);
        const submissionMode = requireField(result, 'submissionMode', isCoveragePosture);
        const summary = requireField(result, 'summary', (value: unknown): value is string => isBoundedText(value, MAX_SUMMARY_LENGTH));
        if (/<!--\s*naru-review:/i.test(summary))
            throw new Error('reviewResult.summary contains a reserved Naru marker');
        const submissionPolicy = requireField(result, 'submissionPolicy', isSubmissionPolicy);
        const conclusion = requireField(result, 'conclusion', isConclusion);
        const findingsRaw = requireField(result, 'findings', isUnknownArray);
        if (findingsRaw.length > MAX_COMMENTS)
            throw new Error(`findings exceeds ${MAX_COMMENTS}`);
        let supersedes;
        if (Object.hasOwn(result, 'supersedes')) {
            assertPlainObject(result.supersedes, 'reviewResult.supersedes');
            validateAllowedKeys(result.supersedes, ['reviewId', 'digest']);
            supersedes = {
                reviewId: requireField(result.supersedes, 'reviewId', isPositiveInteger),
                digest: requireField(result.supersedes, 'digest', isDigest),
            };
        }
        return {
            schemaVersion: 4,
            target,
            snapshot,
            coverage,
            submissionMode,
            summary,
            submissionPolicy,
            conclusion,
            findings: findingsRaw.map(validateFinding),
            ...(supersedes === undefined ? {} : { supersedes }),
        };
    }
    const snapshot = validateSnapshot(snapshotRaw);
    const body = requireField(result, 'body', (value: unknown): value is string => isBoundedText(value, MAX_BODY_LENGTH - 256));
    if (/<!--\s*naru-review:/i.test(body))
        throw new Error('reviewResult.body contains a reserved Naru marker');
    if (version === 3) {
        const coverage = validateV3Coverage(requireField(result, 'coverage', isUnknownRecord), snapshot.warnings);
        const submissionPolicy = result.submissionPolicy;
        if (!isSubmissionPolicy(submissionPolicy)) {
            throw new Error('reviewResult.submissionPolicy must assert current user authorization as comment-only, approve-if-clear, request-changes-if-blocked, or select-state');
        }
        const conclusion = requireField(result, 'conclusion', isConclusion);
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
function compareCanonical(a: unknown, b: unknown): number {
    const left = JSON.stringify(a);
    const right = JSON.stringify(b);
    return left < right ? -1 : left > right ? 1 : 0;
}
function markerDigest(payload: ReviewPayload, comments: InlineComment[] | ReviewFinding[], decision: SubmissionDecision, renderedFindings = ''): string {
    const normalized = comments.map(comment => ({
        path: comment.path,
        line: comment.line,
        side: comment.side,
        body: comment.body,
    })).sort((a, b) => `${a.path}:${a.side}:${a.line}`.localeCompare(`${b.path}:${b.side}:${b.line}`));
    const legacy = {
        ...payload.target,
        headSha: payload.snapshot.headSha,
        body: payload.body ?? payload.summary,
        limitations: payload.coverage.limitations ?? [],
        comments: normalized,
    };
    if (payload.schemaVersion === 2)
        return hash(JSON.stringify(legacy));
    const v4Evidence = payload.schemaVersion === 4 ? {
        snapshotIdentity: {
            baseSha: payload.snapshot.baseSha,
            headSha: payload.snapshot.headSha,
            id: payload.snapshot.id,
            feedbackDigest: payload.snapshot.feedbackDigest,
            evidenceDigest: payload.snapshot.evidenceDigest,
        },
        boundedProvenance: {
            fileBatches: payload.coverage.fileBatches.map(batch => ({
                paths: [...batch.paths],
                batchDigest: batch.batchDigest,
            })).sort(compareCanonical),
            feedbackPages: payload.coverage.feedbackPages.map(page => ({
                kind: page.kind,
                page: page.page,
                pageDigest: page.pageDigest,
            })).sort(compareCanonical),
        },
    } : {};
    return hash(JSON.stringify({
        ...legacy,
        ...v4Evidence,
        schemaVersion: payload.schemaVersion,
        event: decision.event,
        evidencePosture: decision.evidencePosture,
        limitations: decision.limitations,
        coveragePosture: payload.coverage.posture ?? decision.evidencePosture,
        coverageLedger: (payload as ReviewPayloadV4).coverage.ledger.map(entry => ({
            path: entry.path,
            status: entry.status,
            evidence: entry.evidence,
            ...(entry.note === undefined ? {} : { note: entry.note }),
        })).sort(compareCanonical),
        submissionMode: (payload as ReviewPayloadV4).submissionMode,
        conclusion: payload.conclusion,
        submissionPolicy: payload.submissionPolicy,
        authorizationPolicy: decision.authorizationPolicy,
        findings: payload.findings,
        renderedFindings,
    }));
}
function markerTag(payload: ReviewPayload, digest: string): string {
    const { owner, repo, number } = payload.target;
    if (payload.schemaVersion === 4) {
        const supersedes = payload.supersedes ? ` supersedes=${payload.supersedes.reviewId}` : '';
        return `<!-- naru-review:${owner}/${repo}#${number} head=${payload.snapshot.headSha} digest=${digest} v=4 posture=${payload.submissionMode}${supersedes} -->`;
    }
    return `<!-- naru-review:${owner}/${repo}#${number} head=${payload.snapshot.headSha} digest=${digest} -->`;
}
function extractMarker(body: unknown): Omit<ReviewMarker, 'reviewId'> | null {
    if (typeof body !== 'string')
        return null;
    const match = body.match(/<!--\s*naru-review:([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+)#(\d+) head=([0-9a-f]{40}) digest=([0-9a-f]{64})(?: v=(\d+) posture=(complete|limited)(?: supersedes=(\d+))?)?\s*-->/i);
    if (!match)
        return null;
    const owner = match[1];
    const repo = match[2];
    const number = Number(match[3]);
    const headSha = match[4];
    const digest = match[5];
    if (!owner || !repo || !headSha || !digest)
        return null;
    return {
        owner,
        repo,
        number,
        headSha,
        digest,
        ...(match[6] ? { version: Number(match[6]) } : {}),
        ...(match[7] ? { posture: match[7] } : {}),
        ...(match[8] ? { supersedes: Number(match[8]) } : {}),
    };
}
function markersOnHead(reviews: Array<NormalizedReviewItem | NormalizedCommentItem>, target: ReviewTarget, headSha: string, actor: string): ReviewMarker[] {
    const matches: ReviewMarker[] = [];
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
            matches.push({ reviewId: review.id, url: review.url ?? review.html_url, state: review.state, author: review.author, ...marker });
        }
    }
    return matches;
}
function recoveredMarkerOnHead(reviews: Array<NormalizedReviewItem | NormalizedCommentItem>, target: ReviewTarget, headSha: string, actor: string, payload: ReviewPayloadV4, digest: string): ReviewMarker | null {
    const markers = markersOnHead(reviews, target, headSha, actor);
    const supersedes = payload.supersedes;
    const expected = markers.filter(item => item.digest === digest
        && item.version === payload.schemaVersion
        && item.posture === payload.submissionMode
        && (!supersedes || item.supersedes === supersedes.reviewId));
    if (expected.length !== 1)
        return null;
    const predecessors = supersedes ? markers.filter(item => item.reviewId === supersedes.reviewId
        && item.digest === supersedes.digest && item.version === 4 && item.posture === 'limited'
        && item.supersedes === undefined) : [];
    if (supersedes && predecessors.length !== 1)
        return null;
    const conflicts = markers.filter(item => item !== expected[0] && item !== predecessors[0]);
    return conflicts.length === 0 ? expected[0] ?? null : null;
}
function validateSupersession(payload: ReviewPayloadV4, reviews: Array<NormalizedReviewItem | NormalizedCommentItem>, actor: string, decision: SubmissionDecision): ReviewMarker | null {
    const supersedes = payload.supersedes;
    if (!supersedes)
        return null;
    if (payload.schemaVersion !== 4 || payload.submissionMode !== 'complete' || decision.evidencePosture !== 'complete')
        throw new Error('supersession requires a new complete v4 review');
    const markers = markersOnHead(reviews, payload.target, payload.snapshot.headSha, actor);
    const predecessors = markers.filter(item => item.reviewId === supersedes.reviewId && item.digest === supersedes.digest);
    if (predecessors.length !== 1)
        throw new Error('supersession predecessor is missing or ambiguous');
    const predecessor = predecessors[0];
    if (predecessor === undefined)
        throw new Error('supersession predecessor is missing');
    if (predecessor.version !== 4 || predecessor.posture !== 'limited'
        || !['COMMENT', 'COMMENTED'].includes(String(predecessor.state).toUpperCase()))
        throw new Error('supersession predecessor must be a limited v4 COMMENT');
    const eligiblePredecessors = markers.filter(item => item.version === 4 && item.posture === 'limited'
        && ['COMMENT', 'COMMENTED'].includes(String(item.state).toUpperCase()));
    if (eligiblePredecessors.length !== 1)
        throw new Error('supersession predecessor is ambiguous');
    if (markers.some(item => item.supersedes === predecessor.reviewId))
        throw new Error('supersession predecessor already has a successor');
    return predecessor;
}
function targetKey(target: ReviewTarget): string {
    return `${target.owner.toLowerCase()}/${target.repo.toLowerCase()}#${target.number}`;
}
async function withPostLock<T>(key: string, operation: () => Promise<T>): Promise<T> {
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
    let release!: (value: void) => void;
    const current = new Promise<void>(resolve => { release = resolve; });
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
function postRecord(key: string): PostRecord | null {
    const record = postRecords.get(key);
    if (!record)
        return null;
    postRecords.delete(key);
    postRecords.set(key, record);
    return record;
}
function rememberPost(key: string, record: PostRecord): void {
    postRecords.delete(key);
    postRecords.set(key, record);
    while (postRecords.size > MAX_TRACKED_POST_TARGETS) {
        const oldest = postRecords.keys().next();
        if (oldest.done)
            break;
        postRecords.delete(oldest.value);
    }
}
function alreadyPosted(reviewId: unknown, reviewUrl: string | undefined, decision: Partial<SubmissionDecision> = {}) {
    return postState(okEnvelope('naru-github-post-review', {
        posted: false,
        reason: 'alreadyPosted',
        reviewId,
        reviewUrl,
        event: decision.event,
        evidencePosture: decision.evidencePosture,
        limitations: decision.limitations,
        droppedFindings: decision.droppedFindings ?? [],
        submissionPolicy: decision.authorizationPolicy,
    }));
}
function recordedPostResult(key: string, payload: ReviewPayload, actor: string, digest: string, unknownOnly = false) {
    const record = postRecord(key);
    if (!record || record.headSha !== payload.snapshot.headSha)
        return null;
    if (record.actor !== actor.toLowerCase()) {
        return postError('a review post is already recorded for this head under a different actor; duplicate refused');
    }
    if (record.digest !== digest) {
        return postError('a different Naru review already exists on this head; duplicate refused');
    }
    if (unknownOnly && record.status !== 'unknown')
        return null;
    if (record.status === 'succeeded')
        return alreadyPosted(record.reviewId, record.reviewUrl, record);
    return postError('outcomeUnknown: a prior in-process POST attempt on this head has an unknown outcome; duplicate refused', { outcomeUnknown: true });
}
function validateCurrentComments(comments: InlineComment[], snapshot: RuntimeSnapshot): LocationValidation {
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
function isCompletePatch(file: RuntimeEvidenceFile | undefined): boolean {
    return Boolean(file && !file.patchRedacted && !file.patchTruncated && file.patchAvailable
        && (!file.patchEvidence || file.patchEvidence.status === 'complete'));
}
function isApprovalBlocker(finding: ReviewFinding): boolean {
    return (finding.priority === 'P0' || finding.priority === 'P1')
        && (finding.severity === 'Critical' || finding.severity === 'High')
        && finding.confidence === 'High';
}
function validateCurrentFindings(findings: ReviewFinding[], snapshot: RuntimeSnapshot): FindingValidation {
    const files = new Map(snapshot.files.map(file => [file.filename, file]));
    const validInline: ReviewFinding[] = [];
    const invalid: FindingValidation['invalid'] = [];
    const nonInline: FindingValidation['nonInline'] = [];
    const eligibleBlockers: ReviewFinding[] = [];
    for (const finding of findings) {
        const file = finding.path ? files.get(finding.path) : undefined;
        let reason: string | undefined;
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
function locationValidationDigest(validation: LocationValidation): string {
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
function findingValidationDigest(validation: FindingValidation): string {
    return hash(JSON.stringify({
        validInline: validation.validInline.map(({ path, line, side }) => ({ path, line, side })),
        invalid: validation.invalid.map(({ finding, reason }) => ({ path: finding.path, line: finding.line, side: finding.side, reason })),
        nonInline: validation.nonInline.map(({ finding, reason, displayPath }) => ({ body: finding.body, displayPath, line: finding.line, side: finding.side, reason })),
        eligibleBlockers: validation.eligibleBlockers.map(({ path, line, side, body }) => ({ path, line, side, body })),
    }));
}
function findingFingerprint(item: ReviewFinding | NormalizedCommentItem): string | null {
    if (!item.path || !item.line || !item.side || typeof item.body !== 'string')
        return null;
    const body = item.body.replace(/\r\n?/g, '\n').trim();
    return hash(JSON.stringify({ path: item.path, line: item.line, side: item.side.toUpperCase(), body }));
}
function suppressExactPriorFindings(findings: ReviewFinding[], snapshot: RuntimeSnapshot): { kept: ReviewFinding[]; dropped: DroppedFinding[] } {
    const prior = new Set(snapshot.reviewComments
        .filter(comment => comment.commitId === snapshot.headSha)
        .map(findingFingerprint).filter(Boolean));
    const kept: ReviewFinding[] = [];
    const dropped: DroppedFinding[] = [];
    for (const finding of findings) {
        const fingerprint = findingFingerprint(finding);
        if (fingerprint && prior.has(fingerprint))
            dropped.push({ finding, reason: 'exact duplicate of prior inline feedback', fingerprint });
        else
            kept.push(finding);
    }
    return { kept, dropped };
}
function reconcileV4Coverage(payload: ReviewPayloadV4, snapshot: RuntimeSnapshot): { posture: SubmissionMode; limitations: Array<{ path: string; status: CoverageStatus; evidence: CoverageEvidence; reason: string }> } {
    const inventory = new Map(snapshot.files.map(file => [file.filename, file]));
    const seen = new Set();
    for (const entry of payload.coverage.ledger) {
        if (seen.has(entry.path))
            throw new Error(`coverage ledger contains duplicate path: ${entry.path}`);
        seen.add(entry.path);
        if (!inventory.has(entry.path))
            throw new Error(`coverage ledger contains unknown path: ${entry.path}`);
    }
    const missing = [...inventory.keys()].filter(path => !seen.has(path));
    if (missing.length)
        throw new Error(`coverage ledger is missing ${missing.length} final snapshot path(s): ${missing.slice(0, 5).join(', ')}`);
    const limitations: Array<{ path: string; status: CoverageStatus; evidence: CoverageEvidence; reason: string }> = [];
    for (const entry of payload.coverage.ledger) {
        const file = inventory.get(entry.path);
        const currentComplete = entry.status === 'reviewed' && entry.evidence === 'current-patch' && isCompletePatch(file);
        // Recovered evidence is accepted only when the snapshot itself carries a
        // future centrally validated recovery record. Current snapshots explicitly do not.
        const recoveredComplete = entry.status === 'reviewed' && entry.evidence === 'recovered-patch'
            && file?.recoveryEvidence?.status === 'complete';
        if (!currentComplete && !recoveredComplete)
            limitations.push({ path: entry.path, status: entry.status, evidence: entry.evidence, reason: entry.note ?? file?.patchEvidence?.reason ?? 'incomplete-review-evidence' });
    }
    const posture = limitations.length === 0 ? 'complete' : 'limited';
    if (payload.submissionMode !== posture)
        throw new Error(`${posture} derived coverage requires v4 submissionMode=${posture}; submissionMode is an orchestrator assertion derived only from the current user's explicit review request`);
    return { posture, limitations };
}
function boundedSafeMarkdown(value: unknown, max: number): string {
    if (typeof value !== 'string')
        return 'not available';
    const normalized = value.replace(/\r\n?/g, '\n').replace(/[\u0001-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, ' ');
    const escaped = normalized
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('`', '&#96;');
    return escaped.length > max ? `${escaped.slice(0, max)}…` : escaped;
}
function renderNonInlineFindings(entries: FindingValidation['nonInline']): string {
    if (entries.length === 0)
        return '';
    const rendered = entries.map(({ finding, reason, displayPath }, index) => {
        const location = displayPath
            ? `${boundedSafeMarkdown(displayPath, 96)}${finding.line !== undefined ? `:${finding.line} (${finding.side})` : ''}`
            : 'not available';
        const body = boundedSafeMarkdown(finding.body, Number.MAX_SAFE_INTEGER).split('\n').map(line => `> ${line}`).join('\n');
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
function aggregateLimitations(entries: Array<string | { reason: string }>): Array<{ reason: string; count: number }> {
    const counts = new Map<string, number>();
    for (const entry of entries) {
        const reason = typeof entry === 'string' ? entry : entry.reason;
        counts.set(reason, (counts.get(reason) ?? 0) + 1);
    }
    return [...counts].sort(([a], [b]) => a.localeCompare(b)).map(([reason, count]) => ({ reason, count }));
}
function composeReviewBody(payload: ReviewPayload, decision: SubmissionDecision, findingsSection: string, marker = ''): string {
    const limitations = aggregateLimitations(decision.limitationDetails ?? decision.limitations ?? []);
    const limitationLines = limitations.map(({ reason, count }) => `- ${boundedSafeMarkdown(reason, 256)} (${count})`);
    const examples = (decision.limitationDetails ?? []).filter(item => typeof item !== 'string').slice(0, MAX_LIMITATION_EXAMPLES)
        .map(item => `- ${boundedSafeMarkdown(item.path, 128)}: ${boundedSafeMarkdown(item.reason, 192)}`);
    const limitationsSection = limitations.length ? [
        '---',
        '## Review limitations',
        ...limitationLines,
        ...(examples.length ? ['', `Examples (up to ${MAX_LIMITATION_EXAMPLES}):`, ...examples] : []),
    ].join('\n') : '';
    const limitedBanner = decision.evidencePosture === 'limited'
        ? '> [!WARNING]\n> **Limited review:** Explicitly authorized as a COMMENT because complete file evidence was unavailable.'
        : '';
    const parts = [marker, limitedBanner, payload.summary ?? payload.body, findingsSection, limitationsSection].filter(Boolean);
    const body = parts.join('\n\n');
    if (body.length > MAX_BODY_LENGTH)
        throw new Error(`composed review body exceeds ${MAX_BODY_LENGTH} characters`);
    return body;
}
function snapshotEvidenceDigest(snapshot: RuntimeSnapshot): string {
    return hash(JSON.stringify({
        state: snapshot.pull?.state,
        draft: snapshot.pull?.draft,
        author: snapshot.pull?.author,
        contentDigest: snapshot.pull?.contentDigest,
        reviewability: snapshot.reviewability,
        files: snapshot.files.map(file => ({
            filename: file.filename,
            previousFilename: file.previousFilename ?? null,
            patchEvidence: file.patchEvidence,
            patchAvailable: file.patchAvailable,
            patchTruncated: file.patchTruncated,
            patchRedacted: file.patchRedacted,
            lineMap: file.lineMap,
        })),
    }));
}
async function currentSnapshot(payload: ReviewPayload, spawn?: Spawn): Promise<RuntimeSnapshot> {
    if (payload.schemaVersion === 4)
        return boundedV4Evidence(payload, spawn);
    return pullSnapshot({
        owner: payload.target.owner,
        repo: payload.target.repo,
        number: payload.target.number,
    }, { spawn });
}
function manifestIdentity(manifest: PullManifest): PullIdentity {
    return {
        owner: manifest.owner, repo: manifest.repo, number: manifest.number,
        baseSha: manifest.baseSha, headSha: manifest.headSha, snapshotId: manifest.snapshotId,
        feedbackDigest: manifest.feedbackDigest, evidenceDigest: manifest.evidenceDigest,
    };
}
function assertPayloadManifest(payload: ReviewPayloadV4, manifest: PullManifest): void {
    const expected = {
        owner: payload.target.owner, repo: payload.target.repo, number: payload.target.number,
        baseSha: payload.snapshot.baseSha, headSha: payload.snapshot.headSha, snapshotId: payload.snapshot.id,
        feedbackDigest: payload.snapshot.feedbackDigest, evidenceDigest: payload.snapshot.evidenceDigest,
    };
    for (const [field, value] of Object.entries(expected)) {
        if (manifest[field] !== value)
            throw new Error(`bounded manifest ${field} mismatch`);
    }
}
async function boundedV4Evidence(payload: ReviewPayloadV4, spawn?: Spawn): Promise<RuntimeSnapshot> {
    const target = payload.target;
    const first = await pullManifest(target, { spawn });
    assertPayloadManifest(payload, first);
    if (first.reviewability.status === 'unpostable')
        throw new Error('snapshot reviewability is unpostable');
    const manifestPaths = new Set(first.files.map(file => file.path));
    const declaredPathSet = new Set();
    let hasUnknownPath = false;
    for (const batch of payload.coverage.fileBatches) {
        for (const path of batch.paths) {
            if (declaredPathSet.has(path))
                throw new Error('file batch declarations contain duplicate or overlapping paths');
            declaredPathSet.add(path);
            if (!manifestPaths.has(path))
                hasUnknownPath = true;
        }
    }
    if (hasUnknownPath || declaredPathSet.size !== manifestPaths.size)
        throw new Error('file batch declarations do not exactly partition the compact manifest');
    const expectedPages = [];
    for (const [kind, count] of Object.entries(first.feedback))
        for (let page = 1; page <= count.pages; page += 1)
            expectedPages.push(`${kind}:${page}`);
    const expectedPageSet = new Set(expectedPages);
    const declaredPageSet = new Set(payload.coverage.feedbackPages.map(item => `${item.kind}:${item.page}`));
    if (declaredPageSet.size !== payload.coverage.feedbackPages.length
        || declaredPageSet.size !== expectedPageSet.size
        || [...declaredPageSet].some(item => !expectedPageSet.has(item)))
        throw new Error('feedback page declarations do not exactly cover the compact manifest');
    const identity = manifestIdentity(first);
    const acquiredFileBatches = await pullFileBatchesAtManifest(first, payload.coverage.fileBatches, { spawn });
    const files = [];
    for (let index = 0; index < payload.coverage.fileBatches.length; index += 1) {
        const declaration = payload.coverage.fileBatches[index];
        const batch = acquiredFileBatches.batches[index];
        if (declaration === undefined || batch === undefined)
            throw new Error('file batch acquisition is incomplete');
        if (batch.batchDigest !== declaration.batchDigest)
            throw new Error('file batch digest mismatch');
        files.push(...batch.files.map(file => {
            const { patch: _patch, bytesUsed: _bytesUsed, ...retained } = file;
            return retained;
        }));
    }
    const feedback: Record<FeedbackKind, NormalizedCommentItem[]> = { reviews: [], 'review-comments': [], 'issue-comments': [] };
    for (const declaration of payload.coverage.feedbackPages) {
        const page = await pullFeedbackPage({ ...identity, kind: declaration.kind, page: declaration.page }, { spawn });
        if (page.pageDigest !== declaration.pageDigest)
            throw new Error('feedback page digest mismatch');
        feedback[declaration.kind].push(...page.items);
    }
    const finalManifest = await pullManifest(target, { spawn });
    assertPayloadManifest(payload, finalManifest);
    if (hash(JSON.stringify(first)) !== hash(JSON.stringify(finalManifest)))
        throw new Error('compact manifest changed during bounded evidence acquisition');
    const patchesComplete = files.every(isCompletePatch);
    const limitations = files.filter(file => !isCompletePatch(file))
        .map(file => `${file.filename}: patch evidence ${file.patchEvidence?.reason ?? 'incomplete'}`);
    return {
        ...identity,
        pull: first.pull,
        files,
        reviews: feedback.reviews,
        reviewComments: feedback['review-comments'],
        issueComments: feedback['issue-comments'],
        complete: patchesComplete,
        warnings: first.warnings,
        reviewability: {
            status: patchesComplete ? 'complete' : 'limited-comment',
            inventoryComplete: true,
            feedbackComplete: true,
            patchesComplete,
            limitations,
        },
        completeness: { allFilesIncluded: true, feedbackComplete: true, patchesComplete },
    };
}
async function boundedReviewsForRecovery(payload: ReviewPayloadV4, spawn?: Spawn): Promise<NormalizedCommentItem[]> {
    const manifest = await pullManifest(payload.target, { spawn });
    if (manifest.headSha !== payload.snapshot.headSha
        || manifest.baseSha !== payload.snapshot.baseSha
        || manifest.snapshotId !== payload.snapshot.id
        || manifest.evidenceDigest !== payload.snapshot.evidenceDigest)
        return [];
    const identity = manifestIdentity(manifest);
    const reviews: NormalizedCommentItem[] = [];
    for (let page = 1; page <= manifest.feedback.reviews.pages; page += 1) {
        const result = await pullFeedbackPage({ ...identity, kind: 'reviews', page }, { spawn });
        reviews.push(...result.items);
    }
    return reviews;
}
function snapshotIdentityError(payload: ReviewPayload, snapshot: RuntimeSnapshot): string | null {
    if (snapshot.number !== payload.target.number
        || snapshot.owner.toLowerCase() !== payload.target.owner.toLowerCase()
        || snapshot.repo.toLowerCase() !== payload.target.repo.toLowerCase()) {
        return 'canonical repository identity mismatch';
    }
    if (snapshot.headSha !== payload.snapshot.headSha)
        return 'snapshot head SHA mismatch';
    if (snapshot.baseSha !== payload.snapshot.baseSha)
        return 'snapshot base SHA mismatch';
    return null;
}
function snapshotFreshnessError(payload: ReviewPayload, snapshot: RuntimeSnapshot): string | null {
    if (snapshot.snapshotId !== payload.snapshot.id)
        return 'snapshot ID mismatch';
    if (snapshot.feedbackDigest !== payload.snapshot.feedbackDigest)
        return 'snapshot feedback digest mismatch';
    if (payload.schemaVersion === 4 && snapshot.evidenceDigest !== payload.snapshot.evidenceDigest)
        return 'snapshot evidence digest mismatch';
    if (payload.schemaVersion === 2 && !snapshot.complete)
        return 'current snapshot is incomplete; refusing to post';
    return null;
}
function reviewability(snapshot: RuntimeSnapshot) {
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
function deriveReviewSubmission(payload: ReviewPayload, initialSnapshot: RuntimeSnapshot, finalSnapshot: RuntimeSnapshot, actor: string, validation: LocationValidation | FindingValidation): SubmissionDecision {
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
    if (payload.schemaVersion === 4) {
        const coverage = reconcileV4Coverage(payload, finalSnapshot);
        const evidencePosture = coverage.posture === 'complete'
            && currentEvidence.status === 'complete' && finalEvidence.status === 'complete' ? 'complete' : 'limited';
        if (payload.submissionMode !== evidencePosture)
            throw new Error(`${evidencePosture} derived evidence requires v4 submissionMode=${evidencePosture}; limited is authorized only by an explicit current-user limited-review request`);
        // File-level snapshot limitations are already represented by the exact
        // coverage ledger. Do not duplicate them from both freshness snapshots.
        const limitationDetails = coverage.limitations;
        if (evidencePosture === 'limited' && limitationDetails.length === 0)
            throw new Error('limited v4 review requires mechanically derived limitations');
        const declaredBlockers = payload.findings.filter(isApprovalBlocker);
        const droppedBlocker = declaredBlockers.some(finding => !(validation as FindingValidation).eligibleBlockers.includes(finding));
        const formalEligible = evidencePosture === 'complete'
            && finalSnapshot.pull?.draft === false
            && typeof finalSnapshot.pull?.author === 'string'
            && finalSnapshot.pull.author.toLowerCase() !== actor.toLowerCase();
        let event: ReviewEvent = 'COMMENT';
        if (payload.submissionPolicy === 'approve-if-clear'
            && formalEligible && payload.conclusion === 'clear' && declaredBlockers.length === 0 && !droppedBlocker)
            event = 'APPROVE';
        else if (payload.submissionPolicy === 'request-changes-if-blocked'
            && formalEligible && payload.conclusion === 'blocking' && (validation as FindingValidation).eligibleBlockers.length > 0)
            event = 'REQUEST_CHANGES';
        else if (payload.submissionPolicy === 'select-state') {
            if (formalEligible && payload.conclusion === 'blocking' && (validation as FindingValidation).eligibleBlockers.length > 0)
                event = 'REQUEST_CHANGES';
            else if (formalEligible && payload.conclusion === 'clear' && declaredBlockers.length === 0 && !droppedBlocker)
                event = 'APPROVE';
        }
        if (!SUBMISSION_POLICY_EVENTS[payload.submissionPolicy].has(event))
            throw new Error('derived review event exceeds the asserted submission authorization policy');
        return {
            event, evidencePosture, limitations: aggregateLimitations(limitationDetails).map(item => `${item.reason} (${item.count})`),
            limitationDetails, droppedBlocker, authorizationPolicy: payload.submissionPolicy,
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
    const droppedBlocker = declaredBlockers.some(finding => !(validation as FindingValidation).eligibleBlockers.includes(finding));
    const formalEligible = evidencePosture === 'complete'
        && finalSnapshot.pull?.draft === false
        && typeof finalSnapshot.pull?.author === 'string'
        && finalSnapshot.pull.author.toLowerCase() !== actor.toLowerCase();
    let event: ReviewEvent = 'COMMENT';
    if (payload.submissionPolicy === 'approve-if-clear'
        && formalEligible && payload.conclusion === 'clear' && declaredBlockers.length === 0 && !droppedBlocker) {
        event = 'APPROVE';
    }
    else if (payload.submissionPolicy === 'request-changes-if-blocked'
        && formalEligible && payload.conclusion === 'blocking' && (validation as FindingValidation).eligibleBlockers.length > 0) {
        event = 'REQUEST_CHANGES';
    }
    else if (payload.submissionPolicy === 'select-state') {
        if (formalEligible && payload.conclusion === 'blocking' && (validation as FindingValidation).eligibleBlockers.length > 0)
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
async function postReviewLocked(payload: ReviewPayloadV4, spawn: Spawn | undefined, key: string) {
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
    const initialDuplicates = payload.schemaVersion === 4 ? suppressExactPriorFindings(payload.findings, snapshot) : { kept: payload.findings, dropped: [] };
    const finalDuplicates = payload.schemaVersion === 4 ? suppressExactPriorFindings(payload.findings, finalSnapshot) : initialDuplicates;
    if (hash(JSON.stringify(initialDuplicates.dropped)) !== hash(JSON.stringify(finalDuplicates.dropped)))
        return postError('prior-feedback duplicate state changed during final validation; refusing to post', { correctable: true });
    const initialPostingValidation = (payload.schemaVersion as number) === 2
        ? validateCurrentComments(payload.inlineComments!, snapshot)
        : validateCurrentFindings(initialDuplicates.kept, snapshot);
    const finalPostingValidation = (payload.schemaVersion as number) === 2
        ? validateCurrentComments(payload.inlineComments!, finalSnapshot)
        : validateCurrentFindings(finalDuplicates.kept, finalSnapshot);
    // Current-head exact duplicates are suppressed only from emitted comments.
    // They remain declared findings and are revalidated for formal decisions.
    const initialDecisionValidation = payload.schemaVersion === 4
        ? validateCurrentFindings(payload.findings, snapshot)
        : initialPostingValidation;
    const finalDecisionValidation = payload.schemaVersion === 4
        ? validateCurrentFindings(payload.findings, finalSnapshot)
        : finalPostingValidation;
    const validationChanged = (payload.schemaVersion as number) === 2
        ? locationValidationDigest(finalPostingValidation as LocationValidation) !== locationValidationDigest(initialPostingValidation as LocationValidation)
        : findingValidationDigest(finalPostingValidation as FindingValidation) !== findingValidationDigest(initialPostingValidation as FindingValidation)
            || findingValidationDigest(finalDecisionValidation as FindingValidation) !== findingValidationDigest(initialDecisionValidation as FindingValidation);
    if (validationChanged)
        return postError('finding locations or evidence changed during final validation; refusing to post', { correctable: true });
    let decision;
    try {
        decision = deriveReviewSubmission(payload, snapshot, finalSnapshot, actor, finalDecisionValidation);
    }
    catch (error) {
        return postError(safeError(error), { correctable: true });
    }
    const droppedFindings: DroppedFinding[] = finalDuplicates.dropped.map(entry => ({
        ...entry,
        suppressedFromPosting: true,
        retainedForDecision: true,
        eligibleBlocker: (finalDecisionValidation as FindingValidation).eligibleBlockers.includes(entry.finding),
    }));
    decision.droppedFindings = droppedFindings;
    const validComments = (payload.schemaVersion as number) === 2 ? (finalPostingValidation as LocationValidation).valid : (finalPostingValidation as FindingValidation).validInline;
    const droppedComments = (payload.schemaVersion as number) === 2 ? (finalPostingValidation as LocationValidation).dropped : (finalPostingValidation as FindingValidation).invalid;
    let findingsSection = '';
    try {
        findingsSection = (payload.schemaVersion as number) === 2 ? '' : renderNonInlineFindings((finalPostingValidation as FindingValidation).nonInline);
    }
    catch (error) {
        return postError(safeError(error), { correctable: true });
    }
    let bodyWithoutMarker;
    try {
        bodyWithoutMarker = composeReviewBody(payload, decision, findingsSection);
    }
    catch (error) {
        return postError(safeError(error), { correctable: true });
    }
    const digest = markerDigest(payload, validComments, decision, bodyWithoutMarker);
    const recordKey = payload.supersedes ? `${key}:supersedes:${payload.supersedes.reviewId}` : key;
    const existingMarkers = markersOnHead(finalSnapshot.reviews, payload.target, finalSnapshot.headSha, actor);
    const matchingExisting = payload.supersedes
        ? recoveredMarkerOnHead(finalSnapshot.reviews, payload.target, finalSnapshot.headSha, actor, payload, digest)
        : existingMarkers.find(item => item.digest === digest);
    if (matchingExisting) {
        rememberPost(recordKey, {
            actor: actor.toLowerCase(), headSha: finalSnapshot.headSha, digest,
            status: 'succeeded', reviewId: matchingExisting.reviewId, reviewUrl: matchingExisting.url,
            event: decision.event, evidencePosture: decision.evidencePosture,
            limitations: decision.limitations,
            droppedFindings,
            authorizationPolicy: decision.authorizationPolicy,
        });
        return alreadyPosted(matchingExisting.reviewId, matchingExisting.url, decision);
    }
    if (payload.supersedes) {
        const terminalUnknown = recordedPostResult(recordKey, payload, actor, digest, true);
        if (terminalUnknown)
            return terminalUnknown;
    }
    let predecessor;
    try {
        predecessor = validateSupersession(payload, finalSnapshot.reviews, actor, decision);
    }
    catch (error) {
        return postError(safeError(error), { correctable: true });
    }
    if (existingMarkers.length > 0 && !predecessor)
        return postError('a different Naru review already exists on this head; duplicate refused');
    const recorded = recordedPostResult(recordKey, payload, actor, digest);
    if (recorded)
        return recorded;
    const marker = markerTag(payload, digest);
    let body;
    try {
        body = composeReviewBody(payload, decision, findingsSection, marker);
    }
    catch (error) {
        return postError(safeError(error), { correctable: true });
    }
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
    rememberPost(recordKey, {
        actor: actor.toLowerCase(),
        headSha: finalSnapshot.headSha,
        digest,
        status: 'unknown',
        event: decision.event,
        evidencePosture: decision.evidencePosture,
        limitations: decision.limitations,
        droppedFindings,
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
                rememberPost(recordKey, {
                    actor: actor.toLowerCase(),
                    headSha: finalSnapshot.headSha,
                    digest,
                    status: 'succeeded',
                    reviewId: result.id,
                    reviewUrl,
                    event: decision.event,
                    evidencePosture: decision.evidencePosture,
                    limitations: decision.limitations,
                    droppedFindings,
                    authorizationPolicy: decision.authorizationPolicy,
                });
                return postState(okEnvelope('naru-github-post-review', {
                    posted: true,
                    reviewId: result.id,
                    reviewUrl,
                    commentsPosted: ghPayload.comments.length,
                    droppedComments,
                    droppedFindings,
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
        const reviews = payload.schemaVersion === 4
            ? await boundedReviewsForRecovery(payload, spawn)
            : (await currentSnapshot(payload, spawn)).reviews;
        const recovered = recoveredMarkerOnHead(reviews, payload.target, finalSnapshot.headSha, actor, payload, digest);
        if (recovered) {
            rememberPost(recordKey, {
                actor: actor.toLowerCase(),
                headSha: finalSnapshot.headSha,
                digest,
                status: 'succeeded',
                reviewId: recovered.reviewId,
                reviewUrl: recovered.url,
                event: decision.event,
                evidencePosture: decision.evidencePosture,
                limitations: decision.limitations,
                droppedFindings,
                authorizationPolicy: decision.authorizationPolicy,
            });
            return postState(okEnvelope('naru-github-post-review', {
                posted: true,
                recovered: true,
                reviewId: recovered.reviewId,
                reviewUrl: recovered.url,
                commentsPosted: ghPayload.comments.length,
                droppedComments,
                droppedFindings,
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
export async function postReview(rawPayload: unknown, context: unknown, { spawn }: { spawn?: Spawn | undefined } = {}) {
    if (!isUnknownRecord(context) || !POSTING_AGENTS.has(typeof context.agent === 'string' ? context.agent : '')) {
        return postError('caller agent identity mismatch');
    }
    let payload;
    try {
        payload = validateReviewPayload(rawPayload);
    }
    catch (error) {
        return postError(`invalid input: ${safeError(error)}`, { correctable: true });
    }
    if (payload.schemaVersion !== 4)
        return postError('schema v2/v3 is recognized only for existing-marker compatibility; create a schema v4 review before posting', { correctable: true });
    const preflightMarker = markerTag(payload, '0'.repeat(64));
    if (`${preflightMarker}\n${payload.summary}`.length > MAX_BODY_LENGTH)
        return postError(`composed review body exceeds ${MAX_BODY_LENGTH} characters`, { correctable: true });
    const key = targetKey(payload.target);
    try {
        return await withPostLock(key, () => postReviewLocked(payload, spawn, key));
    }
    catch (error) {
        return postError(`review post coordination failed: ${safeError(error)}`);
    }
}
