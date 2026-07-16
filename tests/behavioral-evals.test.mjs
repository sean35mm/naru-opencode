import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { MANAGED_SOL_XHIGH_ALIASES, NARU_AGENT_IDS, NARU_DISPATCH_GRAPH } from '../tools/naru-lib/model-routing.mjs';

const fixturePath = fileURLToPath(new URL('./fixtures/behavioral-evals.json', import.meta.url));
const fixture = JSON.parse(await readFile(fixturePath, 'utf8'));
const canonicalAgents = new Set(NARU_AGENT_IDS);
const workflowBaselines = {
  plan: ['naru-plan-minimal-change', 'naru-plan-tests', 'naru-plan-judge'],
  impact: ['naru-impact-topology', 'naru-impact-tests-ci', 'naru-impact-judge'],
  triage: ['naru-triage-reproduction', 'naru-triage-codepath', 'naru-triage-judge'],
  review: ['naru-review-judge'],
};

function caseByID(id) {
  const item = fixture.cases.find((entry) => entry.id === id);
  assert.ok(item, `missing fixture case: ${id}`);
  return item;
}

test('behavioral contract corpus has a stable, canonical shape', () => {
  assert.equal(fixture.schemaVersion, 1);
  assert.match(fixture.purpose, /not a live model-quality benchmark/i);
  const ids = fixture.cases.map((entry) => entry.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const id of [
    'narrow-implementation', 'cross-package-implementation', 'ambiguous-diagnosis',
    'security-data-sensitive-change', 'frontend-review', 'backend-review', 'cross-service-review',
    'provider-failure', 'missing-context', 'conditional-specialist-selection',
    'high-root-xhigh-denial', 'xhigh-root-optional-children', 'max-root-xhigh-unlock',
    'routine-autonomous-local-commands', 'local-change-stopping-point', 'explicit-git-delivery',
  ]) caseByID(id);

  for (const entry of fixture.cases) {
    assert.equal(typeof entry.id, 'string');
    assert.ok(canonicalAgents.has(entry.rootAgent), `${entry.id} has a canonical root agent`);
    assert.equal(typeof entry.input?.summary, 'string');
    assert.ok(Array.isArray(entry.prohibited?.actions) && entry.prohibited.actions.length);
    assert.ok(Array.isArray(entry.prohibited?.routes) && entry.prohibited.routes.length);
    assert.equal(typeof entry.expected?.status, 'string');
    assert.equal(typeof entry.expected?.authorization, 'string');
  }
});

test('model-route variants preserve high defaults and never create Max children', () => {
  for (const entry of fixture.cases) {
    const { root, children } = entry.routing;
    assert.ok(['luna', 'terra', 'sol'].includes(root.profile), `${entry.id} root profile`);
    assert.ok(['high', 'xhigh', 'max'].includes(root.variant), `${entry.id} root variant`);
    assert.deepEqual(children.standardVariants, ['high'], `${entry.id} standard child variants`);
    assert.ok(children.profiles.every((profile) => ['luna', 'terra', 'sol'].includes(profile)));
    assert.ok(![...children.standardVariants, ...children.optionalVariants].includes('max'), `${entry.id} has no Max child`);
  }
});

test('xhigh is optional and only reachable from direct Sol xhigh or max orchestrator roots', () => {
  for (const entry of fixture.cases) {
    const allowsXhigh = entry.routing.children.optionalVariants.includes('xhigh');
    if (allowsXhigh) {
      assert.equal(entry.rootAgent, 'naru-orchestrator', `${entry.id} xhigh root agent`);
      assert.equal(entry.routing.root.profile, 'sol', `${entry.id} xhigh Sol profile`);
      assert.ok(['xhigh', 'max'].includes(entry.routing.root.variant), `${entry.id} xhigh root variant`);
      assert.equal(entry.expected.authorization, 'xhigh-authorized');
    }
    if (entry.routing.root.variant === 'high') {
      assert.equal(allowsXhigh, false, `${entry.id} high roots cannot auto-use xhigh`);
    }
  }
  const denied = caseByID('high-root-xhigh-denial');
  assert.equal(denied.prohibited.routes[0], 'naru-delegate-sol-xhigh-minion-implement');
  assert.equal(denied.expected.status, 'denied');
  assert.equal(MANAGED_SOL_XHIGH_ALIASES.length, 7);
});

test('conditional fan-out keeps workflow baselines, selected sets, and skipped-not-relevant semantics', () => {
  for (const entry of fixture.cases.filter((item) => item.selection)) {
    const { selected, skipped, baseline, skippedStatus } = entry.selection;
    const targets = NARU_DISPATCH_GRAPH[entry.rootAgent] ?? [];
    assert.deepEqual(baseline, workflowBaselines[entry.workflow] ?? baseline, `${entry.id} baseline`);
    assert.equal(skippedStatus, 'skipped-not-relevant');
    for (const specialist of [...selected, ...skipped, ...baseline]) {
      assert.ok(canonicalAgents.has(specialist), `${entry.id} specialist is canonical`);
      assert.ok(targets.includes(specialist), `${entry.id} specialist is reachable from root`);
    }
    for (const specialist of baseline) assert.ok(selected.includes(specialist), `${entry.id} selected baseline ${specialist}`);
    assert.equal(new Set([...selected, ...skipped]).size, selected.length + skipped.length, `${entry.id} selection sets do not overlap`);
    assert.deepEqual(new Set([...selected, ...skipped]), new Set(targets), `${entry.id} selection sets cover root targets`);
  }
  assert.deepEqual(caseByID('conditional-specialist-selection').selection.skipped, [
    'naru-impact-contracts', 'naru-impact-data', 'naru-impact-frontend-mobile',
  ]);
});

test('authorization fixtures preserve routine autonomy, local stopping, and explicit delivery', () => {
  const routine = caseByID('routine-autonomous-local-commands');
  assert.equal(routine.expected.promptRequired, false);
  assert.deepEqual(routine.expected.allowedOperations, ['naru-git-read', 'naru-github-read', 'bash', 'weaver', 'targeted-check']);

  const localStop = caseByID('local-change-stopping-point');
  assert.equal(localStop.expected.authorization, 'local-changes-stop');
  assert.deepEqual(localStop.prohibited.actions, ['commit', 'push', 'open pull request']);

  const delivery = caseByID('explicit-git-delivery');
  assert.equal(delivery.expected.authorization, 'delivery-authorized');
  assert.equal(delivery.expected.promptRequired, false);
  assert.deepEqual(delivery.expected.allowedOperations, ['commit', 'push', 'open-pull-request']);
});
