import { readdir, readFile, stat } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  DEFAULT_AGENT_ASSIGNMENTS,
  DEFAULT_MODEL_PROFILES,
  LUNA_ELIGIBLE_ROLES,
  NARU_AGENT_IDS,
  NARU_DELEGATE_PROTOCOL,
  NARU_DISPATCH_GRAPH,
  SOL_FLOOR_ROLES,
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
  'agents/naru-plan.md',
  'agents/naru-plan-architecture.md',
  'agents/naru-plan-minimal-change.md',
  'agents/naru-plan-risk.md',
  'agents/naru-plan-tests.md',
  'agents/naru-plan-judge.md',
  'agents/naru-impact.md',
  'agents/naru-impact-topology.md',
  'agents/naru-impact-contracts.md',
  'agents/naru-impact-data.md',
  'agents/naru-impact-frontend-mobile.md',
  'agents/naru-impact-tests-ci.md',
  'agents/naru-impact-judge.md',
  'agents/naru-triage.md',
  'agents/naru-triage-reproduction.md',
  'agents/naru-triage-codepath.md',
  'agents/naru-triage-regression.md',
  'agents/naru-triage-tests.md',
  'agents/naru-triage-judge.md',
  'agents/naru-review.md',
  'agents/naru-review-security.md',
  'agents/naru-review-backend.md',
  'agents/naru-review-frontend-mobile.md',
  'agents/naru-review-integrations.md',
  'agents/naru-review-tests-ci.md',
  'agents/naru-review-judge.md',
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

const expectedRuntimeFiles = [
  'naru-runtime.example.json',
  'plugins/naru-scheduler.js',
  'scripts/naru-live-eval.mjs',
  'tests/fixtures/live-evals.json',
  'tools/naru-scheduler.js',
  'tools/naru-lib/evaluation.mjs',
  'tools/naru-lib/scheduler-config.mjs',
  'tools/naru-lib/scheduler-journal.mjs',
  'tools/naru-lib/scheduler-protocol.mjs',
  'tools/naru-lib/scheduler-state.mjs',
  'tools/naru-lib/scheduler-telemetry.mjs',
  'tools/naru-lib/scheduler-token.mjs',
];

const minionRoles = ['scout', 'investigate', 'architect', 'implement', 'debug', 'verify', 'judge'];
const minionPaths = minionRoles.map(role => `agents/naru-minion-${role}.md`);
const coreAgents = expectedAgents.filter(
  p =>
    p.startsWith('agents/naru-') &&
    p !== 'agents/naru-review-post.md' &&
    p !== 'agents/naru-orchestrator.md' &&
    !p.startsWith('agents/naru-minion-')
);

const readToolPermissions = [
  'glob',
  'grep',
  'lsp',
  'naru-git-read',
  'naru-github-read',
  'codebase-memory-mcp_list_projects',
  'codebase-memory-mcp_index_status',
  'codebase-memory-mcp_get_graph_schema',
  'codebase-memory-mcp_search_graph',
  'codebase-memory-mcp_trace_path',
  'codebase-memory-mcp_get_code_snippet',
  'codebase-memory-mcp_get_architecture',
  'codebase-memory-mcp_detect_changes',
  'codebase-memory-mcp_search_code',
  'codebase-memory-mcp_query_graph',
].map(key => ({ key, val: 'allow' }));

const readOnlyMinionPermissions = [
  { key: '*', val: 'deny' },
  { key: 'edit', val: 'deny' },
  { key: 'apply_patch', val: 'deny' },
  { key: 'task', val: 'deny' },
  { key: 'question', val: 'deny' },
  { key: 'bash', val: 'deny' },
  { key: 'external_directory', val: 'deny' },
  ...readToolPermissions,
  { key: 'read', val: '' },
];

const shellReadOnlyMinionPermissions = [
  { key: '*', val: 'deny' },
  { key: 'edit', val: 'deny' },
  { key: 'apply_patch', val: 'deny' },
  { key: 'task', val: 'deny' },
  { key: 'question', val: 'deny' },
  { key: 'doom_loop', val: 'ask' },
  { key: 'external_directory', val: 'allow' },
  ...readToolPermissions,
  { key: 'read', val: '' },
  { key: 'bash', val: '' },
];

const implementMinionPermissions = [
  { key: '*', val: 'deny' },
  { key: 'edit', val: 'allow' },
  { key: 'apply_patch', val: 'allow' },
  { key: 'task', val: 'deny' },
  { key: 'question', val: 'deny' },
  { key: 'doom_loop', val: 'ask' },
  { key: 'external_directory', val: 'allow' },
  ...readToolPermissions,
  { key: 'read', val: '' },
  { key: 'bash', val: '' },
];

const minionPermissionClasses = {
  scout: readOnlyMinionPermissions,
  investigate: readOnlyMinionPermissions,
  architect: readOnlyMinionPermissions,
  judge: readOnlyMinionPermissions,
  debug: shellReadOnlyMinionPermissions,
  verify: shellReadOnlyMinionPermissions,
  implement: implementMinionPermissions,
};

const expectedReadRules = [
  { pattern: '*', action: 'allow' },
  { pattern: '.git/**', action: 'deny' },
  { pattern: '.env', action: 'deny' },
  { pattern: '.env.*', action: 'deny' },
  { pattern: '*.env', action: 'deny' },
  { pattern: '*.env.*', action: 'deny' },
  { pattern: '*.pem', action: 'deny' },
  { pattern: '*.key', action: 'deny' },
  { pattern: '*.p12', action: 'deny' },
  { pattern: '*.pfx', action: 'deny' },
  { pattern: '**/id_rsa', action: 'deny' },
  { pattern: '**/id_dsa', action: 'deny' },
  { pattern: '**/id_ecdsa', action: 'deny' },
  { pattern: '**/id_ed25519', action: 'deny' },
  { pattern: '**/.ssh/**', action: 'deny' },
  { pattern: '**/.aws/**', action: 'deny' },
  { pattern: '**/.kube/**', action: 'deny' },
  { pattern: '**/.gnupg/**', action: 'deny' },
  { pattern: '**/credentials/**', action: 'deny' },
  { pattern: '**/secrets/**', action: 'deny' },
  { pattern: '*.env.example', action: 'allow' },
  { pattern: 'env.example', action: 'allow' },
];

const expectedBashRules = [
  ['*', 'allow'],
].map(([pattern, action]) => ({ pattern, action }));

async function exists(p) {
  try {
    await stat(here(p));
    return true;
  } catch {
    return false;
  }
}

function readFrontmatter(text) {
  const match = text.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return null;
  const frontmatter = {};
  for (const line of match[1].split('\n')) {
    const index = line.indexOf(':');
    if (index <= 0) continue;
    frontmatter[line.slice(0, index).trim()] = line.slice(index + 1).trim();
  }
  return frontmatter;
}

function parsePermissions(text) {
  const frontmatter = text.match(/^---\n([\s\S]*?)\n---/)?.[1];
  if (!frontmatter) return null;
  const lines = frontmatter.split('\n');
  const start = lines.findIndex(line => line === 'permission:');
  if (start < 0) return null;
  const permissions = [];
  for (const line of lines.slice(start + 1)) {
    if (!line.startsWith(' ')) break;
    if (!line.startsWith('  ') || line.startsWith('   ')) continue;
    const trimmed = line.slice(2).trim();
    const index = trimmed.indexOf(':');
    if (index <= 0) continue;
    permissions.push({
      key: trimmed.slice(0, index).trim().replace(/^['"]|['"]$/g, ''),
      val: trimmed.slice(index + 1).trim(),
    });
  }
  return permissions;
}

function parseNestedPermission(text, name) {
  const frontmatter = text.match(/^---\n([\s\S]*?)\n---/)?.[1];
  if (!frontmatter) return null;
  const lines = frontmatter.split('\n');
  const start = lines.findIndex(line => line === `  ${name}:`);
  if (start < 0) return null;
  const rules = [];
  for (const line of lines.slice(start + 1)) {
    if (!line.startsWith('    ')) break;
    const match = line.match(/^    (?:'([^']*)'|"([^"]*)"|([^:]+)):\s*(allow|ask|deny)$/);
    if (match) rules.push({ pattern: match[1] ?? match[2] ?? match[3].trim(), action: match[4] });
  }
  return rules;
}

function wildcardSource(pattern) {
  return pattern
    .split('*')
    .map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*');
}

function evaluateRule(rules, value) {
  let result;
  for (const { pattern, action } of rules) {
    if (new RegExp(`^${wildcardSource(pattern)}$`).test(value)) result = action;
  }
  return result;
}

async function collectMarkdown(relative) {
  if (!(await exists(relative))) return [];
  const entries = await readdir(here(relative), { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const child = `${relative}/${entry.name}`;
    if (entry.isDirectory()) files.push(...await collectMarkdown(child));
    else if (entry.isFile() && entry.name.endsWith('.md')) files.push(child);
  }
  return files;
}

let failures = 0;
function fail(message) {
  console.error(`FAIL: ${message}`);
  failures += 1;
}

async function main() {
  for (const path of [...expectedCommands, ...expectedAgents, ...expectedRuntimeFiles]) {
    if (!(await exists(path))) fail(`missing expected file: ${path}`);
  }

  const reviewPostCommand = readFrontmatter(await readFile(here('commands/naru-review-post.md'), 'utf8'));
  if (reviewPostCommand?.agent !== 'naru-review-post') fail('review-post command wrapper agent changed');
  if (reviewPostCommand?.subtask !== 'false') fail('review-post command must execute as a root command');

  const actualCommands = (await readdir(here('commands'))).filter(name => name.endsWith('.md')).sort();
  const expectedCommandNames = expectedCommands.map(path => path.split('/')[1]).sort();
  if (JSON.stringify(actualCommands) !== JSON.stringify(expectedCommandNames)) fail('command inventory mismatch');

  const actualAgents = (await readdir(here('agents'))).filter(name => name.endsWith('.md')).map(name => `agents/${name}`).sort();
  if (JSON.stringify(actualAgents) !== JSON.stringify([...expectedAgents].sort())) fail('agent inventory mismatch');
  const expectedIDs = expectedAgents.map(path => path.slice(7, -3)).sort();
  if (JSON.stringify([...NARU_AGENT_IDS].sort()) !== JSON.stringify(expectedIDs)) fail('routing inventory mismatch');

  if (NARU_DELEGATE_PROTOCOL !== 2) fail('unexpected Naru Delegate protocol');
  if (SOL_FLOOR_ROLES.length !== 13) fail('unexpected Sol-floor role count');
  if (SOL_FLOOR_ROLES.includes('naru-orchestrator')) fail('orchestrator must not be a Sol floor');
  if (DEFAULT_AGENT_ASSIGNMENTS['naru-orchestrator'] !== 'sol') fail('orchestrator must default to Sol');
  if (LUNA_ELIGIBLE_ROLES.length !== 5) fail('unexpected Luna-eligible role count');
  for (const role of LUNA_ELIGIBLE_ROLES) {
    if (!role.startsWith('naru-minion-')) fail(`non-minion Luna route: ${role}`);
    if (SOL_FLOOR_ROLES.includes(role)) fail(`Sol-floor role is Luna eligible: ${role}`);
  }
  if (DEFAULT_MODEL_PROFILES.luna.model !== 'openai/gpt-5.6-luna-fast') fail('Luna profile mismatch');
  if (DEFAULT_MODEL_PROFILES.terra.model !== 'openai/gpt-5.6-terra-fast') fail('Terra profile mismatch');
  if (DEFAULT_MODEL_PROFILES.sol.model !== 'openai/gpt-5.6-sol-fast') fail('Sol profile mismatch');
  if (Object.values(DEFAULT_MODEL_PROFILES).some(profile => profile.variant !== 'high')) fail('variant mismatch');

  if ((await collectMarkdown('commands/naru')).length) fail('old nested commands found');
  if ((await collectMarkdown('agents/naru')).length) fail('old nested agents found');

  for (const path of [...expectedCommands, ...expectedAgents]) {
    const text = await readFile(here(path), 'utf8');
    if (text.includes('naru/')) fail(`${path} contains an old nested reference`);
  }

  for (const path of expectedAgents.filter(path => !minionPaths.includes(path))) {
    const first = parsePermissions(await readFile(here(path), 'utf8'))?.[0];
    if (!first || first.key !== '*' || first.val !== 'deny') fail(`${path} is not fail-closed`);
  }

  for (const role of minionRoles) {
    const path = `agents/naru-minion-${role}.md`;
    const text = await readFile(here(path), 'utf8');
    const topLevel = parsePermissions(text);
    const readRules = parseNestedPermission(text, 'read');
    const bashRules = parseNestedPermission(text, 'bash');
    if (JSON.stringify(topLevel) !== JSON.stringify(minionPermissionClasses[role])) fail(`${path} role permission class mismatch`);
    if (JSON.stringify(readRules) !== JSON.stringify(expectedReadRules)) fail(`${path} read policy mismatch`);
    const hasShell = ['implement', 'debug', 'verify'].includes(role);
    if (JSON.stringify(bashRules) !== JSON.stringify(hasShell ? expectedBashRules : null)) fail(`${path} bash policy mismatch`);

    for (const [value, expected] of [
      ['.env', 'deny'], ['.env.production', 'deny'], ['service.env', 'deny'], ['service.env.local', 'deny'],
      ['private.pem', 'deny'], ['config/secrets/token.txt', 'deny'], ['home/.ssh/id_ed25519', 'deny'],
      ['.env.example', 'allow'], ['service.env.example', 'allow'], ['env.example', 'allow'], ['src/app.js', 'allow'],
    ]) {
      if (evaluateRule(readRules, value) !== expected) fail(`${path} reads ${value} as ${evaluateRule(readRules, value)}, expected ${expected}`);
    }

    if (hasShell) {
      for (const command of ['node tests/target.test.mjs', 'weaver status', 'npm run lint', 'git status']) {
        if (evaluateRule(bashRules, command) !== 'allow') fail(`${path} does not allow routine shell command ${command}`);
      }
    }
  }

  for (const path of coreAgents) {
    if (readFrontmatter(await readFile(here(path), 'utf8'))?.hidden !== 'true') fail(`${path} is not hidden`);
  }
  for (const path of [...minionPaths, 'agents/naru-review-post.md']) {
    if (readFrontmatter(await readFile(here(path), 'utf8'))?.hidden !== 'true') fail(`${path} is not hidden`);
  }

  for (const path of [...expectedCommands, ...expectedAgents]) {
    const frontmatter = readFrontmatter(await readFile(here(path), 'utf8'));
    if (path === 'agents/naru-minion-implement.md') {
      if (frontmatter?.model !== 'openai/gpt-5.6-terra-fast' || frontmatter?.variant !== 'high') fail('implement fallback model mismatch');
    } else if (frontmatter?.model || frontmatter?.variant) fail(`${path} unexpectedly pins a model`);
  }

  for (const path of expectedAgents) {
    const text = await readFile(here(path), 'utf8');
    const bad = [];
    for (const line of text.split('\n')) {
      if (/^\s*[-*]?\s*`(gh|git)\s/.test(line)) bad.push(line.trim());
      if (/bash:\s*(gh|git)\s/.test(line)) bad.push(line.trim());
    }
    if (bad.length) fail(`${path} has direct gh/git bash strings: ${bad.slice(0, 3).join('; ')}`);
  }

  for (const path of expectedAgents) {
    const text = await readFile(here(path), 'utf8');
    const refs = [...text.matchAll(/^    '(naru-[\w-]+)': allow$/gm)].map(match => match[1]);
    for (const ref of refs) {
      if (!expectedAgents.includes(`agents/${ref}.md`)) fail(`${path} references unknown agent ${ref}`);
    }
    const id = path.slice(7, -3);
    const expected = NARU_DISPATCH_GRAPH[id];
    if (expected && JSON.stringify(refs.sort()) !== JSON.stringify([...expected].sort())) fail(`${path} dispatch graph mismatch`);
    if (!expected && refs.length) fail(`${path} has unregistered Task routes`);
  }

  for (const path of expectedAgents.filter(path => /^agents\/naru-review(?:-|\.md)/.test(path) && path !== 'agents/naru-review-post.md')) {
    const text = await readFile(here(path), 'utf8');
    for (const required of ['read: deny', 'glob: deny', 'grep: deny', 'lsp: deny', 'naru-git-read: deny', 'naru-github-read: allow']) {
      if (!text.includes(required)) fail(`${path} missing immutable-review permission ${required}`);
    }
    if (text.includes('codebase-memory-mcp_')) fail(`${path} may inspect a mutable local graph`);
  }

  for (const path of expectedAgents.filter(path => !/^agents\/naru-review(?:-|\.md)/.test(path) && !minionPaths.includes(path))) {
    const text = await readFile(here(path), 'utf8');
    if (!text.includes('read:\n')) continue;
    for (const denied of ["'*.pem': deny", "'*.key': deny", "'**/.ssh/**': deny", "'**/credentials/**': deny"]) {
      if (!text.includes(denied)) fail(`${path} missing direct-read secret denial ${denied}`);
    }
  }

  const postTool = 'naru-github-post-review';
  const postingAgents = new Set(['agents/naru-review-post.md', 'agents/naru-orchestrator.md']);
  for (const path of expectedAgents) {
    const text = await readFile(here(path), 'utf8');
    const postPermissions = parsePermissions(text)?.filter(permission => permission.key === postTool) ?? [];
    if (postingAgents.has(path)) {
      if (postPermissions.length !== 1 || postPermissions[0].val !== 'allow') {
        fail(`${path} must allow the posting tool exactly once`);
      }
    } else {
      if (postPermissions.some(permission => permission.val !== 'deny')) {
        fail(`${path} must deny or exclude the posting tool`);
      }
    }
  }
  if (postingAgents.size !== 2) fail('exactly two agents must be posting-capable');

  const orchestratorText = await readFile(here('agents/naru-orchestrator.md'), 'utf8');
  const orchestratorTasks = parseNestedPermission(orchestratorText, 'task');
  const orchestratorAllows = orchestratorTasks.filter(rule => rule.action === 'allow').map(rule => rule.pattern).sort();
  if (JSON.stringify(orchestratorAllows) !== JSON.stringify([...NARU_DISPATCH_GRAPH['naru-orchestrator']].sort())) {
    fail('orchestrator exact Task allowlist mismatch');
  }
  if (!orchestratorAllows.includes('naru-review') || orchestratorAllows.includes('naru-review-post')) {
    fail('orchestrator review Task boundary mismatch');
  }

  const schedulerCapable = [];
  for (const path of expectedAgents) {
    const permissions = parsePermissions(await readFile(here(path), 'utf8')) ?? [];
    const schedulerPermissions = permissions.filter(permission => permission.key === 'naru-scheduler');
    if (schedulerPermissions.length) schedulerCapable.push({ path, schedulerPermissions });
  }
  if (
    schedulerCapable.length !== 1 ||
    schedulerCapable[0].path !== 'agents/naru-orchestrator.md' ||
    JSON.stringify(schedulerCapable[0].schedulerPermissions) !== JSON.stringify([{ key: 'naru-scheduler', val: 'allow' }])
  ) {
    fail('exactly naru-orchestrator must have one scheduler allow');
  }
  for (const required of ['native Task', 'current workspace', 'Do not create worktrees automatically']) {
    if (!orchestratorText.includes(required)) fail(`orchestrator missing scheduler boundary: ${required}`);
  }

  for (const path of [...expectedCommands, ...expectedAgents]) {
    const text = (await readFile(here(path), 'utf8')).toLowerCase();
    for (const forbidden of ['/users/', '.config/opencode', 'herdr']) {
      if (text.includes(forbidden)) fail(`${path} mentions forbidden ${forbidden}`);
    }
  }

  const readme = await readFile(here('README.md'), 'utf8');
  for (const command of ['plan', 'impact', 'triage', 'review', 'review-post', 'minions']) {
    if (!readme.includes(`/naru-${command}`)) fail(`README missing /naru-${command}`);
  }

  const dashboard = await readFile(here('plugins/naru-minions-dashboard.tsx'), 'utf8');
  if (!dashboard.includes('slashName: "naru-minions"') || !dashboard.includes('api.slots.register({') || !dashboard.includes('sidebar_content(_ctx, props)')) fail('dashboard contract mismatch');
  if (!dashboard.includes('api.client.session.messages') || !dashboard.includes('export default plugin')) fail('dashboard metadata contract mismatch');

  const delegate = await readFile(here('plugins/naru-delegate.js'), 'utf8');
  if (!delegate.includes('export const NaruDelegatePlugin') || !delegate.includes("'tool.execute.before'")) fail('delegate plugin contract mismatch');
  if (delegate.includes('client.session.create') || delegate.includes('client.session.prompt')) fail('delegate bypasses native Task sessions');

  for (const tool of ['naru-git-read.js', 'naru-github-read.js', 'naru-github-post-review.js']) {
    const text = await readFile(here(`tools/${tool}`), 'utf8');
    if (text.includes('Bun.$') || text.includes('shell: true') || !text.includes('JSON.stringify')) fail(`${tool} transport contract mismatch`);
  }

  if (failures) {
    console.error(`\n${failures} failure(s)`);
    process.exit(1);
  }
  console.log('OK config-policy');
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
