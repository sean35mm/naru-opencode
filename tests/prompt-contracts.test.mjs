import { readFile, stat } from 'node:fs/promises';
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
    'plugins/naru-delegate.js',
    'tools/naru-lib/model-routing.mjs',
  ];
  const missing = [];
  for (const p of required) {
    if (!(await exists(p))) missing.push(p);
  }
  if (missing.length) fail(`missing required prompt files: ${missing.join(', ')}`);

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
    if (!text.includes(`"agent": "naru-minion-${role}"`)) {
      fail(`naru-minion-${role} missing structured report identity`);
    }
  }

  const routing = await readFile(here('tools/naru-lib/model-routing.mjs'), 'utf8');
  for (const requiredText of [
    'Never downgrade a Deep-floor role',
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
