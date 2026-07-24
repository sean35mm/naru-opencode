import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  appendFile,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

async function copyInstallSource(destination) {
  for (const directory of ['agents', 'plugins', 'scripts', 'skills', 'tools']) {
    await cp(path.join(root, directory), path.join(destination, directory), { recursive: true });
  }
  await mkdir(path.join(destination, 'tests', 'fixtures'), { recursive: true });
  await cp(
    path.join(root, 'tests', 'fixtures', 'live-evals.json'),
    path.join(destination, 'tests', 'fixtures', 'live-evals.json'),
  );
  await cp(path.join(root, 'install.sh'), path.join(destination, 'install.sh'));
  await cp(path.join(root, 'naru-runtime.example.json'), path.join(destination, 'naru-runtime.example.json'));
}

function runDoctor(doctor, { home, project, source }) {
  const result = spawnSync(process.execPath, [
    doctor,
    '--json',
    '--project-root', project,
    '--source', source,
  ], {
    cwd: project,
    env: { ...process.env, HOME: home },
    encoding: 'utf8',
    maxBuffer: 1024 * 1024,
    timeout: 10_000,
  });
  assert.ok(result.status === 0 || result.status === 1, result.stderr || result.stdout);
  assert.equal(result.stderr, '');
  return JSON.parse(result.stdout);
}

test('doctor is read-only and diagnoses scope, default depth, source generation, and dashboard state', async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'naru-doctor-test-'));
  try {
    const source = path.join(temporary, 'source');
    const home = path.join(temporary, 'home');
    const project = path.join(temporary, 'project');
    await mkdir(source, { recursive: true });
    await mkdir(home, { recursive: true });
    await mkdir(project, { recursive: true });
    await copyInstallSource(source);

    const install = spawnSync('sh', [
      path.join(source, 'install.sh'),
      '--apply',
      '--with-dashboard',
    ], {
      cwd: source,
      env: { ...process.env, HOME: home },
      encoding: 'utf8',
      maxBuffer: 1024 * 1024,
      timeout: 20_000,
    });
    assert.equal(install.status, 0, install.stderr || install.stdout);

    const target = path.join(home, '.config', 'opencode');
    const doctor = path.join(target, 'tools', 'naru-doctor.js');
    const manifestPath = path.join(target, '.naru-install.json');
    const manifestBefore = await readFile(manifestPath, 'utf8');

    let report = runDoctor(doctor, { home, project, source });
    assert.equal(report.schemaVersion, 1);
    assert.equal(report.diagnostic, 'naru-doctor');
    assert.equal(report.providerFree, true);
    assert.equal(report.readOnly, true);
    assert.equal(report.depth.effective, 1);
    assert.equal(report.depth.source, 'opencode-default');
    assert.equal(report.scopes.filter(scope => scope.installed).length, 1);
    const globalScope = report.scopes.find(scope => scope.id === 'global');
    assert.equal(globalScope.manifestStatus, 'valid');
    assert.equal(globalScope.installMode, 'symlink');
    assert.equal(globalScope.assets.installed.healthy, globalScope.assets.total);
    assert.equal(globalScope.assets.source.matched, globalScope.assets.total);
    assert.equal(globalScope.routing.status, 'default');
    assert.equal(globalScope.runtime.schedulerMode, 'off');
    assert.equal(globalScope.dashboard.installed, true);
    assert.equal(globalScope.dashboard.registered, true);
    assert.equal(JSON.stringify(report).includes(temporary), false);
    assert.equal(await readFile(manifestPath, 'utf8'), manifestBefore);

    await writeFile(path.join(project, 'opencode.jsonc'), '{\n  // project wins\n  "subagent_depth": 4,\n}\n');
    report = runDoctor(doctor, { home, project, source });
    assert.equal(report.depth.effective, 4);
    assert.equal(report.depth.source, 'project:opencode.jsonc');

    const sourcePlugin = path.join(source, 'plugins', 'naru-delegate.js');
    const originalPlugin = await readFile(sourcePlugin);
    await appendFile(sourcePlugin, '\n// newer source generation\n');
    report = runDoctor(doctor, { home, project, source });
    assert.ok(report.issues.some(issue => issue.code === 'copy-pinned-assets-stale'));
    assert.ok(report.issues.some(issue => issue.code === 'mixed-generation-install'));
    await writeFile(sourcePlugin, originalPlugin);

    await appendFile(path.join(target, 'plugins', 'naru-delegate.js'), '\n// local modification\n');
    report = runDoctor(doctor, { home, project, source });
    assert.ok(report.issues.some(issue => issue.code === 'managed-assets-modified'));
    assert.ok(report.scopes.find(scope => scope.id === 'global').issuePaths.includes('plugins/naru-delegate.js'));

    await writeFile(manifestPath, '{ invalid\n');
    report = runDoctor(doctor, { home, project, source });
    assert.equal(report.scopes.find(scope => scope.id === 'global').manifestStatus, 'invalid');
    assert.ok(report.issues.some(issue => issue.code === 'invalid-install-manifest'));
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});
