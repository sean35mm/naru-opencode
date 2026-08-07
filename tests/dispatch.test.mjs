import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assertDenyOnly,
  buildToolDescription,
  CHILD_SESSION_DENIES,
  DISPATCH_AGENTS,
  modelLabel,
  parseChainEntry,
  parseModelsConfig,
  resolveCandidates,
  runDispatch,
} from '../tools/naru-lib/dispatch.mjs';
import { NaruDispatchPlugin } from '../plugins/naru-dispatch.js';

const CLASSES = parseModelsConfig({
  light: { use: 'wide fan-out', chain: ['openai/gpt-5.6-luna-fast@high', 'opencode-go/deepseek-v4-flash'] },
  deep: { use: 'high consequence', chain: ['openai/gpt-5.6-sol-fast@high', 'openai/gpt-5.6-sol@high'] },
  reasoning: { use: 'hardest problems', chain: ['openai/gpt-5.6-sol@xhigh'] },
});

function fakeContext(overrides = {}) {
  const titles = [];
  return {
    ctx: {
      sessionID: 'ses_parent',
      messageID: 'msg_1',
      agent: 'naru-orchestrator',
      directory: '/work/project',
      metadata: (input) => titles.push(input.title),
      ...overrides,
    },
    titles,
  };
}

function fakeClient({ createResults, promptResults } = {}) {
  const calls = { create: [], prompt: [] };
  let createIndex = 0;
  let promptIndex = 0;
  return {
    calls,
    session: {
      async create(input) {
        calls.create.push(input);
        const result = createResults?.[createIndex] ?? { data: { id: `ses_child_${createIndex}` } };
        createIndex += 1;
        return result;
      },
      async prompt(input) {
        calls.prompt.push(input);
        const result = promptResults?.[promptIndex] ?? { data: { parts: [{ type: 'text', text: 'child answer' }] } };
        promptIndex += 1;
        return result;
      },
      async messages() {
        return { data: [] };
      },
    },
  };
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
  assert.throws(() => parseModelsConfig({ light: { use: '', chain: ['a/b'] } }), /use/);
});

test('tool description lists configured classes and the unconfigured fallback', () => {
  const withClasses = buildToolDescription(CLASSES);
  assert.match(withClasses, /"light": wide fan-out -> openai\/gpt-5\.6-luna-fast@high \(\+1 fallback\)/);
  assert.match(withClasses, /"reasoning": hardest problems -> openai\/gpt-5\.6-sol@xhigh/);
  const empty = buildToolDescription({});
  assert.match(empty, /No model classes are configured/);
});

test('candidate resolution honors auth, effort override, and unknown classes', () => {
  const all = resolveCandidates(CLASSES, 'light', undefined, null);
  assert.equal(all.candidates.length, 2);
  assert.equal(all.candidates[0].effort, 'high');

  const filtered = resolveCandidates(CLASSES, 'light', undefined, new Set(['opencode-go']));
  assert.deepEqual(filtered.candidates.map((c) => c.providerID), ['opencode-go']);

  const overridden = resolveCandidates(CLASSES, 'deep', 'max', null);
  assert.ok(overridden.candidates.every((c) => c.effort === 'max'));

  assert.deepEqual(resolveCandidates(CLASSES, undefined, undefined, null).candidates, []);
  assert.throws(() => resolveCandidates(CLASSES, 'nope', undefined, null), /unknown model class "nope"/);
  assert.throws(() => resolveCandidates(CLASSES, 'deep', 'NOT VALID', null), /effort/);
});

test('child session permissions are deny-only and pin depth to one', () => {
  assertDenyOnly(CHILD_SESSION_DENIES);
  const denied = CHILD_SESSION_DENIES.map((rule) => rule.permission);
  assert.ok(denied.includes('task'));
  assert.ok(denied.includes('naru-dispatch'));
  assert.throws(() => assertDenyOnly([{ permission: 'edit', pattern: '*', action: 'allow' }]), /deny-only/);
});

test('dispatch binds the agent by name, sets the model, and never sends tools', async () => {
  const client = fakeClient();
  const { ctx, titles } = fakeContext();
  const result = await runDispatch({
    client,
    ctx,
    args: { agent: 'naru-reader', class: 'deep', description: 'trace auth flow', prompt: 'Trace it.' },
    classes: CLASSES,
    authProviders: null,
  });
  assert.equal(result.error, undefined);
  assert.match(result.output, /<dispatch agent="naru-reader" model="openai\/gpt-5\.6-sol-fast@high" class="deep"/);
  assert.match(result.output, /child answer/);

  const create = client.calls.create[0];
  assert.equal(create.body.agent, 'naru-reader');
  assert.equal(create.body.parentID, 'ses_parent');
  assert.match(create.body.title, /@naru-reader · openai\/gpt-5\.6-sol-fast@high/);
  assertDenyOnly(create.body.permission);
  assert.equal(create.query.directory, '/work/project');

  const prompt = client.calls.prompt[0];
  assert.equal(prompt.body.agent, 'naru-reader');
  assert.deepEqual(prompt.body.model, { providerID: 'openai', modelID: 'gpt-5.6-sol-fast' });
  assert.equal(prompt.body.variant, 'high');
  assert.equal('tools' in prompt.body, false, 'prompt body must never contain a tools map');
  assert.equal('system' in prompt.body, false);

  assert.ok(titles.some((t) => t.includes('naru-reader · openai/gpt-5.6-sol-fast@high')));
});

test('dispatch without a class inherits the parent model', async () => {
  const client = fakeClient();
  const { ctx } = fakeContext();
  const result = await runDispatch({
    client,
    ctx,
    args: { agent: 'naru-runner', description: 'run the tests', prompt: 'Run them.' },
    classes: CLASSES,
    authProviders: null,
  });
  assert.equal(result.error, undefined);
  assert.match(result.output, /model="inherited"/);
  assert.equal('model' in client.calls.prompt[0].body, false);
  assert.equal('variant' in client.calls.prompt[0].body, false);
});

test('dispatch falls through the chain and reports the fallback', async () => {
  const client = fakeClient({
    promptResults: [
      { error: 'model refused' },
      { data: { parts: [{ type: 'text', text: 'fallback answer' }] } },
    ],
  });
  const { ctx } = fakeContext();
  const result = await runDispatch({
    client,
    ctx,
    args: { agent: 'naru-reader', class: 'light', description: 'find usages', prompt: 'Find them.' },
    classes: CLASSES,
    authProviders: null,
  });
  assert.equal(result.error, undefined);
  assert.match(result.output, /model="opencode-go\/deepseek-v4-flash"/);
  assert.match(result.output, /fell back after openai\/gpt-5\.6-luna-fast@high/);
});

test('dispatch refuses foreign agents and foreign callers before any I/O', async () => {
  const client = fakeClient();
  const { ctx } = fakeContext();
  const foreignAgent = await runDispatch({
    client, ctx,
    args: { agent: 'build', description: 'x', prompt: 'y' },
    classes: CLASSES, authProviders: null,
  });
  assert.match(foreignAgent.error, /can only dispatch/);

  const { ctx: readerCtx } = fakeContext({ agent: 'naru-reader' });
  const foreignCaller = await runDispatch({
    client, ctx: readerCtx,
    args: { agent: 'naru-reader', description: 'x', prompt: 'y' },
    classes: CLASSES, authProviders: null,
  });
  assert.match(foreignCaller.error, /reserved for the naru-orchestrator/);
  assert.equal(client.calls.create.length, 0);
  assert.equal(client.calls.prompt.length, 0);
});

test('dispatch passes an explicit directory through for worktree writers', async () => {
  const client = fakeClient();
  const { ctx } = fakeContext();
  await runDispatch({
    client, ctx,
    args: { agent: 'naru-writer', class: 'deep', description: 'apply edits', prompt: 'Edit.', directory: '/tmp/wt-a' },
    classes: CLASSES, authProviders: null,
  });
  assert.equal(client.calls.create[0].query.directory, '/tmp/wt-a');
});

test('the plugin registers exactly one tool with the documented surface', async () => {
  const hooks = await NaruDispatchPlugin({ client: fakeClient() });
  const keys = Object.keys(hooks);
  assert.deepEqual(keys, ['tool']);
  const tools = Object.keys(hooks.tool);
  assert.deepEqual(tools, ['naru-dispatch']);
  const def = hooks.tool['naru-dispatch'];
  assert.deepEqual(Object.keys(def.args).sort(), ['agent', 'class', 'description', 'directory', 'effort', 'prompt']);
  assert.deepEqual(def.args.agent.enum, [...DISPATCH_AGENTS]);
  assert.equal(typeof def.execute, 'function');
});

test('model labels render for candidates and inheritance', () => {
  assert.equal(modelLabel({ providerID: 'openai', modelID: 'gpt-5.6-sol', effort: 'xhigh' }), 'openai/gpt-5.6-sol@xhigh');
  assert.equal(modelLabel(null), 'inherited');
});
