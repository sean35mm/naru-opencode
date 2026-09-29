import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { realpath, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export const PROCESS_TIMEOUT_MS = 30_000;
const MAX_OUTPUT_BYTES = 64 * 1024;
const TERMINATION_GRACE_MS = 1_000;

export interface BoundedProcessResult {
    durationMs: number;
    output: string;
    stdout: string;
    status: 'passed' | 'failed';
    reason: string | null;
}

export interface BoundedProcessOptions {
    cwd: string;
    env: NodeJS.ProcessEnv;
    maxOutputBytes?: number;
    retainOutput?: boolean;
    timeoutMs?: number;
}

function validateTimeout(value: unknown): number {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 50 || value > 30_000) {
        throw new Error('timeout must be from 50 to 30000 milliseconds');
    }
    return value;
}

function validateOutputLimit(value: unknown): number {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < MAX_OUTPUT_BYTES || value > 1024 * 1024) {
        throw new Error(`output limit must be from ${MAX_OUTPUT_BYTES} to ${1024 * 1024} bytes`);
    }
    return value;
}

function waitForExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
    if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
    return new Promise(resolvePromise => {
        const timer = setTimeout(() => {
            child.removeListener('exit', onExit);
            resolvePromise(false);
        }, timeoutMs);
        function onExit() {
            clearTimeout(timer);
            resolvePromise(true);
        }
        child.once('exit', onExit);
    });
}

export function signalProcessGroup(child: ChildProcess, signal: NodeJS.Signals): void {
    try {
        if (child.pid === undefined) return;
        process.kill(-child.pid, signal);
    }
    catch {
        try { child.kill(signal); } catch { /* The process already exited. */ }
    }
}

export async function stopProcessGroup(child: ChildProcess): Promise<void> {
    signalProcessGroup(child, 'SIGTERM');
    if (await waitForExit(child, TERMINATION_GRACE_MS)) return;
    signalProcessGroup(child, 'SIGKILL');
    await waitForExit(child, 250);
}

export async function runBoundedProcess(executable: string, args: readonly string[], {
    cwd, env, maxOutputBytes = MAX_OUTPUT_BYTES, retainOutput = true, timeoutMs = PROCESS_TIMEOUT_MS,
}: BoundedProcessOptions): Promise<BoundedProcessResult> {
    validateTimeout(timeoutMs);
    validateOutputLimit(maxOutputBytes);
    const started = Date.now();
    let output = Buffer.alloc(0);
    let stdout = Buffer.alloc(0);
    let outputBytes = 0;
    let overflow = false;
    let spawnError = false;
    const child = spawn(executable, args, { cwd, detached: true, env, stdio: ['ignore', 'pipe', 'pipe'] });
    const append = (chunk: Buffer) => {
        if (overflow) return;
        outputBytes += chunk.length;
        if (retainOutput) output = Buffer.concat([output, chunk]).subarray(0, maxOutputBytes);
        if (outputBytes > maxOutputBytes) {
            overflow = true;
            signalProcessGroup(child, 'SIGTERM');
        }
    };
    child.stdout.on('data', (chunk: Buffer) => {
        if (retainOutput && !overflow) stdout = Buffer.concat([stdout, chunk]).subarray(0, maxOutputBytes);
        append(chunk);
    });
    child.stderr.on('data', append);
    const exited = new Promise<boolean>(resolvePromise => {
        child.once('error', () => { spawnError = true; resolvePromise(false); });
        child.once('close', code => resolvePromise(code === 0));
    });
    let timedOut = false;
    let timer: NodeJS.Timeout | undefined;
    const successful = await Promise.race([
        exited,
        new Promise<boolean>(resolvePromise => {
            timer = setTimeout(() => { timedOut = true; resolvePromise(false); }, timeoutMs);
        }),
    ]);
    if (timer) clearTimeout(timer);
    if (timedOut || overflow || spawnError) await stopProcessGroup(child);
    return {
        durationMs: Date.now() - started,
        output: output.toString('utf8'),
        stdout: stdout.toString('utf8'),
        status: successful && !timedOut && !overflow && !spawnError ? 'passed' : 'failed',
        reason: timedOut ? 'timeout' : overflow ? 'output-limit' : spawnError ? 'spawn-failed' : successful ? null : 'nonzero-exit',
    };
}

export async function guardedRemoveDisposableRoot(root: string): Promise<void> {
    const temporaryRoot = await realpath(os.tmpdir());
    const resolved = await realpath(root);
    if (!resolved.startsWith(`${temporaryRoot}${path.sep}`) || !path.basename(resolved).startsWith('naru-')) throw new Error('disposable root escaped the canonical temporary directory');
    await rm(resolved, { recursive: true, force: true });
}
