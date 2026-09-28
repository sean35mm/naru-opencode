#!/usr/bin/env node
import { isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultNativeConfigRoot, installNative, nativeModels, validateNativeExecutable, verifyNativeHostVersion } from './naru-lib/native-install.mjs';
import { fetchPreviewCatalogue, startPreviewServer } from './naru-lib/preview-process.mjs';
import { selectValidModels, TerminalWizardPrompt, WizardCancelled } from './naru-lib/preview-wizard.mjs';
import { parseCatalogueReference } from './naru-lib/native-reader-projection.mjs';

export async function runNative(argv: string[], sourceRoot: string): Promise<void> {
    let root = defaultNativeConfigRoot(), apply = false, preview = false, executable = 'opencode';
    const args: string[] = [];
    for (let i = 0; i < argv.length; i++) {
        if (argv[i] === '--dir') {
            if (!argv[i + 1] || argv[i + 1]!.startsWith('-')) throw new Error('--dir requires a directory');
            root = resolve(argv[++i]!);
        } else if (argv[i] === '--opencode') {
            const value = argv[++i];
            if (!value || !isAbsolute(value)) throw new Error('--opencode requires an absolute executable path');
            executable = value;
        } else if (argv[i] === '--apply') apply = true;
        else if (argv[i] === '--preview') preview = true;
        else args.push(argv[i]!);
    }
    if (apply && preview) throw new Error('--preview and --apply cannot be combined');
    await validateNativeExecutable(executable);
    const command = args.shift() ?? 'install';
    const catalogueEnv = root === defaultNativeConfigRoot() ? process.env : { ...process.env, OPENCODE_CONFIG_DIR: root };
    if (command === 'install') {
        if (args.length) throw new Error(`Unsupported native install option: ${args[0]}`);
        process.stdout.write(await installNative(root, sourceRoot, apply, undefined, {}, executable) + '\n');
    } else if (command === 'models' || command === 'configure') {
        if (command === 'models' && args.length === 1 && args[0] === '--list') {
            const models = await nativeModels(root);
            process.stdout.write(models.length ? models.join('\n') + '\n' : 'No native workers selected. Run naru configure or naru models --set REF[,REF].\n');
            return;
        }
        let selected: string[];
        const existing = await nativeModels(root);
        await verifyNativeHostVersion(executable);
        if (command === 'models' && args.length === 2 && args[0] === '--set') {
            selected = args[1]!.split(',').map(value => value.trim());
            if (!selected.length || selected.some(value => !value)) throw new Error('models --set requires exact comma-separated references');
            for (const model of selected) parseCatalogueReference(model);
            const server = await startPreviewServer(executable, process.cwd(), catalogueEnv, 'catalogue');
            try {
                const catalogue = await fetchPreviewCatalogue(server.url, process.cwd(), server.headers);
                const offered = new Set(catalogue.models.flatMap(model => [model.reference, ...model.variantIDs.map(variant => `${model.reference}#${variant}`)]));
                if (selected.some(model => !offered.has(model)) || new Set(selected).size !== selected.length) throw new Error('Worker references must be distinct exact references offered by the normal OpenCode catalogue');
            } finally { server.stop(); }
        } else if (!args.length && process.stdin.isTTY && process.stdout.isTTY) {
            const server = await startPreviewServer(executable, process.cwd(), catalogueEnv, 'catalogue');
            try {
                const catalogue = await fetchPreviewCatalogue(server.url, process.cwd(), server.headers);
                const prompt = new TerminalWizardPrompt();
                selected = await selectValidModels(prompt, catalogue.models, existing);
                if (!await prompt.confirm('Save these native worker models?')) throw new WizardCancelled();
            } finally { server.stop(); }
        } else throw new Error('Use naru configure in a terminal, or naru models --set REF[,REF] / --list');
        if (!apply) { process.stdout.write(`Native worker pool preview: ${selected.join(', ')}\nPreview only; rerun with --apply.\n`); return; }
        process.stdout.write(`Saved native workers: ${(await nativeModels(root, selected, existing, executable)).join(', ')}\nRestart OpenCode to load changes.\n`);
    } else throw new Error(`Unknown native command: ${command}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
    const sourceRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
    runNative(process.argv.slice(2), sourceRoot).catch(error => {
        process.stderr.write(`naru: ${error instanceof Error ? error.message : String(error)}\n`);
        process.exitCode = 1;
    });
}
