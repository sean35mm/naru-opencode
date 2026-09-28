import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';

export const MAX_GLOBAL_INSTRUCTIONS_BYTES = 64 * 1024;

export interface GlobalInstructionsSource { sourcePath: string; canonicalPath: string }
export interface GlobalInstructionsSetting { revision: number; source: GlobalInstructionsSource | null }
export interface GlobalInstructionsSnapshot extends GlobalInstructionsSource { text: string; sha256: string; byteLength: number }
export type GlobalInstructionsLoadStatus = 'disabled' | 'loaded' | 'missing' | 'unreadable' | 'nonregular' | 'oversized' | 'invalid-utf8' | 'nul' | 'invalid-path';
export interface GlobalInstructionsMetadata {
    revision: number;
    sourcePath: string | null;
    canonicalPath?: string;
    sha256?: string;
    byteLength?: number;
    loadStatus: GlobalInstructionsLoadStatus;
}

export class GlobalInstructionsError extends Error {
    constructor(readonly code: Exclude<GlobalInstructionsLoadStatus, 'disabled' | 'loaded'>, message: string) { super(`GLOBAL_INSTRUCTIONS_${code.toUpperCase().replace('-', '_')}: ${message}`); }
}

const unsafeDisplayCodePoint = /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]/gu;
const displayPath = (path: string) => JSON.stringify(path).replace(unsafeDisplayCodePoint, character => `\\u{${character.codePointAt(0)!.toString(16).padStart(4, '0')}}`);
const markdown = (path: string) => /\.(?:md|markdown)$/iu.test(path);
const sensitiveSegment = /(?:^|[._-])(?:credentials?|creds?|keys?|secrets?|tokens?|passwords?|id_(?:rsa|dsa|ecdsa|ed25519)|\.env|\.ssh|\.aws|\.kube|\.gnupg|\.npmrc|\.pypirc)(?:[._-]|$)|\.(?:pem|key|p12|pfx|keystore)$/iu;

function pathInside(home: string, path: string): boolean {
    const child = relative(home, path);
    return child === '' || (child !== '..' && !child.startsWith(`..${sep}`) && !isAbsolute(child));
}

function validatePathShape(path: unknown, name: string): string {
    if (typeof path !== 'string' || !path || path.length > 4096 || path.includes('\0') || /[\u0001-\u001f\u007f-\u009f]/u.test(path) || !isAbsolute(path)) {
        throw new GlobalInstructionsError('invalid-path', `${name} must be a bounded absolute path`);
    }
    const normalized = resolve(path);
    if (!markdown(normalized)) throw new GlobalInstructionsError('invalid-path', `${displayPath(normalized)} is not a Markdown file`);
    if (normalized.split(sep).some(segment => sensitiveSegment.test(segment))) throw new GlobalInstructionsError('invalid-path', `${displayPath(normalized)} is in a denied secret or key-material path`);
    return normalized;
}

async function trustedHome(home: string): Promise<string> {
    if (typeof home !== 'string' || !home || home.length > 4096 || home.includes('\0') || /[\u0001-\u001f\u007f-\u009f]/u.test(home) || !isAbsolute(home)) {
        throw new GlobalInstructionsError('invalid-path', 'trusted home must be a bounded absolute path');
    }
    const canonical = await realpath(resolve(home));
    const info = await lstat(canonical);
    if (!info.isDirectory()) throw new GlobalInstructionsError('invalid-path', 'trusted home is not a directory');
    return canonical;
}

async function assertWithinHome(path: string, home: string, name: string): Promise<void> {
    if (!pathInside(home, path)) throw new GlobalInstructionsError('invalid-path', `${name} ${displayPath(path)} is outside the trusted user home`);
}

function mapOpenError(error: unknown, path: string): never {
    const code = error instanceof Error && 'code' in error ? String(error.code) : '';
    if (code === 'ENOENT') throw new GlobalInstructionsError('missing', `approved file ${displayPath(path)} is missing`);
    if (code === 'EACCES' || code === 'EPERM') throw new GlobalInstructionsError('unreadable', `approved file ${displayPath(path)} is not readable`);
    if (code === 'ELOOP') throw new GlobalInstructionsError('nonregular', `approved file ${displayPath(path)} must not be a symlink at open time`);
    throw new GlobalInstructionsError('unreadable', `approved file ${displayPath(path)} could not be read`);
}

async function readCanonicalFile(path: string): Promise<Omit<GlobalInstructionsSnapshot, 'sourcePath' | 'canonicalPath'>> {
    let before;
    try { before = await lstat(path); } catch (error) { mapOpenError(error, path); }
    if (!before.isFile() || before.isSymbolicLink()) throw new GlobalInstructionsError('nonregular', `approved file ${displayPath(path)} is not a regular file`);
    if ((before.mode & 0o444) === 0) throw new GlobalInstructionsError('unreadable', `approved file ${displayPath(path)} is not readable`);
    if (before.size > MAX_GLOBAL_INSTRUCTIONS_BYTES) throw new GlobalInstructionsError('oversized', `approved file ${displayPath(path)} exceeds ${MAX_GLOBAL_INSTRUCTIONS_BYTES} bytes`);
    let handle;
    try { handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0)); }
    catch (error) { mapOpenError(error, path); }
    try {
        const info = await handle.stat();
        if (!info.isFile()) throw new GlobalInstructionsError('nonregular', `approved file ${displayPath(path)} is not a regular file`);
        if (info.size > MAX_GLOBAL_INSTRUCTIONS_BYTES) throw new GlobalInstructionsError('oversized', `approved file ${displayPath(path)} exceeds ${MAX_GLOBAL_INSTRUCTIONS_BYTES} bytes`);
        const bytes = Buffer.alloc(MAX_GLOBAL_INSTRUCTIONS_BYTES + 1);
        let offset = 0;
        while (offset < bytes.length) {
            const result = await handle.read(bytes, offset, bytes.length - offset, offset);
            if (!result.bytesRead) break;
            offset += result.bytesRead;
        }
        const content = bytes.subarray(0, offset);
        if (content.length > MAX_GLOBAL_INSTRUCTIONS_BYTES) throw new GlobalInstructionsError('oversized', `approved file ${displayPath(path)} exceeds ${MAX_GLOBAL_INSTRUCTIONS_BYTES} bytes`);
        if (content.includes(0)) throw new GlobalInstructionsError('nul', `approved file ${displayPath(path)} contains NUL bytes`);
        let text: string;
        try { text = new TextDecoder('utf-8', { fatal: true }).decode(content); }
        catch { throw new GlobalInstructionsError('invalid-utf8', `approved file ${displayPath(path)} is not valid UTF-8`); }
        if (!text.length) throw new GlobalInstructionsError('invalid-path', `approved file ${displayPath(path)} is empty; disable the reference instead`);
        return { text, sha256: createHash('sha256').update(content).digest('hex'), byteLength: content.length };
    } finally { await handle.close(); }
}

export async function prepareGlobalInstructions(sourcePath: string, home: string): Promise<GlobalInstructionsSnapshot> {
    const canonicalHome = await trustedHome(home);
    const selected = validatePathShape(sourcePath, 'global instructions source');
    await assertWithinHome(selected, canonicalHome, 'selected path');
    let selectedInfo;
    try { selectedInfo = await lstat(selected); } catch (error) { mapOpenError(error, selected); }
    if (!selectedInfo.isFile() && !selectedInfo.isSymbolicLink()) throw new GlobalInstructionsError('nonregular', `selected path ${displayPath(selected)} is not a regular file or file symlink`);
    let canonical: string;
    try { canonical = validatePathShape(await realpath(selected), 'canonical global instructions target'); }
    catch (error) {
        if (error instanceof GlobalInstructionsError) throw error;
        mapOpenError(error, selected);
    }
    await assertWithinHome(canonical, canonicalHome, 'canonical target');
    return { sourcePath: selected, canonicalPath: canonical, ...await readCanonicalFile(canonical) };
}

export async function loadGlobalInstructions(source: GlobalInstructionsSource, home: string): Promise<GlobalInstructionsSnapshot> {
    const canonicalHome = await trustedHome(home);
    const sourcePath = validatePathShape(source.sourcePath, 'stored source path');
    const canonicalPath = validatePathShape(source.canonicalPath, 'stored canonical target');
    await assertWithinHome(sourcePath, canonicalHome, 'stored source path');
    await assertWithinHome(canonicalPath, canonicalHome, 'stored canonical target');
    return { sourcePath, canonicalPath, ...await readCanonicalFile(canonicalPath) };
}

export async function validateGlobalInstructionsSetting(value: unknown, home: string): Promise<GlobalInstructionsSetting> {
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value)?.constructor !== Object) throw new Error('Invalid global instructions setting');
    const record = value as Record<string, unknown>;
    if (Object.keys(record).some(key => key !== 'revision' && key !== 'source') || !Number.isSafeInteger(record.revision) || (record.revision as number) < 0) throw new Error('Invalid global instructions setting');
    if (record.source === null) return { revision: record.revision as number, source: null };
    if (!record.source || typeof record.source !== 'object' || Array.isArray(record.source) || Object.getPrototypeOf(record.source)?.constructor !== Object) throw new Error('Invalid global instructions setting');
    const source = record.source as Record<string, unknown>;
    if (Object.keys(source).some(key => key !== 'sourcePath' && key !== 'canonicalPath')) throw new Error('Invalid global instructions setting');
    const canonicalHome = await trustedHome(home);
    try {
        const sourcePath = validatePathShape(source.sourcePath, 'stored source path');
        const canonicalPath = validatePathShape(source.canonicalPath, 'stored canonical target');
        await assertWithinHome(sourcePath, canonicalHome, 'stored source path');
        await assertWithinHome(canonicalPath, canonicalHome, 'stored canonical target');
        return { revision: record.revision as number, source: { sourcePath, canonicalPath } };
    } catch { throw new Error('Invalid global instructions setting'); }
}

export async function globalInstructionsMetadata(setting: GlobalInstructionsSetting, home: string): Promise<GlobalInstructionsMetadata> {
    if (!setting.source) return { revision: setting.revision, sourcePath: null, loadStatus: 'disabled' };
    try {
        const snapshot = await loadGlobalInstructions(setting.source, home);
        const { text: _text, ...metadata } = snapshot;
        return { revision: setting.revision, ...metadata, loadStatus: 'loaded' };
    } catch (error) {
        const loadStatus = error instanceof GlobalInstructionsError ? error.code : 'unreadable';
        return { revision: setting.revision, ...setting.source, loadStatus };
    }
}
