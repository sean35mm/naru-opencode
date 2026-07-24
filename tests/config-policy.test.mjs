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
  NARU_MINIMUM_SUBAGENT_DEPTH,
  NARU_REQUIRED_SUBAGENT_DEPTH,
  SOL_FLOOR_ROLES,
} from '../tools/naru-lib/model-routing.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const here = p => join(root, p);

const expectedSkills = ['naru-impact', 'naru-plan', 'naru-review', 'naru-triage'];

const expectedAgents = [
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
  'tools/naru-worktree.js',
  'tools/naru-lib/evaluation.mjs',
  'tools/naru-lib/live-evaluation.mjs',
  'tools/naru-lib/opencode-live-evaluation.mjs',
  'tools/naru-lib/worktree.mjs',
  'tools/naru-lib/scheduler-config.mjs',
  'tools/naru-lib/scheduler-journal.mjs',
  'tools/naru-lib/scheduler-protocol.mjs',
  'tools/naru-lib/scheduler-state.mjs',
  'tools/naru-lib/scheduler-telemetry.mjs',
  'tools/naru-lib/scheduler-token.mjs',
];

const minionRoles = ['scout', 'investigate', 'architect', 'implement', 'debug', 'verify', 'judge'];
const minionPaths = minionRoles.map(role => `agents/naru-minion-${role}.md`);
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
  { key: 'skill', val: '' },
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
  { key: 'skill', val: '' },
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
  { key: 'skill', val: '' },
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

const expectedSkillRules = [{ pattern: '*', action: 'allow' }];

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

function actionRefs(text) {
  return [...text.matchAll(/^\s*uses:\s*([^@\s]+)@([^\s#]+)\s+#\s+(\S+)\s*$/gm)].map(match => ({
    action: match[1],
    ref: match[2],
    tag: match[3],
  }));
}

function workflowJob(text, name) {
  const lines = text.split('\n');
  const start = lines.findIndex(line => line === `  ${name}:`);
  if (start < 0) return '';
  const end = lines.findIndex((line, index) => index > start && /^  [\w-]+:/.test(line));
  return lines.slice(start, end < 0 ? undefined : end).join('\n');
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
  for (const path of [...expectedAgents, ...expectedRuntimeFiles]) {
    if (!(await exists(path))) fail(`missing expected file: ${path}`);
  }

  const actualCommands = (await collectMarkdown('commands')).sort();
  if (actualCommands.length !== 0) fail('legacy Core command files remain installed');

  const actualSkills = (await readdir(here('skills'), { withFileTypes: true }))
    .filter(entry => entry.isDirectory())
    .map(entry => entry.name)
    .sort();
  if (JSON.stringify(actualSkills) !== JSON.stringify(expectedSkills)) fail('skill inventory mismatch');
  for (const skill of expectedSkills) {
    const path = `skills/${skill}/SKILL.md`;
    if (!(await exists(path))) fail(`missing expected skill: ${path}`);
    else if (readFrontmatter(await readFile(here(path), 'utf8'))?.name !== skill) fail(`${path} name mismatch`);
  }

  const actualAgents = (await readdir(here('agents'))).filter(name => name.endsWith('.md')).map(name => `agents/${name}`).sort();
  if (JSON.stringify(actualAgents) !== JSON.stringify([...expectedAgents].sort())) fail('agent inventory mismatch');
  const expectedIDs = expectedAgents.map(path => path.slice(7, -3)).sort();
  if (JSON.stringify([...NARU_AGENT_IDS].sort()) !== JSON.stringify(expectedIDs)) fail('routing inventory mismatch');

  if (NARU_DELEGATE_PROTOCOL !== 2) fail('unexpected Naru Delegate protocol');
  if (NARU_MINIMUM_SUBAGENT_DEPTH !== 1) fail('unexpected minimum subagent depth');
  if (NARU_REQUIRED_SUBAGENT_DEPTH !== 1) fail('dispatch topology depth changed without compatibility update');
  if (SOL_FLOOR_ROLES.length !== 2) fail('unexpected Sol-floor role count');
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

  const orchestratorPath = 'agents/naru-orchestrator.md';
  const orchestratorFirst = parsePermissions(await readFile(here(orchestratorPath), 'utf8'))?.[0];
  if (!orchestratorFirst || orchestratorFirst.key !== '*' || orchestratorFirst.val !== 'deny') fail(`${orchestratorPath} is not fail-closed`);

  for (const path of expectedAgents) {
    const text = await readFile(here(path), 'utf8');
    const skillPermissions = parsePermissions(text)?.filter(permission => permission.key === 'skill') ?? [];
    const skillRules = parseNestedPermission(text, 'skill');
    if (JSON.stringify(skillPermissions) !== JSON.stringify([{ key: 'skill', val: '' }])) {
      fail(`${path} must declare exactly one nested skill permission`);
    }
    if (JSON.stringify(skillRules) !== JSON.stringify(expectedSkillRules)) {
      fail(`${path} skill policy must allow exactly the native wildcard`);
    }
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

  for (const path of minionPaths) {
    if (readFrontmatter(await readFile(here(path), 'utf8'))?.hidden !== 'true') fail(`${path} is not hidden`);
  }

  for (const path of expectedAgents) {
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

  const postTool = 'naru-github-post-review';
  const postingAgents = new Set(['agents/naru-orchestrator.md']);
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
  if (postingAgents.size !== 1) fail('exactly one agent must be posting-capable');

  const orchestratorText = await readFile(here('agents/naru-orchestrator.md'), 'utf8');
  const orchestratorTasks = parseNestedPermission(orchestratorText, 'task');
  const orchestratorAllows = orchestratorTasks.filter(rule => rule.action === 'allow').map(rule => rule.pattern).sort();
  if (JSON.stringify(orchestratorAllows) !== JSON.stringify([...NARU_DISPATCH_GRAPH['naru-orchestrator']].sort())) {
    fail('orchestrator exact Task allowlist mismatch');
  }
  if (orchestratorAllows.some(agent => !agent.startsWith('naru-minion-'))) fail('orchestrator may Task only retained minions');

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
  const worktreeCapable = [];
  for (const path of expectedAgents) {
    const permissions = parsePermissions(await readFile(here(path), 'utf8')) ?? [];
    const worktreePermissions = permissions.filter(permission => permission.key === 'naru-worktree');
    if (worktreePermissions.length) worktreeCapable.push({ path, worktreePermissions });
  }
  if (
    worktreeCapable.length !== 1 ||
    worktreeCapable[0].path !== 'agents/naru-orchestrator.md' ||
    JSON.stringify(worktreeCapable[0].worktreePermissions) !== JSON.stringify([{ key: 'naru-worktree', val: 'allow' }])
  ) {
    fail('exactly naru-orchestrator must have one worktree allow');
  }
  for (const required of ['native Task', 'shared-workspace mode', 'Isolated Writer Mode', 'Do not create ad hoc worktrees']) {
    if (!orchestratorText.includes(required)) fail(`orchestrator missing scheduler boundary: ${required}`);
  }

  for (const path of [...expectedAgents, ...expectedSkills.map(skill => `skills/${skill}/SKILL.md`)]) {
    const text = (await readFile(here(path), 'utf8')).toLowerCase();
    for (const forbidden of ['/users/', '.config/opencode', 'herdr']) {
      if (text.includes(forbidden)) fail(`${path} mentions forbidden ${forbidden}`);
    }
  }

  const readme = await readFile(here('README.md'), 'utf8');
  for (const skill of expectedSkills) {
    if (!readme.includes(skill)) fail(`README missing ${skill}`);
  }

  const dashboard = await readFile(here('plugins/naru-minions-dashboard.tsx'), 'utf8');
  if (!dashboard.includes('slashName: "naru-minions"') || !dashboard.includes('api.slots.register({') || !dashboard.includes('sidebar_content(_ctx, props)')) fail('dashboard contract mismatch');
  if (!dashboard.includes('api.client.session.messages') || !dashboard.includes('export default plugin')) fail('dashboard metadata contract mismatch');

  const delegate = await readFile(here('plugins/naru-delegate.js'), 'utf8');
  if (!delegate.includes('export const NaruDelegatePlugin') || !delegate.includes("'tool.execute.before'")) fail('delegate plugin contract mismatch');
  if (delegate.includes('client.session.create') || delegate.includes('client.session.prompt')) fail('delegate bypasses native Task sessions');

  const ciWorkflow = await readFile(here('.github/workflows/ci.yml'), 'utf8');
  const docsWorkflow = await readFile(here('.github/workflows/docs.yml'), 'utf8');
  const workflows = `${ciWorkflow}\n${docsWorkflow}`;
  const expectedActions = [
    { action: 'actions/checkout', ref: '3d3c42e5aac5ba805825da76410c181273ba90b1', tag: 'v7' },
    { action: 'actions/checkout', ref: '3d3c42e5aac5ba805825da76410c181273ba90b1', tag: 'v7' },
    { action: 'actions/setup-node', ref: '820762786026740c76f36085b0efc47a31fe5020', tag: 'v7' },
    { action: 'actions/setup-node', ref: '820762786026740c76f36085b0efc47a31fe5020', tag: 'v7' },
    { action: 'oven-sh/setup-bun', ref: '0c5077e51419868618aeaa5fe8019c62421857d6', tag: 'v2' },
    { action: 'actions/configure-pages', ref: '45bfe0192ca1faeb007ade9deae92b16b8254a0d', tag: 'v6' },
    { action: 'actions/upload-pages-artifact', ref: 'fc324d3547104276b827a68afc52ff2a11cc49c9', tag: 'v5' },
    { action: 'actions/deploy-pages', ref: 'cd2ce8fcbc39b97be8ca5fce6e763baed58fa128', tag: 'v5' },
  ];
  const actualActions = actionRefs(workflows).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  expectedActions.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  if (JSON.stringify(actualActions) !== JSON.stringify(expectedActions)) fail('workflow action allowlist mismatch');
  if ((workflows.match(/^\s*uses:\s*\S+/gm) ?? []).length !== actualActions.length) fail('workflow action is missing an immutable ref or tag comment');
  if (actualActions.some(({ ref }) => !/^[0-9a-f]{40}$/.test(ref))) fail('workflow action ref is not a lowercase 40-hex commit');
  for (const checkout of workflows.split(/(?=^\s*- name:)/m).filter(step => step.includes('uses: actions/checkout@'))) {
    if (!/persist-credentials:\s*false\b/.test(checkout)) fail('checkout must disable persisted credentials');
  }
  if (!/^permissions:\n  contents: read\n/m.test(ciWorkflow)) fail('CI must have contents-only read permission');
  if ((ciWorkflow.match(/node-version:\s*24\b/g) ?? []).length !== 1) fail('CI must use Node 24');
  if ((docsWorkflow.match(/node-version:\s*24\b/g) ?? []).length !== 1) fail('docs must use Node 24');
  if (!/bun-version:\s*1\.3\.9\b/.test(ciWorkflow)) fail('CI must pin Bun 1.3.9');

  const installCommand = 'npm install --prefix "$RUNNER_TEMP/opencode-linux-x64-1.18.4" --no-save --package-lock=false --ignore-scripts --omit=dev --no-audit --no-fund opencode-linux-x64@1.18.4';
  if ((ciWorkflow.match(new RegExp(installCommand.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) ?? []).length !== 1) {
    fail('CI must use the exact script-free OpenCode package install');
  }
  for (const required of [
    'test "$(node -p \'require(process.argv[1]).version\' "$package_json")" = "1.18.4"',
    'opencode_path="$(realpath "$package_root/node_modules/opencode-linux-x64/bin/opencode")"',
    'test -f "$opencode_path"',
    'test -x "$opencode_path"',
    'bun_path="$(realpath "$(command -v bun)")"',
    'node scripts/naru-compat-smoke.mjs --opencode "$opencode_path" --source "$GITHUB_WORKSPACE" --dashboard --bun "$bun_path" --json',
  ]) {
    if (!ciWorkflow.includes(required)) fail(`CI compatibility smoke missing: ${required}`);
  }
  if (!/case "\$opencode_path" in\n\s+"\$package_root"\/\*\)/.test(ciWorkflow)) fail('OpenCode binary must resolve beneath its package root');
  const orderedCI = [
    'Run Node tests', 'Run Bun transport smoke test', 'Run installer tests', 'Build documentation',
    'Run provider-free OpenCode compatibility smoke', 'Check whitespace',
  ].map(marker => ciWorkflow.indexOf(marker));
  if (orderedCI.some(index => index < 0) || orderedCI.some((index, i) => i && index <= orderedCI[i - 1])) fail('CI check ordering mismatch');
  for (const forbidden of [/\bnpx\b/i, /\bnpm\s+exec\b/i, /command\s+-v\s+opencode\b/i, /\bwhich\s+opencode\b/i, /live[-_ ]eval/i, /\bsecrets?(?:\.|\[)/i, /\b[A-Z][A-Z0-9_]*_(?:API_)?KEY\b/]) {
    if (forbidden.test(workflows)) fail(`workflow contains forbidden provider or package discovery pattern: ${forbidden}`);
  }

  const docsBuild = workflowJob(docsWorkflow, 'build');
  const docsDeploy = workflowJob(docsWorkflow, 'deploy');
  if (!/^permissions:\n  contents: read\n/m.test(docsWorkflow)) fail('docs workflow must default to contents-only read permission');
  if (/\b(?:pages|id-token):\s*write\b/.test(docsBuild)) fail('docs build has deployment permissions');
  if (!/permissions:\n\s+pages: write\n\s+id-token: write\n/.test(docsDeploy) || /\bcontents:\s*/.test(docsDeploy)) {
    fail('docs deploy must have only Pages and ID-token write permissions');
  }
  const buildActions = actionRefs(docsBuild).map(({ action }) => action);
  if (JSON.stringify(buildActions) !== JSON.stringify(['actions/checkout', 'actions/setup-node', 'actions/upload-pages-artifact'])) {
    fail('docs build action boundary mismatch');
  }
  const deployActions = actionRefs(docsDeploy).map(({ action }) => action);
  if (JSON.stringify(deployActions) !== JSON.stringify(['actions/configure-pages', 'actions/deploy-pages'])) {
    fail('docs configure-pages must run immediately before deploy-pages');
  }
  if (!/uses: actions\/configure-pages@[^\n]+\n\s+- name: Deploy to GitHub Pages\n/.test(docsDeploy)) {
    fail('docs configure-pages and deploy-pages steps must be adjacent');
  }
  if (/\bpull_request_target\s*:/.test(workflows)) fail('privileged pull_request_target trigger is forbidden');
  const gitignore = await readFile(here('.gitignore'), 'utf8');
  if (!gitignore.split(/\r?\n/).includes('/.naru-evidence/')) fail('root Naru evidence directory must be ignored');

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
