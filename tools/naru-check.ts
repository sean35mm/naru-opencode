import { access, realpath } from 'node:fs/promises';
import { constants } from 'node:fs';
import { delimiter, isAbsolute, join } from 'node:path';
import { tmpdir } from 'node:os';
import { isolatedCheck } from './naru-lib/preview-process.mjs';
import { isPlainObject, validateAllowedKeys } from './naru-lib/validate.mjs';

export default {
    description: 'Run argv in a disposable repository copy with operating-system filesystem containment and no network or user credentials. Dependency directories such as node_modules are omitted, so only dependency-free checks or checks using already available system runtimes are usable; dependencies are never installed. Never changes the original repository. macOS only; other hosts fail closed. Output and execution are bounded. Use only for verification.',
    args: { input: { type: 'object', properties: { argv: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 64 } }, required: ['argv'], additionalProperties: false } },
    execute: async (args: { input?: unknown }, context: { agent?: string; directory?: string; worktree?: string }) => {
        try {
            if (!/^naru-(runner|writer)(?:-[a-z0-9-]+)?$/.test(context.agent ?? '')) throw new Error('Only Naru verification roles may run checks');
            const root = context.worktree || context.directory;
            if (!root || !isAbsolute(root)) throw new Error('An absolute workspace is required');
            if (!isPlainObject(args.input)) throw new Error('input must be an object');
            validateAllowedKeys(args.input, ['argv']);
            if (!Array.isArray(args.input.argv) || args.input.argv.some(value => typeof value !== 'string')) throw new Error('argv must contain strings');
            let node: string | undefined;
            for (const directory of (process.env.PATH ?? '').split(delimiter).filter(isAbsolute)) {
                const candidate = join(directory, 'node');
                try { await access(candidate, constants.X_OK); node = await realpath(candidate); break; } catch { /* Try the next installed runtime. */ }
            }
            if (!node) throw new Error('Node must be installed to run isolated checks');
            return JSON.stringify(await isolatedCheck(await realpath(root), args.input.argv as string[], node, join(tmpdir(), 'naru-checks')));
        } catch (error) { return JSON.stringify({ ok: false, error: error instanceof Error ? error.message : 'Check failed' }); }
    },
};
