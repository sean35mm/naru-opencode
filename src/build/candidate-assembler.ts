import { createHash } from 'node:crypto';
import {
  chmod,
  lstat,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { dirname, join, posix, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export type CandidateMapping = Readonly<{
  source: string;
  target: string;
}>;

export type RuntimeMapping = CandidateMapping & Readonly<{
  emitted: string;
}>;

export const MIRRORED_MODULES: readonly RuntimeMapping[] = [
  { source: 'src/plugins/naru-delegate.ts', emitted: 'plugins/naru-delegate.js', target: 'plugins/naru-delegate.js' },
  { source: 'src/plugins/naru-minions-dashboard-state.mts', emitted: 'plugins/naru-minions-dashboard-state.mjs', target: 'plugins/naru-minions-dashboard-state.mjs' },
  { source: 'src/plugins/naru-scheduler.ts', emitted: 'plugins/naru-scheduler.js', target: 'plugins/naru-scheduler.js' },
  { source: 'src/scripts/merge-tui-config.mts', emitted: 'scripts/merge-tui-config.mjs', target: 'scripts/merge-tui-config.mjs' },
  { source: 'src/scripts/naru-compat-smoke.mts', emitted: 'scripts/naru-compat-smoke.mjs', target: 'scripts/naru-compat-smoke.mjs' },
  { source: 'src/scripts/naru-live-eval.mts', emitted: 'scripts/naru-live-eval.mjs', target: 'scripts/naru-live-eval.mjs' },
  { source: 'src/tools/naru-doctor.ts', emitted: 'tools/naru-doctor.js', target: 'tools/naru-doctor.js' },
  { source: 'src/tools/naru-git-read.ts', emitted: 'tools/naru-git-read.js', target: 'tools/naru-git-read.js' },
  { source: 'src/tools/naru-github-post-review.ts', emitted: 'tools/naru-github-post-review.js', target: 'tools/naru-github-post-review.js' },
  { source: 'src/tools/naru-github-read.ts', emitted: 'tools/naru-github-read.js', target: 'tools/naru-github-read.js' },
  { source: 'src/tools/naru-scheduler.ts', emitted: 'tools/naru-scheduler.js', target: 'tools/naru-scheduler.js' },
  { source: 'src/tools/naru-worktree.ts', emitted: 'tools/naru-worktree.js', target: 'tools/naru-worktree.js' },
  { source: 'src/tools/naru-lib/compatibility.mts', emitted: 'tools/naru-lib/compatibility.mjs', target: 'tools/naru-lib/compatibility.mjs' },
  { source: 'src/tools/naru-lib/evaluation.mts', emitted: 'tools/naru-lib/evaluation.mjs', target: 'tools/naru-lib/evaluation.mjs' },
  { source: 'src/tools/naru-lib/git.mts', emitted: 'tools/naru-lib/git.mjs', target: 'tools/naru-lib/git.mjs' },
  { source: 'src/tools/naru-lib/github.mts', emitted: 'tools/naru-lib/github.mjs', target: 'tools/naru-lib/github.mjs' },
  { source: 'src/tools/naru-lib/install-manifest.mts', emitted: 'tools/naru-lib/install-manifest.mjs', target: 'tools/naru-lib/install-manifest.mjs' },
  { source: 'src/tools/naru-lib/live-evaluation.mts', emitted: 'tools/naru-lib/live-evaluation.mjs', target: 'tools/naru-lib/live-evaluation.mjs' },
  { source: 'src/tools/naru-lib/model-routing.mts', emitted: 'tools/naru-lib/model-routing.mjs', target: 'tools/naru-lib/model-routing.mjs' },
  { source: 'src/tools/naru-lib/opencode-live-evaluation.mts', emitted: 'tools/naru-lib/opencode-live-evaluation.mjs', target: 'tools/naru-lib/opencode-live-evaluation.mjs' },
  { source: 'src/tools/naru-lib/output.mts', emitted: 'tools/naru-lib/output.mjs', target: 'tools/naru-lib/output.mjs' },
  { source: 'src/tools/naru-lib/review.mts', emitted: 'tools/naru-lib/review.mjs', target: 'tools/naru-lib/review.mjs' },
  { source: 'src/tools/naru-lib/scheduler-config.mts', emitted: 'tools/naru-lib/scheduler-config.mjs', target: 'tools/naru-lib/scheduler-config.mjs' },
  { source: 'src/tools/naru-lib/scheduler-journal.mts', emitted: 'tools/naru-lib/scheduler-journal.mjs', target: 'tools/naru-lib/scheduler-journal.mjs' },
  { source: 'src/tools/naru-lib/scheduler-protocol.mts', emitted: 'tools/naru-lib/scheduler-protocol.mjs', target: 'tools/naru-lib/scheduler-protocol.mjs' },
  { source: 'src/tools/naru-lib/scheduler-state.mts', emitted: 'tools/naru-lib/scheduler-state.mjs', target: 'tools/naru-lib/scheduler-state.mjs' },
  { source: 'src/tools/naru-lib/scheduler-telemetry.mts', emitted: 'tools/naru-lib/scheduler-telemetry.mjs', target: 'tools/naru-lib/scheduler-telemetry.mjs' },
  { source: 'src/tools/naru-lib/scheduler-token.mts', emitted: 'tools/naru-lib/scheduler-token.mjs', target: 'tools/naru-lib/scheduler-token.mjs' },
  { source: 'src/tools/naru-lib/transport.mts', emitted: 'tools/naru-lib/transport.mjs', target: 'tools/naru-lib/transport.mjs' },
  { source: 'src/tools/naru-lib/validate.mts', emitted: 'tools/naru-lib/validate.mjs', target: 'tools/naru-lib/validate.mjs' },
  { source: 'src/tools/naru-lib/worktree.mts', emitted: 'tools/naru-lib/worktree.mjs', target: 'tools/naru-lib/worktree.mjs' },
] as const;

const STATIC_PATHS = [
  '.github/workflows/ci.yml',
  '.github/workflows/docs.yml',
  '.gitignore',
  'README.md',
  'agents/naru-minion-architect.md',
  'agents/naru-minion-debug.md',
  'agents/naru-minion-implement.md',
  'agents/naru-minion-investigate.md',
  'agents/naru-minion-judge.md',
  'agents/naru-minion-scout.md',
  'agents/naru-minion-verify.md',
  'agents/naru-orchestrator.md',
  'install.sh',
  'naru-runtime.example.json',
  'package.json',
  'plugins/naru-minions-dashboard.tsx',
  'skills/naru-impact/SKILL.md',
  'skills/naru-plan/SKILL.md',
  'skills/naru-review/SKILL.md',
  'skills/naru-triage/SKILL.md',
  'tests/behavioral-evals.test.mjs',
  'tests/bun-transport.test.mjs',
  'tests/candidate-assembly.test.mjs',
  'tests/compatibility.test.mjs',
  'tests/config-policy.test.mjs',
  'tests/dashboard-contract.test.mjs',
  'tests/dashboard-state.test.mjs',
  'tests/doctor.test.mjs',
  'tests/evaluation.test.mjs',
  'tests/fixtures/behavioral-evals.json',
  'tests/fixtures/live-evals.json',
  'tests/fixtures/live-evals/fake-opencode.mjs',
  'tests/fixtures/live-evals/impact/project.json',
  'tests/fixtures/live-evals/impact/src/calculate.mjs',
  'tests/fixtures/live-evals/isolated-writer/project.json',
  'tests/fixtures/live-evals/isolated-writer/src/result.mjs',
  'tests/fixtures/live-evals/planning/project.json',
  'tests/fixtures/live-evals/review/change.json',
  'tests/fixtures/live-evals/scoped-implementation/project.json',
  'tests/fixtures/live-evals/scoped-implementation/src/value.mjs',
  'tests/fixtures/live-evals/shared-fallback/project.json',
  'tests/fixtures/live-evals/shared-fallback/src/state.mjs',
  'tests/fixtures/live-evals/triage/project.json',
  'tests/fixtures/scheduler-protocol3.json',
  'tests/github-tools.test.mjs',
  'tests/install.test.sh',
  'tests/live-evaluation.test.mjs',
  'tests/merge-tui-config.test.mjs',
  'tests/model-routing.test.mjs',
  'tests/prompt-contracts.test.mjs',
  'tests/scheduler-lifecycle.test.mjs',
  'tests/scheduler-protocol.test.mjs',
  'tests/scheduler-runtime.test.mjs',
  'tests/scheduler-telemetry.test.mjs',
  'tests/transport.test.mjs',
  'tests/typescript-policy.test.mjs',
  'tests/worktree.test.mjs',
  'tools/package.json',
] as const;

export const STATIC_MAPPINGS: readonly CandidateMapping[] = STATIC_PATHS.map(path => ({
  source: path,
  target: path,
}));

export const CANDIDATE_MAPPINGS: readonly CandidateMapping[] = [
  ...MIRRORED_MODULES,
  ...STATIC_MAPPINGS,
].sort((left, right) => left.target < right.target ? -1 : left.target > right.target ? 1 : 0);

export const CANDIDATE_MANIFEST_PATH = '.naru-candidate.json';

const EXECUTABLE_PATHS = new Set(['install.sh', 'tests/install.test.sh']);
const SHEBANGS = new Map<string, string>([
  ['install.sh', '#!/usr/bin/env sh'],
  ['scripts/naru-compat-smoke.mjs', '#!/usr/bin/env node'],
  ['scripts/naru-live-eval.mjs', '#!/usr/bin/env node'],
  ['tests/fixtures/live-evals/fake-opencode.mjs', '#!/usr/bin/env node'],
  ['tests/install.test.sh', '#!/usr/bin/env sh'],
  ['tools/naru-doctor.js', '#!/usr/bin/env node'],
]);
const CACHE_SEGMENTS = new Set(['.cache', '.naru-build', '__pycache__', 'coverage', 'dist', 'node_modules']);
const TYPESCRIPT_LEAK = /(?:\.d)?\.(?:cts|mts|ts|tsx)$/i;
const SECRET_BASENAME = /^(?:\.env(?:\..*)?|credentials?(?:\..*)?|id_(?:dsa|ecdsa|ed25519|rsa)|secrets?(?:\..*)?|.*\.(?:key|p12|pem|pfx))$/i;

type ManifestFile = Readonly<{
  mode: '0644' | '0755';
  path: string;
  sha256: string;
  size: number;
}>;

type CandidateManifest = Readonly<{
  formatVersion: 1;
  identity: string;
  files: readonly ManifestFile[];
}>;

function normalizedMode(path: string): ManifestFile['mode'] {
  return EXECUTABLE_PATHS.has(path) ? '0755' : '0644';
}

function sha256(value: Buffer | string): string {
  return createHash('sha256').update(value).digest('hex');
}

function canonicalManifest(files: readonly ManifestFile[]): CandidateManifest {
  return {
    formatVersion: 1,
    identity: sha256(JSON.stringify(files)),
    files,
  };
}

function manifestText(manifest: CandidateManifest): string {
  return `${JSON.stringify(manifest)}\n`;
}

function toPosix(path: string): string {
  return path.split(sep).join(posix.sep);
}

function assertSafeRelativePath(path: string): void {
  if (!path || path.startsWith('/') || path.includes('\\') || path.split('/').includes('..')) {
    throw new Error(`unsafe candidate path: ${path}`);
  }
}

function rejectForbiddenCandidatePath(path: string): void {
  const segments = path.split('/');
  const basename = segments.at(-1) ?? '';
  if (segments.some(segment => CACHE_SEGMENTS.has(segment))) {
    throw new Error(`cache/build output is forbidden in candidate: ${path}`);
  }
  if (SECRET_BASENAME.test(basename) || segments.some(segment => /^(?:\.aws|\.gnupg|\.kube|\.ssh|credentials|secrets)$/i.test(segment))) {
    throw new Error(`secret-like path is forbidden in candidate: ${path}`);
  }
  if (TYPESCRIPT_LEAK.test(path) && path !== 'plugins/naru-minions-dashboard.tsx') {
    throw new Error(`TypeScript source is forbidden in candidate: ${path}`);
  }
  if (/\.(?:map|tsbuildinfo)$/i.test(path)) {
    throw new Error(`compiler artifact is forbidden in candidate: ${path}`);
  }
}

function expectedEmittedPath(source: string): string {
  if (!source.startsWith('src/')) throw new Error(`runtime source must be under src: ${source}`);
  if (source.endsWith('.mts')) return `${source.slice(4, -4)}.mjs`;
  if (source.endsWith('.ts')) return `${source.slice(4, -3)}.js`;
  throw new Error(`runtime source must be .ts or .mts: ${source}`);
}

async function assertRegularUnlinkedPath(root: string, path: string): Promise<void> {
  let current = root;
  for (const segment of path.split('/')) {
    current = join(current, segment);
    const info = await lstat(current);
    if (info.isSymbolicLink()) throw new Error(`symlink is forbidden: ${path}`);
  }
  const info = await lstat(join(root, path));
  if (!info.isFile()) throw new Error(`expected regular file: ${path}`);
}

async function collectFiles(root: string, directory = root): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries.sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0)) {
    const absolute = join(directory, entry.name);
    const path = toPosix(relative(root, absolute));
    if (entry.isSymbolicLink()) throw new Error(`symlink is forbidden in candidate: ${path}`);
    if (entry.isDirectory()) files.push(...await collectFiles(root, absolute));
    else if (entry.isFile()) files.push(path);
    else throw new Error(`non-file output is forbidden in candidate: ${path}`);
  }
  return files.sort();
}

async function readOptional(path: string): Promise<Buffer | null> {
  try {
    return await readFile(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

async function assertProductionInventory(repositoryRoot: string): Promise<void> {
  const emittedModules: string[] = [];
  const publicModules: string[] = [];
  const sourceModules: string[] = [];
  for (const base of ['plugins', 'scripts', 'tools']) {
    publicModules.push(...(await collectFiles(join(repositoryRoot, base)))
      .filter(path => /\.(?:js|mjs)$/.test(path))
      .map(path => `${base}/${path}`));
    emittedModules.push(...(await collectFiles(join(repositoryRoot, '.naru-build', 'emit', base)))
      .filter(path => /\.(?:js|mjs)$/.test(path))
      .map(path => `${base}/${path}`));
    sourceModules.push(...(await collectFiles(join(repositoryRoot, 'src', base)))
      .filter(path => /\.(?:mts|ts)$/.test(path))
      .map(path => `src/${base}/${path}`));
  }
  const mappedPublic = MIRRORED_MODULES.map(mapping => mapping.target).sort();
  const mappedEmitted = MIRRORED_MODULES.map(mapping => mapping.emitted).sort();
  const mappedSource = MIRRORED_MODULES.map(mapping => mapping.source).sort();
  if (JSON.stringify(publicModules.sort()) !== JSON.stringify(mappedPublic)) throw new Error('public production module inventory drift');
  if (JSON.stringify(emittedModules.sort()) !== JSON.stringify(mappedEmitted)) throw new Error('emitted production module inventory drift');
  if (JSON.stringify(sourceModules.sort()) !== JSON.stringify(mappedSource)) throw new Error('source production module inventory drift');
  if (sourceModules.filter(path => path.endsWith('.ts')).length !== 8) throw new Error('expected exactly 8 .ts runtime entry modules');
  if (sourceModules.filter(path => path.endsWith('.mts')).length !== 23) throw new Error('expected exactly 23 .mts runtime modules');
  const javaScriptSources = (await collectFiles(join(repositoryRoot, 'src'))).filter(path => /\.(?:js|mjs)$/.test(path));
  if (javaScriptSources.length > 0) throw new Error(`production JavaScript is forbidden under src: ${javaScriptSources.join(', ')}`);
}

async function copyMappedFile(repositoryRoot: string, stagingRoot: string, mapping: CandidateMapping): Promise<void> {
  assertSafeRelativePath(mapping.source);
  assertSafeRelativePath(mapping.target);
  rejectForbiddenCandidatePath(mapping.target);
  const runtimeMapping = 'emitted' in mapping ? mapping as RuntimeMapping : null;
  const sourceRoot = runtimeMapping ? join(repositoryRoot, '.naru-build', 'emit') : repositoryRoot;
  const sourcePath = runtimeMapping?.emitted ?? mapping.source;
  await assertRegularUnlinkedPath(sourceRoot, sourcePath);
  const contents = await readFile(join(sourceRoot, sourcePath));
  const target = join(stagingRoot, mapping.target);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, contents, { flag: 'wx' });
  await chmod(target, normalizedMode(mapping.target) === '0755' ? 0o755 : 0o644);
}

async function inspectPayload(candidateRoot: string): Promise<ManifestFile[]> {
  const actualPaths = (await collectFiles(candidateRoot)).filter(path => path !== CANDIDATE_MANIFEST_PATH);
  const expectedPaths = CANDIDATE_MAPPINGS.map(mapping => mapping.target);
  if (JSON.stringify(actualPaths) !== JSON.stringify(expectedPaths)) {
    throw new Error(`candidate inventory mismatch\nexpected: ${expectedPaths.join('\n')}\nactual: ${actualPaths.join('\n')}`);
  }
  const files: ManifestFile[] = [];
  for (const path of actualPaths) {
    rejectForbiddenCandidatePath(path);
    await assertRegularUnlinkedPath(candidateRoot, path);
    const contents = await readFile(join(candidateRoot, path));
    const firstLine = contents.toString('utf8').split(/\r?\n/, 1)[0] ?? '';
    const expectedShebang = SHEBANGS.get(path);
    if (expectedShebang && firstLine !== expectedShebang) throw new Error(`wrong shebang: ${path}`);
    if (!expectedShebang && firstLine.startsWith('#!')) throw new Error(`undeclared shebang: ${path}`);
    const mode = normalizedMode(path);
    const observedMode = (await lstat(join(candidateRoot, path))).mode & 0o777;
    if (observedMode !== (mode === '0755' ? 0o755 : 0o644)) throw new Error(`wrong mode: ${path}`);
    files.push({ mode, path, sha256: sha256(contents), size: contents.byteLength });
  }
  return files;
}

async function assertMappingContracts(repositoryRoot: string, candidateRoot: string, requirePublicParity: boolean): Promise<void> {
  const targets = CANDIDATE_MAPPINGS.map(mapping => mapping.target);
  if (new Set(targets).size !== targets.length) throw new Error('candidate mappings contain duplicate targets');
  for (const mapping of MIRRORED_MODULES) {
    if (mapping.emitted !== expectedEmittedPath(mapping.source) || mapping.target !== mapping.emitted) {
      throw new Error(`invalid source-to-emit mapping: ${mapping.source}`);
    }
  }
  await assertProductionInventory(repositoryRoot);
  for (const mapping of MIRRORED_MODULES) {
    await assertRegularUnlinkedPath(repositoryRoot, mapping.source);
    await assertRegularUnlinkedPath(join(repositoryRoot, '.naru-build', 'emit'), mapping.emitted);
    const [emitted, candidate] = await Promise.all([
      readFile(join(repositoryRoot, '.naru-build', 'emit', mapping.emitted)),
      readFile(join(candidateRoot, mapping.target)),
    ]);
    if (!emitted.equals(candidate)) throw new Error(`emit/candidate mirror mismatch: ${mapping.target}`);
    if (requirePublicParity) {
      await assertRegularUnlinkedPath(repositoryRoot, mapping.target);
      if (!emitted.equals(await readFile(join(repositoryRoot, mapping.target)))) throw new Error(`emit/public mirror mismatch: ${mapping.target}`);
    }
  }
}

export async function assembleCandidate(repositoryRoot = process.cwd()): Promise<CandidateManifest> {
  const buildRoot = join(repositoryRoot, '.naru-build');
  const stagingRoot = join(buildRoot, 'staging');
  const candidateRoot = join(buildRoot, 'candidate');
  await rm(stagingRoot, { force: true, recursive: true });
  await rm(candidateRoot, { force: true, recursive: true });
  await mkdir(stagingRoot, { recursive: true });
  for (const mapping of CANDIDATE_MAPPINGS) await copyMappedFile(repositoryRoot, stagingRoot, mapping);
  const files = await inspectPayload(stagingRoot);
  const manifest = canonicalManifest(files);
  await writeFile(join(stagingRoot, CANDIDATE_MANIFEST_PATH), manifestText(manifest), { flag: 'wx' });
  await chmod(join(stagingRoot, CANDIDATE_MANIFEST_PATH), 0o644);
  await assertMappingContracts(repositoryRoot, stagingRoot, false);
  await rename(stagingRoot, candidateRoot);
  return manifest;
}

export async function checkCandidate(repositoryRoot = process.cwd(), requirePublicParity = true): Promise<CandidateManifest> {
  const candidateRoot = join(repositoryRoot, '.naru-build', 'candidate');
  const actualPaths = await collectFiles(candidateRoot);
  const expectedPaths = [...CANDIDATE_MAPPINGS.map(mapping => mapping.target), CANDIDATE_MANIFEST_PATH].sort();
  if (JSON.stringify(actualPaths) !== JSON.stringify(expectedPaths)) throw new Error('candidate inventory or manifest placement mismatch');
  const files = await inspectPayload(candidateRoot);
  const expected = canonicalManifest(files);
  const actualText = await readFile(join(candidateRoot, CANDIDATE_MANIFEST_PATH), 'utf8');
  if (actualText !== manifestText(expected)) throw new Error('candidate manifest is not canonical or does not match payload');
  const manifestMode = (await lstat(join(candidateRoot, CANDIDATE_MANIFEST_PATH))).mode & 0o777;
  if (manifestMode !== 0o644) throw new Error('candidate manifest has wrong mode');
  await assertMappingContracts(repositoryRoot, candidateRoot, requirePublicParity);
  return expected;
}

export async function syncCandidate(repositoryRoot = process.cwd()): Promise<void> {
  await checkCandidate(repositoryRoot, false);
  const candidateRoot = join(repositoryRoot, '.naru-build', 'candidate');
  const syncRoot = join(repositoryRoot, '.naru-build', 'sync');
  await rm(syncRoot, { force: true, recursive: true });
  for (const mapping of MIRRORED_MODULES) {
    const candidate = await readFile(join(candidateRoot, mapping.target));
    const publicPath = join(repositoryRoot, mapping.target);
    const current = await readOptional(publicPath);
    if (current && candidate.equals(current)) continue;
    const staged = join(syncRoot, mapping.target);
    await mkdir(dirname(staged), { recursive: true });
    await writeFile(staged, candidate, { flag: 'wx' });
    await chmod(staged, normalizedMode(mapping.target) === '0755' ? 0o755 : 0o644);
    await rename(staged, publicPath);
  }
  await rm(syncRoot, { force: true, recursive: true });
  await checkCandidate(repositoryRoot);
}

async function main(): Promise<void> {
  const mode = process.argv[2];
  if (mode === 'candidate') await assembleCandidate();
  else if (mode === 'check') await checkCandidate();
  else if (mode === 'sync') await syncCandidate();
  else throw new Error('usage: candidate-assembler.js candidate|check|sync');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
