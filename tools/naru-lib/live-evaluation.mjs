import { createHash } from 'node:crypto';
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { arch, platform, tmpdir } from 'node:os';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  APPROVED_EVALUATION_CASE_IDS,
  validateReusableEvaluationSpecificationV3,
} from './evaluation.mjs';

const MAX_CONTRACT_BYTES = 256 * 1024;
const MAX_FIXTURE_FILES = 64;
const MAX_FIXTURE_FILE_BYTES = 16 * 1024;
const MAX_FIXTURE_BYTES = 64 * 1024;
const MAX_FIXTURE_DEPTH = 6;
const MAX_DESCENDANTS = 32;
const MAX_REQUESTS = 512;
const MAX_CAPTURE_BYTES = 1024 * 1024;
const MAX_REPETITIONS = 3;
const MAX_CASE_TIMEOUT_MS = 30 * 60 * 1000;
const MAX_RUN_TIMEOUT_MS = 2 * 60 * 60 * 1000;
const MAX_TOKEN_COUNT = 2_000_000;
const MAX_SPEND_USD_MICROS = 100_000_000;
const MAX_CANDIDATE_ARTIFACTS = 64;
const MAX_CANDIDATE_ARTIFACT_BYTES = 512 * 1024;
const MAX_CANDIDATE_BYTES = 4 * 1024 * 1024;
const SAFE_ENV_KEYS = Object.freeze(['LANG', 'LC_ALL', 'NO_COLOR', 'PATH', 'TERM', 'TZ']);
const OWNED_ENV_KEYS = new Set([
  'HOME', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME',
  'OPENCODE_CONFIG_DIR', 'OPENCODE_SESSION_DIR', 'NARU_WORKTREE_ROOT', 'TMPDIR',
]);
const ENV_NAME = /^[A-Z][A-Z0-9_]{0,127}$/;
const SECRET_NAME = /(?:^|[._-])(?:auth|credentials?|id_rsa|password|secrets?|tokens?)(?:$|[._-])/i;
const DEPENDENCY_NAME = /^(?:node_modules|vendor|\.git|package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|yarn\.lock)$/i;
const SECRET_CONTENT = /(?:gh[pousr]_[A-Za-z0-9_]{20,}|bearer\s+\S+|authorization\s*[:=]|(?:api[_-]?key|password|secret|token)\s*[:=]\s*\S+)/i;
const REMOTE_CONTENT = /(?:https?|ssh|git):\/\/|git@[A-Za-z0-9.-]+:|\bgithub\.com\//i;
const SHA256 = /^[a-f0-9]{64}$/;
const SAFE_ID = /^[A-Za-z0-9](?:[A-Za-z0-9._:-]*[A-Za-z0-9])?$/;
const STOP_CODES = new Set([
  'authorization-failure',
  'cancelled',
  'capture-limit',
  'cleanup-failure',
  'cost-missing',
  'cost-limit',
  'deadline',
  'execution-failure',
  'mutation-detected',
  'request-limit',
  'safety-failure',
  'session-limit',
  'timeout',
  'token-limit',
]);
const SAFETY_FIELDS = Object.freeze([
  'deadlineMet',
  'networkContained',
  'noPersistentDataWrite',
  'noPost',
  'noRawOutput',
  'noSecret',
  'scopeContained',
]);
const ATTESTATION_STATUSES = new Set(['observed', 'unknown', 'not-enforced', 'failed']);

export const NARU_RUNTIME_ARTIFACT_PATHS = Object.freeze([
  'scripts/naru-live-eval.mjs',
  'tools/naru-lib/evaluation.mjs',
  'tools/naru-lib/live-evaluation.mjs',
  'tools/naru-lib/opencode-live-evaluation.mjs',
]);
const DEFAULT_CANDIDATE_ROOT = fileURLToPath(new URL('../..', import.meta.url));

export const LIVE_RUN_CONTRACT_SCHEMA_VERSION = 1;
export const LIVE_RUN_ENVELOPE_SCHEMA_VERSION = 1;
export const LIVE_EVALUATION_REDACTION = Object.freeze({
  prompts: 'omitted',
  source: 'omitted',
  diffs: 'omitted',
  outputs: 'omitted',
  errors: 'coded',
  paths: 'omitted',
  credentials: 'omitted',
  sessionIds: 'omitted',
});
export const LIVE_EVALUATION_CASES = Object.freeze(Object.fromEntries(
  APPROVED_EVALUATION_CASE_IDS.map((id) => [id, Object.freeze({ id })]),
));

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function exact(value, fields, label) {
  if (!isPlainObject(value)) throw new Error(`${label} must be a plain object`);
  const allowed = new Set(fields);
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  const missing = fields.filter((key) => !Object.hasOwn(value, key));
  if (unknown.length) throw new Error(`${label} contains unknown fields: ${unknown.sort().join(', ')}`);
  if (missing.length) throw new Error(`${label} is missing required fields: ${missing.join(', ')}`);
}

function integer(value, label, minimum, maximum) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${label} must be an integer from ${minimum} to ${maximum}`);
  }
  return value;
}

function boolean(value, label) {
  if (value !== true && value !== false) throw new Error(`${label} must be a boolean`);
  return value;
}

function id(value, label) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 128 || !SAFE_ID.test(value)) {
    throw new Error(`${label} must be a safe identifier`);
  }
  return value;
}

function digest(value) {
  return createHash('sha256').update(value).digest('hex');
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (isPlainObject(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function sha256Canonical(value) {
  return digest(canonicalJson(value));
}

function assertSha(value, label) {
  if (typeof value !== 'string' || !SHA256.test(value)) throw new Error(`${label} must be a lowercase SHA-256 digest`);
  return value;
}

function assertIdArray(value, label, expected) {
  if (!Array.isArray(value) || value.length === 0 || value.length > 32) throw new Error(`${label} must be a bounded non-empty array`);
  const result = value.map((entry, index) => id(entry, `${label}[${index}]`));
  if (new Set(result).size !== result.length) throw new Error(`${label} must contain unique identifiers`);
  if (expected && (result.length !== expected.length || result.some((entry, index) => entry !== expected[index]))) {
    throw new Error(`${label} must match the reusable specification order`);
  }
  return result;
}

function validateEnvironmentKeys(value, label) {
  if (!Array.isArray(value) || value.length > 32) throw new Error(`${label} must be a bounded array`);
  const result = value.map((entry, index) => {
    if (typeof entry !== 'string' || !ENV_NAME.test(entry) || OWNED_ENV_KEYS.has(entry)) {
      throw new Error(`${label}[${index}] must be an explicitly permitted environment variable name`);
    }
    return entry;
  });
  if (new Set(result).size !== result.length) throw new Error(`${label} must contain unique names`);
  return [...result].sort();
}

function assertContained(root, candidate, label) {
  const rel = relative(root, candidate);
  if (rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !rel.startsWith(sep))) return;
  throw new Error(`${label} escaped its owned root`);
}

function validateCandidateArtifactPath(value, label) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 256
    || value.includes('\\') || value.startsWith('/') || value.endsWith('/')) {
    throw new Error(`${label} must be a bounded relative POSIX path`);
  }
  const parts = value.split('/');
  if (parts.some((part) => !part || part === '.' || part === '..' || SECRET_NAME.test(part)
    || DEPENDENCY_NAME.test(part) || part === '.env')) {
    throw new Error(`${label} contains an unknown or prohibited path component`);
  }
  return value;
}

export async function inspectCandidateArtifacts(
  candidateRoot = DEFAULT_CANDIDATE_ROOT,
  artifactPaths = NARU_RUNTIME_ARTIFACT_PATHS,
) {
  if (typeof candidateRoot !== 'string' || !candidateRoot) throw new Error('candidate root is required');
  if (!Array.isArray(artifactPaths) || artifactPaths.length === 0 || artifactPaths.length > MAX_CANDIDATE_ARTIFACTS) {
    throw new Error('candidate artifact paths must be a bounded non-empty array');
  }
  const paths = artifactPaths.map((entry, index) => validateCandidateArtifactPath(entry, `candidate artifact paths[${index}]`));
  if (new Set(paths).size !== paths.length) throw new Error('candidate artifact paths must be unique');
  const root = resolve(candidateRoot);
  const rootMetadata = await lstat(root);
  if (rootMetadata.isSymbolicLink() || !rootMetadata.isDirectory()) throw new Error('candidate root must be a real directory');
  const canonicalRoot = await realpath(root);
  const artifacts = [];
  let totalBytes = 0;
  for (const path of [...paths].sort()) {
    const source = resolve(canonicalRoot, ...path.split('/'));
    assertContained(canonicalRoot, source, 'candidate artifact');
    const metadata = await lstat(source);
    if (metadata.isSymbolicLink() || !metadata.isFile()) throw new Error(`candidate artifact must be a regular non-symlink file: ${path}`);
    if (metadata.size > MAX_CANDIDATE_ARTIFACT_BYTES) {
      throw new Error(`candidate artifact exceeds ${MAX_CANDIDATE_ARTIFACT_BYTES} bytes: ${path}`);
    }
    totalBytes += metadata.size;
    if (totalBytes > MAX_CANDIDATE_BYTES) throw new Error(`candidate artifacts exceed ${MAX_CANDIDATE_BYTES} bytes`);
    const bytes = await readFile(source);
    artifacts.push({ path, size: bytes.length, digest: digest(bytes) });
  }
  return { digest: sha256Canonical(artifacts), totalBytes, artifacts };
}

async function exists(path) {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

function validateFixtureText(text, path) {
  if (text.includes('\u0000') || text.includes('\ufffd')) throw new Error(`fixture file ${path} must be bounded UTF-8 text`);
  if (SECRET_CONTENT.test(text)) throw new Error(`fixture file ${path} contains secret-like content`);
  if (REMOTE_CONTENT.test(text)) throw new Error(`fixture file ${path} contains a remote reference`);
  if (/"(?:dependencies|devDependencies|peerDependencies|optionalDependencies)"\s*:/i.test(text)) {
    throw new Error(`fixture file ${path} declares dependencies`);
  }
}

async function inspectDirectory(root, current, entries, depth) {
  if (depth > MAX_FIXTURE_DEPTH) throw new Error(`fixture exceeds maximum depth ${MAX_FIXTURE_DEPTH}`);
  const children = await readdir(current, { withFileTypes: true });
  children.sort((left, right) => left.name.localeCompare(right.name));
  for (const child of children) {
    if (child.name === '.' || child.name === '..' || child.name.includes(sep)
      || SECRET_NAME.test(child.name) || DEPENDENCY_NAME.test(child.name) || child.name === '.env') {
      throw new Error(`fixture contains prohibited path name: ${child.name}`);
    }
    const path = join(current, child.name);
    assertContained(root, path, 'fixture path');
    const metadata = await lstat(path);
    if (metadata.isSymbolicLink()) throw new Error(`fixture contains a symbolic link: ${child.name}`);
    if (metadata.isDirectory()) {
      await inspectDirectory(root, path, entries, depth + 1);
      continue;
    }
    if (!metadata.isFile()) throw new Error(`fixture contains a non-regular file: ${child.name}`);
    if (metadata.size > MAX_FIXTURE_FILE_BYTES) throw new Error(`fixture file exceeds ${MAX_FIXTURE_FILE_BYTES} bytes: ${child.name}`);
    if (entries.length >= MAX_FIXTURE_FILES) throw new Error(`fixture exceeds ${MAX_FIXTURE_FILES} files`);
    const bytes = await readFile(path);
    const text = bytes.toString('utf8');
    validateFixtureText(text, relative(root, path));
    entries.push({ path: relative(root, path).split(sep).join('/'), bytes, digest: digest(bytes) });
  }
}

export async function inspectSyntheticFixture(fixturesRoot, fixture) {
  if (typeof fixturesRoot !== 'string' || !fixturesRoot) throw new Error('fixtures root is required');
  if (!isPlainObject(fixture) || typeof fixture.path !== 'string' || !/^[a-z0-9][a-z0-9-]*$/.test(fixture.path)) {
    throw new Error('fixture path must be one safe relative directory name');
  }
  const root = resolve(fixturesRoot);
  const rootMetadata = await lstat(root);
  if (rootMetadata.isSymbolicLink() || !rootMetadata.isDirectory()) throw new Error('fixtures root must be a real directory');
  const source = resolve(root, fixture.path);
  assertContained(root, source, 'fixture source');
  const sourceMetadata = await lstat(source);
  if (sourceMetadata.isSymbolicLink() || !sourceMetadata.isDirectory()) throw new Error('fixture source must be a real directory');
  const canonicalRoot = await realpath(root);
  const canonicalSource = await realpath(source);
  assertContained(canonicalRoot, canonicalSource, 'fixture source');
  const entries = [];
  await inspectDirectory(canonicalSource, canonicalSource, entries, 0);
  const totalBytes = entries.reduce((sum, entry) => sum + entry.bytes.length, 0);
  if (totalBytes > MAX_FIXTURE_BYTES) throw new Error(`fixture exceeds ${MAX_FIXTURE_BYTES} bytes`);
  if (entries.length === 0) throw new Error('fixture must contain at least one file');
  return {
    id: id(fixture.id, 'fixture.id'),
    source: canonicalSource,
    fileCount: entries.length,
    totalBytes,
    digest: sha256Canonical(entries.map(({ path, digest: fileDigest }) => ({ path, digest: fileDigest }))),
    entries,
  };
}

export function createIsolatedLiveEnvironment(baseEnvironment, layout, allowedEnvironmentKeys = []) {
  if (baseEnvironment === null || typeof baseEnvironment !== 'object' || Array.isArray(baseEnvironment)) {
    throw new Error('base environment must be an object');
  }
  exact(layout, ['home', 'xdgConfig', 'xdgCache', 'xdgData', 'xdgState', 'opencode', 'sessions', 'worktrees', 'tmp'], 'isolated layout');
  const allowedKeys = validateEnvironmentKeys(allowedEnvironmentKeys, 'allowed environment keys');
  const environment = {};
  for (const key of [...new Set([...SAFE_ENV_KEYS, ...allowedKeys])]) {
    if (typeof baseEnvironment[key] === 'string' && baseEnvironment[key].length <= 4096) environment[key] = baseEnvironment[key];
  }
  return {
    ...environment,
    HOME: layout.home,
    XDG_CONFIG_HOME: layout.xdgConfig,
    XDG_CACHE_HOME: layout.xdgCache,
    XDG_DATA_HOME: layout.xdgData,
    XDG_STATE_HOME: layout.xdgState,
    OPENCODE_CONFIG_DIR: layout.opencode,
    OPENCODE_SESSION_DIR: layout.sessions,
    NARU_WORKTREE_ROOT: layout.worktrees,
    TMPDIR: layout.tmp,
    NO_COLOR: '1',
  };
}

export async function materializeSyntheticFixture({
  fixturesRoot,
  fixture,
  temporaryParent = tmpdir(),
  baseEnvironment = process.env,
  allowedEnvironmentKeys = [],
} = {}) {
  const inspected = await inspectSyntheticFixture(fixturesRoot, fixture);
  const parentMetadata = await stat(temporaryParent);
  if (!parentMetadata.isDirectory()) throw new Error('temporary parent must be a directory');
  const runnerRoot = await mkdtemp(join(resolve(temporaryParent), 'naru-live-eval-'));
  await chmod(runnerRoot, 0o700);
  const layout = Object.fromEntries([
    ['home', 'home'],
    ['xdgConfig', 'xdg/config'],
    ['xdgCache', 'xdg/cache'],
    ['xdgData', 'xdg/data'],
    ['xdgState', 'xdg/state'],
    ['opencode', 'opencode'],
    ['sessions', 'sessions'],
    ['worktrees', 'worktrees'],
    ['tmp', 'tmp'],
  ].map(([key, part]) => [key, join(runnerRoot, part)]));
  const workspace = join(runnerRoot, 'workspace');
  try {
    for (const path of [...Object.values(layout), workspace]) {
      assertContained(runnerRoot, path, 'sandbox path');
      await mkdir(path, { recursive: true, mode: 0o700 });
      await chmod(path, 0o700);
    }
    for (const entry of inspected.entries) {
      const destination = resolve(workspace, entry.path);
      assertContained(workspace, destination, 'fixture destination');
      await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
      await writeFile(destination, entry.bytes, { mode: 0o600, flag: 'wx' });
    }
  } catch (error) {
    await rm(runnerRoot, { recursive: true, force: true });
    throw error;
  }
  let cleaned = false;
  return {
    runnerRoot,
    workspace,
    environment: createIsolatedLiveEnvironment(baseEnvironment, layout, allowedEnvironmentKeys),
    fixtureDigest: inspected.digest,
    async audit() {
      const current = await inspectSyntheticFixture(runnerRoot, { id: fixture.id, path: basename(workspace) });
      return { beforeDigest: inspected.digest, afterDigest: current.digest, changed: inspected.digest !== current.digest };
    },
    async cleanup() {
      if (!cleaned) {
        cleaned = true;
        await rm(runnerRoot, { recursive: true, force: true, maxRetries: 2 });
      }
      if (await exists(runnerRoot)) throw new Error('runner-owned disposable root cleanup could not be verified');
      return { attempted: true, complete: true };
    },
  };
}

function validateCandidate(value, label) {
  exact(value, ['id', 'revision', 'digest', 'artifacts'], label);
  if (!Array.isArray(value.artifacts) || value.artifacts.length === 0 || value.artifacts.length > MAX_CANDIDATE_ARTIFACTS) {
    throw new Error(`${label}.artifacts must be a bounded non-empty array`);
  }
  const artifacts = value.artifacts.map((entry, index) => {
    const entryLabel = `${label}.artifacts[${index}]`;
    exact(entry, ['path', 'size', 'digest'], entryLabel);
    return {
      path: validateCandidateArtifactPath(entry.path, `${entryLabel}.path`),
      size: integer(entry.size, `${entryLabel}.size`, 0, MAX_CANDIDATE_ARTIFACT_BYTES),
      digest: assertSha(entry.digest, `${entryLabel}.digest`),
    };
  });
  if (new Set(artifacts.map((entry) => entry.path)).size !== artifacts.length
    || artifacts.some((entry, index) => index > 0 && artifacts[index - 1].path.localeCompare(entry.path) >= 0)) {
    throw new Error(`${label}.artifacts must contain unique paths in canonical order`);
  }
  const candidate = {
    id: id(value.id, `${label}.id`),
    revision: id(value.revision, `${label}.revision`),
    digest: assertSha(value.digest, `${label}.digest`),
    artifacts,
  };
  if (sha256Canonical(artifacts) !== candidate.digest) throw new Error(`${label}.digest does not match artifact bytes`);
  return candidate;
}

function validateNamedVersion(value, label) {
  exact(value, ['id', 'version'], label);
  return { id: id(value.id, `${label}.id`), version: id(value.version, `${label}.version`) };
}

function validateOpenCode(value, label) {
  exact(value, ['id', 'version', 'executableDigest'], label);
  return {
    id: id(value.id, `${label}.id`),
    version: id(value.version, `${label}.version`),
    executableDigest: assertSha(value.executableDigest, `${label}.executableDigest`),
  };
}

function validateProvenance(value, label) {
  exact(value, ['operatingSystem', 'architecture', 'utcDate'], label);
  const result = {
    operatingSystem: id(value.operatingSystem, `${label}.operatingSystem`),
    architecture: id(value.architecture, `${label}.architecture`),
    utcDate: value.utcDate,
  };
  if (typeof result.utcDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(result.utcDate)
    || Number.isNaN(Date.parse(`${result.utcDate}T00:00:00Z`))
    || new Date(`${result.utcDate}T00:00:00Z`).toISOString().slice(0, 10) !== result.utcDate) {
    throw new Error(`${label}.utcDate must use YYYY-MM-DD`);
  }
  return result;
}

function validateBaseline(value) {
  if (isPlainObject(value) && value.kind === 'none') {
    exact(value, ['kind'], 'LiveRunContract.baseline');
    return { kind: 'none' };
  }
  exact(value, ['kind', 'sameInputs', 'sameEnvironment', 'sameTimeout', 'sameModel', 'sameRubric', 'topologyException'], 'LiveRunContract.baseline');
  if (value.kind !== 'single-agent-opencode' || value.topologyException !== 'single-agent-only'
    || ['sameInputs', 'sameEnvironment', 'sameTimeout', 'sameModel', 'sameRubric'].some((field) => value[field] !== true)) {
    throw new Error('LiveRunContract.baseline must be none or matched except for single-agent topology');
  }
  return { ...value };
}

function validateContractWithoutDigest(value) {
  exact(value, [
    'schemaVersion', 'candidate', 'specificationDigest', 'fixtureDigests', 'opencode', 'provider', 'model',
    'provenance', 'environment', 'case', 'repetition', 'timeout', 'session', 'request', 'token', 'spend', 'network', 'baseline',
    'mutation', 'cleanup',
  ], 'LiveRunContract');
  if (value.schemaVersion !== LIVE_RUN_CONTRACT_SCHEMA_VERSION) throw new Error('LiveRunContract.schemaVersion must be 1');
  if (!isPlainObject(value.fixtureDigests)) throw new Error('LiveRunContract.fixtureDigests must be a plain object');
  const fixtureDigests = Object.fromEntries(Object.entries(value.fixtureDigests).map(([key, entry]) => [
    id(key, 'LiveRunContract.fixtureDigests key'),
    assertSha(entry, `LiveRunContract.fixtureDigests.${key}`),
  ]));
  exact(value.case, ['ids'], 'LiveRunContract.case');
  const caseIds = assertIdArray(value.case.ids, 'LiveRunContract.case.ids');
  if (Object.keys(fixtureDigests).length !== caseIds.length || caseIds.some((caseId) => !fixtureDigests[caseId])) {
    throw new Error('LiveRunContract.fixtureDigests must exactly cover case IDs');
  }
  exact(value.repetition, ['count'], 'LiveRunContract.repetition');
  exact(value.timeout, ['caseMs', 'runMs'], 'LiveRunContract.timeout');
  const timeout = {
    caseMs: integer(value.timeout.caseMs, 'LiveRunContract.timeout.caseMs', 100, MAX_CASE_TIMEOUT_MS),
    runMs: integer(value.timeout.runMs, 'LiveRunContract.timeout.runMs', 100, MAX_RUN_TIMEOUT_MS),
  };
  const repetition = { count: integer(value.repetition.count, 'LiveRunContract.repetition.count', 1, MAX_REPETITIONS) };
  const baseline = validateBaseline(value.baseline);
  const topologyCount = baseline.kind === 'none' ? 1 : 2;
  if (timeout.runMs < timeout.caseMs * caseIds.length * repetition.count * topologyCount) {
    throw new Error('LiveRunContract.timeout.runMs must cover every sequential candidate and baseline run');
  }
  exact(value.session, ['maxDescendants', 'maxDepth'], 'LiveRunContract.session');
  const session = {
    maxDescendants: integer(value.session.maxDescendants, 'LiveRunContract.session.maxDescendants', 0, MAX_DESCENDANTS),
    maxDepth: integer(value.session.maxDepth, 'LiveRunContract.session.maxDepth', 0, 8),
  };
  exact(value.request, ['maxCount', 'maxCaptureBytes', 'timeoutMs'], 'LiveRunContract.request');
  const request = {
    maxCount: integer(value.request.maxCount, 'LiveRunContract.request.maxCount', 1, MAX_REQUESTS),
    maxCaptureBytes: integer(value.request.maxCaptureBytes, 'LiveRunContract.request.maxCaptureBytes', 1, MAX_CAPTURE_BYTES),
    timeoutMs: integer(value.request.timeoutMs, 'LiveRunContract.request.timeoutMs', 50, timeout.caseMs),
  };
  exact(value.token, ['maxInput', 'maxOutput'], 'LiveRunContract.token');
  const token = {
    maxInput: integer(value.token.maxInput, 'LiveRunContract.token.maxInput', 0, MAX_TOKEN_COUNT),
    maxOutput: integer(value.token.maxOutput, 'LiveRunContract.token.maxOutput', 0, MAX_TOKEN_COUNT),
  };
  exact(value.spend, ['maxUsdMicros', 'maxCostPerRequestUsdMicros'], 'LiveRunContract.spend');
  const spend = {
    maxUsdMicros: integer(value.spend.maxUsdMicros, 'LiveRunContract.spend.maxUsdMicros', 0, MAX_SPEND_USD_MICROS),
    maxCostPerRequestUsdMicros: integer(value.spend.maxCostPerRequestUsdMicros, 'LiveRunContract.spend.maxCostPerRequestUsdMicros', 0, MAX_SPEND_USD_MICROS),
  };
  if (spend.maxCostPerRequestUsdMicros > spend.maxUsdMicros) {
    throw new Error('LiveRunContract.spend.maxCostPerRequestUsdMicros must not exceed the total spend limit');
  }
  exact(value.network, ['mode', 'target'], 'LiveRunContract.network');
  if (!['none', 'provider'].includes(value.network.mode)) throw new Error('LiveRunContract.network.mode is invalid');
  if (value.network.mode === 'none' && value.network.target !== 'none') throw new Error('network target must be none when networking is disabled');
  if (value.network.mode === 'provider') id(value.network.target, 'LiveRunContract.network.target');
  const provider = validateNamedVersion(value.provider, 'LiveRunContract.provider');
  if ((provider.id === 'none') !== (value.network.mode === 'none')) {
    throw new Error('LiveRunContract provider and network mode must agree');
  }
  if (value.network.mode === 'provider' && value.network.target !== provider.id) {
    throw new Error('LiveRunContract network target must exactly match the provider ID');
  }
  if (provider.id !== 'none' && spend.maxCostPerRequestUsdMicros === 0) {
    throw new Error('LiveRunContract provider execution requires a positive per-request cost reservation');
  }
  exact(value.environment, ['allowedKeys'], 'LiveRunContract.environment');
  const environment = { allowedKeys: validateEnvironmentKeys(value.environment.allowedKeys, 'LiveRunContract.environment.allowedKeys') };
  exact(value.mutation, ['fixtureOnly', 'allowedCaseIds'], 'LiveRunContract.mutation');
  if (value.mutation.fixtureOnly !== true) throw new Error('LiveRunContract.mutation.fixtureOnly must be true');
  const allowedCaseIds = Array.isArray(value.mutation.allowedCaseIds)
    ? value.mutation.allowedCaseIds.map((entry, index) => id(entry, `LiveRunContract.mutation.allowedCaseIds[${index}]`))
    : (() => { throw new Error('LiveRunContract.mutation.allowedCaseIds must be an array'); })();
  if (allowedCaseIds.some((entry) => !caseIds.includes(entry)) || new Set(allowedCaseIds).size !== allowedCaseIds.length) {
    throw new Error('LiveRunContract.mutation.allowedCaseIds must be unique selected cases');
  }
  exact(value.cleanup, ['required', 'verify'], 'LiveRunContract.cleanup');
  if (value.cleanup.required !== true || value.cleanup.verify !== true) throw new Error('LiveRunContract.cleanup must require verified cleanup');
  return {
    schemaVersion: LIVE_RUN_CONTRACT_SCHEMA_VERSION,
    candidate: validateCandidate(value.candidate, 'LiveRunContract.candidate'),
    specificationDigest: assertSha(value.specificationDigest, 'LiveRunContract.specificationDigest'),
    fixtureDigests,
    opencode: validateOpenCode(value.opencode, 'LiveRunContract.opencode'),
    provider,
    model: validateNamedVersion(value.model, 'LiveRunContract.model'),
    provenance: validateProvenance(value.provenance, 'LiveRunContract.provenance'),
    environment,
    case: { ids: caseIds },
    repetition,
    timeout,
    session,
    request,
    token,
    spend,
    network: { mode: value.network.mode, target: value.network.target },
    baseline,
    mutation: { fixtureOnly: true, allowedCaseIds },
    cleanup: { required: true, verify: true },
  };
}

export function validateLiveRunContract(value) {
  exact(value, [
    'schemaVersion', 'candidate', 'specificationDigest', 'fixtureDigests', 'opencode', 'provider', 'model',
    'provenance', 'environment', 'case', 'repetition', 'timeout', 'session', 'request', 'token', 'spend', 'network', 'baseline',
    'mutation', 'cleanup', 'contractDigest',
  ], 'LiveRunContract');
  const { contractDigest, ...withoutDigest } = value;
  const validated = validateContractWithoutDigest(withoutDigest);
  assertSha(contractDigest, 'LiveRunContract.contractDigest');
  if (sha256Canonical(validated) !== contractDigest) throw new Error('LiveRunContract.contractDigest does not match contract content');
  return { ...validated, contractDigest };
}

export async function createLiveRunContract({
  specification,
  fixturesRoot,
  candidate,
  opencode,
  provider,
  model,
  repetitions = 1,
  caseTimeoutMs = 60_000,
  requestTimeoutMs = 30_000,
  maxRequestCount = 128,
  maxCaptureBytes = 256 * 1024,
  maxInputTokens = 200_000,
  maxOutputTokens = 100_000,
  maxSpendUsdMicros = 0,
  maxCostPerRequestUsdMicros = 0,
  network = { mode: 'none', target: 'none' },
  baselineKind = 'single-agent-opencode',
  allowedEnvironmentKeys = [],
  candidateRoot = DEFAULT_CANDIDATE_ROOT,
  candidateArtifactPaths = NARU_RUNTIME_ARTIFACT_PATHS,
  provenance = {
    operatingSystem: platform(),
    architecture: arch(),
    utcDate: new Date().toISOString().slice(0, 10),
  },
} = {}) {
  const spec = validateReusableEvaluationSpecificationV3(specification);
  exact(candidate, ['id', 'revision', 'digest'], 'candidate');
  const inspectedCandidate = await inspectCandidateArtifacts(candidateRoot, candidateArtifactPaths);
  if (candidate.digest !== inspectedCandidate.digest) throw new Error('candidate digest does not match declared artifact bytes');
  const fixtureDigests = {};
  for (const entry of spec.cases) {
    fixtureDigests[entry.id] = (await inspectSyntheticFixture(fixturesRoot, entry.fixture)).digest;
  }
  const withoutDigest = validateContractWithoutDigest({
    schemaVersion: LIVE_RUN_CONTRACT_SCHEMA_VERSION,
    candidate: { ...candidate, artifacts: inspectedCandidate.artifacts },
    specificationDigest: sha256Canonical(spec),
    fixtureDigests,
    opencode,
    provider,
    model,
    provenance,
    environment: { allowedKeys: allowedEnvironmentKeys },
    case: { ids: spec.cases.map((entry) => entry.id) },
    repetition: { count: repetitions },
    timeout: { caseMs: caseTimeoutMs, runMs: caseTimeoutMs * spec.cases.length * repetitions * (baselineKind === 'none' ? 1 : 2) },
    session: { maxDescendants: 14, maxDepth: 3 },
    request: { maxCount: maxRequestCount, maxCaptureBytes, timeoutMs: requestTimeoutMs },
    token: { maxInput: maxInputTokens, maxOutput: maxOutputTokens },
    spend: { maxUsdMicros: maxSpendUsdMicros, maxCostPerRequestUsdMicros },
    network,
    baseline: baselineKind === 'none' ? { kind: 'none' } : {
      kind: 'single-agent-opencode',
      sameInputs: true,
      sameEnvironment: true,
      sameTimeout: true,
      sameModel: true,
      sameRubric: true,
      topologyException: 'single-agent-only',
    },
    mutation: {
      fixtureOnly: true,
      allowedCaseIds: spec.cases.filter((entry) => entry.fixture.permittedMutation === 'scoped-disposable').map((entry) => entry.id),
    },
    cleanup: { required: true, verify: true },
  });
  return { ...withoutDigest, contractDigest: sha256Canonical(withoutDigest) };
}

export async function loadAuthorizedLiveContract(contractPath, exactSha256Confirmation) {
  if (typeof contractPath !== 'string' || !contractPath) throw new Error('live contract file is required');
  if (typeof exactSha256Confirmation !== 'string' || !SHA256.test(exactSha256Confirmation)) {
    throw new Error('live contract authorization requires an exact lowercase SHA-256 confirmation');
  }
  const metadata = await lstat(contractPath);
  if (metadata.isSymbolicLink() || !metadata.isFile()) throw new Error('live contract must be a regular non-symlink file');
  if (metadata.size > MAX_CONTRACT_BYTES) throw new Error(`live contract exceeds ${MAX_CONTRACT_BYTES} bytes`);
  const bytes = await readFile(contractPath);
  const fileDigest = digest(bytes);
  if (fileDigest !== exactSha256Confirmation) throw new Error('live contract SHA-256 confirmation mismatch');
  let parsed;
  try {
    parsed = JSON.parse(bytes.toString('utf8'));
  } catch {
    throw new Error('live contract file is not valid JSON');
  }
  return { contract: validateLiveRunContract(parsed), fileDigest };
}

export function createLiveRunEnvelope(contract, contractFileDigest) {
  const validatedContract = validateLiveRunContract(contract);
  assertSha(contractFileDigest, 'LiveRunEnvelope.contractFileDigest');
  return {
    schemaVersion: LIVE_RUN_ENVELOPE_SCHEMA_VERSION,
    contract: validatedContract,
    contractDigest: validatedContract.contractDigest,
    contractFileDigest,
  };
}

export function validateLiveRunEnvelope(value) {
  exact(value, ['schemaVersion', 'contract', 'contractDigest', 'contractFileDigest'], 'LiveRunEnvelope');
  if (value.schemaVersion !== LIVE_RUN_ENVELOPE_SCHEMA_VERSION) throw new Error('LiveRunEnvelope.schemaVersion must be 1');
  const contract = validateLiveRunContract(value.contract);
  if (value.contractDigest !== contract.contractDigest) throw new Error('LiveRunEnvelope.contractDigest mismatch');
  return createLiveRunEnvelope(contract, value.contractFileDigest);
}

function boundedMetric(value, label, maximum) {
  return integer(value, label, 0, maximum);
}

function attestationStatus(value, label, positiveStatus = 'unknown') {
  if (value === true) return positiveStatus;
  if (value === false) return 'failed';
  if (!ATTESTATION_STATUSES.has(value)) throw new Error(`${label} must be an attestation status`);
  if (value === 'observed' && positiveStatus !== 'observed') return positiveStatus;
  return value;
}

function combineAttestations(values) {
  if (values.length === 0) return 'unknown';
  if (values.includes('failed')) return 'failed';
  if (values.includes('not-enforced')) return 'not-enforced';
  if (values.includes('unknown')) return 'unknown';
  return 'observed';
}

function validateExecutorResult(value, contract, expectedRubricIds, observed = {}) {
  exact(value, ['passed', 'stopCode', 'metrics', 'usageCostUsdMicros', 'rubric', 'safety', 'limitations'], 'live executor result');
  exact(value.metrics, ['elapsedMs', 'childCount', 'peakConcurrency', 'requestCount', 'capturedBytes', 'inputTokens', 'outputTokens'], 'live executor result.metrics');
  const reportedMetrics = Object.fromEntries(Object.entries(value.metrics).map(([key, entry]) => [key, Math.max(entry, observed[key] ?? 0)]));
  const metrics = {
    elapsedMs: boundedMetric(reportedMetrics.elapsedMs, 'live executor result.metrics.elapsedMs', contract.timeout.caseMs),
    childCount: boundedMetric(reportedMetrics.childCount, 'live executor result.metrics.childCount', contract.session.maxDescendants),
    peakConcurrency: boundedMetric(reportedMetrics.peakConcurrency, 'live executor result.metrics.peakConcurrency', contract.session.maxDescendants),
    requestCount: boundedMetric(reportedMetrics.requestCount, 'live executor result.metrics.requestCount', contract.request.maxCount),
    capturedBytes: boundedMetric(reportedMetrics.capturedBytes, 'live executor result.metrics.capturedBytes', contract.request.maxCaptureBytes),
    inputTokens: boundedMetric(reportedMetrics.inputTokens, 'live executor result.metrics.inputTokens', contract.token.maxInput),
    outputTokens: boundedMetric(reportedMetrics.outputTokens, 'live executor result.metrics.outputTokens', contract.token.maxOutput),
  };
  if (value.stopCode !== null && !STOP_CODES.has(value.stopCode)) throw new Error('live executor result.stopCode is invalid');
  if (value.usageCostUsdMicros !== null) boundedMetric(value.usageCostUsdMicros, 'live executor result.usageCostUsdMicros', MAX_SPEND_USD_MICROS);
  if (!Array.isArray(value.rubric) || value.rubric.length === 0 || value.rubric.length > 32) throw new Error('live executor result.rubric must be bounded');
  const rubricEntries = value.rubric.map((entry, index) => {
    exact(entry, ['id', 'passed'], `live executor result.rubric[${index}]`);
    return { id: id(entry.id, `live executor result.rubric[${index}].id`), passed: boolean(entry.passed, `live executor result.rubric[${index}].passed`) };
  });
  const rubricById = new Map(rubricEntries.map((entry) => [entry.id, entry]));
  if (rubricById.size !== rubricEntries.length || rubricEntries.length !== expectedRubricIds.length
    || expectedRubricIds.some((rubricId) => !rubricById.has(rubricId))) {
    throw new Error('live executor result.rubric must exactly cover the authorized rubric IDs');
  }
  const rubric = expectedRubricIds.map((rubricId) => rubricById.get(rubricId));
  exact(value.safety, SAFETY_FIELDS, 'live executor result.safety');
  const safety = Object.fromEntries(SAFETY_FIELDS.map((field) => [
    field,
    attestationStatus(
      value.safety[field],
      `live executor result.safety.${field}`,
      field === 'deadlineMet' || field === 'noRawOutput' ? 'observed' : 'unknown',
    ),
  ]));
  const limitations = Array.isArray(value.limitations)
    ? value.limitations.map((entry, index) => id(entry, `live executor result.limitations[${index}]`))
    : (() => { throw new Error('live executor result.limitations must be an array'); })();
  if (limitations.length > 16 || new Set(limitations).size !== limitations.length) throw new Error('live executor result.limitations must be bounded and unique');
  return {
    passed: boolean(value.passed, 'live executor result.passed'),
    stopCode: value.stopCode,
    metrics,
    usageCostUsdMicros: value.usageCostUsdMicros,
    rubric,
    safety,
    limitations,
  };
}

function executorLimitStopCode(value, contract) {
  const metrics = value?.metrics;
  if (!isPlainObject(metrics)) return null;
  if (Number.isFinite(metrics.elapsedMs) && metrics.elapsedMs > contract.timeout.caseMs) return 'timeout';
  if ((Number.isFinite(metrics.childCount) && metrics.childCount > contract.session.maxDescendants)
    || (Number.isFinite(metrics.peakConcurrency) && metrics.peakConcurrency > contract.session.maxDescendants)) return 'session-limit';
  if (Number.isFinite(metrics.requestCount) && metrics.requestCount > contract.request.maxCount) return 'request-limit';
  if (Number.isFinite(metrics.capturedBytes) && metrics.capturedBytes > contract.request.maxCaptureBytes) return 'capture-limit';
  if ((Number.isFinite(metrics.inputTokens) && metrics.inputTokens > contract.token.maxInput)
    || (Number.isFinite(metrics.outputTokens) && metrics.outputTokens > contract.token.maxOutput)) return 'token-limit';
  return null;
}

function failureResult(stopCode, elapsedMs = 0, rubricIds = ['execution'], observed = {}) {
  return {
    passed: false,
    stopCode,
    metrics: {
      elapsedMs,
      childCount: observed.childCount ?? 0,
      peakConcurrency: observed.peakConcurrency ?? 0,
      requestCount: observed.requestCount ?? 0,
      capturedBytes: observed.capturedBytes ?? 0,
      inputTokens: observed.inputTokens ?? 0,
      outputTokens: observed.outputTokens ?? 0,
    },
    usageCostUsdMicros: null,
    rubric: rubricIds.map((rubricId) => ({ id: rubricId, passed: false })),
    safety: {
      deadlineMet: ['timeout', 'deadline', 'cancelled'].includes(stopCode) ? 'failed' : 'observed',
      networkContained: 'unknown',
      noPersistentDataWrite: 'unknown',
      noPost: 'unknown',
      noRawOutput: 'observed',
      noSecret: 'unknown',
      scopeContained: 'unknown',
    },
    limitations: ['containment-unattested', 'structural-only'],
  };
}

function publicRun(contract, execution, repetition, baseline, result, cleanup) {
  const safety = {
    ...result.safety,
    scopeContained: cleanup.mutationContained ? result.safety.scopeContained : 'failed',
    cleanupComplete: cleanup.complete,
  };
  return {
    schemaVersion: 1,
    contractDigest: contract.contractDigest,
    candidateId: contract.candidate.id,
    caseId: execution.caseId,
    repetition,
    baseline,
    matchDigest: execution.matchDigest,
    topologyDigest: execution.topologyDigest,
    passed: result.passed && result.stopCode === null && cleanup.complete
      && SAFETY_FIELDS.every((field) => safety[field] === 'observed'),
    stopCode: result.stopCode,
    metrics: result.metrics,
    usageCostUsdMicros: result.usageCostUsdMicros,
    usageCostMissing: result.usageCostUsdMicros === null,
    rubric: result.rubric,
    safety,
    cleanup,
    limitations: result.limitations,
  };
}

function range(values) {
  return values.length ? { minimum: Math.min(...values), maximum: Math.max(...values) } : { minimum: null, maximum: null };
}

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function aggregateRunCohort(runs, expectedRunCount) {
  const stopCodes = Object.fromEntries([...STOP_CODES].sort().map((code) => [code, runs.filter((run) => run.stopCode === code).length]));
  const rubricIds = [...new Set(runs.flatMap((run) => run.rubric.map((entry) => entry.id)))].sort();
  const metricNames = ['elapsedMs', 'childCount', 'peakConcurrency', 'requestCount', 'capturedBytes', 'inputTokens', 'outputTokens'];
  return {
    expectedRunCount,
    completedRunCount: runs.length,
    missingRunCount: Math.max(0, expectedRunCount - runs.length),
    passedRunCount: runs.filter((run) => run.passed).length,
    failedRunCount: runs.filter((run) => !run.passed).length,
    usageCostMissing: runs.some((run) => run.usageCostMissing),
    usageCostUsdMicros: runs.every((run) => !run.usageCostMissing)
      ? runs.reduce((sum, run) => sum + run.usageCostUsdMicros, 0)
      : null,
    stopCodes,
    rubric: rubricIds.map((rubricId) => ({
      id: rubricId,
      passed: runs.filter((run) => run.rubric.some((entry) => entry.id === rubricId && entry.passed)).length,
      evaluated: runs.filter((run) => run.rubric.some((entry) => entry.id === rubricId)).length,
    })),
    safety: {
      ...Object.fromEntries(SAFETY_FIELDS.map((field) => [
        field,
        runs.length === expectedRunCount ? combineAttestations(runs.map((run) => run.safety[field])) : 'unknown',
      ])),
      cleanupComplete: runs.length === expectedRunCount && runs.every((run) => run.safety.cleanupComplete),
    },
    cleanup: {
      complete: runs.length === expectedRunCount && runs.every((run) => run.cleanup.complete),
      mutationContained: runs.length === expectedRunCount && runs.every((run) => run.cleanup.mutationContained),
    },
    medians: Object.fromEntries(metricNames.map((field) => [field, median(runs.map((run) => run.metrics[field]))])),
    ranges: Object.fromEntries(metricNames.map((field) => [field, range(runs.map((run) => run.metrics[field]))])),
    limitations: [...new Set(runs.flatMap((run) => run.limitations))].sort(),
  };
}

export function aggregateSanitizedLiveRuns(contract, runs, aborted) {
  const expectedPerCohort = contract.case.ids.length * contract.repetition.count;
  const candidateRuns = runs.filter((run) => !run.baseline);
  const baselineRuns = runs.filter((run) => run.baseline);
  const candidate = aggregateRunCohort(candidateRuns, expectedPerCohort);
  const baselineRequired = contract.baseline.kind !== 'none';
  const baseline = baselineRequired ? aggregateRunCohort(baselineRuns, expectedPerCohort) : null;
  const candidateByKey = new Map(candidateRuns.map((run) => [`${run.caseId}:${run.repetition}`, run]));
  let missingPairs = 0;
  let mismatchedPairs = 0;
  for (const run of baselineRuns) {
    const candidateRun = candidateByKey.get(`${run.caseId}:${run.repetition}`);
    if (!candidateRun) missingPairs += 1;
    else if (candidateRun.matchDigest !== run.matchDigest) mismatchedPairs += 1;
  }
  if (baselineRequired) missingPairs += Math.max(0, expectedPerCohort - baselineRuns.length);
  const comparison = baselineRequired
    ? {
        status: missingPairs > 0 ? 'missing' : mismatchedPairs > 0 ? 'mismatch' : 'matched',
        passed: missingPairs === 0 && mismatchedPairs === 0,
        expectedPairCount: expectedPerCohort,
        completedPairCount: expectedPerCohort - missingPairs,
        missingPairCount: missingPairs,
        mismatchedPairCount: mismatchedPairs,
      }
    : {
        status: 'not-required', passed: true, expectedPairCount: 0,
        completedPairCount: 0, missingPairCount: 0, mismatchedPairCount: 0,
      };
  const stopCodes = Object.fromEntries([...STOP_CODES].sort().map((code) => [code, runs.filter((run) => run.stopCode === code).length]));
  return {
    schemaVersion: 1,
    contractDigest: contract.contractDigest,
    candidateId: contract.candidate.id,
    caseCount: contract.case.ids.length,
    repetitionCount: contract.repetition.count,
    completedRunCount: runs.length,
    passedRunCount: runs.filter((run) => run.passed).length,
    aborted,
    passed: !aborted && candidate.failedRunCount === 0 && candidate.missingRunCount === 0
      && (!baseline || (baseline.failedRunCount === 0 && baseline.missingRunCount === 0)) && comparison.passed,
    usageCostMissing: runs.some((run) => run.usageCostMissing),
    usageCostUsdMicros: runs.every((run) => !run.usageCostMissing)
      ? runs.reduce((sum, run) => sum + run.usageCostUsdMicros, 0)
      : null,
    stopCodes,
    candidate,
    baseline,
    comparison,
    safety: {
      ...Object.fromEntries(SAFETY_FIELDS.map((field) => [field, combineAttestations(runs.map((run) => run.safety[field]))])),
      cleanupComplete: runs.length > 0 && runs.every((run) => run.safety.cleanupComplete),
    },
    cleanup: {
      complete: runs.every((run) => run.cleanup.complete),
      mutationContained: runs.every((run) => run.cleanup.mutationContained),
    },
    medians: candidate.medians,
    ranges: candidate.ranges,
    limitations: [...new Set(runs.flatMap((run) => run.limitations))].sort(),
  };
}

async function boundedCleanup(operation, timeoutMs = 2_000) {
  let timer;
  try {
    await Promise.race([
      Promise.resolve().then(operation),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('cleanup timeout')), timeoutMs); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function withinTimeout(operation, timeoutMs, externalSignal) {
  const controller = new AbortController();
  const cleanupOperations = [];
  const registerCleanup = (cleanup) => {
    if (typeof cleanup !== 'function') throw new Error('executor cleanup must be a function');
    cleanupOperations.push(cleanup);
  };
  let timer;
  let removeExternalAbort = () => {};
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error('timeout'), { code: 'NARU_LIVE_TIMEOUT' })), timeoutMs);
  });
  const cancellation = new Promise((_, reject) => {
    if (!externalSignal) return;
    const cancel = () => reject(Object.assign(new Error('cancelled'), { code: 'NARU_LIVE_CANCELLED' }));
    if (externalSignal.aborted) cancel();
    else {
      externalSignal.addEventListener('abort', cancel, { once: true });
      removeExternalAbort = () => externalSignal.removeEventListener('abort', cancel);
    }
  });
  let executionSettled = false;
  const execution = Promise.resolve()
    .then(() => operation(controller.signal, registerCleanup))
    .then(
      (value) => { executionSettled = true; return value; },
      (error) => { executionSettled = true; throw error; },
    );
  try {
    return await Promise.race([execution, timeout, cancellation]);
  } catch (error) {
    if (error?.code === 'NARU_LIVE_TIMEOUT' || error?.code === 'NARU_LIVE_CANCELLED') {
      controller.abort();
      let cleanupComplete = true;
      for (const cleanup of cleanupOperations.reverse()) {
        try { await boundedCleanup(cleanup); } catch { cleanupComplete = false; }
      }
      await Promise.race([
        execution.catch(() => undefined),
        new Promise((resolvePromise) => setTimeout(resolvePromise, 250)),
      ]);
      error.executorCleanupComplete = cleanupComplete && executionSettled;
    }
    throw error;
  } finally {
    clearTimeout(timer);
    removeExternalAbort();
  }
}

function rubricIdsForCase(caseDefinition) {
  return [...new Set([
    'usefulDelegation', 'justifiedSkip', 'bestOf2', 'remediation', 'checks',
    ...caseDefinition.rubric.decisions,
    ...Object.keys(caseDefinition.rubric.safety),
    'topology',
  ])];
}

function createExecutionDefinition(contract, specification, caseDefinition, baseline) {
  const rubricIds = rubricIdsForCase(caseDefinition);
  const input = {
    schemaVersion: 1,
    suiteId: specification.suiteId,
    caseId: caseDefinition.id,
    scenario: caseDefinition.scenario,
    fixture: {
      id: caseDefinition.fixture.id,
      version: caseDefinition.fixture.version,
      digest: contract.fixtureDigests[caseDefinition.id],
      expectedOutcome: caseDefinition.fixture.expectedOutcome,
    },
    environment: {
      allowedKeys: contract.environment.allowedKeys,
      opencode: contract.opencode,
      provider: contract.provider,
      provenance: contract.provenance,
    },
    model: contract.model,
    timeout: contract.timeout,
    rubric: caseDefinition.rubric,
    rubricIds,
  };
  const topology = baseline
    ? { kind: 'single-agent', workflow: caseDefinition.topology.workflow, schedulerMode: 'off', workspaceMode: 'shared', fallbackMode: 'none' }
    : { kind: 'candidate', ...caseDefinition.topology };
  return {
    caseId: caseDefinition.id,
    input: structuredClone(input),
    topology,
    rubricIds: [...rubricIds],
    matchDigest: sha256Canonical(input),
    topologyDigest: sha256Canonical(topology),
  };
}

function limitError(code, message) {
  return Object.assign(new Error(message), { code });
}

function createExecutionRuntime(contract, totals) {
  const observed = { childCount: 0, peakConcurrency: 0, requestCount: 0, capturedBytes: 0, inputTokens: 0, outputTokens: 0 };
  return {
    observed,
    beforeRequest(count = 1) {
      integer(count, 'request reservation', 1, contract.request.maxCount);
      if (totals.requestCount + observed.requestCount + count > contract.request.maxCount) {
        throw limitError('NARU_LIVE_REQUEST_LIMIT', 'request limit');
      }
      observed.requestCount += count;
    },
    recordCapture(bytes) {
      integer(bytes, 'captured bytes', 0, contract.request.maxCaptureBytes);
      if (totals.capturedBytes + observed.capturedBytes + bytes > contract.request.maxCaptureBytes) {
        throw limitError('NARU_LIVE_CAPTURE_LIMIT', 'capture limit');
      }
      observed.capturedBytes += bytes;
    },
    recordSessions(descendants, depth, peakConcurrency = descendants) {
      integer(descendants, 'descendant count', 0, MAX_DESCENDANTS);
      integer(depth, 'descendant depth', 0, 8);
      integer(peakConcurrency, 'peak concurrency', 0, MAX_DESCENDANTS);
      if (descendants > contract.session.maxDescendants || depth > contract.session.maxDepth || peakConcurrency > contract.session.maxDescendants) {
        throw limitError('NARU_LIVE_SESSION_LIMIT', 'session limit');
      }
      observed.childCount = Math.max(observed.childCount, descendants);
      observed.peakConcurrency = Math.max(observed.peakConcurrency, peakConcurrency);
    },
    recordTokens(inputTokens, outputTokens) {
      integer(inputTokens, 'input tokens', 0, MAX_TOKEN_COUNT);
      integer(outputTokens, 'output tokens', 0, MAX_TOKEN_COUNT);
      if (totals.inputTokens + observed.inputTokens + inputTokens > contract.token.maxInput
        || totals.outputTokens + observed.outputTokens + outputTokens > contract.token.maxOutput) {
        throw limitError('NARU_LIVE_TOKEN_LIMIT', 'token limit');
      }
      observed.inputTokens += inputTokens;
      observed.outputTokens += outputTokens;
    },
    assertLoopback(target) {
      let parsed;
      try { parsed = new URL(target); } catch { throw limitError('NARU_LIVE_NETWORK_LIMIT', 'invalid local adapter URL'); }
      if (parsed.protocol !== 'http:' || !['127.0.0.1', '[::1]'].includes(parsed.hostname)) {
        throw limitError('NARU_LIVE_NETWORK_LIMIT', 'OpenCode adapter traffic must remain loopback-only');
      }
    },
  };
}

function stopCodeForError(error) {
  return new Map([
    ['NARU_LIVE_TIMEOUT', 'timeout'],
    ['NARU_LIVE_CANCELLED', 'cancelled'],
    ['NARU_LIVE_REQUEST_LIMIT', 'request-limit'],
    ['NARU_LIVE_CAPTURE_LIMIT', 'capture-limit'],
    ['NARU_LIVE_SESSION_LIMIT', 'session-limit'],
    ['NARU_LIVE_TOKEN_LIMIT', 'token-limit'],
    ['NARU_LIVE_NETWORK_LIMIT', 'safety-failure'],
    ['NARU_LIVE_CLEANUP_FAILURE', 'cleanup-failure'],
  ]).get(error?.code) ?? 'execution-failure';
}

function validateRuntimePreflight(value, contract) {
  exact(value, ['opencode', 'providerBudget'], 'live runtime preflight');
  exact(value.opencode, ['version', 'executableDigest'], 'live runtime preflight.opencode');
  const opencode = {
    version: id(value.opencode.version, 'live runtime preflight.opencode.version'),
    executableDigest: assertSha(value.opencode.executableDigest, 'live runtime preflight.opencode.executableDigest'),
  };
  if (opencode.version !== contract.opencode.version
    || opencode.executableDigest !== contract.opencode.executableDigest) {
    throw limitError('NARU_LIVE_PROVENANCE_FAILURE', 'actual OpenCode version or executable digest does not match the authorized contract');
  }
  exact(value.providerBudget, ['status', 'maxOutputTokens', 'maxCostPerRequestUsdMicros'], 'live runtime preflight.providerBudget');
  if (!['enforced', 'not-enforced', 'not-required'].includes(value.providerBudget.status)) {
    throw new Error('live runtime preflight.providerBudget.status is invalid');
  }
  const providerBudget = {
    status: value.providerBudget.status,
    maxOutputTokens: integer(value.providerBudget.maxOutputTokens, 'live runtime preflight.providerBudget.maxOutputTokens', 0, MAX_TOKEN_COUNT),
    maxCostPerRequestUsdMicros: integer(
      value.providerBudget.maxCostPerRequestUsdMicros,
      'live runtime preflight.providerBudget.maxCostPerRequestUsdMicros',
      0,
      MAX_SPEND_USD_MICROS,
    ),
  };
  if (contract.provider.id === 'none') {
    if (providerBudget.status !== 'not-required') throw new Error('provider-free execution must report provider budget enforcement as not-required');
  } else if (providerBudget.status !== 'enforced'
    || providerBudget.maxOutputTokens > contract.token.maxOutput
    || providerBudget.maxCostPerRequestUsdMicros > contract.spend.maxCostPerRequestUsdMicros) {
    throw limitError(
      'NARU_LIVE_BUDGET_UNENFORCED',
      'provider execution requires enforceable output-token and per-request cost ceilings before the run command',
    );
  }
  const expectedProviderRuns = contract.case.ids.length * contract.repetition.count
    * (contract.baseline.kind === 'none' ? 1 : 2);
  if (contract.provider.id !== 'none'
    && contract.spend.maxCostPerRequestUsdMicros * expectedProviderRuns > contract.spend.maxUsdMicros) {
    throw limitError(
      'NARU_LIVE_BUDGET_UNENFORCED',
      'authorized spend cannot conservatively reserve the enforceable per-request ceiling for every planned provider run',
    );
  }
  return { opencode, providerBudget };
}

async function assertAuthorizedCandidateArtifacts(contract, candidateRoot) {
  const inspected = await inspectCandidateArtifacts(
    candidateRoot,
    contract.candidate.artifacts.map((entry) => entry.path),
  );
  if (inspected.digest !== contract.candidate.digest
    || canonicalJson(inspected.artifacts) !== canonicalJson(contract.candidate.artifacts)) {
    throw limitError('NARU_LIVE_PROVENANCE_FAILURE', 'authorized candidate artifact digest mismatch');
  }
}

function markRuntimeProvenanceUnknown(result) {
  const safety = { ...result.safety };
  for (const field of ['networkContained', 'noPersistentDataWrite', 'noPost', 'noSecret', 'scopeContained']) {
    if (safety[field] === 'observed') safety[field] = 'unknown';
  }
  return {
    ...result,
    passed: false,
    safety,
    limitations: [...new Set([...result.limitations, 'runtime-bytes-not-bound'])],
  };
}

export async function runAuthorizedLiveEvaluation({
  contractPath,
  confirmationSha256,
  contractDigestConfirmation,
  specification,
  fixturesRoot,
  execute,
  candidateRoot = DEFAULT_CANDIDATE_ROOT,
  temporaryParent,
  baseEnvironment = process.env,
  signal,
} = {}) {
  const authorization = await loadAuthorizedLiveContract(contractPath, confirmationSha256);
  const contract = authorization.contract;
  assertSha(contractDigestConfirmation, 'live contract digest confirmation');
  if (contract.contractDigest !== contractDigestConfirmation) throw new Error('live contract digest confirmation mismatch');
  if (typeof execute !== 'function') throw new Error('live execution requires an injected executor');
  const spec = validateReusableEvaluationSpecificationV3(specification);
  if (sha256Canonical(spec) !== contract.specificationDigest) throw new Error('authorized specification digest mismatch');
  if (contract.case.ids.some((caseId, index) => caseId !== spec.cases[index]?.id)) throw new Error('authorized case set mismatch');
  await assertAuthorizedCandidateArtifacts(contract, candidateRoot);
  let runtimePreflight = null;
  if (typeof execute.preflight === 'function') {
    runtimePreflight = validateRuntimePreflight(await execute.preflight({ contract, baseEnvironment }), contract);
  } else if (contract.provider.id !== 'none') {
    throw limitError(
      'NARU_LIVE_BUDGET_UNENFORCED',
      'provider execution is unavailable without a provider-enforced output-token and cost ceiling',
    );
  }
  await assertAuthorizedCandidateArtifacts(contract, candidateRoot);
  if (contract.provider.id !== 'none') {
    throw limitError(
      'NARU_LIVE_PROVENANCE_FAILURE',
      'provider execution is unavailable because candidate and executable bytes are not bound through execution',
    );
  }
  const envelope = createLiveRunEnvelope(contract, authorization.fileDigest);
  const runs = [];
  let aborted = false;
  let knownSpendUsdMicros = 0;
  const totals = { requestCount: 0, capturedBytes: 0, inputTokens: 0, outputTokens: 0 };
  const deadline = Date.now() + contract.timeout.runMs;
  outer: for (let repetition = 1; repetition <= contract.repetition.count; repetition += 1) {
    for (const caseDefinition of spec.cases) {
      const inspected = await inspectSyntheticFixture(fixturesRoot, caseDefinition.fixture);
      if (inspected.digest !== contract.fixtureDigests[caseDefinition.id]) throw new Error(`authorized fixture digest mismatch for ${caseDefinition.id}`);
      const topologies = contract.baseline.kind === 'none' ? [false] : [false, true];
      for (const baseline of topologies) {
        const execution = createExecutionDefinition(contract, spec, caseDefinition, baseline);
        const reservedCost = contract.spend.maxCostPerRequestUsdMicros;
        if (contract.spend.maxUsdMicros - knownSpendUsdMicros < reservedCost) {
          const result = failureResult('cost-limit', 0, execution.rubricIds);
          runs.push(publicRun(contract, execution, repetition, baseline, result, { attempted: false, complete: true, mutationContained: true }));
          aborted = true;
          break outer;
        }
        if (totals.requestCount >= contract.request.maxCount) {
          const result = failureResult('request-limit', 0, execution.rubricIds);
          runs.push(publicRun(contract, execution, repetition, baseline, result, { attempted: false, complete: true, mutationContained: true }));
          aborted = true;
          break outer;
        }
        if (Date.now() >= deadline) {
          const result = failureResult('deadline', 0, execution.rubricIds);
          runs.push(publicRun(contract, execution, repetition, baseline, result, { attempted: false, complete: true, mutationContained: true }));
          aborted = true;
          break outer;
        }
        const sandbox = await materializeSyntheticFixture({
          fixturesRoot,
          fixture: caseDefinition.fixture,
          temporaryParent,
          baseEnvironment,
          allowedEnvironmentKeys: contract.environment.allowedKeys,
        });
        const runtime = createExecutionRuntime(contract, totals);
        let result;
        let mutationContained = true;
        let executorCleanupComplete = true;
        let cleanup = { attempted: false, complete: false, mutationContained: true };
        const startedAt = Date.now();
        try {
          const raw = await withinTimeout((caseSignal, registerCleanup) => execute({
            caseDefinition,
            contract,
            execution,
            baseline,
            repetition,
            signal: caseSignal,
            registerCleanup,
            runtime,
            workspace: sandbox.workspace,
            environment: sandbox.environment,
            limits: {
              deadline,
              timeout: contract.timeout,
              session: contract.session,
              request: contract.request,
              token: contract.token,
              spend: contract.spend,
              network: contract.network,
            },
          }), Math.min(contract.timeout.caseMs, Math.max(1, deadline - Date.now())), signal);
          const limitStopCode = executorLimitStopCode(raw, contract);
          result = limitStopCode
            ? failureResult(limitStopCode, Math.min(Date.now() - startedAt, contract.timeout.caseMs), execution.rubricIds, runtime.observed)
            : validateExecutorResult(raw, contract, execution.rubricIds, runtime.observed);
          if (result.stopCode === null && Object.values(result.safety).includes('failed')) {
            result = { ...result, passed: false, stopCode: 'safety-failure' };
          }
          const costRequired = contract.provider.id !== 'none' || reservedCost > 0;
          if (costRequired && result.usageCostUsdMicros === null) {
            result = { ...result, passed: false, stopCode: 'cost-missing' };
          } else if (result.usageCostUsdMicros !== null) {
            knownSpendUsdMicros += result.usageCostUsdMicros;
            if (result.usageCostUsdMicros > reservedCost || knownSpendUsdMicros > contract.spend.maxUsdMicros) {
              result = { ...result, passed: false, stopCode: 'cost-limit' };
            }
          }
          totals.requestCount += result.metrics.requestCount;
          totals.capturedBytes += result.metrics.capturedBytes;
          totals.inputTokens += result.metrics.inputTokens;
          totals.outputTokens += result.metrics.outputTokens;
          if (totals.requestCount > contract.request.maxCount) result = { ...result, passed: false, stopCode: 'request-limit' };
          else if (totals.capturedBytes > contract.request.maxCaptureBytes) result = { ...result, passed: false, stopCode: 'capture-limit' };
          else if (totals.inputTokens > contract.token.maxInput || totals.outputTokens > contract.token.maxOutput) {
            result = { ...result, passed: false, stopCode: 'token-limit' };
          }
          try {
            const audit = await sandbox.audit();
            const mayMutate = contract.mutation.allowedCaseIds.includes(caseDefinition.id);
            mutationContained = mayMutate || !audit.changed;
            if (!mutationContained) result = failureResult('mutation-detected', Math.min(Date.now() - startedAt, contract.timeout.caseMs), execution.rubricIds, runtime.observed);
          } catch {
            mutationContained = false;
            result = failureResult('safety-failure', Math.min(Date.now() - startedAt, contract.timeout.caseMs), execution.rubricIds, runtime.observed);
          }
        } catch (error) {
          if (error?.executorCleanupComplete === false) executorCleanupComplete = false;
          result = failureResult(stopCodeForError(error), Math.min(Date.now() - startedAt, contract.timeout.caseMs), execution.rubricIds, runtime.observed);
          if (error?.code === 'NARU_LIVE_NETWORK_LIMIT') result.safety.networkContained = 'failed';
        } finally {
          try {
            const verified = await sandbox.cleanup();
            cleanup = { ...verified, complete: verified.complete && executorCleanupComplete, mutationContained };
            if (!cleanup.complete) result = failureResult('cleanup-failure', Math.min(Date.now() - startedAt, contract.timeout.caseMs), execution.rubricIds, runtime.observed);
          } catch {
            cleanup = { attempted: true, complete: false, mutationContained };
            result = failureResult('cleanup-failure', Math.min(Date.now() - startedAt, contract.timeout.caseMs), execution.rubricIds, runtime.observed);
          }
        }
        result = markRuntimeProvenanceUnknown(result);
        const run = publicRun(contract, execution, repetition, baseline, result, cleanup);
        runs.push(run);
        if (!run.passed) {
          aborted = true;
          break outer;
        }
      }
    }
  }
  return {
    envelope,
    provenance: {
      contractDigest: contract.contractDigest,
      contractFileDigest: authorization.fileDigest,
      specificationDigest: contract.specificationDigest,
      fixtureDigests: contract.fixtureDigests,
      naru: contract.candidate,
      opencode: { status: 'unknown', expected: contract.opencode, observed: null },
      provider: contract.provider,
      model: contract.model,
      operatingSystem: contract.provenance.operatingSystem,
      architecture: contract.provenance.architecture,
      utcDate: contract.provenance.utcDate,
      providerBudget: runtimePreflight?.providerBudget ?? {
        status: contract.provider.id === 'none' ? 'not-required' : 'not-enforced',
        maxOutputTokens: 0,
        maxCostPerRequestUsdMicros: 0,
      },
    },
    redaction: LIVE_EVALUATION_REDACTION,
    runs,
    aggregate: aggregateSanitizedLiveRuns(contract, runs, aborted),
  };
}
