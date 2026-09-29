import { autocompleteMultiselect, confirm as clackConfirm, isCancel, select, text } from '@clack/prompts';
import type { Readable, Writable } from 'node:stream';
import type { HostCatalogueModel } from './host-process.mjs';
export interface WizardPrompt {
    message(value: string): void;
    input(label: string): Promise<string>;
    choose<T extends string>(label: string, choices: Array<{ value: T; label: string }>): Promise<T>;
    confirm(label: string): Promise<boolean>;
    selectModels(models: HostCatalogueModel[], initial: string[]): Promise<string[]>;
}

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
    async selectModels(models: HostCatalogueModel[], initial: string[]): Promise<string[]> {
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

function validateSelection(models: string[], catalogueModels: HostCatalogueModel[], trustedUnavailable: Iterable<string>): void {
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

export async function selectValidModels(prompt: WizardPrompt, catalogueModels: HostCatalogueModel[], retained: string[], trustedUnavailable: Iterable<string> = retained): Promise<string[]> {
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
