import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { installOc2 } from '../tools/install-oc2.mjs';
import { oc2Dispatch } from '../tools/oc2.mjs';

const built = join(dirname(fileURLToPath(import.meta.url)), '..');

test('oc2 routes bare arguments to isolated v2 and naru arguments to the guarded preview', () => {
    const targets = { v2: '/private/v2 wrapper', preview: '/private/naru preview' };
    assert.deepEqual(oc2Dispatch(['run', 'two words', "quote'and;$HOME"], targets), { executable: targets.v2, argv: ['run', 'two words', "quote'and;$HOME"] });
    assert.deepEqual(oc2Dispatch(['naru', 'enroll', '/tmp/two words', '--write', 'src/**'], targets), { executable: targets.preview, argv: ['enroll', '/tmp/two words', '--write', 'src/**'] });
});

test('oc2 process dispatch preserves argument boundaries without a shell', async () => {
    const root = await mkdtemp(join(tmpdir(), 'naru-oc2-test-'));
    try {
        const capture = join(root, 'capture.json');
        const target = join(root, 'fake target');
        await writeFile(target, `#!${process.execPath}\nrequire('fs').writeFileSync(process.env.CAPTURE, JSON.stringify(process.argv.slice(2)))\n`); await chmod(target, 0o755);
        const child = spawn(process.execPath, [join(built, 'tools', 'oc2.mjs'), 'naru', 'open', '/tmp/two words', "quote'and;$HOME"], {
            env: { ...process.env, CAPTURE: capture, NARU_OC2_V2_WRAPPER: target, NARU_OC2_PREVIEW: target }, stdio: 'pipe',
        });
        const code = await new Promise<number | null>((resolvePromise, reject) => { child.once('error', reject); child.once('exit', resolvePromise); });
        assert.equal(code, 0);
        assert.deepEqual(JSON.parse(await readFile(capture, 'utf8')), ['open', '/tmp/two words', "quote'and;$HOME"]);
    } finally { await rm(root, { recursive: true, force: true }); }
});

test('oc2 installer refuses an existing launcher before creating a preview root', async () => {
    const root = await mkdtemp(join(tmpdir(), 'naru-oc2-install-test-'));
    try {
        const bin = join(root, 'oc2'); await writeFile(bin, 'existing');
        const installRoot = join(root, 'preview');
        await assert.rejects(installOc2({ previewCli: '/missing/preview', opencode: '/missing/raw', v2Wrapper: '/missing/wrapper', root: installRoot, bin }), /refusing to overwrite/);
        await assert.rejects(readFile(installRoot), { code: 'ENOENT' });
    } finally { await rm(root, { recursive: true, force: true }); }
});
