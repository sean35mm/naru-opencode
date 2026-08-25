import { stat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { errEnvelope, okEnvelope } from './naru-lib/output.mjs';
import { cleanupWorktreeRun, createWorktreeRun, createWriterWorktree, finalizeWorktreeRun, integrateWriterWorktree, recoverWorktreeRun, worktreeRunSnapshot, } from './naru-lib/worktree.mjs';
import type { WorktreeRegistry } from './naru-lib/worktree.mjs';
import { loadRuntimeConfigFile, parseRuntimeConfig } from './naru-lib/runtime-config.mjs';
import type { RuntimeConfig } from './naru-lib/runtime-config.mjs';
import type { Spawn } from './naru-lib/transport.mjs';
const TOOL_ID = 'naru-worktree';
const DEFAULT_CONFIG_PATH = fileURLToPath(new URL('../naru-runtime.json', import.meta.url));
const OPERATIONS = Object.freeze([
    'prepare_run',
    'recover_run',
    'prepare_item',
    'integrate_item',
    'snapshot',
    'finalize_run',
    'cleanup_run',
] as const);
type WorktreeOperation = typeof OPERATIONS[number];
type WorktreeInput =
    | { operation: 'prepare_item'; runId: string; itemId: string; ownedWriteScope: string[] }
    | { operation: 'integrate_item'; runId: string; itemId: string }
    | { operation: Exclude<WorktreeOperation, 'prepare_item' | 'integrate_item'>; runId: string };
interface WorktreeToolArgs { input?: unknown }
interface WorktreeToolContext {
    agent?: string;
    directory?: string;
    worktree?: string;
    runtimeConfig?: unknown;
    runtimeConfigPath?: string;
    spawn?: Spawn | undefined;
    worktreeRegistry?: WorktreeRegistry | undefined;
    worktreeRoot?: string | undefined;
}
interface WorktreeTool {
    description: string;
    args: Record<string, unknown>;
    execute(args?: WorktreeToolArgs, context?: WorktreeToolContext): Promise<string>;
}

function isOperationName(value: unknown): value is WorktreeOperation {
    return typeof value === 'string' && OPERATIONS.some((operation) => operation === value);
}
function isErrorCode(error: unknown, code: string): error is Error & { code: string } {
    return error instanceof Error && 'code' in error && error.code === code;
}
function assertUnknownRecord(value: unknown): asserts value is Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error('input must be an object');
    }
}
async function runtimeConfig(context: WorktreeToolContext): Promise<RuntimeConfig> {
    if (context?.runtimeConfig !== undefined)
        return parseRuntimeConfig(context.runtimeConfig);
    const path = context?.runtimeConfigPath ?? DEFAULT_CONFIG_PATH;
    try {
        return await loadRuntimeConfigFile(path);
    }
    catch (error) {
        if (isErrorCode(error, 'ENOENT') && path === DEFAULT_CONFIG_PATH)
            return parseRuntimeConfig();
        throw error;
    }
}
function validate(raw: unknown): WorktreeInput {
    assertUnknownRecord(raw);
    const operation = raw.operation;
    if (!isOperationName(operation))
        throw new Error(`operation must be one of ${OPERATIONS.join(', ')}`);
    const allowed = new Set(['operation', 'runId', 'itemId', 'ownedWriteScope']);
    const unknown = Object.keys(raw).filter((key) => !allowed.has(key));
    if (unknown.length)
        throw new Error(`input contains unknown fields: ${unknown.sort().join(', ')}`);
    if (typeof raw.runId !== 'string')
        throw new Error('runId is required');
    if (operation === 'prepare_item') {
        if (typeof raw.itemId !== 'string')
            throw new Error('itemId is required');
        if (!Array.isArray(raw.ownedWriteScope))
            throw new Error('ownedWriteScope is required');
        if (!raw.ownedWriteScope.every((scope) => typeof scope === 'string')) {
            throw new Error('ownedWriteScope must contain only strings');
        }
        return {
            operation,
            runId: raw.runId,
            itemId: raw.itemId,
            ownedWriteScope: raw.ownedWriteScope,
        };
    }
    if (operation === 'integrate_item') {
        if (typeof raw.itemId !== 'string')
            throw new Error('itemId is required');
        return { operation, runId: raw.runId, itemId: raw.itemId };
    }
    return { operation, runId: raw.runId };
}
function errorText(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
async function workspaceDirectory(context: WorktreeToolContext): Promise<string> {
    const directory = context.worktree ?? context.directory;
    if (typeof directory !== 'string' || !isAbsolute(directory) || directory.includes('\0')) {
        throw new Error('an absolute workspace directory is required');
    }
    const stats = await stat(directory);
    if (!stats.isDirectory())
        throw new Error('workspace directory must be a directory');
    return directory;
}
const worktreeTool: WorktreeTool = {
    description: 'Manage clean-repository isolated Naru writer worktrees and serialized integration. Never pushes or creates delivery commits.',
    args: {
        input: {
            type: 'object',
            properties: {
                operation: { type: 'string', enum: OPERATIONS },
                runId: { type: 'string' },
                itemId: { type: 'string' },
                ownedWriteScope: { type: 'array', items: { type: 'string' } },
            },
            required: ['operation', 'runId'],
            additionalProperties: false,
        },
    },
    execute: async (args = {}, context = {}) => {
        let input;
        try {
            if (context.agent !== 'naru-orchestrator')
                throw new Error('naru-worktree is restricted to naru-orchestrator');
            const directory = await workspaceDirectory(context);
            input = validate(args?.input);
            const config = await runtimeConfig(context);
            const implementation = config.implementation;
            if (implementation.workspaceMode === 'shared')
                throw new Error('isolated writer mode is disabled');
            const common = {
                runId: input.runId,
                spawn: context.spawn,
                stateRegistry: context.worktreeRegistry,
            };
            let data;
            switch (input.operation) {
                case 'prepare_run':
                    data = await createWorktreeRun({
                        ...common,
                        directory,
                        maxWriters: implementation.maxConcurrentWriters,
                        worktreeRoot: context.worktreeRoot,
                    });
                    break;
                case 'prepare_item':
                    data = await createWriterWorktree({
                        ...common,
                        itemId: input.itemId,
                        ownedWriteScope: input.ownedWriteScope,
                    });
                    break;
                case 'recover_run':
                    data = await recoverWorktreeRun({
                        ...common,
                        directory,
                        worktreeRoot: context.worktreeRoot,
                    });
                    break;
                case 'integrate_item':
                    data = await integrateWriterWorktree({ ...common, itemId: input.itemId });
                    break;
                case 'snapshot':
                    data = worktreeRunSnapshot(input.runId, context.worktreeRegistry);
                    break;
                case 'finalize_run':
                    data = await finalizeWorktreeRun(common);
                    break;
                case 'cleanup_run':
                    data = await cleanupWorktreeRun(common);
                    break;
                default:
                    throw new Error('unsupported operation');
            }
            const envelope = okEnvelope(TOOL_ID, data);
            return JSON.stringify(envelope, null, 2);
        }
        catch (error) {
            const envelope = errEnvelope(TOOL_ID, errorText(error));
            return JSON.stringify(envelope, null, 2);
        }
    },
};
export default worktreeTool;
