// Naru dispatch plugin: registers the naru-dispatch tool, which spawns Naru
// subagents on a model class chosen per dispatch. This is the only Naru
// plugin; it exists because tool-level code cannot reach the OpenCode SDK
// client, while plugins receive it. It registers one tool and hooks nothing
// else — no config mutation, no event handling.
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import {
    buildToolDescription,
    DISPATCH_AGENTS,
    parseModelsConfig,
    readAuthProviders,
    runDispatch,
} from '../tools/naru-lib/dispatch.mjs';

const CONFIG_PATH = fileURLToPath(new URL('../naru-runtime.json', import.meta.url));
const MAX_CONFIG_BYTES = 64 * 1024;

async function loadModelsConfig() {
    let handle;
    try {
        handle = await open(CONFIG_PATH, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    }
    catch {
        return {};
    }
    try {
        const stats = await handle.stat();
        if (!stats.isFile() || stats.size > MAX_CONFIG_BYTES) return {};
        const value = JSON.parse(await handle.readFile('utf8'));
        return parseModelsConfig(value?.models);
    }
    catch {
        // A malformed runtime config must not take the tool down; dispatches
        // simply inherit the parent session model until the config is fixed.
        return {};
    }
    finally {
        await handle.close();
    }
}

export const NaruDispatchPlugin = async ({ client }) => {
    const classes = await loadModelsConfig();
    const authProviders = readAuthProviders();
    return {
        tool: {
            'naru-dispatch': {
                description: buildToolDescription(classes),
                args: {
                    agent: {
                        type: 'string',
                        enum: [...DISPATCH_AGENTS],
                        description: 'Which Naru subagent to run.',
                    },
                    description: {
                        type: 'string',
                        description: 'A short 3-5 word label for the task, shown to the user.',
                    },
                    prompt: {
                        type: 'string',
                        description: 'The full task for the subagent. It starts with fresh context, so include everything it needs.',
                    },
                    class: {
                        type: 'string',
                        description: 'Model class from the configured list. Omit to inherit the parent session model.',
                    },
                    effort: {
                        type: 'string',
                        description: 'Optional reasoning-effort override for this dispatch (e.g. low, medium, high, xhigh, max).',
                    },
                    directory: {
                        type: 'string',
                        description: 'Optional working directory for the child (e.g. an assigned worktree path).',
                    },
                },
                async execute(args, ctx) {
                    const result = await runDispatch({ client, ctx, args, classes, authProviders });
                    if (result.error) return `naru-dispatch: ${result.error}`;
                    return { title: result.title, output: result.output, metadata: result.metadata };
                },
            },
        },
    };
};
