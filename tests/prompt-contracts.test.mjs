import { readdir, readFile, stat } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const here = p => join(root, p);

async function exists(p) {
  try {
    await stat(here(p));
    return true;
  } catch {
    return false;
  }
}

function hasAny(text, phrases) {
  const low = text.toLowerCase();
  return phrases.some(p => low.includes(p.toLowerCase()));
}

let failures = 0;
function fail(msg) {
  console.error(`FAIL: ${msg}`);
  failures += 1;
}

async function main() {
  const required = [
    'agents/naru-plan.md',
    'agents/naru-impact.md',
    'agents/naru-triage.md',
    'agents/naru-review.md',
    'agents/naru-review-post.md',
    'agents/naru-minion-verify.md',
    'agents/naru-minion-judge.md',
    'agents/naru-minion-implement.md',
    'agents/naru-orchestrator.md',
    'README.md',
    'docs/user-guide.md',
    'docs/agent-integration.md',
    'docs/development.md',
    'plugins/naru-delegate.js',
    'tools/naru-lib/model-routing.mjs',
  ];
  const missing = [];
  for (const p of required) {
    if (!(await exists(p))) missing.push(p);
  }
  if (missing.length) fail(`missing required prompt files: ${missing.join(', ')}`);

  const docs = (await readdir(here('docs'))).sort();
  const expectedDocs = ['agent-integration.md', 'development.md', 'user-guide.md'];
  if (JSON.stringify(docs) !== JSON.stringify(expectedDocs)) {
    fail(`docs inventory mismatch: got ${JSON.stringify(docs)} expected ${JSON.stringify(expectedDocs)}`);
  }

  // Core orchestrators: conditional coverage, status semantics, early stop, and packet scoping.
  for (const wf of ['plan', 'impact', 'triage']) {
    const text = await readFile(here(`agents/naru-${wf}.md`), 'utf8');
    if (!hasAny(text, ['incomplete', 'partial', 'not enough', 'insufficient'])) {
      fail(`naru-${wf} missing incomplete/partial handling`);
    }
    if (!hasAny(text, ['retry', 'degraded', 'status'])) {
      fail(`naru-${wf} missing retry/status handling`);
    }
    if (!hasAny(text, ['prompt injection', 'untrusted input', 'ignore any instruction', 'data, not instructions'])) {
      fail(`naru-${wf} missing prompt-injection guard`);
    }
    for (const requiredText of [
      'conservative relevance-based specialist selection',
      'skipped-not-relevant',
      'Selected specialists are required',
      'Only a failed selected/required specialist degrades',
      'Stop context gathering once the likely touchpoints',
      'small shared base packet',
      'lens-specific evidence, questions, and explicit exclusions',
      'Do not forward raw arguments',
      'untrusted context',
    ]) {
      if (!hasAny(text, [requiredText])) fail(`naru-${wf} missing conditional-selection contract: ${requiredText}`);
    }
    if (text.includes('Every specialist is required for this workflow')) {
      fail(`naru-${wf} retains mandatory-all specialist coverage`);
    }
    const judge = await readFile(here(`agents/naru-${wf}-judge.md`), 'utf8');
    if (!judge.includes('## Workflow Status')) fail(`naru-${wf}-judge missing Workflow Status contract`);
    for (const requiredText of ['completed', 'failed', 'skipped-not-relevant', 'Only failed selected/required specialists degrade']) {
      if (!hasAny(judge, [requiredText])) fail(`naru-${wf}-judge missing conditional-status contract: ${requiredText}`);
    }
  }

  const plan = await readFile(here('agents/naru-plan.md'), 'utf8');
  for (const requiredText of [
    'Always select `naru-plan-minimal-change` and `naru-plan-tests`',
    'naru-plan-architecture` only for structural, API, dependency, or cross-module work',
    'naru-plan-risk` only for security, data, billing, migrations, contracts, deployment, or compatibility work',
  ]) {
    if (!plan.includes(requiredText)) fail(`naru-plan missing relevance rule: ${requiredText}`);
  }

  const impact = await readFile(here('agents/naru-impact.md'), 'utf8');
  for (const requiredText of [
    'Always select `naru-impact-topology` and `naru-impact-tests-ci`',
    'naru-impact-contracts`, `naru-impact-data`, and `naru-impact-frontend-mobile` only when their affected surface is present',
  ]) {
    if (!impact.includes(requiredText)) fail(`naru-impact missing relevance rule: ${requiredText}`);
  }

  const triage = await readFile(here('agents/naru-triage.md'), 'utf8');
  for (const requiredText of [
    'Always select `naru-triage-reproduction` and `naru-triage-codepath`',
    'naru-triage-regression` only when recent changes, history, or a known-good state are relevant',
    'naru-triage-tests` only when failing tests, coverage, CI, or reproduction evidence makes it relevant',
  ]) {
    if (!triage.includes(requiredText)) fail(`naru-triage missing relevance rule: ${requiredText}`);
  }

  // Review: conditional domain selection and preserved strict snapshot/payload invariants.
  const review = await readFile(here('agents/naru-review.md'), 'utf8');
  if (!hasAny(review, ['payload', 'snapshot'])) {
    fail('naru-review missing payload/snapshot framing');
  }
  if (!hasAny(review, ['location', 'nullable', 'optional'])) {
    fail('naru-review missing nullable/optional location handling');
  }
  if (!hasAny(review, ['current/partial/stale/uncertain', 'classify prior findings', 'prior status', 'review status'])) {
    fail('naru-review missing prior status handling');
  }
  for (const requiredText of [
    'Select each domain specialist using the required-specialist relevance criteria below',
    'always select at least one relevant domain specialist',
    'naru-review-tests-ci` only when its existing relevance criteria apply',
    'skipped-not-relevant',
    'Only a failed selected/required specialist degrades the review',
    'immutable PR snapshot',
    'at the snapshot head or base SHA',
    'validate inline comment candidates against the snapshot patch',
    'exact final `naru_review_result` payload',
    'dry-run only',
    '`--post` is not accepted',
  ]) {
    if (!review.includes(requiredText)) fail(`naru-review missing conditional or invariant contract: ${requiredText}`);
  }
  const reviewJudge = await readFile(here('agents/naru-review-judge.md'), 'utf8');
  for (const requiredText of ['skipped-not-relevant', 'Only a failed selected/required specialist', 'schemaVersion": 1']) {
    if (!reviewJudge.includes(requiredText)) fail(`naru-review-judge missing preserved status/schema contract: ${requiredText}`);
  }
  if (reviewJudge.includes('non-required specialist failed')) {
    fail('naru-review-judge retains non-selected failure degradation semantics');
  }

  // Review-post boundary: explicit authorization, fail-closed validation, COMMENT-only, idempotency/snapshot.
  const post = await readFile(here('agents/naru-review-post.md'), 'utf8');
  const reviewPostCommand = await readFile(here('commands/naru-review-post.md'), 'utf8');
  const reviewPostContract = `${post}\n${reviewPostCommand}`;
  for (const requiredText of [
    'explicitly requests posting',
    'user authorization',
    'Do not request another runtime confirmation',
    'dry-run post-preparation mode',
    'exactly one `### naru_review_result` heading',
    'schemaVersion` must be `1`',
    'workflow.status` is `incomplete`',
    'workflow.degraded` is `true`',
    'snapshot.complete` is `false`',
    'exactly once',
    'Do not parse or construct arbitrary endpoints',
    'fall back to shell commands',
    'do not retry',
    'COMMENT',
    'an identical existing review returns `alreadyPosted`',
    'Degraded or incomplete reviews are never posted',
    'Never approve a PR, request changes',
    'push commits',
  ]) {
    if (!reviewPostContract.includes(requiredText)) fail(`naru-review-post missing authorization or fail-closed contract: ${requiredText}`);
  }

  // Verify/judge loop markers.
  const verify = await readFile(here('agents/naru-minion-verify.md'), 'utf8');
  const judge = await readFile(here('agents/naru-minion-judge.md'), 'utf8');
  if (!hasAny(verify, ['loop', 'iterate', 'judge', 'verify'])) {
    fail('naru-minion-verify missing verify/judge loop marker');
  }
  if (!hasAny(judge, ['loop', 'iterate', 'synthesize', 'reconcile'])) {
    fail('naru-minion-judge missing judge loop/synthesize marker');
  }

  // Approved delegation markers for generic implement and orchestrator.
  const implement = await readFile(here('agents/naru-minion-implement.md'), 'utf8');
  const orchestrator = await readFile(here('agents/naru-orchestrator.md'), 'utf8');
  if (!hasAny(implement, ['approved delegation', 'delegated', 'approval', 'explicitly approved'])) {
    fail('naru-minion-implement missing approved delegation marker');
  }
  if (!hasAny(orchestrator, ['delegate', 'delegation', 'approved'])) {
    fail('naru-orchestrator missing delegation marker');
  }
  for (const requiredText of [
    'Run the smallest safe analysis set',
    'Skip `naru-minion-scout` when exact files or symbols are known',
    'naru-minion-investigate` only when behavior, a failure path, or root cause remains uncertain',
    'naru-minion-architect` only for structural or high-consequence work',
    'Stop context gathering once the likely touchpoints',
    'shared base packet',
    'lens-specific evidence, questions, and exclusions',
    'Do not forward raw arguments',
  ]) {
    if (!orchestrator.includes(requiredText)) fail(`naru-orchestrator missing selective-workflow contract: ${requiredText}`);
  }
  if (orchestrator.includes('## Model Selection')) {
    fail('naru-orchestrator retains duplicate static model-selection section');
  }

  for (const requiredText of [
    'dependency DAG, not an ordered queue',
    'after planning and after each completion',
    'do not force fan-out or invent splits',
    'At most two fresh Implement invocations',
    'exact write paths or globs',
    'shared contracts, generated artifacts, manifests or lockfiles or configuration, and mutable runtime resources',
    'Any uncertainty, coupling, overlapping ownership, or required ordering falls back to one writer',
    'Do not create worktrees automatically',
    '`workItemId`',
    '`waveId`',
    'owned write scope',
    'generated-artifact claims',
    'verification needs',
    'fresh Task invocation',
    'never reuse `task_id`',
    'live claim conflict is a blocked/serialization signal',
    'never rerun the conflicting claim',
    'If Weaver is unavailable',
    'strict packet ownership and changed-path containment',
    'full wave barrier',
    'Cap active Implement children at two',
    'Recalculate DAG readiness after each completion',
    'do not dispatch the next wave until the current wave reaches a clean barrier',
    'do not reset or revert automatically',
    'union of the current wave\'s ownership claims',
    'immutable pre-wave workspace baseline',
    '`baselineIdentity`',
    '`baselineState`',
    '`postWaveIdentity`',
    '`postWaveState`',
    '`currentWaveDelta`',
    'Later waves operate on and are checked against the full combined dirty workspace',
    'ownership containment compares only the current wave\'s delta with the current wave\'s ownership union',
    'not unknown current-wave paths',
    'later edits are blocking',
    'Remediation requires fresh aggregate verification and judgment',
    'explicitly authorized delivery remains serialized',
  ]) {
    if (!orchestrator.includes(requiredText)) fail(`naru-orchestrator missing bounded-writer contract: ${requiredText}`);
  }

  for (const requiredText of [
    'at most two fresh Implement invocations',
    'Do not create a worktree automatically',
    'every required exact owned path or glob claim must be successfully acquired before the first edit',
    'Do not edit after only partial claim acquisition',
    'blocked report with zero edits and zero changed paths',
    'serialized coordinator fallback',
    'never rerun the conflicting claim',
    'If Weaver is unavailable',
    'strict ownership and changed-path containment',
    'Stop and report blocked',
    'Concurrent writers may not commit, push, open or update a PR',
    'shared/repository-wide mutating commands',
    'never reset or revert the combined workspace automatically',
    'Remediation and explicitly authorized delivery use later serialized packets',
  ]) {
    if (!implement.includes(requiredText)) fail(`naru-minion-implement missing concurrent-writer contract: ${requiredText}`);
  }

  for (const requiredText of [
    'every Implement writer is terminal',
    'every implementation report',
    'union of the current wave\'s owned write-scope claims',
    'immutable pre-wave `baselineIdentity` and `baselineState`',
    '`postWaveIdentity` and `postWaveState`',
    '`currentWaveDelta`',
    'Compare only the current-wave delta\'s changed paths',
    'full combined post-wave state',
    'not unknown current-wave paths',
    'stale/mixed evidence as blocking',
    'Any later edit or unexpected worktree change invalidates this verification',
    'full wave barrier',
    '"waveId"',
    '"workItemIds"',
  ]) {
    if (!verify.includes(requiredText)) fail(`naru-minion-verify missing aggregate-wave contract: ${requiredText}`);
  }

  for (const requiredText of [
    'every Implement writer in the wave to be terminal',
    'matching aggregate verification report',
    'immutable pre-wave baseline identity/state',
    'post-wave identity/state',
    'current-wave delta',
    'full integrated post-wave state',
    'comparing ownership only against the current-wave delta',
    'not unknown current-wave files',
    'stale or mixed evidence',
    'later edit or unexpected worktree change as blocking',
    'Remediation is serialized',
    'fresh aggregate verification and re-judgment',
    'Explicitly authorized delivery is serialized',
    'at most three judge passes',
  ]) {
    if (!judge.includes(requiredText)) fail(`naru-minion-judge missing wave-judgment contract: ${requiredText}`);
  }

  for (const role of ['scout', 'investigate', 'architect', 'implement', 'debug', 'verify', 'judge']) {
    const text = await readFile(here(`agents/naru-minion-${role}.md`), 'utf8');
    if (!hasAny(text, ['do not read or reveal secrets'])) fail(`naru-minion-${role} missing secret boundary`);
    if (!hasAny(text, ['environment example templates may be inspected'])) fail(`naru-minion-${role} missing environment-example allowance`);
    if (hasAny(text, ['Build-like capability envelope', 'all seven minions have Build-like'])) fail(`naru-minion-${role} retains obsolete uniform-capability claim`);
  }
  for (const role of ['scout', 'investigate', 'architect', 'judge']) {
    const text = await readFile(here(`agents/naru-minion-${role}.md`), 'utf8');
    for (const requiredText of ['technically read-only', 'edit or create files', 'call Task', 'run shell or project commands']) {
      if (!hasAny(text, [requiredText])) fail(`naru-minion-${role} missing technical read-only boundary: ${requiredText}`);
    }
  }
  for (const role of ['debug', 'verify']) {
    const text = await readFile(here(`agents/naru-minion-${role}.md`), 'utf8');
    for (const requiredText of ['technically read-only', 'cannot implement fixes', 'edit or create files', 'delegate with Task']) {
      if (!hasAny(text, [requiredText])) fail(`naru-minion-${role} missing diagnostic boundary: ${requiredText}`);
    }
  }
  if (!hasAny(implement, ['only minion authorized', 'only minion that edits'])) {
    fail('naru-minion-implement missing sole workflow editor boundary');
  }
  for (const requiredText of ['  edit: allow', '  apply_patch: allow', '  task: deny']) {
    if (!implement.includes(requiredText)) fail(`naru-minion-implement permission boundary changed: ${requiredText.trim()}`);
  }
  for (const role of ['scout', 'investigate', 'architect', 'debug', 'verify', 'judge']) {
    const text = await readFile(here(`agents/naru-minion-${role}.md`), 'utf8');
    if (!text.includes('  edit: deny')) fail(`naru-minion-${role} no longer denies edits`);
    if (text.includes('  task: allow')) fail(`naru-minion-${role} unexpectedly allows Task`);
  }
  for (const target of ['scout', 'investigate', 'architect', 'implement', 'debug', 'verify', 'judge']) {
    if (!orchestrator.includes(`    'naru-minion-${target}': allow`)) {
      fail(`naru-orchestrator Task route changed for naru-minion-${target}`);
    }
  }
  if (orchestrator.includes('  edit: allow') || orchestrator.includes('  apply_patch: allow')) {
    fail('naru-orchestrator unexpectedly gained edit permission');
  }
  for (const role of ['implement', 'debug', 'verify']) {
    const text = await readFile(here(`agents/naru-minion-${role}.md`), 'utf8');
    for (const requiredText of [
      'manifest or Makefile target',
      'inspection is mandatory',
      'execute repository code',
      'hidden side effects',
      'Runtime permissions allow shell commands',
      'external-directory access without an approval prompt',
      'one routine command per shell call',
      'naru-git-read',
      'Git and GitHub reads',
      'Weaver',
      'lint',
      'typecheck',
      'targeted tests',
      'ordinary local builds',
      'without another approval question',
    ]) {
      if (!hasAny(text, [requiredText])) fail(`naru-minion-${role} missing routine shell contract: ${requiredText}`);
    }
    if (!hasAny(text, ['database writes', 'database migrations'])) {
      fail(`naru-minion-${role} missing behavioral database boundary`);
    }
  }
  for (const requiredText of [
    'explicit implementation request authorizes delegation',
    'scoped local edits',
    'targeted routine verification',
    'ordinary Git or GitHub reads',
    'Weaver coordination',
    'without approval',
    'Local changes are the default stopping point',
    'user explicitly requested that delivery action',
    'do not reconfirm it',
    'do not perform unrequested delivery',
    'one user checkpoint',
    'persistent database writes or migration execution',
    'dependency changes not already explicitly requested',
    'material scope expansion',
    'exact path',
    'user approved that specific path',
  ]) {
    if (!hasAny(orchestrator, [requiredText])) fail(`naru-orchestrator missing autonomous workflow boundary: ${requiredText}`);
  }
  if (!hasAny(orchestrator, ['may be delegated directly without approval'])) {
    fail('naru-orchestrator does not permit direct routine-check delegation');
  }
  for (const requiredText of ['Only `naru-minion-implement` has technical edit permission', 'technically read-only roles', 'do not edit files']) {
    if (!hasAny(orchestrator, [requiredText])) fail(`naru-orchestrator missing technical role boundary: ${requiredText}`);
  }
  for (const requiredText of ['execute repository code', 'hidden side effects', 'manifest or Makefile target', 'allow shell commands and external-directory access without prompting', 'one routine command per shell call']) {
    if (!hasAny(orchestrator, [requiredText])) fail(`naru-orchestrator missing execution-risk contract: ${requiredText}`);
  }
  if (!hasAny(orchestrator, ['generated `Naru Delegate Routing` appendix is authoritative', 'Sol xhigh eligibility'])) {
    fail('naru-orchestrator missing generated xhigh appendix authority');
  }

  for (const requiredText of [
    'explicit implementation request',
    'scoped local edits',
    'targeted routine verification',
    'without another approval question',
    'Local changes are the default stopping point',
    'user explicitly requested that delivery action',
    'do not ask for confirmation again',
    'Do not perform unrequested delivery',
    'exact external global configuration path',
    'user approved specifically',
    'destructive or irreversible operations',
    'persistent databases',
    'billing or security posture',
    'Materially expand scope',
  ]) {
    if (!hasAny(implement, [requiredText])) fail(`naru-minion-implement missing autonomous implementation boundary: ${requiredText}`);
  }

  for (const command of ['plan', 'impact', 'triage', 'review']) {
    const text = await readFile(here(`commands/naru-${command}.md`), 'utf8');
    for (const requiredText of ['$ARGUMENTS', 'If empty, show:', `Use \`naru-${command}\` as the source of truth`]) {
      if (!text.includes(requiredText)) fail(`naru-${command} command wrapper missing compact contract: ${requiredText}`);
    }
    if (text.includes('Read-only. Do not edit files') || text.includes('Run a multi-agent')) {
      fail(`naru-${command} command wrapper duplicates agent policy`);
    }
  }
  const reviewCommand = await readFile(here('commands/naru-review.md'), 'utf8');
  for (const requiredText of ['dry-run only', 'never posts to GitHub', 'Reject `--post`', '/naru-review-post']) {
    if (!reviewCommand.includes(requiredText)) fail(`naru-review command wrapper missing dry-run/post boundary: ${requiredText}`);
  }

  const userGuide = await readFile(here('docs/user-guide.md'), 'utf8');
  for (const requiredText of ['execute repository code', 'hidden side effects', 'mandatory', 'external_directory` is explicitly `allow', 'unconditionally allowed at runtime', 'Git, Weaver, Python', 'one routine command per shell call', 'intentionally permissive, not a sandbox', 'PATH']) {
    if (!hasAny(userGuide, [requiredText])) fail(`user guide missing shell-policy limitation: ${requiredText}`);
  }
  for (const [name, text] of [
    ['development guide', await readFile(here('docs/development.md'), 'utf8')],
    ['user guide', userGuide],
  ]) {
    if (!/(?:environment(?:-file)?|env|secret)[^.\n]{0,120}\bden(?:y|ied)\b|\bden(?:y|ied)\b[^.\n]{0,120}(?:environment(?:-file)?|env|secret)/i.test(text)) {
      fail(`${name} must document denied minion environment/secret reads`);
    }
    const sentences = text.split(/[.\n]/);
    if (!sentences.some((sentence) => (
      /\b(?:environment(?:-file)?|env)\b/i.test(sentence) &&
      /\b(?:templates?|examples?)\b/i.test(sentence) &&
      /\b(?:allow(?:ed|ance)?|inspect(?:ed|ion)?)\b/i.test(sentence)
    ))) {
      fail(`${name} must document allowed environment templates`);
    }
    if (/(?:\b(?:environment(?:-file)?|env(?:ironment)?|secret)\b[^.\n]{0,120}\b(?:ask|prompt(?:ed|ing)?|auto(?:-| )?approv(?:e|ed|al))\b|\b(?:ask|auto(?:-| )?approv(?:e|ed|al)|prompt(?:ed|ing)?\s+(?:for|to|before|when|on))\b[^.\n]{0,120}\b(?:environment(?:-file)?|env(?:ironment)?|secret)\b)/i.test(text)) {
      fail(`${name} describes minion environment/secret reads as ask, prompt, or auto-approved`);
    }
  }

  const readme = await readFile(here('README.md'), 'utf8');
  for (const doc of ['user-guide.md', 'agent-integration.md', 'development.md']) {
    if (!readme.includes(`](docs/${doc})`)) fail(`README missing direct link to docs/${doc}`);
  }
  for (const command of ['naru-plan', 'naru-impact', 'naru-triage', 'naru-review', 'naru-review-post', 'naru-minions']) {
    if (!readme.includes(`/${command}`)) fail(`README missing public command /${command}`);
  }

  const integration = await readFile(here('docs/agent-integration.md'), 'utf8');
  const exactTaskFragment = `permission:
  task:
    '*': deny
    'naru-plan': allow
    'naru-impact': allow
    'naru-triage': allow
    'naru-review': allow`;
  if (!integration.includes(exactTaskFragment)) fail('agent integration guide missing exact fail-closed Task allowlist');
  for (const forbiddenAllow of [
    "'naru-review-post': allow",
    "'naru-minion-*': allow",
    "'naru-delegate-luna-*': allow",
    "'naru-delegate-sol-*': allow",
    "'naru-delegate-deep-*': allow",
    "'naru-orchestrator': allow",
  ]) {
    if (integration.includes(forbiddenAllow)) fail(`agent integration guide grants forbidden Task target: ${forbiddenAllow}`);
  }
  for (const requiredText of [
    'hidden is not authorization',
    'naru-review-post',
    'naru-minion-*',
    'specialist',
    'judges',
    'naru-delegate-luna-*',
    'naru-delegate-sol-*',
    'one fresh Task',
    'task_id',
    'advisory',
    'default_agent',
    'opencode --agent naru-orchestrator',
  ]) {
    if (!hasAny(integration, [requiredText])) fail(`agent integration guide missing contract: ${requiredText}`);
  }

  for (const role of ['scout', 'investigate', 'architect', 'implement', 'debug', 'verify', 'judge']) {
    const text = await readFile(here(`agents/naru-minion-${role}.md`), 'utf8');
    if (!text.includes(`"agent": "naru-minion-${role}"`)) {
      fail(`naru-minion-${role} missing structured report identity`);
    }
  }

  const routing = await readFile(here('tools/naru-lib/model-routing.mjs'), 'utf8');
  for (const requiredText of [
    'Never downgrade a Sol-floor role',
    'Do not use fixed role-to-model mappings',
    'keyword-only classification',
    'cheapest-first routing',
    'mandatory Luna-to-Terra-to-Sol sequence',
    'Do not use `task_id` for Naru-routed roles',
    'Naru Delegate adds no fallback or retry layer',
  ]) {
    if (!routing.includes(requiredText)) fail(`Naru Delegate routing prompt missing: ${requiredText}`);
  }

  if (failures) {
    console.error(`\n${failures} failure(s)`);
    process.exit(1);
  }
  console.log('OK prompt-contracts');
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
