#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { access } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface Oc2Targets { v2: string; preview: string }

export function oc2Dispatch(argv: string[], targets: Oc2Targets): { executable: string; argv: string[] } {
    if (!isAbsolute(targets.v2) || !isAbsolute(targets.preview)) throw new Error('oc2 targets must be absolute paths');
    if (argv[0] === 'naru') return { executable: targets.preview, argv: argv.slice(1) };
    return { executable: targets.v2, argv: [...argv] };
}

export async function runOc2(argv: string[], targets: Oc2Targets): Promise<number> {
    const dispatch = oc2Dispatch(argv, targets);
    await access(dispatch.executable, constants.X_OK);
    return new Promise((resolvePromise, reject) => {
        const child = spawn(dispatch.executable, dispatch.argv, { env: process.env, stdio: 'inherit' });
        child.once('error', reject);
        child.once('exit', (code, signal) => {
            if (signal) reject(new Error(`oc2 target terminated by ${signal}`));
            else resolvePromise(code ?? 1);
        });
    });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
    const targets = {
        v2: process.env.NARU_OC2_V2_WRAPPER ?? join(homedir(), '.local', 'bin', 'opencode2-naru'),
        preview: process.env.NARU_OC2_PREVIEW ?? join(homedir(), '.local', 'share', 'naru-preview-oc2', 'naru-preview'),
    };
    runOc2(process.argv.slice(2), targets)
        .then(code => { process.exitCode = code; })
        .catch(error => { process.stderr.write(`oc2: ${error instanceof Error ? error.message : 'failed'}\n`); process.exitCode = 1; });
}
