import { readdir, readFile, stat } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  DEEP_FLOOR_ROLES,
  DEFAULT_MODEL_PROFILES,
  NARU_AGENT_IDS,
  NARU_DISPATCH_GRAPH,
} from '../tools/naru-lib/model-routing.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const here = p => join(root, p);

const expectedCommands = [
  'commands/naru-plan.md',
  'commands/naru-impact.md',
  'commands/naru-triage.md',
  'commands/naru-review.md',
  'commands/naru-review-post.md',
];

const expectedAgents = [
  // plan: 1 orchestrator + 5 flattened specialists
  'agents/naru-plan.md',
  'agents/naru-plan-architecture.md',
  'agents/naru-plan-minimal-change.md',
  'agents/naru-plan-risk.md',
  'agents/naru-plan-tests.md',
  'agents/naru-plan-judge.md',
  // impact: 1 orchestrator + 6 flattened specialists
  'agents/naru-impact.md',
  'agents/naru-impact-topology.md',
  'agents/naru-impact-contracts.md',
  'agents/naru-impact-data.md',
  'agents/naru-impact-frontend-mobile.md',
  'agents/naru-impact-tests-ci.md',
  'agents/naru-impact-judge.md',
  // triage: 1 orchestrator + 5 flattened specialists
  'agents/naru-triage.md',
  'agents/naru-triage-reproduction.md',
  'agents/naru-triage-codepath.md',
  'agents/naru-triage-regression.md',
  'agents/naru-triage-tests.md',
  'agents/naru-triage-judge.md',
  // review: 1 orchestrator + 6 flattened specialists
  'agents/naru-review.md',
  'agents/naru-review-security.md',
  'agents/naru-review-backend.md',
  'agents/naru-review-frontend-mobile.md',
  'agents/naru-review-integrations.md',
  'agents/naru-review-tests-ci.md',
  'agents/naru-review-judge.md',
  // provider-neutral orchestrator + minions + explicit post agent
  'agents/naru-review-post.md',
  'agents/naru-orchestrator.md',
  'agents/naru-minion-scout.md',
  'agents/naru-minion-investigate.md',
  'agents/naru-minion-architect.md',
  'agents/naru-minion-implement.md',
  'agents/naru-minion-debug.md',
  'agents/naru-minion-verify.md',
  'agents/naru-minion-judge.md',
];

const coreAgents = expectedAgents.filter(
  p =>
    p.startsWith('agents/naru-') &&
    !p.startsWith('agents/naru-review-post.md') &&
    !p.startsWith('agents/naru-orchestrator.md') &&
    !p.startsWith('agents/naru-minion-')
);

async function exists(p) {
  try {
    await stat(here(p));
    return true;
  } catch {
    return false;
  }
}

function readFrontmatter(text) {
  const m = text.match(/^---\n([\s\S]*?)\n---/);
  if (!m) return null;
  const fm = {};
  for (const line of m[1].split('\n')) {
    const idx = line.indexOf(':');
    if (idx <= 0) continue;
    const key = line.slice(0, idx).trim();
    const val = line.slice(idx + 1).trim();
    fm[key] = val;
  }
  return fm;
}

function parsePermissions(text) {
  const m = text.match(/^permission:\n([\s\S]*?)(?=^\w+:|^---|$)/m);
  if (!m) return null;
  const perms = [];
  for (const line of m[1].split('\n')) {
    if (!line.startsWith('  ') || line.startsWith('   ')) continue;
    const trimmed = line.slice(2).trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const idx = trimmed.indexOf(':');
    if (idx <= 0) continue;
    const key = trimmed.slice(0, idx).trim().replace(/^['"]|['"]$/g, '');
    const val = trimmed.slice(idx + 1).trim();
    perms.push({ key, val });
  }
  return perms;
}

async function collectAgents() {
  const entries = await readdir(here('agents'), { withFileTypes: true });
  return entries
    .filter(e => e.isFile() && e.name.endsWith('.md'))
    .map(e => `agents/${e.name}`);
}

async function collectMarkdownRecursive(relative) {
  if (!(await exists(relative))) return [];
  const entries = await readdir(here(relative), { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const child = `${relative}/${entry.name}`;
    if (entry.isDirectory()) files.push(...await collectMarkdownRecursive(child));
    else if (entry.isFile() && entry.name.endsWith('.md')) files.push(child);
  }
  return files;
}

let failures = 0;
function fail(msg) {
  console.error(`FAIL: ${msg}`);
  failures += 1;
}

async function main() {
  const allExpected = [...expectedCommands, ...expectedAgents];
  const missing = [];
  for (const p of allExpected) {
    if (!(await exists(p))) missing.push(p);
  }
  if (missing.length) fail(`missing expected files: ${missing.join(', ')}`);

  // Exact 5-command inventory.
  const actualCommandFiles = (await readdir(here('commands')))
    .filter(f => f.endsWith('.md'))
    .sort();
  const expectedCommandFiles = expectedCommands.map(p => p.split('/')[1]).sort();
  if (JSON.stringify(actualCommandFiles) !== JSON.stringify(expectedCommandFiles)) {
    fail(
      `command inventory mismatch: got ${JSON.stringify(actualCommandFiles)} expected ${JSON.stringify(expectedCommandFiles)}`
    );
  }

  // Exact 35-agent inventory.
  const actualAgents = (await collectAgents()).sort();
  const expectedAgentsSorted = [...expectedAgents].sort();
  if (JSON.stringify(actualAgents) !== JSON.stringify(expectedAgentsSorted)) {
    fail(
      `agent inventory mismatch: got ${JSON.stringify(actualAgents)} expected ${JSON.stringify(expectedAgentsSorted)}`
    );
  }
  const expectedAgentIDs = expectedAgents.map(p => p.slice('agents/'.length, -'.md'.length)).sort();
  if (JSON.stringify([...NARU_AGENT_IDS].sort()) !== JSON.stringify(expectedAgentIDs)) {
    fail('central model-routing inventory does not match the 35 agent files');
  }
  if (DEEP_FLOOR_ROLES.length !== 13) fail(`unexpected Deep-floor role count: ${DEEP_FLOOR_ROLES.length}`);
  if (DEFAULT_MODEL_PROFILES.fast.model !== 'openai/gpt-5.6-terra-fast') fail('Fast profile is not Terra Fast');
  if (DEFAULT_MODEL_PROFILES.deep.model !== 'openai/gpt-5.6-sol-fast') fail('Deep profile is not Sol Fast');
  if (DEFAULT_MODEL_PROFILES.fast.variant !== 'high' || DEFAULT_MODEL_PROFILES.deep.variant !== 'high') {
    fail('Fast and Deep profiles must use variant high');
  }

  // No old nested Markdown under commands/naru or agents/naru.
  if (await exists('commands/naru')) {
    const nested = await collectMarkdownRecursive('commands/naru');
    if (nested.length) fail(`old nested commands found: ${nested.join(', ')}`);
  }
  if (await exists('agents/naru')) {
    const nested = await collectMarkdownRecursive('agents/naru');
    if (nested.length) fail(`old nested agents found: ${nested.join(', ')}`);
  }

  // No old naru/ IDs or references remain in command/agent definitions.
  for (const p of [...expectedCommands, ...expectedAgents]) {
    const text = await readFile(here(p), 'utf8');
    if (text.includes('naru/')) fail(`${p} contains an old nested naru/ reference`);
  }

  // Every agent permission block begins with a top-level wildcard deny.
  for (const p of expectedAgents) {
    const text = await readFile(here(p), 'utf8');
    const perms = parsePermissions(text);
    if (!perms) {
      fail(`${p} has no parseable permission block`);
      continue;
    }
    const first = perms[0];
    if (!first || first.key !== '*' || first.val !== 'deny') {
      fail(`${p} first permission is not '*': deny (${JSON.stringify(first)})`);
    }
  }

  // All Core agents are hidden.
  for (const p of coreAgents) {
    const text = await readFile(here(p), 'utf8');
    const fm = readFrontmatter(text);
    if (!fm || fm.hidden !== 'true') fail(`${p} is not hidden: true`);
  }
  for (const p of expectedAgents.filter(p => p.includes('naru-minion-') || p === 'agents/naru-review-post.md')) {
    const fm = readFrontmatter(await readFile(here(p), 'utf8'));
    if (!fm || fm.hidden !== 'true') fail(`${p} is not hidden: true`);
  }

  // Only the implementation minion has the intentional model/variant pin.
  for (const p of [...expectedCommands, ...expectedAgents]) {
    const text = await readFile(here(p), 'utf8');
    const fm = readFrontmatter(text);
    if (p === 'agents/naru-minion-implement.md') {
      if (fm?.model !== 'openai/gpt-5.6-terra-fast') fail(`${p} has unexpected model: ${fm?.model}`);
      if (fm?.variant !== 'high') fail(`${p} has unexpected variant: ${fm?.variant}`);
    } else {
      if (fm?.model) fail(`${p} pins model: ${fm.model}`);
      if (fm?.variant) fail(`${p} pins variant: ${fm.variant}`);
    }
  }

  // No direct gh/git bash strings in agents (validated tools are used instead).
  for (const p of expectedAgents) {
    const text = await readFile(here(p), 'utf8');
    const bad = [];
    for (const line of text.split('\n')) {
      if (/^\s*[-*]?\s*`(gh|git)\s/.test(line)) bad.push(line.trim());
      if (/bash:\s*(gh|git)\s/.test(line)) bad.push(line.trim());
    }
    if (bad.length) fail(`${p} has direct gh/git bash strings: ${bad.slice(0, 3).join('; ')}`);
  }

  // Exact task allowlist references resolve to known agents.
  for (const p of expectedAgents) {
    const text = await readFile(here(p), 'utf8');
    const refs = [...text.matchAll(/^    '(naru-[\w-]+)': allow$/gm)].map(m => m[1]);
    for (const ref of refs) {
      const asFile = `agents/${ref}.md`;
      const asDir = `agents/${ref}`;
      const known =
        expectedAgents.includes(asFile) ||
        expectedAgents.some(a => a.startsWith(`${asDir}/`));
      if (!known) fail(`${p} references unresolved agent ${ref}`);
    }
    const agentID = p.slice('agents/'.length, -'.md'.length);
    if (NARU_DISPATCH_GRAPH[agentID]) {
      const actual = refs.sort();
      const expected = [...NARU_DISPATCH_GRAPH[agentID]].sort();
      if (JSON.stringify(actual) !== JSON.stringify(expected)) {
        fail(`${p} Task allowlist differs from central dispatch graph`);
      }
    } else if (refs.length) {
      fail(`${p} has Task routes missing from the central dispatch graph`);
    }
  }

  // Only review-post mentions the post tool permission.
  const postTool = 'naru-github-post-review';
  for (const p of expectedAgents) {
    const text = await readFile(here(p), 'utf8');
    if (p === 'agents/naru-review-post.md') {
      if (!text.includes(postTool)) fail(`${p} should reference ${postTool}`);
    } else if (text.includes(postTool)) {
      fail(`${p} should not reference ${postTool}`);
    }
  }

  for (const p of expectedAgents.filter(p => /^agents\/naru-review(?:-|\.md)/.test(p) && p !== 'agents/naru-review-post.md')) {
    const text = await readFile(here(p), 'utf8');
    for (const required of ['read: deny', 'glob: deny', 'grep: deny', 'lsp: deny', 'naru-git-read: deny', 'naru-github-read: allow']) {
      if (!text.includes(required)) fail(`${p} missing immutable-review permission: ${required}`);
    }
    if (text.includes('codebase-memory-mcp_')) fail(`${p} may inspect a mutable local graph`);
  }

  for (const p of expectedAgents.filter(p => !/^agents\/naru-review(?:-|\.md)/.test(p))) {
    const text = await readFile(here(p), 'utf8');
    if (text.includes('read:\n')) {
      for (const denied of ["'*.pem': deny", "'*.key': deny", "'**/.ssh/**': deny", "'**/credentials/**': deny"]) {
        if (!text.includes(denied)) fail(`${p} missing direct-read secret denial: ${denied}`);
      }
    }
  }

  // Personal/local-only paths and integrations are absent.
  const forbidden = [
    '/Users/',
    '.config/opencode',
    'weaver',
    'herdr',
  ];
  for (const p of [...expectedCommands, ...expectedAgents]) {
    const text = (await readFile(here(p), 'utf8')).toLowerCase();
    for (const f of forbidden) {
      if (text.includes(f.toLowerCase())) fail(`${p} mentions forbidden ${f}`);
    }
  }

  // Docs command parity.
  const readme = await readFile(here('README.md'), 'utf8');
  for (const cmd of ['plan', 'impact', 'triage', 'review', 'review-post']) {
    if (!readme.includes(`/naru-${cmd}`)) fail(`README.md missing /naru-${cmd}`);
  }
  if (!readme.includes('/naru-minions')) fail('README.md missing /naru-minions');

  const dashboard = await readFile(here('plugins/naru-minions-dashboard.js'), 'utf8');
  if (!dashboard.includes('slashName: "naru-minions"')) fail('dashboard does not register /naru-minions');
  if (!dashboard.includes('export default plugin')) fail('dashboard is not an OpenCode ESM plugin');

  const delegate = await readFile(here('plugins/naru-delegate.js'), 'utf8');
  if (!delegate.includes('export const NaruDelegatePlugin')) fail('Naru Delegate is not a server plugin');
  if (!delegate.includes("'tool.execute.before'")) fail('Naru Delegate does not guard routed Task resume');
  if (delegate.includes('session.create') || delegate.includes('session.prompt')) {
    fail('Naru Delegate bypasses native Task child-session handling');
  }

  for (const tool of ['naru-git-read.js', 'naru-github-read.js', 'naru-github-post-review.js']) {
    const text = await readFile(here(`tools/${tool}`), 'utf8');
    if (text.includes('Bun.$') || text.includes('shell: true')) fail(`${tool} exposes a shell execution surface`);
    if (!text.includes('JSON.stringify')) fail(`${tool} does not return text to OpenCode`);
  }

  if (failures) {
    console.error(`\n${failures} failure(s)`);
    process.exit(1);
  }
  console.log('OK config-policy');
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
