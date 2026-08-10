// naru-github-post-review: post exactly one comment-only PR review.
// The filename defines the OpenCode tool ID.
import { postReview } from './naru-lib/review.mjs';
const githubPostReviewTool = {
    description: 'Post a single comment-only PR review from a validated naru_review_result payload. ' +
        'Requires context.agent to be exactly "naru-orchestrator". Hard-coded event COMMENT. ' +
        'Rejects incomplete coverage. ' +
        'Deduplicates via a hidden marker digest and never retries a POST.',
    args: {
        input: {
            type: 'object',
            description: 'Strict schemaVersion 2 naru_review_result payload.',
            properties: {
                reviewResult: {
                    type: 'object',
                    description: 'The complete schemaVersion 2 naru_review_result object emitted by naru-orchestrator.',
                    properties: {
                        schemaVersion: { type: 'integer', enum: [2] },
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
                            properties: {
                                complete: { type: 'boolean' },
                                limitations: { type: 'array', items: { type: 'string' } },
                            },
                            required: ['complete', 'limitations'],
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
                    },
                    required: ['schemaVersion', 'target', 'snapshot', 'coverage', 'body', 'inlineComments', 'skippedInlineComments'],
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
