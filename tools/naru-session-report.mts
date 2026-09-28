#!/usr/bin/env node
import { lstat, open, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { OC2_DEFAULT_SESSION_LIMIT, readOc2SessionEvidence } from './naru-lib/oc2-session-evidence.mjs';

export interface SessionReportCliOptions {
    dbPath: string;
    since?: number;
    limit: number;
    includeExcludedOrigins: boolean;
    output?: string;
}

function usage(): string {
    return 'Usage: naru-session-report --db <explicit-opencode.db> [--since <ISO-8601>] [--limit <count>] [--include-excluded] [--output <new-file.json>]';
}

export function parseSessionReportArgs(args: string[]): SessionReportCliOptions {
    let dbPath: string | undefined, since: number | undefined, output: string | undefined;
    let limit = OC2_DEFAULT_SESSION_LIMIT, includeExcludedOrigins = false;
    for (let index = 0; index < args.length; index += 1) {
        const argument = args[index]!;
        if (argument === '--include-excluded') { includeExcludedOrigins = true; continue; }
        if (argument === '--help') throw new Error(usage());
        if (!['--db', '--since', '--limit', '--output'].includes(argument)) throw new Error(`Unknown argument: ${argument}\n${usage()}`);
        const value = args[++index]; if (!value) throw new Error(`${argument} requires a value\n${usage()}`);
        if (argument === '--db') dbPath = value;
        else if (argument === '--since') {
            const parsed = Date.parse(value); if (!Number.isFinite(parsed)) throw new Error('--since must be an ISO-8601 date or timestamp'); since = parsed;
        } else if (argument === '--limit') {
            if (!/^\d+$/.test(value)) throw new Error('--limit must be a positive integer'); limit = Number(value);
        } else output = value;
    }
    if (!dbPath) throw new Error(`--db is required; the stable database is never selected implicitly\n${usage()}`);
    return { dbPath, ...(since === undefined ? {} : { since }), limit, includeExcludedOrigins, ...(output === undefined ? {} : { output }) };
}

async function writeNewArtifact(path: string, content: string): Promise<void> {
    if (!isAbsolute(path)) throw new Error('--output must be an explicit absolute path');
    const target = resolve(path), parent = dirname(target), canonicalParent = await realpath(parent);
    if (canonicalParent !== parent) throw new Error('--output parent must be a canonical directory without symlinks');
    const parentInfo = await lstat(parent); if (!parentInfo.isDirectory() || parentInfo.isSymbolicLink()) throw new Error('--output parent must be a real directory');
    const handle = await open(target, 'wx', 0o600).catch(error => {
        if (error instanceof Error && 'code' in error && error.code === 'EEXIST') throw new Error('--output already exists; refusing to overwrite it');
        throw error;
    });
    try { await handle.writeFile(content); await handle.sync(); } finally { await handle.close(); }
}

export async function runSessionReport(args: string[], stdout: Pick<NodeJS.WriteStream, 'write'> = process.stdout): Promise<void> {
    const options = parseSessionReportArgs(args);
    const report = readOc2SessionEvidence(options);
    const content = `${JSON.stringify(report, null, 2)}\n`;
    if (options.output) await writeNewArtifact(options.output, content);
    else stdout.write(content);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    runSessionReport(process.argv.slice(2)).catch(error => {
        process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
        process.exitCode = 1;
    });
}
