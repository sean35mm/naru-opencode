#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { access, lstat, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

interface InstallOptions { previewCli: string; opencode: string; v2Wrapper: string; root: string; bin: string; node?: string }

function quote(value: string): string { return `'${value.replaceAll("'", "'\\''")}'`; }
async function absent(path: string, label: string): Promise<void> {
    try { await lstat(path); throw new Error(`${label} already exists; refusing to overwrite it`); }
    catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error; }
}
async function runSetup(node: string, previewCli: string, root: string, opencode: string): Promise<void> {
    await new Promise<void>((resolvePromise, reject) => {
        const child = spawn(node, [previewCli, '--root', root, 'setup', '--opencode', opencode], { stdio: 'inherit' });
        child.once('error', reject);
        child.once('exit', code => code === 0 ? resolvePromise() : reject(new Error(`preview setup failed with exit ${code ?? 1}`)));
    });
}

export async function installOc2(options: InstallOptions): Promise<void> {
    const node = await realpath(options.node ?? process.execPath);
    for (const [label, value] of [['previewCli', options.previewCli], ['opencode', options.opencode], ['v2Wrapper', options.v2Wrapper], ['root', options.root], ['bin', options.bin]] as const) {
        if (!isAbsolute(value)) throw new Error(`${label} must be an absolute path`);
    }
    await absent(options.root, 'preview install root');
    await absent(options.bin, 'oc2 launcher');
    const previewCli = await realpath(options.previewCli);
    const opencode = await realpath(options.opencode);
    const v2Wrapper = await realpath(options.v2Wrapper);
    if (opencode === v2Wrapper) throw new Error('oc2 must target the isolated v2 wrapper, not the raw binary');
    const wrapperInfo = await lstat(options.v2Wrapper);
    if (wrapperInfo.isSymbolicLink() || !wrapperInfo.isFile()) throw new Error('v2 wrapper must be a regular file, not a symlink');
    await access(v2Wrapper, constants.X_OK);
    await mkdir(options.root, { mode: 0o700 });
    let installed = false;
    try {
        await runSetup(node, previewCli, options.root, opencode);
        const launcherModule = join(options.root, 'lib', 'tools', 'oc2.mjs');
        const preview = join(options.root, 'naru-preview');
        await access(launcherModule, constants.R_OK);
        await access(preview, constants.X_OK);
        const script = `#!/bin/sh\nset -eu\nexport NARU_OC2_V2_WRAPPER=${quote(v2Wrapper)}\nexport NARU_OC2_PREVIEW=${quote(preview)}\nexec ${quote(node)} ${quote(launcherModule)} "$@"\n`;
        await writeFile(options.bin, script, { flag: 'wx', mode: 0o755 });
        installed = true;
    }
    finally { if (!installed) await rm(options.root, { recursive: true, force: true }); }
}

function required(args: string[], name: string): string {
    const index = args.indexOf(name);
    if (index < 0 || !args[index + 1] || args[index + 1]!.startsWith('--')) throw new Error(`${name} requires a value`);
    return resolve(args.splice(index, 2)[1]!);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
    const args = process.argv.slice(2);
    const options = {
        previewCli: required(args, '--preview-cli'), opencode: required(args, '--opencode'),
        v2Wrapper: required(args, '--v2-wrapper'), root: required(args, '--root'), bin: required(args, '--bin'),
    };
    if (args.length) throw new Error(`unknown installer arguments: ${args.join(' ')}`);
    installOc2(options)
        .then(() => console.log(`Installed oc2 launcher at ${options.bin} with a fresh Naru preview at ${options.root}`))
        .catch(error => { process.stderr.write(`install-oc2: ${error instanceof Error ? error.message : 'failed'}\n`); process.exitCode = 1; });
}
