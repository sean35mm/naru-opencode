import assert from 'node:assert/strict';
import test from 'node:test';

import { NaruDelegatePlugin } from '../plugins/naru-delegate.js';
import {
  applyRoutingToConfig,
  DEEP_FLOOR_ROLES,
  DEFAULT_AGENT_ASSIGNMENTS,
  DEFAULT_MODEL_PROFILES,
  LEGACY_DEEP_ALIASES,
  isDeepAlias,
  lunaAlias,
  LUNA_ELIGIBLE_ROLES,
  MANAGED_LUNA_ALIASES,
  MANAGED_ROUTING_ALIASES,
  MANAGED_SOL_ALIASES,
  NARU_AGENT_IDS,
  NARU_DELEGATE_PROTOCOL,
  NARU_DELEGATE_ROUTING_MARKER,
  NARU_DISPATCH_GRAPH,
  parseRoutingOverrides,
  resolveRoutingPolicy,
  solAlias,
  SOL_FLOOR_ROLES,
} from '../tools/naru-lib/model-routing.mjs';

const BUILD_LIKE_MINION_PERMISSION = {
  '*': 'allow',
  doom_loop: 'ask',
  external_directory: 'allow',
  read: {
    '*': 'allow',
    '.env': 'ask',
    '.env.*': 'ask',
    '*.env': 'ask',
    '*.env.*': 'ask',
    '*.env.example': 'allow',
    'env.example': 'allow',
  },
  bash: {
    '*': 'allow',
  },
};

function fakeConfig() {
  const config = { agent: {} };
  for (const agent of NARU_AGENT_IDS) {
    config.agent[agent] = {
      description: `Canonical Naru role ${agent}`,
      hidden: true,
      mode: 'subagent',
      permission: { '*': 'deny' },
      prompt: `# Naru ${agent}\n\nCanonical prompt.`,
    };
    if (agent.startsWith('naru-minion-')) {
      config.agent[agent].permission = structuredClone(BUILD_LIKE_MINION_PERMISSION);
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
  const summary = applyRoutingToConfig(config);
  assert.equal(summary.routedAgents, 35);
  assert.equal(summary.lunaAliases, 5);
  assert.equal(summary.solAliases, 17);
  assert.equal(MANAGED_LUNA_ALIASES.length, 5);
  assert.equal(MANAGED_SOL_ALIASES.length, 17);
  assert.equal(MANAGED_ROUTING_ALIASES.length, 22);
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
  assert.equal(config.agent[lunaAlias('naru-minion-architect')], undefined);
  assert.equal(config.agent[solAlias('naru-minion-architect')], undefined);
  assert.equal(config.agent[solAlias('naru-review-security')], undefined);

  const sourcePermission = config.agent['naru-minion-implement'].permission;
  assert.deepEqual(sourcePermission, BUILD_LIKE_MINION_PERMISSION);
  assert.deepEqual(config.agent[implementLuna].permission, sourcePermission);
  assert.deepEqual(config.agent[implementSol].permission, sourcePermission);
  assert.notEqual(config.agent[implementLuna].permission, sourcePermission);
  assert.notEqual(config.agent[implementSol].permission, sourcePermission);
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
    17,
  );
});

test('routing refuses current alias collisions, removes legacy aliases, and preserves unrelated prefixes', () => {
  const config = fakeConfig();
  config.agent[MANAGED_ROUTING_ALIASES[0]] = { description: 'User agent' };
  assert.throws(() => applyRoutingToConfig(config), /alias already exists/);

  const unrelated = 'naru-delegate-user-defined';
  const clean = fakeConfig();
  clean.agent[LEGACY_DEEP_ALIASES[0]] = { description: 'Stale generated route' };
  clean.agent[unrelated] = { description: 'Unrelated user agent' };
  applyRoutingToConfig(clean);
  assert.equal(clean.agent[LEGACY_DEEP_ALIASES[0]], undefined);
  assert.deepEqual(clean.agent[unrelated], { description: 'Unrelated user agent' });
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
