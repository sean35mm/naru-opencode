export const COMPATIBILITY_SCHEMA_VERSION = 1;

export type CompatibilityComponent = 'opencode' | 'node' | 'bun' | 'git' | 'gh';
export type CheckStatus = 'passed' | 'failed' | 'omitted';

const COMPATIBILITY_COMPONENTS: readonly string[] = ['opencode', 'node', 'bun', 'git', 'gh'];
const CHECK_STATUSES: readonly string[] = ['passed', 'failed', 'omitted'];

export interface Semver {
  major: number;
  minor: number;
  patch: number;
  prerelease: string[];
  build: string[];
  normalized: string;
}

export interface VersionRequirement {
  kind: 'minimum' | 'major-target' | 'exact-target' | 'feature-prerequisite';
  version: string | null;
}

export interface VersionEvaluation {
  component: CompatibilityComponent;
  observed: string | null;
  status: 'unrecognized' | 'recorded' | 'supported' | 'unsupported' | 'targeted' | 'non-target';
  requirement: VersionRequirement;
  exactCurrent?: boolean;
}

export interface PlatformEvaluation {
  id: string;
  status: 'targeted' | 'unsupported' | 'unverified';
  reason: string | null;
}

export interface DashboardEvidence {
  requested: boolean;
  status: 'omitted' | 'failed' | 'partial';
  bun: { status: string; observed: string | null };
  syntax: 'omitted' | 'passed' | 'failed';
  registration: 'omitted' | 'passed' | 'failed';
  nativeTuiLoad: 'omitted';
  limitation: string;
}

export interface CompatibilityCheck {
  id: string;
  status: CheckStatus;
  durationMs: number;
  diagnostic: string | null;
}

export interface CompatibilityEvidenceInput {
  platform?: PlatformEvaluation | null;
  versions?: Partial<Record<CompatibilityComponent, unknown>>;
  checks: unknown;
  dashboard?: DashboardEvidence | null;
}

export interface CompatibilityEvidence {
  schemaVersion: number;
  kind: 'naru-compatibility-evidence';
  policyVersion: number;
  providerFree: boolean;
  releaseQualification: 'not-established';
  candidateIdentity: 'unverified';
  status: 'passed-local-smoke' | 'failed-local-smoke';
  platform: PlatformEvaluation | null | undefined;
  versions: Record<CompatibilityComponent, VersionEvaluation>;
  checks: CompatibilityCheck[];
  capabilities: { dashboard: DashboardEvidence };
}

export const COMPATIBILITY_LIMITS = Object.freeze({
  maxChecks: 24,
  maxDiagnosticChars: 160,
  maxResultBytes: 32 * 1024,
  maxVersionInputChars: 256,
});

function deepFreeze<T>(value: T): Readonly<T> {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function isCompatibilityComponent(value: unknown): value is CompatibilityComponent {
  return typeof value === 'string' && COMPATIBILITY_COMPONENTS.includes(value);
}

function isCheckStatus(value: unknown): value is CheckStatus {
  return typeof value === 'string' && CHECK_STATUSES.includes(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export const COMPATIBILITY_POLICY = deepFreeze({
  schemaVersion: COMPATIBILITY_SCHEMA_VERSION,
  policyVersion: 1,
  release: {
    opencode: {
      floor: '1.18.4',
      current: '1.18.4',
    },
  },
  targets: {
    platforms: [
      { id: 'macos-arm64', os: 'macos', platform: 'darwin', arch: 'arm64' },
      { id: 'ubuntu-x64', os: 'ubuntu', platform: 'linux', arch: 'x64' },
    ],
    runtimes: {
      node: { major: 24 },
      bun: { exact: '1.3.9' },
    },
  },
  features: {
    core: {
      required: ['opencode', 'node'],
      git: { prerequisite: true, versionFloor: null },
      providerCalls: false,
      minimumSubagentDepth: 1,
      schedulerDefault: 'off',
    },
    reviewPosting: {
      git: { prerequisite: true, versionFloor: null },
      gh: { prerequisite: true, versionFloor: null },
    },
    dashboard: {
      availability: 'optional-full-tui-only',
      bunTarget: '1.3.9',
      miniTui: 'excluded',
    },
  },
  exclusions: {
    nativeWindows: 'unsupported-unclaimed',
    wsl: 'unsupported-unclaimed',
  },
  evidence: {
    localSmokeQualifiesReleaseMatrix: false,
    exactImmutableCandidateRequired: true,
  },
});

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

export function parseSemver(value: unknown): Semver | null {
  if (typeof value !== 'string' || value.length === 0 || value.length > 128) return null;
  const match = value.match(SEMVER);
  if (match === null) return null;
  const numbers = match.slice(1, 4).map(Number);
  if (numbers.some(number => !Number.isSafeInteger(number))) return null;
  const [major, minor, patch] = numbers;
  if (major === undefined || minor === undefined || patch === undefined) return null;
  const prerelease = match[4]?.split('.') ?? [];
  for (const identifier of prerelease) {
    if (/^\d+$/.test(identifier) && (identifier.length > 1 && identifier.startsWith('0'))) return null;
  }
  return {
    major,
    minor,
    patch,
    prerelease,
    build: match[5]?.split('.') ?? [],
    normalized: `${numbers.join('.')}${match[4] ? `-${match[4]}` : ''}${match[5] ? `+${match[5]}` : ''}`,
  };
}

function compareIdentifier(left: string, right: string): number {
  const leftNumeric = /^\d+$/.test(left);
  const rightNumeric = /^\d+$/.test(right);
  if (leftNumeric && rightNumeric) {
    if (left.length !== right.length) return Math.sign(left.length - right.length);
    return left === right ? 0 : left < right ? -1 : 1;
  }
  if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
  return left === right ? 0 : left < right ? -1 : 1;
}

export function compareSemver(left: string | Semver, right: string | Semver): number {
  const a = typeof left === 'string' ? parseSemver(left) : left;
  const b = typeof right === 'string' ? parseSemver(right) : right;
  if (a === null || b === null) throw new TypeError('compareSemver requires valid semantic versions');
  for (const field of ['major', 'minor', 'patch'] as const) {
    if (a[field] !== b[field]) return Math.sign(a[field] - b[field]);
  }
  if (a.prerelease.length === 0 || b.prerelease.length === 0) {
    if (a.prerelease.length === b.prerelease.length) return 0;
    return a.prerelease.length === 0 ? 1 : -1;
  }
  for (let index = 0; index < Math.max(a.prerelease.length, b.prerelease.length); index += 1) {
    const aIdentifier = a.prerelease[index];
    const bIdentifier = b.prerelease[index];
    if (aIdentifier === undefined) return -1;
    if (bIdentifier === undefined) return 1;
    const compared = compareIdentifier(aIdentifier, bIdentifier);
    if (compared !== 0) return compared;
  }
  return 0;
}

export function sanitizeObservedVersion(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const bounded = value.slice(0, COMPATIBILITY_LIMITS.maxVersionInputChars);
  const match = bounded.match(/(?:^|[^0-9A-Za-z.-])v?((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?)(?=$|[^0-9A-Za-z.-])/);
  const parsed = match === null ? null : parseSemver(match[1]);
  return parsed?.normalized ?? null;
}

export function evaluateObservedVersion(component: unknown, output: unknown): VersionEvaluation {
  if (!isCompatibilityComponent(component)) {
    throw new TypeError('unknown compatibility component');
  }
  const typedComponent: CompatibilityComponent = component;
  const observed = sanitizeObservedVersion(output);
  if (observed === null) {
    return { component: typedComponent, observed: null, status: 'unrecognized', requirement: requirementFor(typedComponent) };
  }
  let status: VersionEvaluation['status'] = 'recorded';
  if (typedComponent === 'opencode') {
    status = compareSemver(observed, COMPATIBILITY_POLICY.release.opencode.floor) >= 0 ? 'supported' : 'unsupported';
  } else if (typedComponent === 'node') {
    const parsed = parseSemver(observed);
    status = parsed?.major === COMPATIBILITY_POLICY.targets.runtimes.node.major ? 'targeted' : 'non-target';
  } else if (typedComponent === 'bun') {
    status = compareSemver(observed, COMPATIBILITY_POLICY.targets.runtimes.bun.exact) === 0 ? 'targeted' : 'non-target';
  }
  return {
    component: typedComponent,
    observed,
    status,
    requirement: requirementFor(typedComponent),
    ...(typedComponent === 'opencode' ? {
      exactCurrent: compareSemver(observed, COMPATIBILITY_POLICY.release.opencode.current) === 0,
    } : {}),
  };
}

function requirementFor(component: CompatibilityComponent): VersionRequirement {
  if (component === 'opencode') return { kind: 'minimum', version: COMPATIBILITY_POLICY.release.opencode.floor };
  if (component === 'node') return { kind: 'major-target', version: '24' };
  if (component === 'bun') return { kind: 'exact-target', version: COMPATIBILITY_POLICY.targets.runtimes.bun.exact };
  return { kind: 'feature-prerequisite', version: null };
}

export interface PlatformObservation {
  platform: unknown;
  arch: unknown;
  osId?: unknown;
  wsl?: unknown;
}

export function evaluatePlatformTarget({ platform, arch, osId = null, wsl = false }: PlatformObservation): PlatformEvaluation {
  if (wsl) return { id: 'wsl', status: 'unsupported', reason: 'wsl-unclaimed' };
  if (platform === 'win32') return { id: 'native-windows', status: 'unsupported', reason: 'native-windows-unclaimed' };
  const target = COMPATIBILITY_POLICY.targets.platforms.find(item => item.platform === platform && item.arch === arch);
  if (target === undefined) return { id: 'other', status: 'unsupported', reason: 'platform-not-targeted' };
  if (target.os === 'ubuntu' && osId !== 'ubuntu') {
    return { id: target.id, status: 'unverified', reason: 'ubuntu-identity-not-confirmed' };
  }
  return { id: target.id, status: 'targeted', reason: null };
}

export interface DashboardEvidenceInput {
  requested: unknown;
  bun?: unknown;
  syntax?: unknown;
  registration?: unknown;
}

export function classifyDashboardEvidence({ requested, bun, syntax, registration }: DashboardEvidenceInput): DashboardEvidence {
  if (!requested) {
    return deepFreeze<DashboardEvidence>({
      requested: false,
      status: 'omitted',
      bun: { status: 'omitted', observed: null },
      syntax: 'omitted',
      registration: 'omitted',
      nativeTuiLoad: 'omitted',
      limitation: 'dashboard-not-requested',
    });
  }
  const bunEvaluation = evaluateObservedVersion('bun', bun ?? '');
  const failed = bunEvaluation.status !== 'targeted' || syntax !== 'passed' || registration !== 'passed';
  return deepFreeze<DashboardEvidence>({
    requested: true,
    status: failed ? 'failed' : 'partial',
    bun: { status: bunEvaluation.status, observed: bunEvaluation.observed },
    syntax: syntax === 'passed' ? 'passed' : 'failed',
    registration: registration === 'passed' ? 'passed' : 'failed',
    nativeTuiLoad: 'omitted',
    limitation: 'native-full-tui-load-not-proven',
  });
}

function boundedCheck(value: unknown): CompatibilityCheck {
  if (!isRecord(value)) throw new TypeError('check must be an object');
  const check = value;
  if (typeof check.id !== 'string' || !/^[a-z0-9-]{1,48}$/.test(check.id)) throw new TypeError('check id is invalid');
  if (!isCheckStatus(check.status)) throw new TypeError('check status is invalid');
  const rawDuration = check.durationMs;
  const durationMs = typeof rawDuration === 'number' && Number.isSafeInteger(rawDuration) && rawDuration >= 0
    ? Math.min(rawDuration, 300_000)
    : 0;
  const diagnostic = typeof check.diagnostic === 'string'
    ? check.diagnostic.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, COMPATIBILITY_LIMITS.maxDiagnosticChars)
    : null;
  return { id: check.id, status: check.status, durationMs, diagnostic: diagnostic || null };
}

export function createCompatibilityEvidence({ platform, versions, checks, dashboard }: CompatibilityEvidenceInput): Readonly<CompatibilityEvidence> {
  if (!Array.isArray(checks) || checks.length > COMPATIBILITY_LIMITS.maxChecks) {
    throw new TypeError(`checks must contain at most ${COMPATIBILITY_LIMITS.maxChecks} entries`);
  }
  const boundedChecks: CompatibilityCheck[] = checks.map(boundedCheck);
  const evaluatedVersions = {
    opencode: evaluateObservedVersion('opencode', versions?.opencode ?? ''),
    node: evaluateObservedVersion('node', versions?.node ?? ''),
    bun: evaluateObservedVersion('bun', versions?.bun ?? ''),
    git: evaluateObservedVersion('git', versions?.git ?? ''),
    gh: evaluateObservedVersion('gh', versions?.gh ?? ''),
  };
  const dashboardEvidence = dashboard ?? classifyDashboardEvidence({ requested: false });
  const successful = platform?.status === 'targeted'
    && evaluatedVersions.opencode.status === 'supported'
    && evaluatedVersions.node.status === 'targeted'
    && boundedChecks.every(check => check.status !== 'failed')
    && dashboardEvidence.status !== 'failed';
  const result: CompatibilityEvidence = {
    schemaVersion: COMPATIBILITY_SCHEMA_VERSION,
    kind: 'naru-compatibility-evidence',
    policyVersion: COMPATIBILITY_POLICY.policyVersion,
    providerFree: true,
    releaseQualification: 'not-established',
    candidateIdentity: 'unverified',
    status: successful ? 'passed-local-smoke' : 'failed-local-smoke',
    platform,
    versions: evaluatedVersions,
    checks: boundedChecks,
    capabilities: { dashboard: dashboardEvidence },
  };
  if (Buffer.byteLength(JSON.stringify(result), 'utf8') > COMPATIBILITY_LIMITS.maxResultBytes) {
    throw new Error('compatibility evidence exceeded its bounded schema');
  }
  return deepFreeze(result);
}
