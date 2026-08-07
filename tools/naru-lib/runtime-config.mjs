// Naru runtime configuration.
// Small on purpose: the orchestrator decides fan-out at reasoning time, so the
// only durable settings are the workspace mode and a runaway-concurrency brake.
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { basename } from 'node:path';
const MAX_CONFIG_BYTES = 64 * 1024;
const WORKSPACE_MODES = Object.freeze(['auto', 'shared', 'worktree']);
const MAX_CONCURRENT_WRITERS = 50;
export const DEFAULT_RUNTIME_CONFIG = Object.freeze({
    schemaVersion: 1,
    implementation: Object.freeze({
        workspaceMode: 'auto',
        maxConcurrentWriters: MAX_CONCURRENT_WRITERS,
        cleanWorkspaceRequired: true,
    }),
});
function isPlainObject(value) {
    if (value === null || typeof value !== 'object' || Array.isArray(value))
        return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
}
function assertObject(value, label) {
    if (!isPlainObject(value))
        throw new Error(`${label} must be a plain object`);
}
function assertAllowedKeys(value, fields, label) {
    const allowed = new Set(fields);
    const unknown = Object.keys(value).filter((key) => !allowed.has(key));
    if (unknown.length > 0)
        throw new Error(`${label} contains unknown fields: ${unknown.sort().join(', ')}`);
}
function integerOption(value, fallback, label, { minimum, maximum }) {
    const resolved = value === undefined ? fallback : value;
    if (typeof resolved !== 'number' || !Number.isSafeInteger(resolved) || resolved < minimum || resolved > maximum) {
        throw new Error(`${label} must be an integer from ${minimum} to ${maximum}`);
    }
    return resolved;
}
function enumOption(value, fallback, allowed, label) {
    const resolved = value === undefined ? fallback : value;
    const match = typeof resolved === 'string' ? allowed.find((entry) => entry === resolved) : undefined;
    if (match === undefined)
        throw new Error(`${label} must be one of ${allowed.join(', ')}`);
    return match;
}
export function parseRuntimeConfig(value = undefined) {
    if (value === undefined || value === null) {
        return { schemaVersion: 1, implementation: { ...DEFAULT_RUNTIME_CONFIG.implementation } };
    }
    assertObject(value, 'naru runtime config');
    assertAllowedKeys(value, ['implementation', 'models', 'schemaVersion'], 'naru runtime config');
    if (value.schemaVersion !== undefined && value.schemaVersion !== 1) {
        throw new Error('naru runtime config schemaVersion must be 1');
    }
    const implementation = value.implementation ?? {};
    assertObject(implementation, 'implementation config');
    assertAllowedKeys(implementation, Object.keys(DEFAULT_RUNTIME_CONFIG.implementation), 'implementation config');
    if (implementation.cleanWorkspaceRequired !== undefined && implementation.cleanWorkspaceRequired !== true) {
        throw new Error('implementation.cleanWorkspaceRequired must be true');
    }
    // The optional models block is validated by tools/naru-lib/dispatch.mjs,
    // which is its only consumer; here it only needs to be a plain object so
    // that a typo cannot break the worktree tool or doctor.
    if (value.models !== undefined && !isPlainObject(value.models)) {
        throw new Error('models must be a plain object of model classes');
    }
    return {
        schemaVersion: 1,
        ...(value.models !== undefined ? { models: value.models } : {}),
        implementation: {
            workspaceMode: enumOption(implementation.workspaceMode, DEFAULT_RUNTIME_CONFIG.implementation.workspaceMode, WORKSPACE_MODES, 'implementation.workspaceMode'),
            maxConcurrentWriters: integerOption(implementation.maxConcurrentWriters, DEFAULT_RUNTIME_CONFIG.implementation.maxConcurrentWriters, 'implementation.maxConcurrentWriters', { minimum: 1, maximum: MAX_CONCURRENT_WRITERS }),
            cleanWorkspaceRequired: true,
        },
    };
}
function hasControl(value) {
    for (let index = 0; index < value.length; index += 1) {
        const code = value.charCodeAt(index);
        if (code <= 31 || code === 127)
            return true;
    }
    return false;
}
function assertSafeConfigPath(path) {
    if (typeof path !== 'string' ||
        path.length === 0 ||
        path.length > 4096 ||
        hasControl(path)) {
        throw new Error('config path is invalid');
    }
    const name = basename(path);
    if (!name.endsWith('.json') || /(?:^|\.)(?:env|pem|key|p12|pfx)$/i.test(name)) {
        throw new Error('config path must identify a non-secret JSON file');
    }
}
export async function loadRuntimeConfigFile(path) {
    assertSafeConfigPath(path);
    const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
        const stats = await handle.stat();
        if (!stats.isFile())
            throw new Error('config path must identify a regular file');
        if (stats.size > MAX_CONFIG_BYTES)
            throw new Error(`runtime config exceeds ${MAX_CONFIG_BYTES} bytes`);
        const text = await handle.readFile({ encoding: 'utf8' });
        if (Buffer.byteLength(text, 'utf8') > MAX_CONFIG_BYTES) {
            throw new Error(`runtime config exceeds ${MAX_CONFIG_BYTES} bytes`);
        }
        let value;
        try {
            value = JSON.parse(text);
        }
        catch {
            throw new Error('runtime config contains invalid JSON');
        }
        return parseRuntimeConfig(value);
    }
    finally {
        await handle.close();
    }
}
export const IMPLEMENTATION_WORKSPACE_MODES = WORKSPACE_MODES;
