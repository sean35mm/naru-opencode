import { isAbsolute } from 'node:path';
import gitReadTool from '../naru-git-read.js';
import githubPostReviewTool from '../naru-github-post-review.js';
import githubReadTool from '../naru-github-read.js';
import worktreeTool from '../naru-worktree.js';
import { DEFAULT_RUNTIME_CONFIG } from '../naru-lib/runtime-config.mjs';
import type { Spawn } from '../naru-lib/transport.mjs';
import type { WorktreeRegistry } from '../naru-lib/worktree.mjs';

type JsonSchema = Record<string, unknown>;
interface LegacyTool {
    description: string;
    args: Record<string, unknown>;
    execute(args?: Record<string, unknown>, context?: Record<string, unknown>): Promise<string>;
}
interface NativeExecutionContext {
    agent?: unknown;
    directory?: unknown;
    sessionID?: unknown;
    worktree?: unknown;
}
interface NativeToolDefinition {
    name: string;
    description: string;
    input: JsonSchema;
    options: { codemode: false };
    execute(input: Record<string, unknown>, context: NativeExecutionContext): Promise<{ content: string }>;
}
interface NativeToolEditor { add(tool: NativeToolDefinition): void }
interface NativePluginContext {
    session?: { get(input: { sessionID: string }): Promise<unknown> };
    tool: { transform(callback: (editor: NativeToolEditor) => void): Promise<unknown> };
}
export interface NativePluginAdapters {
    spawn?: Spawn;
    worktreeRegistry?: WorktreeRegistry;
}

const TOOL_INVENTORY = Object.freeze([
    ['naru-git-read', gitReadTool],
    ['naru-github-read', githubReadTool],
    ['naru-github-post-review', githubPostReviewTool],
    ['naru-worktree', worktreeTool],
] as const);

export const OC2_NATIVE_TOOL_NAMES = Object.freeze(TOOL_INVENTORY.map(([name]) => name));

function absoluteDirectory(value: unknown, field: string): string {
    if (typeof value !== 'string' || !isAbsolute(value) || value.includes('\0')) {
        throw new Error(`OC2 native tool context.${field} must be an absolute per-session directory`);
    }
    return value;
}

function record(value: unknown): Record<string, unknown> | undefined {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown>
        : undefined;
}

function sessionDirectory(value: unknown): string | undefined {
    const root = record(value);
    const data = record(root?.data) ?? root;
    const location = record(data?.location);
    for (const candidate of [data?.directory, location?.directory]) {
        if (typeof candidate === 'string' && isAbsolute(candidate) && !candidate.includes('\0')) return candidate;
    }
    return undefined;
}

async function nativeContext(context: NativeExecutionContext, plugin: NativePluginContext, adapters: NativePluginAdapters): Promise<Record<string, unknown>> {
    if (typeof context.agent !== 'string' || context.agent.length === 0) {
        throw new Error('OC2 native tool context.agent is required');
    }
    if (typeof context.sessionID !== 'string' || context.sessionID.length === 0) {
        throw new Error('OC2 native tool context.sessionID is required');
    }
    let directory: string;
    if (context.directory !== undefined) directory = absoluteDirectory(context.directory, 'directory');
    else {
        if (!plugin.session) throw new Error('OC2 native host does not expose a per-session directory resolver');
        const resolved = sessionDirectory(await plugin.session.get({ sessionID: context.sessionID }));
        if (!resolved) throw new Error('OC2 native host session did not provide an absolute per-session directory');
        directory = resolved;
    }
    const worktree = context.worktree === undefined
        ? directory
        : absoluteDirectory(context.worktree, 'worktree');
    return {
        agent: context.agent === 'naru' ? 'naru-orchestrator' : context.agent,
        directory,
        worktree,
        runtimeConfig: DEFAULT_RUNTIME_CONFIG,
        worktreeRegistry: adapters.worktreeRegistry ?? new Map(),
        ...(adapters.spawn ? { spawn: adapters.spawn } : {}),
    };
}

function schema(tool: LegacyTool): JsonSchema {
    return {
        type: 'object',
        properties: tool.args,
        required: Object.keys(tool.args),
        additionalProperties: false,
    };
}

export function createOc2NativePlugin(adapters: NativePluginAdapters = {}) {
    const worktreeRegistry = adapters.worktreeRegistry ?? new Map();
    const scopedAdapters = { ...adapters, worktreeRegistry };
    return {
        id: 'naru.oc2-native',
        async setup(context: NativePluginContext): Promise<void> {
            await context.tool.transform(editor => {
                for (const [name, tool] of TOOL_INVENTORY) {
                    const legacy = tool as LegacyTool;
                    editor.add({
                        name,
                        description: legacy.description,
                        input: schema(legacy),
                        options: { codemode: false },
                        async execute(input, executionContext) {
                            return { content: await legacy.execute(input, await nativeContext(executionContext, context, scopedAdapters)) };
                        },
                    });
                }
            });
        },
    };
}

export default createOc2NativePlugin();
