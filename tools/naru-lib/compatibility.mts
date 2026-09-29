export const COMPATIBILITY_SCHEMA_VERSION = 4;
const COMPATIBILITY_COMPONENTS = ['opencode', 'node', 'bun', 'git', 'gh'] as const;
const CHECK_STATUSES = ['passed', 'failed', 'omitted'] as const;
const COMPATIBILITY_PROFILES = ['native-v2'] as const;
type UnknownRecord = Record<string, unknown>;
export type CompatibilityComponent = typeof COMPATIBILITY_COMPONENTS[number];
export type CompatibilityCheckStatus = typeof CHECK_STATUSES[number];
export type CompatibilityProfile = typeof COMPATIBILITY_PROFILES[number];
export const REQUIRED_COMPATIBILITY_CHECKS: Readonly<Record<CompatibilityProfile, readonly string[]>> = Object.freeze({
    'native-v2': Object.freeze(['target-platform', 'opencode-version', 'install-preview', 'install-apply', 'models-preview', 'models-apply', 'native-worker-pool', 'naru-doctor', 'native-package', 'native-agents', 'native-registration', 'native-host-startup', 'native-config-source', 'native-host-agents', 'native-host-plugin', 'native-host-skills', 'native-host-command', 'cleanup']),
});
export type CompatibilityQualification = 'native-v2';
export type ObservedVersionStatus = 'unrecognized' | 'recorded' | 'supported' | 'candidate' | 'unsupported' | 'targeted' | 'non-target';

export interface ParsedSemver {
    major: number;
    minor: number;
    patch: number;
    prerelease: string[];
    build: string[];
    normalized: string;
}

export interface CompatibilityRequirement {
    kind: 'explicit-builds' | 'major-target' | 'exact-target' | 'feature-prerequisite';
    version: string | null;
    builds?: readonly string[];
}

export interface ObservedVersionEvaluation {
    component: CompatibilityComponent;
    observed: string | null;
    status: ObservedVersionStatus;
    requirement: CompatibilityRequirement;
}

export interface PlatformEvaluation {
    id: string;
    status: 'targeted' | 'unverified' | 'unsupported';
    reason: string | null;
}

export interface CompatibilityCheck {
    id: string;
    status: CompatibilityCheckStatus;
    durationMs: number;
    diagnostic: string | null;
}

export interface CompatibilityVersionEvaluations {
    opencode: ObservedVersionEvaluation;
    node: ObservedVersionEvaluation;
    bun: ObservedVersionEvaluation;
    git: ObservedVersionEvaluation;
    gh: ObservedVersionEvaluation;
}

export interface CompatibilityEvidence {
    schemaVersion: 4;
    kind: 'naru-compatibility-evidence';
    policyVersion: 4;
    providerFree: true;
    profile: CompatibilityProfile;
    qualification: CompatibilityQualification;
    releaseQualification: 'not-established';
    candidateIdentity: 'unverified';
    versionEvidence: {
        classification: 'current-target' | 'rejected';
        localProbe: 'passed' | 'failed';
        releaseMatrix: 'not-established';
    };
    status: 'passed-local-smoke' | 'failed-local-smoke';
    platform: PlatformEvaluation | undefined;
    versions: CompatibilityVersionEvaluations;
    checks: CompatibilityCheck[];
}
export const COMPATIBILITY_LIMITS = Object.freeze({
    maxChecks: 24,
    maxDiagnosticChars: 160,
    maxResultBytes: 32 * 1024,
    maxVersionInputChars: 256,
});
function deepFreeze<const T>(value: T): T;
function deepFreeze(value: unknown): unknown {
    if (value === null || typeof value !== 'object' || Object.isFrozen(value))
        return value;
    for (const child of Object.values(value))
        deepFreeze(child);
    return Object.freeze(value);
}
function isCompatibilityComponent(value: unknown): value is CompatibilityComponent {
    return typeof value === 'string' && COMPATIBILITY_COMPONENTS.some((component) => component === value);
}
function isCheckStatus(value: unknown): value is CompatibilityCheckStatus {
    return typeof value === 'string' && CHECK_STATUSES.some((status) => status === value);
}
export function isCompatibilityProfile(value: unknown): value is CompatibilityProfile {
    return typeof value === 'string' && COMPATIBILITY_PROFILES.some((profile) => profile === value);
}
function isRecord(value: unknown): value is UnknownRecord {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}
export const COMPATIBILITY_POLICY = deepFreeze({
    schemaVersion: COMPATIBILITY_SCHEMA_VERSION,
    policyVersion: 4,
    profiles: {
        'native-v2': {
            qualification: 'native-v2',
            recognizedBuilds: ['2.0.15'],
            // Install and doctor accept stable patch releases in [floor, below) as candidates; smoke qualification stays exact.
            candidateRange: { floor: '2.0.15', below: '2.1.0' },
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
        },
        reviewPosting: {
            git: { prerequisite: true, versionFloor: null },
            gh: { prerequisite: true, versionFloor: null },
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
} as const);
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;
export function parseSemver(value: unknown): ParsedSemver | null {
    if (typeof value !== 'string' || value.length === 0 || value.length > 128)
        return null;
    const match = value.match(SEMVER);
    if (match === null)
        return null;
    const numbers = match.slice(1, 4).map(Number);
    if (numbers.some(number => !Number.isSafeInteger(number)))
        return null;
    const [major, minor, patch] = numbers;
    if (major === undefined || minor === undefined || patch === undefined)
        return null;
    const prerelease = match[4]?.split('.') ?? [];
    for (const identifier of prerelease) {
        if (/^\d+$/.test(identifier) && (identifier.length > 1 && identifier.startsWith('0')))
            return null;
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
        if (left.length !== right.length)
            return Math.sign(left.length - right.length);
        return left === right ? 0 : left < right ? -1 : 1;
    }
    if (leftNumeric !== rightNumeric)
        return leftNumeric ? -1 : 1;
    return left === right ? 0 : left < right ? -1 : 1;
}
export function compareSemver(left: string | ParsedSemver, right: string | ParsedSemver): number {
    const a = typeof left === 'string' ? parseSemver(left) : left;
    const b = typeof right === 'string' ? parseSemver(right) : right;
    if (a === null || b === null)
        throw new TypeError('compareSemver requires valid semantic versions');
    for (const field of ['major', 'minor', 'patch'] as const) {
        if (a[field] !== b[field])
            return Math.sign(a[field] - b[field]);
    }
    if (a.prerelease.length === 0 || b.prerelease.length === 0) {
        if (a.prerelease.length === b.prerelease.length)
            return 0;
        return a.prerelease.length === 0 ? 1 : -1;
    }
    for (let index = 0; index < Math.max(a.prerelease.length, b.prerelease.length); index += 1) {
        const aIdentifier = a.prerelease[index];
        const bIdentifier = b.prerelease[index];
        if (aIdentifier === undefined)
            return -1;
        if (bIdentifier === undefined)
            return 1;
        const compared = compareIdentifier(aIdentifier, bIdentifier);
        if (compared !== 0)
            return compared;
    }
    return 0;
}
export function sanitizeObservedVersion(value: unknown): string | null {
    if (typeof value !== 'string')
        return null;
    const bounded = value.slice(0, COMPATIBILITY_LIMITS.maxVersionInputChars);
    if (bounded.length !== value.length)
        return null;
    const version = '((?:0|[1-9]\\d*)\\.(?:0|[1-9]\\d*)\\.(?:0|[1-9]\\d*)(?:-[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?(?:\\+[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?)';
    const match = bounded.match(new RegExp(`^[ \\t\\r\\n]*(?:v${version}|${version}|opencode2 v${version}|opencode v${version})[ \\t\\r\\n]*$`));
    const parsed = match === null ? null : parseSemver(match[1] ?? match[2] ?? match[3] ?? match[4]);
    return parsed?.normalized ?? null;
}
function profilePolicy(profile: unknown) {
    if (!isCompatibilityProfile(profile))
        throw new TypeError('unknown compatibility profile');
    return COMPATIBILITY_POLICY.profiles[profile];
}
export function evaluateOpenCodeVersion(profile: unknown, output: unknown): ObservedVersionEvaluation {
    const selected = profilePolicy(profile);
    const observed = sanitizeObservedVersion(output);
    const parsed = observed === null ? null : parseSemver(observed);
    const range = selected.candidateRange;
    const status: ObservedVersionStatus = observed !== null && selected.recognizedBuilds.some(build => build === observed) ? 'supported' : observed === null ? 'unrecognized'
        : parsed && parsed.prerelease.length === 0 && compareSemver(parsed, range.floor) >= 0 && compareSemver(parsed, range.below) < 0 ? 'candidate' : 'unsupported';
    return {
        component: 'opencode',
        observed,
        status,
        requirement: { kind: 'explicit-builds', version: null, builds: selected.recognizedBuilds },
    };
}
export function evaluateObservedVersion(component: unknown, output: unknown, profile: CompatibilityProfile = 'native-v2'): ObservedVersionEvaluation {
    if (!isCompatibilityComponent(component)) {
        throw new TypeError('unknown compatibility component');
    }
    const typedComponent = component;
    if (typedComponent === 'opencode')
        return evaluateOpenCodeVersion(profile, output);
    const observed = sanitizeObservedVersion(output);
    if (observed === null) {
        return { component: typedComponent, observed: null, status: 'unrecognized', requirement: requirementFor(typedComponent) };
    }
    let status: ObservedVersionStatus = 'recorded';
    if (typedComponent === 'node') {
        const parsed = parseSemver(observed);
        status = parsed?.major === COMPATIBILITY_POLICY.targets.runtimes.node.major ? 'targeted' : 'non-target';
    }
    else if (typedComponent === 'bun') {
        status = compareSemver(observed, COMPATIBILITY_POLICY.targets.runtimes.bun.exact) === 0 ? 'targeted' : 'non-target';
    }
    return {
        component: typedComponent,
        observed,
        status,
        requirement: requirementFor(typedComponent),
    };
}
function requirementFor(component: CompatibilityComponent): CompatibilityRequirement {
    if (component === 'opencode')
        return { kind: 'explicit-builds', version: null, builds: COMPATIBILITY_POLICY.profiles['native-v2'].recognizedBuilds };
    if (component === 'node')
        return { kind: 'major-target', version: '24' };
    if (component === 'bun')
        return { kind: 'exact-target', version: COMPATIBILITY_POLICY.targets.runtimes.bun.exact };
    return { kind: 'feature-prerequisite', version: null };
}
export function evaluatePlatformTarget({ platform, arch, osId = null, wsl = false }: {
    platform?: unknown;
    arch?: unknown;
    osId?: unknown;
    wsl?: unknown;
}): PlatformEvaluation {
    if (wsl)
        return { id: 'wsl', status: 'unsupported', reason: 'wsl-unclaimed' };
    if (platform === 'win32')
        return { id: 'native-windows', status: 'unsupported', reason: 'native-windows-unclaimed' };
    const target = COMPATIBILITY_POLICY.targets.platforms.find(item => item.platform === platform && item.arch === arch);
    if (target === undefined)
        return { id: 'other', status: 'unsupported', reason: 'platform-not-targeted' };
    if (target.os === 'ubuntu' && osId !== 'ubuntu') {
        return { id: target.id, status: 'unverified', reason: 'ubuntu-identity-not-confirmed' };
    }
    return { id: target.id, status: 'targeted', reason: null };
}
function boundedCheck(value: unknown): CompatibilityCheck {
    if (!isRecord(value))
        throw new TypeError('check must be an object');
    const check = value;
    if (typeof check.id !== 'string' || !/^[a-z0-9-]{1,48}$/.test(check.id))
        throw new TypeError('check id is invalid');
    if (!isCheckStatus(check.status))
        throw new TypeError('check status is invalid');
    const rawDuration = check.durationMs;
    const durationMs = typeof rawDuration === 'number' && Number.isSafeInteger(rawDuration) && rawDuration >= 0
        ? Math.min(rawDuration, 300_000)
        : 0;
    const diagnostic = typeof check.diagnostic === 'string'
        ? check.diagnostic.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, COMPATIBILITY_LIMITS.maxDiagnosticChars)
        : null;
    return { id: check.id, status: check.status, durationMs, diagnostic: diagnostic || null };
}
export function createCompatibilityEvidence({ profile, platform, versions, checks }: {
    profile: CompatibilityProfile;
    platform?: PlatformEvaluation;
    versions?: unknown;
    checks: unknown;
}): CompatibilityEvidence {
    const selectedProfile = profilePolicy(profile);
    if (!Array.isArray(checks) || checks.length > COMPATIBILITY_LIMITS.maxChecks) {
        throw new TypeError(`checks must contain at most ${COMPATIBILITY_LIMITS.maxChecks} entries`);
    }
    const boundedChecks = checks.map(boundedCheck);
    const checkIds = new Set(boundedChecks.map(check => check.id));
    if (checkIds.size !== boundedChecks.length) throw new TypeError('check ids must be unique');
    const versionRecord = isRecord(versions) ? versions : undefined;
    const evaluatedVersions: CompatibilityVersionEvaluations = {
        opencode: evaluateOpenCodeVersion(profile, versionRecord?.opencode ?? ''),
        node: evaluateObservedVersion('node', versionRecord?.node ?? ''),
        bun: evaluateObservedVersion('bun', versionRecord?.bun ?? ''),
        git: evaluateObservedVersion('git', versionRecord?.git ?? ''),
        gh: evaluateObservedVersion('gh', versionRecord?.gh ?? ''),
    };
    const successful = platform?.status === 'targeted'
        && evaluatedVersions.opencode.status === 'supported'
        && evaluatedVersions.node.status === 'targeted'
        && REQUIRED_COMPATIBILITY_CHECKS[profile].every(id => boundedChecks.some(check => check.id === id && check.status === 'passed'))
        && boundedChecks.every(check => check.status !== 'failed');
    const passed = successful ? 'passed-local-smoke' : 'failed-local-smoke';
    const result: CompatibilityEvidence = {
        schemaVersion: COMPATIBILITY_SCHEMA_VERSION,
        kind: 'naru-compatibility-evidence',
        policyVersion: COMPATIBILITY_POLICY.policyVersion,
        providerFree: true,
        profile,
        qualification: selectedProfile.qualification,
        releaseQualification: 'not-established',
        candidateIdentity: 'unverified',
        versionEvidence: {
            classification: evaluatedVersions.opencode.status === 'supported' ? 'current-target' : 'rejected',
            localProbe: successful ? 'passed' : 'failed',
            releaseMatrix: 'not-established',
        },
        status: passed,
        platform,
        versions: evaluatedVersions,
        checks: boundedChecks,
    };
    if (Buffer.byteLength(JSON.stringify(result), 'utf8') > COMPATIBILITY_LIMITS.maxResultBytes) {
        throw new Error('compatibility evidence exceeded its bounded schema');
    }
    return deepFreeze(result);
}
