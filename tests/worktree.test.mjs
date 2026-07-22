import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmod, lstat, mkdtemp, mkdir, readFile, readdir, rm, stat, symlink, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

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
    agent: 'naru-orchestrator',
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
    agent: 'naru-orchestrator',
    directory: repository,
    runtimeConfig: { implementation: { workspaceMode: 'shared' } },
    spawn: nodeSpawn,
    worktreeRoot,
    worktreeRegistry: new Map(),
  }));
  assert.equal(output.ok, false);
  assert.match(output.error, /isolated writer mode is disabled/);
});

test('worktree tool denies unauthorized callers and invalid workspace paths before Git I/O', async (t) => {
  const { root, repository, worktreeRoot } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  let spawnCalls = 0;
  const deniedSpawn = async () => {
    spawnCalls += 1;
    throw new Error('Git must not run');
  };
  const input = { input: { operation: 'prepare_run', runId: 'denied' } };
  const context = {
    directory: repository,
    runtimeConfig: { implementation: { workspaceMode: 'worktree' } },
    spawn: deniedSpawn,
    worktreeRoot,
    worktreeRegistry: new Map(),
  };

  const denied = JSON.parse(await worktreeTool.execute(input, context));
  assert.equal(denied.ok, false);
  assert.match(denied.error, /restricted to naru-orchestrator/);
  const invalidDirectory = JSON.parse(await worktreeTool.execute(input, {
    ...context,
    agent: 'naru-orchestrator',
    directory: 'relative/repository',
  }));
  assert.equal(invalidDirectory.ok, false);
  assert.match(invalidDirectory.error, /absolute workspace directory/);
  assert.equal(spawnCalls, 0);
});

test('worktree creation rejects a symlinked repository-name ancestor before external writes', async (t) => {
  const { root, repository, worktreeRoot } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const externalDirectory = join(root, 'external-worktrees');
  await mkdir(worktreeRoot);
  await mkdir(externalDirectory);
  await symlink(externalDirectory, join(worktreeRoot, basename(repository)));
  const calls = [];
  const trackedSpawn = (argv, options) => {
    calls.push(argv);
    return nodeSpawn(argv, options);
  };
  const stateRegistry = new Map();

  await assert.rejects(
    createWorktreeRun({
      directory: repository,
      runId: 'run-ancestor-link',
      worktreeRoot,
      spawn: trackedSpawn,
      stateRegistry,
    }),
    /repository worktree directory must not be a symbolic link/,
  );
  assert.equal(calls.some((argv) => argv.includes('worktree') && argv.includes('add')), false);
  await assert.rejects(lstat(join(externalDirectory, 'naru')), { code: 'ENOENT' });
  assert.equal(stateRegistry.size, 0);
});

test('Naru worktree creation disables checkout hooks only on worktree add', async (t) => {
  const { root, repository, worktreeRoot } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const marker = join(root, 'checkout-hook-ran');
  const hook = join(repository, '.git/hooks/post-checkout');
  await writeFile(hook, `#!/bin/sh\n: > ${JSON.stringify(marker)}\n`);
  await chmod(hook, 0o700);
  const calls = [];
  const trackedSpawn = (argv, options) => {
    calls.push(argv);
    return nodeSpawn(argv, options);
  };
  const stateRegistry = new Map();
  await createWorktreeRun({
    directory: repository,
    runId: 'run-hooks',
    worktreeRoot,
    spawn: trackedSpawn,
    stateRegistry,
  });
  await createWriterWorktree({
    runId: 'run-hooks',
    itemId: 'item',
    ownedWriteScope: ['src/a.txt'],
    spawn: trackedSpawn,
    stateRegistry,
  });

  await assert.rejects(lstat(marker), { code: 'ENOENT' });
  const addCalls = calls.filter((argv) => argv.includes('worktree') && argv.includes('add'));
  assert.equal(addCalls.length, 2);
  assert.equal(addCalls.every((argv) => argv.includes('core.hooksPath=/dev/null')), true);
  assert.equal(
    calls.filter((argv) => !argv.includes('worktree') || !argv.includes('add'))
      .every((argv) => !argv.includes('core.hooksPath=/dev/null')),
    true,
  );
});

test('mutating operations serialize per run and release the lock after rejection', async (t) => {
  const { root, repository, worktreeRoot } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const stateRegistry = new Map();
  await createWorktreeRun({
    directory: repository,
    runId: 'run-lock',
    maxWriters: 2,
    worktreeRoot,
    spawn: nodeSpawn,
    stateRegistry,
  });
  const rejected = await createWriterWorktree({
    runId: 'run-lock',
    itemId: 'rejected',
    ownedWriteScope: ['src/a.txt'],
    spawn: nodeSpawn,
    stateRegistry,
  });
  const accepted = await createWriterWorktree({
    runId: 'run-lock',
    itemId: 'accepted',
    ownedWriteScope: ['src/b.txt'],
    spawn: nodeSpawn,
    stateRegistry,
  });
  await writeFile(join(rejected.path, 'src/b.txt'), 'outside\n');
  await writeFile(join(accepted.path, 'src/b.txt'), 'accepted\n');
  let active = 0;
  let maximumActive = 0;
  const delayedSpawn = async (argv, options) => {
    active += 1;
    maximumActive = Math.max(maximumActive, active);
    await delay(15);
    try {
      return await nodeSpawn(argv, options);
    } finally {
      active -= 1;
    }
  };

  const results = await Promise.allSettled([
    integrateWriterWorktree({ runId: 'run-lock', itemId: 'rejected', spawn: delayedSpawn, stateRegistry }),
    integrateWriterWorktree({ runId: 'run-lock', itemId: 'accepted', spawn: delayedSpawn, stateRegistry }),
  ]);
  assert.equal(results[0].status, 'rejected');
  assert.match(results[0].reason.message, /outside rejected ownership/);
  assert.equal(results[1].status, 'fulfilled');
  assert.equal(maximumActive, 1);
  assert.equal(worktreeRunSnapshot('run-lock', stateRegistry).items[1].integrated, true);
});

test('metadata replacement is private and recovery rejects malformed or inconsistent state', async (t) => {
  const { root, repository, worktreeRoot } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const stateRegistry = new Map();
  const run = await createWorktreeRun({
    directory: repository,
    runId: 'run-metadata',
    worktreeRoot,
    spawn: nodeSpawn,
    stateRegistry,
  });
  await createWriterWorktree({
    runId: 'run-metadata',
    itemId: 'pending',
    ownedWriteScope: ['src/a.txt'],
    spawn: nodeSpawn,
    stateRegistry,
  });
  const runRoot = dirname(run.integrationPath);
  const metadataPath = join(runRoot, '.naru-run.json');
  assert.equal((await stat(metadataPath)).mode & 0o777, 0o600);
  assert.deepEqual((await readdir(runRoot)).filter((name) => name.endsWith('.tmp')), []);

  const metadata = JSON.parse(await readFile(metadataPath, 'utf8'));
  metadata.finalized = true;
  await writeFile(metadataPath, `${JSON.stringify(metadata)}\n`, { mode: 0o600 });
  await assert.rejects(
    recoverWorktreeRun({
      directory: repository,
      runId: 'run-metadata',
      worktreeRoot,
      spawn: nodeSpawn,
      stateRegistry: new Map(),
    }),
    /finalized worktree run metadata contains unintegrated writers/,
  );
  await writeFile(metadataPath, '{ malformed', { mode: 0o600 });
  await assert.rejects(
    recoverWorktreeRun({
      directory: repository,
      runId: 'run-metadata',
      worktreeRoot,
      spawn: nodeSpawn,
      stateRegistry: new Map(),
    }),
    /malformed JSON/,
  );
});

test('untracked integration rejects symlink leaves and target symlink ancestors', async (t) => {
  const { root, repository, worktreeRoot } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const stateRegistry = new Map();
  const run = await createWorktreeRun({
    directory: repository,
    runId: 'run-links',
    maxWriters: 2,
    worktreeRoot,
    spawn: nodeSpawn,
    stateRegistry,
  });
  const linked = await createWriterWorktree({
    runId: 'run-links',
    itemId: 'linked',
    ownedWriteScope: ['src/linked.txt'],
    spawn: nodeSpawn,
    stateRegistry,
  });
  const externalFile = join(root, 'external.txt');
  await writeFile(externalFile, 'external\n');
  await symlink(externalFile, join(linked.path, 'src/linked.txt'));
  await assert.rejects(
    integrateWriterWorktree({ runId: 'run-links', itemId: 'linked', spawn: nodeSpawn, stateRegistry }),
    /symbolic link/,
  );

  const nested = await createWriterWorktree({
    runId: 'run-links',
    itemId: 'nested',
    ownedWriteScope: ['nested/file.txt'],
    spawn: nodeSpawn,
    stateRegistry,
  });
  await mkdir(join(nested.path, 'nested'));
  await writeFile(join(nested.path, 'nested/file.txt'), 'nested\n');
  const externalDirectory = join(root, 'external-directory');
  await mkdir(externalDirectory);
  await symlink(externalDirectory, join(run.integrationPath, 'nested'));
  await assert.rejects(
    integrateWriterWorktree({ runId: 'run-links', itemId: 'nested', spawn: nodeSpawn, stateRegistry }),
    /unsafe ancestor/,
  );
  await assert.rejects(lstat(join(externalDirectory, 'file.txt')), { code: 'ENOENT' });
});

test('finalization rolls back tracked and created untracked files after a partial copy failure', async (t) => {
  const { root, repository, worktreeRoot } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const stateRegistry = new Map();
  const run = await createWorktreeRun({
    directory: repository,
    runId: 'run-rollback',
    worktreeRoot,
    spawn: nodeSpawn,
    stateRegistry,
  });
  const item = await createWriterWorktree({
    runId: 'run-rollback',
    itemId: 'item',
    ownedWriteScope: ['src/a.txt', 'src/new.txt', 'src/too-large.bin'],
    spawn: nodeSpawn,
    stateRegistry,
  });
  await writeFile(join(item.path, 'src/a.txt'), 'a1\n');
  await writeFile(join(item.path, 'src/new.txt'), 'new\n');
  await writeFile(join(item.path, 'src/too-large.bin'), 'small\n');
  await integrateWriterWorktree({ runId: 'run-rollback', itemId: 'item', spawn: nodeSpawn, stateRegistry });
  await truncate(join(run.integrationPath, 'src/too-large.bin'), (64 * 1024 * 1024) + 1);

  await assert.rejects(
    finalizeWorktreeRun({ runId: 'run-rollback', spawn: nodeSpawn, stateRegistry }),
    /untracked file exceeds .*rollback completed/,
  );
  assert.equal(await readFile(join(repository, 'src/a.txt'), 'utf8'), 'a0\n');
  await assert.rejects(lstat(join(repository, 'src/new.txt')), { code: 'ENOENT' });
  await assert.rejects(lstat(join(repository, 'src/too-large.bin')), { code: 'ENOENT' });
  assert.equal(await git(repository, 'status', '--porcelain'), '');
  assert.equal(worktreeRunSnapshot('run-rollback', stateRegistry).faulted, true);
});
