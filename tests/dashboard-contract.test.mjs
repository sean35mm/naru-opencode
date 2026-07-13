import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { parentTasks, routeText, statusText } from '../plugins/naru-minions-dashboard-state.mjs';

const source = await readFile(new URL('../plugins/naru-minions-dashboard.tsx', import.meta.url), 'utf8');

test('dashboard uses the OpenCode external TSX runtime and slot registration contract', () => {
  assert.match(source, /^\/\*\* @jsxImportSource @opentui\/solid \*\//);
  assert.match(source, /from "solid-js"/);
  assert.match(source, /api\.slots\.register\(\{/);
  assert.match(source, /sidebar_content\(_ctx, props\)/);
  assert.match(source, /sessionID=\{props\.session_id\}/);
  assert.doesNotMatch(source, /return\s+\{\s*sidebar_content/);
});

test('dashboard owns reactive resources in its mounted component', () => {
  assert.match(source, /function NaruActivity\(props\)/);
  assert.match(source, /createEffect\(\(\) => void refresh\(props\.sessionID\)\)/);
  assert.match(source, /onCleanup\(\(\) => \{/);
  assert.match(source, /setRows\(\[\]\)\s*\n\s*setDegraded\(true\)/);
  assert.doesNotMatch(source, /route\.changed/);
});

test('dashboard distinguishes Luna, Terra, Sol, and floors without guessing assignment provenance', () => {
  const configured = {
    'naru-plan-risk': { model: 'provider/sol', variant: 'high' },
    'naru-minion-scout': { model: 'provider/sol', variant: 'high' },
    'naru-delegate-sol-minion-investigate': { model: 'provider/sol', variant: 'high' },
    'naru-delegate-luna-minion-investigate': { model: 'provider/luna', variant: 'high' },
    'naru-minion-investigate': { model: 'provider/terra', variant: 'high' },
  };
  assert.equal(routeText('naru-minion-scout', 'naru-minion-scout', configured), 'Sol');
  assert.equal(routeText('naru-minion-investigate', 'naru-minion-investigate', configured), 'Terra');
  assert.equal(routeText('naru-delegate-luna-minion-investigate', 'naru-minion-investigate', configured), 'Luna');
  assert.equal(routeText('naru-delegate-sol-minion-investigate', 'naru-minion-investigate', configured), 'Sol');
  assert.equal(routeText('naru-delegate-deep-minion-investigate', 'naru-minion-investigate', configured), 'Sol');
  assert.equal(routeText('naru-plan-risk', 'naru-plan-risk', configured), 'Sol floor');
  assert.equal(routeText('naru-minion-verify', 'naru-minion-verify', {}), 'Routed');
});

test('v1.17 Task parts use background and terminal state overrides stale native activity', () => {
  const tasks = parentTasks([{
    parts: [{
      type: 'tool',
      tool: 'task',
      state: {
        status: 'completed',
        input: { background: true, subagent_type: 'naru-minion-scout' },
        metadata: { sessionID: 'completed-child' },
      },
    }, {
      type: 'tool',
      tool: 'task',
      state: {
        status: 'error',
        input: { subagent_type: 'naru-minion-debug' },
        metadata: { background: false, sessionID: 'error-child' },
      },
    }],
  }]);

  assert.equal(tasks.get('completed-child').background, true);
  assert.equal(tasks.get('error-child').background, false);
  assert.equal(statusText({ type: 'busy' }, tasks.get('completed-child').status), 'completed');
  assert.equal(statusText({ type: 'retry', attempt: 2 }, tasks.get('error-child').status), 'error');
  assert.equal(statusText({ type: 'busy' }, 'running'), 'busy');
  assert.equal(statusText({ type: 'idle' }, 'pending'), 'pending');
  assert.equal(statusText(undefined, undefined), 'unknown');
  assert.doesNotMatch(source, /run_in_background/);
});
