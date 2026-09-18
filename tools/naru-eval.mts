#!/usr/bin/env node
import { mkdir, mkdtemp, open, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildEvaluationMatrix, snapshotEvaluationCatalogue, type EvaluationCatalogueSnapshot, type EvaluationMatrix } from './naru-lib/oc2-eval-catalogue.mjs';
import { buildEvaluationReport, parseAttemptLines, readAnswerKey, type EvaluationReportPolicy } from './naru-lib/oc2-eval-report.mjs';
import { createNativeEvaluationDispatcher, readEvaluationTaskManifest, readSubscriptionAuthorization, runEvaluation } from './naru-lib/oc2-eval-runner.mjs';
import { loadOc2Host, oc2NativePaths } from './naru-lib/oc2-profile.mjs';
import { fetchPreviewCatalogue, startPreviewServer } from './naru-lib/preview-process.mjs';

type Command = 'discover' | 'matrix' | 'report' | 'run';

function usage(): string {
    return `Usage:
  naru-eval discover --output <new-absolute-catalogue.json> [--root <oc2-root>]
  naru-eval matrix --catalogue <catalogue.json> --output <new-absolute-matrix.json> [--configurations <exact-id[,exact-id]>]
  naru-eval run --matrix <matrix.json> --tasks <tasks.json> --answer-key <key.json> --authorization <subscription.json> --output <new-absolute-directory> [--max-attempts N] [--max-wall-ms N] [--max-attempt-wall-ms N] [--max-output-tokens N] [--concurrency 1..3] [--provider-concurrency 1] [--resume] [--unblock-budget <exact[,exact]>] [--root <oc2-root>]
  naru-eval report --run <absolute-run-directory> [--output <new-absolute-report.json>]`;
}

function parse(args: string[]): { command: Command; values: Map<string, string>; resume: boolean } {
    const command = args.shift() as Command;
    if (!['discover', 'matrix', 'report', 'run'].includes(command)) throw new Error(usage());
    const values = new Map<string, string>(); let resume = false;
    for (let index = 0; index < args.length; index += 1) {
        const flag = args[index]!;
        if (flag === '--resume') { if (resume) throw new Error('--resume may be supplied once'); resume = true; continue; }
        if (!flag.startsWith('--')) throw new Error(`Unexpected argument: ${flag}\n${usage()}`);
        const value = args[++index]; if (!value || value.startsWith('--')) throw new Error(`${flag} requires a value`);
        if (values.has(flag)) throw new Error(`${flag} may be supplied once`); values.set(flag, value);
    }
    return { command, values, resume };
}

function required(values: Map<string, string>, name: string): string {
    const value = values.get(name); if (!value) throw new Error(`${name} is required\n${usage()}`); return value;
}

function integer(values: Map<string, string>, name: string): number | undefined {
    const value = values.get(name); if (value === undefined) return undefined;
    if (!/^\d+$/.test(value)) throw new Error(`${name} must be a positive integer`);
    return Number(value);
}

function only(values: Map<string, string>, allowed: string[]): void {
    for (const key of values.keys()) if (!allowed.includes(key)) throw new Error(`Unknown option for this command: ${key}`);
}

async function writeNew(path: string, value: unknown): Promise<void> {
    if (!isAbsolute(path)) throw new Error('--output must be an absolute path');
    const target = resolve(path), parent = dirname(target);
    if (await realpath(parent) !== parent) throw new Error('--output parent must be a canonical existing directory');
    const handle = await open(target, 'wx', 0o600);
    try { await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`); await handle.sync(); } finally { await handle.close(); }
}

async function json<T>(path: string): Promise<T> { return JSON.parse(await readFile(path, 'utf8')) as T; }
const defaultRoot = () => process.env.NARU_OC2_ROOT ?? join(homedir(), '.local', 'share', 'naru-preview-oc2');

async function discoverCatalogue(root: string): Promise<EvaluationCatalogueSnapshot> {
    const host = await loadOc2Host(root), paths = oc2NativePaths(host.root), temporary = await realpath(await mkdtemp(join(tmpdir(), 'naru-eval-discover-')));
    const configRoot = join(temporary, 'config'), configDirectory = join(configRoot, 'opencode'), workspace = join(temporary, 'workspace');
    await mkdir(configDirectory, { recursive: true, mode: 0o700 }); await mkdir(workspace, { mode: 0o700 }); await mkdir(join(temporary, 'cache'), { mode: 0o700 }); await mkdir(join(temporary, 'state'), { mode: 0o700 });
    await writeFile(join(configDirectory, 'opencode.json'), JSON.stringify({ update: 'disable', share: 'disabled', snapshots: false, permissions: [{ action: '*', resource: '*', effect: 'deny' }] }), { mode: 0o600 });
    const environment: NodeJS.ProcessEnv = { PATH: process.env.PATH ?? '/usr/bin:/bin', LANG: 'C', HOME: temporary, TMPDIR: temporary, XDG_CONFIG_HOME: configRoot, XDG_DATA_HOME: paths.dataRoot,
        XDG_CACHE_HOME: join(temporary, 'cache'), XDG_STATE_HOME: join(temporary, 'state'), OPENCODE_DB: paths.database, OPENCODE_DISABLE_AUTOUPDATE: 'true', OPENCODE_DISABLE_PROJECT_CONFIG: 'true' };
    let server: Awaited<ReturnType<typeof startPreviewServer>> | undefined;
    try { server = await startPreviewServer(host.executable, workspace, environment, 'catalogue'); return snapshotEvaluationCatalogue(await fetchPreviewCatalogue(server.url, workspace, server.headers)); }
    finally { server?.stop(); await rm(temporary, { recursive: true, force: true }); }
}

export async function runEvaluationCli(args: string[], stdout: Pick<NodeJS.WriteStream, 'write'> = process.stdout): Promise<void> {
    const parsed = parse([...args]);
    if (parsed.command === 'discover') {
        only(parsed.values, ['--output', '--root']);
        const root = parsed.values.get('--root') ?? defaultRoot();
        await writeNew(required(parsed.values, '--output'), await discoverCatalogue(root));
        return;
    }
    if (parsed.command === 'matrix') {
        only(parsed.values, ['--catalogue', '--output', '--configurations']);
        const subset = parsed.values.get('--configurations')?.split(',').filter(Boolean) ?? [];
        if (parsed.values.has('--configurations') && !subset.length) throw new Error('--configurations requires at least one exact configuration ID');
        await writeNew(required(parsed.values, '--output'), buildEvaluationMatrix(await json<EvaluationCatalogueSnapshot>(required(parsed.values, '--catalogue')), new Date(), subset));
        return;
    }
    if (parsed.command === 'report') {
        only(parsed.values, ['--run', '--output']);
        const run = required(parsed.values, '--run'); if (!isAbsolute(run)) throw new Error('--run must be an absolute directory');
        const metadata = await json<{ schemaVersion: unknown; inputFingerprint: unknown; taskIDs: unknown; limits: unknown; protocol: unknown }>(join(run, 'run.json'));
        const limits = metadata.limits as Partial<EvaluationReportPolicy> | null;
        const protocol = metadata.protocol as Record<string, unknown> | null;
        if (metadata.schemaVersion !== 3 || !protocol || protocol.taskVersion !== 2 || protocol.scorerVersion !== 2 || protocol.sourceListingFormat !== 'numbered-lines-v1' || protocol.numericPolicy !== 'strict-json-types'
            || typeof metadata.inputFingerprint !== 'string' || !Array.isArray(metadata.taskIDs) || metadata.taskIDs.some(item => typeof item !== 'string') || !limits
            || !Number.isSafeInteger(limits.maxAttempts) || !Number.isSafeInteger(limits.maxWallMs) || !Number.isSafeInteger(limits.maxAttemptWallMs) || !Number.isSafeInteger(limits.maxOutputTokens)
            || !Number.isSafeInteger(limits.concurrency) || limits.providerConcurrency !== 1) throw new Error('Run metadata is malformed');
        const report = buildEvaluationReport(await json<EvaluationMatrix>(join(run, 'matrix.json')), parseAttemptLines(await readFile(join(run, 'attempts.ndjson'), 'utf8'), metadata.inputFingerprint), metadata.taskIDs as string[], limits as EvaluationReportPolicy);
        const output = parsed.values.get('--output'); if (output) await writeNew(output, report); else stdout.write(`${JSON.stringify(report, null, 2)}\n`);
        return;
    }
    only(parsed.values, ['--matrix', '--tasks', '--answer-key', '--authorization', '--output', '--root', '--max-attempts', '--max-wall-ms', '--max-attempt-wall-ms', '--max-output-tokens', '--concurrency', '--provider-concurrency', '--unblock-budget']);
    const maxAttempts = integer(parsed.values, '--max-attempts'), maxWallMs = integer(parsed.values, '--max-wall-ms'), maxAttemptWallMs = integer(parsed.values, '--max-attempt-wall-ms');
    const maxOutputTokens = integer(parsed.values, '--max-output-tokens'), concurrency = integer(parsed.values, '--concurrency');
    const providerConcurrency = integer(parsed.values, '--provider-concurrency'), root = parsed.values.get('--root') ?? defaultRoot();
    const result = await runEvaluation({
            matrix: await json<EvaluationMatrix>(required(parsed.values, '--matrix')),
            manifest: await readEvaluationTaskManifest(required(parsed.values, '--tasks')),
            answerKey: await readAnswerKey(required(parsed.values, '--answer-key')),
            authorization: await readSubscriptionAuthorization(required(parsed.values, '--authorization')),
            outputDirectory: required(parsed.values, '--output'), resume: parsed.resume,
            dispatcherFactory: limits => createNativeEvaluationDispatcher(root, limits.maxOutputTokens),
            ...(parsed.values.get('--unblock-budget') ? { unblockBudgets: parsed.values.get('--unblock-budget')!.split(',').filter(Boolean) } : {}),
            ...(maxAttempts === undefined ? {} : { maxAttempts }),
            ...(maxWallMs === undefined ? {} : { maxWallMs }),
            ...(maxAttemptWallMs === undefined ? {} : { maxAttemptWallMs }),
            ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }),
            ...(concurrency === undefined ? {} : { concurrency }),
            ...(providerConcurrency === undefined ? {} : { providerConcurrency }),
    });
    stdout.write(`${JSON.stringify(result)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    runEvaluationCli(process.argv.slice(2)).catch(error => { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; });
}
