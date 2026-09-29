// Naru runtime configuration.
// Small on purpose: settings cover workspace behavior, review defaults, and
// explicitly opted-in configured MCP policy. The native plugin passes
// DEFAULT_RUNTIME_CONFIG; there is no runtime config file.
const WORKSPACE_MODES = Object.freeze(['auto', 'shared', 'worktree'] as const);
const REVIEW_PROFILES = Object.freeze(['standard', 'release-critical'] as const);
const REVIEW_DECISIONS = Object.freeze(['automatic', 'comment-only'] as const);
const REVIEW_OUTPUTS = Object.freeze(['concise', 'detailed'] as const);
const CONFIGURED_MCP_TOOL_MODES = Object.freeze(['off', 'ask', 'allow'] as const);
const MAX_CONCURRENT_WRITERS = 50;
type UnknownRecord = Record<string, unknown>;

export type ImplementationWorkspaceMode = typeof WORKSPACE_MODES[number];
export interface RuntimeImplementationConfig {
    workspaceMode: ImplementationWorkspaceMode;
    maxConcurrentWriters: number;
    cleanWorkspaceRequired: true;
}
export interface RuntimeReviewConfig {
    defaultProfile: typeof REVIEW_PROFILES[number];
    defaultDecision: typeof REVIEW_DECISIONS[number];
    defaultOutput: typeof REVIEW_OUTPUTS[number];
}
export interface RuntimeMcpConfig {
    configuredTools: typeof CONFIGURED_MCP_TOOL_MODES[number];
}

export interface RuntimeConfig {
    schemaVersion: 1;
    implementation: RuntimeImplementationConfig;
    mcp: RuntimeMcpConfig;
    review: RuntimeReviewConfig;
}

export const DEFAULT_RUNTIME_CONFIG = Object.freeze({
    schemaVersion: 1,
    implementation: Object.freeze({
        workspaceMode: 'auto',
        maxConcurrentWriters: MAX_CONCURRENT_WRITERS,
        cleanWorkspaceRequired: true,
    }),
    mcp: Object.freeze({
        configuredTools: 'off',
    }),
    review: Object.freeze({
        defaultProfile: 'standard',
        defaultDecision: 'comment-only',
        defaultOutput: 'detailed',
    }),
}) satisfies Readonly<RuntimeConfig>;
function isPlainObject(value: unknown): value is UnknownRecord {
    if (value === null || typeof value !== 'object' || Array.isArray(value))
        return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
}
function assertObject(value: unknown, label: string): asserts value is UnknownRecord {
    if (!isPlainObject(value))
        throw new Error(`${label} must be a plain object`);
}
function assertAllowedKeys(value: UnknownRecord, fields: readonly string[], label: string): void {
    const allowed = new Set(fields);
    const unknown = Object.keys(value).filter((key) => !allowed.has(key));
    if (unknown.length > 0)
        throw new Error(`${label} contains unknown fields: ${unknown.sort().join(', ')}`);
}
function integerOption(value: unknown, fallback: number, label: string, { minimum, maximum }: { minimum: number; maximum: number }): number {
    const resolved = value === undefined ? fallback : value;
    if (typeof resolved !== 'number' || !Number.isSafeInteger(resolved) || resolved < minimum || resolved > maximum) {
        throw new Error(`${label} must be an integer from ${minimum} to ${maximum}`);
    }
    return resolved;
}
function enumOption<T extends string>(value: unknown, fallback: T, allowed: readonly T[], label: string): T {
    const resolved = value === undefined ? fallback : value;
    const match = typeof resolved === 'string' ? allowed.find((entry) => entry === resolved) : undefined;
    if (match === undefined)
        throw new Error(`${label} must be one of ${allowed.join(', ')}`);
    return match;
}
export function parseRuntimeConfig(value: unknown = undefined): RuntimeConfig {
    if (value === undefined || value === null) {
        return { schemaVersion: 1, implementation: { ...DEFAULT_RUNTIME_CONFIG.implementation }, mcp: { ...DEFAULT_RUNTIME_CONFIG.mcp }, review: { ...DEFAULT_RUNTIME_CONFIG.review } };
    }
    assertObject(value, 'naru runtime config');
    assertAllowedKeys(value, ['implementation', 'mcp', 'review', 'schemaVersion'], 'naru runtime config');
    if (value.schemaVersion !== undefined && value.schemaVersion !== 1) {
        throw new Error('naru runtime config schemaVersion must be 1');
    }
    const implementation = value.implementation ?? {};
    assertObject(implementation, 'implementation config');
    assertAllowedKeys(implementation, Object.keys(DEFAULT_RUNTIME_CONFIG.implementation), 'implementation config');
    if (implementation.cleanWorkspaceRequired !== undefined && implementation.cleanWorkspaceRequired !== true) {
        throw new Error('implementation.cleanWorkspaceRequired must be true');
    }
    const mcp = value.mcp ?? {};
    assertObject(mcp, 'mcp config');
    assertAllowedKeys(mcp, Object.keys(DEFAULT_RUNTIME_CONFIG.mcp), 'mcp config');
    const review = value.review ?? {};
    assertObject(review, 'review config');
    assertAllowedKeys(review, Object.keys(DEFAULT_RUNTIME_CONFIG.review), 'review config');
    return {
        schemaVersion: 1,
        implementation: {
            workspaceMode: enumOption(implementation.workspaceMode, DEFAULT_RUNTIME_CONFIG.implementation.workspaceMode, WORKSPACE_MODES, 'implementation.workspaceMode'),
            maxConcurrentWriters: integerOption(implementation.maxConcurrentWriters, DEFAULT_RUNTIME_CONFIG.implementation.maxConcurrentWriters, 'implementation.maxConcurrentWriters', { minimum: 1, maximum: MAX_CONCURRENT_WRITERS }),
            cleanWorkspaceRequired: true,
        },
        mcp: {
            configuredTools: enumOption(mcp.configuredTools, DEFAULT_RUNTIME_CONFIG.mcp.configuredTools, CONFIGURED_MCP_TOOL_MODES, 'mcp.configuredTools'),
        },
        review: {
            defaultProfile: enumOption(review.defaultProfile, DEFAULT_RUNTIME_CONFIG.review.defaultProfile, REVIEW_PROFILES, 'review.defaultProfile'),
            defaultDecision: enumOption(review.defaultDecision, DEFAULT_RUNTIME_CONFIG.review.defaultDecision, REVIEW_DECISIONS, 'review.defaultDecision'),
            defaultOutput: enumOption(review.defaultOutput, DEFAULT_RUNTIME_CONFIG.review.defaultOutput, REVIEW_OUTPUTS, 'review.defaultOutput'),
        },
    };
}
