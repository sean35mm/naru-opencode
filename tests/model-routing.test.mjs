import assert from 'node:assert/strict';
import test from 'node:test';

import { NaruDelegatePlugin } from '../plugins/naru-delegate.js';
import {
  applyRoutingToConfig,
  DEEP_FLOOR_ROLES,
  DEFAULT_AGENT_ASSIGNMENTS,
  DEFAULT_MODEL_PROFILES,
  deriveAndValidateNaruRequiredDepth,
  LEGACY_DEEP_ALIASES,
  isDeepAlias,
  lunaAlias,
  LUNA_ELIGIBLE_ROLES,
  MANAGED_LUNA_ALIASES,
  MANAGED_ROUTING_ALIASES,
  MANAGED_SOL_ALIASES,
  MANAGED_SOL_XHIGH_ALIASES,
  NARU_AGENT_IDS,
  NARU_DELEGATE_PROTOCOL,
  NARU_DELEGATE_ROUTING_MARKER,
  NARU_DISPATCH_ENTRY_TOPOLOGY,
  NARU_DISPATCH_GRAPH,
  NARU_MINIMUM_SUBAGENT_DEPTH,
  NARU_REQUIRED_SUBAGENT_DEPTH,
  parseRoutingOverrides,
  resolveRoutingPolicy,
  solAlias,
  solXhighAlias,
  SOL_FLOOR_ROLES,
} from '../tools/naru-lib/model-routing.mjs';

const SECRET_SAFE_READ_PERMISSION = {
  '*': 'allow',
  '.git/**': 'deny',
  '.env': 'deny',
  '.env.*': 'deny',
  '*.env': 'deny',
  '*.env.*': 'deny',
  '*.pem': 'deny',
  '*.key': 'deny',
  '*.p12': 'deny',
  '*.pfx': 'deny',
  '**/id_rsa': 'deny',
  '**/id_dsa': 'deny',
  '**/id_ecdsa': 'deny',
  '**/id_ed25519': 'deny',
  '**/.ssh/**': 'deny',
  '**/.aws/**': 'deny',
  '**/.kube/**': 'deny',
  '**/.gnupg/**': 'deny',
  '**/credentials/**': 'deny',
  '**/secrets/**': 'deny',
  '*.env.example': 'allow',
  'env.example': 'allow',
};

const READ_TOOL_PERMISSION = {
  glob: 'allow',
  grep: 'allow',
  lsp: 'allow',
  'naru-git-read': 'allow',
  'naru-github-read': 'allow',
  'codebase-memory-mcp_list_projects': 'allow',
  'codebase-memory-mcp_index_status': 'allow',
  'codebase-memory-mcp_get_graph_schema': 'allow',
  'codebase-memory-mcp_search_graph': 'allow',
  'codebase-memory-mcp_trace_path': 'allow',
  'codebase-memory-mcp_get_code_snippet': 'allow',
  'codebase-memory-mcp_get_architecture': 'allow',
  'codebase-memory-mcp_detect_changes': 'allow',
  'codebase-memory-mcp_search_code': 'allow',
  'codebase-memory-mcp_query_graph': 'allow',
};

const READ_ONLY_MINION_PERMISSION = {
  '*': 'deny',
  skill: { '*': 'allow' },
  edit: 'deny',
  apply_patch: 'deny',
  task: 'deny',
  question: 'deny',
  bash: 'deny',
  external_directory: 'deny',
  ...READ_TOOL_PERMISSION,
  read: SECRET_SAFE_READ_PERMISSION,
};

const SHELL_READ_ONLY_MINION_PERMISSION = {
  '*': 'deny',
  skill: { '*': 'allow' },
  edit: 'deny',
  apply_patch: 'deny',
  task: 'deny',
  question: 'deny',
  doom_loop: 'ask',
  external_directory: 'allow',
  ...READ_TOOL_PERMISSION,
  read: SECRET_SAFE_READ_PERMISSION,
  bash: { '*': 'allow' },
};

const IMPLEMENT_MINION_PERMISSION = {
  '*': 'deny',
  skill: { '*': 'allow' },
  edit: 'allow',
  apply_patch: 'allow',
  task: 'deny',
  question: 'deny',
  doom_loop: 'ask',
  external_directory: 'allow',
  ...READ_TOOL_PERMISSION,
  read: SECRET_SAFE_READ_PERMISSION,
  bash: { '*': 'allow' },
};

const MINION_PERMISSIONS = {
  'naru-minion-scout': READ_ONLY_MINION_PERMISSION,
  'naru-minion-investigate': READ_ONLY_MINION_PERMISSION,
  'naru-minion-architect': READ_ONLY_MINION_PERMISSION,
  'naru-minion-judge': READ_ONLY_MINION_PERMISSION,
  'naru-minion-debug': SHELL_READ_ONLY_MINION_PERMISSION,
  'naru-minion-verify': SHELL_READ_ONLY_MINION_PERMISSION,
  'naru-minion-implement': IMPLEMENT_MINION_PERMISSION,
};

function fakeConfig() {
  const config = { agent: {}, subagent_depth: 2 };
  for (const agent of NARU_AGENT_IDS) {
    config.agent[agent] = {
      description: `Canonical Naru role ${agent}`,
      hidden: true,
      mode: 'subagent',
      permission: { '*': 'deny', skill: { '*': 'allow' } },
      prompt: `# Naru ${agent}\n\nCanonical prompt.`,
    };
    if (agent.startsWith('naru-minion-')) {
      config.agent[agent].permission = structuredClone(MINION_PERMISSIONS[agent]);
    }
  }
  config.agent['naru-orchestrator'].hidden = false;
  config.agent['naru-orchestrator'].mode = 'primary';
  for (const [caller, targets] of Object.entries(NARU_DISPATCH_GRAPH)) {
    config.agent[caller].permission.task = { '*': 'deny' };
    for (const target of targets) config.agent[caller].permission.task[target] = 'allow';
  }
  return config;
}

function assertAliasSkillPermissionClones(config) {
  for (const source of NARU_AGENT_IDS) {
    const sourceSkill = config.agent[source]?.permission?.skill;
    assert.deepEqual(sourceSkill, { '*': 'allow' });
    for (const alias of [lunaAlias(source), solAlias(source), solXhighAlias(source)]) {
      if (!config.agent[alias]) continue;
      assert.deepEqual(config.agent[alias].permission.skill, sourceSkill);
      assert.notEqual(config.agent[alias].permission.skill, sourceSkill);
    }
  }
}

let pluginScope = 0;

async function configuredPlugin(routingOverrides) {
  const sessions = new Map();
  const messages = new Map();
  const client = {
    app: { log: async () => ({ data: true }) },
    session: {
      get: async ({ path }) => ({ data: sessions.get(path.id) }),
      messages: async ({ path }) => ({ data: messages.get(path.id) ?? [] }),
    },
  };
  const plugin = await NaruDelegatePlugin(
    { client, directory: `/routing-test-${pluginScope += 1}` },
    { routingOverrides },
  );
  const config = fakeConfig();
  await plugin.config(config);
  return { client, config, messages, plugin, sessions };
}

async function recordSession(plugin, sessions, sessionID, {
  agent = 'naru-orchestrator',
  modelID = 'gpt-5.6-sol-fast',
  parentID,
  providerID = 'openai',
  variant = 'xhigh',
} = {}) {
  sessions.set(sessionID, { id: sessionID, ...(parentID ? { parentID } : {}) });
  await plugin['chat.message']({ sessionID, agent, model: { providerID, modelID }, variant });
}

test('default policy covers every Naru agent with Luna, Terra, and Sol profiles', () => {
  const policy = resolveRoutingPolicy();
  assert.equal(Object.keys(policy.agents).length, 35);
  assert.equal(policy.schemaVersion, 2);
  assert.deepEqual(policy.profiles, {
    luna: { model: 'openai/gpt-5.6-luna-fast', variant: 'high' },
    terra: { model: 'openai/gpt-5.6-terra-fast', variant: 'high' },
    sol: { model: 'openai/gpt-5.6-sol-fast', variant: 'high' },
  });
  for (const agent of NARU_AGENT_IDS) {
    assert.equal(
      policy.agents[agent],
      DEFAULT_AGENT_ASSIGNMENTS[agent] ?? (SOL_FLOOR_ROLES.includes(agent) ? 'sol' : 'terra'),
    );
  }
  assert.equal(DEFAULT_AGENT_ASSIGNMENTS['naru-orchestrator'], 'sol');
  assert.equal(SOL_FLOOR_ROLES.includes('naru-orchestrator'), false);
  assert.equal(DEEP_FLOOR_ROLES, SOL_FLOOR_ROLES);
  assert.equal(isDeepAlias(LEGACY_DEEP_ALIASES[0]), true);
  assert.deepEqual(LUNA_ELIGIBLE_ROLES, [
    'naru-minion-scout',
    'naru-minion-investigate',
    'naru-minion-implement',
    'naru-minion-debug',
    'naru-minion-verify',
  ]);
});

test('canonical dispatch topology derives and locks the required subagent depth', () => {
  assert.equal(NARU_MINIMUM_SUBAGENT_DEPTH, 2);
  assert.equal(NARU_REQUIRED_SUBAGENT_DEPTH, 2);
  assert.equal(deriveAndValidateNaruRequiredDepth(), 2);
  assert.deepEqual(NARU_DISPATCH_ENTRY_TOPOLOGY, {
    root: ['naru-orchestrator', 'naru-review-post'],
    subtask: ['naru-plan', 'naru-impact', 'naru-triage', 'naru-review'],
  });

  const futureGraph = {
    root: ['middle'],
    middle: ['dispatcher'],
    dispatcher: ['leaf'],
  };
  assert.equal(deriveAndValidateNaruRequiredDepth({
    agentIDs: ['root', 'middle', 'dispatcher', 'leaf'],
    entryTopology: { root: ['root'], subtask: [] },
    graph: futureGraph,
  }), 3);
  assert.throws(
    () => deriveAndValidateNaruRequiredDepth({
      agentIDs: ['root', 'middle', 'dispatcher', 'leaf'],
      entryTopology: { root: ['root'], subtask: [] },
      expectedDepth: 2,
      graph: futureGraph,
    }),
    /requires subagent depth 3; expected 2/,
  );
  assert.throws(
    () => deriveAndValidateNaruRequiredDepth({
      agentIDs: ['root', 'middle'],
      entryTopology: { root: ['root'], subtask: [] },
      graph: { root: ['middle'], middle: ['root'] },
    }),
    /contains a cycle/,
  );
  assert.throws(
    () => deriveAndValidateNaruRequiredDepth({
      agentIDs: ['root'],
      entryTopology: { root: ['root'], subtask: [] },
      graph: { root: ['missing'] },
    }),
    /unknown target/,
  );
});

test('v2 overrides replace profiles and cannot statically assign Luna or downgrade Sol floors', () => {
  const overrides = parseRoutingOverrides({
    schemaVersion: 2,
    profiles: { terra: { model: 'custom/terra' } },
    agents: { 'naru-minion-implement': 'sol' },
  });
  const policy = resolveRoutingPolicy(overrides);
  assert.deepEqual(policy.profiles.terra, { model: 'custom/terra' });
  assert.deepEqual(policy.profiles.sol, DEFAULT_MODEL_PROFILES.sol);
  assert.equal(policy.agents['naru-minion-implement'], 'sol');
  assert.throws(
    () => parseRoutingOverrides({ schemaVersion: 2, agents: { 'naru-review-security': 'terra' } }),
    /cannot downgrade/,
  );
  assert.throws(
    () => parseRoutingOverrides({ schemaVersion: 2, agents: { 'naru-minion-scout': 'luna' } }),
    /invalid/,
  );
  assert.throws(
    () => parseRoutingOverrides({ schemaVersion: 2, profiles: { terra: { model: 'missing-slash' } } }),
    /provider\/model/,
  );
  assert.deepEqual(
    parseRoutingOverrides({
      schemaVersion: 2,
      profiles: { luna: { model: 'openrouter/vendor/model:free' } },
    }).profiles.luna,
    { model: 'openrouter/vendor/model:free' },
  );
  assert.throws(() => parseRoutingOverrides({ schemaVersion: 3 }), /schemaVersion/);
  assert.throws(() => parseRoutingOverrides({ schemaVersion: 2, extra: true }), /unsupported field/);
});

test('v1 overrides normalize Fast and Deep into the v2 policy', () => {
  const overrides = parseRoutingOverrides({
    schemaVersion: 1,
    profiles: {
      fast: { model: 'custom/legacy-fast' },
      deep: { model: 'custom/legacy-deep', variant: 'max' },
    },
    agents: {
      'naru-orchestrator': 'fast',
      'naru-minion-implement': 'deep',
    },
  });
  assert.deepEqual(overrides, {
    schemaVersion: NARU_DELEGATE_PROTOCOL,
    profiles: {
      terra: { model: 'custom/legacy-fast' },
      sol: { model: 'custom/legacy-deep', variant: 'max' },
    },
    agents: {
      'naru-orchestrator': 'terra',
      'naru-minion-implement': 'sol',
    },
  });
  assert.throws(
    () => parseRoutingOverrides({ schemaVersion: 1, agents: { 'naru-minion-scout': 'terra' } }),
    /invalid/,
  );
});

test('config routing exposes Luna, canonical Terra, and Sol routes only where eligible', () => {
  const config = fakeConfig();
  const leakedXhigh = solXhighAlias('naru-minion-scout');
  config.agent['naru-plan'].permission.task[leakedXhigh] = 'allow';
  const summary = applyRoutingToConfig(config);
  assert.equal(summary.routedAgents, 35);
  assert.equal(summary.lunaAliases, 5);
  assert.equal(summary.solAliases, 17);
  assert.equal(summary.solXhighAliases, 7);
  assert.equal(MANAGED_LUNA_ALIASES.length, 5);
  assert.equal(MANAGED_SOL_ALIASES.length, 17);
  assert.equal(MANAGED_SOL_XHIGH_ALIASES.length, 7);
  assert.equal(MANAGED_ROUTING_ALIASES.length, 29);
  assert.equal(config.agent['naru-orchestrator'].model, 'openai/gpt-5.6-sol-fast');
  assert.equal(config.agent['naru-orchestrator'].variant, 'high');
  assert.equal(config.agent['naru-minion-implement'].model, 'openai/gpt-5.6-terra-fast');
  assert.equal(config.agent['naru-review-security'].model, 'openai/gpt-5.6-sol-fast');

  const implementLuna = lunaAlias('naru-minion-implement');
  const implementSol = solAlias('naru-minion-implement');
  assert.equal(config.agent[implementLuna].name, implementLuna);
  assert.equal(config.agent[implementLuna].model, 'openai/gpt-5.6-luna-fast');
  assert.equal(config.agent[implementLuna].variant, 'high');
  assert.equal(config.agent[implementLuna].hidden, true);
  assert.equal(config.agent[implementSol].name, implementSol);
  assert.equal(config.agent[implementSol].model, 'openai/gpt-5.6-sol-fast');
  assert.equal(config.agent[implementSol].variant, 'high');
  assert.equal(config.agent['naru-orchestrator'].permission.task[implementLuna], 'allow');
  assert.equal(config.agent['naru-orchestrator'].permission.task[implementSol], 'allow');
  assert.equal(config.agent['naru-orchestrator'].permission.task['naru-review'], 'allow');
  assert.equal(config.agent['naru-orchestrator'].permission.task[lunaAlias('naru-review')], undefined);
  assert.equal(config.agent['naru-orchestrator'].permission.task[solAlias('naru-review')], undefined);
  assert.equal(config.agent['naru-orchestrator'].permission.task[solXhighAlias('naru-review')], undefined);
  assert.equal(config.agent['naru-review-post'].permission.task['naru-review'], 'allow');
  assert.equal(config.agent['naru-review-post'].permission.task[lunaAlias('naru-review')], undefined);
  assert.equal(config.agent['naru-review-post'].permission.task[solAlias('naru-review')], 'allow');
  assert.equal(config.agent['naru-review-post'].permission.task[solXhighAlias('naru-review')], undefined);
  assert.equal(config.agent[lunaAlias('naru-minion-architect')], undefined);
  assert.equal(config.agent[solAlias('naru-minion-architect')], undefined);
  assert.equal(config.agent[solAlias('naru-review-security')], undefined);

  assert.notDeepEqual(
    config.agent['naru-minion-scout'].permission,
    config.agent['naru-minion-implement'].permission,
  );
  for (const target of NARU_DISPATCH_GRAPH['naru-orchestrator'].filter((value) => value.startsWith('naru-minion-'))) {
    const sourcePermission = config.agent[target].permission;
    assert.deepEqual(sourcePermission, MINION_PERMISSIONS[target]);
    for (const alias of [lunaAlias(target), solAlias(target), solXhighAlias(target)]) {
      if (!config.agent[alias]) continue;
      assert.deepEqual(config.agent[alias].permission, sourcePermission);
      assert.notEqual(config.agent[alias].permission, sourcePermission);
      assert.notEqual(config.agent[alias].permission.read, sourcePermission.read);
    }
  }

  for (const target of NARU_DISPATCH_GRAPH['naru-orchestrator'].filter((value) => value.startsWith('naru-minion-'))) {
    const alias = solXhighAlias(target);
    assert.equal(config.agent[alias].name, alias);
    assert.equal(config.agent[alias].model, 'openai/gpt-5.6-sol-fast');
    assert.equal(config.agent[alias].variant, 'xhigh');
    assert.equal(config.agent[alias].hidden, true);
    assert.equal(config.agent['naru-orchestrator'].permission.task[alias], 'allow');
    assert.equal(alias.includes('max'), false);
    for (const caller of Object.keys(NARU_DISPATCH_GRAPH).filter((value) => value !== 'naru-orchestrator')) {
      assert.equal(config.agent[caller].permission.task[alias], undefined);
    }
  }
  assert.match(config.agent['naru-orchestrator'].prompt, /Sol xhigh routes are optional/);
  assert.match(config.agent['naru-orchestrator'].prompt, /`naru-review`: canonical-only review lane/);
  assert.match(config.agent['naru-review-post'].prompt, /`naru-review`: Terra\. Sol: `naru-delegate-sol-review`\./);
  assert.equal(Object.keys(config.agent).some((agent) => agent.includes('sol-max')), false);
  assert.equal(config.agent['naru-plan'].permission.task[leakedXhigh], undefined);
  assertAliasSkillPermissionClones(config);
});

test('orchestrator default Sol assignment is overrideable to Terra without changing dispatch', () => {
  const config = fakeConfig();
  applyRoutingToConfig(config, {
    schemaVersion: 2,
    agents: { 'naru-orchestrator': 'terra' },
  });
  assert.equal(config.agent['naru-orchestrator'].model, 'openai/gpt-5.6-terra-fast');
  assert.equal(config.agent['naru-orchestrator'].variant, 'high');
  assert.equal(config.agent[solAlias('naru-orchestrator')], undefined);
  assert.deepEqual(NARU_DISPATCH_GRAPH['naru-orchestrator'], [
    'naru-review',
    'naru-minion-scout',
    'naru-minion-investigate',
    'naru-minion-architect',
    'naru-minion-implement',
    'naru-minion-debug',
    'naru-minion-verify',
    'naru-minion-judge',
  ]);
});

test('routing is idempotent and appends policy only to dispatchers', () => {
  const config = fakeConfig();
  applyRoutingToConfig(config);
  applyRoutingToConfig(config, undefined, { allowExistingAliases: true });
  const prompt = config.agent['naru-orchestrator'].prompt;
  assert.equal(prompt.split(NARU_DELEGATE_ROUTING_MARKER).length - 1, 1);
  assert.match(prompt, /Never downgrade a Sol-floor role/);
  assert.match(prompt, /Do not use fixed role-to-model mappings/);
  assert.doesNotMatch(config.agent['naru-minion-scout'].prompt, /Naru Delegate Routing/);
  assert.equal(
    Object.keys(config.agent).filter((agent) => agent.startsWith('naru-delegate-luna-')).length,
    5,
  );
  assert.equal(
    Object.keys(config.agent).filter((agent) => agent.startsWith('naru-delegate-sol-')).length,
    24,
  );
  assert.equal(
    Object.keys(config.agent).filter((agent) => agent.startsWith('naru-delegate-sol-xhigh-')).length,
    7,
  );
});

test('routing refuses current alias collisions, removes legacy aliases, and preserves unrelated prefixes', () => {
  const config = fakeConfig();
  config.agent[MANAGED_ROUTING_ALIASES[0]] = { description: 'User agent' };
  assert.throws(() => applyRoutingToConfig(config), /alias already exists/);

  const xhighCollision = fakeConfig();
  xhighCollision.agent[MANAGED_SOL_XHIGH_ALIASES[0]] = { description: 'User agent' };
  assert.throws(() => applyRoutingToConfig(xhighCollision), /alias already exists/);

  const unrelated = 'naru-delegate-user-defined';
  const clean = fakeConfig();
  clean.agent[LEGACY_DEEP_ALIASES[0]] = { description: 'Stale generated route' };
  clean.agent[unrelated] = { description: 'Unrelated user agent' };
  applyRoutingToConfig(clean);
  assert.equal(clean.agent[LEGACY_DEEP_ALIASES[0]], undefined);
  assert.deepEqual(clean.agent[unrelated], { description: 'Unrelated user agent' });

  const staleXhigh = fakeConfig();
  staleXhigh.agent[MANAGED_SOL_XHIGH_ALIASES[0]] = { description: 'Stale generated route' };
  applyRoutingToConfig(staleXhigh, undefined, { allowExistingAliases: true });
  assert.match(staleXhigh.agent[MANAGED_SOL_XHIGH_ALIASES[0]].description, /^Sol xhigh Naru Delegate route/);
});

test('Sol xhigh aliases use a custom Sol model while overriding only its variant', () => {
  const config = fakeConfig();
  const summary = applyRoutingToConfig(config, {
    schemaVersion: 2,
    profiles: { sol: { model: 'custom/sol/model', variant: 'max' } },
  });
  assert.deepEqual(summary.profiles.sol, { model: 'custom/sol/model', variant: 'max' });
  for (const alias of MANAGED_SOL_XHIGH_ALIASES) {
    assert.equal(config.agent[alias].model, 'custom/sol/model');
    assert.equal(config.agent[alias].variant, 'xhigh');
  }
  assert.equal(config.agent['naru-orchestrator'].model, 'custom/sol/model');
  assert.equal(config.agent['naru-orchestrator'].variant, 'max');
});

test('trusted Sol override removes unnecessary Luna and Sol aliases', () => {
  const config = fakeConfig();
  applyRoutingToConfig(config, {
    schemaVersion: 2,
    agents: { 'naru-minion-implement': 'sol' },
  });
  assert.equal(config.agent['naru-minion-implement'].model, 'openai/gpt-5.6-sol-fast');
  assert.equal(config.agent[lunaAlias('naru-minion-implement')], undefined);
  assert.equal(config.agent[solAlias('naru-minion-implement')], undefined);
  assert.equal(config.agent['naru-orchestrator'].permission.task[lunaAlias('naru-minion-implement')], undefined);
  assert.equal(config.agent['naru-orchestrator'].permission.task[solAlias('naru-minion-implement')], undefined);
  assert.match(
    config.agent['naru-orchestrator'].prompt,
    /`naru-minion-implement`: Sol override; invoke this exact role\./,
  );
  assert.doesNotMatch(config.agent['naru-orchestrator'].prompt, /`naru-minion-implement`: Sol floor/);
  assertAliasSkillPermissionClones(config);
});

test('validation completes before mutating config', () => {
  const config = fakeConfig();
  delete config.agent['naru-review-judge'];
  const before = structuredClone(config);
  assert.throws(() => applyRoutingToConfig(config), /missing Naru agent/);
  assert.deepEqual(config, before);
});

test('plugin rejects task_id resume only for Naru routes', async () => {
  const plugin = await NaruDelegatePlugin({
    client: { app: { log: async () => ({ data: true }) } },
  });
  await assert.rejects(
    plugin['tool.execute.before'](
      { tool: 'task' },
      { args: { subagent_type: 'naru-minion-scout', task_id: 'session-id' } },
    ),
    /fresh child session/,
  );
  await assert.rejects(
    plugin['tool.execute.before'](
      { tool: 'task', sessionID: 'root' },
      { args: { subagent_type: solXhighAlias('naru-minion-scout'), task_id: 'session-id' } },
    ),
    /fresh child session/,
  );
  await assert.rejects(
    plugin['tool.execute.before'](
      { tool: 'task' },
      { args: { subagent_type: lunaAlias('naru-minion-scout'), task_id: 'session-id' } },
    ),
    /fresh child session/,
  );
  await plugin['tool.execute.before'](
    { tool: 'task' },
    { args: { subagent_type: 'explore', task_id: 'session-id' } },
  );
});

test('plugin rejects root-only Naru Task targets without affecting native targets or canonical review', async () => {
  const plugin = await NaruDelegatePlugin({
    client: { app: { log: async () => ({ data: true }) } },
  });
  const config = fakeConfig();
  config.subagent_depth = 2;
  await plugin.config(config);
  for (const target of ['naru-orchestrator', 'naru-review-post']) {
    await assert.rejects(
      plugin['tool.execute.before'](
        { tool: 'task' },
        { args: { subagent_type: target } },
      ),
      /root-only; use direct agent selection or its slash command/,
    );
  }
  await plugin['tool.execute.before'](
    { tool: 'task' },
    { args: { subagent_type: 'naru-review' } },
  );
  await plugin['tool.execute.before'](
    { tool: 'task' },
    { args: { subagent_type: 'explore', task_id: 'session-id' } },
  );
});

test('plugin guards only Naru dispatcher launches when effective subagent depth is incompatible', async () => {
  const omittedLogs = [];
  const omittedPlugin = await NaruDelegatePlugin({
    client: { app: { log: async (entry) => omittedLogs.push(entry) } },
    directory: '/depth-omitted',
  });
  const omittedConfig = fakeConfig();
  delete omittedConfig.subagent_depth;
  await omittedPlugin.config(omittedConfig);
  await omittedPlugin.config(omittedConfig);
  assert.equal(Object.hasOwn(omittedConfig, 'subagent_depth'), false);
  assert.equal(omittedLogs.length, 1);
  assert.match(omittedLogs[0].body.message, /OpenCode 1\.18\.4 default 1/);
  await assert.rejects(
    omittedPlugin['tool.execute.before'](
      { tool: 'task' },
      { args: { subagent_type: 'naru-review' } },
    ),
    /default 1.*required minimum is 2.*top-level subagent_depth: 2.*restart OpenCode/,
  );
  await assert.rejects(
    omittedPlugin['tool.execute.before'](
      { tool: 'task' },
      { args: { subagent_type: solAlias('naru-review') } },
    ),
    /required minimum is 2/,
  );
  await omittedPlugin['tool.execute.before'](
    { tool: 'task' },
    { args: { subagent_type: 'naru-minion-implement' } },
  );
  await omittedPlugin['tool.execute.before'](
    { tool: 'task' },
    { args: { subagent_type: lunaAlias('naru-minion-implement') } },
  );
  await omittedPlugin['tool.execute.before'](
    { tool: 'task' },
    { args: { subagent_type: 'explore' } },
  );

  for (const [value, compatible] of [[1, false], [2, true], [3, true], ['2', false], [2.5, false]]) {
    const logs = [];
    const plugin = await NaruDelegatePlugin({
      client: { app: { log: async (entry) => logs.push(entry) } },
      directory: `/depth-${String(value)}`,
    });
    const config = fakeConfig();
    config.subagent_depth = value;
    await plugin.config(config);
    assert.equal(config.subagent_depth, value);
    assert.equal(logs.length, compatible ? 0 : 1);
    const launch = plugin['tool.execute.before'](
      { tool: 'task' },
      { args: { subagent_type: 'naru-plan' } },
    );
    if (compatible) await launch;
    else await assert.rejects(launch, /found top-level subagent_depth value .*required minimum is 2/);
  }
});

test('Sol xhigh routes authorize only direct Sol orchestrator roots at xhigh or max', async () => {
  const { plugin, sessions } = await configuredPlugin();
  const target = solXhighAlias('naru-minion-implement');
  const invoke = (sessionID) => plugin['tool.execute.before'](
    { tool: 'task', sessionID },
    { args: { subagent_type: target } },
  );

  for (const variant of ['xhigh', 'max']) {
    const sessionID = `allowed-${variant}`;
    await recordSession(plugin, sessions, sessionID, { variant });
    await invoke(sessionID);
  }

  const rejected = [
    ['high-root', { variant: 'high' }],
    ['terra-xhigh', { modelID: 'gpt-5.6-terra-fast' }],
    ['wrong-provider', { providerID: 'custom' }],
    ['custom-agent', { agent: 'custom-orchestrator' }],
    ['nested-root', { parentID: 'parent-session' }],
    ['missing-variant', { variant: null }],
  ];
  for (const [sessionID, metadata] of rejected) {
    await recordSession(plugin, sessions, sessionID, metadata);
    await assert.rejects(invoke(sessionID), /direct naru-orchestrator root/);
  }

  sessions.set('missing-metadata', { id: 'missing-metadata' });
  await assert.rejects(invoke('missing-metadata'), /direct naru-orchestrator root/);
});

test('Sol xhigh authorization lazily hydrates metadata and honors custom Sol models', async () => {
  const { config, messages, plugin, sessions } = await configuredPlugin({
    schemaVersion: 2,
    profiles: { sol: { model: 'custom/sol/model', variant: 'high' } },
  });
  const target = solXhighAlias('naru-minion-judge');
  assert.equal(config.agent[target].model, 'custom/sol/model');
  assert.equal(config.agent[target].variant, 'xhigh');
  sessions.set('hydrated-root', { id: 'hydrated-root' });
  messages.set('hydrated-root', [{
    info: {
      role: 'user',
      agent: 'naru-orchestrator',
      model: { providerID: 'custom', modelID: 'sol/model' },
      variant: 'xhigh',
    },
  }]);
  await plugin['tool.execute.before'](
    { tool: 'task', sessionID: 'hydrated-root' },
    { args: { subagent_type: target } },
  );

  await plugin.event({ event: {
    type: 'session.deleted',
    properties: { info: { id: 'hydrated-root' } },
  } });
  messages.set('hydrated-root', []);
  await assert.rejects(
    plugin['tool.execute.before'](
      { tool: 'task', sessionID: 'hydrated-root' },
      { args: { subagent_type: target } },
    ),
    /direct naru-orchestrator root/,
  );
});

test('root routing metadata cache is bounded and handles session deletion', async () => {
  const client = { app: { log: async () => ({ data: true }) } };
  const plugin = await NaruDelegatePlugin(
    { client, directory: '/routing-cache-test' },
    { routingOverrides: undefined },
  );
  const config = fakeConfig();
  await plugin.config(config);
  for (let index = 0; index < 520; index += 1) {
    await plugin['chat.message']({
      sessionID: `bounded-${index}`,
      agent: 'naru-orchestrator',
      model: { providerID: 'openai', modelID: 'gpt-5.6-sol-fast' },
      variant: 'xhigh',
    });
  }
  const sessions = globalThis[Symbol.for('naru.delegate.config-state.v1')].sessions;
  assert.ok(sessions.size <= 512);
  assert.equal(sessions.has('bounded-519'), true);
  await plugin.event({ event: {
    type: 'session.deleted',
    properties: { info: { id: 'bounded-519' } },
  } });
  assert.equal(sessions.has('bounded-519'), false);
});

test('root routing metadata expires after 30 minutes without affecting fresh authorization', async () => {
  const { plugin, sessions } = await configuredPlugin();
  const staleSessionID = 'ttl-stale-root';
  const freshSessionID = 'ttl-fresh-root';
  const target = solXhighAlias('naru-minion-implement');
  await recordSession(plugin, sessions, staleSessionID);
  await recordSession(plugin, sessions, freshSessionID);

  const cachedSessions = globalThis[Symbol.for('naru.delegate.config-state.v1')].sessions;
  cachedSessions.get(staleSessionID).updatedAt = Date.now() - (30 * 60 * 1000);

  await plugin['chat.message']({
    sessionID: 'ttl-prune-trigger',
    agent: 'naru-orchestrator',
    model: { providerID: 'openai', modelID: 'gpt-5.6-sol-fast' },
    variant: 'xhigh',
  });

  assert.equal(cachedSessions.has(staleSessionID), false);
  await plugin['tool.execute.before'](
    { tool: 'task', sessionID: freshSessionID },
    { args: { subagent_type: target } },
  );
});

test('multiple plugin scopes merge sparse overrides and invalid later config restores originals', async () => {
  const logs = [];
  const client = { app: { log: async (entry) => logs.push(entry) } };
  const config = fakeConfig();

  const globalPlugin = await NaruDelegatePlugin(
    { client },
    {
      routingOverrides: {
        schemaVersion: 1,
        profiles: { fast: { model: 'custom/global-fast' } },
      },
    },
  );
  await globalPlugin.config(config);
  assert.equal(config.agent['naru-minion-scout'].model, 'custom/global-fast');
  assertAliasSkillPermissionClones(config);
  const sharedState = globalThis[Symbol.for('naru.delegate.config-state.v1')].configs.get(config);
  assert.equal(sharedState.overrides.schemaVersion, 1);
  assert.equal(sharedState.overrides.profiles.fast.model, 'custom/global-fast');
  assert.equal(sharedState.overrides.profiles.deep.model, 'openai/gpt-5.6-sol-fast');
  assert.equal(sharedState.overrides.agents['naru-orchestrator'], 'deep');
  assert.equal(sharedState.overrides.agents['naru-minion-scout'], 'fast');
  assert.equal(sharedState.overridesV2.schemaVersion, 2);

  const projectWithoutOverride = await NaruDelegatePlugin({ client }, {});
  await projectWithoutOverride.config(config);
  assert.equal(config.agent['naru-minion-scout'].model, 'custom/global-fast');

  const projectPlugin = await NaruDelegatePlugin(
    { client },
    {
      routingOverrides: {
        schemaVersion: 2,
        profiles: { sol: { model: 'custom/project-sol', variant: 'max' } },
      },
    },
  );
  await projectPlugin.config(config);
  assert.equal(config.agent['naru-minion-scout'].model, 'custom/global-fast');
  assertAliasSkillPermissionClones(config);
  assert.equal(config.agent['naru-review-security'].model, 'custom/project-sol');
  assert.equal(config.agent['naru-review-security'].variant, 'max');
  assert.equal(sharedState.overrides.profiles.deep.model, 'custom/project-sol');
  assert.equal(sharedState.overrides.profiles.deep.variant, 'max');

  const invalidPlugin = await NaruDelegatePlugin(
    { client },
    { routingOverrides: { schemaVersion: 3 } },
  );
  await invalidPlugin.config(config);
  assert.equal(config.agent['naru-minion-scout'].model, undefined);
  assert.equal(config.agent['naru-review-security'].model, undefined);
  assert.equal(config.agent[lunaAlias('naru-minion-scout')], undefined);
  assert.equal(config.agent[solAlias('naru-minion-scout')], undefined);
  for (const agent of NARU_AGENT_IDS) assert.deepEqual(config.agent[agent].permission.skill, { '*': 'allow' });
  assert.equal(logs.length, 1);
});

test('plugin failure preserves an originally missing agent as absent', async () => {
  const logs = [];
  const config = fakeConfig();
  delete config.agent['naru-review-judge'];
  const plugin = await NaruDelegatePlugin({
    client: { app: { log: async (entry) => logs.push(entry) } },
  });
  await plugin.config(config);
  assert.equal(Object.hasOwn(config.agent, 'naru-review-judge'), false);
  assert.equal(config.agent[lunaAlias('naru-minion-scout')], undefined);
  assert.equal(config.agent[solAlias('naru-minion-scout')], undefined);
  assert.equal(logs.length, 1);
});
