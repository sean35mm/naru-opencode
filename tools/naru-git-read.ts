// naru-git-read: read-only git inspection for OpenCode custom tools.
// The filename defines the OpenCode tool ID.
import { runGit, type GitContext } from './naru-lib/git.mjs';
import type { Spawn } from './naru-lib/transport.mjs';

type GitReadInput =
    | { operation: 'repository' }
    | { operation: 'status' }
    | { operation: 'diff'; base?: string; head?: string; path?: string }
    | { operation: 'log'; maxCount?: number; path?: string }
    | { operation: 'file'; ref?: string; path?: string }
    | { operation: 'grep'; pattern?: string; path?: string }
    | { operation: 'merge-base'; refs?: string[] };
interface GitReadArgs { input?: GitReadInput }
interface GitReadContext extends GitContext { spawn?: Spawn }
interface GitReadTool {
    description: string;
    args: Record<string, unknown>;
    execute(args?: GitReadArgs, context?: GitReadContext): Promise<string>;
}
const gitReadTool: GitReadTool = {
    description: 'Run a read-only git operation in the current workspace. ' +
        'Supported operations: repository, status, diff, log, file, grep, merge-base. ' +
        'All commands use fixed argv arrays, --no-pager/--no-color, and never mutate state.',
    args: {
        input: {
            type: 'object',
            description: 'Git operation request with operation-specific fields.',
            properties: {
                operation: {
                    type: 'string',
                    enum: ['repository', 'status', 'diff', 'log', 'file', 'grep', 'merge-base'],
                    description: 'Which read-only git operation to run.',
                },
                base: { type: 'string', description: 'Base ref for diff.' },
                head: { type: 'string', description: 'Head ref for diff.' },
                ref: { type: 'string', description: 'Ref for file show.' },
                path: { type: 'string', description: 'Relative pathspec (no absolute/.. paths).' },
                pattern: { type: 'string', description: 'Grep pattern.' },
                maxCount: { type: 'number', description: 'Maximum log entries (default 50, max 1000).' },
                refs: {
                    type: 'array',
                    items: { type: 'string' },
                    description: 'Two refs for merge-base.',
                },
            },
            required: ['operation'],
            additionalProperties: false,
        },
    },
    execute: async (args = {}, context = {}) => {
        const input = args.input;
        const result = await runGit(context, input, { spawn: context?.spawn });
        return JSON.stringify(result, null, 2);
    },
};
export default gitReadTool;
