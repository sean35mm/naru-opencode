// Naru dispatch: per-task model selection via generated agent variants.
//
// The optional `models` block in naru-runtime.json defines model classes.
// For each class this module clones the three base subagents into hidden
// variants — naru-reader-<class>, naru-runner-<class>, naru-writer-<class> —
// with the class's model and effort baked in. The orchestrator then picks a
// model per task by dispatching a variant through OpenCode's native task
// tool, which keeps the TUI's subagent rendering, click-through, and thread
// cycling intact.
//
// Safety: variants begin as byte-for-byte clones of the base agents' permission
// maps. A separate, provenance-tracked pass may add configured MCP policy to all
// Naru roles; model selection itself never changes permissions.
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { RuntimeMcpConfig, RuntimeReviewConfig } from './runtime-config.mjs';

export const VARIANT_ROLES = Object.freeze(['naru-reader', 'naru-runner', 'naru-writer'] as const);
export const ORCHESTRATOR = 'naru-orchestrator';

type UnknownRecord = Record<string, unknown>;
export type VariantRole = typeof VARIANT_ROLES[number];

export interface ModelCandidate {
    providerID: string;
    modelID: string;
    effort?: string;
}

export interface ModelClassDefinition {
    use: string;
    chain: ModelCandidate[];
}

export type ModelsConfig = Record<string, ModelClassDefinition>;

export interface GeneratedModelClass {
    className: string;
    label: string;
    use: string;
}

export interface VariantApplicationSummary {
    variants: string[];
    classes: string[];
    configuredMcp?: ConfiguredMcpAnalysis;
}

export interface ConfiguredMcpDiagnostic {
    serverName: string;
    normalizedName: string | null;
    category: 'collision' | 'disabled' | 'eligible' | 'malformed' | 'unsafe';
    reason: string;
}

export interface ConfiguredMcpAnalysis {
    diagnostics: ConfiguredMcpDiagnostic[];
    rules: string[];
}

const MAX_CLASSES = 16;
const MAX_CHAIN = 4;
const MAX_USE_LENGTH = 200;
const CLASS_NAME_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;
const MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const EFFORT_PATTERN = /^[a-z][a-z0-9-]{0,15}$/;
const VARIANT_NAME_PATTERN = /^naru-(?:reader|runner|writer)-[a-z][a-z0-9-]{0,31}$/;
const APPENDIX_BEGIN = '<!-- naru-model-classes:begin -->';
const APPENDIX_END = '<!-- naru-model-classes:end -->';
const REVIEW_APPENDIX_BEGIN = '<!-- naru-review-defaults:begin -->';
const REVIEW_APPENDIX_END = '<!-- naru-review-defaults:end -->';
const MCP_POLICY_METADATA = 'naruConfiguredMcpPolicy';
const KNOWN_NON_MCP_TOOLS = Object.freeze([
    'apply_patch', 'bash', 'batch', 'codesearch', 'doom_loop', 'edit', 'external_directory', 'glob', 'grep', 'lsp', 'multi_tool_use', 'multiedit',
    'naru-git-read', 'naru-github-post-review', 'naru-github-read', 'naru-worktree', 'question', 'read', 'skill', 'task', 'todowrite', 'webfetch', 'websearch', 'write',
]);

export function parseChainEntry(value: unknown, label = 'chain entry'): ModelCandidate {
    if (typeof value !== 'string' || value.length === 0 || value.length > 128) {
        throw new Error(`${label} must be a short string like "provider/model" or "provider/model@effort"`);
    }
    const at = value.indexOf('@');
    const modelPart = at === -1 ? value : value.slice(0, at);
    const effort = at === -1 ? undefined : value.slice(at + 1);
    if (!MODEL_PATTERN.test(modelPart)) {
        throw new Error(`${label} "${value}" must look like "provider/model-id"`);
    }
    if (effort !== undefined && !EFFORT_PATTERN.test(effort)) {
        throw new Error(`${label} "${value}" has an invalid effort suffix`);
    }
    const slash = modelPart.indexOf('/');
    return {
        providerID: modelPart.slice(0, slash),
        modelID: modelPart.slice(slash + 1),
        ...(effort !== undefined ? { effort } : {}),
    };
}

export function parseModelsConfig(value: unknown): ModelsConfig {
    if (value === undefined || value === null) return {};
    if (!isPlainObject(value)) {
        throw new Error('models config must be a plain object of class definitions');
    }
    const names = Object.keys(value);
    if (names.length > MAX_CLASSES) throw new Error(`models config allows at most ${MAX_CLASSES} classes`);
    const classes: ModelsConfig = {};
    for (const name of names) {
        if (!CLASS_NAME_PATTERN.test(name)) {
            throw new Error(`model class name "${name}" must be short lowercase kebab-case`);
        }
        const entry = value[name];
        if (!isPlainObject(entry)) {
            throw new Error(`model class "${name}" must be an object with "use" and "chain"`);
        }
        const unknown = Object.keys(entry).filter((key) => key !== 'use' && key !== 'chain');
        if (unknown.length > 0) {
            throw new Error(`model class "${name}" has unknown fields: ${unknown.sort().join(', ')}`);
        }
        if (typeof entry.use !== 'string' || entry.use.length === 0 || entry.use.length > MAX_USE_LENGTH) {
            throw new Error(`model class "${name}" needs a short "use" description`);
        }
        if (!Array.isArray(entry.chain) || entry.chain.length === 0 || entry.chain.length > MAX_CHAIN) {
            throw new Error(`model class "${name}" needs a "chain" of 1 to ${MAX_CHAIN} models`);
        }
        classes[name] = {
            use: entry.use,
            chain: entry.chain.map((item, index) => parseChainEntry(item, `models.${name}.chain[${index}]`)),
        };
    }
    return classes;
}

export function modelLabel(candidate: ModelCandidate | null | undefined): string {
    if (!candidate) return 'inherited';
    return `${candidate.providerID}/${candidate.modelID}${candidate.effort ? `@${candidate.effort}` : ''}`;
}

export function readAuthProviders(path = join(homedir(), '.local', 'share', 'opencode', 'auth.json')): Set<string> | null {
    try {
        const raw = readFileSync(path, 'utf8');
        if (raw.length > 256 * 1024) return null;
        const value: unknown = JSON.parse(raw);
        if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
        return new Set(Object.keys(value));
    }
    catch {
        return null;
    }
}

// First chain entry whose provider is authenticated; when auth state is
// unknown, trust the config and take the first entry. Model IDs the catalog
// does not know are attempted anyway (openai's -fast tier IDs are absent
// from the catalog but work), so auth is the only availability signal used.
export function pickChainEntry(classDef: ModelClassDefinition, authProviders: ReadonlySet<string> | null | undefined): ModelCandidate | null {
    for (const entry of classDef.chain) {
        if (authProviders === null || authProviders === undefined || authProviders.has(entry.providerID)) {
            return entry;
        }
    }
    return null;
}

export function variantAgentName(role: VariantRole, className: string): string {
    return `${role}-${className}`;
}

function isPlainObject(value: unknown): value is UnknownRecord {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function normalizeMcpServerName(name: string): string {
    return name.replace(/[^a-zA-Z0-9_-]/g, '_');
}

function safeServerName(name: string): boolean {
    if (name.length === 0 || name.length > 128 || /[*?\[\]{}]/.test(name)) return false;
    for (let index = 0; index < name.length; index += 1) {
        const code = name.charCodeAt(index);
        if (code <= 31 || code === 127) return false;
    }
    return true;
}

// OpenCode 1.18.x registers MCP tools as
// `${serverName.replace(/[^a-zA-Z0-9_-]/g, '_')}_${toolName}`. Only server IDs
// and enabled flags are inspected; connection and credential fields stay opaque.
export function analyzeConfiguredMcp(value: unknown): ConfiguredMcpAnalysis {
    if (value === undefined || value === null) return { diagnostics: [], rules: [] };
    if (!isPlainObject(value)) {
        return { diagnostics: [{ serverName: '', normalizedName: null, category: 'malformed', reason: 'mcp config is not a server map' }], rules: [] };
    }
    const diagnostics: ConfiguredMcpDiagnostic[] = [];
    const candidates: Array<{ serverName: string; normalizedName: string }> = [];
    for (const serverName of Object.keys(value).sort()) {
        const server = value[serverName];
        const normalizedName = safeServerName(serverName) ? normalizeMcpServerName(serverName) : null;
        if (!isPlainObject(server) || normalizedName === null || normalizedName.length === 0 ||
            (server.enabled !== undefined && typeof server.enabled !== 'boolean')) {
            diagnostics.push({ serverName, normalizedName, category: normalizedName === null ? 'unsafe' : 'malformed', reason: 'server name, definition, or enabled state is invalid' });
        }
        else if (server.enabled === false) {
            diagnostics.push({ serverName, normalizedName, category: 'disabled', reason: 'server is disabled' });
        }
        else {
            candidates.push({ serverName, normalizedName });
        }
    }
    const collided = new Set<string>();
    for (let left = 0; left < candidates.length; left += 1) {
        const first = candidates[left];
        if (!first) continue;
        const prefix = `${first.normalizedName}_`;
        if (KNOWN_NON_MCP_TOOLS.some((tool) => tool.startsWith(prefix))) collided.add(first.serverName);
        for (let right = left + 1; right < candidates.length; right += 1) {
            const second = candidates[right];
            if (!second) continue;
            if (first.normalizedName === second.normalizedName ||
                first.normalizedName.startsWith(`${second.normalizedName}_`) ||
                second.normalizedName.startsWith(`${first.normalizedName}_`)) {
                collided.add(first.serverName);
                collided.add(second.serverName);
            }
        }
    }
    for (const candidate of candidates) {
        diagnostics.push(collided.has(candidate.serverName)
            ? { ...candidate, category: 'collision', reason: 'namespace overlaps another configured server or a native tool' }
            : { ...candidate, category: 'eligible', reason: 'enabled server has an isolated namespace' });
    }
    diagnostics.sort((left, right) => left.serverName.localeCompare(right.serverName) || left.category.localeCompare(right.category));
    return {
        diagnostics,
        rules: diagnostics.filter((entry) => entry.category === 'eligible' && entry.normalizedName !== null).map((entry) => `${entry.normalizedName}_*`).sort(),
    };
}

function clone(value: UnknownRecord): UnknownRecord {
    const cloned: unknown = JSON.parse(JSON.stringify(value));
    if (!isPlainObject(cloned)) throw new Error('agent configuration could not be cloned safely');
    return cloned;
}

function stripAppendix(prompt: string): string {
    const begin = prompt.indexOf(APPENDIX_BEGIN);
    if (begin === -1) return prompt;
    const end = prompt.indexOf(APPENDIX_END);
    if (end === -1) return prompt.slice(0, begin).trimEnd();
    return (prompt.slice(0, begin) + prompt.slice(end + APPENDIX_END.length)).trimEnd();
}

function replaceBoundedAppendix(prompt: string, beginMarker: string, endMarker: string, appendix: string): string {
    const begin = prompt.indexOf(beginMarker);
    const end = begin === -1 ? -1 : prompt.indexOf(endMarker, begin + beginMarker.length);
    const bare = begin === -1
        ? prompt.trimEnd()
        : (prompt.slice(0, begin) + (end === -1 ? '' : prompt.slice(end + endMarker.length))).trimEnd();
    return appendix ? `${bare}\n\n${appendix}` : bare;
}

export function buildReviewDefaultsAppendix(review: RuntimeReviewConfig): string {
    return [
        REVIEW_APPENDIX_BEGIN,
        '',
        '## Review defaults (generated from naru-runtime.json)',
        '',
        `Effective defaults: profile=${review.defaultProfile}; decision=${review.defaultDecision}; output=${review.defaultOutput}.`,
        'Persistent configuration never authorizes a post or formal review state. For generic',
        'current-message post/comment/submit requests, decision is always comment-only even when',
        'defaultDecision=automatic. Only the native /naru ship-review invocation itself authorizes',
        'automatic select-state for its finite targets; it also supplies release-critical/concise defaults.',
        '',
        REVIEW_APPENDIX_END,
    ].join('\n');
}

export function applyReviewDefaultsToConfig(config: unknown, review: RuntimeReviewConfig): void {
    if (!isPlainObject(config) || !isPlainObject(config.agent)) throw new Error('OpenCode configuration has no agent map');
    const orchestrator = config.agent[ORCHESTRATOR];
    if (!isPlainObject(orchestrator) || typeof orchestrator.prompt !== 'string') {
        throw new Error(`agent ${ORCHESTRATOR} has no prompt`);
    }
    orchestrator.prompt = replaceBoundedAppendix(orchestrator.prompt, REVIEW_APPENDIX_BEGIN, REVIEW_APPENDIX_END, buildReviewDefaultsAppendix(review));
}

export function buildPromptAppendix(generated: readonly GeneratedModelClass[]): string {
    if (generated.length === 0) return '';
    const lines = [
        APPENDIX_BEGIN,
        '',
        '## Model classes (generated from naru-runtime.json)',
        '',
        'Each class below exists as three dispatchable agents — naru-reader-<class>,',
        'naru-runner-<class>, and naru-writer-<class> — identical to the base agents',
        'except for the model baked in. Pick the class per task: cheap and wide for',
        'breadth, heavy only where the answer carries consequence. Base agents',
        '(naru-reader, naru-runner, naru-writer) inherit the session model.',
        '',
    ];
    for (const item of generated) {
        lines.push(`- "${item.className}" -> ${item.label}: ${item.use}`);
    }
    lines.push('', APPENDIX_END);
    return lines.join('\n');
}

// Mutates an OpenCode config object: regenerates variant agents from the
// current classes and refreshes the orchestrator's task allowlist and prompt
// appendix. Idempotent — safe to call on every config hook invocation. All
// validation happens before any mutation so a bad config leaves the object
// untouched.
export function applyVariantsToConfig(config: unknown, classes: ModelsConfig, authProviders: ReadonlySet<string> | null | undefined): VariantApplicationSummary {
    if (!isPlainObject(config) || !isPlainObject(config.agent)) {
        throw new Error('OpenCode configuration has no agent map');
    }
    const agents = config.agent;
    const orchestrator = agents[ORCHESTRATOR];
    if (!isPlainObject(orchestrator)) throw new Error(`agent ${ORCHESTRATOR} is not configured`);
    const permission = orchestrator.permission;
    if (!isPlainObject(permission) || !isPlainObject(permission.task)) {
        throw new Error(`agent ${ORCHESTRATOR} has no task permission map`);
    }
    const taskPermissions = permission.task;
    if (taskPermissions['*'] !== 'deny') {
        throw new Error(`agent ${ORCHESTRATOR} task permissions must begin fail-closed`);
    }
    const bases: Record<VariantRole, UnknownRecord> = Object.create(null);
    for (const role of VARIANT_ROLES) {
        const base = agents[role];
        if (!isPlainObject(base)) throw new Error(`agent ${role} is not configured`);
        if (taskPermissions[role] !== 'allow') {
            throw new Error(`agent ${ORCHESTRATOR} does not allow expected target ${role}`);
        }
        bases[role] = base;
    }

    // Build everything before mutating anything.
    const generated: GeneratedModelClass[] = [];
    const variants: Record<string, UnknownRecord> = {};
    for (const className of Object.keys(classes)) {
        const def = classes[className];
        if (def === undefined)
            throw new Error(`model class ${className} is unavailable`);
        const entry = pickChainEntry(def, authProviders);
        if (entry === null) continue;
        for (const role of VARIANT_ROLES) {
            const name = variantAgentName(role, className);
            const variant = clone(bases[role]);
            variant.model = `${entry.providerID}/${entry.modelID}`;
            if (entry.effort !== undefined) variant.variant = entry.effort;
            else delete variant.variant;
            variant.hidden = true;
            variant.mode = 'subagent';
            variant.description = `${typeof variant.description === 'string' ? variant.description : ''} Model class "${className}" (${modelLabel(entry)}): ${def.use}`.trim();
            variant.options = { ...(isPlainObject(variant.options) ? variant.options : {}), naruVariant: true };
            variants[name] = variant;
        }
        generated.push({ className, label: modelLabel(entry), use: def.use });
    }

    // Clear the reserved namespace, then install the current generation.
    for (const name of Object.keys(agents)) {
        if (VARIANT_NAME_PATTERN.test(name)) delete agents[name];
    }
    for (const key of Object.keys(taskPermissions)) {
        if (VARIANT_NAME_PATTERN.test(key)) delete taskPermissions[key];
    }
    Object.assign(agents, variants);
    for (const name of Object.keys(variants)) {
        taskPermissions[name] = 'allow';
    }
    if (typeof orchestrator.prompt === 'string') {
        const bare = stripAppendix(orchestrator.prompt);
        const appendix = buildPromptAppendix(generated);
        orchestrator.prompt = appendix ? `${bare}\n\n${appendix}` : bare;
    }
    return { variants: Object.keys(variants).sort(), classes: generated.map((item) => item.className) };
}

interface OwnedMcpPolicy {
    rules: Record<string, 'allow' | 'ask'>;
    overrides: Record<string, 'ask' | Record<string, 'ask'>>;
    positions: Record<string, { index: number; value: unknown }>;
}

function ownedMcpPolicy(options: unknown): OwnedMcpPolicy {
    if (!isPlainObject(options)) return { rules: {}, overrides: {}, positions: {} };
    const metadata = options[MCP_POLICY_METADATA];
    if (!isPlainObject(metadata) || metadata.version !== 1) return { rules: {}, overrides: {}, positions: {} };
    const rules: Record<string, 'allow' | 'ask'> = {};
    const overrides: Record<string, 'ask' | Record<string, 'ask'>> = {};
    const positions: Record<string, { index: number; value: unknown }> = {};
    if (isPlainObject(metadata.rules)) {
        for (const [key, action] of Object.entries(metadata.rules)) {
            if (action === 'allow' || action === 'ask') rules[key] = action;
        }
    }
    if (isPlainObject(metadata.overrides)) {
        for (const [key, action] of Object.entries(metadata.overrides)) {
            if (action === 'ask') overrides[key] = action;
            else if (isPlainObject(action)) {
                const leaves: Record<string, 'ask'> = {};
                for (const [pattern, leaf] of Object.entries(action)) {
                    if (leaf === 'ask') leaves[pattern] = leaf;
                }
                if (Object.keys(leaves).length > 0) overrides[key] = leaves;
            }
        }
    }
    if (isPlainObject(metadata.positions)) {
        for (const [key, entry] of Object.entries(metadata.positions)) {
            if (!isPlainObject(entry) || typeof entry.index !== 'number' || !Number.isSafeInteger(entry.index) || entry.index < 0) continue;
            const value = entry.value;
            if (value === 'allow' || value === 'ask' || value === 'deny' || isPlainObject(value)) {
                positions[key] = { index: entry.index, value };
            }
        }
    }
    return { rules, overrides, positions };
}

function appliesToMcpNamespace(pattern: string, rules: readonly string[]): boolean {
    return rules.some((rule) => pattern.startsWith(rule.slice(0, -1)));
}

function clonePermissionValue(value: unknown): unknown {
    return isPlainObject(value) ? { ...value } : value;
}

function samePermissionValue(left: unknown, right: unknown): boolean {
    if (left === right) return true;
    if (!isPlainObject(left) || !isPlainObject(right)) return false;
    const leftEntries = Object.entries(left);
    const rightEntries = Object.entries(right);
    return leftEntries.length === rightEntries.length && leftEntries.every(([key, value], index) => {
        const other = rightEntries[index];
        return other !== undefined && other[0] === key && other[1] === value;
    });
}

function applyMcpRulesToAgent(agent: UnknownRecord, mode: RuntimeMcpConfig['configuredTools'], rules: readonly string[]): void {
    if (!isPlainObject(agent.permission) || agent.permission['*'] !== 'deny') {
        throw new Error('Naru agent permissions must include a wildcard deny');
    }
    let permission: UnknownRecord = { ...agent.permission };
    const options: UnknownRecord = isPlainObject(agent.options) ? { ...agent.options } : {};
    const previous = ownedMcpPolicy(options);
    for (const [key, action] of Object.entries(previous.rules)) {
        if (permission[key] === action) delete permission[key];
    }
    const positionsToRestore = Object.entries(previous.positions)
        .filter(([key, entry]) => Object.hasOwn(permission, key) && samePermissionValue(permission[key], entry.value))
        .sort((left, right) => left[1].index - right[1].index);
    for (const [key, original] of Object.entries(previous.overrides)) {
        if (original === 'ask') {
            if (permission[key] === 'allow') permission[key] = original;
            continue;
        }
        const current = permission[key];
        if (!isPlainObject(current)) continue;
        const restored: UnknownRecord = { ...current };
        for (const [pattern, action] of Object.entries(original)) {
            if (restored[pattern] === 'allow') restored[pattern] = action;
        }
        permission[key] = restored;
    }
    if (positionsToRestore.length > 0) {
        const moving = new Set(positionsToRestore.map(([key]) => key));
        const entries = Object.entries(permission).filter(([key]) => !moving.has(key));
        for (const [key, entry] of positionsToRestore) {
            entries.splice(Math.min(entry.index, entries.length), 0, [key, permission[key]]);
        }
        permission = Object.fromEntries(entries);
    }
    delete options[MCP_POLICY_METADATA];

    if (mode === 'off') {
        agent.permission = permission;
        if (Object.keys(options).length > 0 || isPlainObject(agent.options)) agent.options = options;
        return;
    }

    const generated: Record<string, 'allow' | 'ask'> = {};
    const overrides: Record<string, 'ask' | Record<string, 'ask'>> = {};
    const originalEntries = Object.entries(permission);
    const mcpPositions: Record<string, { index: number; value: unknown }> = {};
    if (mode === 'allow') {
        for (const [key, action] of Object.entries(permission)) {
            if (!appliesToMcpNamespace(key, rules)) continue;
            if (action === 'ask') {
                permission[key] = 'allow';
                overrides[key] = 'ask';
            }
            else if (isPlainObject(action)) {
                const rewritten: UnknownRecord = { ...action };
                const leaves: Record<string, 'ask'> = {};
                for (const [pattern, leaf] of Object.entries(action)) {
                    if (leaf !== 'ask') continue;
                    rewritten[pattern] = 'allow';
                    leaves[pattern] = 'ask';
                }
                if (Object.keys(leaves).length > 0) {
                    permission[key] = rewritten;
                    overrides[key] = leaves;
                }
            }
        }
    }
    for (const key of rules) {
        if (!Object.hasOwn(permission, key)) generated[key] = mode;
    }
    const mcpEntries: Array<[string, unknown]> = [];
    const rebuilt: UnknownRecord = {};
    for (let index = 0; index < originalEntries.length; index += 1) {
        const entry = originalEntries[index];
        if (!entry) continue;
        const [key] = entry;
        const action = permission[key];
        if (appliesToMcpNamespace(key, rules)) {
            mcpEntries.push([key, action]);
            mcpPositions[key] = { index, value: clonePermissionValue(action) };
        }
        else {
            rebuilt[key] = action;
        }
    }
    Object.assign(rebuilt, generated);
    for (const [key, action] of mcpEntries) rebuilt[key] = action;
    agent.permission = rebuilt;
    if (Object.keys(generated).length > 0 || Object.keys(overrides).length > 0 || Object.keys(mcpPositions).length > 0) {
        options[MCP_POLICY_METADATA] = { version: 1, rules: generated, overrides, positions: mcpPositions };
    }
    if (Object.keys(options).length > 0 || isPlainObject(agent.options)) agent.options = options;
}

export function applyConfiguredMcpPermissionsToConfig(config: unknown, mode: RuntimeMcpConfig['configuredTools'], mcp: unknown): ConfiguredMcpAnalysis {
    if (!isPlainObject(config) || !isPlainObject(config.agent)) throw new Error('OpenCode configuration has no agent map');
    const analysis = analyzeConfiguredMcp(mcp);
    const names = [ORCHESTRATOR, ...VARIANT_ROLES, ...Object.keys(config.agent).filter((name) => VARIANT_NAME_PATTERN.test(name))];
    for (const name of names) {
        const candidate = config.agent[name];
        if (!isPlainObject(candidate)) throw new Error(`agent ${name} is not configured`);
        applyMcpRulesToAgent(candidate, mode, analysis.rules);
    }
    return analysis;
}

function configDraft(config: UnknownRecord): UnknownRecord {
    if (!isPlainObject(config.agent)) throw new Error('OpenCode configuration has no agent map');
    const agents: UnknownRecord = {};
    for (const [name, value] of Object.entries(config.agent)) {
        if (!isPlainObject(value)) {
            agents[name] = value;
            continue;
        }
        const agent = { ...value };
        if (isPlainObject(value.permission)) {
            const permission = { ...value.permission };
            if (isPlainObject(value.permission.task)) permission.task = { ...value.permission.task };
            agent.permission = permission;
        }
        if (isPlainObject(value.options)) agent.options = { ...value.options };
        agents[name] = agent;
    }
    return { ...config, agent: agents };
}

export function applyRuntimeToConfigAtomically(
    config: unknown,
    classes: ModelsConfig,
    authProviders: ReadonlySet<string> | null | undefined,
    review: RuntimeReviewConfig,
    mcpMode: RuntimeMcpConfig['configuredTools'] = 'off',
    mcp: unknown = undefined,
): VariantApplicationSummary {
    if (!isPlainObject(config) || !isPlainObject(config.agent)) throw new Error('OpenCode configuration has no agent map');
    const draft = configDraft(config);
    const summary = applyVariantsToConfig(draft, classes, authProviders);
    const configuredMcp = applyConfiguredMcpPermissionsToConfig(draft, mcpMode, mcp);
    applyReviewDefaultsToConfig(draft, review);
    const draftAgents = draft.agent;
    if (!isPlainObject(draftAgents)) throw new Error('draft OpenCode configuration has no agent map');
    for (const name of Object.keys(config.agent)) delete config.agent[name];
    Object.assign(config.agent, draftAgents);
    return { ...summary, configuredMcp };
}
