// Naru dispatch: per-task model selection for subagents.
//
// The orchestrator picks a model class per dispatch; config maps classes to
// ordered model chains. The child agent is bound BY NAME so OpenCode applies
// its permission frontmatter itself — this module never mirrors or weakens
// the agent permission model. Two invariants keep that true:
//   1. The prompt body never contains a `tools` map (it would overwrite
//      session permissions wholesale).
//   2. Session permissions passed at create are deny-only (evaluation is
//      last-match-wins, so an allow here could override an agent deny).
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const DISPATCH_AGENTS = Object.freeze(['naru-reader', 'naru-runner', 'naru-writer']);
export const DISPATCHING_AGENTS = Object.freeze(new Set(['naru-orchestrator']));

const MAX_CLASSES = 16;
const MAX_CHAIN = 4;
const MAX_USE_LENGTH = 200;
const CLASS_NAME_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;
const MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const EFFORT_PATTERN = /^[a-z][a-z0-9-]{0,15}$/;
const MAX_PROMPT_BYTES = 256 * 1024;

// Child sessions can only be tightened here, never loosened. `task` and
// `naru-dispatch` keep the topology at depth 1; `question`/`todowrite` match
// what the built-in task tool denies for children.
export const CHILD_SESSION_DENIES = Object.freeze([
    Object.freeze({ permission: 'task', pattern: '*', action: 'deny' }),
    Object.freeze({ permission: 'naru-dispatch', pattern: '*', action: 'deny' }),
    Object.freeze({ permission: 'todowrite', pattern: '*', action: 'deny' }),
    Object.freeze({ permission: 'question', pattern: '*', action: 'deny' }),
]);

export function assertDenyOnly(rules, label = 'session permission') {
    for (const rule of rules) {
        if (rule.action !== 'deny') {
            throw new Error(`${label} must be deny-only; found action "${rule.action}" for "${rule.permission}"`);
        }
    }
    return rules;
}

export function parseChainEntry(value, label = 'chain entry') {
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

export function parseModelsConfig(value) {
    if (value === undefined || value === null) return {};
    if (typeof value !== 'object' || Array.isArray(value)) {
        throw new Error('models config must be a plain object of class definitions');
    }
    const names = Object.keys(value);
    if (names.length > MAX_CLASSES) throw new Error(`models config allows at most ${MAX_CLASSES} classes`);
    const classes = {};
    for (const name of names) {
        if (!CLASS_NAME_PATTERN.test(name)) {
            throw new Error(`model class name "${name}" must be short lowercase kebab-case`);
        }
        const entry = value[name];
        if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
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

export function buildToolDescription(classes) {
    const lines = [
        'Dispatch a Naru subagent on a chosen model class. Creates a fresh child',
        'session, runs it to completion, and returns its final answer prefixed with',
        'the model that actually ran. Multiple dispatches in one turn run',
        'concurrently. Use the built-in task tool instead when model choice does',
        'not matter (children then inherit your session model).',
        `Agents: ${DISPATCH_AGENTS.join(', ')}. Only naru-writer can edit files.`,
    ];
    const names = Object.keys(classes);
    if (names.length === 0) {
        lines.push('No model classes are configured in naru-runtime.json, so every dispatch inherits the parent session model.');
    } else {
        lines.push('Model classes (from naru-runtime.json):');
        for (const name of names) {
            const def = classes[name];
            const primary = def.chain[0];
            const label = `${primary.providerID}/${primary.modelID}${primary.effort ? `@${primary.effort}` : ''}`;
            lines.push(`- "${name}": ${def.use} -> ${label}${def.chain.length > 1 ? ` (+${def.chain.length - 1} fallback)` : ''}`);
        }
        lines.push('Optional "effort" overrides the chain default (e.g. low, medium, high, xhigh, max) when the model supports it. Escalate effort for consequence, not by default.');
    }
    return lines.join('\n');
}

export function readAuthProviders(path = join(homedir(), '.local', 'share', 'opencode', 'auth.json')) {
    try {
        const raw = readFileSync(path, 'utf8');
        if (raw.length > 256 * 1024) return null;
        const value = JSON.parse(raw);
        if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
        return new Set(Object.keys(value));
    }
    catch {
        return null;
    }
}

// Ordered candidates for one dispatch. Unknown-to-catalog model IDs are
// trusted and attempted (e.g. openai's -fast tier IDs are absent from the
// catalog but work); only a definite auth miss skips an entry.
export function resolveCandidates(classes, className, effortOverride, authProviders) {
    if (className === undefined || className === null || className === '') return { candidates: [], className: null };
    const def = classes[className];
    if (!def) {
        const known = Object.keys(classes);
        throw new Error(`unknown model class "${className}"${known.length ? `; configured classes: ${known.join(', ')}` : ' (no classes configured)'}`);
    }
    if (effortOverride !== undefined && !EFFORT_PATTERN.test(effortOverride)) {
        throw new Error('effort must be a short lowercase token such as low, medium, high, xhigh, or max');
    }
    const candidates = def.chain
        .filter((entry) => authProviders === null || authProviders === undefined || authProviders.has(entry.providerID))
        .map((entry) => ({
            providerID: entry.providerID,
            modelID: entry.modelID,
            effort: effortOverride ?? entry.effort,
        }));
    return { candidates, className };
}

export function modelLabel(candidate) {
    if (!candidate) return 'inherited';
    return `${candidate.providerID}/${candidate.modelID}${candidate.effort ? `@${candidate.effort}` : ''}`;
}

function textFromParts(parts) {
    if (!Array.isArray(parts)) return null;
    const last = parts.filter((part) => part?.type === 'text' && typeof part.text === 'string').at(-1);
    return last ? last.text : null;
}

async function promptChild(client, input) {
    const body = {
        agent: input.agent,
        parts: [{ type: 'text', text: input.prompt }],
        ...(input.candidate
            ? {
                model: { providerID: input.candidate.providerID, modelID: input.candidate.modelID },
                ...(input.candidate.effort ? { variant: input.candidate.effort } : {}),
            }
            : {}),
    };
    if ('tools' in body) throw new Error('dispatch prompt body must never set tools');
    const result = await client.session.prompt({ path: { id: input.sessionID }, body });
    if (result.error !== undefined) {
        throw new Error(typeof result.error === 'string' ? result.error : JSON.stringify(result.error).slice(0, 400));
    }
    const direct = textFromParts(result.data?.parts);
    if (direct !== null) return direct;
    const messages = await client.session.messages({ path: { id: input.sessionID } });
    const list = Array.isArray(messages.data) ? messages.data : [];
    for (let index = list.length - 1; index >= 0; index -= 1) {
        const message = list[index];
        if (message?.info?.role !== 'assistant') continue;
        const text = textFromParts(message.parts);
        if (text !== null) return text;
    }
    return '';
}

export async function runDispatch({ client, ctx, args, classes, authProviders }) {
    const agent = args.agent;
    if (!DISPATCH_AGENTS.includes(agent)) {
        return { error: `naru-dispatch can only dispatch: ${DISPATCH_AGENTS.join(', ')}` };
    }
    if (!DISPATCHING_AGENTS.has(ctx.agent)) {
        return { error: 'naru-dispatch is reserved for the naru-orchestrator identity' };
    }
    const description = typeof args.description === 'string' && args.description.trim() ? args.description.trim().slice(0, 120) : null;
    if (!description) return { error: 'description is required (a short label for the task)' };
    const prompt = typeof args.prompt === 'string' ? args.prompt : '';
    if (!prompt.trim()) return { error: 'prompt is required' };
    if (Buffer.byteLength(prompt, 'utf8') > MAX_PROMPT_BYTES) return { error: `prompt exceeds ${MAX_PROMPT_BYTES} bytes` };

    let resolution;
    try {
        resolution = resolveCandidates(classes, args.class, args.effort, authProviders);
    }
    catch (error) {
        return { error: error instanceof Error ? error.message : String(error) };
    }

    // Candidates first, then a final inherit attempt so model trouble never
    // hard-fails a dispatch.
    const attempts = [...resolution.candidates.map((candidate) => ({ candidate })), { candidate: null }];
    const failures = [];
    const permission = assertDenyOnly([...CHILD_SESSION_DENIES]);

    for (const attempt of attempts) {
        const label = modelLabel(attempt.candidate);
        ctx.metadata?.({ title: `${agent} · ${label} — ${description}` });
        let sessionID;
        try {
            const created = await client.session.create({
                body: {
                    parentID: ctx.sessionID,
                    title: `${description} (@${agent} · ${label})`,
                    agent,
                    permission,
                },
                query: { directory: args.directory ?? ctx.directory },
            });
            if (created.error !== undefined || created.data?.id === undefined) {
                throw new Error(typeof created.error === 'string' ? created.error : 'session create failed');
            }
            sessionID = created.data.id;
            const text = await promptChild(client, { sessionID, agent, prompt, candidate: attempt.candidate });
            const fallbackNote = failures.length > 0
                ? `\n(note: fell back after ${failures.map((f) => f.label).join(', ')} failed)`
                : '';
            return {
                output: [
                    `<dispatch agent="${agent}" model="${label}"${resolution.className ? ` class="${resolution.className}"` : ''} session="${sessionID}">`,
                    text,
                    '</dispatch>',
                ].join('\n') + fallbackNote,
                title: `${agent} · ${label} — ${description}`,
                metadata: { agent, model: label, class: resolution.className, sessionID },
            };
        }
        catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            failures.push({ label, message });
            if (attempt.candidate === null) {
                return { error: `dispatch failed on every model (${failures.map((f) => `${f.label}: ${f.message}`).join('; ')})` };
            }
        }
    }
    return { error: 'dispatch failed unexpectedly' };
}
