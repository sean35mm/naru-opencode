import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readFile, realpath, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { isPlainObject } from './validate.mjs';

export const OFFICIAL_MODEL_CATALOGUE_URL = 'https://models.opencode.ai/api.json';
export const MODEL_CATALOGUE_MAX_BYTES = 16 * 1024 * 1024;
export const MODEL_CATALOGUE_USER_AGENT = 'opencode/2.0.15/naru-preview';

export interface PreviewModelSource {
    path: string;
    digest: string;
    bytes: number;
    sourceURL: typeof OFFICIAL_MODEL_CATALOGUE_URL;
    requestedAt: string;
    completedAt: string;
    outcome: 'downloaded' | 'unchanged';
    warnings?: string[];
}

export interface ModelSourceCost { input: number; output: number; cache: { read: number; write: number }; tier?: { type: string; size: number } }
export interface ModelSourceMode { id: string; cost: ModelSourceCost[]; body?: { service_tier?: 'priority'; reasoning?: { mode: 'pro' }; speed?: 'fast' }; headers?: { 'anthropic-beta': 'fast-mode-2026-02-01' } }
export interface ModelSourceEntry { providerID: string; modelID: string; reference: string; name: string; releaseDate: string; attachment: boolean; reasoning: boolean; tools: boolean; modalities?: { input: string[]; output: string[] }; limit: { context: number; output: number; input?: number }; mode?: ModelSourceMode }
export interface ValidatedModelFeed { value: Record<string, unknown>; entries: ModelSourceEntry[] }

const safeProviderID = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;
const safeModelID = /^[a-zA-Z0-9@~][a-zA-Z0-9._:@/~-]{0,511}$/;
const safeText = (value: unknown, maximum = 1024): value is string => typeof value === 'string' && value.length > 0 && value.length <= maximum && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u.test(value);
const stringList = (value: unknown): value is string[] => Array.isArray(value) && value.length <= 64 && value.every(item => safeText(item, 128));
const finiteNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const finiteNonnegative = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const optionalText = (value: unknown): boolean => value === undefined || safeText(value, 4096);
const optionalBoolean = (value: unknown): boolean => value === undefined || typeof value === 'boolean';
const npmPackage = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*(?:\/[a-z0-9][a-z0-9._-]*)*$/iu;
const providerShape = /^[a-z][a-z0-9._-]{0,127}$/iu;
const safeModeID = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;
const maximumModesPerModel = 32;

function packageIdentifier(value: unknown): value is string {
    return typeof value === 'string' && value.length <= 214 && npmPackage.test(value);
}

function apiURL(value: unknown, allowedEnvironment: string[] = []): value is string {
    if (typeof value !== 'string' || value.length > 2048 || /[\u0000-\u001f\u007f]/u.test(value)) return false;
    const expansion = /^\$\{([A-Z_][A-Z0-9_]*)\}(\/[-a-zA-Z0-9._~!$&'()*+,;=:@%/]*)?$/.exec(value);
    if (expansion) return allowedEnvironment.includes(expansion[1]!) && !(expansion[2] ?? '').split('/').some(segment => segment === '.' || segment === '..');
    try { const parsed = new URL(value); return (parsed.protocol === 'http:' || parsed.protocol === 'https:') && !!parsed.hostname && !parsed.username && !parsed.password; }
    catch { return false; }
}

function normalizedCost(value: unknown): Record<string, unknown> | undefined {
    if (value === undefined) return undefined;
    if (!validateCost(value)) throw new Error('invalid cost metadata');
    const cost = value as Record<string, unknown>, result: Record<string, unknown> = {};
    for (const key of ['input', 'output', 'cache_read', 'cache_write', 'input_audio', 'output_audio', 'reasoning']) if (cost[key] !== undefined) result[key] = cost[key];
    if (Array.isArray(cost.tiers)) result.tiers = cost.tiers.map(tier => {
        const source = tier as Record<string, unknown>, normalized: Record<string, unknown> = {};
        for (const key of ['input', 'output', 'cache_read', 'cache_write', 'input_audio', 'output_audio', 'reasoning']) if (source[key] !== undefined) normalized[key] = source[key];
        normalized.tier = { type: (source.tier as Record<string, unknown>).type, size: (source.tier as Record<string, unknown>).size };
        return normalized;
    });
    if (isPlainObject(cost.context_over_200k)) result.context_over_200k = Object.fromEntries(Object.entries(cost.context_over_200k).filter(([key]) => ['input', 'output', 'cache_read', 'cache_write', 'input_audio', 'output_audio', 'reasoning'].includes(key)));
    return result;
}

function normalizedReasoningOptions(value: unknown): unknown[] | undefined {
    if (value === undefined) return undefined;
    if (!validateReasoningOptions(value)) throw new Error('invalid reasoning metadata');
    return (value as Array<Record<string, unknown>>).map(option => ({ type: option.type, ...(option.values !== undefined ? { values: [...option.values as unknown[]] } : {}), ...(option.min !== undefined ? { min: option.min } : {}), ...(option.max !== undefined ? { max: option.max } : {}) }));
}

function projectedCost(value: unknown): ModelSourceCost[] {
    const source = normalizedCost(value) ?? {};
    const item = (cost: Record<string, unknown>, tier?: { type: string; size: number }): ModelSourceCost => ({
        input: typeof cost.input === 'number' ? cost.input : 0,
        output: typeof cost.output === 'number' ? cost.output : 0,
        cache: { read: typeof cost.cache_read === 'number' ? cost.cache_read : 0, write: typeof cost.cache_write === 'number' ? cost.cache_write : 0 },
        ...(tier ? { tier } : {}),
    });
    const result = [item(source)];
    for (const tier of Array.isArray(source.tiers) ? source.tiers as Array<Record<string, unknown>> : []) {
        const descriptor = tier.tier as Record<string, unknown>;
        result.push(item(tier, { type: descriptor.type as string, size: descriptor.size as number }));
    }
    if (isPlainObject(source.context_over_200k)) result.push(item(source.context_over_200k, { type: 'context', size: 200_000 }));
    return result;
}

function mergedProjectedCost(baseValue: unknown, overrideValue: unknown): ModelSourceCost[] {
    const base = projectedCost(baseValue);
    if (overrideValue === undefined) return base;
    const override = projectedCost(overrideValue), [baseDefault, ...baseTiers] = base, [overrideDefault, ...overrideTiers] = override;
    const key = (item: ModelSourceCost) => `${item.tier?.type ?? 'base'}:${item.tier?.size ?? 0}`;
    const merge = (left: ModelSourceCost, right: ModelSourceCost): ModelSourceCost => ({ ...left, ...right, ...(right.tier ?? left.tier ? { tier: right.tier ?? left.tier } : {}), cache: { ...left.cache, ...right.cache } });
    const tiers = new Map(baseTiers.map(item => [key(item), item]));
    for (const item of overrideTiers) tiers.set(key(item), tiers.has(key(item)) ? merge(tiers.get(key(item))!, item) : item);
    return [merge(baseDefault!, overrideDefault!), ...tiers.values()];
}

function validateCost(value: unknown): boolean {
    if (value === undefined) return true;
    if (!isPlainObject(value)) return false;
    for (const [key, item] of Object.entries(value)) {
        if (key === 'tiers') {
            if (!Array.isArray(item) || item.length > 64 || !item.every(tier => isPlainObject(tier) && Object.entries(tier).every(([tierKey, tierValue]) => tierKey === 'tier'
                ? isPlainObject(tierValue) && safeText(tierValue.type, 64) && finiteNonnegative(tierValue.size)
                : finiteNonnegative(tierValue)))) return false;
        } else if (key === 'context_over_200k') {
            if (!isPlainObject(item) || !Object.values(item).every(finiteNonnegative)) return false;
        } else if (!finiteNonnegative(item)) return false;
    }
    return true;
}

function validateModalities(value: unknown): boolean {
    if (value === undefined) return true;
    return isPlainObject(value) && stringList(value.input) && stringList(value.output);
}

function validateReasoningOptions(value: unknown): boolean {
    if (value === undefined) return true;
    if (!Array.isArray(value) || value.length > 16) return false;
    return value.every(option => isPlainObject(option) && (option.type === 'toggle' || option.type === 'effort' || option.type === 'budget_tokens')
        && (option.values === undefined || (Array.isArray(option.values) && option.values.length <= 64 && option.values.every(item => item === null || safeText(item, 128)))) && (option.min === undefined || finiteNumber(option.min))
        && (option.max === undefined || finiteNumber(option.max)));
}

function validateProviderOverride(value: unknown, allowedEnvironment: string[]): boolean {
    if (value === undefined) return true;
    if (!isPlainObject(value)) return false;
    return (value.api === undefined || apiURL(value.api, allowedEnvironment)) && (value.npm === undefined || packageIdentifier(value.npm)) && (value.shape === undefined || (typeof value.shape === 'string' && providerShape.test(value.shape)));
}

function normalizedModeProvider(value: unknown): Record<string, unknown> | undefined {
    if (value === undefined) return undefined;
    if (!isPlainObject(value)) throw new Error('invalid mode provider metadata');
    const body: Record<string, unknown> = {};
    if (value.body !== undefined) {
        if (!isPlainObject(value.body)) throw new Error('invalid mode provider body metadata');
        if (value.body.service_tier !== undefined) {
            if (value.body.service_tier !== 'priority') throw new Error('invalid mode service tier');
            body.service_tier = 'priority';
        }
        if (value.body.reasoning !== undefined) {
            if (!isPlainObject(value.body.reasoning) || value.body.reasoning.mode !== 'pro') throw new Error('invalid mode reasoning metadata');
            body.reasoning = { mode: 'pro' };
        }
        if (value.body.speed !== undefined) {
            if (value.body.speed !== 'fast') throw new Error('invalid mode speed metadata');
            body.speed = 'fast';
        }
    }
    const headers: Record<string, unknown> = {};
    if (value.headers !== undefined) {
        if (!isPlainObject(value.headers) || !Object.values(value.headers).every(item => safeText(item, 1024))) throw new Error('invalid mode provider header metadata');
        if (Object.keys(value.headers).some(key => /^(?:authorization|cookie|proxy-authorization|set-cookie)$/iu.test(key))) throw new Error('prohibited mode provider header metadata');
        if (value.headers['anthropic-beta'] !== undefined) {
            if (value.headers['anthropic-beta'] !== 'fast-mode-2026-02-01') throw new Error('invalid Anthropic fast-mode header metadata');
            headers['anthropic-beta'] = 'fast-mode-2026-02-01';
        }
    }
    if (Object.keys(body).length > 1) throw new Error('ambiguous mode provider body metadata');
    const anthropic = body.speed === 'fast' || headers['anthropic-beta'] !== undefined;
    if (anthropic && (body.speed !== 'fast' || headers['anthropic-beta'] !== 'fast-mode-2026-02-01')) throw new Error('incomplete Anthropic fast-mode metadata');
    if (!Object.keys(body).length && !Object.keys(headers).length) throw new Error('unsupported mode provider metadata');
    return { ...(Object.keys(body).length ? { body } : {}), ...(Object.keys(headers).length ? { headers } : {}) };
}

function normalizedExperimentalModes(value: unknown, providerID: string): Record<string, unknown> | undefined {
    if (value === undefined) return undefined;
    if (!isPlainObject(value) || (value.modes !== undefined && !isPlainObject(value.modes))) throw new Error('invalid experimental mode metadata');
    if (value.modes === undefined) return undefined;
    const modes = Object.entries(value.modes);
    if (modes.length > maximumModesPerModel) throw new Error('too many experimental modes');
    const normalized: Record<string, unknown> = {};
    for (const [modeID, modeValue] of modes) {
        if (!safeModeID.test(modeID) || !isPlainObject(modeValue) || !validateCost(modeValue.cost)) throw new Error('invalid experimental mode metadata');
        const provider = normalizedModeProvider(modeValue.provider);
        if (providerID === 'openai' && modeID === 'fast' && (modeValue.cost === undefined || !isPlainObject(provider?.body) || provider.body.service_tier !== 'priority')) throw new Error('invalid OpenAI fast mode contract');
        if (providerID === 'openai' && modeID === 'pro' && (!isPlainObject(provider?.body) || !isPlainObject(provider.body.reasoning) || provider.body.reasoning.mode !== 'pro')) throw new Error('invalid OpenAI pro mode contract');
        normalized[modeID] = {
            ...(modeValue.cost !== undefined ? { cost: normalizedCost(modeValue.cost) } : {}),
            ...(provider ? { provider } : {}),
        };
    }
    return normalized;
}

export function validateOfficialModelFeed(value: unknown): ValidatedModelFeed {
    if (!isPlainObject(value) || Object.keys(value).length === 0) throw new Error('Official model catalogue has an invalid schema: expected a nonempty provider object');
    const entries: ModelSourceEntry[] = [], normalized: Record<string, unknown> = {};
    for (const [providerKey, providerValue] of Object.entries(value)) {
        if (!safeProviderID.test(providerKey) || !isPlainObject(providerValue) || providerValue.id !== providerKey || !safeText(providerValue.name)
            || !stringList(providerValue.env) || !packageIdentifier(providerValue.npm) || (providerValue.api !== undefined && !apiURL(providerValue.api, providerValue.env)) || !optionalText(providerValue.doc)
            || !isPlainObject(providerValue.models)) throw new Error(`Official model catalogue has an invalid provider record: ${JSON.stringify(providerKey)}`);
        const normalizedModels: Record<string, unknown> = {};
        const canonicalModelIDs = new Set(Object.keys(providerValue.models));
        const generatedModeIDs = new Set<string>();
        for (const [modelKey, modelValue] of Object.entries(providerValue.models)) {
            if (!safeModelID.test(modelKey) || modelKey.split('/').some(segment => !segment || segment === '.' || segment === '..') || !isPlainObject(modelValue) || modelValue.id !== modelKey || !safeText(modelValue.name)
                || !safeText(modelValue.release_date, 64) || typeof modelValue.attachment !== 'boolean' || typeof modelValue.reasoning !== 'boolean'
                || typeof modelValue.tool_call !== 'boolean' || !isPlainObject(modelValue.limit) || !finiteNonnegative(modelValue.limit.context)
                || !finiteNonnegative(modelValue.limit.output) || (modelValue.limit.input !== undefined && !finiteNonnegative(modelValue.limit.input))
                || !validateCost(modelValue.cost) || !validateModalities(modelValue.modalities) || !validateReasoningOptions(modelValue.reasoning_options)
                 || !optionalText(modelValue.status) || !validateProviderOverride(modelValue.provider, providerValue.env) || !optionalText(modelValue.family)
                || !optionalText(modelValue.knowledge) || !optionalText(modelValue.last_updated) || !optionalBoolean(modelValue.open_weights)
                 || !optionalBoolean(modelValue.temperature) || !optionalBoolean(modelValue.structured_output) || !optionalText(modelValue.description)
                  || (modelValue.interleaved !== undefined && typeof modelValue.interleaved !== 'boolean' && (!isPlainObject(modelValue.interleaved) || !safeText(modelValue.interleaved.field, 128)))) {
                throw new Error(`Official model catalogue has an invalid model record: ${JSON.stringify(providerKey + '/' + modelKey)}`);
            }
            let modes: Record<string, unknown> | undefined;
            try { modes = normalizedExperimentalModes(modelValue.experimental, providerKey); }
            catch { throw new Error(`Official model catalogue has an invalid model record: ${JSON.stringify(providerKey + '/' + modelKey)}`); }
            for (const modeID of Object.keys(modes ?? {})) {
                const generatedID = `${modelKey}-${modeID}`;
                if (!safeModelID.test(generatedID) || canonicalModelIDs.has(generatedID) || generatedModeIDs.has(generatedID)) throw new Error(`Official model catalogue has a colliding experimental mode ID: ${JSON.stringify(providerKey + '/' + generatedID)}`);
                generatedModeIDs.add(generatedID);
            }
            const modalities = modelValue.modalities as { input: string[]; output: string[] } | undefined;
            const limit = modelValue.limit as Record<string, number>;
            const normalizedModel: Record<string, unknown> = {
                id: modelKey, name: modelValue.name,
                ...(modelValue.description !== undefined && safeText(modelValue.description, 4096) ? { description: modelValue.description } : {}),
                ...(modelValue.family !== undefined ? { family: modelValue.family } : {}), attachment: modelValue.attachment, reasoning: modelValue.reasoning,
                ...(modelValue.reasoning_options !== undefined ? { reasoning_options: normalizedReasoningOptions(modelValue.reasoning_options) } : {}),
                tool_call: modelValue.tool_call,
                ...(typeof modelValue.interleaved === 'boolean' ? { interleaved: modelValue.interleaved } : isPlainObject(modelValue.interleaved) && safeText(modelValue.interleaved.field, 128) ? { interleaved: { field: modelValue.interleaved.field } } : {}),
                ...(modelValue.structured_output !== undefined ? { structured_output: modelValue.structured_output } : {}),
                ...(modelValue.temperature !== undefined ? { temperature: modelValue.temperature } : {}),
                ...(modelValue.knowledge !== undefined ? { knowledge: modelValue.knowledge } : {}), release_date: modelValue.release_date,
                ...(modelValue.last_updated !== undefined ? { last_updated: modelValue.last_updated } : {}),
                ...(modalities ? { modalities: { input: [...modalities.input], output: [...modalities.output] } } : {}),
                ...(modelValue.open_weights !== undefined ? { open_weights: modelValue.open_weights } : {}),
                ...(modelValue.cost !== undefined ? { cost: normalizedCost(modelValue.cost) } : {}),
                ...(modes ? { experimental: { modes } } : {}),
                limit: { context: limit.context, ...(limit.input !== undefined ? { input: limit.input } : {}), output: limit.output },
                ...(modelValue.status !== undefined ? { status: modelValue.status } : {}),
                ...(isPlainObject(modelValue.provider) ? { provider: { ...(modelValue.provider.npm !== undefined ? { npm: modelValue.provider.npm } : {}), ...(modelValue.provider.api !== undefined ? { api: modelValue.provider.api } : {}), ...(modelValue.provider.shape !== undefined ? { shape: modelValue.provider.shape } : {}) } } : {}),
            };
            normalizedModels[modelKey] = normalizedModel;
            const entry = { providerID: providerKey, modelID: modelKey, reference: `${providerKey}/${modelKey}`, name: modelValue.name, releaseDate: modelValue.release_date, attachment: modelValue.attachment, reasoning: modelValue.reasoning, tools: modelValue.tool_call, ...(modalities ? { modalities: { input: [...modalities.input], output: [...modalities.output] } } : {}), limit: { context: limit.context!, ...(limit.input !== undefined ? { input: limit.input } : {}), output: limit.output! } };
            entries.push(entry);
            for (const [modeID, modeValue] of Object.entries(modes ?? {})) {
                const mode = modeValue as Record<string, unknown>, provider = mode.provider as Record<string, unknown> | undefined;
                const contract: ModelSourceMode = { id: modeID, cost: mergedProjectedCost(modelValue.cost, mode.cost) };
                if (isPlainObject(provider?.body)) contract.body = provider.body as NonNullable<ModelSourceMode['body']>;
                if (isPlainObject(provider?.headers)) contract.headers = provider.headers as NonNullable<ModelSourceMode['headers']>;
                entries.push({ ...entry, reference: `${providerKey}/${modelKey}-${modeID}`, name: `${modelValue.name} ${modeID.charAt(0).toUpperCase()}${modeID.slice(1)}`,
                    mode: contract });
            }
        }
        normalized[providerKey] = { id: providerKey, name: providerValue.name, env: [...providerValue.env], npm: providerValue.npm, ...(providerValue.api !== undefined ? { api: providerValue.api } : {}), ...(providerValue.doc !== undefined ? { doc: providerValue.doc } : {}), models: normalizedModels };
    }
    return { value: normalized, entries };
}

async function privateDirectory(path: string): Promise<string> {
    await mkdir(path, { recursive: true, mode: 0o700 });
    const info = await lstat(path);
    if (info.isSymbolicLink() || !info.isDirectory() || info.uid !== process.getuid?.() || (info.mode & 0o777) !== 0o700) throw new Error('Managed model catalogue path must be an owned private directory without symlinks');
    return realpath(path);
}

async function syncDirectory(path: string): Promise<void> {
    const handle = await open(path, constants.O_RDONLY);
    try { await handle.sync(); } finally { await handle.close(); }
}

async function atomicPrivateJson(path: string, value: unknown, onRenamed?: () => void): Promise<void> {
    const temporary = `${path}.${randomUUID()}.tmp`;
    const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { await handle.writeFile(JSON.stringify(value, null, 2)); await handle.sync(); } finally { await handle.close(); }
    await rename(temporary, path);
    onRenamed?.();
    await syncDirectory(join(path, '..'));
}

async function verifySnapshot(path: string, expectedDigest: string, expectedBytes: number): Promise<Buffer> {
    const info = await lstat(path);
    if (info.isSymbolicLink() || !info.isFile() || info.uid !== process.getuid?.() || (info.mode & 0o777) !== 0o600 || info.size !== expectedBytes) throw new Error('Managed model catalogue snapshot is not an owned immutable 0600 file');
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
        const bytes = await handle.readFile();
        if (createHash('sha256').update(bytes).digest('hex') !== expectedDigest) throw new Error('Managed model catalogue snapshot digest does not match its pointer');
        validateOfficialModelFeed(JSON.parse(bytes.toString('utf8')));
        return bytes;
    } finally { await handle.close(); }
}

export async function loadManagedModelSource(root: string): Promise<PreviewModelSource | null> {
    const canonicalRoot = await privateDirectory(root), directory = await privateDirectory(join(canonicalRoot, 'model-catalogue'));
    let value: unknown;
    const pointer = join(directory, 'current.json');
    try {
        const info = await lstat(pointer);
        if (info.isSymbolicLink() || !info.isFile() || info.uid !== process.getuid?.() || (info.mode & 0o777) !== 0o600) throw new Error('Managed model catalogue pointer must be an owned 0600 file, not a symlink');
        value = JSON.parse(await readFile(pointer, 'utf8'));
    }
    catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null;
        if (error instanceof Error && error.message.startsWith('Managed model catalogue pointer must')) throw error;
        throw new Error('Managed model catalogue pointer is malformed');
    }
    if (!isPlainObject(value) || value.sourceURL !== OFFICIAL_MODEL_CATALOGUE_URL || !/^[a-f0-9]{64}$/.test(String(value.digest))
        || !Number.isSafeInteger(value.bytes) || (value.bytes as number) < 1 || !safeText(value.requestedAt, 64) || !safeText(value.completedAt, 64)
        || (value.outcome !== 'downloaded' && value.outcome !== 'unchanged')) throw new Error('Managed model catalogue pointer is malformed');
    const path = join(directory, 'snapshots', `${value.digest}.json`);
    await verifySnapshot(path, value.digest as string, value.bytes as number);
    return { path, digest: value.digest as string, bytes: value.bytes as number, sourceURL: OFFICIAL_MODEL_CATALOGUE_URL, requestedAt: value.requestedAt, completedAt: value.completedAt, outcome: value.outcome };
}

async function responseBytes(response: Response, maximum: number): Promise<Buffer> {
    if (response.status === 403) { await response.body?.cancel(); throw new Error('Official model catalogue request was refused (403); no retry was attempted'); }
    if (!response.ok) { await response.body?.cancel(); throw new Error(`Official model catalogue request failed (${response.status})`); }
    const declared = Number(response.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > maximum) { await response.body?.cancel(); throw new Error('Official model catalogue response exceeded the 16 MiB limit'); }
    if (!response.body) throw new Error('Official model catalogue returned an empty response');
    const reader = response.body.getReader(); const chunks: Buffer[] = []; let total = 0;
    try {
        while (true) {
            const item = await reader.read(); if (item.done) break;
            total += item.value.byteLength;
            if (total > maximum) { await reader.cancel(); throw new Error('Official model catalogue response exceeded the 16 MiB limit'); }
            chunks.push(Buffer.from(item.value));
        }
    } finally { reader.releaseLock(); }
    return Buffer.concat(chunks, total);
}

export async function refreshManagedModelSource(root: string, validateHost: (source: PreviewModelSource) => Promise<void>, options: {
    fetch?: typeof fetch; timeoutMs?: number; maxBytes?: number; now?: () => Date; writeMetadata?: (path: string, value: unknown, onRenamed?: () => void) => Promise<void>;
} = {}): Promise<PreviewModelSource> {
    const now = options.now ?? (() => new Date()), requestedAt = now().toISOString();
    const canonicalRoot = await privateDirectory(root), directory = await privateDirectory(join(canonicalRoot, 'model-catalogue'));
    const snapshots = await privateDirectory(join(directory, 'snapshots'));
    const writeMetadata = options.writeMetadata ?? atomicPrivateJson;
    let digest: string | null = null, byteLength = 0, committed = false;
    try {
        let response: Response;
        try {
            response = await (options.fetch ?? fetch)(OFFICIAL_MODEL_CATALOGUE_URL, {
                headers: { accept: 'application/json', 'user-agent': MODEL_CATALOGUE_USER_AGENT }, redirect: 'manual', signal: AbortSignal.timeout(options.timeoutMs ?? 15_000),
            });
        } catch (error) {
            if (error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError')) throw new Error('Official model catalogue request timed out');
            throw new Error('Official model catalogue request failed');
        }
        if (response.status >= 300 && response.status < 400) { await response.body?.cancel(); throw new Error('Official model catalogue refused an untrusted redirect'); }
        const bytes = await responseBytes(response, options.maxBytes ?? MODEL_CATALOGUE_MAX_BYTES); byteLength = bytes.length;
        let parsed: unknown;
        try { parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
        catch { throw new Error('Official model catalogue response is not valid UTF-8 JSON'); }
        const validated = validateOfficialModelFeed(parsed);
        const normalizedBytes = Buffer.from(JSON.stringify(validated.value));
        digest = createHash('sha256').update(normalizedBytes).digest('hex'); byteLength = normalizedBytes.length;
        const snapshotPath = join(snapshots, `${digest}.json`);
        try { await verifySnapshot(snapshotPath, digest, normalizedBytes.length); }
        catch (error) {
            if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
            const temporary = join(snapshots, `.${digest}.${randomUUID()}.tmp`);
            const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
            try { await handle.writeFile(normalizedBytes); await handle.sync(); } finally { await handle.close(); }
            await rename(temporary, snapshotPath); await syncDirectory(snapshots);
        }
        const previous = await loadManagedModelSource(root);
        const completedAt = now().toISOString();
        const source: PreviewModelSource = { path: snapshotPath, digest, bytes: normalizedBytes.length, sourceURL: OFFICIAL_MODEL_CATALOGUE_URL, requestedAt, completedAt, outcome: previous?.digest === digest ? 'unchanged' : 'downloaded' };
        if (source.outcome === 'unchanged') {
            try { await writeMetadata(join(directory, 'last-attempt.json'), { sourceURL: OFFICIAL_MODEL_CATALOGUE_URL, digest, bytes: normalizedBytes.length, requestedAt, completedAt, outcome: 'unchanged' }); }
            catch { source.warnings = ['Catalogue is unchanged, but refresh diagnostic metadata could not be updated']; }
            return source;
        }
        await validateHost(source);
        const { path: _path, ...metadata } = source;
        try {
            await writeMetadata(join(directory, 'current.json'), metadata, () => { committed = true; });
            committed = true;
        } catch (error) {
            if (!committed) throw error;
            source.warnings = ['Catalogue snapshot was published, but pointer directory durability sync failed'];
        }
        try { await writeMetadata(join(directory, 'last-attempt.json'), metadata); }
        catch { source.warnings = [...(source.warnings ?? []), 'Catalogue snapshot was published, but refresh diagnostic metadata could not be updated']; }
        return source;
    } catch (error) {
        if (committed) throw new Error('Catalogue snapshot was published, but refresh completion reporting failed');
        try { await writeMetadata(join(directory, 'last-attempt.json'), { sourceURL: OFFICIAL_MODEL_CATALOGUE_URL, digest, bytes: byteLength, requestedAt, completedAt: now().toISOString(), outcome: 'failed' }); } catch {}
        throw error;
    }
}

export async function readManagedModelFeed(source: PreviewModelSource): Promise<ValidatedModelFeed> {
    const bytes = await verifySnapshot(source.path, source.digest, source.bytes);
    return validateOfficialModelFeed(JSON.parse(bytes.toString('utf8')));
}
