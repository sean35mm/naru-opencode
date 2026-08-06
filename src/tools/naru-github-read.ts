// naru-github-read: read-only GitHub inspection for OpenCode custom tools.
// The filename defines the OpenCode tool ID.

import {
  parseReference,
  resolveBareNumber,
  fetchIssue,
  pullSnapshot,
  fetchSourceAtSha,
} from './naru-lib/github.mjs';
import { okEnvelope, errEnvelope } from './naru-lib/output.mjs';
import {
  assertPlainObject,
  validateAllowedKeys,
  validateStringEnum,
  isSafeOwner,
  isSafeRepo,
  isPositiveInteger,
  is40HexSha,
  isSafeRelativePath,
  isNonEmptyString,
  safeError,
  requireField,
} from './naru-lib/validate.mjs';
import type { GitHubContext } from './naru-lib/github.mjs';

const OPERATIONS = ['resolve', 'issue', 'pull', 'source'] as const;

type UnknownRecord = Record<string, unknown>;
type GitHubOperationName = (typeof OPERATIONS)[number];

type GitHubReadOperation =
  | { operation: 'resolve'; reference: string }
  | { operation: 'pull'; owner: string; repo: string; number: number }
  | { operation: 'issue'; owner: string; repo: string; number: number }
  | { operation: 'source'; owner: string; repo: string; sha: string; path: string };

interface GitHubReadArgs {
  input?: unknown;
}

interface GitHubReadToolDefinition {
  description: string;
  args: UnknownRecord;
  execute: (args?: GitHubReadArgs, context?: GitHubContext) => Promise<string>;
}

function isOperationName(value: string): value is GitHubOperationName {
  return OPERATIONS.some(operation => operation === value);
}

function validateInput(raw: unknown): GitHubReadOperation {
  assertPlainObject(raw, 'input');
  validateAllowedKeys(raw, ['operation', 'reference', 'owner', 'repo', 'number', 'sha', 'path']);
  validateStringEnum(raw.operation, OPERATIONS, 'operation');
  if (!isOperationName(raw.operation)) throw new Error('unsupported operation');

  switch (raw.operation) {
    case 'resolve': {
      const reference = requireField(raw, 'reference', (value): value is string => isNonEmptyString(value, { max: 512 }));
      return { operation: 'resolve', reference };
    }
    case 'pull': {
      const owner = requireField(raw, 'owner', isSafeOwner);
      const repo = requireField(raw, 'repo', isSafeRepo);
      const number = requireField(raw, 'number', isPositiveInteger);
      return { operation: 'pull', owner, repo, number };
    }
    case 'issue': {
      const owner = requireField(raw, 'owner', isSafeOwner);
      const repo = requireField(raw, 'repo', isSafeRepo);
      const number = requireField(raw, 'number', isPositiveInteger);
      return { operation: 'issue', owner, repo, number };
    }
    case 'source': {
      const owner = requireField(raw, 'owner', isSafeOwner);
      const repo = requireField(raw, 'repo', isSafeRepo);
      const sha = requireField(raw, 'sha', is40HexSha);
      const path = requireField(raw, 'path', isSafeRelativePath);
      return { operation: 'source', owner, repo, sha, path };
    }
  }
}

const githubReadTool: GitHubReadToolDefinition = {
  description:
    'Read-only GitHub inspection. Resolve PR/issue references, read an issue, capture a ' +
    'coherent pull snapshot, or fetch an exact source file at a 40-char SHA.',
  args: {
    input: {
      type: 'object',
      description: 'GitHub operation request.',
      properties: {
        operation: {
          type: 'string',
          enum: ['resolve', 'issue', 'pull', 'source'],
          description: 'Resolve a reference, read an issue, capture a pull snapshot, or read source at a SHA.',
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
      },
      required: ['operation'],
      additionalProperties: false,
    },
  },
  execute: async (args = {}, context = {}) => {
    const raw = args && typeof args === 'object' ? args.input : undefined;
    let input: GitHubReadOperation;
    try {
      input = validateInput(raw);
    } catch (err) {
      return JSON.stringify(errEnvelope('naru-github-read', `invalid input: ${safeError(err)}`), null, 2);
    }

    try {
      switch (input.operation) {
        case 'resolve': {
          const parsed = parseReference(input.reference);
          if (parsed.bare) {
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
          const snapshot = await pullSnapshot(
            { owner: input.owner, repo: input.repo, number: input.number },
            { spawn: context?.spawn },
          );
          return JSON.stringify(okEnvelope('naru-github-read', snapshot, {
            complete: snapshot.complete,
            contentTruncated: snapshot.contentTruncated,
            warnings: snapshot.warnings,
          }), null, 2);
        }
        case 'issue': {
          const issue = await fetchIssue(
            { owner: input.owner, repo: input.repo, number: input.number },
            { spawn: context?.spawn },
          );
          return JSON.stringify(okEnvelope('naru-github-read', issue, {
            complete: issue.complete,
            warnings: issue.warnings,
          }), null, 2);
        }
        case 'source': {
          const source = await fetchSourceAtSha(
            { owner: input.owner, repo: input.repo, sha: input.sha, path: input.path },
            { spawn: context?.spawn },
          );
          return JSON.stringify(okEnvelope('naru-github-read', source, {
            complete: source.content !== null && source.contentTruncated !== true,
            contentTruncated: source.contentTruncated === true,
          }), null, 2);
        }
      }
    } catch (err) {
      return JSON.stringify(errEnvelope('naru-github-read', safeError(err)), null, 2);
    }
  },
};

export default githubReadTool;
