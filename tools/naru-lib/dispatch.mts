import { buildReviewDefaultsAppendix } from './review-defaults.mjs';
export { buildReviewDefaultsAppendix } from './review-defaults.mjs';
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
// maps. A separate policy pass may add provenance-tracked MCP asks to writer
// variants only; model selection itself never changes permissions. The names naru-reader-*, naru-runner-*, and
// naru-writer-* are a reserved, Naru-managed namespace.
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
}

export type ConfiguredMcpCategory = 'collision' | 'disabled' | 'eligible' | 'malformed' | 'protected';
export interface ConfiguredMcpDiagnostic {
    serverName: string;
    normalizedName: string | null;
    category: ConfiguredMcpCategory;
    reason: string;
}
export interface ConfiguredMcpAnalysis {
    diagnostics: ConfiguredMcpDiagnostic[];
    rules: string[];
}
export interface DispatchApplicationSummary extends VariantApplicationSummary {
    configuredMcp: ConfiguredMcpAnalysis;
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
const PROTECTED_MCP_NAMESPACES = new Set(['codebase-memory-mcp']);
const PROTECTED_MCP_TOOLS = Object.freeze([
    'codebase-memory-mcp_delete_project',
    'codebase-memory-mcp_index_repository',
    'codebase-memory-mcp_ingest_traces',
    'codebase-memory-mcp_query_graph',
    'codebase-memory-mcp_search_graph',
]);
const KNOWN_NON_MCP_TOOLS = Object.freeze([
    'apply_patch', 'bash', 'batch', 'codesearch', 'doom_loop', 'edit', 'external_directory', 'glob', 'grep', 'lsp', 'multi_tool_use', 'multiedit', 'naru-check',
    'naru-git-read', 'naru-github-post-review', 'naru-github-read', 'naru-worktree',
    'question', 'read', 'skill', 'task', 'todowrite', 'webfetch', 'websearch', 'write',
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
    if (name.length === 0 || name.length > 128) return false;
    for (let index = 0; index < name.length; index += 1) {
        const code = name.charCodeAt(index);
        if (code <= 31 || code === 127) return false;
    }
    return true;
}

function overlapsProtectedMcp(normalizedName: string): boolean {
    const generatedPrefix = `${normalizedName}_`;
    return [...PROTECTED_MCP_NAMESPACES].some((protectedName) =>
        normalizedName === protectedName ||
        normalizedName.startsWith(`${protectedName}_`) ||
        protectedName.startsWith(`${normalizedName}_`)) ||
        PROTECTED_MCP_TOOLS.some((tool) => tool.startsWith(generatedPrefix));
}

// OpenCode 1.18.29 registers MCP tools as
// `${serverName.replace(/[^a-zA-Z0-9_-]/g, '_')}_${toolName}`. This analysis
// deliberately uses only server names and `enabled`; connection details never
// enter Naru policy state or diagnostics.
export function analyzeConfiguredMcp(value: unknown): ConfiguredMcpAnalysis {
    if (value === undefined || value === null) return { diagnostics: [], rules: [] };
    if (!isPlainObject(value)) {
        return { diagnostics: [{ serverName: '', normalizedName: null, category: 'malformed', reason: 'mcp config is not a server map' }], rules: [] };
    }
    const diagnostics: ConfiguredMcpDiagnostic[] = [];
    const valid: Array<{ serverName: string; normalizedName: string; category: 'candidate' | 'disabled' | 'protected' }> = [];
    for (const serverName of Object.keys(value).sort()) {
        const server = value[serverName];
        const normalizedName = safeServerName(serverName) ? normalizeMcpServerName(serverName) : null;
        if (!isPlainObject(server) || normalizedName === null || normalizedName.length === 0 ||
            (server.enabled !== undefined && typeof server.enabled !== 'boolean')) {
            diagnostics.push({ serverName, normalizedName, category: 'malformed', reason: 'server name or enabled state is malformed' });
            continue;
        }
        if (overlapsProtectedMcp(normalizedName)) valid.push({ serverName, normalizedName, category: 'protected' });
        else if (server.enabled === false) valid.push({ serverName, normalizedName, category: 'disabled' });
        else valid.push({ serverName, normalizedName, category: 'candidate' });
    }
    const collided = new Set<string>();
    for (let left = 0; left < valid.length; left += 1) {
        const first = valid[left];
        if (!first || first.category !== 'candidate') continue;
        const prefix = `${first.normalizedName}_`;
        if (KNOWN_NON_MCP_TOOLS.some((tool) => tool.startsWith(prefix))) collided.add(first.serverName);
        for (let right = 0; right < valid.length; right += 1) {
            const second = valid[right];
            if (!second || second.category === 'disabled' || first.serverName === second.serverName) continue;
            if (first.normalizedName === second.normalizedName ||
                first.normalizedName.startsWith(`${second.normalizedName}_`) ||
                second.normalizedName.startsWith(`${first.normalizedName}_`)) {
                collided.add(first.serverName);
                if (second.category === 'candidate') collided.add(second.serverName);
            }
        }
    }
    for (const entry of valid) {
        if (entry.category === 'protected') {
            diagnostics.push({ ...entry, category: 'protected', reason: 'namespace overlaps an explicitly curated namespace; absent administrative tools stay unavailable' });
        }
        else if (entry.category === 'disabled') {
            diagnostics.push({ ...entry, category: 'disabled', reason: 'server is disabled' });
        }
        else if (collided.has(entry.serverName)) {
            diagnostics.push({ ...entry, category: 'collision', reason: 'namespace overlaps another configured server namespace or a known non-MCP tool' });
        }
        else {
            diagnostics.push({ ...entry, category: 'eligible', reason: 'enabled server has an isolated namespace' });
        }
    }
    diagnostics.sort((left, right) => left.serverName.localeCompare(right.serverName) || left.category.localeCompare(right.category));
    const rules = diagnostics
        .filter((entry) => entry.category === 'eligible' && entry.normalizedName !== null)
        .map((entry) => `${entry.normalizedName}_*`)
        .sort();
    return { diagnostics, rules };
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

function ownedMcpRules(options: unknown): Record<string, 'ask'> {
    if (!isPlainObject(options)) return {};
    const metadata = options[MCP_POLICY_METADATA];
    if (!isPlainObject(metadata) || metadata.version !== 1 || !isPlainObject(metadata.rules)) return {};
    const rules: Record<string, 'ask'> = {};
    for (const [key, action] of Object.entries(metadata.rules)) {
        if (action === 'ask') rules[key] = action;
    }
    return rules;
}

function applyMcpRulesToAgent(agent: UnknownRecord, rules: readonly string[]): void {
    if (!isPlainObject(agent.permission) || agent.permission['*'] !== 'deny' || Object.keys(agent.permission)[0] !== '*') {
        throw new Error('eligible agent permissions must begin with a wildcard deny');
    }
    const permission = { ...agent.permission };
    const options = isPlainObject(agent.options) ? { ...agent.options } : {};
    for (const [key, action] of Object.entries(ownedMcpRules(options))) {
        if (permission[key] === action) delete permission[key];
    }
    delete options[MCP_POLICY_METADATA];

    const generated: Record<string, 'ask'> = {};
    for (const key of rules) {
        // An existing exact or wildcard policy is user/Naru authored and wins.
        if (!Object.hasOwn(permission, key)) generated[key] = 'ask';
    }
    const rebuilt: UnknownRecord = { '*': permission['*'], ...generated };
    for (const [key, action] of Object.entries(permission)) {
        if (key !== '*') rebuilt[key] = action;
    }
    agent.permission = rebuilt;
    if (Object.keys(generated).length > 0) {
        options[MCP_POLICY_METADATA] = { version: 1, rules: generated };
    }
    if (Object.keys(options).length > 0 || isPlainObject(agent.options)) agent.options = options;
}

export function applyConfiguredMcpPermissionsToConfig(config: unknown, mode: RuntimeMcpConfig['configuredTools'], mcp: unknown): ConfiguredMcpAnalysis {
    if (!isPlainObject(config) || !isPlainObject(config.agent)) throw new Error('OpenCode configuration has no agent map');
    const analysis = analyzeConfiguredMcp(mcp);
    const rules = mode === 'ask' ? analysis.rules : [];
    const eligible = [ORCHESTRATOR, 'naru-writer', ...Object.keys(config.agent).filter((name) => /^naru-writer-[a-z][a-z0-9-]{0,31}$/.test(name))];
    for (const name of eligible) {
        const candidate = config.agent[name];
        if (!isPlainObject(candidate)) throw new Error(`agent ${name} is not configured`);
        applyMcpRulesToAgent(candidate, rules);
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

export function applyDispatchToConfigAtomically(config: unknown, classes: ModelsConfig, authProviders: ReadonlySet<string> | null | undefined, mcpMode: RuntimeMcpConfig['configuredTools'], mcp: unknown): DispatchApplicationSummary {
    if (!isPlainObject(config) || !isPlainObject(config.agent)) throw new Error('OpenCode configuration has no agent map');
    const draft = configDraft(config);
    const summary = applyVariantsToConfig(draft, classes, authProviders);
    const configuredMcp = applyConfiguredMcpPermissionsToConfig(draft, mcpMode, mcp);
    const draftAgents = draft.agent;
    if (!isPlainObject(draftAgents)) throw new Error('draft OpenCode configuration has no agent map');
    for (const name of Object.keys(config.agent)) delete config.agent[name];
    Object.assign(config.agent, draftAgents);
    return { ...summary, configuredMcp };
}

export function applyRuntimeToConfigAtomically(config: unknown, classes: ModelsConfig, authProviders: ReadonlySet<string> | null | undefined, review: RuntimeReviewConfig): VariantApplicationSummary {
    if (!isPlainObject(config) || !isPlainObject(config.agent)) throw new Error('OpenCode configuration has no agent map');
    const draft = configDraft(config);
    const summary = applyVariantsToConfig(draft, classes, authProviders);
    applyReviewDefaultsToConfig(draft, review);
    const draftAgents = draft.agent;
    if (!isPlainObject(draftAgents)) throw new Error('draft OpenCode configuration has no agent map');
    for (const name of Object.keys(config.agent)) delete config.agent[name];
    Object.assign(config.agent, draftAgents);
    return summary;
}
