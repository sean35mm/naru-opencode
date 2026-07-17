const PROFILE_NAMES = ['luna', 'terra', 'sol'];
const ASSIGNMENT_NAMES = ['terra', 'sol'];
const LUNA_ALIAS_PREFIX = 'naru-delegate-luna-';
const SOL_ALIAS_PREFIX = 'naru-delegate-sol-';
const SOL_XHIGH_ALIAS_PREFIX = 'naru-delegate-sol-xhigh-';
const LEGACY_DEEP_ALIAS_PREFIX = 'naru-delegate-deep-';
const ROUTING_MARKER = '<!-- naru-delegate-routing:v1 -->';

export const NARU_DELEGATE_PROTOCOL = 2;

export const DEFAULT_MODEL_PROFILES = Object.freeze({
  luna: Object.freeze({ model: 'openai/gpt-5.6-luna-fast', variant: 'high' }),
  terra: Object.freeze({ model: 'openai/gpt-5.6-terra-fast', variant: 'high' }),
  sol: Object.freeze({ model: 'openai/gpt-5.6-sol-fast', variant: 'high' }),
});

export const DEFAULT_AGENT_ASSIGNMENTS = Object.freeze({
  'naru-orchestrator': 'sol',
});

export const NARU_AGENT_IDS = Object.freeze([
  'naru-plan',
  'naru-plan-architecture',
  'naru-plan-minimal-change',
  'naru-plan-risk',
  'naru-plan-tests',
  'naru-plan-judge',
  'naru-impact',
  'naru-impact-topology',
  'naru-impact-contracts',
  'naru-impact-data',
  'naru-impact-frontend-mobile',
  'naru-impact-tests-ci',
  'naru-impact-judge',
  'naru-triage',
  'naru-triage-reproduction',
  'naru-triage-codepath',
  'naru-triage-regression',
  'naru-triage-tests',
  'naru-triage-judge',
  'naru-review',
  'naru-review-security',
  'naru-review-backend',
  'naru-review-frontend-mobile',
  'naru-review-integrations',
  'naru-review-tests-ci',
  'naru-review-judge',
  'naru-review-post',
  'naru-orchestrator',
  'naru-minion-scout',
  'naru-minion-investigate',
  'naru-minion-architect',
  'naru-minion-implement',
  'naru-minion-debug',
  'naru-minion-verify',
  'naru-minion-judge',
]);

export const SOL_FLOOR_ROLES = Object.freeze([
  'naru-plan-architecture',
  'naru-plan-risk',
  'naru-plan-judge',
  'naru-impact-contracts',
  'naru-impact-data',
  'naru-impact-judge',
  'naru-triage-judge',
  'naru-review-security',
  'naru-review-backend',
  'naru-review-integrations',
  'naru-review-judge',
  'naru-minion-architect',
  'naru-minion-judge',
]);

// Retained so a copy-pinned v1 dashboard can still load after the routing helper is upgraded.
export const DEEP_FLOOR_ROLES = SOL_FLOOR_ROLES;

export const LUNA_ELIGIBLE_ROLES = Object.freeze([
  'naru-minion-scout',
  'naru-minion-investigate',
  'naru-minion-implement',
  'naru-minion-debug',
  'naru-minion-verify',
]);

export const NARU_DISPATCH_GRAPH = Object.freeze({
  'naru-plan': Object.freeze([
    'naru-plan-architecture',
    'naru-plan-minimal-change',
    'naru-plan-risk',
    'naru-plan-tests',
    'naru-plan-judge',
  ]),
  'naru-impact': Object.freeze([
    'naru-impact-topology',
    'naru-impact-contracts',
    'naru-impact-data',
    'naru-impact-frontend-mobile',
    'naru-impact-tests-ci',
    'naru-impact-judge',
  ]),
  'naru-triage': Object.freeze([
    'naru-triage-reproduction',
    'naru-triage-codepath',
    'naru-triage-regression',
    'naru-triage-tests',
    'naru-triage-judge',
  ]),
  'naru-review': Object.freeze([
    'naru-review-security',
    'naru-review-backend',
    'naru-review-frontend-mobile',
    'naru-review-integrations',
    'naru-review-tests-ci',
    'naru-review-judge',
  ]),
  'naru-review-post': Object.freeze(['naru-review']),
  'naru-orchestrator': Object.freeze([
    'naru-review',
    'naru-minion-scout',
    'naru-minion-investigate',
    'naru-minion-architect',
    'naru-minion-implement',
    'naru-minion-debug',
    'naru-minion-verify',
    'naru-minion-judge',
  ]),
});

const ORCHESTRATOR_MODEL_ROUTED_TARGETS = Object.freeze([
  'naru-minion-scout',
  'naru-minion-investigate',
  'naru-minion-architect',
  'naru-minion-implement',
  'naru-minion-debug',
  'naru-minion-verify',
  'naru-minion-judge',
]);

const AGENT_ID_SET = new Set(NARU_AGENT_IDS);
const SOL_FLOOR_SET = new Set(SOL_FLOOR_ROLES);
const LUNA_ELIGIBLE_SET = new Set(LUNA_ELIGIBLE_ROLES);
const DELEGABLE_TARGETS = new Set(Object.values(NARU_DISPATCH_GRAPH).flat());

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertAllowedKeys(value, allowed, label) {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw new Error(`${label} contains unsupported field: ${key}`);
  }
}

function clone(value) {
  return structuredClone(value);
}

function validateProfile(value, label) {
  if (!isPlainObject(value)) throw new Error(`${label} must be an object`);
  assertAllowedKeys(value, ['model', 'variant'], label);
  const slash = typeof value.model === 'string' ? value.model.indexOf('/') : -1;
  const provider = slash > 0 ? value.model.slice(0, slash) : '';
  const model = slash > 0 ? value.model.slice(slash + 1) : '';
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
  return { model: value.model, ...(value.variant === undefined ? {} : { variant: value.variant }) };
}

export function parseRoutingOverrides(value) {
  if (value === undefined || value === null) {
    return { schemaVersion: NARU_DELEGATE_PROTOCOL, profiles: {}, agents: {} };
  }
  if (!isPlainObject(value)) throw new Error('naru-models.json must contain an object');
  assertAllowedKeys(value, ['schemaVersion', 'profiles', 'agents'], 'naru-models.json');
  if (value.schemaVersion !== 1 && value.schemaVersion !== NARU_DELEGATE_PROTOCOL) {
    throw new Error(`naru-models.json schemaVersion must be 1 or ${NARU_DELEGATE_PROTOCOL}`);
  }
  const legacy = value.schemaVersion === 1;
  const profileNames = legacy ? ['fast', 'deep'] : PROFILE_NAMES;
  const profileMap = legacy ? { fast: 'terra', deep: 'sol' } : {};
  const assignmentMap = legacy ? { fast: 'terra', deep: 'sol' } : {};

  const profiles = {};
  if (value.profiles !== undefined) {
    if (!isPlainObject(value.profiles)) throw new Error('naru-models.json profiles must be an object');
    assertAllowedKeys(value.profiles, profileNames, 'naru-models.json profiles');
    for (const name of profileNames) {
      if (value.profiles[name] !== undefined) {
        profiles[profileMap[name] ?? name] = validateProfile(
          value.profiles[name],
          `naru-models.json profiles.${name}`,
        );
      }
    }
  }

  const agents = {};
  if (value.agents !== undefined) {
    if (!isPlainObject(value.agents)) throw new Error('naru-models.json agents must be an object');
    for (const [agent, profile] of Object.entries(value.agents)) {
      if (!AGENT_ID_SET.has(agent)) throw new Error(`naru-models.json contains unknown agent: ${agent}`);
      if (legacy && !Object.hasOwn(assignmentMap, profile)) {
        throw new Error(`naru-models.json agents.${agent} is invalid`);
      }
      const assignment = assignmentMap[profile] ?? profile;
      if (!ASSIGNMENT_NAMES.includes(assignment)) {
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

export function resolveRoutingPolicy(overrides = parseRoutingOverrides()) {
  const parsed = parseRoutingOverrides(overrides);
  const profiles = {
    luna: parsed.profiles.luna ? { ...parsed.profiles.luna } : { ...DEFAULT_MODEL_PROFILES.luna },
    terra: parsed.profiles.terra ? { ...parsed.profiles.terra } : { ...DEFAULT_MODEL_PROFILES.terra },
    sol: parsed.profiles.sol ? { ...parsed.profiles.sol } : { ...DEFAULT_MODEL_PROFILES.sol },
  };
  const agents = {};
  for (const agent of NARU_AGENT_IDS) {
    agents[agent] =
      parsed.agents[agent] ??
      DEFAULT_AGENT_ASSIGNMENTS[agent] ??
      (SOL_FLOOR_SET.has(agent) ? 'sol' : 'terra');
  }
  return { schemaVersion: NARU_DELEGATE_PROTOCOL, profiles, agents };
}

export function mergeRoutingOverrides(baseValue, nextValue) {
  const base = parseRoutingOverrides(baseValue);
  if (nextValue === undefined || nextValue === null) return clone(base);
  const next = parseRoutingOverrides(nextValue);
  return {
    schemaVersion: NARU_DELEGATE_PROTOCOL,
    profiles: { ...base.profiles, ...next.profiles },
    agents: { ...base.agents, ...next.agents },
  };
}

function routedAlias(prefix, agent) {
  if (!AGENT_ID_SET.has(agent)) throw new Error(`unknown Naru agent: ${agent}`);
  return `${prefix}${agent.slice('naru-'.length)}`;
}

export function lunaAlias(agent) {
  return routedAlias(LUNA_ALIAS_PREFIX, agent);
}

export function solAlias(agent) {
  return routedAlias(SOL_ALIAS_PREFIX, agent);
}

export function solXhighAlias(agent) {
  return routedAlias(SOL_XHIGH_ALIAS_PREFIX, agent);
}

function legacyDeepAlias(agent) {
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

const MANAGED_LUNA_ALIAS_SET = new Set(MANAGED_LUNA_ALIASES);
const MANAGED_SOL_ALIAS_SET = new Set(MANAGED_SOL_ALIASES);
const MANAGED_SOL_XHIGH_ALIAS_SET = new Set(MANAGED_SOL_XHIGH_ALIASES);
const LEGACY_DEEP_ALIAS_SET = new Set(LEGACY_DEEP_ALIASES);

export function isLunaAlias(agent) {
  return MANAGED_LUNA_ALIAS_SET.has(agent);
}

export function isSolAlias(agent) {
  return MANAGED_SOL_ALIAS_SET.has(agent);
}

export function isSolXhighAlias(agent) {
  return MANAGED_SOL_XHIGH_ALIAS_SET.has(agent);
}

export function isDeepAlias(agent) {
  return LEGACY_DEEP_ALIAS_SET.has(agent);
}

export function isManagedRoutingAlias(agent) {
  return isLunaAlias(agent) || isSolAlias(agent) || isSolXhighAlias(agent) || LEGACY_DEEP_ALIAS_SET.has(agent);
}

export function canonicalAgentForRoute(agent) {
  if (isLunaAlias(agent)) return `naru-${agent.slice(LUNA_ALIAS_PREFIX.length)}`;
  if (isSolAlias(agent)) return `naru-${agent.slice(SOL_ALIAS_PREFIX.length)}`;
  if (isSolXhighAlias(agent)) return `naru-${agent.slice(SOL_XHIGH_ALIAS_PREFIX.length)}`;
  if (LEGACY_DEEP_ALIAS_SET.has(agent)) return `naru-${agent.slice(LEGACY_DEEP_ALIAS_PREFIX.length)}`;
}

function validateSourceAgent(agent, value) {
  if (!isPlainObject(value)) throw new Error(`missing Naru agent configuration: ${agent}`);
  if (typeof value.description !== 'string' || !value.description.includes('Naru')) {
    throw new Error(`agent ${agent} does not have a canonical Naru description`);
  }
  if (typeof value.prompt !== 'string' || !/^# Naru\b/m.test(value.prompt)) {
    throw new Error(`agent ${agent} does not have a canonical Naru prompt`);
  }
}

function setProfile(agent, profile) {
  agent.model = profile.model;
  if (profile.variant === undefined) delete agent.variant;
  else agent.variant = profile.variant;
}

function routingAppendix(caller, policy, overrides) {
  const routes = NARU_DISPATCH_GRAPH[caller].map((target) => {
    if (caller === 'naru-orchestrator' && target === 'naru-review') {
      return '- `naru-review`: canonical-only review lane; invoke this exact role with no generated model alias.';
    }
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

function stripRoutingAppendix(prompt) {
  const markerIndex = prompt.indexOf(ROUTING_MARKER);
  return (markerIndex === -1 ? prompt : prompt.slice(0, markerIndex)).trimEnd();
}

export function applyRoutingToConfig(config, overrideValue, { allowExistingAliases = false } = {}) {
  if (!isPlainObject(config) || !isPlainObject(config.agent)) {
    throw new Error('OpenCode configuration has no agent map');
  }
  const overrides = parseRoutingOverrides(overrideValue);
  const policy = resolveRoutingPolicy(overrides);
  const originals = new Map();

  if (!allowExistingAliases) {
    for (const alias of MANAGED_ROUTING_ALIASES) {
      if (Object.hasOwn(config.agent, alias)) throw new Error(`Naru Delegate agent alias already exists: ${alias}`);
    }
  }

  for (const agent of NARU_AGENT_IDS) {
    validateSourceAgent(agent, config.agent[agent]);
    const next = clone(config.agent[agent]);
    setProfile(next, policy.profiles[policy.agents[agent]]);
    originals.set(agent, next);
  }

  for (const [caller, targets] of Object.entries(NARU_DISPATCH_GRAPH)) {
    const next = originals.get(caller);
    if (!isPlainObject(next.permission) || !isPlainObject(next.permission.task)) {
      throw new Error(`agent ${caller} has no exact Task permission map`);
    }
    if (next.permission.task['*'] !== 'deny') {
      throw new Error(`agent ${caller} Task permissions must begin fail-closed`);
    }
    for (const target of targets) {
      if (next.permission.task[target] !== 'allow') {
        throw new Error(`agent ${caller} does not allow expected target ${target}`);
      }
    }
    for (const alias of [...MANAGED_ROUTING_ALIASES, ...LEGACY_DEEP_ALIASES]) {
      delete next.permission.task[alias];
    }
    for (const target of targets) {
      if (caller === 'naru-orchestrator' && target === 'naru-review') continue;
      if (policy.agents[target] !== 'terra') continue;
      if (LUNA_ELIGIBLE_SET.has(target)) next.permission.task[lunaAlias(target)] = 'allow';
      next.permission.task[solAlias(target)] = 'allow';
    }
    if (caller === 'naru-orchestrator') {
      for (const alias of MANAGED_SOL_XHIGH_ALIASES) next.permission.task[alias] = 'allow';
    }
    next.prompt = `${stripRoutingAppendix(next.prompt)}\n\n${routingAppendix(caller, policy, overrides)}`;
  }

  const aliases = new Map();
  for (const target of DELEGABLE_TARGETS) {
    if (policy.agents[target] !== 'terra') continue;
    if (LUNA_ELIGIBLE_SET.has(target)) {
      const alias = lunaAlias(target);
      const next = clone(originals.get(target));
      next.name = alias;
      next.mode = 'subagent';
      next.hidden = true;
      next.description = `Luna Naru Delegate route for ${target}. ${next.description}`;
      setProfile(next, policy.profiles.luna);
      aliases.set(alias, next);
    }
    const alias = solAlias(target);
    const next = clone(originals.get(target));
    next.name = alias;
    next.mode = 'subagent';
    next.hidden = true;
    next.description = `Sol Naru Delegate route for ${target}. ${next.description}`;
    setProfile(next, policy.profiles.sol);
    aliases.set(alias, next);
  }

  for (const target of ORCHESTRATOR_MODEL_ROUTED_TARGETS) {
    const alias = solXhighAlias(target);
    const next = clone(originals.get(target));
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
