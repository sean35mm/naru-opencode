import assert from 'node:assert/strict';
import test from 'node:test';

import { NaruDelegatePlugin } from '../plugins/naru-delegate.js';
import {
  applyRoutingToConfig,
  deepAlias,
  DEEP_FLOOR_ROLES,
  DEFAULT_MODEL_PROFILES,
  NARU_AGENT_IDS,
  NARU_DELEGATE_ROUTING_MARKER,
  NARU_DISPATCH_GRAPH,
  MANAGED_DEEP_ALIASES,
  parseRoutingOverrides,
  resolveRoutingPolicy,
} from '../tools/naru-lib/model-routing.mjs';

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
  }
  config.agent['naru-orchestrator'].hidden = false;
  config.agent['naru-orchestrator'].mode = 'primary';
  for (const [caller, targets] of Object.entries(NARU_DISPATCH_GRAPH)) {
    config.agent[caller].permission.task = { '*': 'deny' };
    for (const target of targets) config.agent[caller].permission.task[target] = 'allow';
  }
  return config;
}

test('default policy covers every Naru agent with Terra Fast or Sol Fast', () => {
  const policy = resolveRoutingPolicy();
  assert.equal(Object.keys(policy.agents).length, 35);
  assert.deepEqual(policy.profiles, {
    fast: { model: 'openai/gpt-5.6-terra-fast', variant: 'high' },
    deep: { model: 'openai/gpt-5.6-sol-fast', variant: 'high' },
  });
  for (const agent of NARU_AGENT_IDS) {
    assert.equal(policy.agents[agent], DEEP_FLOOR_ROLES.includes(agent) ? 'deep' : 'fast');
  }
});

test('routing overrides replace profiles and cannot downgrade deep floors', () => {
  const overrides = parseRoutingOverrides({
    schemaVersion: 1,
    profiles: { fast: { model: 'custom/fast' } },
    agents: { 'naru-minion-implement': 'deep' },
  });
  const policy = resolveRoutingPolicy(overrides);
  assert.deepEqual(policy.profiles.fast, { model: 'custom/fast' });
  assert.deepEqual(policy.profiles.deep, DEFAULT_MODEL_PROFILES.deep);
  assert.equal(policy.agents['naru-minion-implement'], 'deep');
  assert.throws(
    () => parseRoutingOverrides({ schemaVersion: 1, agents: { 'naru-review-security': 'fast' } }),
    /cannot downgrade/,
  );
  assert.throws(
    () => parseRoutingOverrides({ schemaVersion: 1, profiles: { fast: { model: 'missing-slash' } } }),
    /provider\/model/,
  );
  assert.deepEqual(
    parseRoutingOverrides({
      schemaVersion: 1,
      profiles: { fast: { model: 'openrouter/vendor/model:free' } },
    }).profiles.fast,
    { model: 'openrouter/vendor/model:free' },
  );
  assert.throws(() => parseRoutingOverrides({ schemaVersion: 2 }), /schemaVersion/);
  assert.throws(() => parseRoutingOverrides({ schemaVersion: 1, extra: true }), /unsupported field/);
});

test('config routing sets original profiles and generates only eligible deep aliases', () => {
  const config = fakeConfig();
  const summary = applyRoutingToConfig(config);
  assert.equal(summary.routedAgents, 35);
  assert.equal(summary.deepAliases, 17);
  assert.equal(config.agent['naru-minion-implement'].model, 'openai/gpt-5.6-terra-fast');
  assert.equal(config.agent['naru-review-security'].model, 'openai/gpt-5.6-sol-fast');

  const implementAlias = deepAlias('naru-minion-implement');
  assert.equal(config.agent[implementAlias].name, implementAlias);
  assert.equal(config.agent[implementAlias].model, 'openai/gpt-5.6-sol-fast');
  assert.equal(config.agent[implementAlias].variant, 'high');
  assert.equal(config.agent[implementAlias].hidden, true);
  assert.equal(config.agent['naru-orchestrator'].permission.task[implementAlias], 'allow');
  assert.equal(config.agent[deepAlias('naru-review-security')], undefined);

  const sourcePermission = config.agent['naru-minion-implement'].permission;
  assert.deepEqual(config.agent[implementAlias].permission, sourcePermission);
  assert.notEqual(config.agent[implementAlias].permission, sourcePermission);
});

test('routing is idempotent and appends policy only to dispatchers', () => {
  const config = fakeConfig();
  applyRoutingToConfig(config);
  applyRoutingToConfig(config, undefined, { allowExistingAliases: true });
  const prompt = config.agent['naru-orchestrator'].prompt;
  assert.equal(prompt.split(NARU_DELEGATE_ROUTING_MARKER).length - 1, 1);
  assert.match(prompt, /Never downgrade a Deep-floor role/);
  assert.doesNotMatch(config.agent['naru-minion-scout'].prompt, /Naru Delegate Routing/);
  assert.equal(
    Object.keys(config.agent).filter((agent) => agent.startsWith('naru-delegate-deep-')).length,
    17,
  );
});

test('routing refuses exact alias collisions and preserves unrelated prefixes', () => {
  const config = fakeConfig();
  config.agent[MANAGED_DEEP_ALIASES[0]] = { description: 'User agent' };
  assert.throws(() => applyRoutingToConfig(config), /alias already exists/);

  const unrelated = 'naru-delegate-deep-user-defined';
  const clean = fakeConfig();
  clean.agent[unrelated] = { description: 'Unrelated user agent' };
  applyRoutingToConfig(clean);
  assert.deepEqual(clean.agent[unrelated], { description: 'Unrelated user agent' });
});

test('trusted role override removes an unnecessary deep alias', () => {
  const config = fakeConfig();
  applyRoutingToConfig(config, {
    schemaVersion: 1,
    agents: { 'naru-minion-implement': 'deep' },
  });
  assert.equal(config.agent['naru-minion-implement'].model, 'openai/gpt-5.6-sol-fast');
  assert.equal(config.agent[deepAlias('naru-minion-implement')], undefined);
  assert.equal(config.agent['naru-orchestrator'].permission.task[deepAlias('naru-minion-implement')], undefined);
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

  const projectWithoutOverride = await NaruDelegatePlugin({ client }, {});
  await projectWithoutOverride.config(config);
  assert.equal(config.agent['naru-minion-scout'].model, 'custom/global-fast');

  const projectPlugin = await NaruDelegatePlugin(
    { client },
    {
      routingOverrides: {
        schemaVersion: 1,
        profiles: { deep: { model: 'custom/project-deep', variant: 'max' } },
      },
    },
  );
  await projectPlugin.config(config);
  assert.equal(config.agent['naru-minion-scout'].model, 'custom/global-fast');
  assert.equal(config.agent['naru-review-security'].model, 'custom/project-deep');
  assert.equal(config.agent['naru-review-security'].variant, 'max');

  const invalidPlugin = await NaruDelegatePlugin(
    { client },
    { routingOverrides: { schemaVersion: 2 } },
  );
  await invalidPlugin.config(config);
  assert.equal(config.agent['naru-minion-scout'].model, undefined);
  assert.equal(config.agent['naru-review-security'].model, undefined);
  assert.equal(config.agent[deepAlias('naru-minion-scout')], undefined);
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
  assert.equal(config.agent[deepAlias('naru-minion-scout')], undefined);
  assert.equal(logs.length, 1);
});
