import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  activityCounts,
  ageText,
  compactLegend,
  compactRowMetadata,
  compactRowTitle,
  DASHBOARD_SENTINELS,
  dividerLine,
  hiddenCount,
  isSelectableSessionValue,
  padCell,
  parentTasks,
  routeText,
  sanitizeText,
  SIDEBAR_WIDTH,
  shortAgent,
  shortModel,
  shortSessionID,
  sidebarDividerLine,
  sidebarHeaderLine,
  sidebarLine,
  sidebarMetadataLine,
  sidebarOverflowLine,
  sidebarStatusLine,
  sidebarTaskLine,
  statusPresentation,
  statusText,
  truncateText,
  visibleActivityRows,
} from '../plugins/naru-minions-dashboard-state.mjs';
import {
  canonicalAgentForRoute,
  isManagedRoutingAlias,
  solXhighAlias,
} from '../tools/naru-lib/model-routing.mjs';

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
  assert.match(source, /setRows\(\[\]\)\s*\n\s*setTelemetry\(null\)\s*\n\s*setDegraded\(true\)/);
  assert.doesNotMatch(source, /route\.changed/);
});

test('dashboard distinguishes Luna, Terra, Sol, Sol xhigh, and floors without guessing assignment provenance', () => {
  const configured = {
    'naru-plan-risk': { model: 'provider/sol', variant: 'high' },
    'naru-minion-scout': { model: 'provider/sol', variant: 'high' },
    'naru-delegate-sol-minion-investigate': { model: 'provider/sol', variant: 'high' },
    'naru-delegate-luna-minion-investigate': { model: 'provider/luna', variant: 'high' },
    'naru-delegate-sol-xhigh-minion-architect': { model: 'provider/sol', variant: 'xhigh' },
    'naru-delegate-sol-xhigh-minion-investigate': { model: 'provider/sol', variant: 'xhigh' },
    'naru-minion-investigate': { model: 'provider/terra', variant: 'high' },
  };
  assert.equal(routeText('naru-minion-scout', 'naru-minion-scout', configured), 'Sol');
  assert.equal(routeText('naru-minion-investigate', 'naru-minion-investigate', configured), 'Terra');
  assert.equal(routeText('naru-delegate-luna-minion-investigate', 'naru-minion-investigate', configured), 'Luna');
  assert.equal(routeText('naru-delegate-sol-minion-investigate', 'naru-minion-investigate', configured), 'Sol');
  assert.equal(routeText('naru-delegate-sol-xhigh-minion-investigate', 'naru-minion-investigate', configured), 'Sol xhigh');
  assert.equal(routeText('naru-delegate-sol-xhigh-minion-architect', 'naru-minion-architect', configured), 'Sol xhigh');
  assert.equal(routeText('naru-delegate-deep-minion-investigate', 'naru-minion-investigate', configured), 'Sol');
  assert.equal(routeText('naru-plan-risk', 'naru-plan-risk', configured), 'Sol floor');
  assert.equal(routeText('naru-minion-verify', 'naru-minion-verify', {}), 'Routed');
});

test('dashboard canonicalizes every managed Sol xhigh minion alias', () => {
  for (const target of [
    'naru-minion-scout',
    'naru-minion-investigate',
    'naru-minion-architect',
    'naru-minion-implement',
    'naru-minion-debug',
    'naru-minion-verify',
    'naru-minion-judge',
  ]) {
    const alias = solXhighAlias(target);
    assert.equal(isManagedRoutingAlias(alias), true);
    assert.equal(canonicalAgentForRoute(alias), target);
  }
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

test('dashboard text helpers sanitize controls, truncate safely, and align fixed-width cells', () => {
  assert.equal(sanitizeText('  first\nsecond\u0000\tthird  '), 'first second third');
  assert.equal(truncateText('abcdefgh', 5), 'abcd…');
  assert.equal(truncateText('abcdefgh', 1), '…');
  assert.equal(padCell('abcdef', 4), 'abc…');
  assert.equal(padCell('x', 4), 'x   ');
  assert.equal(padCell('x', 4, 'right'), '   x');
  assert.equal(dividerLine(5), '-----');
  assert.equal(shortSessionID('session-123456789'), 'session…');
  assert.equal(shortAgent('naru-minion-implement'), 'implement');
  assert.equal(shortModel('openai/gpt-5.6-sol (xhigh)'), 'gpt-5.6-sol (xhigh)');
});

test('dashboard status and age presentations remain explicit and deterministic', () => {
  assert.deepEqual(statusPresentation('busy'), { symbol: '●', label: 'BUSY' });
  assert.deepEqual(statusPresentation('retry 2'), { symbol: '↻', label: 'RETRY 2' });
  assert.deepEqual(statusPresentation('completed'), { symbol: '✓', label: 'DONE' });
  assert.deepEqual(statusPresentation(undefined), { symbol: '?', label: 'UNKNOWN' });
  assert.equal(ageText(1_000, 31_000), '30s');
  assert.equal(ageText(1_000, 121_000), '2m');
  assert.equal(ageText(undefined, 121_000), 'resolving');
});

test('dashboard counts active and recent rows, caps inventory, and reports hidden rows', () => {
  const now = 1_000_000;
  const rows = [
    { id: 'active-1', status: 'busy', updated: now - 50_000 },
    { id: 'active-2', status: 'pending', updated: now - 900_000 },
    { id: 'recent-1', status: 'completed', updated: now - 60_000 },
    { id: 'stale-1', status: 'error', updated: now - (16 * 60_000) },
    { id: 'recent-2', status: 'idle', updated: now - 100_000 },
  ];
  assert.deepEqual(activityCounts(rows, now), { active: 2, recent: 2 });
  assert.deepEqual(visibleActivityRows(rows, 3, now).map((row) => row.id), ['active-1', 'active-2', 'recent-1']);
  assert.equal(hiddenCount(4, 3), 1);
  assert.equal(hiddenCount(2, 4), 0);
});

test('dashboard compact rows keep aligned primary columns within 61 characters', () => {
  const row = {
    id: 'child-session-123456789',
    status: 'running',
    agent: 'naru-minion-implement',
    route: 'Sol xhigh',
    mode: 'background',
    updated: 1_000,
    task: 'Implement a very long task\nwithout breaking the terminal layout',
    model: 'openai/gpt-5.6-sol (xhigh)',
  };

  const legend = compactLegend();
  assert.equal(legend.length, 61);
  assert.match(legend, /^STATUS\s+AGENT\s+AGE\s+TASK\s*$/);

  for (const status of ['busy', 'retry 123456789', 'running', 'pending', 'completed', 'error', 'idle', 'unknown-status']) {
    const title = compactRowTitle({ ...row, status, task: row.task.repeat(5) }, 31_000);
    assert.ok(title.length <= 61);
    assert.doesNotMatch(title, /\n/);
    assert.ok(title.slice(0, 11).trim().length > 1, 'status symbol and label are present');
    assert.equal(title.slice(12, 24).trim(), 'implement');
    assert.equal(title.slice(25, 34).trim(), '30s');
    assert.ok(title.slice(35).trim().length > 0, 'task column is present');
  }
});

test('dashboard compact secondary metadata labels route, mode, model, and short session', () => {
  const metadata = compactRowMetadata({
    id: 'child-session-123456789',
    status: 'running',
    agent: 'naru-minion-implement',
    route: 'Sol xhigh',
    mode: 'background',
    task: 'Implement the compact dashboard',
    model: 'openai/gpt-5.6-sol (xhigh)',
  });
  assert.match(metadata, /Route: Sol xhigh/);
  assert.match(metadata, /Mode: BG/);
  assert.match(metadata, /Model: gpt-5\.6-sol \(xhigh\)/);
  assert.match(metadata, /Session: child-s…/);
  assert.doesNotMatch(metadata, /child-session-123456789/);
});

test('dashboard keeps full session IDs as values and ignores renderable sentinel states', () => {
  assert.deepEqual(Object.keys(DASHBOARD_SENTINELS), ['loading', 'empty', 'unavailable']);
  for (const value of Object.values(DASHBOARD_SENTINELS)) {
    assert.equal(isSelectableSessionValue(value), false);
  }
  assert.equal(isSelectableSessionValue('child-session-123456789'), true);

  assert.match(source, /title: compactRowTitle\(row\)/);
  assert.match(source, /description: compactRowMetadata\(row\)/);
  assert.match(source, /value: row\.id/);
  assert.match(source, /if \(!isSelectableSessionValue\(item\?\.value\)\) return/);
  assert.match(source, /value: DASHBOARD_SENTINELS\.loading/);
  assert.match(source, /value: DASHBOARD_SENTINELS\.empty/);
  assert.match(source, /value: DASHBOARD_SENTINELS\.unavailable/);
  assert.doesNotMatch(source, /disabled\s*:/);
  assert.doesNotMatch(source, /DETAIL_LAYOUT|detailHeader|detailDivider|detailLines/);
  assert.doesNotMatch(source, /dialog\.setSize/);
  assert.doesNotMatch(source, /process\.stdout\.columns/);
  assert.match(source, /skipFilter: true/);
  assert.match(source, /Loading activity\.\.\./);
  assert.match(source, /No recognized Naru child sessions/);
  assert.match(source, /Naru activity unavailable/);
});

test('dashboard sidebar helpers conservatively bound every rendered line to 32 characters', () => {
  const row = {
    id: 'child-session-123456789',
    status: 'retry 123456789',
    agent: 'naru-minion-extraordinarily-long-agent-name',
    route: 'Extraordinarily long route classification',
    mode: 'background',
    updated: 1_000,
    task: 'Implement a very long task without breaking the sidebar layout'.repeat(3),
    model: 'provider/an-extraordinarily-long-model-name-with-a-variant',
  };
  const lines = [
    sidebarLine('x'.repeat(100)),
    sidebarHeaderLine(123456789, 987654321),
    sidebarDividerLine(),
    sidebarStatusLine(row, 31_000),
    sidebarTaskLine(row),
    sidebarMetadataLine(row),
    sidebarOverflowLine(123456789),
  ];
  assert.equal(SIDEBAR_WIDTH, 32);
  assert.ok(lines.every((line) => line.length <= SIDEBAR_WIDTH));
  assert.equal(sidebarDividerLine().length, SIDEBAR_WIDTH);
  assert.match(sidebarStatusLine({ ...row, status: 'busy' }, 31_000), /^● BUSY/);
  assert.match(source, /const SIDEBAR_LIMIT = 4/);
  assert.match(source, /visibleActivityRows\(rows\(\), SIDEBAR_LIMIT\)/);
  for (const helper of ['sidebarHeaderLine', 'sidebarDividerLine', 'sidebarLine', 'sidebarStatusLine', 'sidebarTaskLine', 'sidebarMetadataLine', 'sidebarOverflowLine']) {
    assert.match(source, new RegExp(`${helper}\\(`));
  }
});
