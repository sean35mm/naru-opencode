#!/usr/bin/env node
import { homedir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runOc2Native, type NativeLaunchTargets } from './naru-lib/oc2-native-launch.mjs';

export interface Oc2Targets extends NativeLaunchTargets {}

export function oc2Dispatch(argv: string[], targets: Oc2Targets): { root: string; legacy?: string; argv: string[] } {
    if (!isAbsolute(targets.root) || (targets.legacy !== undefined && !isAbsolute(targets.legacy))) throw new Error('oc2 targets must be absolute paths');
    return { root: targets.root, ...(targets.legacy ? { legacy: targets.legacy } : {}), argv: [...argv] };
}

export async function runOc2(argv: string[], targets: Oc2Targets): Promise<number> {
    const dispatch = oc2Dispatch(argv, targets);
    return runOc2Native(dispatch.argv, { root: dispatch.root, ...(dispatch.legacy ? { legacy: dispatch.legacy } : {}) });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
    const legacy = process.env.NARU_OC2_LEGACY ?? process.env.NARU_OC2_PREVIEW;
    const root = process.env.NARU_OC2_ROOT ?? (legacy ? dirname(legacy) : join(homedir(), '.local', 'share', 'naru-preview-oc2'));
    const targets: Oc2Targets = {
        root,
        legacy: legacy ?? join(root, 'naru-preview'),
    };
    runOc2(process.argv.slice(2), targets)
        .then(code => { process.exitCode = code; })
        .catch(error => { process.stderr.write(`oc2: ${error instanceof Error ? error.message : 'failed'}\n`); process.exitCode = 1; });
}
