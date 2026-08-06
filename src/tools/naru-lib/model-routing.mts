const PROFILE_NAMES = ['luna', 'terra', 'sol'] as const;
const ASSIGNMENT_NAMES = ['terra', 'sol'] as const;
const LUNA_ALIAS_PREFIX = 'naru-delegate-luna-';
const SOL_ALIAS_PREFIX = 'naru-delegate-sol-';
const SOL_XHIGH_ALIAS_PREFIX = 'naru-delegate-sol-xhigh-';
const LEGACY_DEEP_ALIAS_PREFIX = 'naru-delegate-deep-';
const ROUTING_MARKER = '<!-- naru-delegate-routing:v1 -->';

export type ProfileName = (typeof PROFILE_NAMES)[number];
export type AssignmentName = (typeof ASSIGNMENT_NAMES)[number];
export type LunaAlias = `${typeof LUNA_ALIAS_PREFIX}${string}`;
export type SolAlias = `${typeof SOL_ALIAS_PREFIX}${string}`;
export type SolXhighAlias = `${typeof SOL_XHIGH_ALIAS_PREFIX}${string}`;
export type LegacyDeepAlias = `${typeof LEGACY_DEEP_ALIAS_PREFIX}${string}`;
export type RoutingAlias = LunaAlias | SolAlias | SolXhighAlias;

export interface ModelProfile {
  model: string;
  variant?: string;
}

export const NARU_DELEGATE_PROTOCOL = 2;
export const NARU_MINIMUM_SUBAGENT_DEPTH = 1;

export const NARU_AGENT_IDS = Object.freeze([
  'naru-orchestrator',
  'naru-minion-scout',
  'naru-minion-investigate',
  'naru-minion-architect',
  'naru-minion-implement',
  'naru-minion-debug',
  'naru-minion-verify',
  'naru-minion-judge',
] as const);

export type NaruAgentId = (typeof NARU_AGENT_IDS)[number];

export interface NormalizedRoutingOverrides {
  schemaVersion: typeof NARU_DELEGATE_PROTOCOL;
  profiles: Partial<Record<ProfileName, ModelProfile>>;
  agents: Partial<Record<NaruAgentId, AssignmentName>>;
}

export interface ResolvedRoutingPolicy {
  schemaVersion: typeof NARU_DELEGATE_PROTOCOL;
  profiles: Record<ProfileName, ModelProfile>;
  agents: Record<NaruAgentId, AssignmentName>;
}

export type DispatchGraph = Readonly<Partial<Record<NaruAgentId, readonly NaruAgentId[]>>>;

export interface DispatchEntryTopology {
  root: readonly NaruAgentId[];
  subtask: readonly NaruAgentId[];
}

export const DEFAULT_MODEL_PROFILES = Object.freeze({
  luna: Object.freeze({ model: 'openai/gpt-5.6-luna-fast', variant: 'high' }),
  terra: Object.freeze({ model: 'openai/gpt-5.6-terra-fast', variant: 'high' }),
  sol: Object.freeze({ model: 'openai/gpt-5.6-sol-fast', variant: 'high' }),
}) satisfies Readonly<Record<ProfileName, Readonly<ModelProfile>>>;

export const DEFAULT_AGENT_ASSIGNMENTS: Readonly<Partial<Record<NaruAgentId, AssignmentName>>> = Object.freeze({
  'naru-orchestrator': 'sol',
}) satisfies Readonly<Partial<Record<NaruAgentId, AssignmentName>>>;

export const SOL_FLOOR_ROLES = Object.freeze([
  'naru-minion-architect',
  'naru-minion-judge',
] as const) satisfies readonly NaruAgentId[];

// Retained so a copy-pinned v1 dashboard can still load after the routing helper is upgraded.
export const DEEP_FLOOR_ROLES = SOL_FLOOR_ROLES;

export const LUNA_ELIGIBLE_ROLES = Object.freeze([
  'naru-minion-scout',
  'naru-minion-investigate',
  'naru-minion-implement',
  'naru-minion-debug',
  'naru-minion-verify',
] as const) satisfies readonly NaruAgentId[];

export const NARU_DISPATCH_GRAPH = Object.freeze({
  'naru-orchestrator': Object.freeze([
    'naru-minion-scout',
    'naru-minion-investigate',
    'naru-minion-architect',
    'naru-minion-implement',
    'naru-minion-debug',
    'naru-minion-verify',
    'naru-minion-judge',
  ] as const),
}) satisfies DispatchGraph;

export const NARU_DISPATCH_ENTRY_TOPOLOGY = Object.freeze({
  root: Object.freeze(['naru-orchestrator'] as const),
  subtask: Object.freeze([] as const),
}) satisfies DispatchEntryTopology;

const ORCHESTRATOR_MODEL_ROUTED_TARGETS = Object.freeze([
  'naru-minion-scout',
  'naru-minion-investigate',
  'naru-minion-architect',
  'naru-minion-implement',
  'naru-minion-debug',
  'naru-minion-verify',
  'naru-minion-judge',
] as const) satisfies readonly NaruAgentId[];

const AGENT_ID_SET: ReadonlySet<string> = new Set(NARU_AGENT_IDS);
const SOL_FLOOR_SET: ReadonlySet<string> = new Set(SOL_FLOOR_ROLES);
const LUNA_ELIGIBLE_SET: ReadonlySet<string> = new Set(LUNA_ELIGIBLE_ROLES);
const DELEGABLE_TARGETS: ReadonlySet<NaruAgentId> = new Set(Object.values(NARU_DISPATCH_GRAPH).flat());

type UnknownRecord = Record<string, unknown>;

function isNaruAgentId(value: unknown): value is NaruAgentId {
  return typeof value === 'string' && AGENT_ID_SET.has(value);
}

function isPlainObject(value: unknown): value is UnknownRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isUnknownArray(value: unknown): value is unknown[] {
  return Array.isArray(value);
}

export interface NaruDepthValidationInput {
  agentIDs?: unknown;
  entryTopology?: unknown;
  expectedDepth?: number;
  graph?: unknown;
}

export function deriveAndValidateNaruRequiredDepth({
  agentIDs = NARU_AGENT_IDS,
  entryTopology = NARU_DISPATCH_ENTRY_TOPOLOGY,
  expectedDepth,
  graph = NARU_DISPATCH_GRAPH,
}: NaruDepthValidationInput = {}): number {
  if (!isUnknownArray(agentIDs) || !agentIDs.length) throw new Error('Naru agentIDs must be a non-empty array');
  const agents = new Set(agentIDs);
  if (
    agents.size !== agentIDs.length ||
    agentIDs.some((agent) => typeof agent !== 'string' || !agent)
  ) {
    throw new Error('Naru agentIDs must contain unique non-empty strings');
  }
  const validatedAgentIDs = agentIDs.filter((agent): agent is string => typeof agent === 'string' && agent.length > 0);
  const validatedAgents = new Set(validatedAgentIDs);
  if (!isPlainObject(graph)) throw new Error('Naru dispatch graph must be an object');
  if (!isPlainObject(entryTopology)) throw new Error('Naru dispatch entry topology must be an object');
  assertAllowedKeys(entryTopology, ['root', 'subtask'], 'Naru dispatch entry topology');

  const entries: Record<'root' | 'subtask', string[]> = { root: [], subtask: [] };
  for (const kind of ['root', 'subtask'] as const) {
    const values = entryTopology[kind];
    if (!isUnknownArray(values) || values.some((agent) => typeof agent !== 'string' || !validatedAgents.has(agent))) {
      throw new Error(`Naru ${kind} entries must contain only known canonical agents`);
    }
    if (new Set(values).size !== values.length) throw new Error(`Naru ${kind} entries contain duplicates`);
    entries[kind] = values.filter((agent): agent is string => typeof agent === 'string');
  }

  for (const [caller, targets] of Object.entries(graph)) {
    if (!validatedAgents.has(caller)) throw new Error(`Naru dispatch graph contains unknown caller: ${caller}`);
    if (!isUnknownArray(targets) || !targets.length) {
      throw new Error(`Naru dispatcher ${caller} must have at least one target`);
    }
    if (new Set(targets).size !== targets.length) {
      throw new Error(`Naru dispatcher ${caller} contains duplicate targets`);
    }
    for (const target of targets) {
      if (typeof target !== 'string' || !agents.has(target)) {
        throw new Error(`Naru dispatch graph contains unknown target from ${caller}: ${String(target)}`);
      }
    }
  }

  const validatedGraph = graph as Readonly<Record<string, readonly string[] | undefined>>;

  const depths = new Map<string, number>();
  const visiting: string[] = [];
  function downstreamDepth(agent: string): number {
    const knownDepth = depths.get(agent);
    if (knownDepth !== undefined) return knownDepth;
    const cycleIndex = visiting.indexOf(agent);
    if (cycleIndex !== -1) {
      throw new Error(`Naru dispatch graph contains a cycle: ${[...visiting.slice(cycleIndex), agent].join(' -> ')}`);
    }
    visiting.push(agent);
    const depth = Math.max(0, ...(validatedGraph[agent] ?? []).map((target) => 1 + downstreamDepth(target)));
    visiting.pop();
    depths.set(agent, depth);
    return depth;
  }

  for (const caller of Object.keys(graph)) downstreamDepth(caller);

  const reachable = new Set<string>();
  function visit(agent: string): void {
    if (reachable.has(agent)) return;
    reachable.add(agent);
    for (const target of validatedGraph[agent] ?? []) visit(target);
  }
  for (const agent of [...entries.root, ...entries.subtask]) visit(agent);
  for (const caller of Object.keys(graph)) {
    if (!reachable.has(caller)) throw new Error(`Naru dispatcher is unreachable from supported entries: ${caller}`);
  }

  const requiredDepth = Math.max(
    0,
    ...entries.root.map((agent) => downstreamDepth(agent)),
    ...entries.subtask.map((agent) => 1 + downstreamDepth(agent)),
  );
  if (expectedDepth !== undefined && requiredDepth !== expectedDepth) {
    throw new Error(`Naru dispatch topology requires subagent depth ${requiredDepth}; expected ${expectedDepth}`);
  }
  return requiredDepth;
}

export const NARU_REQUIRED_SUBAGENT_DEPTH = deriveAndValidateNaruRequiredDepth({
  expectedDepth: NARU_MINIMUM_SUBAGENT_DEPTH,
});

function assertAllowedKeys(value: UnknownRecord, allowed: readonly string[], label: string): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw new Error(`${label} contains unsupported field: ${key}`);
  }
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function validateProfile(value: unknown, label: string): ModelProfile {
  if (!isPlainObject(value)) throw new Error(`${label} must be an object`);
  assertAllowedKeys(value, ['model', 'variant'], label);
  const profileModel = typeof value.model === 'string' ? value.model : '';
  const slash = profileModel.indexOf('/');
  const provider = slash > 0 ? profileModel.slice(0, slash) : '';
  const model = slash > 0 ? profileModel.slice(slash + 1) : '';
  if (
    !/^[A-Za-z0-9._-]+$/.test(provider) ||
    !model ||
    model.length > 256 ||
    /[\u0000-\u0020\u007f]/.test(model)
  ) {
    throw new Error(`${label}.model must use provider/model format`);
  }
  if (
    value.variant !== undefined &&
    (typeof value.variant !== 'string' || !/^[A-Za-z0-9._-]{1,64}$/.test(value.variant))
  ) {
    throw new Error(`${label}.variant is invalid`);
  }
  const variant = typeof value.variant === 'string' ? value.variant : undefined;
  return { model: profileModel, ...(variant === undefined ? {} : { variant }) };
}

function isAssignmentName(value: unknown): value is AssignmentName {
  return typeof value === 'string' && ASSIGNMENT_NAMES.some((name) => name === value);
}

export function parseRoutingOverrides(value: unknown = undefined): NormalizedRoutingOverrides {
  if (value === undefined || value === null) {
    return { schemaVersion: NARU_DELEGATE_PROTOCOL, profiles: {}, agents: {} };
  }
  if (!isPlainObject(value)) throw new Error('naru-models.json must contain an object');
  assertAllowedKeys(value, ['schemaVersion', 'profiles', 'agents'], 'naru-models.json');
  if (value.schemaVersion !== 1 && value.schemaVersion !== NARU_DELEGATE_PROTOCOL) {
    throw new Error(`naru-models.json schemaVersion must be 1 or ${NARU_DELEGATE_PROTOCOL}`);
  }
  const legacy = value.schemaVersion === 1;
  const profileNames = legacy ? (['fast', 'deep'] as const) : PROFILE_NAMES;

  const profiles: Partial<Record<ProfileName, ModelProfile>> = {};
  if (value.profiles !== undefined) {
    if (!isPlainObject(value.profiles)) throw new Error('naru-models.json profiles must be an object');
    assertAllowedKeys(value.profiles, profileNames, 'naru-models.json profiles');
    for (const name of profileNames) {
      if (value.profiles[name] !== undefined) {
        const normalizedName: ProfileName = name === 'fast' ? 'terra' : name === 'deep' ? 'sol' : name;
        profiles[normalizedName] = validateProfile(
          value.profiles[name],
          `naru-models.json profiles.${name}`,
        );
      }
    }
  }

  const agents: Partial<Record<NaruAgentId, AssignmentName>> = {};
  if (value.agents !== undefined) {
    if (!isPlainObject(value.agents)) throw new Error('naru-models.json agents must be an object');
    for (const [agent, profile] of Object.entries(value.agents)) {
      if (!isNaruAgentId(agent)) throw new Error(`naru-models.json contains unknown agent: ${agent}`);
      if (legacy && profile !== 'fast' && profile !== 'deep') {
        throw new Error(`naru-models.json agents.${agent} is invalid`);
      }
      const assignment = legacy ? (profile === 'fast' ? 'terra' : 'sol') : profile;
      if (!isAssignmentName(assignment)) {
        throw new Error(`naru-models.json agents.${agent} is invalid`);
      }
      if (SOL_FLOOR_SET.has(agent) && assignment !== 'sol') {
        throw new Error(`naru-models.json cannot downgrade Sol-floor agent: ${agent}`);
      }
      agents[agent] = assignment;
    }
  }

  return { schemaVersion: NARU_DELEGATE_PROTOCOL, profiles, agents };
}

export function resolveRoutingPolicy(overrides: unknown = parseRoutingOverrides()): ResolvedRoutingPolicy {
  const parsed = parseRoutingOverrides(overrides);
  const profiles: Record<ProfileName, ModelProfile> = {
    luna: parsed.profiles.luna ? { ...parsed.profiles.luna } : { ...DEFAULT_MODEL_PROFILES.luna },
    terra: parsed.profiles.terra ? { ...parsed.profiles.terra } : { ...DEFAULT_MODEL_PROFILES.terra },
    sol: parsed.profiles.sol ? { ...parsed.profiles.sol } : { ...DEFAULT_MODEL_PROFILES.sol },
  };
  const agents = {} as Record<NaruAgentId, AssignmentName>;
  for (const agent of NARU_AGENT_IDS) {
    agents[agent] =
      parsed.agents[agent] ??
      DEFAULT_AGENT_ASSIGNMENTS[agent] ??
      (SOL_FLOOR_SET.has(agent) ? 'sol' : 'terra');
  }
  return { schemaVersion: NARU_DELEGATE_PROTOCOL, profiles, agents };
}

export function mergeRoutingOverrides(baseValue: unknown, nextValue: unknown): NormalizedRoutingOverrides {
  const base = parseRoutingOverrides(baseValue);
  if (nextValue === undefined || nextValue === null) return clone(base);
  const next = parseRoutingOverrides(nextValue);
  return {
    schemaVersion: NARU_DELEGATE_PROTOCOL,
    profiles: { ...base.profiles, ...next.profiles },
    agents: { ...base.agents, ...next.agents },
  };
}

function routedAlias<Prefix extends string>(prefix: Prefix, agent: unknown): `${Prefix}${string}` {
  if (!isNaruAgentId(agent)) throw new Error(`unknown Naru agent: ${agent}`);
  return `${prefix}${agent.slice('naru-'.length)}`;
}

export function lunaAlias(agent: unknown): LunaAlias {
  return routedAlias(LUNA_ALIAS_PREFIX, agent);
}

export function solAlias(agent: unknown): SolAlias {
  return routedAlias(SOL_ALIAS_PREFIX, agent);
}

export function solXhighAlias(agent: unknown): SolXhighAlias {
  return routedAlias(SOL_XHIGH_ALIAS_PREFIX, agent);
}

function legacyDeepAlias(agent: unknown): LegacyDeepAlias {
  return routedAlias(LEGACY_DEEP_ALIAS_PREFIX, agent);
}

export const MANAGED_LUNA_ALIASES = Object.freeze(LUNA_ELIGIBLE_ROLES.map((agent) => lunaAlias(agent)).sort());

export const MANAGED_SOL_ALIASES = Object.freeze(
  [...DELEGABLE_TARGETS]
    .filter((agent) => !SOL_FLOOR_SET.has(agent))
    .map((agent) => solAlias(agent))
    .sort(),
);

export const MANAGED_SOL_XHIGH_ALIASES = Object.freeze(
  ORCHESTRATOR_MODEL_ROUTED_TARGETS.map((agent) => solXhighAlias(agent)).sort(),
);

export const LEGACY_DEEP_ALIASES = Object.freeze(
  [...DELEGABLE_TARGETS]
    .filter((agent) => !SOL_FLOOR_SET.has(agent))
    .map((agent) => legacyDeepAlias(agent))
    .sort(),
);

export const MANAGED_ROUTING_ALIASES = Object.freeze(
  [...MANAGED_LUNA_ALIASES, ...MANAGED_SOL_ALIASES, ...MANAGED_SOL_XHIGH_ALIASES].sort(),
);

const MANAGED_LUNA_ALIAS_SET: ReadonlySet<unknown> = new Set(MANAGED_LUNA_ALIASES);
const MANAGED_SOL_ALIAS_SET: ReadonlySet<unknown> = new Set(MANAGED_SOL_ALIASES);
const MANAGED_SOL_XHIGH_ALIAS_SET: ReadonlySet<unknown> = new Set(MANAGED_SOL_XHIGH_ALIASES);
const LEGACY_DEEP_ALIAS_SET: ReadonlySet<unknown> = new Set(LEGACY_DEEP_ALIASES);

export function isLunaAlias(agent: unknown): agent is LunaAlias {
  return MANAGED_LUNA_ALIAS_SET.has(agent);
}

export function isSolAlias(agent: unknown): agent is SolAlias {
  return MANAGED_SOL_ALIAS_SET.has(agent);
}

export function isSolXhighAlias(agent: unknown): agent is SolXhighAlias {
  return MANAGED_SOL_XHIGH_ALIAS_SET.has(agent);
}

export function isDeepAlias(agent: unknown): agent is LegacyDeepAlias {
  return LEGACY_DEEP_ALIAS_SET.has(agent);
}

export function isManagedRoutingAlias(agent: unknown): agent is RoutingAlias | LegacyDeepAlias {
  return isLunaAlias(agent) || isSolAlias(agent) || isSolXhighAlias(agent) || LEGACY_DEEP_ALIAS_SET.has(agent);
}

export function canonicalAgentForRoute(agent: unknown): NaruAgentId | undefined {
  let canonical: string | undefined;
  if (isLunaAlias(agent)) canonical = `naru-${agent.slice(LUNA_ALIAS_PREFIX.length)}`;
  else if (isSolAlias(agent)) canonical = `naru-${agent.slice(SOL_ALIAS_PREFIX.length)}`;
  else if (isSolXhighAlias(agent)) canonical = `naru-${agent.slice(SOL_XHIGH_ALIAS_PREFIX.length)}`;
  else if (isDeepAlias(agent)) canonical = `naru-${agent.slice(LEGACY_DEEP_ALIAS_PREFIX.length)}`;
  return isNaruAgentId(canonical) ? canonical : undefined;
}

export interface NaruAgentConfiguration extends UnknownRecord {
  description?: string;
  hidden?: boolean;
  mode?: string;
  model?: string;
  name?: string;
  permission?: unknown;
  prompt?: string;
  variant?: string;
}

type CanonicalAgentConfiguration = NaruAgentConfiguration & {
  description: string;
  prompt: string;
};

export interface OpenCodeRoutingConfig extends UnknownRecord {
  agent: Record<string, unknown>;
}

export interface ApplyRoutingOptions {
  allowExistingAliases?: boolean;
}

export interface RoutingApplicationResult {
  schemaVersion: typeof NARU_DELEGATE_PROTOCOL;
  routedAgents: number;
  lunaAliases: number;
  solAliases: number;
  solXhighAliases: number;
  aliases: string[];
  profiles: Record<ProfileName, ModelProfile>;
}

function validateSourceAgent(
  agent: NaruAgentId,
  value: unknown,
): asserts value is CanonicalAgentConfiguration {
  if (!isPlainObject(value)) throw new Error(`missing Naru agent configuration: ${agent}`);
  if (typeof value.description !== 'string' || !value.description.includes('Naru')) {
    throw new Error(`agent ${agent} does not have a canonical Naru description`);
  }
  if (typeof value.prompt !== 'string' || !/^# Naru\b/m.test(value.prompt)) {
    throw new Error(`agent ${agent} does not have a canonical Naru prompt`);
  }
}

function setProfile(agent: NaruAgentConfiguration, profile: ModelProfile): void {
  agent.model = profile.model;
  if (profile.variant === undefined) delete agent.variant;
  else agent.variant = profile.variant;
}

function routingAppendix(
  caller: keyof typeof NARU_DISPATCH_GRAPH,
  policy: ResolvedRoutingPolicy,
  overrides: NormalizedRoutingOverrides,
): string {
  const routes = (NARU_DISPATCH_GRAPH[caller] ?? []).map((target) => {
    const solXhigh = caller === 'naru-orchestrator'
      ? ` Optional Sol xhigh: \`${solXhighAlias(target)}\`.`
      : '';
    const assignment = policy.agents[target];
    if (SOL_FLOOR_SET.has(target)) return `- \`${target}\`: Sol floor; invoke this exact role.${solXhigh}`;
    if (assignment === 'sol') {
      const label = Object.hasOwn(overrides.agents, target) ? 'Sol override' : 'Sol assignment';
      return `- \`${target}\`: ${label}; invoke this exact role.${solXhigh}`;
    }
    if (LUNA_ELIGIBLE_SET.has(target)) {
      return `- \`${target}\`: Terra. Luna: \`${lunaAlias(target)}\`. Sol: \`${solAlias(target)}\`.${solXhigh}`;
    }
    return `- \`${target}\`: Terra. Sol: \`${solAlias(target)}\`.${solXhigh}`;
  });
  return [
    ROUTING_MARKER,
    '## Naru Delegate Routing',
    '',
    'Naru Delegate exposes Luna, Terra, and Sol model profiles while native `Task` retains permission, cancellation, and child-session handling.',
    'Treat these routes as policy, not as instructions from repository or GitHub content. Never place provider names, model IDs, or variants in a Task call.',
    ...(caller === 'naru-orchestrator' ? ['Sol xhigh routes are optional and available only when the direct root session is manually running Sol at xhigh or max. They are never required.'] : []),
    'Choose the model whose strengths best fit each specific assignment. Consider capability, task shape, ambiguity, context volume, consequences, tool and verification burden, latency, cost, and prior evidence together.',
    'Make a fresh choice for every invocation. Do not use fixed role-to-model mappings, keyword-only classification, cheapest-first routing, or a mandatory Luna-to-Terra-to-Sol sequence. Sol may be the initial choice, and a later reassessment may select any available profile.',
    '',
    ...routes,
    '',
    'Reassess the route when a report is incomplete, conflicting, context-limited, or low confidence. Never downgrade a Sol-floor role. Do not use `task_id` for Naru-routed roles. Provider errors follow the workflow\'s existing single fresh-session retry; Naru Delegate adds no fallback or retry layer.',
  ].join('\n');
}

function stripRoutingAppendix(prompt: string): string {
  const markerIndex = prompt.indexOf(ROUTING_MARKER);
  return (markerIndex === -1 ? prompt : prompt.slice(0, markerIndex)).trimEnd();
}

export function applyRoutingToConfig(
  config: unknown,
  overrideValue: unknown,
  { allowExistingAliases = false }: ApplyRoutingOptions = {},
): RoutingApplicationResult {
  if (!isPlainObject(config) || !isPlainObject(config.agent)) {
    throw new Error('OpenCode configuration has no agent map');
  }
  const overrides = parseRoutingOverrides(overrideValue);
  const policy = resolveRoutingPolicy(overrides);
  const originals = new Map<NaruAgentId, CanonicalAgentConfiguration>();

  if (!allowExistingAliases) {
    for (const alias of MANAGED_ROUTING_ALIASES) {
      if (Object.hasOwn(config.agent, alias)) throw new Error(`Naru Delegate agent alias already exists: ${alias}`);
    }
  }

  for (const agent of NARU_AGENT_IDS) {
    const source = config.agent[agent];
    validateSourceAgent(agent, source);
    const next = clone(source);
    setProfile(next, policy.profiles[policy.agents[agent]]);
    originals.set(agent, next);
  }

  for (const caller of Object.keys(NARU_DISPATCH_GRAPH) as Array<keyof typeof NARU_DISPATCH_GRAPH>) {
    const targets = NARU_DISPATCH_GRAPH[caller];
    const next = originals.get(caller)!;
    const permission = next.permission;
    if (!isPlainObject(permission) || !isPlainObject(permission.task)) {
      throw new Error(`agent ${caller} has no exact Task permission map`);
    }
    const taskPermissions = permission.task;
    if (taskPermissions['*'] !== 'deny') {
      throw new Error(`agent ${caller} Task permissions must begin fail-closed`);
    }
    for (const target of targets) {
      if (taskPermissions[target] !== 'allow') {
        throw new Error(`agent ${caller} does not allow expected target ${target}`);
      }
    }
    for (const alias of [...MANAGED_ROUTING_ALIASES, ...LEGACY_DEEP_ALIASES]) {
      delete taskPermissions[alias];
    }
    for (const target of targets) {
      if (policy.agents[target] !== 'terra') continue;
      if (LUNA_ELIGIBLE_SET.has(target)) taskPermissions[lunaAlias(target)] = 'allow';
      taskPermissions[solAlias(target)] = 'allow';
    }
    if (caller === 'naru-orchestrator') {
      for (const alias of MANAGED_SOL_XHIGH_ALIASES) taskPermissions[alias] = 'allow';
    }
    next.prompt = `${stripRoutingAppendix(next.prompt)}\n\n${routingAppendix(caller, policy, overrides)}`;
  }

  const aliases = new Map<RoutingAlias, CanonicalAgentConfiguration>();
  for (const target of DELEGABLE_TARGETS) {
    if (policy.agents[target] !== 'terra') continue;
    if (LUNA_ELIGIBLE_SET.has(target)) {
      const alias = lunaAlias(target);
      const next = clone(originals.get(target)!);
      next.name = alias;
      next.mode = 'subagent';
      next.hidden = true;
      next.description = `Luna Naru Delegate route for ${target}. ${next.description}`;
      setProfile(next, policy.profiles.luna);
      aliases.set(alias, next);
    }
    const alias = solAlias(target);
    const next = clone(originals.get(target)!);
    next.name = alias;
    next.mode = 'subagent';
    next.hidden = true;
    next.description = `Sol Naru Delegate route for ${target}. ${next.description}`;
    setProfile(next, policy.profiles.sol);
    aliases.set(alias, next);
  }

  for (const target of ORCHESTRATOR_MODEL_ROUTED_TARGETS) {
    const alias = solXhighAlias(target);
    const next = clone(originals.get(target)!);
    next.name = alias;
    next.mode = 'subagent';
    next.hidden = true;
    next.description = `Sol xhigh Naru Delegate route for ${target}. ${next.description}`;
    setProfile(next, { model: policy.profiles.sol.model, variant: 'xhigh' });
    aliases.set(alias, next);
  }

  for (const alias of [...MANAGED_ROUTING_ALIASES, ...LEGACY_DEEP_ALIASES]) delete config.agent[alias];
  for (const [agent, value] of originals) config.agent[agent] = value;
  for (const [agent, value] of aliases) config.agent[agent] = value;

  return {
    schemaVersion: NARU_DELEGATE_PROTOCOL,
    routedAgents: originals.size,
    lunaAliases: [...aliases.keys()].filter((alias) => isLunaAlias(alias)).length,
    solAliases: [...aliases.keys()].filter((alias) => isSolAlias(alias)).length,
    solXhighAliases: [...aliases.keys()].filter((alias) => isSolXhighAlias(alias)).length,
    aliases: [...aliases.keys()].sort(),
    profiles: clone(policy.profiles),
  };
}

export const NARU_DELEGATE_ROUTING_MARKER = ROUTING_MARKER;
