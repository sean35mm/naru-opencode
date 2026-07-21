import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import worktreeTool from '../tools/naru-worktree.js';
import {
  cleanupWorktreeRun,
  createWorktreeRun,
  createWriterWorktree,
  finalizeWorktreeRun,
  integrateWriterWorktree,
  recoverWorktreeRun,
  worktreeRunSnapshot,
} from '../tools/naru-lib/worktree.mjs';

function nodeSpawn(argv, { cwd, input } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(argv[0], argv.slice(1), { cwd, env: { ...process.env, NO_COLOR: '1' } });
    const stdout = [];
    const stderr = [];
    child.stdout.on('data', (chunk) => stdout.push(chunk));
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    child.once('error', reject);
    child.once('exit', (code) => resolve({
      ok: code === 0,
      code,
      stdout: Buffer.concat(stdout).toString('utf8'),
      stderr: Buffer.concat(stderr).toString('utf8'),
      stdoutTruncated: false,
      stderrTruncated: false,
    }));
    if (input !== undefined) child.stdin.end(input);
    else child.stdin.end();
  });
}

async function git(repository, ...args) {
  const result = await nodeSpawn(['git', ...args], { cwd: repository });
  assert.equal(result.ok, true, result.stderr);
  return result.stdout.trim();
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'naru-worktree-test-'));
  const repository = join(root, 'repository');
  await mkdir(join(repository, 'src'), { recursive: true });
  await git(root, 'init', repository);
  await git(repository, 'config', 'user.name', 'Naru Test');
  await git(repository, 'config', 'user.email', 'naru-test@localhost');
  await writeFile(join(repository, 'src/a.txt'), 'a0\n');
  await writeFile(join(repository, 'src/b.txt'), 'b0\n');
  await git(repository, 'add', '.');
  await git(repository, 'commit', '-m', 'fixture');
  return { root, repository, worktreeRoot: join(root, 'worktrees') };
}

test('isolated writers integrate serially and leave the main branch uncommitted', async (t) => {
  const { root, repository, worktreeRoot } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const stateRegistry = new Map();
  const run = await createWorktreeRun({
    directory: repository,
    runId: 'run-a',
    maxWriters: 6,
    worktreeRoot,
    spawn: nodeSpawn,
    stateRegistry,
  });
  const baseSha = await git(repository, 'rev-parse', 'HEAD');
  assert.equal(run.baseSha, baseSha);

  const a = await createWriterWorktree({
    runId: 'run-a',
    itemId: 'a',
    ownedWriteScope: ['src/a.txt'],
    spawn: nodeSpawn,
    stateRegistry,
  });
  const b = await createWriterWorktree({
    runId: 'run-a',
    itemId: 'b',
    ownedWriteScope: ['src/b.txt', 'src/new.txt'],
    spawn: nodeSpawn,
    stateRegistry,
  });
  await writeFile(join(a.path, 'src/a.txt'), 'a1\n');
  await writeFile(join(b.path, 'src/b.txt'), 'b1\n');
  await writeFile(join(b.path, 'src/new.txt'), 'new\n');

  const activeRegistry = new Map();
  const active = await recoverWorktreeRun({
    directory: repository,
    runId: 'run-a',
    worktreeRoot,
    spawn: nodeSpawn,
    stateRegistry: activeRegistry,
  });
  assert.equal(active.finalized, false);
  await integrateWriterWorktree({ runId: 'run-a', itemId: 'a', spawn: nodeSpawn, stateRegistry: activeRegistry });
  await integrateWriterWorktree({ runId: 'run-a', itemId: 'b', spawn: nodeSpawn, stateRegistry: activeRegistry });
  assert.equal(await readFile(join(run.integrationPath, 'src/a.txt'), 'utf8'), 'a1\n');
  assert.equal(await readFile(join(run.integrationPath, 'src/b.txt'), 'utf8'), 'b1\n');
  assert.equal(await readFile(join(run.integrationPath, 'src/new.txt'), 'utf8'), 'new\n');
  assert.equal(await readFile(join(repository, 'src/a.txt'), 'utf8'), 'a0\n');
  assert.equal(await git(repository, 'status', '--porcelain'), '');

  const finalized = await finalizeWorktreeRun({ runId: 'run-a', spawn: nodeSpawn, stateRegistry: activeRegistry });
  assert.deepEqual(finalized.changedPaths, ['src/a.txt', 'src/b.txt', 'src/new.txt']);
  assert.equal(await readFile(join(repository, 'src/a.txt'), 'utf8'), 'a1\n');
  assert.equal(await readFile(join(repository, 'src/new.txt'), 'utf8'), 'new\n');
  assert.equal(await git(repository, 'rev-parse', 'HEAD'), baseSha);
  assert.match(await git(repository, 'status', '--porcelain'), /src\/a\.txt/);

  const recoveredRegistry = new Map();
  const recoveryOutput = JSON.parse(await worktreeTool.execute({
    input: { operation: 'recover_run', runId: 'run-a' },
  }, {
    directory: repository,
    runtimeConfig: { implementation: { workspaceMode: 'worktree' } },
    worktreeRoot,
    spawn: nodeSpawn,
    worktreeRegistry: recoveredRegistry,
  }));
  assert.equal(recoveryOutput.ok, true, recoveryOutput.error);
  assert.equal(recoveryOutput.data.finalized, true);
  assert.deepEqual(recoveryOutput.data.items.map((item) => item.itemId), ['a', 'b']);
  assert.deepEqual(await cleanupWorktreeRun({ runId: 'run-a', spawn: nodeSpawn, stateRegistry: recoveredRegistry }), {
    runId: 'run-a',
    cleaned: true,
  });
  assert.equal(recoveredRegistry.size, 0);
});

test('worktree integration rejects out-of-scope changes and cleanup before finalization', async (t) => {
  const { root, repository, worktreeRoot } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const stateRegistry = new Map();
  await createWorktreeRun({
    directory: repository,
    runId: 'run-b',
    maxWriters: 1,
    worktreeRoot,
    spawn: nodeSpawn,
    stateRegistry,
  });
  const item = await createWriterWorktree({
    runId: 'run-b',
    itemId: 'limited',
    ownedWriteScope: ['src/a.txt'],
    spawn: nodeSpawn,
    stateRegistry,
  });
  await writeFile(join(item.path, 'src/b.txt'), 'outside\n');
  await assert.rejects(
    integrateWriterWorktree({ runId: 'run-b', itemId: 'limited', spawn: nodeSpawn, stateRegistry }),
    /outside limited ownership/,
  );
  await assert.rejects(
    cleanupWorktreeRun({ runId: 'run-b', spawn: nodeSpawn, stateRegistry }),
    /before successful finalization/,
  );
  assert.equal(worktreeRunSnapshot('run-b', stateRegistry).finalized, false);
});

test('isolated writer mode refuses dirty repositories and tool mode can be disabled', async (t) => {
  const { root, repository, worktreeRoot } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(repository, 'src/a.txt'), 'dirty\n');
  await assert.rejects(
    createWorktreeRun({
      directory: repository,
      runId: 'run-dirty',
      worktreeRoot,
      spawn: nodeSpawn,
      stateRegistry: new Map(),
    }),
    /requires a clean workspace/,
  );

  const output = JSON.parse(await worktreeTool.execute({ input: { operation: 'prepare_run', runId: 'disabled' } }, {
    directory: repository,
    runtimeConfig: { implementation: { workspaceMode: 'shared' } },
    spawn: nodeSpawn,
    worktreeRoot,
    worktreeRegistry: new Map(),
  }));
  assert.equal(output.ok, false);
  assert.match(output.error, /isolated writer mode is disabled/);
});
