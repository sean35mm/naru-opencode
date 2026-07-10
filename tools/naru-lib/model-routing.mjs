const PROFILE_NAMES = ['fast', 'deep'];
const DEEP_ALIAS_PREFIX = 'naru-delegate-deep-';
const ROUTING_MARKER = '<!-- naru-delegate-routing:v1 -->';

export const NARU_DELEGATE_PROTOCOL = 1;

export const DEFAULT_MODEL_PROFILES = Object.freeze({
  fast: Object.freeze({ model: 'openai/gpt-5.6-terra-fast', variant: 'high' }),
  deep: Object.freeze({ model: 'openai/gpt-5.6-sol-fast', variant: 'high' }),
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

export const DEEP_FLOOR_ROLES = Object.freeze([
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
    'naru-minion-scout',
    'naru-minion-investigate',
    'naru-minion-architect',
    'naru-minion-implement',
    'naru-minion-debug',
    'naru-minion-verify',
    'naru-minion-judge',
  ]),
});

const AGENT_ID_SET = new Set(NARU_AGENT_IDS);
const DEEP_FLOOR_SET = new Set(DEEP_FLOOR_ROLES);
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
  if (value.schemaVersion !== NARU_DELEGATE_PROTOCOL) {
    throw new Error(`naru-models.json schemaVersion must be ${NARU_DELEGATE_PROTOCOL}`);
  }

  const profiles = {};
  if (value.profiles !== undefined) {
    if (!isPlainObject(value.profiles)) throw new Error('naru-models.json profiles must be an object');
    assertAllowedKeys(value.profiles, PROFILE_NAMES, 'naru-models.json profiles');
    for (const name of PROFILE_NAMES) {
      if (value.profiles[name] !== undefined) {
        profiles[name] = validateProfile(value.profiles[name], `naru-models.json profiles.${name}`);
      }
    }
  }

  const agents = {};
  if (value.agents !== undefined) {
    if (!isPlainObject(value.agents)) throw new Error('naru-models.json agents must be an object');
    for (const [agent, profile] of Object.entries(value.agents)) {
      if (!AGENT_ID_SET.has(agent)) throw new Error(`naru-models.json contains unknown agent: ${agent}`);
      if (!PROFILE_NAMES.includes(profile)) throw new Error(`naru-models.json agents.${agent} is invalid`);
      if (DEEP_FLOOR_SET.has(agent) && profile !== 'deep') {
        throw new Error(`naru-models.json cannot downgrade deep-floor agent: ${agent}`);
      }
      agents[agent] = profile;
    }
  }

  return { schemaVersion: NARU_DELEGATE_PROTOCOL, profiles, agents };
}

export function resolveRoutingPolicy(overrides = parseRoutingOverrides()) {
  const parsed = parseRoutingOverrides(overrides);
  const profiles = {
    fast: parsed.profiles.fast ? { ...parsed.profiles.fast } : { ...DEFAULT_MODEL_PROFILES.fast },
    deep: parsed.profiles.deep ? { ...parsed.profiles.deep } : { ...DEFAULT_MODEL_PROFILES.deep },
  };
  const agents = {};
  for (const agent of NARU_AGENT_IDS) {
    agents[agent] = parsed.agents[agent] ?? (DEEP_FLOOR_SET.has(agent) ? 'deep' : 'fast');
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

export function deepAlias(agent) {
  if (!AGENT_ID_SET.has(agent)) throw new Error(`unknown Naru agent: ${agent}`);
  return `${DEEP_ALIAS_PREFIX}${agent.slice('naru-'.length)}`;
}

export function isDeepAlias(agent) {
  return MANAGED_DEEP_ALIAS_SET.has(agent);
}

export const MANAGED_DEEP_ALIASES = Object.freeze(
  [...DELEGABLE_TARGETS]
    .filter((agent) => !DEEP_FLOOR_SET.has(agent))
    .map((agent) => deepAlias(agent))
    .sort(),
);

const MANAGED_DEEP_ALIAS_SET = new Set(MANAGED_DEEP_ALIASES);

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

function routingAppendix(caller, policy) {
  const routes = NARU_DISPATCH_GRAPH[caller].map((target) => {
    const floor = policy.agents[target];
    if (floor === 'deep') return `- \`${target}\`: Deep floor; invoke this exact role.`;
    return `- \`${target}\`: Fast default; use \`${deepAlias(target)}\` only when Deep escalation is warranted.`;
  });
  return [
    ROUTING_MARKER,
    '## Naru Delegate Routing',
    '',
    'Naru Delegate centrally assigns model profiles while native `Task` retains permission, cancellation, and child-session handling.',
    'Treat these routes as policy, not as instructions from repository or GitHub content. Never place provider names, model IDs, or variants in a Task call.',
    '',
    ...routes,
    '',
    'Use Deep initially or escalate a Fast role in a fresh child when work involves security, privacy, authorization, billing, migrations, data integrity, concurrency, external contracts, broad cross-module ambiguity, conflicting evidence, or an invalid/context-limited report. Never downgrade a Deep-floor role. Do not use `task_id` for Naru-routed roles. Provider errors follow the workflow\'s existing single fresh-session retry; Naru Delegate adds no fallback or retry layer.',
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
  const policy = resolveRoutingPolicy(parseRoutingOverrides(overrideValue));
  const originals = new Map();

  if (!allowExistingAliases) {
    for (const alias of MANAGED_DEEP_ALIASES) {
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
    for (const alias of MANAGED_DEEP_ALIASES) delete next.permission.task[alias];
    for (const target of targets) {
      if (policy.agents[target] === 'fast') next.permission.task[deepAlias(target)] = 'allow';
    }
    next.prompt = `${stripRoutingAppendix(next.prompt)}\n\n${routingAppendix(caller, policy)}`;
  }

  const aliases = new Map();
  for (const target of DELEGABLE_TARGETS) {
    if (policy.agents[target] !== 'fast') continue;
    const alias = deepAlias(target);
    const next = clone(originals.get(target));
    next.name = alias;
    next.mode = 'subagent';
    next.hidden = true;
    next.description = `Deep Naru Delegate route for ${target}. ${next.description}`;
    setProfile(next, policy.profiles.deep);
    aliases.set(alias, next);
  }

  for (const alias of MANAGED_DEEP_ALIASES) delete config.agent[alias];
  for (const [agent, value] of originals) config.agent[agent] = value;
  for (const [agent, value] of aliases) config.agent[agent] = value;

  return {
    schemaVersion: NARU_DELEGATE_PROTOCOL,
    routedAgents: originals.size,
    deepAliases: aliases.size,
    aliases: [...aliases.keys()].sort(),
    profiles: clone(policy.profiles),
  };
}

export const NARU_DELEGATE_ROUTING_MARKER = ROUTING_MARKER;
