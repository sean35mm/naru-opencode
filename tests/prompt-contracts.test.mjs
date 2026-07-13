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

  // Core orchestrators: retry/status/partial/incomplete handling and injection guards.
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
    const judge = await readFile(here(`agents/naru-${wf}-judge.md`), 'utf8');
    if (!judge.includes('## Workflow Status')) fail(`naru-${wf}-judge missing Workflow Status contract`);
  }

  // Review: strict payload/snapshot, nullable location, prior status.
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

  // Review-post boundary: COMMENT-only, idempotency/snapshot.
  const post = await readFile(here('agents/naru-review-post.md'), 'utf8');
  if (!hasAny(post, ['COMMENT', 'comment-only'])) {
    fail('naru-review-post missing COMMENT-only boundary');
  }
  if (!hasAny(post, ['boundary', 'dry run', 'dry-run', 'snapshot', 'idempot'])) {
    fail('naru-review-post missing post boundary language');
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

  for (const role of ['scout', 'investigate', 'architect', 'implement', 'debug', 'verify', 'judge']) {
    const text = await readFile(here(`agents/naru-minion-${role}.md`), 'utf8');
    for (const requiredText of [
      'Build-like capability envelope',
      'workflow responsibility',
      'do not read or reveal secrets',
      'approval prompt is not authorization',
    ]) {
      if (!hasAny(text, [requiredText])) fail(`naru-minion-${role} missing capability/responsibility contract: ${requiredText}`);
    }
  }
  for (const role of ['scout', 'investigate', 'architect', 'judge']) {
    const text = await readFile(here(`agents/naru-minion-${role}.md`), 'utf8');
    for (const requiredText of ['do not edit or create files', 'call Task', 'run shell or project commands']) {
      if (!hasAny(text, [requiredText])) fail(`naru-minion-${role} missing behavioral read-only boundary: ${requiredText}`);
    }
  }
  for (const role of ['debug', 'verify']) {
    const text = await readFile(here(`agents/naru-minion-${role}.md`), 'utf8');
    for (const requiredText of ['behaviorally read-only', 'do not implement fixes', 'edit or create files', 'delegate with Task']) {
      if (!hasAny(text, [requiredText])) fail(`naru-minion-${role} missing diagnostic boundary: ${requiredText}`);
    }
  }
  if (!hasAny(implement, ['only minion authorized', 'only minion that edits'])) {
    fail('naru-minion-implement missing sole workflow editor boundary');
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
    ]) {
      if (!hasAny(text, [requiredText])) fail(`naru-minion-${role} missing Build-like shell contract: ${requiredText}`);
    }
    if (!hasAny(text, ['database writes', 'database migrations'])) {
      fail(`naru-minion-${role} missing behavioral database boundary`);
    }
  }
  for (const requiredText of ['exact authorized command scope', 'explicit user approval', 'Git mutations', 'database writes']) {
    if (!hasAny(orchestrator, [requiredText])) fail(`naru-orchestrator missing command authorization contract: ${requiredText}`);
  }
  if (!hasAny(orchestrator, ['routine test', 'may be delegated directly'])) {
    fail('naru-orchestrator does not permit direct routine-check delegation');
  }
  for (const requiredText of ['Build-like runtime capabilities', 'capability is not workflow responsibility', 'only role authorized', 'behaviorally read-only']) {
    if (!hasAny(orchestrator, [requiredText])) fail(`naru-orchestrator missing capability/responsibility contract: ${requiredText}`);
  }
  for (const requiredText of ['execute repository code', 'hidden side effects', 'manifest or Makefile target', 'allow shell commands and external-directory access without prompting', 'exact authorized command scope', 'one routine command per shell call']) {
    if (!hasAny(orchestrator, [requiredText])) fail(`naru-orchestrator missing execution-risk contract: ${requiredText}`);
  }

  const userGuide = await readFile(here('docs/user-guide.md'), 'utf8');
  for (const requiredText of ['execute repository code', 'hidden side effects', 'mandatory', 'external_directory` is explicitly `allow', 'unconditionally allowed at runtime', 'Git, Weaver, Python', 'one routine command per shell call', 'intentionally permissive, not a sandbox', 'PATH']) {
    if (!hasAny(userGuide, [requiredText])) fail(`user guide missing shell-policy limitation: ${requiredText}`);
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
