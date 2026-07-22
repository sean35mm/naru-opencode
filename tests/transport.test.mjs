import assert from 'node:assert/strict';
import test from 'node:test';

import { run } from '../tools/naru-lib/transport.mjs';

test('run preserves injectable spawn options and result compatibility', async () => {
  const expected = { ok: true, code: 0, stdout: 'ok', stderr: '' };
  const calls = [];
  const result = await run(['tool', '--flag'], {
    input: 'input',
    cwd: '/tmp',
    timeout: 1234,
    maxBytes: 2048,
    killGraceMs: 25,
    async spawn(argv, options) {
      calls.push({ argv, options });
      return expected;
    },
  });

  assert.equal(result, expected);
  assert.deepEqual(calls, [{
    argv: ['tool', '--flag'],
    options: {
      input: 'input',
      cwd: '/tmp',
      timeout: 1234,
      maxBytes: 2048,
      killGraceMs: 25,
    },
  }]);
});

test('run rejects invalid deadline and capture options before spawning', async () => {
  let spawned = false;
  const spawn = async () => {
    spawned = true;
  };

  await assert.rejects(run(['tool'], { spawn, timeout: 0 }), /run timeout must be from 1/);
  await assert.rejects(run(['tool'], { spawn, maxBytes: 0 }), /run maxBytes must be a positive safe integer/);
  await assert.rejects(run(['tool'], { spawn, killGraceMs: 30001 }), /run killGraceMs must be from 1/);
  assert.equal(spawned, false);
});
