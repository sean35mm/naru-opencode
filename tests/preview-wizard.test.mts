import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { cp, lstat, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { renderPromptValue, runPreviewWizard, TerminalWizardPrompt, WizardCancelled, type PreviewSetupStatus, type WizardPrompt } from '../tools/naru-lib/preview-wizard.mjs';
import type { PreviewCatalogue } from '../tools/naru-lib/preview-process.mjs';
import type { Enrollment, EnrollmentKind, GlobalWorkerPool, PreviewAccess } from '../tools/naru-lib/preview-broker.mjs';
import type { GlobalInstructionsMetadata } from '../tools/naru-lib/global-instructions.mjs';

const model = { id: 'tool_worker', providerID: 'fixture', name: 'Tool Worker', reference: 'fixture/tool_worker', capabilities: { tools: true, input: ['text'], output: ['text'] }, variantIDs: ['fast'] };
const catalogue: PreviewCatalogue = { models: [model], providers: [{ id: 'fixture', name: 'Fixture', activation: 'enabled' }], observedAt: '2026-09-08T00:00:00.000Z', metadataFreshness: 'unknown', accountAccess: 'unknown' };
const built = join(dirname(fileURLToPath(import.meta.url)), '..');
const supportsPty = process.platform === 'darwin' || process.platform === 'linux';
const globalProfile: GlobalWorkerPool = { models: ['fixture/tool_worker#fast'], revision: 2 };
const disabledInstructions: GlobalInstructionsMetadata = { revision: 0, sourcePath: null, loadStatus: 'disabled' };
const status = (enrollment: Enrollment | null = null, dirty = false, maximumAccess: PreviewAccess = 'write', global: GlobalWorkerPool | null = globalProfile): PreviewSetupStatus => ({
    installation: { version: '0.0.0-beta-19425', isolated: true, hostCapabilities: { inspect: true, check: maximumAccess !== 'inspect', write: maximumAccess === 'write' } },
    globalProfile: global, globalInstructions: disabledInstructions, repository: { path: '/canonical/repo', kind: 'git', dirty, enrollment, effectiveWorkerPool: enrollment && global ? { models: global.models, revision: global.revision } : null }, blockers: [], maximumAccess,
});

class Prompt implements WizardPrompt {
    messages: string[] = []; choices: Array<Array<{ value: string; label: string }>> = []; modelInitials: string[][] = []; modelOptions: string[][] = [];
    constructor(readonly answers: { input?: string[]; choose?: string[]; confirm?: boolean[]; models?: Array<string[] | Error> } = {}) {}
    message(value: string) { this.messages.push(value); }
    async input() { const value = this.answers.input?.shift(); if (value === undefined) throw new Error('Unexpected input prompt'); return value; }
    async choose<T extends string>(_label: string, choices: Array<{ value: T; label: string }>): Promise<T> {
        this.choices.push(choices); const value = this.answers.choose?.shift(); if (!value) throw new Error('Unexpected choice prompt');
        if (value === 'CANCEL') throw new WizardCancelled();
        assert.ok(choices.some(choice => choice.value === value), `choice ${value} was not offered`); return value as T;
    }
    async confirm() { const value = this.answers.confirm?.shift(); if (value === undefined) throw new Error('Unexpected confirmation'); return value; }
    async selectModels(models: typeof catalogue.models, initial: string[]) { this.modelOptions.push(models.map(value => value.reference)); this.modelInitials.push([...initial]); const value = this.answers.models?.shift(); if (value instanceof Error) throw value; if (!value) throw new Error('Unexpected model prompt'); return value; }
}

const catalogueOfSize = (count: number): PreviewCatalogue => ({ ...catalogue, models: Array.from({ length: count }, (_, index) => ({ ...model, id: `worker_${index}`, name: `Worker ${index}`, reference: `fixture/worker_${index}`, variantIDs: [] })) });

function adapters(overrides: Partial<{
    statuses: PreviewSetupStatus[]; catalogues: PreviewCatalogue[]; refreshCatalogue: (path: string) => Promise<PreviewCatalogue>; diagnoseCatalogue: (path: string, query: string, current?: PreviewCatalogue) => Promise<{ query: string; observedAt: string; accountAccess: 'unknown'; matches: Array<{ reference: string; name: string; eligibility: string; reason?: string; sourcePresence?: string; variantAvailability?: string }> }>; configureGlobal: (input: { models: string[]; expectedRevision: number | null }) => Promise<GlobalWorkerPool>; prepareGlobalInstructions: (input: { sourcePath: string }) => Promise<{ sourcePath: string; canonicalPath: string; sha256: string; byteLength: number }>; configureGlobalInstructions: (input: { sourcePath: string; canonicalPath: string; sha256: string; byteLength: number; expectedRevision: number }) => Promise<GlobalInstructionsMetadata>; disableGlobalInstructions: (input: { expectedRevision: number }) => Promise<GlobalInstructionsMetadata>; enroll: (input: { path: string; kind: EnrollmentKind; access: PreviewAccess; writeScopes: string[]; expectedRevision: number | null; expectedGlobalRevision: number }) => Promise<Enrollment>; authenticate: () => Promise<void>; open: (path: string) => Promise<void>;
}> = {}) {
    const calls = { status: [] as string[], catalogue: [] as string[], refreshCatalogue: [] as string[], diagnoseCatalogue: [] as unknown[], configureGlobal: [] as unknown[], prepareGlobalInstructions: [] as unknown[], configureGlobalInstructions: [] as unknown[], disableGlobalInstructions: [] as unknown[], enroll: [] as unknown[], open: [] as string[], authenticate: 0 };
    const statuses = [...(overrides.statuses ?? [status()])], catalogues = [...(overrides.catalogues ?? [catalogue])];
    return { calls, value: {
        status: async (path: string) => { calls.status.push(path); const value = statuses.shift(); if (!value) throw new Error('Unexpected status'); return value; },
        catalogue: async (path: string) => { calls.catalogue.push(path); const value = catalogues.shift(); if (!value) throw new Error('Unexpected catalogue'); return value; },
        configureGlobal: async (input: { models: string[]; expectedRevision: number | null }) => { calls.configureGlobal.push(input); return overrides.configureGlobal ? overrides.configureGlobal(input) : { models: input.models, revision: (input.expectedRevision ?? 0) + 1 }; },
        prepareGlobalInstructions: async (input: { sourcePath: string }) => { calls.prepareGlobalInstructions.push(input); return overrides.prepareGlobalInstructions ? overrides.prepareGlobalInstructions(input) : { sourcePath: input.sourcePath, canonicalPath: input.sourcePath, sha256: 'a'.repeat(64), byteLength: 24 }; },
        configureGlobalInstructions: async (input: { sourcePath: string; canonicalPath: string; sha256: string; byteLength: number; expectedRevision: number }): Promise<GlobalInstructionsMetadata> => { calls.configureGlobalInstructions.push(input); return overrides.configureGlobalInstructions ? overrides.configureGlobalInstructions(input) : { revision: input.expectedRevision + 1, sourcePath: input.sourcePath, canonicalPath: input.canonicalPath, sha256: input.sha256, byteLength: input.byteLength, loadStatus: 'loaded' }; },
        disableGlobalInstructions: async (input: { expectedRevision: number }): Promise<GlobalInstructionsMetadata> => { calls.disableGlobalInstructions.push(input); return overrides.disableGlobalInstructions ? overrides.disableGlobalInstructions(input) : { revision: input.expectedRevision + 1, sourcePath: null, loadStatus: 'disabled' }; },
        enroll: async (input: { path: string; kind: EnrollmentKind; access: PreviewAccess; writeScopes: string[]; expectedRevision: number | null; expectedGlobalRevision: number }) => { calls.enroll.push(input); return overrides.enroll ? overrides.enroll(input) : { path: input.path, kind: input.kind, access: input.access, writeScopes: input.writeScopes, revision: (input.expectedRevision ?? 0) + 1 }; },
        authenticate: async () => { calls.authenticate++; await overrides.authenticate?.(); },
        open: async (path: string) => { calls.open.push(path); await overrides.open?.(path); },
        ...(overrides.refreshCatalogue ? { refreshCatalogue: async (path: string) => { calls.refreshCatalogue.push(path); return overrides.refreshCatalogue!(path); } } : {}),
        ...(overrides.diagnoseCatalogue ? { diagnoseCatalogue: async (path: string, query: string, current?: PreviewCatalogue) => { calls.diagnoseCatalogue.push({ path, query }); return overrides.diagnoseCatalogue!(path, query, current); } } : {}),
    } };
}

test('multiple new repositories inherit the configured global worker pool without reopening the model picker', async () => {
    for (const name of ['a', 'b', 'c']) {
        const repositoryStatus = status(); repositoryStatus.repository!.path = `/canonical/${name}`;
        const prompt = new Prompt({ choose: ['inspect'], confirm: [true] }); const fixture = adapters({ statuses: [repositoryStatus] });
        const result = await runPreviewWizard({ cwd: `/canonical/${name}`, configure: false, prompt, adapters: fixture.value });
        assert.equal(result.outcome, 'launched');
        assert.deepEqual(fixture.calls.enroll, [{ path: `/canonical/${name}`, kind: 'git', access: 'inspect', writeScopes: [], expectedRevision: null, expectedGlobalRevision: 2 }]);
        assert.deepEqual(fixture.calls.catalogue, []); assert.deepEqual(fixture.calls.open, [`/canonical/${name}`]);
    }
});

test('first setup saves a confirmed global pool, then asks only for repository access', async () => {
    const unset = status(null, false, 'write', null), configured = status();
    const prompt = new Prompt({ choose: ['inspect'], models: [['fixture/tool_worker#fast']], confirm: [true, true] });
    const fixture = adapters({ statuses: [unset, configured] });
    const result = await runPreviewWizard({ cwd: '/canonical/repo', configure: false, prompt, adapters: fixture.value });
    assert.equal(result.outcome, 'launched'); assert.equal(result.globalWorkerPoolSaved, true);
    assert.deepEqual(fixture.calls.configureGlobal, [{ models: ['fixture/tool_worker#fast'], expectedRevision: null }]);
    assert.equal(fixture.calls.catalogue.length, 1);
});

test('cancellation after a global save discloses the durable pool and leaves the repository unenrolled', async () => {
    const outsideUnset: PreviewSetupStatus = { ...status(null, false, 'write', null), repository: null, blockers: ['not a repository'] };
    const outsideConfigured: PreviewSetupStatus = { ...status(), repository: null, blockers: ['not a repository'] };
    const prompt = new Prompt({ choose: ['cancel'], models: [['fixture/tool_worker#fast']], confirm: [true] });
    const fixture = adapters({ statuses: [outsideUnset, outsideConfigured, outsideConfigured] });
    const result = await runPreviewWizard({ cwd: '/outside-git', configure: false, prompt, adapters: fixture.value });
    assert.deepEqual(result, { outcome: 'cancelled', authenticationMayHaveChanged: false, globalWorkerPoolSaved: true });
    assert.equal(fixture.calls.configureGlobal.length, 1); assert.deepEqual(fixture.calls.enroll, []);
});

test('global configure works outside Git and stale CAS reloads for explicit reconfirmation', async () => {
    const outside = (profile: GlobalWorkerPool): PreviewSetupStatus => ({ ...status(null, false, 'write', profile), repository: null, blockers: ['not a repository'] });
    let attempts = 0;
    const fixture = adapters({ statuses: [outside(globalProfile), outside({ models: ['fixture/tool_worker'], revision: 3 })], catalogues: [catalogue, catalogue], configureGlobal: async input => {
        if (!attempts++) throw new Error('Global worker models changed since setup status; reload, review, and confirm again');
        return { models: input.models, revision: 4 };
    } });
    const prompt = new Prompt({ choose: ['global'], models: [['fixture/tool_worker#fast'], ['fixture/tool_worker']], confirm: [true, true] });
    const result = await runPreviewWizard({ cwd: '/outside-git', configure: true, prompt, adapters: fixture.value });
    assert.equal(result.outcome, 'configured'); assert.equal(result.globalWorkerPoolSaved, true);
    assert.deepEqual(fixture.calls.configureGlobal, [{ models: ['fixture/tool_worker#fast'], expectedRevision: 2 }, { models: ['fixture/tool_worker'], expectedRevision: 3 }]);
    assert.ok(prompt.messages.some(message => /confirm again/.test(message)));
});

test('global instructions configure works outside Git, accepts the home default, and confirms canonical metadata only', async () => {
    const configured: PreviewSetupStatus = { ...status(), globalInstructions: { revision: 4, sourcePath: null, loadStatus: 'disabled' }, repository: null, blockers: ['not a repository'] };
    const chosen = '/synthetic/home/.config/opencode/AGENTS.md', canonical = '/synthetic/home/config/instructions.md';
    const prompt = new Prompt({ choose: ['instructions', 'reference'], input: [''], confirm: [true] });
    const fixture = adapters({ statuses: [configured], prepareGlobalInstructions: async input => ({ sourcePath: input.sourcePath, canonicalPath: canonical, sha256: 'b'.repeat(64), byteLength: 31 }) });
    const result = await runPreviewWizard({ cwd: '/outside-git', configure: true, prompt, adapters: fixture.value, defaultGlobalInstructionsPath: chosen });
    assert.deepEqual(result, { outcome: 'configured', globalInstructionsSaved: true });
    assert.deepEqual(fixture.calls.prepareGlobalInstructions, [{ sourcePath: chosen }]);
    assert.deepEqual(fixture.calls.configureGlobalInstructions, [{ sourcePath: chosen, canonicalPath: canonical, sha256: 'b'.repeat(64), byteLength: 31, expectedRevision: 4 }]);
    const confirmation = prompt.messages.find(message => message.startsWith('Source:'))!;
    assert.match(confirmation, /Canonical target:/); assert.match(confirmation, /SHA-256:/); assert.match(confirmation, /advisory/); assert.doesNotMatch(confirmation, /instruction body/i);
});

test('global instructions disable increments from the displayed revision and cancel performs no mutation', async () => {
    const configured: PreviewSetupStatus = { ...status(), globalInstructions: { revision: 8, sourcePath: '/synthetic/AGENTS.md', canonicalPath: '/synthetic/AGENTS.md', sha256: 'c'.repeat(64), byteLength: 12, loadStatus: 'loaded' }, repository: null, blockers: [] };
    const disablePrompt = new Prompt({ choose: ['instructions', 'disable'], confirm: [true] }), disableFixture = adapters({ statuses: [configured] });
    assert.deepEqual(await runPreviewWizard({ cwd: '/outside', configure: true, prompt: disablePrompt, adapters: disableFixture.value }), { outcome: 'configured', globalInstructionsSaved: true });
    assert.deepEqual(disableFixture.calls.disableGlobalInstructions, [{ expectedRevision: 8 }]);
    const cancelPrompt = new Prompt({ choose: ['instructions', 'cancel'] }), cancelFixture = adapters({ statuses: [configured] });
    assert.equal((await runPreviewWizard({ cwd: '/outside', configure: true, prompt: cancelPrompt, adapters: cancelFixture.value })).outcome, 'cancelled');
    assert.deepEqual(cancelFixture.calls.configureGlobalInstructions, []); assert.deepEqual(cancelFixture.calls.disableGlobalInstructions, []);
});

test('global instructions CAS and canonical-target races reload before a fresh confirmation', async () => {
    const first: PreviewSetupStatus = { ...status(), globalInstructions: { revision: 2, sourcePath: null, loadStatus: 'disabled' }, repository: null, blockers: [] };
    const second: PreviewSetupStatus = { ...first, globalInstructions: { revision: 3, sourcePath: null, loadStatus: 'disabled' } };
    let attempts = 0;
    const prompt = new Prompt({ choose: ['instructions', 'reference', 'reference'], input: ['/home/first.md', '/home/second.md'], confirm: [true, true] });
    const fixture = adapters({ statuses: [first, second], configureGlobalInstructions: async input => {
        if (!attempts++) throw new Error('Global instructions source changed after preview; reload and confirm the current canonical target and metadata');
        return { revision: input.expectedRevision + 1, sourcePath: input.sourcePath, canonicalPath: input.canonicalPath, sha256: input.sha256, byteLength: input.byteLength, loadStatus: 'loaded' };
    } });
    assert.equal((await runPreviewWizard({ cwd: '/outside', configure: true, prompt, adapters: fixture.value })).outcome, 'configured');
    assert.deepEqual((fixture.calls.configureGlobalInstructions as Array<{ expectedRevision: number }>).map(value => value.expectedRevision), [2, 3]);
    assert.ok(prompt.messages.some(message => /confirm again/.test(message)));
});

test('global instruction paths are escaped in prompts without changing adapter identity', async () => {
    const unsafe = '/home/name\n\u001b[2J\u202E.md';
    const outside: PreviewSetupStatus = { ...status(), repository: null, blockers: [], globalInstructions: disabledInstructions };
    const prompt = new Prompt({ choose: ['instructions', 'reference'], input: [unsafe], confirm: [false] });
    const fixture = adapters({ statuses: [outside] });
    assert.equal((await runPreviewWizard({ cwd: '/outside', configure: true, prompt, adapters: fixture.value })).outcome, 'cancelled');
    assert.deepEqual(fixture.calls.prepareGlobalInstructions, [{ sourcePath: unsafe }]);
    const shown = prompt.messages.find(message => message.startsWith('Source:'))!;
    assert.equal(shown.includes(unsafe), false); assert.equal(shown.includes('\u001b'), false); assert.equal(shown.includes('\u202e'), false); assert.match(shown, /\\u\{000a\}/);
});

test('ready repeat launch is a no-prompt fast path without catalogue refresh', async () => {
    const enrollment: Enrollment = { path: '/canonical/repo', access: 'inspect', writeScopes: [], revision: 3 };
    const prompt = new Prompt(); const fixture = adapters({ statuses: [status(enrollment)] });
    assert.equal((await runPreviewWizard({ cwd: '/canonical/repo', configure: false, prompt, adapters: fixture.value })).outcome, 'launched');
    assert.deepEqual(fixture.calls.catalogue, []); assert.deepEqual(fixture.calls.enroll, []); assert.deepEqual(fixture.calls.open, ['/canonical/repo']);
});

test('an existing enrollment with no global pool is guided through global setup before launch', async () => {
    const enrollment: Enrollment = { path: '/canonical/repo', access: 'check', writeScopes: [], revision: 1 };
    const prompt = new Prompt({ choose: ['check'], models: [['fixture/tool_worker']], confirm: [true, true] }), fixture = adapters({ statuses: [status(enrollment, false, 'write', null), status(enrollment)] });
    assert.equal((await runPreviewWizard({ cwd: '/canonical/repo', configure: false, prompt, adapters: fixture.value })).outcome, 'launched');
    assert.deepEqual(fixture.calls.configureGlobal, [{ models: ['fixture/tool_worker'], expectedRevision: null }]); assert.equal(fixture.calls.catalogue.length, 1); assert.deepEqual(fixture.calls.open, ['/canonical/repo']);
});

test('configure revisits repository access and cancellation does not mutate policy', async () => {
    for (const current of [status({ path: '/canonical/repo', access: 'write', writeScopes: ['src/**'], revision: 2 }, true), status(null, false, 'inspect')]) {
        const prompt = new Prompt({ choose: ['repository', 'inspect'], confirm: [false] }); const fixture = adapters({ statuses: [current] });
        const result = await runPreviewWizard({ cwd: '/canonical/repo', configure: true, prompt, adapters: fixture.value });
        assert.equal(result.outcome, 'cancelled'); assert.deepEqual(fixture.calls.enroll, []); assert.deepEqual(fixture.calls.catalogue, []); assert.ok(!prompt.choices[1]!.some(choice => choice.value === 'write'));
    }
});

test('wizard cancels cleanly outside Git, during model selection, final confirmation, and native auth', async () => {
    const outside: PreviewSetupStatus = { ...status(), repository: null, blockers: ['not a repository'] };
    const cases = [
        { prompt: new Prompt({ choose: ['cancel'] }), fixture: adapters({ statuses: [outside, outside] }) },
        { prompt: new Prompt({ models: [new WizardCancelled()] }), fixture: adapters({ statuses: [status(null, false, 'write', null)] }) },
        { prompt: new Prompt({ choose: ['inspect'], confirm: [false] }), fixture: adapters() },
        { prompt: new Prompt({ choose: ['login'] }), fixture: adapters({ statuses: [status(null, false, 'write', null)], catalogues: [{ ...catalogue, models: [] }, catalogue], authenticate: async () => { throw new WizardCancelled(); } }) },
    ];
    for (const item of cases) {
        const result = await runPreviewWizard({ cwd: '/candidate', configure: false, prompt: item.prompt, adapters: item.fixture.value });
        assert.equal(result.outcome, 'cancelled'); assert.deepEqual(item.fixture.calls.enroll, []);
    }
});

test('catalogue retry/login discloses durable auth and never treats activation as account evidence', async () => {
    const unset = status(null, false, 'write', null), configured = status();
    const prompt = new Prompt({ choose: ['login', 'inspect'], models: [['fixture/tool_worker']], confirm: [true, true] });
    const fixture = adapters({ statuses: [unset, configured], catalogues: [{ ...catalogue, models: [] }, catalogue] });
    const result = await runPreviewWizard({ cwd: '/canonical/repo', configure: false, prompt, adapters: fixture.value });
    assert.equal(fixture.calls.authenticate, 1); assert.equal(result.authenticationMayHaveChanged, true);
    assert.ok(prompt.choices[0]!.find(choice => choice.value === 'login')!.label.includes('persist'));
});

test('successful authentication followed by an empty catalogue preserves the may-have-changed flag on every cancellation path', async () => {
    for (const cancellation of ['cancel', 'CANCEL']) {
        const prompt = new Prompt({ choose: ['login', cancellation] });
        const fixture = adapters({ statuses: [status(null, false, 'write', null)], catalogues: [{ ...catalogue, models: [] }, { ...catalogue, models: [] }] });
        const result = await runPreviewWizard({ cwd: '/canonical/repo', configure: false, prompt, adapters: fixture.value });
        assert.deepEqual(result, { outcome: 'cancelled', authenticationMayHaveChanged: true });
        assert.equal(fixture.calls.authenticate, 1); assert.deepEqual(fixture.calls.enroll, []);
    }
    const retryPrompt = new Prompt({ choose: ['login', 'retry', 'cancel'] });
    const retryFixture = adapters({ statuses: [status(null, false, 'write', null)], catalogues: Array.from({ length: 3 }, () => ({ ...catalogue, models: [] })) });
    assert.deepEqual(await runPreviewWizard({ cwd: '/canonical/repo', configure: false, prompt: retryPrompt, adapters: retryFixture.value }), { outcome: 'cancelled', authenticationMayHaveChanged: true });
    assert.equal(retryFixture.calls.authenticate, 1); assert.deepEqual(retryFixture.calls.enroll, []);

    const authPrompt = new Prompt({ choose: ['login'] });
    const authFixture = adapters({ statuses: [status(null, false, 'write', null)], catalogues: [{ ...catalogue, models: [] }], authenticate: async () => { throw new WizardCancelled(); } });
    assert.deepEqual(await runPreviewWizard({ cwd: '/canonical/repo', configure: false, prompt: authPrompt, adapters: authFixture.value }), { outcome: 'cancelled', authenticationMayHaveChanged: true });
    assert.equal(authFixture.calls.authenticate, 1); assert.deepEqual(authFixture.calls.enroll, []);
});

test('CAS conflict reloads and requires a fresh explicit confirmation before saving', async () => {
    const oldEnrollment: Enrollment = { path: '/canonical/repo', access: 'inspect', writeScopes: [], revision: 1 };
    const currentEnrollment = { ...oldEnrollment, revision: 2 };
    let attempts = 0; const fixture = adapters({ statuses: [status(oldEnrollment), status(currentEnrollment)], catalogues: [catalogue, catalogue], enroll: async input => {
        if (!attempts++) throw new Error('Enrollment changed since setup status; review and confirm the current policy');
        return { path: input.path, kind: input.kind, access: input.access, writeScopes: input.writeScopes, revision: 3 };
    } });
    const prompt = new Prompt({ choose: ['repository', 'inspect', 'inspect'], confirm: [true, true] });
    assert.equal((await runPreviewWizard({ cwd: '/canonical/repo', configure: true, prompt, adapters: fixture.value })).outcome, 'launched');
    assert.deepEqual(fixture.calls.enroll.map(value => (value as { expectedRevision: number }).expectedRevision), [1, 2]);
    assert.ok(prompt.messages.some(value => /confirm again/.test(value)));
});

test('a saved enrollment survives launch failure and launch can be retried without another policy confirmation', async () => {
    let opens = 0; const fixture = adapters({ open: async () => { if (!opens++) throw new Error('synthetic launch failure'); } });
    const prompt = new Prompt({ choose: ['inspect', 'retry'], confirm: [true] });
    assert.equal((await runPreviewWizard({ cwd: '/canonical/repo', configure: false, prompt, adapters: fixture.value })).outcome, 'launched');
    assert.equal(fixture.calls.enroll.length, 1); assert.equal(fixture.calls.open.length, 2);
});

test('invalid model selections retry with distinct, safe explanations before any policy confirmation', async () => {
    const unsafeUnknown = 'fixture/unknown"\n\u001b[2J';
    const cases = [
        { selected: [] as string[], catalogue, expected: /Choose at least one worker reference/ },
        { selected: catalogueOfSize(33).models.map(value => value.reference), catalogue: catalogueOfSize(33), expected: /selected 33 worker references; the limit is 32\. Remove 1/ },
        { selected: ['fixture/tool_worker', 'fixture/tool_worker'], catalogue, expected: /Duplicate worker references: "fixture\/tool_worker"/ },
        { selected: [unsafeUnknown], catalogue, expected: /not offered by this catalogue and not previously approved as unavailable/ },
    ];
    for (const item of cases) {
        const prompt = new Prompt({ choose: ['global'], models: [item.selected, [item.catalogue.models[0]!.reference]], confirm: [false] });
        const fixture = adapters({ catalogues: [item.catalogue] });
        const result = await runPreviewWizard({ cwd: '/canonical/repo', configure: true, prompt, adapters: fixture.value });
        assert.equal(result.outcome, 'cancelled'); assert.deepEqual(fixture.calls.configureGlobal, []); assert.deepEqual(fixture.calls.enroll, []);
        const explanation = prompt.messages.find(message => item.expected.test(message)); assert.ok(explanation);
        assert.doesNotMatch(explanation, /invented/); assert.equal(explanation.includes('\n'), false); assert.equal(explanation.includes('\u001b'), false);
    }
});

test('global model picker retries 33 selections in place and saves only after reducing to 32', async () => {
    const largeCatalogue = catalogueOfSize(33), all = largeCatalogue.models.map(value => value.reference), valid = all.slice(0, 32);

    const globalPrompt = new Prompt({ choose: ['global'], models: [all, valid], confirm: [true] });
    const globalFixture = adapters({ catalogues: [largeCatalogue] });
    assert.equal((await runPreviewWizard({ cwd: '/canonical/repo', configure: true, prompt: globalPrompt, adapters: globalFixture.value })).outcome, 'configured');
    assert.deepEqual(globalPrompt.modelInitials, [globalProfile.models, all]);
    assert.deepEqual(globalFixture.calls.configureGlobal, [{ models: valid, expectedRevision: 2 }]); assert.equal(globalFixture.calls.catalogue.length, 1);
});

test('only originally saved unavailable references survive retries; draft unknown references cannot become trusted', async () => {
    const retained = 'retired/saved', unknown = 'unknown/draft';
    const retainedProfile: GlobalWorkerPool = { models: [retained], revision: 7 };
    const prompt = new Prompt({ choose: ['global'], models: [[retained, unknown], [retained]], confirm: [true] });
    const fixture = adapters({ statuses: [status(null, false, 'write', retainedProfile)] });
    assert.equal((await runPreviewWizard({ cwd: '/canonical/repo', configure: true, prompt, adapters: fixture.value })).outcome, 'configured');
    assert.deepEqual(prompt.modelInitials, [[retained], [retained]]);
    assert.deepEqual(fixture.calls.configureGlobal, [{ models: [retained], expectedRevision: 7 }]);
    assert.ok(prompt.messages.some(message => message.includes(JSON.stringify(unknown)) && message.includes('not previously approved')));
});

test('explicit refresh preserves only saved or previously eligible draft choices and never mutates the pool until final confirmation', async () => {
    const transient = { ...model, id: 'transient', name: 'Transient', reference: 'fixture/transient', variantIDs: [] };
    const deepseek = { ...model, id: 'deepseek-v4.1-flash', providerID: 'opencode-go', name: 'DeepSeek V4.1 Flash', reference: 'opencode-go/deepseek-v4.1-flash', variantIDs: [] };
    const refreshed: PreviewCatalogue = { ...catalogue, models: [model, deepseek], observedAt: '2026-09-11T01:00:00.000Z', source: { management: 'naru-snapshot', digest: 'a'.repeat(64), completedAt: '2026-09-11T00:59:59.000Z', upstreamFreshness: 'unknown' } };
    const prompt = new Prompt({ choose: ['global', 'edit', 'refresh', 'check', 'edit', 'continue'], input: ['DeepSeek'], models: [['fixture/tool_worker#fast', 'fixture/transient'], ['fixture/tool_worker#fast', 'fixture/transient', deepseek.reference]], confirm: [true] });
    const fixture = adapters({ catalogues: [{ ...catalogue, models: [model, transient] }], refreshCatalogue: async () => refreshed, diagnoseCatalogue: async (_path, query) => ({ query, observedAt: refreshed.observedAt, accountAccess: 'unknown', matches: [{ reference: deepseek.reference, name: deepseek.name, eligibility: 'eligible' }] }) });
    const result = await runPreviewWizard({ cwd: '/canonical/repo', configure: true, prompt, adapters: fixture.value });
    assert.equal(result.outcome, 'configured');
    assert.deepEqual(prompt.modelInitials, [[globalProfile.models[0]!], ['fixture/tool_worker#fast', 'fixture/transient']]);
    assert.deepEqual(fixture.calls.configureGlobal, [{ models: ['fixture/tool_worker#fast', 'fixture/transient', deepseek.reference], expectedRevision: 2 }]);
    assert.ok(prompt.messages.some(message => /Unavailable now: fixture\/transient/.test(message)));
    assert.ok(prompt.messages.some(message => message.includes(deepseek.reference) && message.includes('eligible')));
});

test('refresh makes saved fast family variants eligible without rewriting or persisting the saved pool', async () => {
    const savedReferences = ['openai/gpt-5.6-sol-fast#max', 'openai/gpt-5.6-luna-fast#high', 'openai/gpt-5.6-terra-fast#medium'];
    const savedProfile: GlobalWorkerPool = { models: savedReferences, revision: 9 };
    const familyModels = ['sol', 'luna', 'terra'].map(family => ({
        ...model,
        id: `gpt-5.6-${family}-fast`,
        providerID: 'openai',
        name: `GPT-5.6 ${family} Fast`,
        reference: `openai/gpt-5.6-${family}-fast`,
        variantIDs: ['none', 'low', 'medium', 'high', 'xhigh', 'max'],
    }));
    const refreshed: PreviewCatalogue = { ...catalogue, models: familyModels };
    const prompt = new Prompt({ choose: ['global', 'refresh', 'edit', 'continue'], models: [savedReferences], confirm: [false] });
    const fixture = adapters({
        statuses: [status(null, false, 'write', savedProfile)],
        refreshCatalogue: async () => refreshed,
        diagnoseCatalogue: async (_path, query) => ({ query, observedAt: refreshed.observedAt, accountAccess: 'unknown', matches: [] }),
    });
    assert.equal((await runPreviewWizard({ cwd: '/canonical/repo', configure: true, prompt, adapters: fixture.value })).outcome, 'cancelled');
    assert.deepEqual(prompt.modelInitials, [savedReferences]);
    assert.deepEqual(prompt.modelOptions, [familyModels.map(value => value.reference)]);
    assert.deepEqual(fixture.calls.configureGlobal, []);
    assert.deepEqual(savedProfile, { models: savedReferences, revision: 9 });
});

test('refresh failure and cancellation preserve the nonempty draft with zero pool mutations', async () => {
    const prompt = new Prompt({ choose: ['global', 'refresh', 'cancel'] });
    const fixture = adapters({ refreshCatalogue: async () => { throw new Error('Synthetic refresh failed'); }, diagnoseCatalogue: async (_path, query) => ({ query, observedAt: catalogue.observedAt, accountAccess: 'unknown', matches: [] }) });
    const result = await runPreviewWizard({ cwd: '/canonical/repo', configure: true, prompt, adapters: fixture.value });
    assert.equal(result.outcome, 'cancelled'); assert.deepEqual(fixture.calls.configureGlobal, []); assert.deepEqual(fixture.calls.enroll, []);
    assert.ok(prompt.messages.some(message => /Synthetic refresh failed/.test(message)));
});

test('cancelling a retried draft does not persist it and preserves the authentication warning', async () => {
    const largeCatalogue = catalogueOfSize(33), all = largeCatalogue.models.map(value => value.reference);
    const prompt = new Prompt({ choose: ['global', 'login'], models: [all, new WizardCancelled()] });
    const fixture = adapters({ catalogues: [{ ...catalogue, models: [] }, largeCatalogue] });
    const result = await runPreviewWizard({ cwd: '/canonical/repo', configure: true, prompt, adapters: fixture.value });
    assert.deepEqual(result, { outcome: 'cancelled', authenticationMayHaveChanged: true });
    assert.deepEqual(prompt.modelInitials, [globalProfile.models, all]);
    assert.equal(fixture.calls.authenticate, 1); assert.deepEqual(fixture.calls.configureGlobal, []); assert.deepEqual(fixture.calls.enroll, []);
});

test('terminal prompt treats EOF and Ctrl-C as cancellation and keeps input boundaries intact', async () => {
    const stream = () => {
        const input = new PassThrough() as PassThrough & { isTTY: boolean; isRaw: boolean; setRawMode(value: boolean): void };
        input.isTTY = true; input.isRaw = false; input.setRawMode = value => { input.isRaw = value; };
        const output = new PassThrough() as PassThrough & { isTTY: boolean; columns: number }; output.isTTY = true; output.columns = 80;
        return { input, output, prompt: new TerminalWizardPrompt(input, output) };
    };
    const eof = stream(), eofAnswer = eof.prompt.input('Path: '); eof.input.end(); await assert.rejects(eofAnswer, WizardCancelled);
    const interrupt = stream(), interrupted = interrupt.prompt.input('Path: '); interrupt.input.emit('keypress', '\u0003', { name: 'c', ctrl: true, sequence: '\u0003' });
    await assert.rejects(Promise.race([interrupted, new Promise((_, reject) => setTimeout(() => reject(new Error('Ctrl-C did not cancel')), 500))]), WizardCancelled);
    const answer = stream(), bounded = answer.prompt.input('Path: '); answer.input.write('  /tmp/repo with spaces  \r'); assert.equal(await bounded, '/tmp/repo with spaces');
});

test('workspace paths are escaped for terminal confirmation without changing adapter identity', async () => {
    const path = '/repo\ntrusted\u001b[2J\u202Espoof';
    const unsafeStatus: PreviewSetupStatus = { ...status(), repository: { path, kind: 'git', dirty: false, enrollment: null, effectiveWorkerPool: null } };
    const prompt = new Prompt({ choose: ['inspect'], confirm: [false] }); const fixture = adapters({ statuses: [unsafeStatus] });
    const result = await runPreviewWizard({ cwd: path, configure: false, prompt, adapters: fixture.value });
    assert.equal(result.outcome, 'cancelled'); assert.deepEqual(fixture.calls.catalogue, []); assert.deepEqual(fixture.calls.enroll, []);
    const confirmation = prompt.messages.find(message => message.startsWith('Workspace:'))!;
    assert.equal(confirmation.includes('\ntrusted'), false); assert.equal(confirmation.includes('\u001b'), false); assert.equal(confirmation.includes('\u202e'), false);
    assert.match(confirmation, /\\u\{000a\}/); assert.match(confirmation, /\\u\{001b\}/); assert.match(confirmation, /\\u\{202e\}/);
    assert.equal(renderPromptValue(path).includes(path), false);
});

async function runPtyHarness(source: string, keys: string[], startMarker = 'Worker models'): Promise<{ output: string; result: Record<string, unknown> }> {
    const cwd = await mkdtemp(join(tmpdir(), 'naru-wizard-pty-'));
    try {
        const driver = `import errno,fcntl,json,os,pty,select,signal,struct,sys,termios,time
node,source,keys,marker=sys.argv[1],sys.argv[2],json.loads(sys.argv[3]),sys.argv[4].encode(); pid,fd=pty.fork()
if pid == 0:
 env=os.environ.copy(); env['NO_COLOR']='1'; os.execve(node,[node,'--input-type=module','--eval',source],env)
fcntl.ioctl(fd,termios.TIOCSWINSZ,struct.pack('HHHH',24,80,0,0))
output=b''; index=0; next_key=0.0; deadline=time.time()+6; status=None; resized=False
while time.time() < deadline:
 ready,_,_=select.select([fd],[],[],0.02)
 if ready:
  try: output += os.read(fd,65536)
  except OSError as error:
   if error.errno != errno.EIO: raise
 if marker in output and not resized:
  fcntl.ioctl(fd,termios.TIOCSWINSZ,struct.pack('HHHH',18,60,0,0)); os.kill(pid,signal.SIGWINCH); resized=True
 if marker in output and index < len(keys) and time.time() >= next_key:
  os.write(fd,keys[index].encode()); index += 1; next_key=time.time()+0.12
 done,status=os.waitpid(pid,os.WNOHANG)
 if done: break
else:
 os.kill(pid,signal.SIGKILL); os.waitpid(pid,0); sys.stdout.buffer.write(output); print('PTY timeout',file=sys.stderr); sys.exit(124)
sys.stdout.buffer.write(output); sys.exit(os.waitstatus_to_exitcode(status))`;
        const child = spawn('/usr/bin/python3', ['-c', driver, process.execPath, source, JSON.stringify(keys), startMarker], {
            cwd, env: { ...process.env, NO_COLOR: '1' }, stdio: ['pipe', 'pipe', 'pipe'],
        });
        let output = '', stderr = ''; child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
        child.stdout.on('data', chunk => { output += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
        const code = await new Promise<number | null>((resolvePromise, reject) => {
            const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`PTY prompt did not exit: ${output}${stderr}`)); }, 8_000);
            child.once('error', error => { clearTimeout(timer); reject(error); });
            child.once('exit', value => { clearTimeout(timer); resolvePromise(value); });
        });
        assert.equal(code, 0, output + stderr);
        const match = output.match(/NARU_RESULT:(\{[^\r\n]+\})/u); assert.ok(match, output);
        return { output, result: JSON.parse(match[1]!) };
    } finally { await rm(cwd, { recursive: true, force: true }); }
}

test('native Clack configure saves a global pool and access setup for one new and two old repositories has no model-source menu', { skip: !supportsPty }, async () => {
    const module = pathToFileURL(join(built, 'tools', 'naru-lib', 'preview-wizard.mjs')).href;
    const source = `import { TerminalWizardPrompt, runPreviewWizard } from ${JSON.stringify(module)};
const model={id:'worker',providerID:'fixture',name:'Worker',reference:'fixture/worker',capabilities:{tools:true,input:['text'],output:['text']},variantIDs:[]};
let globalProfile=null,catalogues=0,enrollments=0;const prompt=new TerminalWizardPrompt();
const adapters={status:async path=>({installation:{version:'test',isolated:true,hostCapabilities:{inspect:true,check:true,write:true}},globalProfile,repository:path==='/outside'?null:{path,kind:'git',dirty:false,enrollment:path.includes('old')?{path,kind:'git',access:'inspect',writeScopes:[],revision:4}:null,effectiveWorkerPool:null},blockers:path==='/outside'?['not git']:[],maximumAccess:'write'}),authenticate:async()=>{},catalogue:async()=>{catalogues++;return {models:[model],providers:[],observedAt:'synthetic',metadataFreshness:'unknown',accountAccess:'unknown'}},configureGlobal:async value=>(globalProfile={models:value.models,revision:1}),enroll:async value=>{enrollments++;return {path:value.path,kind:value.kind,access:value.access,writeScopes:value.writeScopes,revision:1}},open:async()=>{}};
const configured=await runPreviewWizard({cwd:'/outside',configure:true,prompt,adapters});const outcomes=[(await runPreviewWizard({cwd:'/repo-new',configure:false,prompt,adapters})).outcome];for(const path of ['/repo-old-a','/repo-old-b'])outcomes.push((await runPreviewWizard({cwd:path,configure:true,prompt,adapters})).outcome);
console.log('NARU_RESULT:'+JSON.stringify({configured:configured.outcome,outcomes,catalogues,enrollments,raw:process.stdin.isRaw}));`;
    const newRepositoryKeys = ['\r', '\u001b[A', '\r'];
    const oldRepositoryKeys = ['\u001b[B', '\u001b[B', '\r', '\r', '\u001b[A', '\r'];
    const keys = ['\r', '\t', '\r', '\u001b[A', '\r', ...newRepositoryKeys, ...oldRepositoryKeys, ...oldRepositoryKeys];
    const { output, result } = await runPtyHarness(source, keys, 'What would you like to configure?');
    assert.deepEqual(result, { configured: 'configured', outcomes: ['launched', 'launched', 'launched'], catalogues: 1, enrollments: 3, raw: false });
    assert.match(output, /Global worker models/); assert.match(output, /This workspace’s access/); assert.doesNotMatch(output, /model source/i); assert.doesNotMatch(output, /(?:^|\s)\d+[.)]\s/m);
});

test('native Clack model picker filters live, preserves hidden selections, toggles multiple workers, and restores the terminal', { skip: !supportsPty }, async () => {
    const isolated = await mkdtemp(join(tmpdir(), 'naru-wizard-installed-'));
    try {
        await cp(join(built, 'tools'), join(isolated, 'tools'), { recursive: true });
        await assert.rejects(lstat(join(isolated, 'node_modules')), { code: 'ENOENT' });
        const module = pathToFileURL(join(isolated, 'tools', 'naru-lib', 'preview-wizard.mjs')).href;
        const models = [
            { id: 'alpha', providerID: 'fixture', name: 'Alpha Worker', reference: 'fixture/alpha', variantIDs: [] },
            { id: 'beta', providerID: 'second', name: 'Beta Worker', reference: 'second/beta', variantIDs: [] },
            { id: 'gamma', providerID: 'third', name: 'Gamma Worker', reference: 'third/gamma', variantIDs: ['deep'] },
        ];
        const source = `import { TerminalWizardPrompt } from ${JSON.stringify(module)};
const before = process.stdin.listenerCount('keypress');
const value = await new TerminalWizardPrompt().selectModels(${JSON.stringify(models)}, ['fixture/alpha', 'retired/worker']);
console.log('NARU_RESULT:' + JSON.stringify({ value, raw: process.stdin.isRaw, listeners: process.stdin.listenerCount('keypress') - before }));`;
        const { output, result } = await runPtyHarness(source, ['no-match', '\u0015', 'beta', '\u001b[B', ' ', '\u0015', 'gamma', '\u001b[B', '\u001b[A', ' ', '\u0015', '\r']);
        assert.deepEqual(result.value, ['fixture/alpha', 'retired/worker', 'second/beta', 'third/gamma']);
        assert.equal(result.raw, false); assert.equal(result.listeners, 0);
        assert.match(output, /Type:.*search/s); assert.match(output, /No matches found/); assert.match(output, /unavailable \(saved; retain or remove\)/); assert.match(output, /4 items selected/); assert.ok(output.includes('\u001b[?25h'));
    } finally { await rm(isolated, { recursive: true, force: true }); }
});

test('native Clack refresh is available before selection, warns when a saved draft disappears, and cancel makes no pool mutation', { skip: !supportsPty }, async () => {
    const module = pathToFileURL(join(built, 'tools', 'naru-lib', 'preview-wizard.mjs')).href;
    const source = `import { TerminalWizardPrompt, runPreviewWizard } from ${JSON.stringify(module)};
const oldModel={id:'worker',providerID:'fixture',name:'Worker',reference:'fixture/worker',capabilities:{tools:true,input:['text'],output:['text']},variantIDs:[]};let refreshes=0,saves=0;
const catalogue=models=>({models,providers:[],observedAt:'synthetic',metadataFreshness:'unknown',accountAccess:'unknown',source:{management:'host-managed-unverified',upstreamFreshness:'unknown'}});
const result=await runPreviewWizard({cwd:'/fixture',configure:true,prompt:new TerminalWizardPrompt(),adapters:{
status:async()=>({installation:{version:'test',isolated:true,hostCapabilities:{inspect:true,check:true,write:true}},globalProfile:{models:['fixture/worker'],revision:2},globalInstructions:{revision:0,sourcePath:null,loadStatus:'disabled'},repository:null,blockers:[],maximumAccess:'write'}),
catalogue:async()=>catalogue([oldModel]),refreshCatalogue:async()=>{refreshes++;return catalogue([])},diagnoseCatalogue:async(_p,q,c)=>({query:q,observedAt:c.observedAt,accountAccess:'unknown',matches:[]}),authenticate:async()=>{},configureGlobal:async value=>{saves++;return {models:value.models,revision:3}},prepareGlobalInstructions:async()=>{},configureGlobalInstructions:async()=>{},disableGlobalInstructions:async()=>{},enroll:async()=>{},open:async()=>{}
}});console.log('NARU_RESULT:'+JSON.stringify({outcome:result.outcome,refreshes,saves,raw:process.stdin.isRaw}));`;
    const { output, result } = await runPtyHarness(source, ['\r', '\u001b[B', '\r', '\u001b'], 'What would you like to configure?');
    assert.deepEqual(result, { outcome: 'cancelled', refreshes: 1, saves: 0, raw: false });
    assert.match(output, /Refresh catalogue/); assert.match(output, /Unavailable now: fixture\/worker/);
});

test('native Clack refresh retains an edited draft, exposes new models, marks removed selections unavailable, and cancel makes no pool mutation', { skip: !supportsPty }, async () => {
    const module = pathToFileURL(join(built, 'tools', 'naru-lib', 'preview-wizard.mjs')).href;
    const source = `import { TerminalWizardPrompt, runPreviewWizard } from ${JSON.stringify(module)};
const makeModel=(id,name,reference)=>({id,providerID:reference.split('/')[0],name,reference,capabilities:{tools:true,input:['text'],output:['text']},variantIDs:[]});
const saved=makeModel('saved','Saved Worker','fixture/saved'),old=makeModel('old','Old Worker','fixture/old'),syntheticDeepSeekRef='synthetic/deepseek-v4.1-flash',deepseek=makeModel('deepseek-v4.1-flash','Synthetic DeepSeek',syntheticDeepSeekRef);
const catalogue=models=>({models,providers:[],observedAt:'synthetic',metadataFreshness:'unknown',accountAccess:'unknown',source:{management:'host-managed-unverified',upstreamFreshness:'unknown'}});
let refreshes=0,saves=0;class TrackingPrompt extends TerminalWizardPrompt{initials=[];async selectModels(models,initial){this.initials.push([...initial]);return super.selectModels(models,initial)}}const prompt=new TrackingPrompt();
const result=await runPreviewWizard({cwd:'/fixture',configure:true,prompt,adapters:{
status:async()=>({installation:{version:'test',isolated:true,hostCapabilities:{inspect:true,check:true,write:true}},globalProfile:{models:[saved.reference],revision:2},globalInstructions:{revision:0,sourcePath:null,loadStatus:'disabled'},repository:null,blockers:[],maximumAccess:'write'}),
catalogue:async()=>catalogue([saved,old]),refreshCatalogue:async()=>{refreshes++;return catalogue([saved,deepseek])},diagnoseCatalogue:async(_p,q,c)=>({query:q,observedAt:c.observedAt,accountAccess:'unknown',matches:[]}),authenticate:async()=>{},configureGlobal:async value=>{saves++;return {models:value.models,revision:3}},prepareGlobalInstructions:async()=>{},configureGlobalInstructions:async()=>{},disableGlobalInstructions:async()=>{},enroll:async()=>{},open:async()=>{}
}});console.log('NARU_RESULT:'+JSON.stringify({outcome:result.outcome,refreshes,saves,initials:prompt.initials,syntheticDeepSeekRef,raw:process.stdin.isRaw}));`;
    const keys = ['\r', '\r', '\u001b[B', ' ', '\r', '\u001b[B', '\r', '\r', '\u001b'];
    const { output, result } = await runPtyHarness(source, keys, 'What would you like to configure?');
    assert.deepEqual(result, { outcome: 'cancelled', refreshes: 1, saves: 0, initials: [['fixture/saved'], ['fixture/saved', 'fixture/old']], syntheticDeepSeekRef: 'synthetic/deepseek-v4.1-flash', raw: false });
    assert.match(output, /synthetic\/deepseek-v4\.1-flash/);
    assert.match(output, /fixture\/old · unavailable \(saved; retain or remove\)/);
});

test('native Clack reopens all 33 selected models, then accepts the same draft after one is deselected', { skip: !supportsPty }, async () => {
    const module = pathToFileURL(join(built, 'tools', 'naru-lib', 'preview-wizard.mjs')).href;
    const largeCatalogue = catalogueOfSize(33), selected = largeCatalogue.models.map(value => value.reference);
    const source = `import { TerminalWizardPrompt, runPreviewWizard } from ${JSON.stringify(module)};
const models=${JSON.stringify(largeCatalogue.models)},original=${JSON.stringify(selected)};let saved=null,catalogues=0;
class TrackingPrompt extends TerminalWizardPrompt { initials=[]; selections=[]; async selectModels(models,initial){this.initials.push([...initial]);const value=await super.selectModels(models,initial);this.selections.push([...value]);return value;} }
const prompt=new TrackingPrompt();const result=await runPreviewWizard({cwd:'/synthetic/repo',configure:true,prompt,adapters:{
status:async()=>({installation:{version:'test',isolated:true,hostCapabilities:{inspect:true,check:true,write:true}},globalProfile:{models:original,revision:4},repository:null,blockers:['not git'],maximumAccess:'write'}),
catalogue:async()=>{catalogues++;return {models,providers:[],observedAt:'synthetic',metadataFreshness:'unknown',accountAccess:'unknown'}},authenticate:async()=>{},configureGlobal:async value=>(saved={models:value.models,revision:5}),enroll:async()=>{throw new Error('unexpected enroll')},open:async()=>{throw new Error('unexpected open')}
}});console.log('NARU_RESULT:'+JSON.stringify({outcome:result.outcome,initialLengths:prompt.initials.map(value=>value.length),selectionLengths:prompt.selections.map(value=>value.length),savedCount:saved?.models.length,catalogues,raw:process.stdin.isRaw}));`;
    const { output, result } = await runPtyHarness(source, ['\r', '\r', '\t', '\r', '\u001b[A', '\r'], 'What would you like to configure?');
    assert.deepEqual(result, { outcome: 'configured', initialLengths: [33, 33], selectionLengths: [33, 32], savedCount: 32, catalogues: 1, raw: false });
    assert.match(output, /selected 33 worker references; the limit is 32\. Remove 1/);
});

test('native Clack cancellation keys leave policy untouched and restore raw mode and listeners', { skip: !supportsPty }, async () => {
    const module = pathToFileURL(join(built, 'tools', 'naru-lib', 'preview-wizard.mjs')).href;
    const wizardFixture = `const model = { id: 'worker', providerID: 'fixture', name: 'Worker', reference: 'fixture/worker', capabilities: { tools: true, input: ['text'], output: ['text'] }, variantIDs: [] };
let enrollments = 0; const before = process.stdin.listenerCount('keypress');
const result = await runPreviewWizard({ cwd: '/synthetic/repo', configure: false, prompt: new TerminalWizardPrompt(), adapters: {
status: async () => ({ installation: { version: 'test', isolated: true, hostCapabilities: { inspect: true, check: true, write: true } }, globalProfile: null, repository: { path: '/synthetic/repo', kind: 'git', dirty: false, enrollment: null, effectiveWorkerPool: null }, blockers: [], maximumAccess: 'write' }),
catalogue: async () => ({ models: [model], providers: [], observedAt: 'synthetic', metadataFreshness: 'unknown', accountAccess: 'unknown' }),
authenticate: async () => {}, configureGlobal: async value => ({ models: value.models, revision: 1 }), enroll: async value => { enrollments++; return { path: value.path, access: value.access, writeScopes: value.writeScopes, revision: 1 }; }, open: async () => {},
} }); console.log('NARU_RESULT:' + JSON.stringify({ outcome: result.outcome, enrollments, raw: process.stdin.isRaw, listeners: process.stdin.listenerCount('keypress') - before }));`;
    for (const key of ['\u001b', '\u0003', '\u0004']) {
        const source = `import { TerminalWizardPrompt, runPreviewWizard } from ${JSON.stringify(module)}; ${wizardFixture}`;
        const { result } = await runPtyHarness(source, [key]);
        assert.deepEqual(result, { outcome: 'cancelled', enrollments: 0, raw: false, listeners: 0 });
    }
});

test('native catalogue cancellation after successful auth reports that login may have changed', { skip: !supportsPty }, async () => {
    const module = pathToFileURL(join(built, 'tools', 'naru-lib', 'preview-wizard.mjs')).href;
    const source = `import { TerminalWizardPrompt, runPreviewWizard } from ${JSON.stringify(module)};
let authentications = 0, enrollments = 0;
const result = await runPreviewWizard({ cwd: '/synthetic/repo', configure: false, prompt: new TerminalWizardPrompt(), adapters: {
status: async () => ({ installation: { version: 'test', isolated: true, hostCapabilities: { inspect: true, check: true, write: true } }, globalProfile: null, repository: { path: '/synthetic/repo', kind: 'git', dirty: false, enrollment: null, effectiveWorkerPool: null }, blockers: [], maximumAccess: 'write' }),
catalogue: async () => ({ models: [], providers: [], observedAt: 'synthetic', metadataFreshness: 'unknown', accountAccess: 'unknown' }),
authenticate: async () => { authentications++; }, configureGlobal: async value => ({ models: value.models, revision: 1 }), enroll: async value => { enrollments++; return { path: value.path, access: value.access,writeScopes: value.writeScopes, revision: 1 }; }, open: async () => {},
} }); console.log('NARU_RESULT:' + JSON.stringify({ outcome: result.outcome, authenticationMayHaveChanged: result.authenticationMayHaveChanged, authentications, enrollments, raw: process.stdin.isRaw }));`;
    const { result } = await runPtyHarness(source, ['\u001b[B', '\r', '\u001b'], 'Model catalogue');
    assert.deepEqual(result, { outcome: 'cancelled', authenticationMayHaveChanged: true, authentications: 1, enrollments: 0, raw: false });
});

test('native text, arrow menu, and safe-default confirmation use the expected terminal keys', { skip: !supportsPty }, async () => {
    const module = pathToFileURL(join(built, 'tools', 'naru-lib', 'preview-wizard.mjs')).href;
    const source = `import { TerminalWizardPrompt } from ${JSON.stringify(module)};
const prompt = new TerminalWizardPrompt(); const path = await prompt.input('Repository path:');
const access = await prompt.choose('Repository access policy:', [{ value: 'inspect', label: 'Inspect only' }, { value: 'write', label: 'Scoped edits' }]);
const approved = await prompt.confirm('Save this repository policy and launch Naru?');
console.log('NARU_RESULT:' + JSON.stringify({ path, access, approved, raw: process.stdin.isRaw }));`;
    const { result } = await runPtyHarness(source, ['/tmp/repo with spaces', '\r', '\u001b[B', '\r', '\r'], 'Repository path');
    assert.deepEqual(result, { path: '/tmp/repo with spaces', access: 'write', approved: false, raw: false });
});

test('write scopes are escaped for terminal confirmation without changing policy identity', async () => {
    const scope = 'src/\u202E**';
    const prompt = new Prompt({ choose: ['write'], input: [scope], confirm: [true] }); const fixture = adapters();
    const result = await runPreviewWizard({ cwd: '/canonical/repo', configure: false, prompt, adapters: fixture.value });
    assert.equal(result.outcome, 'launched'); assert.deepEqual(fixture.calls.enroll[0], { path: '/canonical/repo', kind: 'git', access: 'write', writeScopes: [scope], expectedRevision: null, expectedGlobalRevision: 2 });
    const confirmation = prompt.messages.find(message => message.startsWith('Workspace:'))!;
    assert.equal(confirmation.includes(scope), false); assert.equal(confirmation.includes('\u202e'), false); assert.ok(confirmation.includes(`Write scopes: ${renderPromptValue(scope)}`));
});

test('directory write enrollment requires an explicit direct-write warning with no rollback claim', async () => {
    const directory = status(); directory.repository = { path: '/canonical/directory', kind: 'directory', dirty: null, enrollment: null, effectiveWorkerPool: null };
    const prompt = new Prompt({ choose: ['write'], input: ['src/**'], confirm: [false] }), fixture = adapters({ statuses: [directory] });
    assert.equal((await runPreviewWizard({ cwd: '/canonical/directory', configure: false, prompt, adapters: fixture.value })).outcome, 'cancelled');
    const confirmation = prompt.messages.find(message => message.startsWith('Workspace:'))!;
    assert.match(confirmation, /edit this directory directly.*not a multi-file transaction.*partial edits.*no rollback or integration step/is);
    assert.deepEqual(fixture.calls.enroll, []);
});
