import { autocompleteMultiselect, confirm as clackConfirm, isCancel, select, text } from '@clack/prompts';
import type { Readable, Writable } from 'node:stream';
import type { PreviewAccess, Enrollment, EnrollmentKind, GlobalWorkerPool } from './preview-broker.mjs';
import type { GlobalInstructionsMetadata, GlobalInstructionsSource } from './global-instructions.mjs';
import type { PreviewCatalogue, PreviewCatalogueModel } from './preview-process.mjs';
import { isSafeScope } from './validate.mjs';

export interface PreviewSetupStatus {
    installation: { version: string; isolated: boolean; hostCapabilities: { inspect: boolean; check: boolean; write: boolean } };
    globalProfile: GlobalWorkerPool | null;
    globalInstructions: GlobalInstructionsMetadata;
    modelSource?: { management: 'host-managed-unverified' | 'naru-snapshot'; digest?: string; bytes?: number; requestedAt?: string; completedAt?: string; outcome?: 'downloaded' | 'unchanged'; upstreamFreshness: 'unknown'; accountAccess: 'unknown' };
    repository: { path: string; kind: EnrollmentKind; dirty: boolean | null; enrollment: Enrollment | null; effectiveWorkerPool: { models: string[]; revision: number } | null } | null;
    blockers: string[];
    maximumAccess: PreviewAccess;
}
export interface WizardPrompt {
    message(value: string): void;
    input(label: string): Promise<string>;
    choose<T extends string>(label: string, choices: Array<{ value: T; label: string }>): Promise<T>;
    confirm(label: string): Promise<boolean>;
    selectModels(models: PreviewCatalogueModel[], initial: string[]): Promise<string[]>;
}
export interface PreviewWizardAdapters {
    status(path: string): Promise<PreviewSetupStatus>;
    authenticate(): Promise<void>;
    catalogue(path: string): Promise<PreviewCatalogue>;
    refreshCatalogue?(path: string): Promise<PreviewCatalogue>;
    diagnoseCatalogue?(path: string, query: string, current?: PreviewCatalogue): Promise<{ query: string; observedAt: string; accountAccess: 'unknown'; matches: Array<{ reference: string; name: string; eligibility: string; reason?: string; sourcePresence?: string; variantAvailability?: string }> }>;
    configureGlobal(input: { models: string[]; expectedRevision: number | null }): Promise<GlobalWorkerPool>;
    prepareGlobalInstructions(input: { sourcePath: string }): Promise<GlobalInstructionsSource & { sha256: string; byteLength: number }>;
    configureGlobalInstructions(input: GlobalInstructionsSource & { sha256: string; byteLength: number; expectedRevision: number }): Promise<GlobalInstructionsMetadata>;
    disableGlobalInstructions(input: { expectedRevision: number }): Promise<GlobalInstructionsMetadata>;
    enroll(input: { path: string; kind: EnrollmentKind; access: PreviewAccess; writeScopes: string[]; expectedRevision: number | null; expectedGlobalRevision: number }): Promise<Enrollment>;
    open(path: string): Promise<void>;
}
export interface PreviewWizardOptions { cwd: string; configure: boolean; prompt: WizardPrompt; adapters: PreviewWizardAdapters; defaultGlobalInstructionsPath?: string }
export type PreviewWizardResult = { outcome: 'cancelled' | 'launched' | 'configured'; repository?: string; authenticationMayHaveChanged?: boolean; globalWorkerPoolSaved?: boolean; globalInstructionsSaved?: boolean };

export class WizardCancelled extends Error { constructor(readonly authenticationMayHaveChanged = false) { super('Naru setup cancelled'); } }
const maximumWorkerReferences = 32;
const allVariants = (reference: string): string => `\u0000all-variants:${reference}`;
const unsafePromptCodePoint = /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]/u;
export function renderPromptValue(value: string): string {
    return [...value].map(character => unsafePromptCodePoint.test(character) ? `\\u{${character.codePointAt(0)!.toString(16).padStart(4, '0')}}` : character).join('');
}
function renderPromptMessage(value: string): string { return value.split('\n').map(renderPromptValue).join('\n'); }

export class TerminalWizardPrompt implements WizardPrompt {
    constructor(private inputStream: Readable = process.stdin, private outputStream: Writable = process.stdout) {}
    message(value: string) { const safe = renderPromptMessage(value); this.outputStream.write(safe.endsWith('\n') ? safe : safe + '\n'); }
    private async prompt<T>(run: (signal: AbortSignal) => Promise<T | symbol>): Promise<T> {
        const controller = new AbortController();
        const input = this.inputStream as Readable & { isRaw?: boolean; setRawMode?: (mode: boolean) => void };
        const wasRaw = input.isRaw;
        const cancel = () => controller.abort();
        const cancelOnEof = (value: string, key?: { ctrl?: boolean; name?: string; sequence?: string }) => { if (value === '\u0004' || key?.sequence === '\u0004' || (key?.ctrl && key.name === 'd')) cancel(); };
        input.once('end', cancel); input.once('close', cancel);
        input.on('keypress', cancelOnEof);
        if (input.readableEnded || input.destroyed) controller.abort();
        try {
            const value = await run(controller.signal);
            if (isCancel(value)) throw new WizardCancelled();
            return value as T;
        } finally {
            input.off('end', cancel); input.off('close', cancel);
            input.off('keypress', cancelOnEof);
            if (typeof wasRaw === 'boolean' && input.setRawMode) input.setRawMode(wasRaw);
            this.outputStream.write('\u001b[?25h');
        }
    }
    async input(label: string): Promise<string> {
        const value = await this.prompt<string>(signal => text({ message: renderPromptValue(label.replace(/:\s*$/u, '')), input: this.inputStream, output: this.outputStream, signal }));
        return value.trim();
    }
    async choose<T extends string>(label: string, choices: Array<{ value: T; label: string }>): Promise<T> {
        if (!choices.length) throw new Error('No choices are available');
        const value = await this.prompt<string>(signal => select<string>({
            message: renderPromptValue(label), options: choices.map(choice => ({ value: choice.value, label: renderPromptValue(choice.label) })),
            initialValue: choices[0]!.value, maxItems: this.visibleRows(), input: this.inputStream, output: this.outputStream, signal,
        }));
        return value as T;
    }
    async confirm(label: string): Promise<boolean> {
        return this.prompt<boolean>(signal => clackConfirm({
            message: renderPromptValue(label), active: label.includes('worker models') ? 'Yes, save global pool' : label.includes('Disable global instructions') ? 'Yes, disable reference' : label.includes('global instructions') ? 'Yes, save reference' : 'Yes, save and launch', inactive: 'No, cancel', initialValue: false, vertical: true,
            input: this.inputStream, output: this.outputStream, signal,
        }));
    }
    async selectModels(models: PreviewCatalogueModel[], initial: string[]): Promise<string[]> {
        const options = models.flatMap(model => [{ reference: model.reference, label: `${renderPromptValue(model.name)} · ${renderPromptValue(model.reference)}`, search: `${model.name} ${model.providerID} ${model.id} ${model.reference}` },
            ...(model.variantIDs.length ? [{ reference: allVariants(model.reference), label: `${renderPromptValue(model.name)} / all ${model.variantIDs.length} advertised variants · ${renderPromptValue(model.reference)}`, search: `${model.name} ${model.providerID} ${model.id} ${model.reference} all variants` }] : []),
            ...model.variantIDs.map(id => ({ reference: `${model.reference}#${id}`, label: `${renderPromptValue(model.name)} / ${renderPromptValue(id)} · ${renderPromptValue(model.reference)}#${renderPromptValue(id)}`, search: `${model.name} ${model.providerID} ${model.id} ${model.reference} ${id}` }))]);
        const available = new Set(options.map(option => option.reference));
        for (const reference of initial) if (!available.has(reference)) options.push({ reference, label: `${renderPromptValue(reference)} · unavailable (saved; retain or remove)`, search: `${reference} unavailable saved retain remove` });
        return this.prompt<string[]>(signal => autocompleteMultiselect({
            message: 'Worker models — Choose 1–32 exact references after expansion; base models and variants are separate — the top-level model stays user-selected in OpenCode',
            options: options.map(option => ({ value: option.reference, label: option.label })),
            initialValues: initial, required: true, maxItems: this.visibleRows(),
            placeholder: 'Type a name, provider, model ID, or variant',
            filter: (search, option) => options.find(candidate => candidate.reference === option.value)!.search.toLocaleLowerCase().includes(search.toLocaleLowerCase()),
            input: this.inputStream, output: this.outputStream, signal,
        }));
    }
    private visibleRows(): number { const rows = 'rows' in this.outputStream && typeof this.outputStream.rows === 'number' ? this.outputStream.rows : 20; return Math.max(1, Math.min(10, rows - 8)); }
}

async function repositoryStatus(path: string, prompt: WizardPrompt, adapters: PreviewWizardAdapters): Promise<PreviewSetupStatus> {
    let candidate = path;
    while (true) {
        const status = await adapters.status(candidate);
        if (status.repository) return status;
        prompt.message(status.blockers.join('\n'));
        const choice = await prompt.choose('Choose a workspace directory.', [{ value: 'path', label: 'Enter another path' }, { value: 'cancel', label: 'Cancel' }]);
        if (choice === 'cancel') throw new WizardCancelled();
        candidate = await prompt.input('Workspace path: ');
        if (!candidate) throw new WizardCancelled();
    }
}

async function catalogue(path: string, prompt: WizardPrompt, adapters: PreviewWizardAdapters): Promise<{ value: PreviewCatalogue; authenticationMayHaveChanged: boolean }> {
    let authenticationMayHaveChanged = false;
    try {
        while (true) {
            try {
                const value = await adapters.catalogue(path);
                if (value.models.length) return { value, authenticationMayHaveChanged };
                prompt.message('No eligible tool-capable text models were found. Catalogue freshness and account access are unknown.');
            } catch (error) {
                if (error instanceof WizardCancelled) throw error;
                prompt.message(error instanceof Error ? error.message : 'Model catalogue failed');
            }
            const action = await prompt.choose('Model catalogue is unavailable or empty.', [
                { value: 'retry', label: 'Retry catalogue' },
                { value: 'login', label: 'Open the isolated host login (credentials may persist even if setup is later cancelled)' },
                { value: 'cancel', label: 'Cancel' },
            ]);
            if (action === 'cancel') throw new WizardCancelled();
            if (action === 'login') {
                authenticationMayHaveChanged = true;
                await adapters.authenticate();
            }
        }
    } catch (error) {
        if (error instanceof WizardCancelled) throw new WizardCancelled(authenticationMayHaveChanged || error.authenticationMayHaveChanged);
        throw error;
    }
}

function validateSelection(models: string[], catalogueModels: PreviewCatalogueModel[], trustedUnavailable: Iterable<string>): void {
    const eligible = new Set(catalogueModels.flatMap(model => [model.reference, ...model.variantIDs.map(id => `${model.reference}#${id}`)]));
    const allowedUnavailable = new Set([...trustedUnavailable].filter(reference => !eligible.has(reference)));
    if (!models.length) throw new Error('Choose at least one worker reference.');
    if (models.length > maximumWorkerReferences) throw new Error(`You selected ${models.length} worker references; the limit is ${maximumWorkerReferences}. Remove ${models.length - maximumWorkerReferences} and try again.`);
    const seen = new Set<string>();
    const duplicates = [...new Set(models.filter(model => { if (seen.has(model)) return true; seen.add(model); return false; }))];
    if (duplicates.length) throw new Error(`Duplicate worker references: ${duplicates.map(model => JSON.stringify(renderPromptValue(model))).join(', ')}. Remove duplicate selections and try again.`);
    const unavailable = models.filter(model => !eligible.has(model) && !allowedUnavailable.has(model));
    if (unavailable.length) throw new Error(`Worker references not offered by this catalogue and not previously approved as unavailable: ${unavailable.map(model => JSON.stringify(renderPromptValue(model))).join(', ')}.`);
}

export async function selectValidModels(prompt: WizardPrompt, catalogueModels: PreviewCatalogueModel[], retained: string[], trustedUnavailable: Iterable<string> = retained): Promise<string[]> {
    const eligible = new Set(catalogueModels.flatMap(model => [model.reference, ...model.variantIDs.map(id => `${model.reference}#${id}`)]));
    const trusted = new Set(trustedUnavailable), groups = new Map(catalogueModels.filter(model => model.variantIDs.length).map(model => [allVariants(model.reference), model.variantIDs.map(id => `${model.reference}#${id}`)]));
    const allowed = new Set([...eligible, ...groups.keys(), ...[...trusted].filter(reference => !eligible.has(reference))]);
    let initial = retained.filter((reference, index) => allowed.has(reference) && retained.indexOf(reference) === index);
    while (true) {
        const models = await prompt.selectModels(catalogueModels, initial);
        try {
            const seen = new Set<string>();
            const duplicates = [...new Set(models.filter(model => { if (seen.has(model)) return true; seen.add(model); return false; }))];
            if (duplicates.length) throw new Error(`Duplicate worker references: ${duplicates.map(model => JSON.stringify(renderPromptValue(model))).join(', ')}. Remove duplicate selections and try again.`);
            const expanded = [...new Set(models.flatMap(reference => groups.get(reference) ?? [reference]))];
            validateSelection(expanded, catalogueModels, trusted);
            return expanded;
        } catch (error) {
            prompt.message(error instanceof Error ? error.message : 'Model selection is invalid.');
            initial = models.filter((reference, index) => allowed.has(reference) && models.indexOf(reference) === index);
        }
    }
}

async function editGlobalPool(path: string, initialStatus: PreviewSetupStatus, prompt: WizardPrompt, adapters: PreviewWizardAdapters): Promise<{ pool: GlobalWorkerPool; authenticationMayHaveChanged: boolean }> {
    let status = initialStatus, authenticationMayHaveChanged = false;
    while (true) {
        if (adapters.refreshCatalogue && adapters.diagnoseCatalogue) {
            const originallySaved = new Set(status.globalProfile?.models ?? []), selectedWhileEligible = new Set<string>();
            let draft = [...originallySaved], current: PreviewCatalogue;
            try { current = await adapters.catalogue(path); }
            catch (error) { prompt.message(error instanceof Error ? error.message : 'Model catalogue failed'); current = { models: [], providers: [], observedAt: new Date().toISOString(), metadataFreshness: 'unknown', accountAccess: 'unknown', source: { management: 'host-managed-unverified', upstreamFreshness: 'unknown' } }; }
            while (true) {
                const eligible = new Set(current.models.flatMap(model => [model.reference, ...model.variantIDs.map(id => `${model.reference}#${id}`)]));
                const trusted = new Set([...originallySaved, ...selectedWhileEligible]);
                const choices: Array<{ value: 'edit' | 'refresh' | 'check' | 'continue' | 'login' | 'cancel'; label: string }> = [];
                if (current.models.length) choices.push({ value: 'edit', label: draft.length ? 'Choose or edit models' : 'Choose models' });
                choices.push({ value: 'refresh', label: 'Refresh catalogue from the official public feed' }, { value: 'check', label: 'Check model availability by exact reference or name' });
                if (draft.length) choices.push({ value: 'continue', label: 'Continue and review this draft' });
                choices.push({ value: 'login', label: 'Open the isolated host login (credentials may persist even if setup is later cancelled)' }, { value: 'cancel', label: 'Cancel' });
                const sourceLabel = current.source?.management === 'naru-snapshot' ? 'Naru immutable managed snapshot' : 'host-managed source; freshness and generation unverified; this session is not switched automatically';
                const action = await prompt.choose(`Model catalogue observed ${current.observedAt}. Source: ${sourceLabel}; upstream freshness: unknown; account access: unknown.`, choices);
                if (action === 'cancel') throw new WizardCancelled(authenticationMayHaveChanged);
                if (action === 'login') { authenticationMayHaveChanged = true; await adapters.authenticate(); current = await adapters.catalogue(path); continue; }
                if (action === 'refresh') {
                    try {
                        current = await adapters.refreshCatalogue(path);
                        const refreshedEligible = new Set(current.models.flatMap(model => [model.reference, ...model.variantIDs.map(id => `${model.reference}#${id}`)]));
                        const unavailable = draft.filter(reference => !refreshedEligible.has(reference));
                        prompt.message(`Catalogue refresh completed. Host observed ${current.observedAt}; upstream freshness and account access remain unknown.${unavailable.length ? `\nUnavailable now: ${unavailable.map(renderPromptValue).join(', ')}. Previously approved choices remain checked until removed.` : ''}`);
                    } catch (error) { prompt.message(error instanceof Error ? error.message : 'Catalogue refresh failed; the previous source and draft remain in use.'); }
                    continue;
                }
                if (action === 'check') {
                    const query = await prompt.input('Exact model reference or name: ');
                    if (!query) { prompt.message('Enter a model reference or name.'); continue; }
                    const diagnostic = await adapters.diagnoseCatalogue(path, query, current);
                    prompt.message(diagnostic.matches.length ? diagnostic.matches.map(match => `${renderPromptValue(match.reference)} · ${renderPromptValue(match.name)} · ${match.eligibility}${match.reason ? ` (${match.reason})` : ''}${match.sourcePresence ? ` (${match.sourcePresence})` : ''}`).join('\n') : `No matching entry was observed in the host catalogue. Upstream freshness and account access remain unknown.`);
                    continue;
                }
                if (action === 'edit') {
                    draft = await selectValidModels(prompt, current.models, draft, trusted);
                    for (const reference of draft) if (eligible.has(reference)) selectedWhileEligible.add(reference);
                    continue;
                }
                try { validateSelection(draft, current.models, trusted); }
                catch (error) { prompt.message(error instanceof Error ? error.message : 'Model selection is invalid.'); continue; }
                const initial = status.globalProfile?.models ?? [], added = draft.filter(model => !initial.includes(model));
                const unavailable = draft.filter(reference => !eligible.has(reference));
                prompt.message(`Global worker models: ${draft.map(renderPromptValue).join(', ')}${added.length ? `\nAdded models: ${added.map(renderPromptValue).join(', ')}` : ''}${unavailable.length ? `\nUnavailable now: ${unavailable.map(renderPromptValue).join(', ')}` : ''}\nApplies to new sessions only; existing sessions keep their frozen worker pool and model source.`);
                if (!await prompt.confirm('Save these global worker models?')) throw new WizardCancelled(authenticationMayHaveChanged);
                try { return { pool: await adapters.configureGlobal({ models: draft, expectedRevision: status.globalProfile?.revision ?? null }), authenticationMayHaveChanged }; }
                catch (error) {
                    if (!(error instanceof Error) || !/Global worker models changed since setup status/.test(error.message)) throw error;
                    prompt.message(error.message); status = await adapters.status(path); prompt.message('The current global pool has been reloaded. Review it and confirm again.'); break;
                }
            }
            continue;
        }
        const catalogueResult = await catalogue(path, prompt, adapters); authenticationMayHaveChanged ||= catalogueResult.authenticationMayHaveChanged;
        prompt.message(`Catalogue observed ${catalogueResult.value.observedAt}; metadata freshness: unknown; account access: unknown. Listed models are not proof of account access.`);
        const initial = status.globalProfile?.models ?? [];
        let models: string[];
        try { models = await selectValidModels(prompt, catalogueResult.value.models, initial); }
        catch (error) { if (error instanceof WizardCancelled) throw new WizardCancelled(authenticationMayHaveChanged || error.authenticationMayHaveChanged); throw error; }
        const added = models.filter(model => !initial.includes(model));
        prompt.message(`Global worker models: ${models.map(renderPromptValue).join(', ')}${added.length ? `\nAdded models: ${added.map(renderPromptValue).join(', ')}` : ''}\nApplies to new sessions only; existing sessions keep their frozen worker pool.`);
        if (!await prompt.confirm('Save these global worker models?')) throw new WizardCancelled(authenticationMayHaveChanged);
        try {
            return { pool: await adapters.configureGlobal({ models, expectedRevision: status.globalProfile?.revision ?? null }), authenticationMayHaveChanged };
        } catch (error) {
            if (!(error instanceof Error) || !/Global worker models changed since setup status/.test(error.message)) throw error;
            prompt.message(error.message); status = await adapters.status(path);
            prompt.message('The current global pool has been reloaded. Review it and confirm again.');
        }
    }
}

function instructionsSummary(value: GlobalInstructionsMetadata): string {
    if (!value.sourcePath) return `Global instructions: disabled\nRevision: ${value.revision}`;
    return [`Global instructions source: ${renderPromptValue(value.sourcePath)}`,
        value.canonicalPath && value.canonicalPath !== value.sourcePath ? `Canonical target: ${renderPromptValue(value.canonicalPath)}` : '',
        `Load status: ${value.loadStatus}`,
        value.sha256 ? `SHA-256: ${value.sha256}` : '',
        value.byteLength !== undefined ? `Bytes: ${value.byteLength}` : '',
        `Revision: ${value.revision}`].filter(Boolean).join('\n');
}

async function editGlobalInstructions(path: string, initialStatus: PreviewSetupStatus, prompt: WizardPrompt, adapters: PreviewWizardAdapters, defaultPath?: string): Promise<void> {
    let status = initialStatus;
    while (true) {
        prompt.message(instructionsSummary(status.globalInstructions));
        const action = await prompt.choose('Global instructions are referenced read-only. Choose an action.', [
            { value: 'reference', label: 'Reference existing file' },
            { value: 'disable', label: 'Disable reference' },
            { value: 'cancel', label: 'Cancel' },
        ]);
        if (action === 'cancel') throw new WizardCancelled();
        if (action === 'disable') {
            if (!await prompt.confirm('Disable global instructions reference?')) throw new WizardCancelled();
            try { await adapters.disableGlobalInstructions({ expectedRevision: status.globalInstructions.revision }); return; }
            catch (error) {
                if (!(error instanceof Error) || !/Global instructions changed since setup status/.test(error.message)) throw error;
                prompt.message(error.message); status = await adapters.status(path); prompt.message('The current global instructions setting has been reloaded. Review it and confirm again.'); continue;
            }
        }
        const suggestion = status.globalInstructions.sourcePath ?? defaultPath;
        const entered = await prompt.input(`Existing Markdown path${suggestion ? ` (press Enter for ${renderPromptValue(suggestion)})` : ''}: `);
        const sourcePath = entered || suggestion;
        if (!sourcePath) { prompt.message('Enter an absolute Markdown path.'); continue; }
        let prepared: Awaited<ReturnType<PreviewWizardAdapters['prepareGlobalInstructions']>>;
        try { prepared = await adapters.prepareGlobalInstructions({ sourcePath }); }
        catch (error) { prompt.message(error instanceof Error ? error.message : 'Global instructions source could not be prepared.'); continue; }
        prompt.message([`Source: ${renderPromptValue(prepared.sourcePath)}`,
            prepared.canonicalPath !== prepared.sourcePath ? `Canonical target: ${renderPromptValue(prepared.canonicalPath)}` : '',
            `Load status: loaded`, `SHA-256: ${prepared.sha256}`, `Bytes: ${prepared.byteLength}`,
            'Only advisory instruction text is referenced. Tools, permissions, providers, models, and repository configuration are not imported.',
            'The approved target is pinned; edits to that target are read for each new Naru session.'].filter(Boolean).join('\n'));
        if (!await prompt.confirm('Save this global instructions reference?')) throw new WizardCancelled();
        try { await adapters.configureGlobalInstructions({ ...prepared, expectedRevision: status.globalInstructions.revision }); return; }
        catch (error) {
            if (!(error instanceof Error) || !/Global instructions (?:changed since setup status|source changed after preview)/.test(error.message)) throw error;
            prompt.message(error.message); status = await adapters.status(path); prompt.message('The current setting or canonical target has changed. Review it and confirm again.');
        }
    }
}

export async function runPreviewWizard(options: PreviewWizardOptions): Promise<PreviewWizardResult> {
    const { prompt, adapters } = options; let authenticationMayHaveChanged = false, globalWorkerPoolSaved = false;
    try {
        let status = await adapters.status(options.cwd);
        if (!options.configure && status.repository?.enrollment && status.globalProfile) {
            await adapters.open(status.repository.path);
            return { outcome: 'launched', repository: status.repository.path };
        }
        if (options.configure) {
            const section = await prompt.choose('What would you like to configure?', [
                { value: 'global', label: 'Global worker models' },
                { value: 'instructions', label: 'Global instructions' },
                { value: 'repository', label: 'This workspace’s access' },
            ]);
            if (section === 'global') {
                const result = await editGlobalPool(options.cwd, status, prompt, adapters);
                return { outcome: 'configured', authenticationMayHaveChanged: result.authenticationMayHaveChanged, globalWorkerPoolSaved: true };
            }
            if (section === 'instructions') {
                await editGlobalInstructions(options.cwd, status, prompt, adapters, options.defaultGlobalInstructionsPath);
                return { outcome: 'configured', globalInstructionsSaved: true };
            }
        }
        if (!status.globalProfile) {
            prompt.message('Global worker models are required for every repository. Configure them once; the top-level model remains selected by you in OpenCode.');
            const result = await editGlobalPool(options.cwd, status, prompt, adapters);
            authenticationMayHaveChanged ||= result.authenticationMayHaveChanged; globalWorkerPoolSaved = true;
            status = await adapters.status(options.cwd);
        }
        if (!status.repository) status = await repositoryStatus(options.cwd, prompt, adapters);
        let repository = status.repository!;
        while (true) {
            const models = [...status.globalProfile!.models];
            const accessChoices: Array<{ value: PreviewAccess; label: string }> = [{ value: 'inspect', label: 'Inspect only (read files)' }];
            if (status.maximumAccess !== 'inspect') accessChoices.push({ value: 'check', label: 'Inspect and run isolated checks' });
            if (status.maximumAccess === 'write' && (repository.kind === 'directory' || !repository.dirty)) accessChoices.push({ value: 'write', label: repository.kind === 'directory' ? 'Scoped direct edits, plus isolated checks (no rollback)' : 'Scoped edits in isolated worktrees, plus checks' });
            const existingAccess = repository.enrollment?.access;
            if (existingAccess) accessChoices.sort((left, right) => Number(right.value === existingAccess) - Number(left.value === existingAccess));
            if (repository.kind === 'git' && repository.dirty) prompt.message('This repository is dirty. Existing work is untouched; this setup cannot enable writers.');
            const access = await prompt.choose('Workspace access policy:', accessChoices);
            const writeScopes = access === 'write' ? (await prompt.input('Comma-separated write scopes: ')).split(',').map(value => value.trim()).filter(Boolean) : [];
            if (access === 'write' && (!writeScopes.length || writeScopes.length > 128 || writeScopes.some(scope => !isSafeScope(scope)))) throw new Error('Scoped edit access requires at least one valid write scope');
            prompt.message(`Workspace: ${renderPromptValue(repository.path)}\nKind: ${repository.kind}\nGlobal worker models: ${models.map(renderPromptValue).join(', ')}\nAccess: ${access}${writeScopes.length ? `\nWrite scopes: ${writeScopes.map(renderPromptValue).join(', ')}` : ''}${access === 'write' && repository.kind === 'directory' ? '\nWARNING: managed writers edit this directory directly. Each file replacement is atomic, but the task is not a multi-file transaction and failed, cancelled, or interrupted work may leave partial edits. There is no rollback or integration step.' : ''}\nGlobal model changes apply after reopening; existing sessions keep their frozen pool.`);
            if (!await prompt.confirm('Save this workspace policy and launch Naru?')) throw new WizardCancelled();
            try {
                await adapters.enroll({ path: repository.path, kind: repository.kind, access, writeScopes, expectedRevision: repository.enrollment?.revision ?? null, expectedGlobalRevision: status.globalProfile!.revision });
                while (true) {
                    try { await adapters.open(repository.path); return { outcome: 'launched', repository: repository.path, authenticationMayHaveChanged, ...(globalWorkerPoolSaved ? { globalWorkerPoolSaved } : {}) }; }
                    catch (error) {
                        prompt.message(`Policy was saved, but Naru did not launch: ${error instanceof Error ? error.message : 'launch failed'}`);
                        const retry = await prompt.choose('Launch failed.', [{ value: 'retry', label: 'Retry launch' }, { value: 'cancel', label: 'Exit with the saved policy' }]);
                        if (retry === 'cancel') return { outcome: 'configured', repository: repository.path, authenticationMayHaveChanged, ...(globalWorkerPoolSaved ? { globalWorkerPoolSaved } : {}) };
                    }
                }
            } catch (error) {
                if (!(error instanceof Error) || !/(Enrollment|Global worker models) changed since setup status/.test(error.message)) throw error;
                prompt.message(error.message);
                status = await repositoryStatus(repository.path, prompt, adapters); repository = status.repository!;
                prompt.message('The current policy has been reloaded. Review it and confirm again.');
            }
        }
    } catch (error) {
        if (error instanceof WizardCancelled) return { outcome: 'cancelled', authenticationMayHaveChanged: authenticationMayHaveChanged || error.authenticationMayHaveChanged, ...(globalWorkerPoolSaved ? { globalWorkerPoolSaved } : {}) };
        throw error;
    }
}
