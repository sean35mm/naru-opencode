import assert from 'node:assert/strict';
import test from 'node:test';
import {
  applyVariantsToConfig,
  buildPromptAppendix,
  modelLabel,
  parseChainEntry,
  parseModelsConfig,
  pickChainEntry,
  variantAgentName,
  VARIANT_ROLES,
} from '../tools/naru-lib/dispatch.mjs';
import { NaruDispatchPlugin } from '../plugins/naru-dispatch.js';

const CLASSES = parseModelsConfig({
  light: { use: 'wide fan-out', chain: ['openai/gpt-5.6-luna-fast@high', 'opencode-go/deepseek-v4-flash'] },
  deep: { use: 'high consequence', chain: ['openai/gpt-5.6-sol-fast@high', 'openai/gpt-5.6-sol@high'] },
  crosscheck: { use: 'non-openai second opinion', chain: ['opencode-go/kimi-k2.5'] },
});

interface TestAgent {
  mode?: string;
  hidden?: boolean;
  description?: string;
  prompt?: string;
  model?: string;
  variant?: string;
  options?: { naruVariant?: boolean };
  permission?: Record<string, string | Record<string, string>>;
}

interface TestConfig {
  agent: Record<string, TestAgent>;
}

function fakeConfig(): TestConfig {
  return {
    agent: {
      'naru-orchestrator': {
        mode: 'primary',
        prompt: 'You coordinate work.',
        permission: {
          '*': 'deny',
          task: { '*': 'deny', 'naru-reader': 'allow', 'naru-runner': 'allow', 'naru-writer': 'allow' },
        },
      },
      'naru-reader': {
        mode: 'subagent',
        hidden: true,
        description: 'Read-only investigator.',
        permission: { '*': 'deny', bash: 'deny', edit: 'deny', task: 'deny', read: { '*': 'allow', '.env': 'deny' } },
      },
      'naru-runner': {
        mode: 'subagent',
        hidden: true,
        description: 'Read-only checker.',
        permission: { '*': 'deny', bash: { '*': 'allow' }, edit: 'deny', task: 'deny' },
      },
      'naru-writer': {
        mode: 'subagent',
        hidden: true,
        description: 'The only editor.',
        permission: { '*': 'deny', bash: { '*': 'allow' }, edit: 'allow', apply_patch: 'allow', task: 'deny' },
      },
      build: { mode: 'primary' },
    },
  };
}

function requiredValue<T>(value: T | undefined, label: string): T {
  if (value === undefined) throw new Error(`${label} is unavailable`);
  return value;
}

function agent(config: TestConfig, name: string): TestAgent {
  return requiredValue(config.agent[name], `agent ${name}`);
}

test('chain entries parse model and optional effort exactly', () => {
  assert.deepEqual(parseChainEntry('openai/gpt-5.6-sol@xhigh'), {
    providerID: 'openai',
    modelID: 'gpt-5.6-sol',
    effort: 'xhigh',
  });
  assert.deepEqual(parseChainEntry('opencode-go/deepseek-v4-flash'), {
    providerID: 'opencode-go',
    modelID: 'deepseek-v4-flash',
  });
  assert.throws(() => parseChainEntry('no-slash'), /provider\/model/);
  assert.throws(() => parseChainEntry('a/b@UPPER'), /effort/);
  assert.throws(() => parseChainEntry('../etc/passwd'), /provider\/model/);
});

test('models config validation rejects malformed classes and accepts absence', () => {
  assert.deepEqual(parseModelsConfig(undefined), {});
  assert.deepEqual(parseModelsConfig(null), {});
  assert.throws(() => parseModelsConfig([]), /plain object/);
  assert.throws(() => parseModelsConfig({ 'Bad Name': { use: 'x', chain: ['a/b'] } }), /kebab-case/);
  assert.throws(() => parseModelsConfig({ light: { use: 'x' } }), /chain/);
  assert.throws(() => parseModelsConfig({ light: { use: 'x', chain: [] } }), /chain/);
  assert.throws(() => parseModelsConfig({ light: { use: 'x', chain: ['a/b'], extra: 1 } }), /unknown fields/);
});

test('chain selection honors auth and falls to null when nothing is available', () => {
  assert.equal(pickChainEntry(requiredValue(CLASSES.light, 'light class'), null)?.modelID, 'gpt-5.6-luna-fast');
  assert.equal(pickChainEntry(requiredValue(CLASSES.light, 'light class'), new Set(['opencode-go']))?.modelID, 'deepseek-v4-flash');
  assert.equal(pickChainEntry(requiredValue(CLASSES.deep, 'deep class'), new Set(['zai'])), null);
});

test('variants are exact permission clones with only model, effort, and description changed', () => {
  const config = fakeConfig();
  const summary = applyVariantsToConfig(config, CLASSES, null);

  assert.equal(summary.variants.length, 9);
  for (const role of VARIANT_ROLES) {
    const variant = config.agent[variantAgentName(role, 'deep')];
    assert.ok(variant, `${role}-deep exists`);
    assert.equal(variant.model, 'openai/gpt-5.6-sol-fast');
    assert.equal(variant.variant, 'high');
    assert.equal(variant.hidden, true);
    assert.equal(variant.mode, 'subagent');
    assert.equal(variant.options?.naruVariant, true);
    assert.deepEqual(variant.permission, agent(config, role).permission, `${role}-deep permissions identical`);
    assert.match(variant.description ?? '', /Model class "deep" \(openai\/gpt-5\.6-sol-fast@high\)/);
  }
  // A chain entry without effort produces no variant field.
  assert.equal('variant' in agent(config, 'naru-reader-crosscheck'), false);
  assert.equal(agent(config, 'naru-reader-crosscheck').model, 'opencode-go/kimi-k2.5');
  // Base agents remain model-less and untouched.
  assert.equal('model' in agent(config, 'naru-reader'), false);
  assert.equal(agent(config, 'naru-writer').permission?.edit, 'allow');
});

test('the orchestrator allowlist and prompt appendix are regenerated idempotently', () => {
  const config = fakeConfig();
  applyVariantsToConfig(config, CLASSES, null);
  const taskValue = agent(config, 'naru-orchestrator').permission?.task;
  assert.equal(typeof taskValue, 'object');
  assert.ok(taskValue);
  const task = taskValue as Record<string, string>;
  assert.equal(task['naru-reader-light'], 'allow');
  assert.equal(task['naru-writer-crosscheck'], 'allow');
  assert.equal(task['*'], 'deny');
  assert.match(agent(config, 'naru-orchestrator').prompt ?? '', /Model classes \(generated from naru-runtime\.json\)/);
  assert.match(agent(config, 'naru-orchestrator').prompt ?? '', /"deep" -> openai\/gpt-5\.6-sol-fast@high: high consequence/);

  // Second application with fewer classes removes stale variants and keys.
  applyVariantsToConfig(config, parseModelsConfig({ light: { use: 'wide', chain: ['openai/gpt-5.6-luna-fast@high'] } }), null);
  assert.equal(config.agent['naru-reader-deep'], undefined);
  assert.equal(task['naru-reader-deep'], undefined);
  assert.equal(task['naru-reader-light'], 'allow');
  assert.equal((agent(config, 'naru-orchestrator').prompt?.match(/Model classes/g) || []).length, 1);

  // Empty classes strips everything, restoring the base config shape.
  applyVariantsToConfig(config, {}, null);
  assert.equal(Object.keys(config.agent).filter((k) => /^naru-(reader|runner|writer)-/.test(k)).length, 0);
  assert.equal(agent(config, 'naru-orchestrator').prompt, 'You coordinate work.');
});

test('classes whose providers are all unauthenticated are skipped, not broken', () => {
  const config = fakeConfig();
  const summary = applyVariantsToConfig(config, CLASSES, new Set(['openai']));
  assert.deepEqual(summary.classes.sort(), ['deep', 'light']);
  assert.equal(config.agent['naru-reader-crosscheck'], undefined);
});

test('validation happens before mutation: a broken config is left untouched', () => {
  const config = fakeConfig();
  delete config.agent['naru-writer'];
  const before = JSON.stringify(config);
  assert.throws(() => applyVariantsToConfig(config, CLASSES, null), /naru-writer is not configured/);
  assert.equal(JSON.stringify(config), before);

  const noTask = fakeConfig();
  const noTaskPermission = agent(noTask, 'naru-orchestrator').permission?.task;
  assert.equal(typeof noTaskPermission, 'object');
  assert.ok(noTaskPermission);
  (noTaskPermission as Record<string, string>)['*'] = 'allow';
  assert.throws(() => applyVariantsToConfig(noTask, CLASSES, null), /fail-closed/);
});

test('the plugin hooks config only and fails open on unusable configs', async () => {
  const hooks = await NaruDispatchPlugin();
  assert.deepEqual(Object.keys(hooks), ['config']);
  const broken = { agent: {} };
  await hooks.config(broken);
  assert.deepEqual(broken, { agent: {} });
});

test('appendix and labels render as documented', () => {
  assert.equal(modelLabel({ providerID: 'openai', modelID: 'gpt-5.6-sol', effort: 'xhigh' }), 'openai/gpt-5.6-sol@xhigh');
  assert.equal(modelLabel(null), 'inherited');
  assert.equal(buildPromptAppendix([]), '');
  const appendix = buildPromptAppendix([{ className: 'light', label: 'openai/gpt-5.6-luna-fast@high', use: 'wide fan-out' }]);
  assert.match(appendix, /naru-reader-<class>/);
  assert.match(appendix, /"light" -> openai\/gpt-5\.6-luna-fast@high: wide fan-out/);
});
