import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const helper = new URL('../scripts/merge-opencode-config.mjs', import.meta.url);

async function merge(source, inputMode) {
  const dir = await mkdtemp(join(tmpdir(), 'naru-opencode-config-'));
  const input = join(dir, 'input.jsonc');
  const output = join(dir, 'output.jsonc');
  await writeFile(input, source);
  if (inputMode !== undefined) await chmod(input, inputMode);
  const result = spawnSync(process.execPath, [helper.pathname, input, output], { encoding: 'utf8' });
  const text = result.status === 0 ? await readFile(output, 'utf8') : undefined;
  const mode = result.status === 0 ? (await stat(output)).mode & 0o777 : undefined;
  await rm(dir, { recursive: true, force: true });
  return { ...result, mode, text };
}

test('raises absent, zero, and one depths to two without changing unrelated JSONC', async () => {
  for (const source of [
    '{\n  // keep\n  "theme": "system",\n}\n',
    '{\n  "subagent_depth": 0,\n  "theme": "system"\n}\n',
    '{\n  "subagent_depth": 1,\n  "theme": "system"\n}\n',
  ]) {
    const result = await merge(source);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.text, /"subagent_depth": 2/);
    assert.match(result.text, /"theme": "system"/);
    if (source.includes('// keep')) assert.match(result.text, /\/\/ keep/);
  }
});

test('preserves CRLF, comments, trailing commas, indentation, and final-newline state', async () => {
  const source = '{\r\n\t/* keep */\r\n\t"theme": "system",\r\n}';
  const result = await merge(source);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.text, /\r\n\t"subagent_depth": 2,\r\n/);
  assert.match(result.text, /\/\* keep \*\//);
  assert.equal(result.text.replace(/\r\n/g, '').includes('\n'), false);
  assert.equal(result.text.endsWith('\n'), false);
});

test('preserves valid depths exactly and is idempotent at two', async () => {
  for (const depth of [2, 7]) {
    const source = `{\n  "subagent_depth": ${depth},\n  "theme": "system"\n}\n`;
    const first = await merge(source);
    assert.equal(first.status, 0, first.stderr);
    assert.equal(first.text, source);
    const second = await merge(first.text);
    assert.equal(second.status, 0, second.stderr);
    assert.equal(second.text, source);
  }
});

test('preserves ordinary input permission bits on prepared output', async () => {
  const result = await merge('{"subagent_depth":1}\n', 0o600);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.mode, 0o600);
});

test('creates a minimal schema-bearing config', async () => {
  const dir = join(tmpdir(), `naru-opencode-create-${process.pid}-${Date.now()}`);
  const output = join(dir, 'opencode.json');
  await mkdir(dir);
  const result = spawnSync(process.execPath, [helper.pathname, '-', output], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const text = await readFile(output, 'utf8');
  assert.deepEqual(JSON.parse(text), { $schema: 'https://opencode.ai/config.json', subagent_depth: 2 });
  assert.equal((await stat(output)).mode & 0o777, 0o600);
  await rm(dir, { recursive: true, force: true });
});

test('rejects malformed, non-object, invalid, and duplicate depth configuration', async () => {
  for (const source of [
    '{ invalid',
    '[]\n',
    '{"subagent_depth":-1}\n',
    '{"subagent_depth":1.5}\n',
    '{"subagent_depth":"2"}\n',
    '{"subagent_depth":1,"subagent_depth":2}\n',
    '{"subagent_depth":1,"subagent_\\u0064epth":2}\n',
  ]) {
    const result = await merge(source);
    assert.notEqual(result.status, 0, source);
  }
});

test('rejects symlinked and oversized input', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'naru-opencode-reject-'));
  const real = join(dir, 'real.json');
  const link = join(dir, 'link.json');
  const output = join(dir, 'output.json');
  await writeFile(real, '{}\n');
  await symlink(real, link);
  let result = spawnSync(process.execPath, [helper.pathname, link, output], { encoding: 'utf8' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /must not be a symlink/);
  await writeFile(real, `${' '.repeat(64 * 1024)}x`);
  result = spawnSync(process.execPath, [helper.pathname, real, output], { encoding: 'utf8' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /exceeds 65536 bytes/);
  await rm(dir, { recursive: true, force: true });
});
