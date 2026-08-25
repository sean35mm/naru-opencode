// naru-github-post-review: post exactly one tool-authorized PR review.
// The filename defines the OpenCode tool ID.
import { postReview } from './naru-lib/review.mjs';
import type { ReviewPayloadV4 } from './naru-lib/review.mjs';
import type { Spawn } from './naru-lib/transport.mjs';

interface GitHubPostReviewArgs { input?: { reviewResult?: ReviewPayloadV4 } }
interface GitHubPostReviewContext { agent?: string; spawn?: Spawn; [key: string]: unknown }
interface GitHubPostReviewTool {
    description: string;
    args: Record<string, unknown>;
    execute(args?: GitHubPostReviewArgs, context?: GitHubPostReviewContext): Promise<string>;
}

const githubPostReviewTool: GitHubPostReviewTool = {
    description: 'Post a single PR review from a validated schema v4 manifest-bound naru_review_result payload. ' +
        'Requires context.agent to be exactly "naru-orchestrator". The tool derives the GitHub event within the asserted submission authorization policy. ' +
        'Legacy v2/v3 markers remain recognizable but cannot create a new review. V4 derives coverage and formal-decision eligibility from final evidence. ' +
        'Deduplicates via a hidden marker digest and never retries a POST.',
    args: {
        input: {
            type: 'object',
            description: 'Strict schemaVersion 4 naru_review_result payload. Runtime validation is authoritative.',
            properties: {
                reviewResult: {
                    type: 'object',
                    description: 'Manifest-bound v4 review result; callers cannot supply a GitHub event or assert complete coverage.',
                    properties: {
                        schemaVersion: { type: 'integer', enum: [4] },
                        target: {
                            type: 'object',
                            description: 'Repository target. Supply exactly one of pullNumber or number.',
                            properties: {
                                owner: { type: 'string' },
                                repo: { type: 'string' },
                                pullNumber: { type: 'integer', minimum: 1, description: 'Canonical pull request number; supply exactly one of pullNumber or number.' },
                                number: { type: 'integer', minimum: 1, description: 'Alias for pullNumber; supply exactly one of pullNumber or number.' },
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
                                baseSha: { type: 'string', pattern: '^[0-9a-f]{40}$' },
                                headSha: { type: 'string', pattern: '^[0-9a-f]{40}$' },
                                feedbackDigest: { type: 'string', pattern: '^[0-9a-f]{64}$' },
                                evidenceDigest: { type: 'string', pattern: '^[0-9a-f]{64}$' },
                                warnings: { type: 'array', items: { type: 'string' } },
                            },
                            required: ['baseSha', 'headSha', 'feedbackDigest', 'evidenceDigest', 'warnings'],
                            additionalProperties: false,
                        },
                        coverage: {
                            type: 'object',
                            description: 'Exact one-entry-per-final-path ledger plus acknowledgement of the prior-feedback digest. The tool derives posture.',
                            properties: {
                                ledger: { type: 'array', maxItems: 3000, items: {
                                    type: 'object',
                                    properties: {
                                        path: { type: 'string' },
                                        status: { type: 'string', enum: ['reviewed', 'blocked', 'excluded'] },
                                        evidence: { type: 'string', enum: ['current-patch', 'recovered-patch', 'alternate', 'none'] },
                                        note: { type: 'string' },
                                    },
                                    required: ['path', 'status', 'evidence'],
                                    additionalProperties: false,
                                } },
                                fileBatches: { type: 'array', maxItems: 3000, items: {
                                    type: 'object', properties: {
                                        paths: { type: 'array', minItems: 1, maxItems: 100, items: { type: 'string' } },
                                        batchDigest: { type: 'string', pattern: '^[0-9a-f]{64}$' },
                                    }, required: ['paths', 'batchDigest'], additionalProperties: false,
                                } },
                                feedbackPages: { type: 'array', maxItems: 3000, items: {
                                    type: 'object', properties: {
                                        kind: { type: 'string', enum: ['reviews', 'review-comments', 'issue-comments'] },
                                        page: { type: 'integer', minimum: 1 },
                                        pageDigest: { type: 'string', pattern: '^[0-9a-f]{64}$' },
                                    }, required: ['kind', 'page', 'pageDigest'], additionalProperties: false,
                                } },
                                feedbackAcknowledged: { type: 'boolean', enum: [true] },
                                feedbackDigest: { type: 'string', pattern: '^[0-9a-f]{64}$' },
                            },
                            required: ['ledger', 'fileBatches', 'feedbackPages', 'feedbackAcknowledged', 'feedbackDigest'],
                            additionalProperties: false,
                        },
                        submissionMode: { type: 'string', enum: ['complete', 'limited'], description: 'V4 orchestrator assertion derived only from the current user request. limited requires explicit limited-review authorization, must match mechanically derived posture, and always posts COMMENT.' },
                        summary: { type: 'string', maxLength: 8192, description: 'Short caller summary; findings and limitations are rendered by the tool.' },
                        submissionPolicy: {
                            type: 'string',
                            enum: ['comment-only', 'approve-if-clear', 'request-changes-if-blocked', 'select-state'],
                            description: 'V4 current-message authorization: comment-only allows COMMENT; approve-if-clear allows COMMENT or APPROVE; request-changes-if-blocked allows COMMENT or REQUEST_CHANGES; select-state allows all three.',
                        },
                        conclusion: {
                            type: 'string',
                            enum: ['informational', 'clear', 'blocking'],
                            description: 'V4 declared conclusion; never interpreted from prose.',
                        },
                        findings: {
                            type: 'array',
                            description: 'A finding is either unlocated (omit path, line, side), path-level (path only), or inline (path with both line and side).',
                            items: {
                                type: 'object',
                                properties: {
                                    path: { type: 'string', description: 'Optional safe current-snapshot path.' },
                                    line: { type: 'integer', minimum: 1, description: 'Optional; when present side and path are also required.' },
                                    side: { type: 'string', enum: ['LEFT', 'RIGHT'], description: 'Optional; when present line and path are also required.' },
                                    body: { type: 'string' },
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
                            description: 'Optional explicit same-head limited-v4 to complete-v4 supersession authorization.',
                            properties: {
                                reviewId: { type: 'integer', minimum: 1 },
                                digest: { type: 'string', pattern: '^[0-9a-f]{64}$' },
                            },
                            required: ['reviewId', 'digest'],
                            additionalProperties: false,
                        },
                    },
                    required: ['schemaVersion', 'target', 'snapshot', 'coverage', 'submissionMode', 'summary', 'submissionPolicy', 'conclusion', 'findings'],
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
