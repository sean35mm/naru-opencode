// Naru dispatch plugin: generates model-class agent variants.
//
// Reads the optional `models` block from naru-runtime.json and, in the
// config hook, clones the base subagents into hidden variants with the
// class's model and effort baked in (naru-reader-<class>, ...). The
// orchestrator dispatches them through OpenCode's native task tool, so the
// TUI's subagent rendering and click-through behave exactly as they do for
// the base agents. The plugin hooks config only — no tools, no events, no
// session access — and fails open: any error leaves the config untouched
// and Naru running on the base agents.
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import {
    applyVariantsToConfig,
    parseModelsConfig,
    readAuthProviders,
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
        // A malformed runtime config must not take Naru down; the base
        // agents keep working and simply inherit the session model.
        return {};
    }
    finally {
        await handle.close();
    }
}

export const NaruDispatchPlugin = async () => {
    const classes = await loadModelsConfig();
    const authProviders = readAuthProviders();
    return {
        config: async (config) => {
            if (Object.keys(classes).length === 0) return;
            try {
                applyVariantsToConfig(config, classes, authProviders);
            }
            catch {
                // Fail open: a config this hook cannot safely extend is left
                // exactly as OpenCode built it.
            }
        },
    };
};
