import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, symlink, truncate, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { globalInstructionsMetadata, loadGlobalInstructions, MAX_GLOBAL_INSTRUCTIONS_BYTES, prepareGlobalInstructions, validateGlobalInstructionsSetting } from '../tools/naru-lib/global-instructions.mjs';

test('global instructions prepare and load only bounded UTF-8 Markdown under the injected home', async () => {
    const fixture = await realpath(await mkdtemp('/tmp/naru-global-instructions-'));
    const home = join(fixture, 'home'); await mkdir(join(home, '.config', 'opencode'), { recursive: true });
    const sourcePath = join(home, '.config', 'opencode', 'AGENTS.md');
    try {
        await writeFile(sourcePath, 'Synthetic preference marker.\n');
        const prepared = await prepareGlobalInstructions(sourcePath, home);
        assert.deepEqual(prepared, { sourcePath, canonicalPath: sourcePath, text: 'Synthetic preference marker.\n', sha256: 'dc266930037445ff025fa7178219e21462343a7922c11674a7ca158599ad0c23', byteLength: 29 });
        await writeFile(sourcePath, 'Synthetic preference changed.\n');
        const loaded = await loadGlobalInstructions(prepared, home);
        assert.equal(loaded.text, 'Synthetic preference changed.\n'); assert.notEqual(loaded.sha256, prepared.sha256);
        assert.deepEqual(await globalInstructionsMetadata({ revision: 0, source: null }, home), { revision: 0, sourcePath: null, loadStatus: 'disabled' });
    } finally { await rm(fixture, { recursive: true, force: true }); }
});

test('global instructions pin a canonical symlink target and never follow a later retarget', async () => {
    const fixture = await realpath(await mkdtemp('/tmp/naru-global-instructions-link-'));
    const home = join(fixture, 'home'); await mkdir(home);
    const first = join(home, 'first.md'), second = join(home, 'second.md'), selected = join(home, 'AGENTS.md');
    try {
        await writeFile(first, 'FIRST_SYNTHETIC\n'); await writeFile(second, 'SECOND_SYNTHETIC\n'); await symlink(first, selected);
        const prepared = await prepareGlobalInstructions(selected, home); assert.equal(prepared.canonicalPath, first);
        await rm(selected); await symlink(second, selected);
        const loaded = await loadGlobalInstructions(prepared, home);
        assert.equal(loaded.text, 'FIRST_SYNTHETIC\n'); assert.equal(loaded.canonicalPath, first);
        assert.notEqual((await prepareGlobalInstructions(selected, home)).canonicalPath, prepared.canonicalPath);
    } finally { await rm(fixture, { recursive: true, force: true }); }
});

test('global instructions reject denied paths, home escapes, empty and unsafe file forms without exposing content', async () => {
    const fixture = await realpath(await mkdtemp('/tmp/naru-global-instructions-denial-'));
    const home = join(fixture, 'home'); await mkdir(home); const outside = join(fixture, 'outside.md');
    const secretDirectory = join(home, '.ssh'); await mkdir(secretDirectory); const secret = join(secretDirectory, 'notes.md');
    const namedSecret = join(home, 'private-key.md');
    let socketServer: ReturnType<typeof createServer> | undefined;
    try {
        await writeFile(outside, 'OUTSIDE_PRIVATE_MARKER'); await writeFile(secret, 'SECRET_PRIVATE_MARKER'); await writeFile(namedSecret, 'KEY_PRIVATE_MARKER');
        for (const path of [outside, secret, namedSecret, join(home, '.env.md')]) await assert.rejects(prepareGlobalInstructions(path, home), /GLOBAL_INSTRUCTIONS_INVALID_PATH/);
        const escape = join(home, 'escape.md'); await symlink(outside, escape); await assert.rejects(prepareGlobalInstructions(escape, home), /GLOBAL_INSTRUCTIONS_INVALID_PATH/);
        const secretAlias = join(home, 'preferences.md'); await symlink(secret, secretAlias); await assert.rejects(prepareGlobalInstructions(secretAlias, home), /GLOBAL_INSTRUCTIONS_INVALID_PATH/);
        await assert.rejects(prepareGlobalInstructions(join(home, 'missing.md'), home), /GLOBAL_INSTRUCTIONS_MISSING/);
        const empty = join(home, 'empty.md'); await writeFile(empty, ''); await assert.rejects(prepareGlobalInstructions(empty, home), /empty.*disable/i);
        const directory = join(home, 'directory.md'); await mkdir(directory); await assert.rejects(prepareGlobalInstructions(directory, home), /NONREGULAR/);
        const socket = join(home, 'socket.md'); socketServer = createServer(); await new Promise<void>((resolvePromise, reject) => { socketServer!.once('error', reject); socketServer!.listen(socket, resolvePromise); }); await assert.rejects(prepareGlobalInstructions(socket, home), /NONREGULAR/);
        const invalid = join(home, 'invalid.md'); await writeFile(invalid, Buffer.from([0xc3, 0x28])); await assert.rejects(prepareGlobalInstructions(invalid, home), /INVALID_UTF8/);
        const nul = join(home, 'nul.md'); await writeFile(nul, Buffer.from('before\0after')); await assert.rejects(prepareGlobalInstructions(nul, home), /_NUL/);
        const unreadable = join(home, 'unreadable.md'); await writeFile(unreadable, 'synthetic'); await chmod(unreadable, 0o000); await assert.rejects(prepareGlobalInstructions(unreadable, home), /UNREADABLE/);
        assert.equal(await readFile(secret, 'utf8'), 'SECRET_PRIVATE_MARKER');
    } finally { if (socketServer) await new Promise<void>(resolvePromise => socketServer!.close(() => resolvePromise())); await rm(fixture, { recursive: true, force: true }); }
});

test('global instructions fail closed for oversized files and malformed persisted settings', async () => {
    const fixture = await realpath(await mkdtemp('/tmp/naru-global-instructions-state-'));
    const home = join(fixture, 'home'); await mkdir(home); const oversized = join(home, 'large.md'); await writeFile(oversized, 'x'); await truncate(oversized, MAX_GLOBAL_INSTRUCTIONS_BYTES + 1);
    try {
        await assert.rejects(prepareGlobalInstructions(oversized, home), /OVERSIZED/);
        assert.deepEqual(await validateGlobalInstructionsSetting({ revision: 0, source: null }, home), { revision: 0, source: null });
        for (const value of [{ revision: -1, source: null }, { revision: 1, source: { sourcePath: oversized } }, { revision: 1, source: { sourcePath: '/outside.md', canonicalPath: '/outside.md' } }, { revision: 1, source: null, extra: true }]) {
            await assert.rejects(validateGlobalInstructionsSetting(value, home), /Invalid global instructions setting/);
        }
    } finally { await rm(fixture, { recursive: true, force: true }); }
});
