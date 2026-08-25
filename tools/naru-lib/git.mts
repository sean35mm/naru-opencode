// Read-only git operations for naru-git-read. Builds fixed argv arrays and runs
// them through the injectable transport. No shell, no mutation.
import { run, type Spawn } from './transport.mjs';
import { okEnvelope, errEnvelope, type OutputEnvelope } from './output.mjs';
import { assertPlainObject, validateAllowedKeys, validateStringEnum, isSafeGitRef, isSafeRelativePath, isSafeGrepPattern, isPositiveInteger, optionalField, requireField, safeError, stripSecrets, guardInputSize, } from './validate.mjs';

const OPERATIONS = ['repository', 'status', 'diff', 'log', 'file', 'grep', 'merge-base'] as const;
const MAX_LOG_COUNT = 1000;
const DEFAULT_LOG_COUNT = 50;
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
const SECRET_PATHSPECS = [
    ':(exclude,glob)**/.env',
    ':(exclude,glob)**/.env.*',
    ':(exclude,glob)**/*.pem',
    ':(exclude,glob)**/*.key',
    ':(exclude,glob)**/*.p12',
    ':(exclude,glob)**/*.pfx',
    ':(exclude,glob)**/id_rsa',
    ':(exclude,glob)**/id_dsa',
    ':(exclude,glob)**/id_ecdsa',
    ':(exclude,glob)**/id_ed25519',
    ':(exclude,glob)**/.ssh/**',
    ':(exclude,glob)**/.aws/**',
    ':(exclude,glob)**/.kube/**',
    ':(exclude,glob)**/.gnupg/**',
    ':(exclude,glob)**/credentials/**',
    ':(exclude,glob)**/secrets/**',
] as const;

export type GitOperationName = typeof OPERATIONS[number];
export interface RepositoryGitInput { operation: 'repository' }
export interface StatusGitInput { operation: 'status' }
export interface DiffGitInput { operation: 'diff'; base?: string; head?: string; path?: string }
export interface LogGitInput { operation: 'log'; maxCount: number; path?: string }
export interface FileGitInput { operation: 'file'; ref: string; path: string }
export interface GrepGitInput { operation: 'grep'; pattern: string; path?: string }
export interface MergeBaseGitInput { operation: 'merge-base'; refs: [string, string] }

export interface GitOperationInputs {
    repository: RepositoryGitInput;
    status: StatusGitInput;
    diff: DiffGitInput;
    log: LogGitInput;
    file: FileGitInput;
    grep: GrepGitInput;
    'merge-base': MergeBaseGitInput;
}

export type GitInput = GitOperationInputs[GitOperationName];

export interface GitContext {
    worktree?: string;
    directory?: string;
}

export interface RepositoryGitResult {
    topLevel: string;
    branch: string | null;
}

export interface OutputGitResult {
    output: string;
}

export interface GitOperationResults {
    repository: RepositoryGitResult;
    status: OutputGitResult;
    diff: OutputGitResult;
    log: OutputGitResult;
    file: OutputGitResult;
    grep: OutputGitResult;
    'merge-base': OutputGitResult;
}

export type GitResultData = GitOperationResults[GitOperationName];
export type GitOperationResult<TOperation extends GitOperationName> = OutputEnvelope<GitOperationResults[TOperation], string>;
export type GitRunResult = GitOperationResult<GitOperationName>;

export interface GitRunOptions {
    spawn?: Spawn | undefined;
}

function isGitOperationName(value: unknown): value is GitOperationName {
    return OPERATIONS.some(operation => operation === value);
}

function resolveCwd(context: unknown): string {
    if (!context || typeof context !== 'object') {
        throw new Error('missing context');
    }
    const cwd = (context as GitContext).worktree || (context as GitContext).directory;
    if (typeof cwd !== 'string' || cwd.length === 0) {
        throw new Error('context.worktree or context.directory is required');
    }
    if (!cwd.startsWith('/')) {
        throw new Error('context worktree/directory must be an absolute path');
    }
    return cwd;
}

function buildBaseArgv(): string[] {
    return ['git', '--no-pager', '-c', 'color.ui=false'];
}

function addPathspec(argv: string[], path: string | undefined): void {
    if (path !== undefined && path !== '') {
        argv.push('--', path);
    }
}

function addContentPathspec(argv: string[], path: string | undefined): void {
    argv.push('--', path || '.', ...SECRET_PATHSPECS);
}

function validateRefs(refs: unknown[], max = 2): asserts refs is string[] {
    if (refs.length > max)
        throw new Error(`refs accepts at most ${max} entries`);
    for (let i = 0; i < refs.length; i += 1) {
        if (!isSafeGitRef(refs[i]))
            throw new Error(`refs[${i}] is not a safe ref`);
    }
}

export function validateGitInput(raw: unknown): GitInput {
    assertPlainObject(raw, 'input');
    guardInputSize(raw);
    validateAllowedKeys(raw, ['operation', 'base', 'head', 'ref', 'path', 'pattern', 'maxCount', 'refs']);
    validateStringEnum(raw.operation, OPERATIONS, 'operation');
    if (!isGitOperationName(raw.operation))
        throw new Error('unsupported operation');
    switch (raw.operation) {
        case 'repository':
            validateAllowedKeys(raw, ['operation']);
            return { operation: raw.operation };
        case 'status':
            validateAllowedKeys(raw, ['operation']);
            return { operation: raw.operation };
        case 'diff': {
            const base = optionalField(raw, 'base', isSafeGitRef);
            const head = optionalField(raw, 'head', isSafeGitRef);
            const path = optionalField(raw, 'path', isSafeRelativePath);
            if (head !== undefined && base === undefined) {
                throw new Error('head requires base');
            }
            return {
                operation: raw.operation,
                ...(base === undefined ? {} : { base }),
                ...(head === undefined ? {} : { head }),
                ...(path === undefined ? {} : { path }),
            };
        }
        case 'log': {
            let maxCount = optionalField(raw, 'maxCount', isPositiveInteger);
            if (maxCount === undefined)
                maxCount = DEFAULT_LOG_COUNT;
            if (maxCount > MAX_LOG_COUNT)
                throw new Error(`maxCount exceeds ${MAX_LOG_COUNT}`);
            const path = optionalField(raw, 'path', isSafeRelativePath);
            return { operation: raw.operation, maxCount, ...(path === undefined ? {} : { path }) };
        }
        case 'file': {
            const ref = requireField(raw, 'ref', isSafeGitRef);
            const path = requireField(raw, 'path', isSafeRelativePath);
            return { operation: raw.operation, ref, path };
        }
        case 'grep': {
            const pattern = requireField(raw, 'pattern', isSafeGrepPattern);
            const path = optionalField(raw, 'path', isSafeRelativePath);
            return { operation: raw.operation, pattern, ...(path === undefined ? {} : { path }) };
        }
        case 'merge-base': {
            const refs = requireField(raw, 'refs', Array.isArray);
            if (refs.length < 2)
                throw new Error('invalid value for refs');
            validateRefs(refs, 2);
            const first = refs[0];
            const second = refs[1];
            if (first === undefined || second === undefined)
                throw new Error('invalid value for refs');
            return { operation: raw.operation, refs: [first, second] };
        }
    }
}

export async function runGit(context: unknown, rawInput: unknown, { spawn }: GitRunOptions = {}): Promise<GitRunResult> {
    let input: GitInput;
    try {
        input = validateGitInput(rawInput);
    }
    catch (err) {
        return errEnvelope('naru-git-read', `invalid input: ${safeError(err)}`);
    }
    let cwd: string;
    try {
        cwd = resolveCwd(context);
    }
    catch (err) {
        return errEnvelope('naru-git-read', `invalid context: ${safeError(err)}`);
    }
    let argv: string[];
    let label: string;
    switch (input.operation) {
        case 'repository': {
            const top = await run(['git', '--no-pager', 'rev-parse', '--show-toplevel'], { spawn, cwd, maxBytes: MAX_OUTPUT_BYTES });
            if (!top.ok)
                return errEnvelope('naru-git-read', `git rev-parse failed: ${top.stderr || top.stdout}`);
            const branch = await run(['git', '--no-pager', 'rev-parse', '--abbrev-ref', 'HEAD'], { spawn, cwd, maxBytes: MAX_OUTPUT_BYTES });
            return okEnvelope('naru-git-read', {
                topLevel: top.stdout.trim(),
                branch: branch.ok ? branch.stdout.trim() : null,
            }, { warnings: branch.ok ? [] : ['could not read current branch'] });
        }
        case 'status': {
            argv = [...buildBaseArgv(), 'status', '--short', '--branch'];
            label = 'status';
            break;
        }
        case 'diff': {
            argv = [...buildBaseArgv(), 'diff', '--no-ext-diff', '--no-textconv', '--no-renames'];
            if (input.base)
                argv.push(input.base);
            if (input.head)
                argv.push(input.head);
            addContentPathspec(argv, input.path);
            label = 'diff';
            break;
        }
        case 'log': {
            argv = [...buildBaseArgv(), 'log', `--max-count=${input.maxCount}`, '--pretty=medium'];
            addPathspec(argv, input.path);
            label = 'log';
            break;
        }
        case 'file': {
            argv = [...buildBaseArgv(), 'show', '--no-ext-diff', '--no-textconv', '--format=', `${input.ref}:${input.path}`];
            label = `file ${input.path}`;
            break;
        }
        case 'grep': {
            argv = [...buildBaseArgv(), 'grep', '-n', '-e', input.pattern];
            addContentPathspec(argv, input.path);
            label = 'grep';
            break;
        }
        case 'merge-base': {
            argv = ['git', '--no-pager', 'merge-base', input.refs[0], input.refs[1]];
            label = 'merge-base';
            break;
        }
    }
    try {
        const result = await run(argv, { spawn, cwd, maxBytes: MAX_OUTPUT_BYTES });
        if (!result.ok) {
            return errEnvelope('naru-git-read', `${label} failed: ${stripSecrets(result.stderr || result.stdout || `exit ${result.code}`)}`);
        }
        return okEnvelope('naru-git-read', { output: result.stdout }, {
            contentTruncated: result.stdoutTruncated || result.stderrTruncated,
            limits: result.stdoutTruncated ? { outputBytes: MAX_OUTPUT_BYTES } : {},
        });
    }
    catch (err) {
        return errEnvelope('naru-git-read', `git transport error: ${safeError(err)}`);
    }
}
