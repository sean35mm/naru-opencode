// Naru dispatch plugin: generates model-class variants and configured MCP policy.
//
// Reads the optional `models` block from naru-runtime.json and, in the
// config hook, clones the base subagents into hidden variants with the
// class's model and effort baked in (naru-reader-<class>, ...). The
// orchestrator dispatches them through OpenCode's native task tool, so the
// TUI's subagent rendering and click-through behave exactly as they do for
// the base agents. Its opt-in MCP pass reads only server names and enabled
// states. The plugin hooks config only — no tools, no events, no session access
// — and every config mutation is atomic.
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import {
    applyRuntimeToConfigAtomically,
    parseModelsConfig,
    readAuthProviders,
} from '../tools/naru-lib/dispatch.mjs';
import type { ModelsConfig } from '../tools/naru-lib/dispatch.mjs';
import { parseRuntimeConfig, type RuntimeConfig } from '../tools/naru-lib/runtime-config.mjs';

interface OpenCodeAgentConfig {
    [key: string]: unknown;
}

interface OpenCodeConfig {
    agent?: Record<string, OpenCodeAgentConfig>;
    mcp?: unknown;
    [key: string]: unknown;
}

interface OpenCodePluginHooks {
    config(config: OpenCodeConfig): Promise<void>;
}

const CONFIG_PATH = fileURLToPath(new URL('../naru-runtime.json', import.meta.url));
const MAX_CONFIG_BYTES = 64 * 1024;

async function loadRuntimeConfig(): Promise<RuntimeConfig | null> {
    let handle;
    try {
        handle = await open(CONFIG_PATH, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    }
    catch {
        return parseRuntimeConfig();
    }
    try {
        const stats = await handle.stat();
        if (!stats.isFile() || stats.size > MAX_CONFIG_BYTES) return null;
        const value = JSON.parse(await handle.readFile('utf8'));
        return parseRuntimeConfig(value);
    }
    catch {
        // A malformed runtime config must not take Naru down; the base
        // agents keep working and simply inherit the session model.
        return null;
    }
    finally {
        await handle.close();
    }
}

export const NaruDispatchPlugin = async (): Promise<OpenCodePluginHooks> => {
    const runtime = await loadRuntimeConfig();
    let classes: ModelsConfig = {};
    try {
        classes = runtime ? parseModelsConfig(runtime.models) : {};
    }
    catch {
        // Invalid model classes must not prevent the base agents or review
        // defaults from loading.
    }
    const authProviders = readAuthProviders();
    return createNaruDispatchHooks(runtime, classes, authProviders);
};

export function createNaruDispatchHooks(runtime: RuntimeConfig | null, classes: ModelsConfig, authProviders: ReadonlySet<string> | null): OpenCodePluginHooks {
    return {
        config: async (config: OpenCodeConfig) => {
            if (!runtime) return;
            try {
                applyRuntimeToConfigAtomically(config, classes, authProviders, runtime.review, runtime.mcp.configuredTools, config.mcp);
            }
            catch {
                // Fail open: a config this hook cannot safely extend is left
                // exactly as OpenCode built it.
            }
        },
    };
}
