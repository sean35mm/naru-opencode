// naru-github-post-review: post exactly one comment-only PR review.
// The filename defines the OpenCode tool ID.

import { postReview } from './naru-lib/review.mjs';

export default {
  description:
    'Post a single comment-only PR review from a validated naru_review_result payload. ' +
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
        },
      },
      required: ['reviewResult'],
      additionalProperties: false,
    },
  },
  execute: async (args, context) => {
    const input = args && typeof args === 'object' ? args.input : undefined;
    const result = await postReview(input, context, { spawn: context?.spawn });
    return JSON.stringify(result, null, 2);
  },
};
