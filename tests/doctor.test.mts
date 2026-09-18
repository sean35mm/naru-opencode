import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  appendFile,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { evaluateDoctorOpenCodeOutput } from '../tools/naru-doctor.js';
import { runHostContractProbe } from '../tools/naru-lib/host-contract-probe.mjs';
import { parseRuntimeConfig } from '../tools/naru-lib/runtime-config.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

interface DoctorScope {
  id: string;
  installed: boolean;
  manifestStatus: string;
  installMode: string;
  issuePaths: string[];
  assets: { total: number; installed: { healthy: number }; source: { matched: number } };
  configuredMcpPolicy: string;
  runtime: { status: string; workspaceMode: string; configuredMcpTools: string; reviewProfile: string; reviewDecision: string; reviewOutput: string };
}

interface DoctorReport {
  schemaVersion: number;
  diagnostic: string;
  providerFree: boolean;
  readOnly: boolean;
  compatibility: { opencode: { status: string; version: string | null; profile: string; testedBuilds: string[]; recognizedBuilds: string[]; versionPolicy: string; probe: { status: string; checks: Array<{ id: string; status: string; diagnostic: string | null }>; actions: string[] } } };
  depth: {
    effective: number;
    source: string;
    project: { configuredMcp: { status: string; basis: string; categories: Record<string, number>; notes: string[] } };
    configuredMcp: { status: string; source: string; toolInventory: string; categories: Record<string, number>; notes: string[] };
  };
  scopes: DoctorScope[];
  issues: Array<{ code: string }>;
}

interface DoctorPaths {
  home: string;
  project: string;
  source: string;
}

test('runtime review defaults are backward-safe and strictly validated', () => {
  assert.deepEqual(parseRuntimeConfig({}).review, {
    defaultProfile: 'standard', defaultDecision: 'comment-only', defaultOutput: 'detailed',
  });
  assert.deepEqual(parseRuntimeConfig({ review: {
    defaultProfile: 'release-critical', defaultDecision: 'automatic', defaultOutput: 'concise',
  } }).review, {
    defaultProfile: 'release-critical', defaultDecision: 'automatic', defaultOutput: 'concise',
  });
  assert.throws(() => parseRuntimeConfig({ review: { defaultProfile: 'critical' } }), /defaultProfile/);
  assert.throws(() => parseRuntimeConfig({ review: { ticket: true } }), /unknown fields/);
});

test('configured MCP runtime policy is backward-safe and strictly validated', () => {
  assert.deepEqual(parseRuntimeConfig({}).mcp, { configuredTools: 'off' });
  assert.deepEqual(parseRuntimeConfig({ mcp: { configuredTools: 'ask' } }).mcp, { configuredTools: 'ask' });
  assert.throws(() => parseRuntimeConfig({ mcp: { configuredTools: 'allow' } }), /mcp\.configuredTools/);
  assert.throws(() => parseRuntimeConfig({ mcp: { configuredTools: true } }), /mcp\.configuredTools/);
  assert.throws(() => parseRuntimeConfig({ mcp: { extra: 'ask' } }), /unknown fields/);
});

test('doctor distinguishes tested stable history from candidates requiring a current probe', () => {
  assert.equal(evaluateDoctorOpenCodeOutput('1.18.4').status, 'supported');
  assert.equal(evaluateDoctorOpenCodeOutput('1.18.28').status, 'supported');
  assert.equal(evaluateDoctorOpenCodeOutput('1.18.29').status, 'probe-required');
  assert.equal(evaluateDoctorOpenCodeOutput('1.99.0').status, 'probe-required');
  assert.equal(evaluateDoctorOpenCodeOutput('2.0.0').status, 'probe-required');
  assert.equal(evaluateDoctorOpenCodeOutput('2.0.0-beta.1').status, 'unsupported');
  assert.equal(evaluateDoctorOpenCodeOutput('opencode2 v0.0.0-beta-19086').status, 'unsupported');
  assert.equal(evaluateDoctorOpenCodeOutput('not a version').status, 'unknown');
  assert.equal(evaluateDoctorOpenCodeOutput('1.18.28', false).status, 'unknown');
});

async function copyInstallSource(destination: string): Promise<void> {
  for (const directory of ['agents', 'commands', 'plugins', 'skills', 'tools']) {
    await cp(path.join(root, directory), path.join(destination, directory), { recursive: true });
  }
  await cp(path.join(root, 'install.sh'), path.join(destination, 'install.sh'));
  await cp(path.join(root, 'naru-runtime.example.json'), path.join(destination, 'naru-runtime.example.json'));
  await cp(path.join(root, 'THIRD_PARTY_NOTICES'), path.join(destination, 'THIRD_PARTY_NOTICES'));
}

function runDoctor(doctor: string, { home, project, source }: DoctorPaths, options: { hostContractRoot?: string; path?: string } = {}): DoctorReport {
  const args = [
    doctor,
    '--json',
    '--project-root', project,
    '--source', source,
  ];
  if (options.hostContractRoot) args.push('--host-contract-root', options.hostContractRoot);
  const result = spawnSync(process.execPath, args, {
    cwd: project,
    env: { ...process.env, HOME: home, ...(options.path ? { PATH: options.path } : {}) },
    encoding: 'utf8',
    maxBuffer: 1024 * 1024,
    timeout: 10_000,
  });
  assert.ok(result.status === 0 || result.status === 1, result.stderr || result.stdout);
  assert.equal(result.stderr, '');
  return JSON.parse(result.stdout) as DoctorReport;
}

async function fakeDoctorOpenCode(directory: string, mode: 'pass' | 'delayed' | 'fail' | 'timeout' | 'overflow'): Promise<string> {
  const executable = path.join(directory, 'opencode');
  const childPidFile = `${executable}.child`;
  const source = `#!${process.execPath}
import http from 'node:http';import path from 'node:path';import {spawn} from 'node:child_process';import {readFileSync,writeFileSync} from 'node:fs';
const args=process.argv.slice(2);if(args[0]==='--version'){console.log('1.18.29');process.exit(0)}
const required=['HOME','XDG_CONFIG_HOME','XDG_DATA_HOME','XDG_CACHE_HOME','XDG_STATE_HOME','TMPDIR'];const boundary=path.dirname(process.env.HOME||'');if(!boundary||required.some(key=>!process.env[key]?.startsWith(boundary+path.sep)))process.exit(70);if(Object.keys(process.env).some(key=>/(?:API_KEY|TOKEN|SECRET|PASSWORD|AUTH)$/i.test(key)))process.exit(71);
if(args[0]!=='serve')process.exit(64);${mode === 'fail' ? 'process.exit(9);' : ''}
${mode === 'timeout' || mode === 'overflow' ? `const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)']);writeFileSync(${JSON.stringify(childPidFile)},String(child.pid));` : ''}
${mode === 'timeout' ? 'await new Promise(()=>{});' : mode === 'overflow' ? "process.stdout.write('x'.repeat(65537));setInterval(()=>{},1000);" : ''}
let seq=0,delayed=false;const observationDelay=${mode === 'delayed' ? 1250 : 0};const sessions=new Map(),pending=new Map(),attempted=new Map();const body=req=>new Promise(resolve=>{let value='';req.on('data',chunk=>value+=chunk);req.on('end',()=>resolve(value?JSON.parse(value):{}))});const send=(res,value)=>{res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify(value))};const rules=name=>[{permission:'*',pattern:'*',action:'deny'},{permission:'edit',pattern:'*',action:'deny'},{permission:'task',pattern:'*',action:'deny'},...(['naru-orchestrator','naru-writer','naru-writer-smoke'].includes(name)?[{permission:'safe_tools_*',pattern:'*',action:'ask'},{permission:'codebase_*',pattern:'*',action:'ask'},{permission:'safe_tools_delete',pattern:'*',action:'deny'}]:[]),...(name==='naru-orchestrator'?[{permission:'codebase-memory-mcp_search_graph',pattern:'*',action:'allow'}]:[])];const hostAgents=['naru-orchestrator','naru-reader','naru-runner','naru-writer'].flatMap(name=>[{name,permission:rules(name),options:{}},...(name==='naru-orchestrator'?[]:[{name,permission:rules(name+'-smoke'),variant:'high',options:{naruVariant:true}}])]);
const server=http.createServer(async(req,res)=>{const url=new URL(req.url,'http://127.0.0.1');if(url.pathname==='/global/health')send(res,{healthy:true});else if(url.pathname==='/agent')send(res,hostAgents);else if((url.pathname==='/api/session'||url.pathname==='/session')&&req.method==='POST'){const input=await body(req),id='ses_'+(++seq);sessions.set(id,input.agent);pending.set(id,[]);send(res,url.pathname==='/session'?{id}:{data:{id}})}else if(url.pathname==='/permission'&&req.method==='GET')send(res,[...pending.values()].flat());else{const message=url.pathname.match(/^\\/session\\/(ses_[0-9]+)\\/message$/);if(message&&req.method==='GET'){send(res,[{parts:[{type:'tool',tool:attempted.get(message[1]),state:{status:'error'}}]}]);return}const prompt=url.pathname.match(/^\\/session\\/(ses_[0-9]+)\\/prompt_async$/);if(prompt&&req.method==='POST'){const input=await body(req),agent=sessions.get(prompt[1]),action=String(input.parts?.[0]?.text||'').split(':').at(-1),config=JSON.parse(readFileSync(path.join(process.cwd(),'opencode.json'),'utf8'));attempted.set(prompt[1],action);if(observationDelay&&!delayed){delayed=true;await new Promise(resolve=>setTimeout(resolve,observationDelay))}await fetch(config.provider.openai.options.baseURL+'/responses',{method:'POST',body:'{}'});if(['naru-orchestrator','naru-writer','naru-writer-smoke'].includes(agent)&&['safe_tools_read','codebase_read'].includes(action))pending.get(prompt[1]).push({sessionID:prompt[1],permission:action});res.writeHead(204);res.end();return}const match=url.pathname.match(/^\\/api\\/session\\/(ses_[0-9]+)\\/permission$/);if(!match){res.writeHead(404);res.end('{}');return}const id=match[1];if(req.method==='GET'){send(res,{data:pending.get(id)||[]});return}const input=await body(req),agent=sessions.get(id),eligible=['naru-orchestrator','naru-writer','naru-writer-smoke'].includes(agent);const effect=eligible&&['safe_tools_read','codebase_read'].includes(input.action)?'ask':agent==='naru-orchestrator'&&input.action==='codebase-memory-mcp_search_graph'?'allow':'deny';const item={id:'per_'+(++seq),action:input.action,effect};if(effect==='ask')pending.get(id).push(item);send(res,{data:item})}});server.listen(Number(args[4]),'127.0.0.1');process.on('SIGTERM',()=>server.close(()=>process.exit(0)));
`;
  await writeFile(executable, source, { mode: 0o755 });
  return executable;
}

test('CLI-mode doctor probes candidates without caching command failures, timeouts, or bounded output', async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'naru-doctor-probe-test-'));
  try {
    const home = path.join(temporary, 'home');
    const project = path.join(temporary, 'project');
    const bin = path.join(temporary, 'bin');
    await mkdir(home, { recursive: true });
    await mkdir(project, { recursive: true });
    await mkdir(bin, { recursive: true });
    const paths = { home, project, source: root };
    const doctor = path.join(root, 'tools', 'naru-doctor.js');
    const executable = await fakeDoctorOpenCode(bin, 'delayed');
    const pathValue = [bin, path.dirname(process.execPath), '/usr/bin', '/bin'].join(path.delimiter);
    let report = runDoctor(doctor, paths, { hostContractRoot: root, path: pathValue });
    assert.equal(report.compatibility.opencode.version, '1.18.29');
    assert.equal(report.compatibility.opencode.versionPolicy, 'candidate');
    assert.equal(report.compatibility.opencode.status, 'local-tested');
    assert.equal(report.compatibility.opencode.probe.status, 'passed');
    assert.deepEqual(report.compatibility.opencode.probe.checks.map(check => [check.id, check.status]), [['mcp-contract', 'passed']]);
    assert.ok(report.compatibility.opencode.probe.actions.includes('naru-writer-smoke:safe_tools_read:ask'));
    const cli = spawnSync('sh', [path.join(root, 'bin', 'naru'), 'doctor', '--json', '--project-root', project, '--source', root], {
      cwd: project, env: { ...process.env, HOME: home, PATH: pathValue }, encoding: 'utf8', timeout: 10_000, maxBuffer: 1024 * 1024,
    });
    assert.ok(cli.status === 0 || cli.status === 1, cli.stderr || cli.stdout);
    assert.equal((JSON.parse(cli.stdout) as DoctorReport).compatibility.opencode.status, 'local-tested');

    const bypass = spawnSync(process.execPath, [doctor, '--internal-static-compatibility'], { cwd: project, env: { ...process.env, HOME: home, PATH: pathValue }, encoding: 'utf8' });
    assert.equal(bypass.status, 2);
    assert.match(bypass.stderr, /unknown option/);

    for (const mode of ['fail', 'overflow'] as const) {
      await fakeDoctorOpenCode(bin, mode);
      report = runDoctor(doctor, paths, { hostContractRoot: root, path: pathValue });
      assert.equal(report.compatibility.opencode.status, 'contract-failed', mode);
      assert.equal(report.compatibility.opencode.probe.status, 'failed', mode);
      assert.ok(report.compatibility.opencode.probe.checks.every(check => check.status === 'failed'), mode);
      if (mode === 'overflow') {
        const childPid = Number(await readFile(`${executable}.child`, 'utf8'));
        assert.throws(() => process.kill(childPid, 0), (error: unknown) => error instanceof Error && 'code' in error && error.code === 'ESRCH');
      }
    }
    await fakeDoctorOpenCode(bin, 'timeout');
    const timeoutRoot = path.join(temporary, 'bounded-timeout');
    const timeoutHome = path.join(timeoutRoot, 'home');
    const timeoutProject = path.join(timeoutRoot, 'project');
    const timeoutTmp = path.join(timeoutRoot, 'tmp');
    const timeoutEnv = {
      HOME: timeoutHome,
      PATH: pathValue,
      TMPDIR: timeoutTmp,
      XDG_CACHE_HOME: path.join(timeoutRoot, 'cache'),
      XDG_CONFIG_HOME: path.join(timeoutRoot, 'config'),
      XDG_DATA_HOME: path.join(timeoutRoot, 'data'),
      XDG_STATE_HOME: path.join(timeoutRoot, 'state'),
    };
    for (const directory of [timeoutHome, timeoutProject, timeoutTmp, timeoutEnv.XDG_CACHE_HOME, timeoutEnv.XDG_CONFIG_HOME, timeoutEnv.XDG_DATA_HOME, timeoutEnv.XDG_STATE_HOME]) await mkdir(directory, { recursive: true });
    await writeFile(path.join(timeoutProject, 'opencode.json'), '{}\n');
    const timedOut = await runHostContractProbe({ executable, cwd: timeoutProject, env: timeoutEnv, marker: path.join(timeoutRoot, 'marker'), timeoutMs: 100 });
    assert.equal(timedOut.status, 'failed');
    assert.equal(timedOut.diagnostic, 'host-startup-timeout');
    const timedOutChildPid = Number(await readFile(`${executable}.child`, 'utf8'));
    assert.throws(() => process.kill(timedOutChildPid, 0), (error: unknown) => error instanceof Error && 'code' in error && error.code === 'ESRCH');
    assert.equal(executable, path.join(bin, 'opencode'));
  } finally { await rm(temporary, { recursive: true, force: true }); }
});

test('CLI helper modules tolerate virtual Bun argv when imported as tools', async () => {
  const previousArgv1 = process.argv[1];
  process.argv[1] = '/$bunfs/root/src/cli/tui/worker.js';
  try {
    const nonce = Date.now();
    await import(`${pathToFileURL(path.join(root, 'tools/naru-lib/install-manifest.mjs')).href}?virtual-bun-argv=${nonce}`);
    await import(`${pathToFileURL(path.join(root, 'tools/naru-doctor.js')).href}?virtual-bun-argv=${nonce}`);
  } finally {
    if (previousArgv1 === undefined) delete process.argv[1];
    else process.argv[1] = previousArgv1;
  }
});

test('doctor is read-only and diagnoses scope, default depth, and source generation', async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'naru-doctor-test-'));
  try {
    const source = path.join(temporary, 'source');
    const home = path.join(temporary, 'home');
    const project = path.join(temporary, 'project');
    await mkdir(source, { recursive: true });
    await mkdir(home, { recursive: true });
    await mkdir(project, { recursive: true });
    await copyInstallSource(source);

    const install = spawnSync('sh', [
      path.join(source, 'install.sh'),
      '--apply',
    ], {
      cwd: source,
      env: { ...process.env, HOME: home },
      encoding: 'utf8',
      maxBuffer: 1024 * 1024,
      timeout: 20_000,
    });
    assert.equal(install.status, 0, install.stderr || install.stdout);

    const target = path.join(home, '.config', 'opencode');
    const doctor = path.join(target, 'tools', 'naru-doctor.js');
    const manifestPath = path.join(target, '.naru-install.json');
    const manifestBefore = await readFile(manifestPath, 'utf8');

    let report = runDoctor(doctor, { home, project, source });
    assert.equal(report.schemaVersion, 3);
    assert.equal(report.diagnostic, 'naru-doctor');
    assert.equal(report.providerFree, true);
    assert.equal(report.readOnly, true);
    assert.equal(report.depth.effective, 1);
    assert.equal(report.depth.source, 'opencode-default');
    assert.equal(report.scopes.filter(scope => scope.installed).length, 1);
    const globalScope = report.scopes.find(scope => scope.id === 'global');
    assert.ok(globalScope);
    assert.equal(globalScope.manifestStatus, 'valid');
    assert.equal(globalScope.installMode, 'symlink');
    assert.equal(globalScope.assets.installed.healthy, globalScope.assets.total);
    assert.equal(globalScope.assets.source.matched, globalScope.assets.total);
    assert.equal(globalScope.runtime.status, 'default');
    assert.equal(globalScope.runtime.workspaceMode, 'auto');
    assert.equal(globalScope.runtime.configuredMcpTools, 'off');
    assert.equal(globalScope.configuredMcpPolicy, 'installed');
    assert.deepEqual(
      [globalScope.runtime.reviewProfile, globalScope.runtime.reviewDecision, globalScope.runtime.reviewOutput],
      ['standard', 'comment-only', 'detailed'],
    );
    assert.equal(JSON.stringify(report).includes(temporary), false);
    assert.equal(await readFile(manifestPath, 'utf8'), manifestBefore);

    await writeFile(path.join(target, 'opencode.json'), '{"mcp":{"foo":{}}}\n');
    await writeFile(path.join(project, 'opencode.jsonc'), '{\n  // project wins\n  "subagent_depth": 4,\n  "mcp": {\n    "foo_bar": {},\n    "disabled": { "enabled": false },\n    "codebase-memory-mcp": {}\n  },\n}\n');
    report = runDoctor(doctor, { home, project, source });
    assert.equal(report.depth.effective, 4);
    assert.equal(report.depth.source, 'project:opencode.jsonc');
    assert.equal(report.depth.project.configuredMcp.status, 'available');
    assert.equal(report.depth.project.configuredMcp.basis, 'scope-only');
    assert.deepEqual(report.depth.project.configuredMcp.categories, { protected: 1, disabled: 1, eligible: 1 });
    assert.equal(report.depth.configuredMcp.status, 'known');
    assert.equal(report.depth.configuredMcp.source, 'global+project deep merge');
    assert.equal(report.depth.configuredMcp.toolInventory, 'unknown');
    assert.deepEqual(report.depth.configuredMcp.categories, { protected: 1, disabled: 1, collision: 2 });
    assert.deepEqual(report.depth.project.configuredMcp.notes, ['protected namespaces remain explicitly curated; absent administrative tools stay unavailable']);
    assert.ok(report.issues.some(issue => issue.code === 'configured-mcp-collision'));

    await writeFile(path.join(target, 'opencode.json'), '{"mcp":{"foo":{},"foo_bar":{"enabled":true}}}\n');
    await writeFile(path.join(project, 'opencode.jsonc'), '{\n  "subagent_depth": 4,\n  "mcp": {\n    "foo_bar": { "enabled": false }\n  }\n}\n');
    report = runDoctor(doctor, { home, project, source });
    assert.deepEqual(report.depth.configuredMcp.categories, { eligible: 1, disabled: 1 });
    assert.equal(report.issues.some(issue => issue.code === 'configured-mcp-collision'), false);

    const sourceAsset = path.join(source, 'tools', 'naru-git-read.js');
    const originalAsset = await readFile(sourceAsset);
    await appendFile(sourceAsset, '\n// newer source generation\n');
    report = runDoctor(doctor, { home, project, source });
    assert.ok(report.issues.some(issue => issue.code === 'copy-pinned-assets-stale'));
    assert.ok(report.issues.some(issue => issue.code === 'mixed-generation-install'));
    await writeFile(sourceAsset, originalAsset);

    await appendFile(path.join(target, 'tools', 'naru-git-read.js'), '\n// local modification\n');
    report = runDoctor(doctor, { home, project, source });
    assert.ok(report.issues.some(issue => issue.code === 'managed-assets-modified'));
    assert.ok(report.scopes.find(scope => scope.id === 'global')?.issuePaths.includes('tools/naru-git-read.js'));

    await writeFile(manifestPath, '{ invalid\n');
    report = runDoctor(doctor, { home, project, source });
    assert.equal(report.scopes.find(scope => scope.id === 'global')?.manifestStatus, 'invalid');
    assert.ok(report.issues.some(issue => issue.code === 'invalid-install-manifest'));
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});
