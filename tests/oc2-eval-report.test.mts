import assert from 'node:assert/strict';
import test from 'node:test';
import { buildEvaluationReport, gradeEvaluationResponse, parseAttemptLines, type AnswerKeyTask, type EvaluationAttemptRecord } from '../tools/naru-lib/oc2-eval-report.mjs';
import type { EvaluationMatrix } from '../tools/naru-lib/oc2-eval-catalogue.mjs';

const key: AnswerKeyTask = { taskID: 'task', facts: { answer: 42, guard: 'hidden' }, evidence: {
    answer: [{ path: 'source.ts', start: 2, end: 4 }], guard: [{ path: 'panel.ts', start: 8, end: 9 }],
} };
const sources = [{ path: 'source.ts', lines: 10 }, { path: 'panel.ts', lines: 10 }];
const responseSchema = { properties: { facts: { properties: { answer: { type: 'number' }, guard: { type: 'string', enum: ['hidden'] } } } } };

test('grader separates fact accuracy from meaningful evidence coverage and rejects malformed output and refusal', () => {
    const completed = gradeEvaluationResponse('task', JSON.stringify({ taskID: 'task', facts: { answer: 42, guard: 'hidden' }, evidence: {
        answer: [{ path: 'source.ts', startLine: 2, endLine: 4 }], guard: [{ path: 'panel.ts', startLine: 8, endLine: 9 }],
    }, briefExplanation: 'Direct evaluation.' }), key, sources, responseSchema);
    assert.deepEqual(completed, { status: 'completed', grade: { answerFactsCorrect: 2, answerFactsTotal: 2, answerFactAccuracy: 1, evidenceCovered: 2, evidenceEligibleCorrectFacts: 2, evidenceCoverage: 1,
        formatCompliance: true, formatIssues: [], invalidEvidence: 0, irrelevantEvidence: 0, semanticDiagnostics: { numericStringFactIDs: [] }, perfect: true } });
    const malformed = gradeEvaluationResponse('task', '{', key, sources, responseSchema);
    assert.equal(malformed.status, 'malformed-output'); assert.equal(malformed.grade.answerFactsCorrect, null); assert.equal(malformed.grade.evidenceCoverage, null);
    assert.equal(gradeEvaluationResponse('task', "I can't answer this request", key, sources, responseSchema).status, 'refusal');
    const badEvidence = gradeEvaluationResponse('task', JSON.stringify({ taskID: 'task', facts: { answer: 42, guard: 'hidden' }, evidence: {
        answer: [{ path: 'source.ts', startLine: 10, endLine: 10 }], guard: [{ path: '../secret', startLine: 1, endLine: 1 }],
    } }), key, sources, responseSchema);
    assert.equal(badEvidence.status, 'format-invalid'); assert.equal(badEvidence.grade.answerFactsCorrect, 2); assert.equal(badEvidence.grade.evidenceCoverage, 0); assert.equal(badEvidence.grade.invalidEvidence, 1); assert.equal(badEvidence.grade.irrelevantEvidence, 1);
});

test('strict numeric types remain format-invalid while numeric-string matches are diagnostic only', () => {
    const result = gradeEvaluationResponse('task', JSON.stringify({ taskID: 'task', facts: { answer: '42', guard: 'hidden' }, evidence: {
        answer: [{ path: 'source.ts', startLine: 2, endLine: 4 }], guard: [{ path: 'panel.ts', startLine: 8, endLine: 9 }],
    } }), key, sources, responseSchema);
    assert.equal(result.status, 'format-invalid'); assert.equal(result.grade.formatCompliance, false); assert.equal(result.grade.answerFactsCorrect, null);
    assert.deepEqual(result.grade.semanticDiagnostics.numericStringFactIDs, ['answer']); assert.ok(result.grade.formatIssues.includes('fact-type:answer'));
});

test('a nearby preceding line is valid but irrelevant evidence, not hidden-range coverage', () => {
    const result = gradeEvaluationResponse('task', JSON.stringify({ taskID: 'task', facts: { answer: 42, guard: 'hidden' }, evidence: {
        answer: [{ path: 'source.ts', startLine: 1, endLine: 1 }], guard: [{ path: 'panel.ts', startLine: 7, endLine: 7 }],
    } }), key, sources, responseSchema);
    assert.equal(result.status, 'completed'); assert.equal(result.grade.answerFactAccuracy, 1); assert.equal(result.grade.evidenceCoverage, 0);
    assert.equal(result.grade.invalidEvidence, 0); assert.equal(result.grade.irrelevantEvidence, 2); assert.equal(result.grade.perfect, false);
});

const selection: EvaluationMatrix['selection'] = { opencodeGoRoutes: 0, advertisedFreeOpenCodeRoutes: 0, requiredNamedRoutes: 0, opencodeGoRouteIDs: [], advertisedFreeOpenCodeRouteIDs: [], requiredNamedRouteIDs: [], fullConfigurationCount: 1 };
const sampling: EvaluationMatrix['sampling'] = { exploratory: true, ranking: false, replicates: 1, order: 'route-then-variant' };
const configuration: EvaluationMatrix['configurations'][number] = { id: 'openai/model#default', routeID: 'openai/model', providerID: 'openai', modelID: 'model', upstreamModelID: 'upstream', variant: null, reasoningLevel: 'default', serviceTier: 'default', requestSettings: {}, costProvenance: { mode: 'subscription-only-authorization', allowance: 'unknown', cataloguePricesUsedForEligibility: false }, status: 'pending' };
const matrix: EvaluationMatrix = { schemaVersion: 2, kind: 'task-conditioned-read-only', observedAt: '2026-09-15T00:00:00.000Z', generatedAt: '2026-09-15T00:00:00.000Z', limitations: ['limited'], selection, subset: { mode: 'full', requestedConfigurationIDs: [], fullConfigurationCount: 1, selectedConfigurationCount: 1 }, sampling, configurations: [configuration] };
const policy = { maxAttempts: 6, maxWallMs: 1_200_000, maxAttemptWallMs: 120_000, maxOutputTokens: 512, concurrency: 1, providerConcurrency: 1 as const };
const attempt = (taskID: string, status: EvaluationAttemptRecord['status']): EvaluationAttemptRecord => ({ schemaVersion: 3, protocol: { taskVersion: 2, scorerVersion: 2, sourceListingFormat: 'numbered-lines-v1', numericPolicy: 'strict-json-types' }, inputFingerprint: 'f'.repeat(64), attemptID: taskID, runID: 'r', taskID, taskDigest: 'd', configurationID: configuration.id, routeID: configuration.routeID,
    requested: { providerID: 'openai', modelID: 'model', variant: null, serviceTier: 'default' }, observed: { providerID: 'openai', modelID: 'upstream', variant: null, finish: 'stop' }, status, latencyMs: 10, usage: { inputTokens: 20, outputTokens: 5 },
    budgetPolicy: { requestedMaxOutputTokens: 512, enforcement: 'token-cap', appliedMaxTokens: 512, wallDeadlineMs: 120000 },
    grade: { answerFactsCorrect: status === 'completed' ? 2 : null, answerFactsTotal: 2, answerFactAccuracy: status === 'completed' ? 1 : null,
        evidenceCovered: status === 'completed' ? 2 : null, evidenceEligibleCorrectFacts: status === 'completed' ? 2 : null, evidenceCoverage: status === 'completed' ? 1 : null,
        formatCompliance: status === 'completed', formatIssues: status === 'completed' ? [] : ['unscored-attempt'], invalidEvidence: 0, irrelevantEvidence: 0,
        semanticDiagnostics: { numericStringFactIDs: [] }, perfect: status === 'completed' ? true : null } });

test('report requires every task before a configuration is complete and keeps failures attempted', () => {
    const one = buildEvaluationReport(matrix, [attempt('one', 'completed')], ['one', 'two'], policy);
    assert.equal(one.coverage.completeConfigurations, 0); assert.equal(one.coverage.attemptedIncompleteConfigurations, 1); assert.equal(one.configurations[0]!.ledger, 'attempted');
    const failed = buildEvaluationReport(matrix, [attempt('one', 'completed'), attempt('two', 'timeout')], ['one', 'two'], policy);
    assert.equal(failed.coverage.completeConfigurations, 0); assert.equal(failed.configurations[0]!.ledger, 'attempted');
    assert.equal(attempt('two', 'incomplete-output').grade.answerFactsCorrect, null);
    const complete = buildEvaluationReport(matrix, [attempt('one', 'completed'), attempt('two', 'completed')], ['one', 'two'], policy);
    assert.equal(complete.coverage.completeConfigurations, 1); assert.equal(complete.quality.perfectAttempts, 2); assert.equal(complete.quality.answerFacts.meanAccuracy, 1); assert.equal(complete.quality.evidenceCoverage.meanCoverage, 1);
    assert.equal(Object.hasOwn(complete.quality, 'meanCitationAccuracy'), false);
    assert.doesNotMatch(JSON.stringify(complete), /prompt|raw stdout|Direct evaluation/iu);
});

test('report marks all pending configurations for an auth-refused provider as blocked-auth and retains safe diagnostic tags', () => {
    const second = { ...configuration, id: 'openai/model#high', variant: 'high', reasoningLevel: 'high' };
    const auth = { ...attempt('one', 'auth-unavailable'), diagnostic: { category: 'auth-unavailable' as const, reasonCode: 'workspace-required' as const, providerErrorType: 'provider.auth' }, stop: { scope: 'provider-auth' as const, reason: 'auth-unavailable' as const, reasonCode: 'workspace-required' as const } };
    const report = buildEvaluationReport({ ...matrix, configurations: [configuration, second], selection: { ...selection, fullConfigurationCount: 2 }, subset: { ...matrix.subset, fullConfigurationCount: 2, selectedConfigurationCount: 2 } }, [auth], ['one', 'two'], policy);
    assert.equal(report.coverage.blockedAuthConfigurations, 2);
    assert.ok(report.configurations.every(item => item.ledger === 'blocked-auth'));
    assert.deepEqual(report.diagnostics, { 'workspace-required': 1 });
    assert.doesNotMatch(JSON.stringify(report), /only available|https?:\/\//i);
});

test('request-invalid halts the report without failing untouched configurations', () => {
    const other = { ...configuration, id: 'openai/other#high', routeID: 'openai/other', modelID: 'other', variant: 'high', reasoningLevel: 'high' };
    const invalid = { ...attempt('one', 'request-invalid'), diagnostic: { category: 'request-invalid' as const } };
    const report = buildEvaluationReport({ ...matrix, configurations: [configuration, other], selection: { ...selection, fullConfigurationCount: 2 }, subset: { ...matrix.subset, fullConfigurationCount: 2, selectedConfigurationCount: 2 } }, [invalid], ['one', 'two'], policy);
    assert.equal(report.haltedReason, 'request-invalid');
    assert.deepEqual(report.policy, policy);
    assert.equal(report.coverage.requestUnsupportedConfigurations, 1);
    assert.equal(report.configurations[0]!.ledger, 'request-unsupported');
    assert.equal(report.configurations[1]!.ledger, 'pending');
    assert.equal(invalid.grade.answerFactsCorrect, null);
});

test('attempt parsing refuses partial final lines and mismatched frozen fingerprints', () => {
    const line = JSON.stringify(attempt('one', 'completed'));
    assert.throws(() => parseAttemptLines(line), /partial final line/);
    assert.throws(() => parseAttemptLines(`${line}\n`, '0'.repeat(64)), /mismatched.*line 1/);
    assert.throws(() => parseAttemptLines(`${JSON.stringify({ ...attempt('one', 'completed'), schemaVersion: 2 })}\n`), /mismatched.*line 1/);
    assert.equal(parseAttemptLines(`${line}\n`, 'f'.repeat(64)).length, 1);
});
