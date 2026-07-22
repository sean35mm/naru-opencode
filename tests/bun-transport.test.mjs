import assert from 'node:assert/strict';

import { defaultSpawn } from '../tools/naru-lib/transport.mjs';

if (typeof Bun === 'undefined') {
  console.log('SKIP bun transport (Bun unavailable)');
} else {
  const result = await defaultSpawn(
    [process.execPath, '-e', 'process.stdin.pipe(process.stdout)'],
    { input: 'naru-stdin-smoke', maxBytes: 1024, timeout: 5000 },
  );

  assert.equal(result.ok, true);
  assert.equal(result.stdout, 'naru-stdin-smoke');
  assert.equal(result.stdoutTruncated, false);

  const gracefulTerm = await defaultSpawn([
    process.execPath,
    '-e',
    "process.on('SIGTERM', () => process.exit(0)); setInterval(() => {}, 1000)",
  ], { maxBytes: 1024, timeout: 100, killGraceMs: 200 });
  assert.equal(gracefulTerm.ok, false);
  assert.equal(gracefulTerm.timedOut, true);
  assert.equal(gracefulTerm.terminationEscalated, false);

  const ignoredTerm = await defaultSpawn([
    process.execPath,
    '-e',
    "process.stdout.write('started'); process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)",
  ], { maxBytes: 1024, timeout: 50, killGraceMs: 50 });
  assert.equal(ignoredTerm.ok, false);
  assert.equal(ignoredTerm.timedOut, true);
  assert.equal(ignoredTerm.terminationEscalated, true);
  assert.equal(ignoredTerm.stdout, 'started');

  const startedAt = Date.now();
  const retainedPipes = await defaultSpawn([
    process.execPath,
    '-e',
    [
      "require('node:child_process').spawn(process.execPath, ['-e', 'setTimeout(() => {}, 1000)'],",
      "  { stdio: ['ignore', 1, 2] });",
      "process.on('SIGTERM', () => {});",
      "setInterval(() => {}, 1000);",
    ].join(' '),
  ], { maxBytes: 1024, timeout: 50, killGraceMs: 50 });
  assert.equal(retainedPipes.ok, false);
  assert.equal(retainedPipes.timedOut, true);
  assert.equal(retainedPipes.terminationEscalated, true);
  assert.ok(Date.now() - startedAt < 750, 'retained descendant pipes must not defeat the final bound');
  console.log('OK bun transport');
}
