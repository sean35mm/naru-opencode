import { readFile } from 'node:fs/promises';
import { isPlainObject, isSafeRelativePath, validateAllowedKeys } from './validate.mjs';
import type { EvaluationConfiguration, EvaluationMatrix } from './oc2-eval-catalogue.mjs';

export type AttemptStatus = 'auth-unavailable' | 'completed' | 'context-limit' | 'format-invalid' | 'incomplete-output' | 'infrastructure-failure' | 'malformed-output' | 'quota-stopped' | 'refusal' | 'request-invalid' | 'timeout' | 'tool-failure' | 'unsupported' | 'unavailable';

export interface EvaluationAttemptRecord {
    schemaVersion: 3;
    protocol: { taskVersion: 2; scorerVersion: 2; sourceListingFormat: 'numbered-lines-v1'; numericPolicy: 'strict-json-types' };
    inputFingerprint: string;
    attemptID: string;
    runID: string;
    taskID: string;
    taskDigest: string;
    configurationID: string;
    routeID: string;
    requested: { providerID: string; modelID: string; variant: string | null; serviceTier: EvaluationConfiguration['serviceTier'] };
    observed: { providerID: string; modelID: string; variant: string | null; finish: string | null } | null;
    status: AttemptStatus;
    latencyMs: number;
    usage: { inputTokens?: number; outputTokens?: number; reasoningTokens?: number; cacheReadTokens?: number; cacheWriteTokens?: number };
    budgetPolicy: { requestedMaxOutputTokens: number; enforcement: 'deadline-only' | 'token-cap'; appliedMaxTokens: number | null; wallDeadlineMs: number; reasonCode?: 'openai-subscription-fast-output-limit-unsupported' };
    grade: {
        answerFactsCorrect: number | null;
        answerFactsTotal: number;
        answerFactAccuracy: number | null;
        evidenceCovered: number | null;
        evidenceEligibleCorrectFacts: number | null;
        evidenceCoverage: number | null;
        formatCompliance: boolean;
        formatIssues: string[];
        invalidEvidence: number;
        irrelevantEvidence: number;
        semanticDiagnostics: { numericStringFactIDs: string[] };
        perfect: boolean | null;
    };
    diagnostic?: { category: 'auth-unavailable' | 'request-invalid'; reasonCode?: 'unsupported-output-limit' | 'workspace-required'; providerErrorType?: string };
    stop?: { scope: 'provider-budget'; reason: 'payment' | 'quota' | 'rate-limit'; retryAfterSeconds?: number } | { scope: 'provider-auth'; reason: 'auth-unavailable'; reasonCode?: 'unsupported-output-limit' | 'workspace-required' };
}

export interface EvidenceRange { path: string; start: number; end: number }
export interface AnswerKeyTask {
    taskID: string;
    facts: Record<string, string | number | boolean | null>;
    evidence: Record<string, EvidenceRange[]>;
}
export interface AnswerKey { schemaVersion: 2; scoringVersion: 2; numericPolicy: 'strict-json-types'; tasks: AnswerKeyTask[] }
export interface SourceLineCount { path: string; lines: number }
export interface EvaluationReportPolicy {
    maxAttempts: number;
    maxWallMs: number;
    maxAttemptWallMs: number;
    maxOutputTokens: number;
    concurrency: number;
    providerConcurrency: 1;
}

const emptyGrade = (factsTotal: number, formatIssues: string[], numericStringFactIDs: string[] = [], invalidEvidence = 0, irrelevantEvidence = 0): EvaluationAttemptRecord['grade'] => ({
    answerFactsCorrect: null, answerFactsTotal: factsTotal, answerFactAccuracy: null, evidenceCovered: null, evidenceEligibleCorrectFacts: null, evidenceCoverage: null,
    formatCompliance: false, formatIssues: [...new Set(formatIssues)].sort().slice(0, 64), invalidEvidence, irrelevantEvidence,
    semanticDiagnostics: { numericStringFactIDs: [...new Set(numericStringFactIDs)].sort() }, perfect: null,
});

function responseObject(text: string): Record<string, unknown> | null {
    if (text.length > 64 * 1024) return null;
    const stripped = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
    try { const value = JSON.parse(stripped); return isPlainObject(value) ? value : null; } catch { return null; }
}

export function gradeEvaluationResponse(taskID: string, text: string, key: AnswerKeyTask, sources: SourceLineCount[], responseSchema: Record<string, unknown>): Pick<EvaluationAttemptRecord, 'status' | 'grade'> {
    const total = Object.keys(key.facts).length;
    if (/\b(?:cannot|can't|unable to) (?:answer|comply|help)\b/i.test(text)) return { status: 'refusal', grade: emptyGrade(total, ['refusal']) };
    const value = responseObject(text);
    if (!value) return { status: 'malformed-output', grade: emptyGrade(total, ['invalid-json']) };
    const expectedIDs = Object.keys(key.facts), issues: string[] = [], answerIssues: string[] = [], numericStringFactIDs: string[] = [];
    const answerIssue = (issue: string) => { issues.push(issue); answerIssues.push(issue); };
    const allowedRoot = new Set(['taskID', 'facts', 'evidence', 'briefExplanation']);
    if (Object.keys(value).some(name => !allowedRoot.has(name))) issues.push('unexpected-root-field');
    if (value.taskID !== taskID) answerIssue('task-id');
    if (!isPlainObject(value.facts)) answerIssue('facts-object');
    if (!isPlainObject(value.evidence)) issues.push('evidence-object');
    if (value.briefExplanation !== undefined && (typeof value.briefExplanation !== 'string' || value.briefExplanation.length > 1000)) issues.push('brief-explanation');
    const facts = isPlainObject(value.facts) ? value.facts : {};
    const evidence = isPlainObject(value.evidence) ? value.evidence : {};
    if (Object.keys(facts).sort().join('\0') !== [...expectedIDs].sort().join('\0')) answerIssue('fact-fields');
    if (Object.keys(evidence).sort().join('\0') !== [...expectedIDs].sort().join('\0')) issues.push('evidence-fields');
    const schemaProperties = isPlainObject(responseSchema.properties) && isPlainObject(responseSchema.properties.facts) && isPlainObject(responseSchema.properties.facts.properties) ? responseSchema.properties.facts.properties : {};
    for (const [name, answer] of Object.entries(key.facts)) {
        if (!Object.hasOwn(facts, name)) continue;
        const actual = facts[name], factSchema = isPlainObject(schemaProperties[name]) ? schemaProperties[name] : {};
        const expectedType = factSchema.type, matchesType = expectedType === 'null' ? actual === null : typeof actual === expectedType;
        const matchesEnum = !Array.isArray(factSchema.enum) || factSchema.enum.some(candidate => Object.is(candidate, actual));
        if (!matchesType || !matchesEnum) {
            answerIssue(`${matchesType ? 'fact-enum' : 'fact-type'}:${name}`);
            if (typeof answer === 'number' && typeof actual === 'string' && actual.trim() !== '' && Number.isFinite(Number(actual)) && Number(actual) === answer) numericStringFactIDs.push(name);
        }
    }
    const sourceLines = new Map(sources.map(source => [source.path, source.lines]));
    const validEvidence = new Map<string, EvidenceRange[]>(); let invalidEvidence = 0, irrelevantEvidence = 0;
    for (const name of expectedIDs) {
        const raw = evidence[name];
        if (!Array.isArray(raw) || raw.length < 1 || raw.length > 3) { issues.push(`evidence-list:${name}`); continue; }
        const accepted: EvidenceRange[] = [];
        for (const item of raw) {
            if (!isPlainObject(item) || Object.keys(item).sort().join('\0') !== 'endLine\0path\0startLine' || typeof item.path !== 'string' || !isSafeRelativePath(item.path)
                || !Number.isSafeInteger(item.startLine) || !Number.isSafeInteger(item.endLine)) { invalidEvidence++; issues.push(`evidence-format:${name}`); continue; }
            const start = item.startLine as number, end = item.endLine as number, lines = sourceLines.get(item.path);
            if (start < 1 || end < start || end - start + 1 > 20 || lines === undefined || end > lines) { invalidEvidence++; continue; }
            const range = { path: item.path, start, end }; accepted.push(range);
            if (!(key.evidence[name] ?? []).some(expected => expected.path === range.path && range.start >= expected.start && range.end <= expected.end)) irrelevantEvidence++;
        }
        validEvidence.set(name, accepted);
    }
    const answerScorable = answerIssues.length === 0;
    const correctIDs = answerScorable ? expectedIDs.filter(name => Object.is(facts[name], key.facts[name])) : [];
    const covered = correctIDs.filter(name => (validEvidence.get(name) ?? []).some(range => (key.evidence[name] ?? []).some(expected => expected.path === range.path && range.start >= expected.start && range.end <= expected.end))).length;
    const answerFactsCorrect = answerScorable ? correctIDs.length : null, answerFactAccuracy = answerScorable && total ? correctIDs.length / total : null;
    const evidenceCovered = answerScorable ? covered : null, evidenceEligibleCorrectFacts = answerScorable ? correctIDs.length : null, evidenceCoverage = answerScorable && correctIDs.length ? covered / correctIDs.length : null;
    const formatCompliance = issues.length === 0;
    return { status: formatCompliance ? 'completed' : 'format-invalid', grade: {
        answerFactsCorrect, answerFactsTotal: total, answerFactAccuracy, evidenceCovered, evidenceEligibleCorrectFacts, evidenceCoverage,
        formatCompliance, formatIssues: [...new Set(issues)].sort().slice(0, 64), invalidEvidence, irrelevantEvidence, semanticDiagnostics: { numericStringFactIDs: [...new Set(numericStringFactIDs)].sort() },
        perfect: formatCompliance ? answerFactAccuracy === 1 && evidenceCoverage === 1 && invalidEvidence === 0 && irrelevantEvidence === 0 : null,
    } };
}

export async function readAnswerKey(path: string): Promise<AnswerKey> {
    const value: unknown = JSON.parse(await readFile(path, 'utf8'));
    if (!isPlainObject(value)) throw new Error('Invalid evaluation answer key');
    validateAllowedKeys(value, ['schemaVersion', 'scoringVersion', 'numericPolicy', 'tasks']);
    if (value.schemaVersion !== 2 || value.scoringVersion !== 2 || value.numericPolicy !== 'strict-json-types' || !Array.isArray(value.tasks) || value.tasks.length < 1 || value.tasks.length > 16) throw new Error('Invalid evaluation answer key');
    const ids = new Set<string>();
    for (const raw of value.tasks) {
        if (!isPlainObject(raw)) throw new Error('Invalid evaluation answer key');
        validateAllowedKeys(raw, ['taskID', 'facts', 'evidence']);
        if (typeof raw.taskID !== 'string' || ids.has(raw.taskID) || !isPlainObject(raw.facts) || !isPlainObject(raw.evidence)) throw new Error('Invalid evaluation answer key');
        ids.add(raw.taskID);
        const facts = Object.keys(raw.facts), evidence = Object.keys(raw.evidence);
        if (!facts.length || facts.length > 64 || facts.sort().join('\0') !== evidence.sort().join('\0')) throw new Error('Every answer fact must have evidence ranges');
        for (const ranges of Object.values(raw.evidence)) if (!Array.isArray(ranges) || !ranges.length || ranges.some(range => !isPlainObject(range) || typeof range.path !== 'string' || !isSafeRelativePath(range.path) || !Number.isSafeInteger(range.start) || !Number.isSafeInteger(range.end) || (range.start as number) < 1 || (range.end as number) < (range.start as number) || (range.end as number) - (range.start as number) + 1 > 20)) throw new Error('Invalid answer-key evidence range');
    }
    return value as unknown as AnswerKey;
}

export function buildEvaluationReport(matrix: EvaluationMatrix, attempts: EvaluationAttemptRecord[], taskIDs: string[], policy: EvaluationReportPolicy) {
    if (!taskIDs.length || new Set(taskIDs).size !== taskIDs.length) throw new Error('Report requires distinct expected task IDs');
    const counts: Record<string, number> = {};
    for (const attempt of attempts) counts[attempt.status] = (counts[attempt.status] ?? 0) + 1;
    const byConfiguration = new Map<string, EvaluationAttemptRecord[]>();
    for (const attempt of attempts) byConfiguration.set(attempt.configurationID, [...(byConfiguration.get(attempt.configurationID) ?? []), attempt]);
    const authBlockedProviders = new Set(attempts.filter(attempt => attempt.stop?.scope === 'provider-auth').map(attempt => attempt.requested.providerID));
    const ledger = matrix.configurations.map(item => {
        if (item.status === 'blocked') return { id: item.id, routeID: item.routeID, upstreamModelID: item.upstreamModelID, reasoningLevel: item.reasoningLevel, serviceTier: item.serviceTier, ledger: 'blocked' as const, completedTasks: 0, expectedTasks: taskIDs.length };
        const records = byConfiguration.get(item.id) ?? [];
        const completedTasks = taskIDs.filter(taskID => records.some(record => record.taskID === taskID && record.status === 'completed')).length;
        return { id: item.id, routeID: item.routeID, upstreamModelID: item.upstreamModelID, reasoningLevel: item.reasoningLevel, serviceTier: item.serviceTier,
            ledger: completedTasks === taskIDs.length ? 'complete' as const : records.some(record => record.status === 'request-invalid') ? 'request-unsupported' as const : authBlockedProviders.has(item.providerID) ? 'blocked-auth' as const : records.length ? 'attempted' as const : 'pending' as const, completedTasks, expectedTasks: taskIDs.length };
    });
    const completed = attempts.filter(attempt => attempt.status === 'completed');
    const formatEligible = attempts.filter(attempt => attempt.status === 'completed' || attempt.status === 'format-invalid' || attempt.status === 'malformed-output' || attempt.status === 'refusal');
    const answerScores = attempts.flatMap(attempt => attempt.grade.answerFactAccuracy === null ? [] : [attempt.grade.answerFactAccuracy]);
    const evidenceScores = attempts.flatMap(attempt => attempt.grade.evidenceCoverage === null ? [] : [attempt.grade.evidenceCoverage]);
    const mean = (scores: number[]) => scores.length ? scores.reduce((sum, score) => sum + score, 0) / scores.length : null;
    return {
        schemaVersion: 3, kind: matrix.kind,
        protocol: { taskVersion: 2, scorerVersion: 2, sourceListingFormat: 'numbered-lines-v1', numericPolicy: 'strict-json-types' },
        sampling: matrix.sampling,
        limitations: [...matrix.limitations, 'Revision-1 citation scores measured whether any citation landed in each hidden range, not citation precision or a valid general accuracy metric. They are unsuitable for model ranking and are not regraded here.'],
        inventory: matrix.selection,
        policy,
        haltedReason: attempts.some(attempt => attempt.status === 'request-invalid') ? 'request-invalid' as const : null,
        coverage: {
            configurations: matrix.configurations.length,
            completeConfigurations: ledger.filter(item => item.ledger === 'complete').length,
            attemptedIncompleteConfigurations: ledger.filter(item => item.ledger === 'attempted').length,
            pendingConfigurations: ledger.filter(item => item.ledger === 'pending').length,
            blockedConfigurations: ledger.filter(item => item.ledger === 'blocked').length,
            blockedAuthConfigurations: ledger.filter(item => item.ledger === 'blocked-auth').length,
            requestUnsupportedConfigurations: ledger.filter(item => item.ledger === 'request-unsupported').length,
            expectedTasksPerConfiguration: taskIDs.length,
        },
        outcomes: Object.fromEntries(Object.entries(counts).sort(([left], [right]) => left.localeCompare(right))),
        diagnostics: Object.fromEntries([...new Set(attempts.flatMap(attempt => attempt.diagnostic ? [attempt.diagnostic.reasonCode ?? attempt.diagnostic.category] : []))].sort().map(tag => [tag, attempts.filter(attempt => (attempt.diagnostic?.reasonCode ?? attempt.diagnostic?.category) === tag).length])),
        quality: {
            completedAttempts: completed.length,
            answerFacts: { scoredAttempts: answerScores.length, meanAccuracy: mean(answerScores) },
            evidenceCoverage: { scoredAttempts: evidenceScores.length, eligibleOnlyForCorrectFacts: true, meanCoverage: mean(evidenceScores) },
            formatCompliance: { compliantAttempts: formatEligible.filter(attempt => attempt.grade.formatCompliance).length, eligibleResponseAttempts: formatEligible.length },
            invalidEvidence: attempts.reduce((sum, attempt) => sum + attempt.grade.invalidEvidence, 0),
            irrelevantEvidence: attempts.reduce((sum, attempt) => sum + attempt.grade.irrelevantEvidence, 0),
            perfectAttempts: completed.filter(attempt => attempt.grade.perfect).length,
            scope: 'exploratory single-sample source-reading tasks; no ranking and no agentic tools',
        },
        configurations: ledger,
    };
}

export function parseAttemptLines(content: string, fingerprint?: string): EvaluationAttemptRecord[] {
    if (!content) return [];
    if (!content.endsWith('\n')) throw new Error('Evaluation attempt log has a partial final line; manual recovery is required');
    return content.trim().split('\n').filter(Boolean).map((line, index) => {
        try {
            const value = JSON.parse(line) as EvaluationAttemptRecord;
            if (value.schemaVersion !== 3 || !isPlainObject(value.protocol) || value.protocol.taskVersion !== 2 || value.protocol.scorerVersion !== 2 || value.protocol.sourceListingFormat !== 'numbered-lines-v1' || value.protocol.numericPolicy !== 'strict-json-types'
                || typeof value.inputFingerprint !== 'string' || typeof value.attemptID !== 'string' || typeof value.configurationID !== 'string' || typeof value.status !== 'string' || !isPlainObject(value.budgetPolicy) || (fingerprint && value.inputFingerprint !== fingerprint)) throw new Error();
            return value;
        } catch { throw new Error(`Malformed or mismatched evaluation attempt record at line ${index + 1}`); }
    });
}
