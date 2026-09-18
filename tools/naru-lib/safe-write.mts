import { constants } from 'node:fs';
import { link, lstat, mkdir, open, realpath, rename, rm } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { basename, isAbsolute, join, relative, sep } from 'node:path';
import { isSafeRelativePath } from './validate.mjs';

export interface DirectoryIdentity { dev: string; ino: string }
export interface AtomicWorkspaceWriteAdapters {
    beforeCommitValidation?: () => Promise<void>;
    beforeInstall?: () => Promise<void>;
    beforeParentCreate?: (path: string) => Promise<void>;
}

export function pathContains(root: string, value: string): boolean {
    const path = relative(root, value);
    return path === '' || (path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}

const protectedComponent = (value: string): string => value.normalize('NFD').toUpperCase().toLowerCase().normalize('NFD');
export function protectedPathContains(root: string, value: string): boolean {
    const rootParts = root.replaceAll('\\', '/').split('/').filter(Boolean).map(protectedComponent);
    const valueParts = value.replaceAll('\\', '/').split('/').filter(Boolean).map(protectedComponent);
    return rootParts.length <= valueParts.length && rootParts.every((part, index) => part === valueParts[index]);
}

interface ExistingFile {
    hash: string;
    mode: number;
    size: string;
    mtimeNs: string;
    ctimeNs: string;
    identity: DirectoryIdentity;
}

function identity(info: { dev: bigint; ino: bigint }): DirectoryIdentity {
    return { dev: String(info.dev), ino: String(info.ino) };
}

function sameIdentity(left: DirectoryIdentity, right: DirectoryIdentity): boolean {
    return left.dev === right.dev && left.ino === right.ino;
}

export async function directoryIdentity(path: string): Promise<DirectoryIdentity> {
    const canonical = await realpath(path), info = await lstat(path, { bigint: true });
    if (canonical !== path || info.isSymbolicLink() || !info.isDirectory()) throw new Error('Workspace root must remain the enrolled canonical directory, not a symlink');
    return identity(info);
}

export async function assertDirectoryIdentity(path: string, expected: DirectoryIdentity): Promise<void> {
    if (!sameIdentity(await directoryIdentity(path), expected)) throw new Error('Enrolled directory identity changed; review and enroll it again');
}

async function existingFile(path: string): Promise<ExistingFile | null> {
    let handle: Awaited<ReturnType<typeof open>>;
    try { handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW); }
    catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null;
        throw error;
    }
    try {
        const before = await handle.stat({ bigint: true });
        if (!before.isFile() || before.size > 256n * 1024n) throw new Error('Only bounded regular text files can be replaced');
        const bytes = await handle.readFile();
        if (bytes.includes(0)) throw new Error('Only bounded text files can be replaced');
        new TextDecoder('utf-8', { fatal: true }).decode(bytes);
        const { createHash } = await import('node:crypto');
        return {
            hash: createHash('sha256').update(bytes).digest('hex'),
            mode: Number(before.mode & 0o777n),
            size: String(before.size),
            mtimeNs: String(before.mtimeNs),
            ctimeNs: String(before.ctimeNs),
            identity: identity(before),
        };
    } catch (error) {
        if (error instanceof TypeError) throw new Error('Only bounded UTF-8 text files can be replaced');
        throw error;
    } finally { await handle.close(); }
}

async function safeParent(root: string, relative: string, expectedRoot: DirectoryIdentity, adapters: AtomicWorkspaceWriteAdapters): Promise<string> {
    let current = root;
    for (const part of relative.split('/').slice(0, -1)) {
        await assertDirectoryIdentity(root, expectedRoot);
        const parent = current, parentIdentity = identity(await lstat(parent, { bigint: true }));
        current = join(current, part);
        try {
            const info = await lstat(current);
            if (info.isSymbolicLink() || !info.isDirectory()) throw new Error('Workspace paths must not traverse symlinks or special files');
        } catch (error) {
            if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
            await adapters.beforeParentCreate?.(current);
            await assertDirectoryIdentity(root, expectedRoot);
            if (!sameIdentity(identity(await lstat(parent, { bigint: true })), parentIdentity) || await realpath(parent) !== parent || !pathContains(root, parent)) throw new Error('Workspace parent changed before directory creation');
            await mkdir(current, { mode: 0o700 });
        }
    }
    const canonical = await realpath(current);
    if (canonical !== current || !pathContains(root, current)) throw new Error('Workspace parent changed or escaped the enrolled directory');
    return current;
}

function sameFileSnapshot(left: ExistingFile, right: ExistingFile): boolean {
    return left.hash === right.hash && left.mode === right.mode && left.size === right.size
        && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs
        && sameIdentity(left.identity, right.identity);
}

export async function atomicWorkspaceWrite(root: string, expectedRoot: DirectoryIdentity, relative: string, content: string, expectedHash: string | null, adapters: AtomicWorkspaceWriteAdapters = {}): Promise<{ sha256: string }> {
    if (!isSafeRelativePath(relative) || relative.includes('\\')) throw new Error('Unsafe or secret workspace path');
    if (Buffer.byteLength(content) > 128 * 1024 || content.includes('\0')) throw new Error('Write requires bounded text content');
    await assertDirectoryIdentity(root, expectedRoot);
    const parent = await safeParent(root, relative, expectedRoot, adapters), parentIdentity = identity(await lstat(parent, { bigint: true }));
    const target = join(parent, basename(relative)), before = await existingFile(target);
    if ((before && before.hash !== expectedHash) || (!before && expectedHash !== null)) throw new Error('File changed since inspection; expectedHash must match, or be null for a new file');
    const temporary = join(parent, `.${basename(relative)}.naru-${process.pid}-${randomBytes(12).toString('hex')}.tmp`);
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
        handle = await open(temporary, 'wx', before?.mode ?? 0o600);
        await handle.writeFile(content); await handle.chmod(before?.mode ?? 0o600); await handle.sync(); await handle.close(); handle = undefined;
        await assertDirectoryIdentity(root, expectedRoot);
        if (!sameIdentity(identity(await lstat(parent, { bigint: true })), parentIdentity) || await realpath(parent) !== parent) throw new Error('Workspace parent changed before write commit');
        await adapters.beforeCommitValidation?.();
        const current = await existingFile(target);
        if (before ? !current || !sameFileSnapshot(current, before) : current !== null) throw new Error('File changed since inspection; refusing write commit');
        await adapters.beforeInstall?.();
        if (before) await rename(temporary, target);
        else {
            try { await link(temporary, target); }
            catch (error) {
                if (error instanceof Error && 'code' in error && error.code === 'EEXIST') throw new Error('File changed since inspection; refusing write commit');
                throw error;
            }
            await rm(temporary);
        }
        const parentHandle = await open(parent, constants.O_RDONLY);
        try { await parentHandle.sync(); } finally { await parentHandle.close(); }
        const { createHash } = await import('node:crypto');
        return { sha256: createHash('sha256').update(content).digest('hex') };
    } finally {
        await handle?.close().catch(() => undefined);
        await rm(temporary, { force: true }).catch(() => undefined);
    }
}
