import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstat, readdir, readFile } from 'node:fs/promises';
import { dirname, join, relative, sep } from 'node:path';
import { spawn } from 'node:child_process';
import test from 'node:test';

const checkoutRoot = process.cwd();
const candidateRoot = join(checkoutRoot, '.naru-build', 'candidate');
const assemblerPath = join(checkoutRoot, '.naru-build', 'emit', 'build', 'candidate-assembler.js');

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

async function collect(root, directory = root) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const absolute = join(directory, entry.name);
    const path = relative(root, absolute).split(sep).join('/');
    assert.equal(entry.isSymbolicLink(), false, `candidate symlink: ${path}`);
    if (entry.isDirectory()) files.push(...await collect(root, absolute));
    else if (entry.isFile()) files.push(path);
    else assert.fail(`candidate non-file: ${path}`);
  }
  return files.sort();
}

async function runAssembler(mode) {
  await new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [assemblerPath, mode], {
      cwd: checkoutRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolvePromise() : reject(new Error(stderr || `assembler exited ${code}`)));
  });
}

test('candidate inventory and canonical build identity match every payload file', async () => {
  const { CANDIDATE_MANIFEST_PATH, CANDIDATE_MAPPINGS } = await import(`file://${assemblerPath}`);
  const manifestText = await readFile(join(candidateRoot, CANDIDATE_MANIFEST_PATH), 'utf8');
  const manifest = JSON.parse(manifestText);
  assert.equal(manifestText, `${JSON.stringify(manifest)}\n`);
  const expectedPaths = CANDIDATE_MAPPINGS.map(mapping => mapping.target).sort();
  const actualPaths = (await collect(candidateRoot)).filter(path => path !== CANDIDATE_MANIFEST_PATH);
  assert.deepEqual(actualPaths, expectedPaths);
  assert.deepEqual(manifest.files.map(file => file.path), expectedPaths);
  for (const file of manifest.files) {
    const contents = await readFile(join(candidateRoot, file.path));
    assert.equal(file.sha256, sha256(contents), file.path);
    assert.equal(file.size, contents.byteLength, file.path);
    const expectedMode = file.path === 'install.sh' || file.path === 'tests/install.test.sh' ? '0755' : '0644';
    assert.equal(file.mode, expectedMode, file.path);
    assert.equal(((await lstat(join(candidateRoot, file.path))).mode & 0o777).toString(8).padStart(4, '0'), expectedMode, file.path);
  }
  assert.equal(manifest.identity, sha256(JSON.stringify(manifest.files)));
});

test('candidate excludes compiler, cache, secret-like, and undeclared TypeScript outputs', async () => {
  for (const path of await collect(candidateRoot)) {
    assert.doesNotMatch(path, /(?:^|\/)(?:node_modules|coverage|dist|\.cache|\.naru-build|__pycache__)(?:\/|$)/);
    assert.doesNotMatch(path, /\.(?:map|tsbuildinfo)$/i);
    if (path !== 'plugins/naru-minions-dashboard.tsx') assert.doesNotMatch(path, /(?:\.d)?\.(?:cts|mts|ts|tsx)$/i);
    assert.doesNotMatch(path.split('/').at(-1), /^(?:\.env(?:\..*)?|credentials?(?:\..*)?|secrets?(?:\..*)?|.*\.(?:key|p12|pem|pfx))$/i);
  }
});

test('fresh emit, public paths, and candidate paths are byte-identical', async () => {
  const { MIRRORED_MODULES } = await import(`file://${assemblerPath}`);
  for (const mapping of MIRRORED_MODULES) {
    const [emitted, publicFile, candidate] = await Promise.all([
      readFile(join(checkoutRoot, '.naru-build', 'emit', mapping.emitted)),
      readFile(join(checkoutRoot, mapping.target)),
      readFile(join(candidateRoot, mapping.target)),
    ]);
    assert.deepEqual(emitted, publicFile, mapping.target);
    assert.deepEqual(emitted, candidate, mapping.target);
  }
});

test('declared shebangs are exact and all others remain data files', async () => {
  const expected = new Map([
    ['install.sh', '#!/usr/bin/env sh'],
    ['scripts/naru-compat-smoke.mjs', '#!/usr/bin/env node'],
    ['scripts/naru-live-eval.mjs', '#!/usr/bin/env node'],
    ['tests/fixtures/live-evals/fake-opencode.mjs', '#!/usr/bin/env node'],
    ['tests/install.test.sh', '#!/usr/bin/env sh'],
    ['tools/naru-doctor.js', '#!/usr/bin/env node'],
  ]);
  for (const path of (await collect(candidateRoot)).filter(path => path !== '.naru-candidate.json')) {
    const firstLine = (await readFile(join(candidateRoot, path), 'utf8')).split(/\r?\n/, 1)[0];
    if (expected.has(path)) assert.equal(firstLine, expected.get(path), path);
    else assert.equal(firstLine.startsWith('#!'), false, path);
  }
});

test('candidate assembly is deterministic', async () => {
  await runAssembler('candidate');
  const first = await readFile(join(candidateRoot, '.naru-candidate.json'));
  await runAssembler('candidate');
  const second = await readFile(join(candidateRoot, '.naru-candidate.json'));
  assert.deepEqual(second, first);
  await runAssembler('check');
});
