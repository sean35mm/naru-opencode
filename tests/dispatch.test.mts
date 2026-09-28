import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  analyzeConfiguredMcp,
  applyConfiguredMcpPermissionsToConfig,
  applyDispatchToConfigAtomically,
  applyVariantsToConfig,
  applyReviewDefaultsToConfig,
  applyRuntimeToConfigAtomically,
  buildReviewDefaultsAppendix,
  buildPromptAppendix,
  modelLabel,
  parseChainEntry,
  parseModelsConfig,
  pickChainEntry,
  variantAgentName,
  VARIANT_ROLES,
} from '../tools/naru-lib/dispatch.mjs';
import { createNaruDispatchHooks, createNaruDispatchPlugin } from '../plugins/naru-dispatch.js';
import { globalRuntimeConfigPath, loadRuntimeConfigFile, loadRuntimeConfigLayers, mergeRuntimeConfigLayers, parseRuntimeConfig } from '../tools/naru-lib/runtime-config.mjs';

const CLASSES = parseModelsConfig({
  light: { use: 'wide fan-out', chain: ['openai/gpt-5.6-luna-fast@high', 'opencode-go/deepseek-v4-flash'] },
  deep: { use: 'high consequence', chain: ['openai/gpt-5.6-sol-fast@high', 'openai/gpt-5.6-sol@high'] },
  crosscheck: { use: 'non-openai second opinion', chain: ['opencode-go/kimi-k2.5'] },
});

interface TestAgent {
  [key: string]: unknown;
  mode?: string;
  hidden?: boolean;
  description?: string;
  prompt?: string;
  model?: string;
  variant?: string;
  options?: Record<string, unknown>;
  permission?: Record<string, string | Record<string, string>>;
}

interface TestConfig {
  [key: string]: unknown;
  agent: Record<string, TestAgent>;
  mcp?: unknown;
  permission?: Record<string, unknown>;
}

function fakeConfig(): TestConfig {
  return {
    agent: {
      'naru': {
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

async function writeJson(file: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(value)}\n`);
}

// OpenCode evaluates the last matching tool permission. Pin effective outcomes,
// not just the presence of generated keys.
function effectiveToolPermission(permission: TestAgent['permission'], tool: string): string | undefined {
  return effectivePermission(permission, tool, '*');
}

function matches(pattern: string, value: string): boolean {
  const regex = new RegExp(`^${pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replaceAll('*', '.*')}$`);
  return regex.test(value);
}

function effectivePermission(permission: TestAgent['permission'], tool: string, resource: string): string | undefined {
  if (!permission) return undefined;
  let result: string | undefined;
  for (const [toolPattern, action] of Object.entries(permission)) {
    if (!matches(toolPattern, tool)) continue;
    if (typeof action === 'string') result = action;
    else {
      for (const [resourcePattern, resourceAction] of Object.entries(action)) {
        if (matches(resourcePattern, resource)) result = resourceAction;
      }
    }
  }
  return result;
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

test('raw runtime layers merge before defaults and arrays replace', () => {
  const runtime = mergeRuntimeConfigLayers([
    {
      mcp: { configuredTools: 'ask' },
      models: { smoke: { use: 'global class', chain: ['openai/global@high'] } },
      review: { defaultProfile: 'release-critical' },
    },
    {
      models: { smoke: { chain: ['openai/local@low'] } },
      review: { defaultOutput: 'concise' },
    },
  ]);
  assert.equal(runtime.mcp.configuredTools, 'ask');
  assert.deepEqual(runtime.review, { defaultProfile: 'release-critical', defaultDecision: 'comment-only', defaultOutput: 'concise' });
  assert.deepEqual(runtime.models, { smoke: { use: 'global class', chain: ['openai/local@low'] } });
  assert.deepEqual(mergeRuntimeConfigLayers([{ models: { smoke: { use: 'x', chain: ['a/b'] } } }, { models: {} }]).models, {});
  assert.throws(() => mergeRuntimeConfigLayers([{ schemaVersion: 2 }, { schemaVersion: 1 }]), /schemaVersion/);
  assert.equal(globalRuntimeConfigPath({ XDG_CONFIG_HOME: '/tmp/naru-xdg' }, '/tmp/ignored-home'), '/tmp/naru-xdg/opencode/naru-runtime.json');
  assert.equal(globalRuntimeConfigPath({}, '/tmp/naru-home'), '/tmp/naru-home/.config/opencode/naru-runtime.json');
});

test('direct runtime loading preserves ENOENT while layered absence uses defaults', async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'naru-runtime-loader-'));
  try {
    const missing = path.join(temporary, 'missing', 'naru-runtime.json');
    await assert.rejects(loadRuntimeConfigFile(missing), (error: unknown) =>
      error instanceof Error && 'code' in error && error.code === 'ENOENT');
    assert.deepEqual(await loadRuntimeConfigLayers([missing]), parseRuntimeConfig());

    const malformed = path.join(temporary, 'malformed', 'naru-runtime.json');
    await mkdir(path.dirname(malformed), { recursive: true });
    await writeFile(malformed, '{ invalid\n');
    await assert.rejects(loadRuntimeConfigFile(malformed), /invalid JSON/);
    await assert.rejects(loadRuntimeConfigLayers([malformed]), /invalid JSON/);

    await writeJson(malformed, { schemaVersion: 2 });
    await assert.rejects(loadRuntimeConfigFile(malformed), /schemaVersion/);
    await assert.rejects(loadRuntimeConfigLayers([malformed]), /schemaVersion/);
  }
  finally {
    await rm(temporary, { recursive: true, force: true });
  }
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
  const taskValue = agent(config, 'naru').permission?.task;
  assert.equal(typeof taskValue, 'object');
  assert.ok(taskValue);
  const task = taskValue as Record<string, string>;
  assert.equal(task['naru-reader-light'], 'allow');
  assert.equal(task['naru-writer-crosscheck'], 'allow');
  assert.equal(task['*'], 'deny');
  assert.match(agent(config, 'naru').prompt ?? '', /Model classes \(generated from naru-runtime\.json\)/);
  assert.match(agent(config, 'naru').prompt ?? '', /"deep" -> openai\/gpt-5\.6-sol-fast@high: high consequence/);

  // Second application with fewer classes removes stale variants and keys.
  applyVariantsToConfig(config, parseModelsConfig({ light: { use: 'wide', chain: ['openai/gpt-5.6-luna-fast@high'] } }), null);
  assert.equal(config.agent['naru-reader-deep'], undefined);
  assert.equal(task['naru-reader-deep'], undefined);
  assert.equal(task['naru-reader-light'], 'allow');
  assert.equal((agent(config, 'naru').prompt?.match(/Model classes/g) || []).length, 1);

  // Empty classes strips everything, restoring the base config shape.
  applyVariantsToConfig(config, {}, null);
  assert.equal(Object.keys(config.agent).filter((k) => /^naru-(reader|runner|writer)-/.test(k)).length, 0);
  assert.equal(agent(config, 'naru').prompt, 'You coordinate work.');
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
  const noTaskPermission = agent(noTask, 'naru').permission?.task;
  assert.equal(typeof noTaskPermission, 'object');
  assert.ok(noTaskPermission);
  (noTaskPermission as Record<string, string>)['*'] = 'allow';
  assert.throws(() => applyVariantsToConfig(noTask, CLASSES, null), /fail-closed/);
});

test('runtime config application is atomic when review defaults fail after variant setup', () => {
  const config = fakeConfig();
  delete agent(config, 'naru').prompt;
  const before = JSON.stringify(config);
  assert.throws(() => applyRuntimeToConfigAtomically(config, CLASSES, null, {
    defaultProfile: 'standard', defaultDecision: 'comment-only', defaultOutput: 'detailed',
  }), /no prompt/);
  assert.equal(JSON.stringify(config), before);
  assert.equal(config.agent['naru-reader-deep'], undefined);
});

test('configured MCP analysis normalizes like OpenCode and fails collisions closed', () => {
  const analysis = analyzeConfiguredMcp({
    'design.api': { type: 'remote' },
    design_api: { type: 'local' },
    foo: {},
    foo_bar: {},
    apply: {},
    disabled: { enabled: false },
    'codebase-memory-mcp': {},
    'codebase-memory-mcp_delete': {},
    'codebase-memory-mcp_query': { enabled: false },
    codebase: {},
    bad: { enabled: 'yes' },
    'keeps-hyphens': {},
  });
  const categories = Object.fromEntries(analysis.diagnostics.map(item => [item.serverName, item.category]));
  assert.equal(categories['design.api'], 'collision');
  assert.equal(categories.design_api, 'collision');
  assert.equal(categories.foo, 'collision');
  assert.equal(categories.foo_bar, 'collision');
  assert.equal(categories.apply, 'collision');
  assert.equal(categories.disabled, 'disabled');
  assert.equal(categories['codebase-memory-mcp'], 'protected');
  assert.equal(categories['codebase-memory-mcp_delete'], 'protected');
  assert.equal(categories['codebase-memory-mcp_query'], 'protected');
  assert.equal(categories.codebase, 'eligible');
  assert.equal(categories.bad, 'malformed');
  assert.deepEqual(analysis.rules, ['codebase_*', 'keeps-hyphens_*']);
  assert.equal(analyzeConfiguredMcp([]).diagnostics[0]?.category, 'malformed');
});

test('ask mode applies to every Naru base and generated variant without changing native walls', () => {
  const config = fakeConfig();
  applyDispatchToConfigAtomically(config, CLASSES, null, 'ask', {
    future: {},
    disabled: { enabled: false },
  });
  for (const name of ['naru', ...VARIANT_ROLES, ...Object.keys(config.agent).filter(name => /^naru-(reader|runner|writer)-/.test(name))]) {
    assert.equal(effectiveToolPermission(agent(config, name).permission, 'future_brand_new_tool'), 'ask', name);
    assert.equal(effectiveToolPermission(agent(config, name).permission, 'disabled_tool'), 'deny', name);
  }
  assert.equal(effectiveToolPermission(agent(config, 'naru').permission, 'bash'), 'deny');
  assert.equal(effectiveToolPermission(agent(config, 'naru-writer').permission, 'task'), 'deny');
});

test('off mode leaves an ungenerated permission policy unchanged', () => {
  const config = fakeConfig();
  config.permission = { '*': 'ask', bash: 'deny' };
  const before = JSON.stringify(config);
  applyConfiguredMcpPermissionsToConfig(config, 'off', { future: {} });
  assert.equal(JSON.stringify(config), before);
});

test('specific and server-wide policies retain last-match precedence over generated asks', () => {
  const config = fakeConfig();
  const orchestratorPermission = requiredValue(agent(config, 'naru').permission, 'orchestrator permission');
  for (const tool of ['get_design_context', 'get_variable_defs', 'get_screenshot', 'get_motion_context', 'get_metadata', 'get_figjam']) {
    orchestratorPermission[`figma-desktop_${tool}`] = 'allow';
  }
  orchestratorPermission['figma-desktop_delete_file'] = 'deny';
  const writerPermission = requiredValue(agent(config, 'naru-writer').permission, 'writer permission');
  writerPermission['locked_*'] = 'deny';
  applyConfiguredMcpPermissionsToConfig(config, 'ask', { 'figma-desktop': {}, locked: {}, open: {} });

  for (const tool of ['get_design_context', 'get_variable_defs', 'get_screenshot', 'get_motion_context', 'get_metadata', 'get_figjam']) {
    assert.equal(effectiveToolPermission(agent(config, 'naru').permission, `figma-desktop_${tool}`), 'allow');
  }
  assert.equal(effectiveToolPermission(agent(config, 'naru').permission, 'figma-desktop_new_future_tool'), 'ask');
  assert.equal(effectiveToolPermission(agent(config, 'naru').permission, 'figma-desktop_delete_file'), 'deny');
  assert.equal(effectiveToolPermission(agent(config, 'naru-writer').permission, 'locked_anything'), 'deny');
  assert.equal(effectiveToolPermission(agent(config, 'naru-writer').permission, 'open_future'), 'ask');
  assert.equal(effectiveToolPermission(agent(config, 'naru-writer').permission, 'unrelated_builtin'), 'deny');
});

test('protected codebase namespace retains curated exact tools without exposing administrative tools', () => {
  const config = fakeConfig();
  const permission = requiredValue(agent(config, 'naru').permission, 'orchestrator permission');
  permission['codebase-memory-mcp_search_graph'] = 'allow';
  applyConfiguredMcpPermissionsToConfig(config, 'ask', {
    'codebase-memory-mcp_delete': {},
    'codebase-memory-mcp_query': { enabled: false },
  });
  assert.equal(effectiveToolPermission(agent(config, 'naru').permission, 'codebase-memory-mcp_search_graph'), 'allow');
  assert.equal(effectiveToolPermission(agent(config, 'naru').permission, 'codebase-memory-mcp_delete_project'), 'deny');
  assert.equal(effectiveToolPermission(agent(config, 'naru').permission, 'codebase-memory-mcp_query_graph'), 'deny');
  assert.equal(effectiveToolPermission(agent(config, 'naru-writer').permission, 'codebase-memory-mcp_delete_project'), 'deny');
  assert.equal(effectiveToolPermission(agent(config, 'naru-writer').permission, 'codebase-memory-mcp_query_graph'), 'deny');
  assert.equal(Object.hasOwn(agent(config, 'naru').permission ?? {}, 'codebase-memory-mcp_*'), false);
});

test('ordinary codebase namespace stays eligible without broadening protected tools', () => {
  const config = fakeConfig();
  const analysis = applyConfiguredMcpPermissionsToConfig(config, 'ask', {
    shadow: {},
    shadow_admin: { enabled: false },
    codebase: {},
    safe: {},
  });
  assert.deepEqual(analysis.rules, ['codebase_*', 'safe_*', 'shadow_*']);
  assert.equal(effectiveToolPermission(agent(config, 'naru').permission, 'shadow_admin_delete'), 'ask');
  assert.equal(effectiveToolPermission(agent(config, 'naru').permission, 'codebase_future'), 'ask');
  assert.equal(effectiveToolPermission(agent(config, 'naru').permission, 'codebase-memory-mcp_delete_project'), 'deny');
  assert.equal(effectiveToolPermission(agent(config, 'naru').permission, 'safe_future'), 'ask');
});

test('generated MCP rules are idempotent, removable, and preserve user modifications', () => {
  const config = fakeConfig();
  applyConfiguredMcpPermissionsToConfig(config, 'ask', { alpha: {} });
  const once = JSON.stringify(config);
  applyConfiguredMcpPermissionsToConfig(config, 'ask', { alpha: {} });
  assert.equal(JSON.stringify(config), once);

  const permission = requiredValue(agent(config, 'naru-writer').permission, 'writer permission');
  permission['alpha_*'] = 'allow';
  applyConfiguredMcpPermissionsToConfig(config, 'ask', {});
  assert.equal(agent(config, 'naru-writer').permission?.['alpha_*'], 'allow');
  assert.equal(Object.hasOwn(agent(config, 'naru').permission ?? {}, 'alpha_*'), false);

  applyConfiguredMcpPermissionsToConfig(config, 'ask', { beta: {} });
  applyConfiguredMcpPermissionsToConfig(config, 'off', { beta: {} });
  assert.equal(Object.hasOwn(agent(config, 'naru').permission ?? {}, 'beta_*'), false);
});

test('variant and MCP synthesis is atomic on a fail-closed permission error', () => {
  const config = fakeConfig();
  const writerPermission = requiredValue(agent(config, 'naru-writer').permission, 'writer permission');
  delete writerPermission['*'];
  const before = JSON.stringify(config);
  assert.throws(() => applyDispatchToConfigAtomically(config, CLASSES, null, 'ask', { alpha: {} }), /wildcard deny/);
  assert.equal(JSON.stringify(config), before);
});

test('real config hook applies ask policy without MCP connection or provider access', async () => {
  const runtime = parseRuntimeConfig({ mcp: { configuredTools: 'ask' } });
  const hooks = createNaruDispatchHooks(runtime, {}, new Set());
  const config = fakeConfig();
  config.mcp = { 'figma-desktop': { type: 'remote', url: 'not-read-by-policy.invalid', enabled: true } };
  await hooks.config(config);
  assert.equal(effectiveToolPermission(agent(config, 'naru').permission, 'figma-desktop_future'), 'ask');
  assert.equal(effectiveToolPermission(agent(config, 'naru-writer').permission, 'figma-desktop_future'), 'ask');
  assert.equal(effectiveToolPermission(agent(config, 'naru-reader').permission, 'figma-desktop_future'), 'ask');
});

test('plugin layers global and adjacent runtime across repeated hooks', async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'naru-dispatch-layers-'));
  try {
    const globalPath = path.join(temporary, 'global', 'naru-runtime.json');
    const projectPath = path.join(temporary, 'project', 'naru-runtime.json');
    const absentPath = path.join(temporary, 'absent', 'naru-runtime.json');
    await writeJson(globalPath, {
      schemaVersion: 1,
      mcp: { configuredTools: 'ask' },
      models: { smoke: { use: 'global class', chain: ['openai/naru-layer@high'] } },
      review: { defaultProfile: 'release-critical', defaultDecision: 'automatic' },
    });

    const projectOnly = await createNaruDispatchPlugin({ globalRuntimePath: globalPath, localRuntimePath: absentPath, authProviders: null });
    const inherited = fakeConfig();
    inherited.mcp = { future: {} };
    await projectOnly.config(inherited);
    assert.equal(effectiveToolPermission(agent(inherited, 'naru-writer').permission, 'future_tool'), 'ask');
    assert.equal(agent(inherited, 'naru-writer-smoke').model, 'openai/naru-layer');

    await writeJson(projectPath, { review: { defaultOutput: 'concise' } });
    const globalPlugin = await createNaruDispatchPlugin({ globalRuntimePath: globalPath, localRuntimePath: globalPath, authProviders: null });
    const projectPlugin = await createNaruDispatchPlugin({ globalRuntimePath: globalPath, localRuntimePath: projectPath, authProviders: null });
    const combined = fakeConfig();
    combined.mcp = { future: {} };
    await globalPlugin.config(combined);
    await projectPlugin.config(combined);
    const combinedOnce = JSON.stringify(combined);
    await projectPlugin.config(combined);
    assert.equal(JSON.stringify(combined), combinedOnce);
    assert.equal(effectiveToolPermission(agent(combined, 'naru').permission, 'future_tool'), 'ask');
    assert.equal(agent(combined, 'naru-writer-smoke').model, 'openai/naru-layer');
    assert.match(agent(combined, 'naru').prompt ?? '', /profile=release-critical; decision=automatic; output=concise/);

    await writeJson(projectPath, { mcp: { configuredTools: 'off' } });
    const localOff = await createNaruDispatchPlugin({ globalRuntimePath: globalPath, localRuntimePath: projectPath, authProviders: null });
    await localOff.config(combined);
    assert.equal(effectiveToolPermission(agent(combined, 'naru').permission, 'future_tool'), 'deny');
    assert.equal(agent(combined, 'naru-writer-smoke').model, 'openai/naru-layer');

    await writeJson(projectPath, { models: {} });
    const noLocalClasses = await createNaruDispatchPlugin({ globalRuntimePath: globalPath, localRuntimePath: projectPath, authProviders: null });
    await noLocalClasses.config(combined);
    assert.equal(effectiveToolPermission(agent(combined, 'naru').permission, 'future_tool'), 'ask');
    assert.equal(combined.agent['naru-writer-smoke'], undefined);

    await writeJson(projectPath, { schemaVersion: 2 });
    const invalidLocal = await createNaruDispatchPlugin({ globalRuntimePath: globalPath, localRuntimePath: projectPath, authProviders: null });
    await globalPlugin.config(combined);
    assert.equal(effectiveToolPermission(agent(combined, 'naru').permission, 'future_tool'), 'ask');
    await invalidLocal.config(combined);
    assert.equal(effectiveToolPermission(agent(combined, 'naru').permission, 'future_tool'), 'deny');
    assert.equal(combined.agent['naru-writer-smoke'], undefined);

    const defaults = await createNaruDispatchPlugin({ globalRuntimePath: absentPath, localRuntimePath: path.join(temporary, 'also-absent.json'), authProviders: null });
    const defaultConfig = fakeConfig();
    defaultConfig.mcp = { future: {} };
    await defaults.config(defaultConfig);
    assert.equal(effectiveToolPermission(agent(defaultConfig, 'naru').permission, 'future_tool'), 'deny');
    assert.equal(defaultConfig.agent['naru-writer-smoke'], undefined);
  }
  finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test('missing runtime config removes generated rules and leaves the base agents available', async () => {
  const missing = path.join(os.tmpdir(), `naru-dispatch-missing-${process.pid}-${Date.now()}.json`);
  const hooks = await createNaruDispatchPlugin({ globalRuntimePath: missing, localRuntimePath: missing, authProviders: null });
  const config = fakeConfig();
  config.mcp = { alpha: {} };
  await hooks.config(config);
  assert.equal(effectiveToolPermission(agent(config, 'naru').permission, 'alpha_tool'), 'deny');
});

test('configured MCP analysis uses the host namespace mapping and rejects unsafe collisions', () => {
  const analysis = analyzeConfiguredMcp({
    'design.api': {},
    design_api: {},
    multi: {},
    'safe-server': {},
    disabled: { enabled: false },
    'bad*glob': {},
    malformed: { enabled: 'yes' },
  });
  const categories = Object.fromEntries(analysis.diagnostics.map((item) => [item.serverName, item.category]));
  assert.equal(categories['design.api'], 'collision');
  assert.equal(categories.design_api, 'collision');
  assert.equal(categories.multi, 'collision');
  assert.equal(categories.disabled, 'disabled');
  assert.equal(categories['bad*glob'], 'unsafe');
  assert.equal(categories.malformed, 'malformed');
  assert.deepEqual(analysis.rules, ['safe-server_*']);
});

test('MCP synthesis preserves native last-match order and restores moved MCP rules exactly', () => {
  const config = fakeConfig();
  const permission: NonNullable<TestAgent['permission']> = {
    alpha_blocked: 'deny',
    alpha_resource: { '*': 'ask', dangerous: 'deny' },
    'naru-git-read': 'allow',
    '*': 'deny',
    'native_*': 'ask',
    bash: 'deny',
    edit: 'deny',
    read: { '*': 'allow', '.env': 'deny' },
    task: { '*': 'deny', 'naru-reader': 'allow' },
  };
  agent(config, 'naru').permission = permission;
  const before = JSON.stringify(permission);
  const nativeKeys = Object.keys(permission).filter((key) => !key.startsWith('alpha_'));
  const nativeOutcomes = [
    effectiveToolPermission(permission, 'naru-git-read'),
    effectiveToolPermission(permission, 'native_probe'),
    effectiveToolPermission(permission, 'bash'),
    effectiveToolPermission(permission, 'edit'),
    effectivePermission(permission, 'read', '.env'),
    effectivePermission(permission, 'read', 'src/file.ts'),
    effectivePermission(permission, 'task', 'naru-reader'),
    effectivePermission(permission, 'task', 'other'),
  ];

  applyConfiguredMcpPermissionsToConfig(config, 'allow', { alpha: {} });
  const applied = requiredValue(agent(config, 'naru').permission, 'orchestrator permission');
  assert.deepEqual(Object.keys(applied).filter((key) => !key.startsWith('alpha_')), nativeKeys);
  assert.deepEqual([
    effectiveToolPermission(applied, 'naru-git-read'),
    effectiveToolPermission(applied, 'native_probe'),
    effectiveToolPermission(applied, 'bash'),
    effectiveToolPermission(applied, 'edit'),
    effectivePermission(applied, 'read', '.env'),
    effectivePermission(applied, 'read', 'src/file.ts'),
    effectivePermission(applied, 'task', 'naru-reader'),
    effectivePermission(applied, 'task', 'other'),
  ], nativeOutcomes);
  assert.equal(effectiveToolPermission(applied, 'naru-git-read'), 'deny');
  assert.equal(effectiveToolPermission(applied, 'alpha_new'), 'allow');
  assert.equal(effectiveToolPermission(applied, 'alpha_blocked'), 'deny');
  assert.equal(effectivePermission(applied, 'alpha_resource', 'ordinary'), 'allow');
  assert.equal(effectivePermission(applied, 'alpha_resource', 'dangerous'), 'deny');

  applyConfiguredMcpPermissionsToConfig(config, 'off', {});
  assert.equal(JSON.stringify(agent(config, 'naru').permission), before);
});

test('allow mode grants configured MCP namespaces to every base and model variant without changing native walls', () => {
  const config = fakeConfig();
  const sharedNested = { '*': 'ask', safe: 'allow', dangerous: 'deny', tail: 'ask' };
  for (const name of ['naru', ...VARIANT_ROLES]) {
    const permission = requiredValue(agent(config, name).permission, `${name} permission`);
    agent(config, name).permission = {
      linear_resource: sharedNested,
      linear_delete_customer: 'ask',
      ...permission,
    };
  }
  requiredValue(agent(config, 'naru-reader').permission, 'reader permission')['linear_delete_secret'] = 'deny';
  applyRuntimeToConfigAtomically(config, CLASSES, null, {
    defaultProfile: 'standard', defaultDecision: 'comment-only', defaultOutput: 'detailed',
  }, 'allow', {
    linear: { type: 'remote', url: 'ignored.invalid', headers: { authorization: 'never-inspected' } },
    'design.api': { command: ['never', 'inspected'] },
    disabled: { enabled: false },
  });

  const names = ['naru', ...VARIANT_ROLES, ...Object.keys(config.agent).filter((name) => /^naru-(reader|runner|writer)-/.test(name))];
  for (const name of names) {
    assert.equal(Object.keys(agent(config, name).permission ?? {})[0], '*', name);
    assert.equal(effectiveToolPermission(agent(config, name).permission, 'linear_create_issue'), 'allow', name);
    assert.equal(effectiveToolPermission(agent(config, name).permission, 'design_api_render'), 'allow', name);
    assert.equal(effectiveToolPermission(agent(config, name).permission, 'disabled_call'), 'deny', name);
    assert.equal(effectivePermission(agent(config, name).permission, 'linear_resource', 'ordinary'), 'allow', name);
    assert.equal(effectivePermission(agent(config, name).permission, 'linear_resource', 'safe'), 'allow', name);
    assert.equal(effectivePermission(agent(config, name).permission, 'linear_resource', 'dangerous'), 'deny', name);
    assert.equal(effectivePermission(agent(config, name).permission, 'linear_resource', 'tail'), 'allow', name);
    assert.deepEqual(Object.keys(agent(config, name).permission?.linear_resource ?? {}), ['*', 'safe', 'dangerous', 'tail'], name);
  }
  assert.deepEqual(sharedNested, { '*': 'ask', safe: 'allow', dangerous: 'deny', tail: 'ask' });
  assert.equal(effectiveToolPermission(agent(config, 'naru-reader').permission, 'linear_delete_secret'), 'deny');
  assert.equal(effectiveToolPermission(agent(config, 'naru-reader').permission, 'bash'), 'deny');
  assert.equal(effectiveToolPermission(agent(config, 'naru-runner').permission, 'edit'), 'deny');
  assert.equal(effectiveToolPermission(agent(config, 'naru-writer').permission, 'task'), 'deny');
  assert.equal(effectiveToolPermission(agent(config, 'naru').permission, 'linear_delete_customer'), 'allow');
});

test('generated MCP policy is idempotent, switches modes, restores asks, and preserves user edits', () => {
  const config = fakeConfig();
  const permission = requiredValue(agent(config, 'naru-writer').permission, 'writer permission');
  const nativeRead = permission.read;
  permission['alpha_sensitive'] = 'ask';
  permission['alpha_resource'] = { '*': 'ask', safe: 'allow', dangerous: 'deny', tail: 'ask' };
  applyConfiguredMcpPermissionsToConfig(config, 'allow', { alpha: {} });
  const once = JSON.stringify(config);
  applyConfiguredMcpPermissionsToConfig(config, 'allow', { alpha: {} });
  assert.equal(JSON.stringify(config), once);
  assert.equal(effectiveToolPermission(agent(config, 'naru-writer').permission, 'alpha_sensitive'), 'allow');
  assert.equal(effectivePermission(agent(config, 'naru-writer').permission, 'alpha_resource', 'ordinary'), 'allow');
  assert.equal(effectivePermission(agent(config, 'naru-writer').permission, 'alpha_resource', 'dangerous'), 'deny');
  assert.strictEqual(agent(config, 'naru-writer').permission?.read, nativeRead);
  const activeNested = agent(config, 'naru-writer').permission?.alpha_resource;
  assert.equal(typeof activeNested, 'object');
  assert.ok(activeNested);
  (activeNested as Record<string, string>).tail = 'deny';

  applyConfiguredMcpPermissionsToConfig(config, 'ask', { alpha: {} });
  assert.equal(effectiveToolPermission(agent(config, 'naru-writer').permission, 'alpha_sensitive'), 'ask');
  assert.equal(effectivePermission(agent(config, 'naru-writer').permission, 'alpha_resource', 'ordinary'), 'ask');
  assert.equal(effectivePermission(agent(config, 'naru-writer').permission, 'alpha_resource', 'tail'), 'deny');
  const orchestratorPermission = requiredValue(agent(config, 'naru').permission, 'orchestrator permission');
  orchestratorPermission['alpha_*'] = 'deny';
  applyConfiguredMcpPermissionsToConfig(config, 'allow', {});
  assert.equal(agent(config, 'naru').permission?.['alpha_*'], 'deny');
  assert.equal(agent(config, 'naru-writer').permission?.['alpha_sensitive'], 'ask');
  assert.equal(effectivePermission(agent(config, 'naru-writer').permission, 'alpha_resource', 'ordinary'), 'ask');
  assert.equal(effectivePermission(agent(config, 'naru-writer').permission, 'alpha_resource', 'tail'), 'deny');
  assert.equal(Object.hasOwn(agent(config, 'naru-reader').permission ?? {}, 'alpha_*'), false);
});

test('multiple config hooks replace owned MCP policy and leave no stale global rule', async () => {
  const config = fakeConfig();
  config.mcp = { alpha: {} };
  const globalHook = createNaruDispatchHooks(parseRuntimeConfig({ mcp: { configuredTools: 'allow' } }), {}, new Set());
  const projectHook = createNaruDispatchHooks(parseRuntimeConfig({ mcp: { configuredTools: 'off' } }), {}, new Set());
  await globalHook.config(config);
  assert.equal(effectiveToolPermission(agent(config, 'naru-reader').permission, 'alpha_read'), 'allow');
  await projectHook.config(config);
  assert.equal(effectiveToolPermission(agent(config, 'naru-reader').permission, 'alpha_read'), 'deny');
});

test('invalid model classes do not suppress independent MCP policy', async () => {
  const runtime = parseRuntimeConfig({
    mcp: { configuredTools: 'allow' },
    models: { broken: { use: 'missing chain' } },
  });
  assert.throws(() => parseModelsConfig(runtime.models), /chain/);
  const hooks = createNaruDispatchHooks(runtime, {}, new Set());
  const config = fakeConfig();
  config.mcp = { alpha: {} };
  await hooks.config(config);
  assert.equal(effectiveToolPermission(agent(config, 'naru').permission, 'alpha_read'), 'allow');
  assert.equal(config.agent['naru-reader-broken'], undefined);
});

test('MCP permission synthesis is atomic on an invalid Naru agent map', () => {
  const config = fakeConfig();
  const permission = requiredValue(agent(config, 'naru-runner').permission, 'runner permission');
  permission['*'] = 'allow';
  const before = JSON.stringify(config);
  assert.throws(() => applyRuntimeToConfigAtomically(config, CLASSES, null, {
    defaultProfile: 'standard', defaultDecision: 'comment-only', defaultOutput: 'detailed',
  }, 'allow', { alpha: {} }), /wildcard deny/);
  assert.equal(JSON.stringify(config), before);
});

test('the plugin hooks config only and fails open on unusable configs', async () => {
  const hooks = createNaruDispatchHooks(parseRuntimeConfig(), {}, new Set());
  assert.deepEqual(Object.keys(hooks), ['config']);
  const withoutModels = fakeConfig();
  await hooks.config(withoutModels);
  assert.match(agent(withoutModels, 'naru').prompt ?? '', /Review defaults \(generated/);
  assert.equal(Object.keys(withoutModels.agent).filter(name => /^naru-(reader|runner|writer)-/.test(name)).length, 0);
  const broken = { agent: {} };
  await hooks.config(broken);
  assert.deepEqual(broken, { agent: {} });
  const missingWriter = fakeConfig();
  delete missingWriter.agent['naru-writer'];
  await hooks.config(missingWriter);
  assert.match(agent(missingWriter, 'naru').prompt ?? '', /Review defaults \(generated/);
});

test('appendix and labels render as documented', () => {
  assert.equal(modelLabel({ providerID: 'openai', modelID: 'gpt-5.6-sol', effort: 'xhigh' }), 'openai/gpt-5.6-sol@xhigh');
  assert.equal(modelLabel(null), 'inherited');
  assert.equal(buildPromptAppendix([]), '');
  const appendix = buildPromptAppendix([{ className: 'light', label: 'openai/gpt-5.6-luna-fast@high', use: 'wide fan-out' }]);
  assert.match(appendix, /naru-reader-<class>/);
  assert.match(appendix, /"light" -> openai\/gpt-5\.6-luna-fast@high: wide fan-out/);
});

test('review defaults appendix works without model classes and is idempotent', () => {
  const config = fakeConfig();
  const review = { defaultProfile: 'release-critical', defaultDecision: 'automatic', defaultOutput: 'concise' } as const;
  applyReviewDefaultsToConfig(config, review);
  applyReviewDefaultsToConfig(config, review);
  const prompt = agent(config, 'naru').prompt ?? '';
  assert.equal((prompt.match(/Review defaults \(generated/g) || []).length, 1);
  assert.match(prompt, /profile=release-critical; decision=automatic; output=concise/);
  assert.match(prompt, /Persistent configuration never authorizes a post/);
  assert.match(buildReviewDefaultsAppendix(review), /ship-review/);

  const broken = { agent: { 'naru': {} } };
  const before = JSON.stringify(broken);
  assert.throws(() => applyReviewDefaultsToConfig(broken, review), /no prompt/);
  assert.equal(JSON.stringify(broken), before);
});
