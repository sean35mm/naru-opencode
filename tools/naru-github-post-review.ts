// naru-github-post-review: post exactly one tool-authorized PR review.
// The filename defines the OpenCode tool ID.
import { postReview } from './naru-lib/review.mjs';
import type { ReviewPayloadV5 } from './naru-lib/review.mjs';
import type { Spawn } from './naru-lib/transport.mjs';

interface GitHubPostReviewArgs { input?: { reviewResult?: ReviewPayloadV5 } }
interface GitHubPostReviewContext { agent?: string; spawn?: Spawn; [key: string]: unknown }
interface GitHubPostReviewTool {
    description: string;
    args: Record<string, unknown>;
    execute(args?: GitHubPostReviewArgs, context?: GitHubPostReviewContext): Promise<string>;
}

const SAFE_OWNER_PATTERN = '^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$';
const SAFE_REPO_PATTERN = '^[A-Za-z0-9._-]+$';
const SAFE_PATH_PATTERN = '^(?!/)(?![A-Za-z]:[\\\\/])(?!.*\\.\\.)(?!.*[\\u0000-\\u001F])(?!.*(?:^|[\\\\/])(?:\\.git|\\.svn|\\.hg|node_modules|\\.env|\\.envrc|\\.npmrc|\\.pypirc|\\.dockerconfigjson|\\.aws|\\.ssh|\\.kube|\\.gnupg|id_rsa|id_dsa|id_ecdsa|id_ed25519)(?:[\\\\/]|$))[^\\u0000-\\u001F]+$';
const NON_NUL_PATTERN = '^[^\\u0000]+$';
const NO_CONTROL_PATTERN = '^[^\\u0000-\\u001F]+$';
const MAX_SAFE_INTEGER = Number.MAX_SAFE_INTEGER;

const githubPostReviewTool: GitHubPostReviewTool = {
    description: 'Post a single PR review from a validated schema v5 manifest-bound naru_review_result payload. ' +
        'Requires context.agent to be exactly "naru-orchestrator". The tool derives the GitHub event within the asserted submission authorization policy. ' +
        'Legacy v2/v3/v4 markers remain recognizable but cannot create a new review. V5 derives coverage and formal-decision eligibility from final evidence. ' +
        'Deduplicates via a hidden marker digest and never retries a POST.',
    args: {
        input: {
            type: 'object',
            description: 'Strict schemaVersion 5 naru_review_result payload. Runtime validation is authoritative.',
            properties: {
                reviewResult: {
                    type: 'object',
                    description: 'Manifest-bound v5 review result; callers cannot supply a GitHub event or assert complete coverage.',
                    properties: {
                        schemaVersion: { type: 'integer', enum: [5] },
                        target: {
                            type: 'object',
                            description: 'Repository target. Supply exactly one of pullNumber or number.',
                            properties: {
                                owner: { type: 'string', minLength: 1, maxLength: 39, pattern: SAFE_OWNER_PATTERN },
                                repo: { type: 'string', minLength: 1, maxLength: 100, pattern: SAFE_REPO_PATTERN },
                                pullNumber: { type: 'integer', minimum: 1, maximum: MAX_SAFE_INTEGER, description: 'Canonical pull request number; supply exactly one of pullNumber or number.' },
                                number: { type: 'integer', minimum: 1, maximum: MAX_SAFE_INTEGER, description: 'Alias for pullNumber; supply exactly one of pullNumber or number.' },
                            },
                            required: ['owner', 'repo'],
                            additionalProperties: false,
                        },
                        snapshot: {
                            type: 'object',
                            description: 'Fresh review snapshot. Supply exactly one of id or snapshotId.',
                            properties: {
                                id: { type: 'string', pattern: '^naru-snap-[0-9a-f]{64}$', description: 'Canonical snapshot ID; supply exactly one of id or snapshotId.' },
                                snapshotId: { type: 'string', pattern: '^naru-snap-[0-9a-f]{64}$', description: 'Alias for id; supply exactly one of id or snapshotId.' },
                                baseSha: { type: 'string', pattern: '^[0-9a-fA-F]{40}$' },
                                diffBaseSha: { type: 'string', pattern: '^[0-9a-fA-F]{40}$' },
                                headOwner: { type: 'string', minLength: 1, maxLength: 39, pattern: SAFE_OWNER_PATTERN },
                                headRepo: { type: 'string', minLength: 1, maxLength: 100, pattern: SAFE_REPO_PATTERN },
                                headSha: { type: 'string', pattern: '^[0-9a-fA-F]{40}$' },
                                feedbackDigest: { type: 'string', pattern: '^[0-9a-f]{64}$' },
                                evidenceDigest: { type: 'string', pattern: '^[0-9a-f]{64}$' },
                                warnings: { type: 'array', maxItems: 100, items: { type: 'string', minLength: 1, maxLength: 4096, pattern: NO_CONTROL_PATTERN } },
                            },
                            required: ['baseSha', 'diffBaseSha', 'headOwner', 'headRepo', 'headSha', 'feedbackDigest', 'evidenceDigest', 'warnings'],
                            additionalProperties: false,
                        },
                        coverage: {
                            type: 'object',
                            description: 'Exact one-entry-per-final-path ledger plus acknowledgement of the prior-feedback digest. The tool derives posture.',
                            properties: {
                                ledger: { type: 'array', maxItems: 3000, items: {
                                    type: 'object',
                                    properties: {
                                        path: { type: 'string', minLength: 1, maxLength: 4096, pattern: SAFE_PATH_PATTERN },
                                        status: { type: 'string', enum: ['reviewed', 'blocked', 'excluded'] },
                                        evidence: { type: 'string', enum: ['current-patch', 'recovered-patch', 'alternate', 'none'] },
                                        note: { type: 'string', minLength: 1, maxLength: 4096, pattern: NON_NUL_PATTERN },
                                    },
                                    required: ['path', 'status', 'evidence'],
                                    additionalProperties: false,
                                } },
                                fileBatches: { type: 'array', maxItems: 3000, items: {
                                    type: 'object', properties: {
                                        paths: { type: 'array', minItems: 1, maxItems: 100, uniqueItems: true, items: { type: 'string', minLength: 1, maxLength: 4096, pattern: SAFE_PATH_PATTERN } },
                                        batchDigest: { type: 'string', pattern: '^[0-9a-f]{64}$' },
                                    }, required: ['paths', 'batchDigest'], additionalProperties: false,
                                } },
                                recoveryBatches: { type: 'array', maxItems: 3000, items: {
                                    type: 'object', properties: {
                                        paths: { type: 'array', minItems: 1, maxItems: 100, uniqueItems: true, items: { type: 'string', minLength: 1, maxLength: 4096, pattern: SAFE_PATH_PATTERN } },
                                        recoveryBatchDigest: { type: 'string', pattern: '^[0-9a-f]{64}$' },
                                    }, required: ['paths', 'recoveryBatchDigest'], additionalProperties: false,
                                } },
                                feedbackPages: { type: 'array', maxItems: 3000, items: {
                                    type: 'object', properties: {
                                        kind: { type: 'string', enum: ['reviews', 'review-comments', 'issue-comments'] },
                                        page: { type: 'integer', minimum: 1, maximum: MAX_SAFE_INTEGER },
                                        pageDigest: { type: 'string', pattern: '^[0-9a-f]{64}$' },
                                    }, required: ['kind', 'page', 'pageDigest'], additionalProperties: false,
                                } },
                                feedbackAcknowledged: { type: 'boolean', enum: [true] },
                                feedbackDigest: { type: 'string', pattern: '^[0-9a-f]{64}$' },
                            },
                            required: ['ledger', 'fileBatches', 'recoveryBatches', 'feedbackPages', 'feedbackAcknowledged', 'feedbackDigest'],
                            additionalProperties: false,
                        },
                        submissionMode: { type: 'string', enum: ['complete', 'limited'], description: 'V5 orchestrator assertion derived only from the current user request. limited requires explicit limited-review authorization, must match mechanically derived posture, and always posts COMMENT.' },
                        summary: { type: 'string', minLength: 1, maxLength: 8192, pattern: NON_NUL_PATTERN, description: 'Short caller summary; findings and limitations are rendered by the tool.' },
                        submissionPolicy: {
                            type: 'string',
                            enum: ['comment-only', 'approve-if-clear', 'request-changes-if-blocked', 'select-state'],
                            description: 'V5 current-message authorization: comment-only allows COMMENT; approve-if-clear allows COMMENT or APPROVE; request-changes-if-blocked allows COMMENT or REQUEST_CHANGES; select-state allows all three.',
                        },
                        reviewProfile: {
                            type: 'string', enum: ['standard', 'release-critical'],
                            description: 'Required review focus. release-critical accepts only qualifying release risks and mechanically derives conclusion.',
                        },
                        outputMode: { type: 'string', enum: ['concise', 'detailed'] },
                        objectiveAssessment: {
                            type: 'object',
                            description: 'Bounded objective assessment derived manifest-first from untrusted PR text or from the current request.',
                            properties: {
                                source: { type: 'string', enum: ['pull-request', 'current-request'] },
                                status: { type: 'string', enum: ['met', 'missed', 'unclear'] },
                                confidence: { type: 'string', enum: ['High', 'Medium', 'Low'] },
                                summary: { type: 'string', minLength: 1, maxLength: 2048, pattern: NON_NUL_PATTERN },
                                rationale: { type: 'string', minLength: 1, maxLength: 4096, pattern: NON_NUL_PATTERN },
                            },
                            required: ['source', 'status', 'confidence', 'summary', 'rationale'],
                            additionalProperties: false,
                        },
                        conclusion: {
                            type: 'string',
                            enum: ['informational', 'clear', 'blocking'],
                            description: 'For release-critical, must equal the mechanically derived conclusion.',
                        },
                        findings: {
                            type: 'array',
                            maxItems: 100,
                            description: 'A finding is either unlocated (omit path, line, side), path-level (path only), or inline (path with both line and side).',
                            items: {
                                type: 'object',
                                properties: {
                                    path: { type: 'string', minLength: 1, maxLength: 4096, pattern: SAFE_PATH_PATTERN, description: 'Optional safe current-snapshot path.' },
                                    line: { type: 'integer', minimum: 1, maximum: MAX_SAFE_INTEGER, description: 'Optional; when present side and path are also required.' },
                                    side: { type: 'string', enum: ['LEFT', 'RIGHT'], description: 'Optional; when present line and path are also required.' },
                                    body: { type: 'string', minLength: 1, maxLength: 32768, pattern: NON_NUL_PATTERN },
                                    priority: { type: 'string', enum: ['P0', 'P1', 'P2', 'P3'] },
                                    severity: { type: 'string', enum: ['Critical', 'High', 'Medium', 'Low'] },
                                    confidence: { type: 'string', enum: ['High', 'Medium', 'Low'] },
                                },
                                required: ['body', 'priority', 'severity', 'confidence'],
                                additionalProperties: false,
                            },
                        },
                        supersedes: {
                            type: 'object',
                            description: 'Optional explicit same-head limited-v4/v5 to complete-v5 supersession authorization.',
                            properties: {
                                reviewId: { type: 'integer', minimum: 1, maximum: MAX_SAFE_INTEGER },
                                digest: { type: 'string', pattern: '^[0-9a-f]{64}$' },
                            },
                            required: ['reviewId', 'digest'],
                            additionalProperties: false,
                        },
                    },
                    required: ['schemaVersion', 'target', 'snapshot', 'coverage', 'submissionMode', 'summary', 'submissionPolicy', 'reviewProfile', 'outputMode', 'objectiveAssessment', 'conclusion', 'findings'],
                    additionalProperties: false,
                },
            },
            required: ['reviewResult'],
            additionalProperties: false,
        },
    },
    execute: async (args = {}, context = {}) => {
        const input = args.input;
        const result = await postReview(input, context, { spawn: context?.spawn });
        return JSON.stringify(result, null, 2);
    },
};
export default githubPostReviewTool;
