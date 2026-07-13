import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const helper = new URL('../scripts/merge-tui-config.mjs', import.meta.url);
const current = './plugins/naru-minions-dashboard.tsx';

async function merge(source, operation = 'register') {
  const dir = await mkdtemp(join(tmpdir(), 'naru-tui-'));
  const input = join(dir, 'input.jsonc');
  const output = join(dir, 'output.jsonc');
  await writeFile(input, source);
  const result = spawnSync(process.execPath, [helper.pathname, input, output, current, operation], { encoding: 'utf8' });
  const text = result.status === 0 ? await readFile(output, 'utf8') : undefined;
  await rm(dir, { recursive: true, force: true });
  return { ...result, text };
}

test('migrates and deduplicates string and tuple Naru registrations', async () => {
  const result = await merge(`{
  "plugin": [
    ["unrelated", { "enabled": true }],
    ["./plugins/naru-minions-dashboard.js", { "old": true }],
    "plugins/naru-minions-dashboard.tsx"
  ]
}\n`);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.text, /\["unrelated", \{ "enabled": true \}\]/);
  assert.equal(result.text.match(/naru-minions-dashboard\.tsx/g)?.length, 1);
  assert.doesNotMatch(result.text, /naru-minions-dashboard\.js/);
  assert.deepEqual(JSON.parse(result.text), { plugin: [['unrelated', { enabled: true }], current] });
});

test('preserves comments inside the plugin array and CRLF newlines', async () => {
  const source = '{\r\n  "plugin": /* keep around */ [\r\n    // keep before\r\n    "other", // keep after\r\n    /* migrate */ "./plugins/naru-minions-dashboard.js",\r\n  ],\r\n}\r\n';
  const result = await merge(source);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.text, /\/\/ keep before/);
  assert.match(result.text, /\/\/ keep after/);
  assert.match(result.text, /\/\* keep around \*\//);
  assert.match(result.text, /\/\* migrate \*\//);
  assert.equal(result.text.replace(/\r\n/g, '').includes('\n'), false);
});

test('rejects invalid object and malformed tuple plugin entries', async () => {
  for (const entry of ['{"specifier":"other"}', '["other"]', '["other", true]']) {
    const result = await merge(`{"plugin":[${entry}]}\n`);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /plugin entries must be strings or \[string, options-object\] tuples/);
  }
});

test('remove mode cleans exact Naru entries without adding the current one', async () => {
  const result = await merge('{"plugin":["other",["./plugins/naru-minions-dashboard.js",{}]]}\n', 'remove');
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.text, /"other"/);
  assert.doesNotMatch(result.text, /naru-minions-dashboard/);
});

test('adjacent final removals remain strict JSON without a trailing comma', async () => {
  const result = await merge('{"plugin":["other","plugins/naru-minions-dashboard.js","./plugins/naru-minions-dashboard.tsx"]}\n', 'remove');
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.text), { plugin: ['other'] });
});

test('root insertion ignores closing braces in trailing comments', async () => {
  const source = '{\n  "theme": "system"\n}\n// trailing } comment\n';
  const result = await merge(source);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.text, /}\n\/\/ trailing } comment\n$/);
  assert.deepEqual(JSON.parse(result.text.slice(0, result.text.indexOf('// trailing'))), {
    theme: 'system',
    plugin: [current],
  });
});

test('root insertion preserves a valid trailing comma', async () => {
  const result = await merge('{\n  "theme": "system",\n}\n');
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.text.replace(/,\s*([}\]])/g, '$1')), {
    theme: 'system',
    plugin: [current],
  });
  assert.doesNotMatch(result.text, /,,/);
});
