import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export type PreviewUpdatePhase = 'preparing' | 'pre-switch' | 'switching' | 'complete';
export interface PreviewUpdatePhaseRecord {
    schemaVersion: 1;
    phase: PreviewUpdatePhase;
    recoveryPath: string | null;
    backupPaths: Record<string, string> | null;
    validatedBackups: boolean;
}
export interface PreviewUpdateGuard { token: string; release: () => Promise<void>; setPhase: (record: Omit<PreviewUpdatePhaseRecord, 'schemaVersion'>) => Promise<void> }

async function writePhase(root: string, token: string, record: Omit<PreviewUpdatePhaseRecord, 'schemaVersion'>): Promise<void> {
    await assertPreviewUpdateGuard(root, token);
    const directory = join(root, 'start.lock'), temporary = join(directory, `phase.${process.pid}.${randomBytes(6).toString('hex')}.tmp`);
    await writeFile(temporary, JSON.stringify({ schemaVersion: 1, ...record }) + '\n', { mode: 0o600, flag: 'wx' });
    await rename(temporary, join(directory, 'phase.json'));
}

export async function acquirePreviewUpdateGuard(root: string): Promise<PreviewUpdateGuard> {
    const directory = join(root, 'start.lock');
    try { await mkdir(directory, { mode: 0o700 }); }
    catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'EEXIST') throw new Error('Preview startup or update is already in progress; inspect start.lock before recovery');
        throw error;
    }
    const token = randomBytes(24).toString('hex');
    try { await writeFile(join(directory, 'owner.json'), JSON.stringify({ pid: process.pid, token }) + '\n', { mode: 0o600, flag: 'wx' }); }
    catch (error) { await rm(directory, { recursive: true, force: true }); throw error; }
    await writePhase(root, token, { phase: 'preparing', recoveryPath: null, backupPaths: null, validatedBackups: false });
    let released = false;
    return {
        token,
        setPhase: record => writePhase(root, token, record),
        release: async () => { if (released) return; released = true; await assertPreviewUpdateGuard(root, token); await rm(directory, { recursive: true }); },
    };
}

export async function assertPreviewUpdateGuard(root: string, token: string): Promise<void> {
    let value: unknown;
    try { value = JSON.parse(await readFile(join(root, 'start.lock', 'owner.json'), 'utf8')); }
    catch { throw new Error('Preview update guard is missing or invalid'); }
    if (value === null || typeof value !== 'object' || Array.isArray(value) || (value as { token?: unknown }).token !== token) throw new Error('Preview update guard ownership changed');
}
