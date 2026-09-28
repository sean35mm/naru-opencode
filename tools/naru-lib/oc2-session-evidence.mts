import { createHash } from 'node:crypto';
import { basename } from 'node:path';
import { DatabaseSync, type StatementSync } from 'node:sqlite';

export const OC2_SESSION_EVIDENCE_SCHEMA_VERSION = 1 as const;
export const OC2_DEFAULT_LOOKBACK_DAYS = 14;
export const OC2_MAX_LOOKBACK_DAYS = 365;
export const OC2_DEFAULT_SESSION_LIMIT = 500;
export const OC2_MAX_SESSION_LIMIT = 5_000;

const MAX_MESSAGES = 100_000;
const MAX_TOOL_PARTS = 100_000;
const MAX_FAMILY_DEPTH = 64;
const EXCLUDED_TITLE_PREFIXES = ['[eval]', 'eval:'] as const;
const LEGACY_PREVIEW_VERSIONS = new Set(['0.0.0-beta-19271']);
const TOOL_CATEGORIES = new Map<string, ToolCategory>([
    ['apply_patch', 'patch-write'], ['edit', 'patch-write'], ['patch', 'patch-write'], ['write', 'patch-write'],
    ['subagent', 'subagent'], ['control_task_start', 'subagent'],
    ['bash', 'shell-unknown'], ['execute', 'shell-unknown'], ['shell', 'shell-unknown'],
    ['glob', 'read'], ['grep', 'read'], ['naru-git-read', 'read'], ['read', 'read'], ['repo_files', 'read'],
    ['repo_read', 'read'], ['webfetch', 'read'], ['websearch', 'read'], ['worker_files', 'read'], ['worker_read', 'read'],
]);

export type EvidenceOrigin = 'eval' | 'legacy-preview' | 'synthetic' | 'unknown';
export type OriginConfidence = 'explicit-title-prefix' | 'known-host-version' | 'unknown';
export type ToolCategory = 'other' | 'patch-write' | 'read' | 'shell-unknown' | 'subagent';

export interface EvidenceModel {
    id: string;
    providerID: string;
    variant: string;
}

export interface EvidenceToolCounts {
    attempts: number;
    completed: number;
    errors: number;
    interrupted: number;
}

export interface EvidenceToolCategory extends EvidenceToolCounts {
    category: ToolCategory;
}

export interface NormalizedSession {
    id: string;
    parentId: string | null;
    rootId: string;
    depth: number;
    origin: {
        kind: EvidenceOrigin;
        confidence: OriginConfidence;
        marker: 'eval-title-prefix' | 'legacy-preview-host-version' | 'synthetic-title-prefix' | 'none';
    };
    familyComplete: boolean;
    project: string;
    role: string;
    createdAt: number;
    updatedAt: number;
    requestedModel: EvidenceModel | null;
    recordedModels: Array<EvidenceModel & { messages: number }>;
    providerRetryEvents: number;
    tools: EvidenceToolCounts & {
        categories: EvidenceToolCategory[];
        confirmedPatchWrites: EvidenceToolCounts;
    };
    subagents: {
        calls: number;
        continuations: number;
    };
}

export interface SessionEpisode {
    rootId: string;
    sessionIds: string[];
    parentLinks: Array<{ childId: string; parentId: string; parentIncluded: boolean }>;
    completeness: 'complete' | 'incomplete';
    warnings: Array<'omitted-children' | 'omitted-parent' | 'session-limit-reached'>;
    distinctChildren: number;
    sameRoleContinuations: number;
    subagentCalls: number;
    subagentContinuations: number;
    confirmedPatchWrites: {
        parent: EvidenceToolCounts;
        children: EvidenceToolCounts;
    };
    temporalIntervalOverlap: {
        maxOverlappingIntervals: number;
        interpretation: 'recorded-interval-overlap-not-execution-or-concurrency';
    };
}

export interface Oc2SessionEvidenceReport {
    schemaVersion: typeof OC2_SESSION_EVIDENCE_SCHEMA_VERSION;
    source: {
        adapter: 'oc2-v2';
        capturedProviderFields: ['id', 'providerID', 'variant'];
        loadedModelInventory: 'unknown';
        contentPolicy: 'metadata-only';
    };
    window: { since: number; sessionLimit: number; limitReached: boolean; sampleBasis: 'recent-session-metadata' };
    warnings: Array<'root-families-may-be-incomplete-at-window-or-limit-boundary'>;
    excludedSessionCount: number;
    malformedMessageCount: number;
    sessions: NormalizedSession[];
    episodes: SessionEpisode[];
}

export interface ReadOc2SessionEvidenceOptions {
    dbPath: string;
    since?: number;
    limit?: number;
    includeExcludedOrigins?: boolean;
    now?: number;
}

interface SessionRow {
    id: string;
    parent_id: string | null;
    directory: string;
    title: string | null;
    version: string | null;
    agent: string;
    time_created: number;
    time_updated: number;
    model_id: string | null;
    model_provider: string | null;
    model_variant: string | null;
}

interface MessageRow {
    session_id: string;
    role: string;
    model_id: string | null;
    model_provider: string | null;
    model_variant: string | null;
    retry_event: number;
}

interface ToolRow {
    session_id: string;
    tool_name: string | null;
    tool_status: string | null;
    continuation: number;
}

function asNumber(value: number | bigint): number {
    const result = Number(value);
    if (!Number.isSafeInteger(result)) throw new Error('OC2 evidence contains a timestamp or count outside the safe integer range');
    return result;
}

function shortId(value: string): string {
    return createHash('sha256').update(value).digest('hex').slice(0, 12);
}

function safeIdentifier(value: unknown, fallback = 'unknown'): string {
    return typeof value === 'string' && value.length > 0 && value.length <= 128 && /^[A-Za-z0-9._/@:+-]+$/.test(value) ? value : fallback;
}

function safeProject(directory: string): string {
    const name = basename(directory.replaceAll('\\', '/'));
    return safeIdentifier(name, 'unknown-project');
}

function normalizedTitle(title: string | null): string {
    return typeof title === 'string' ? title.trimStart().toLowerCase() : '';
}

function originForMetadata(title: string | null, version: string | null): NormalizedSession['origin'] {
    const normalized = normalizedTitle(title);
    if (normalized.startsWith('[eval]') || normalized.startsWith('eval:')) return { kind: 'eval', confidence: 'explicit-title-prefix', marker: 'eval-title-prefix' };
    if (normalized.startsWith('[synthetic]') || normalized.startsWith('synthetic:')) return { kind: 'synthetic', confidence: 'explicit-title-prefix', marker: 'synthetic-title-prefix' };
    if (version && LEGACY_PREVIEW_VERSIONS.has(version)) return { kind: 'legacy-preview', confidence: 'known-host-version', marker: 'legacy-preview-host-version' };
    return { kind: 'unknown', confidence: 'unknown', marker: 'none' };
}

function modelFromFields(id: unknown, providerID: unknown, variant: unknown): EvidenceModel | null {
    if (typeof id !== 'string' || typeof providerID !== 'string' || typeof variant !== 'string') return null;
    return {
        id: safeIdentifier(id),
        providerID: safeIdentifier(providerID),
        variant: safeIdentifier(variant),
    };
}

function emptyCounts(): EvidenceToolCounts {
    return { attempts: 0, completed: 0, errors: 0, interrupted: 0 };
}

function addCounts(target: EvidenceToolCounts, source: EvidenceToolCounts): void {
    target.attempts += source.attempts;
    target.completed += source.completed;
    target.errors += source.errors;
    target.interrupted += source.interrupted;
}

function recordTool(target: EvidenceToolCounts, status: string | null): void {
    target.attempts += 1;
    if (status === 'completed') target.completed += 1;
    else if (status === 'error') target.errors += 1;
    else target.interrupted += 1;
}

function requiredColumns(db: DatabaseSync, table: 'session_message' | 'session_v2', required: readonly string[]): void {
    let rows: Array<{ name: string }>;
    try { rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>; }
    catch { throw new Error(`Unsupported OC2 database: cannot inspect required ${table} schema`); }
    const present = new Set(rows.map(row => row.name));
    const missing = required.filter(column => !present.has(column));
    if (missing.length > 0) throw new Error(`Unsupported OC2 database schema: ${table} is missing ${missing.join(', ')}; expected OC2-v2`);
}

function boundedRows<T>(statement: StatementSync, maximum: number, ...params: Array<string | number>): T[] {
    const rows = statement.all(...params) as T[];
    if (rows.length > maximum) throw new Error(`OC2 evidence query exceeded its ${maximum}-row safety bound; narrow --since or --limit`);
    return rows;
}

function validateOptions(options: ReadOc2SessionEvidenceOptions): { since: number; limit: number } {
    if (typeof options.dbPath !== 'string' || options.dbPath.trim() === '') throw new Error('An explicit OC2 database path is required; there is no stable-database fallback');
    const now = options.now ?? Date.now();
    const since = options.since ?? now - OC2_DEFAULT_LOOKBACK_DAYS * 86_400_000;
    const limit = options.limit ?? OC2_DEFAULT_SESSION_LIMIT;
    if (!Number.isSafeInteger(now) || !Number.isSafeInteger(since) || since < 0 || since > now) throw new Error('--since must be a valid timestamp no later than now');
    if (now - since > OC2_MAX_LOOKBACK_DAYS * 86_400_000) throw new Error(`--since is bounded to the last ${OC2_MAX_LOOKBACK_DAYS} days`);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > OC2_MAX_SESSION_LIMIT) throw new Error(`--limit must be between 1 and ${OC2_MAX_SESSION_LIMIT}`);
    return { since, limit };
}

export function readOc2SessionEvidence(options: ReadOc2SessionEvidenceOptions): Oc2SessionEvidenceReport {
    const { since, limit } = validateOptions(options);
    let db: DatabaseSync;
    try { db = new DatabaseSync(options.dbPath, { readOnly: true }); }
    catch (error) { throw new Error(`Unable to open the explicit OC2 database read-only: ${error instanceof Error ? error.message : String(error)}`); }
    try {
        db.exec('PRAGMA query_only = ON');
        requiredColumns(db, 'session_v2', ['id', 'project_id', 'parent_id', 'directory', 'title', 'version', 'agent', 'model', 'time_created', 'time_updated']);
        requiredColumns(db, 'session_message', ['id', 'session_id', 'type', 'seq', 'time_created', 'time_updated', 'data']);
        db.exec('BEGIN');
        try {
            const candidates = boundedRows<SessionRow>(db.prepare(`
                SELECT id, parent_id, directory, title, version, agent, time_created, time_updated,
                    CASE WHEN json_valid(model) THEN json_extract(model, '$.id') END AS model_id,
                    CASE WHEN json_valid(model) THEN json_extract(model, '$.providerID') END AS model_provider,
                    CASE WHEN json_valid(model) THEN json_extract(model, '$.variant') END AS model_variant
                FROM session_v2 WHERE time_updated >= ? ORDER BY time_updated DESC, id LIMIT ?
            `), limit + 1, since, limit + 1);
            const limitReached = candidates.length > limit;
            const sessionRows = candidates.slice(0, limit);
            const selected = sessionRows.filter(row => options.includeExcludedOrigins || !EXCLUDED_TITLE_PREFIXES.some(prefix => normalizedTitle(row.title).startsWith(prefix)));
            const ids = selected.map(row => row.id);
            const idJson = JSON.stringify(ids);
            const omittedChildParents = ids.length === 0 ? new Set<string>() : new Set((db.prepare(`
                SELECT DISTINCT parent_id FROM session_v2
                WHERE parent_id IN (SELECT value FROM json_each(?))
                    AND id NOT IN (SELECT value FROM json_each(?))
                LIMIT ?
            `).all(idJson, idJson, limit + 1) as Array<{ parent_id: string }>).map(row => row.parent_id));
            const messageRows = ids.length === 0 ? [] : boundedRows<MessageRow>(db.prepare(`
                SELECT session_id, type AS role,
                    CASE WHEN json_valid(data) THEN json_extract(data, '$.model.id') END AS model_id,
                    CASE WHEN json_valid(data) THEN json_extract(data, '$.model.providerID') END AS model_provider,
                    CASE WHEN json_valid(data) THEN json_extract(data, '$.model.variant') END AS model_variant,
                    CASE WHEN json_valid(data) AND json_type(data, '$.retry') = 'object' THEN 1 ELSE 0 END AS retry_event
                FROM session_message WHERE session_id IN (SELECT value FROM json_each(?))
                ORDER BY session_id, seq LIMIT ?
            `), MAX_MESSAGES, idJson, MAX_MESSAGES + 1);
            const toolRows = ids.length === 0 ? [] : boundedRows<ToolRow>(db.prepare(`
                SELECT m.session_id,
                    CASE WHEN json_type(part.value, '$.name') = 'text' THEN json_extract(part.value, '$.name') END AS tool_name,
                    CASE WHEN json_type(part.value, '$.state.status') = 'text' THEN json_extract(part.value, '$.state.status') END AS tool_status,
                    CASE WHEN json_type(part.value, '$.state.input.sessionID') = 'text' THEN 1 ELSE 0 END AS continuation
                FROM session_message m, json_each(m.data, '$.content') part
                WHERE m.session_id IN (SELECT value FROM json_each(?)) AND json_valid(m.data)
                    AND json_type(m.data, '$.content') = 'array' AND json_extract(part.value, '$.type') = 'tool'
                ORDER BY m.session_id, m.seq, part.key LIMIT ?
            `), MAX_TOOL_PARTS, idJson, MAX_TOOL_PARTS + 1);
            const malformed = ids.length === 0 ? 0 : asNumber((db.prepare(`
                SELECT count(*) AS count FROM session_message
                WHERE session_id IN (SELECT value FROM json_each(?)) AND NOT json_valid(data)
            `).get(idJson) as { count: number | bigint }).count);
            db.exec('COMMIT');
            return normalizeRows(sessionRows.length - selected.length, selected, messageRows, toolRows, malformed, since, limit, limitReached, omittedChildParents);
        } catch (error) {
            try { db.exec('ROLLBACK'); } catch { /* preserve the original read failure */ }
            throw error;
        }
    } finally { db.close(); }
}

function normalizeRows(excludedSessionCount: number, rows: SessionRow[], messages: MessageRow[], tools: ToolRow[], malformedMessageCount: number, since: number, limit: number, limitReached: boolean, omittedChildParents: Set<string>): Oc2SessionEvidenceReport {
    const byRawId = new Map(rows.map(row => [row.id, row]));
    const normalizedByRawId = new Map<string, NormalizedSession>();
    const messagesBySession = new Map<string, MessageRow[]>();
    const toolsBySession = new Map<string, ToolRow[]>();
    for (const message of messages) messagesBySession.set(message.session_id, [...(messagesBySession.get(message.session_id) ?? []), message]);
    for (const tool of tools) toolsBySession.set(tool.session_id, [...(toolsBySession.get(tool.session_id) ?? []), tool]);

    const ancestry = (id: string): { root: string; depth: number; complete: boolean } => {
        const seenAt = new Map<string, number>(), order: string[] = []; let current = id;
        while (true) {
            const cycleAt = seenAt.get(current);
            if (cycleAt !== undefined) return { root: [...order.slice(cycleAt)].sort()[0]!, depth: cycleAt, complete: true };
            seenAt.set(current, order.length); order.push(current);
            const parent = byRawId.get(current)?.parent_id;
            if (!parent) return { root: current, depth: order.length - 1, complete: true };
            if (!byRawId.has(parent)) return { root: parent, depth: order.length, complete: false };
            if (order.length > MAX_FAMILY_DEPTH) throw new Error(`OC2 session family exceeds the ${MAX_FAMILY_DEPTH}-level safety bound`);
            current = parent;
        }
    };

    for (const row of rows) {
        const sessionMessages = messagesBySession.get(row.id) ?? [];
        const role = safeIdentifier(row.agent || sessionMessages.find(message => message.role === 'assistant')?.role, 'unknown');
        const modelCounts = new Map<string, EvidenceModel & { messages: number }>();
        for (const message of sessionMessages) {
            const model = modelFromFields(message.model_id, message.model_provider, message.model_variant);
            if (!model) continue;
            const key = `${model.providerID}\0${model.id}\0${model.variant}`, existing = modelCounts.get(key);
            if (existing) existing.messages += 1; else modelCounts.set(key, { ...model, messages: 1 });
        }
        const categories = new Map<ToolCategory, EvidenceToolCounts>();
        let subagentCalls = 0, subagentContinuations = 0;
        for (const tool of toolsBySession.get(row.id) ?? []) {
            const category = TOOL_CATEGORIES.get(tool.tool_name ?? '') ?? 'other';
            const counts = categories.get(category) ?? emptyCounts(); recordTool(counts, tool.tool_status); categories.set(category, counts);
            if (category === 'subagent') { subagentCalls += 1; subagentContinuations += tool.continuation ? 1 : 0; }
        }
        const allTools = emptyCounts(); for (const value of categories.values()) addCounts(allTools, value);
        const patchWrites = categories.get('patch-write') ?? emptyCounts();
        const family = ancestry(row.id);
        normalizedByRawId.set(row.id, {
            id: shortId(row.id), parentId: row.parent_id ? shortId(row.parent_id) : null,
            rootId: shortId(family.root), depth: family.depth, origin: originForMetadata(row.title, row.version), familyComplete: family.complete,
            project: safeProject(row.directory), role,
            createdAt: asNumber(row.time_created), updatedAt: asNumber(row.time_updated), requestedModel: modelFromFields(row.model_id, row.model_provider, row.model_variant),
            recordedModels: [...modelCounts.values()].sort((a, b) => `${a.providerID}/${a.id}/${a.variant}`.localeCompare(`${b.providerID}/${b.id}/${b.variant}`)),
            providerRetryEvents: sessionMessages.reduce((sum, message) => sum + (message.retry_event ? 1 : 0), 0),
            tools: { ...allTools, categories: [...categories].map(([category, counts]) => ({ category, ...counts })).sort((a, b) => a.category.localeCompare(b.category)), confirmedPatchWrites: { ...patchWrites } },
            subagents: { calls: subagentCalls, continuations: subagentContinuations },
        });
    }
    const sessions = [...normalizedByRawId.values()].sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
    const episodes = buildEpisodes(sessions, limitReached, new Set([...omittedChildParents].map(shortId)));
    return {
        schemaVersion: OC2_SESSION_EVIDENCE_SCHEMA_VERSION,
        source: { adapter: 'oc2-v2', capturedProviderFields: ['id', 'providerID', 'variant'], loadedModelInventory: 'unknown', contentPolicy: 'metadata-only' },
        window: { since, sessionLimit: limit, limitReached, sampleBasis: 'recent-session-metadata' },
        warnings: limitReached || episodes.some(episode => episode.completeness === 'incomplete') ? ['root-families-may-be-incomplete-at-window-or-limit-boundary'] : [],
        excludedSessionCount, malformedMessageCount, sessions, episodes,
    };
}

function buildEpisodes(sessions: NormalizedSession[], limitReached: boolean, omittedChildParentIds: Set<string>): SessionEpisode[] {
    const groups = new Map<string, NormalizedSession[]>();
    for (const session of sessions) groups.set(session.rootId, [...(groups.get(session.rootId) ?? []), session]);
    return [...groups.entries()].map(([rootId, family]): SessionEpisode => {
        const root = family.find(session => session.id === rootId);
        const parentPatchWrites = emptyCounts(), childPatchWrites = emptyCounts();
        for (const session of family) addCounts(session.id === root?.id ? parentPatchWrites : childPatchWrites, session.tools.confirmedPatchWrites);
        const events = family.flatMap(session => [{ time: session.createdAt, delta: 1 }, { time: session.updatedAt, delta: -1 }])
            .sort((a, b) => a.time - b.time || b.delta - a.delta);
        let active = 0, maxOverlappingIntervals = 0;
        for (const event of events) { active += event.delta; maxOverlappingIntervals = Math.max(maxOverlappingIntervals, active); }
        const warningSet = new Set<SessionEpisode['warnings'][number]>();
        if (family.some(session => !session.familyComplete)) warningSet.add('omitted-parent');
        if (family.some(session => omittedChildParentIds.has(session.id))) warningSet.add('omitted-children');
        if (limitReached && warningSet.size > 0) warningSet.add('session-limit-reached');
        const warnings = [...warningSet].sort();
        return {
            rootId, sessionIds: family.map(session => session.id),
            parentLinks: family.flatMap(session => session.parentId ? [{ childId: session.id, parentId: session.parentId, parentIncluded: family.some(parent => parent.id === session.parentId) }] : []),
            completeness: warnings.length === 0 ? 'complete' : 'incomplete', warnings,
            distinctChildren: family.filter(session => session.id !== root?.id).length,
            sameRoleContinuations: family.filter(session => session.parentId !== null && family.find(parent => parent.id === session.parentId)?.role === session.role).length,
            subagentCalls: family.reduce((sum, session) => sum + session.subagents.calls, 0),
            subagentContinuations: family.reduce((sum, session) => sum + session.subagents.continuations, 0),
            confirmedPatchWrites: { parent: parentPatchWrites, children: childPatchWrites },
            temporalIntervalOverlap: { maxOverlappingIntervals, interpretation: 'recorded-interval-overlap-not-execution-or-concurrency' },
        };
    }).sort((a, b) => a.rootId.localeCompare(b.rootId));
}
