// naru-github-post-review: post exactly one tool-authorized PR review.
// The filename defines the OpenCode tool ID.
import { postReview } from './naru-lib/review.mjs';
const githubPostReviewTool = {
    description: 'Post a single PR review from a validated schema v2 or v3 naru_review_result payload. ' +
        'Requires context.agent to be exactly "naru-orchestrator". The tool derives the GitHub event within the asserted submission authorization policy. ' +
        'V2 is complete-evidence COMMENT-only; v3 permits evidence-gated formal decisions and limited COMMENT reviews. ' +
        'Deduplicates via a hidden marker digest and never retries a POST.',
    args: {
        input: {
            type: 'object',
            description: 'Strict schemaVersion 2 or 3 naru_review_result payload. Runtime version-specific validation is authoritative.',
            properties: {
                reviewResult: {
                    type: 'object',
                    description: 'Versioned review result. V2 requires inlineComments and skippedInlineComments and is COMMENT-only. V3 requires submissionPolicy, conclusion, and findings; callers cannot supply a GitHub event.',
                    properties: {
                        schemaVersion: { type: 'integer', enum: [2, 3] },
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
                                complete: { type: 'boolean' },
                                warnings: { type: 'array', items: { type: 'string' } },
                            },
                            required: ['baseSha', 'headSha', 'feedbackDigest', 'complete', 'warnings'],
                            additionalProperties: false,
                        },
                        coverage: {
                            type: 'object',
                            description: 'V2 requires complete:boolean and limitations. V3 requires posture (complete or limited) and limitations; limited posture requires at least one limitation.',
                            properties: {
                                complete: { type: 'boolean' },
                                posture: { type: 'string', enum: ['complete', 'limited'] },
                                limitations: { type: 'array', items: { type: 'string' } },
                            },
                            required: ['limitations'],
                            additionalProperties: false,
                        },
                        body: { type: 'string' },
                        inlineComments: {
                            type: 'array',
                            items: {
                                type: 'object',
                                properties: {
                                    path: { type: 'string' }, line: { type: 'integer', minimum: 1 },
                                    side: { type: 'string', enum: ['LEFT', 'RIGHT'] }, body: { type: 'string' },
                                    priority: { type: 'string', enum: ['P0', 'P1', 'P2', 'P3'] },
                                    severity: { type: 'string', enum: ['Critical', 'High', 'Medium', 'Low'] },
                                    confidence: { type: 'string', enum: ['High', 'Medium', 'Low'] },
                                },
                                required: ['path', 'line', 'side', 'body', 'priority', 'severity', 'confidence'],
                                additionalProperties: false,
                            },
                        },
                        skippedInlineComments: {
                            type: 'array',
                            items: {
                                type: 'object',
                                properties: {
                                    path: { type: 'string' }, line: { type: 'integer', minimum: 1 },
                                    side: { type: 'string', enum: ['LEFT', 'RIGHT'] }, reason: { type: 'string' },
                                },
                                required: ['path', 'line', 'side', 'reason'],
                                additionalProperties: false,
                            },
                        },
                        submissionPolicy: {
                            type: 'string',
                            enum: ['comment-only', 'approve-if-clear', 'request-changes-if-blocked', 'select-state'],
                            description: 'V3 only. The orchestrator asserts the current user authorization: comment-only allows COMMENT; approve-if-clear allows COMMENT or APPROVE; request-changes-if-blocked allows COMMENT or REQUEST_CHANGES; select-state allows all three. The tool derives within that exact set after final evidence validation.',
                        },
                        conclusion: {
                            type: 'string',
                            enum: ['informational', 'clear', 'blocking'],
                            description: 'V3 only. Declared conclusion; never interpreted from prose.',
                        },
                        findings: {
                            type: 'array',
                            description: 'V3 only. A finding is either unlocated (omit path, line, side), path-level (path only), or inline (path with both line and side).',
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
                    },
                    required: ['schemaVersion', 'target', 'snapshot', 'coverage', 'body'],
                    additionalProperties: false,
                },
            },
            required: ['reviewResult'],
            additionalProperties: false,
        },
    },
    execute: async (args = {}, context = {}) => {
        const input = args && typeof args === 'object' ? args.input : undefined;
        const result = await postReview(input, context, { spawn: context?.spawn });
        return JSON.stringify(result, null, 2);
    },
};
export default githubPostReviewTool;
