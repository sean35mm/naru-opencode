// naru-github-read: read-only GitHub inspection for OpenCode custom tools.
// The filename defines the OpenCode tool ID.
import { parseReference, resolveBareNumber, fetchIssue, pullSnapshot, pullManifest, pullFilesAtHead, pullFeedbackPage, fetchSourceAtSha, } from './naru-lib/github.mjs';
import type { FeedbackKind } from './naru-lib/github.mjs';
import { okEnvelope, errEnvelope } from './naru-lib/output.mjs';
import type { Spawn } from './naru-lib/transport.mjs';
import { assertPlainObject, validateAllowedKeys, validateStringEnum, isSafeOwner, isSafeRepo, isPositiveInteger, is40HexSha, isSafeRelativePath, isNonEmptyString, safeError, requireField, } from './naru-lib/validate.mjs';
const OPERATIONS = ['resolve', 'issue', 'pull', 'pull-manifest', 'pull-files', 'pull-feedback', 'source'] as const;
type GitHubOperation = typeof OPERATIONS[number];
interface ResolveInput { operation: 'resolve'; reference: string }
interface TargetInput { owner: string; repo: string; number: number }
interface PullInput extends TargetInput { operation: 'pull' }
interface PullManifestInput extends TargetInput { operation: 'pull-manifest' }
interface IssueInput extends TargetInput { operation: 'issue' }
interface PullIdentityInput extends TargetInput { baseSha: string; diffBaseSha: string; headOwner: string; headRepo: string; headSha: string; snapshotId: string; feedbackDigest: string; evidenceDigest: string }
interface PullFilesInput extends PullIdentityInput { operation: 'pull-files'; paths: string[] }
interface PullFeedbackInput extends PullIdentityInput { operation: 'pull-feedback'; kind: FeedbackKind; page: number }
interface SourceInput { operation: 'source'; owner: string; repo: string; sha: string; path: string }
type GitHubReadInput = ResolveInput | PullInput | PullManifestInput | PullFilesInput | PullFeedbackInput | IssueInput | SourceInput;
interface GitHubReadArgs { input?: unknown }
interface GitHubReadContext { directory?: string; worktree?: string; spawn?: Spawn }
interface GitHubReadTool {
    description: string;
    args: Record<string, unknown>;
    execute(args?: GitHubReadArgs, context?: GitHubReadContext): Promise<string>;
}
function isOperationName(value: unknown): value is GitHubOperation {
    return OPERATIONS.some(operation => operation === value);
}
function isSnapshotId(value: unknown): value is string {
    return typeof value === 'string' && /^naru-snap-[0-9a-f]{64}$/.test(value);
}
function isDigest(value: unknown): value is string {
    return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
}
function isPathArray(value: unknown): value is string[] {
    return Array.isArray(value);
}
function isFeedbackKind(value: unknown): value is FeedbackKind {
    return value === 'reviews' || value === 'review-comments' || value === 'issue-comments';
}
function validateInput(raw: unknown): GitHubReadInput {
    assertPlainObject(raw, 'input');
    validateAllowedKeys(raw, ['operation', 'reference', 'owner', 'repo', 'number', 'sha', 'path', 'baseSha', 'diffBaseSha', 'headOwner', 'headRepo', 'headSha', 'snapshotId', 'feedbackDigest', 'evidenceDigest', 'paths', 'kind', 'page']);
    validateStringEnum(raw.operation, OPERATIONS, 'operation');
    if (!isOperationName(raw.operation))
        throw new Error('unsupported operation');
    switch (raw.operation) {
        case 'resolve': {
            validateAllowedKeys(raw, ['operation', 'reference']);
            const reference = requireField(raw, 'reference', (value) => isNonEmptyString(value, { max: 512 }));
            return { operation: 'resolve', reference };
        }
        case 'pull': {
            validateAllowedKeys(raw, ['operation', 'owner', 'repo', 'number']);
            const owner = requireField(raw, 'owner', isSafeOwner);
            const repo = requireField(raw, 'repo', isSafeRepo);
            const number = requireField(raw, 'number', isPositiveInteger);
            return { operation: 'pull', owner, repo, number };
        }
        case 'pull-manifest': {
            validateAllowedKeys(raw, ['operation', 'owner', 'repo', 'number']);
            const owner = requireField(raw, 'owner', isSafeOwner);
            const repo = requireField(raw, 'repo', isSafeRepo);
            const number = requireField(raw, 'number', isPositiveInteger);
            return { operation: 'pull-manifest', owner, repo, number };
        }
        case 'pull-files': {
            validateAllowedKeys(raw, ['operation', 'owner', 'repo', 'number', 'baseSha', 'diffBaseSha', 'headOwner', 'headRepo', 'headSha', 'snapshotId', 'feedbackDigest', 'evidenceDigest', 'paths']);
            const owner = requireField(raw, 'owner', isSafeOwner);
            const repo = requireField(raw, 'repo', isSafeRepo);
            const number = requireField(raw, 'number', isPositiveInteger);
            const baseSha = requireField(raw, 'baseSha', is40HexSha);
            const diffBaseSha = requireField(raw, 'diffBaseSha', is40HexSha);
            const headOwner = requireField(raw, 'headOwner', isSafeOwner);
            const headRepo = requireField(raw, 'headRepo', isSafeRepo);
            const headSha = requireField(raw, 'headSha', is40HexSha);
            const snapshotId = requireField(raw, 'snapshotId', isSnapshotId);
            const feedbackDigest = requireField(raw, 'feedbackDigest', isDigest);
            const evidenceDigest = requireField(raw, 'evidenceDigest', isDigest);
            const paths = requireField(raw, 'paths', isPathArray);
            return { operation: 'pull-files', owner, repo, number, baseSha, diffBaseSha, headOwner, headRepo, headSha, snapshotId, feedbackDigest, evidenceDigest, paths };
        }
        case 'pull-feedback': {
            validateAllowedKeys(raw, ['operation', 'owner', 'repo', 'number', 'baseSha', 'diffBaseSha', 'headOwner', 'headRepo', 'headSha', 'snapshotId', 'feedbackDigest', 'evidenceDigest', 'kind', 'page']);
            const identity = {
                owner: requireField(raw, 'owner', isSafeOwner), repo: requireField(raw, 'repo', isSafeRepo),
                number: requireField(raw, 'number', isPositiveInteger), baseSha: requireField(raw, 'baseSha', is40HexSha),
                diffBaseSha: requireField(raw, 'diffBaseSha', is40HexSha),
                headOwner: requireField(raw, 'headOwner', isSafeOwner),
                headRepo: requireField(raw, 'headRepo', isSafeRepo),
                headSha: requireField(raw, 'headSha', is40HexSha),
                snapshotId: requireField(raw, 'snapshotId', isSnapshotId),
                feedbackDigest: requireField(raw, 'feedbackDigest', isDigest),
                evidenceDigest: requireField(raw, 'evidenceDigest', isDigest),
            };
            const kind = requireField(raw, 'kind', isFeedbackKind);
            const page = requireField(raw, 'page', isPositiveInteger);
            return { operation: 'pull-feedback', ...identity, kind, page };
        }
        case 'issue': {
            validateAllowedKeys(raw, ['operation', 'owner', 'repo', 'number']);
            const owner = requireField(raw, 'owner', isSafeOwner);
            const repo = requireField(raw, 'repo', isSafeRepo);
            const number = requireField(raw, 'number', isPositiveInteger);
            return { operation: 'issue', owner, repo, number };
        }
        case 'source': {
            validateAllowedKeys(raw, ['operation', 'owner', 'repo', 'sha', 'path']);
            const owner = requireField(raw, 'owner', isSafeOwner);
            const repo = requireField(raw, 'repo', isSafeRepo);
            const sha = requireField(raw, 'sha', is40HexSha);
            const path = requireField(raw, 'path', isSafeRelativePath);
            return { operation: 'source', owner, repo, sha, path };
        }
    }
}
const githubReadTool: GitHubReadTool = {
    description: 'Read-only GitHub inspection. Resolve PR/issue references, read an issue, capture a ' +
        'coherent pull snapshot/manifest, fetch an exact-head file batch or feedback page, or fetch an exact source file at a 40-char SHA.',
    args: {
        input: {
            type: 'object',
            description: 'GitHub operation request.',
            properties: {
                operation: {
                    type: 'string',
                    enum: ['resolve', 'issue', 'pull', 'pull-manifest', 'pull-files', 'pull-feedback', 'source'],
                    description: 'Resolve a reference, read an issue, capture bounded pull evidence, or read source at a SHA.',
                },
                reference: {
                    type: 'string',
                    description: 'Full URL, owner/repo#number, owner/repo number, or bare number.',
                },
                owner: { type: 'string', description: 'Repository owner.' },
                repo: { type: 'string', description: 'Repository name.' },
                number: { type: 'number', description: 'Issue or pull request number.' },
                sha: { type: 'string', description: '40-character hex commit SHA.' },
                path: { type: 'string', description: 'Relative file path.' },
                headSha: { type: 'string', description: 'Exact 40-character pull head SHA.' },
                baseSha: { type: 'string', description: 'Exact 40-character pull base SHA.' },
                diffBaseSha: { type: 'string', description: 'Exact 40-character compare merge-base SHA.' },
                headOwner: { type: 'string', description: 'Exact pull head repository owner.' },
                headRepo: { type: 'string', description: 'Exact pull head repository name.' },
                snapshotId: { type: 'string', description: 'Originating compact manifest snapshot ID.' },
                feedbackDigest: { type: 'string', description: 'Originating compact manifest feedback digest.' },
                evidenceDigest: { type: 'string', description: 'Originating compact manifest evidence digest.' },
                paths: { type: 'array', items: { type: 'string' }, maxItems: 100, description: 'Distinct manifest paths to retrieve.' },
                kind: { type: 'string', enum: ['reviews', 'review-comments', 'issue-comments'] },
                page: { type: 'number', minimum: 1 },
            },
            required: ['operation'],
            additionalProperties: false,
        },
    },
    execute: async (args = {}, context = {}) => {
        const raw = args.input;
        let input: GitHubReadInput;
        try {
            input = validateInput(raw);
        }
        catch (err) {
            return JSON.stringify(errEnvelope('naru-github-read', `invalid input: ${safeError(err)}`), null, 2);
        }
        try {
            switch (input.operation) {
                case 'resolve': {
                    const parsed = parseReference(input.reference);
                    if ('bare' in parsed) {
                        const resolved = await resolveBareNumber(parsed.number, context, { spawn: context?.spawn });
                        return JSON.stringify(okEnvelope('naru-github-read', { kind: 'pull', ...resolved }), null, 2);
                    }
                    return JSON.stringify(okEnvelope('naru-github-read', {
                        kind: parsed.kind,
                        owner: parsed.owner,
                        repo: parsed.repo,
                        number: parsed.number,
                    }), null, 2);
                }
                case 'pull': {
                    const snapshot = await pullSnapshot({ owner: input.owner, repo: input.repo, number: input.number }, { spawn: context?.spawn });
                    return JSON.stringify(okEnvelope('naru-github-read', snapshot, {
                        complete: snapshot.complete,
                        contentTruncated: snapshot.contentTruncated,
                        warnings: snapshot.warnings,
                    }), null, 2);
                }
                case 'pull-manifest': {
                    const manifest = await pullManifest(input, { spawn: context?.spawn });
                    return JSON.stringify(okEnvelope('naru-github-read', manifest, {
                        complete: manifest.reviewability.inventoryComplete && manifest.reviewability.feedbackComplete,
                        warnings: manifest.warnings,
                    }), null, 2);
                }
                case 'pull-files': {
                    const batch = await pullFilesAtHead(input, { spawn: context?.spawn });
                    return JSON.stringify(okEnvelope('naru-github-read', batch), null, 2);
                }
                case 'pull-feedback': {
                    return JSON.stringify(okEnvelope('naru-github-read', await pullFeedbackPage(input, { spawn: context?.spawn })), null, 2);
                }
                case 'issue': {
                    const issue = await fetchIssue({ owner: input.owner, repo: input.repo, number: input.number }, { spawn: context?.spawn });
                    return JSON.stringify(okEnvelope('naru-github-read', issue, {
                        complete: issue.complete,
                        warnings: issue.warnings,
                    }), null, 2);
                }
                case 'source': {
                    const source = await fetchSourceAtSha({ owner: input.owner, repo: input.repo, sha: input.sha, path: input.path }, { spawn: context?.spawn });
                    return JSON.stringify(okEnvelope('naru-github-read', source, {
                        complete: source.content !== null && source.contentTruncated !== true,
                        contentTruncated: source.contentTruncated === true,
                    }), null, 2);
                }
            }
        }
        catch (err) {
            return JSON.stringify(errEnvelope('naru-github-read', safeError(err)), null, 2);
        }
    },
};
export default githubReadTool;
