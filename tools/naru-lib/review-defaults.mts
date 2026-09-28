import type { RuntimeReviewConfig } from './runtime-config.mjs';
const REVIEW_APPENDIX_BEGIN = '<!-- naru-review-defaults:begin -->';
const REVIEW_APPENDIX_END = '<!-- naru-review-defaults:end -->';

export function buildReviewDefaultsAppendix(review: RuntimeReviewConfig): string {
    return [
        REVIEW_APPENDIX_BEGIN,
        '',
        '## Review defaults (generated from naru-runtime.json)',
        '',
        `Effective defaults: profile=${review.defaultProfile}; decision=${review.defaultDecision}; output=${review.defaultOutput}.`,
        'Persistent configuration never authorizes a post or formal review state. For generic',
        'current-message post/comment/submit requests, decision is always comment-only even when',
        'defaultDecision=automatic. Only the native /naru ship-review invocation itself authorizes',
        'automatic select-state for its finite targets; it also supplies release-critical/concise defaults.',
        '',
        REVIEW_APPENDIX_END,
    ].join('\n');
}
