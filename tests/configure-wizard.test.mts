import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { cp, lstat, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { renderPromptValue, selectValidModels, TerminalWizardPrompt, WizardCancelled, type WizardPrompt } from '../tools/naru-lib/configure-wizard.mjs';
import type { HostCatalogue } from '../tools/naru-lib/host-process.mjs';

const model = { id: 'tool_worker', providerID: 'fixture', name: 'Tool Worker', reference: 'fixture/tool_worker', capabilities: { tools: true, input: ['text'], output: ['text'] }, variantIDs: ['fast'] };
const catalogue: HostCatalogue = { models: [model], providers: [{ id: 'fixture', name: 'Fixture', activation: 'enabled' }], observedAt: '2026-09-08T00:00:00.000Z', metadataFreshness: 'unknown', accountAccess: 'unknown' };
const built = join(dirname(fileURLToPath(import.meta.url)), '..');
const supportsPty = process.platform === 'darwin' || process.platform === 'linux';

class Prompt implements WizardPrompt {
    messages: string[] = []; choices: Array<Array<{ value: string; label: string }>> = []; modelInitials: string[][] = []; modelOptions: string[][] = [];
    constructor(readonly answers: { input?: string[]; choose?: string[]; confirm?: boolean[]; models?: Array<string[] | Error> } = {}) {}
    message(value: string) { this.messages.push(value); }
    async input() { const value = this.answers.input?.shift(); if (value === undefined) throw new Error('Unexpected input prompt'); return value; }
    async choose<T extends string>(_label: string, choices: Array<{ value: T; label: string }>): Promise<T> {
        this.choices.push(choices); const value = this.answers.choose?.shift(); if (!value) throw new Error('Unexpected choice prompt');
        if (value === 'CANCEL') throw new WizardCancelled();
        assert.ok(choices.some(choice => choice.value === value), `choice ${value} was not offered`); return value as T;
    }
    async confirm() { const value = this.answers.confirm?.shift(); if (value === undefined) throw new Error('Unexpected confirmation'); return value; }
    async selectModels(models: typeof catalogue.models, initial: string[]) { this.modelOptions.push(models.map(value => value.reference)); this.modelInitials.push([...initial]); const value = this.answers.models?.shift(); if (value instanceof Error) throw value; if (!value) throw new Error('Unexpected model prompt'); return value; }
}

test('all advertised variants expand to exact references; Fast is a separate catalogue model, not an inferred variant', async () => {
    const variants = { ...model, variantIDs: ['none', 'low', 'medium', 'high', 'xhigh', 'max'] };
    const fast = { ...model, id: 'tool_worker-fast', name: 'Fast Worker', reference: 'fixture/tool_worker-fast', variantIDs: ['none', 'low', 'high'] };
    const group = '\u0000all-variants:fixture/tool_worker';
    const prompt = new Prompt({ models: [[group, 'fixture/tool_worker', 'fixture/tool_worker#high', fast.reference, 'fixture/tool_worker-fast#low']] });
    assert.deepEqual(await selectValidModels(prompt, [variants, fast], []), [
        ...variants.variantIDs.map(id => `fixture/tool_worker#${id}`), variants.reference, fast.reference, 'fixture/tool_worker-fast#low',
    ]);
    assert.deepEqual(prompt.modelInitials, [[]]);
});

test('variantless models have no group option and fabricated groups cannot be saved', async () => {
    const variantless = { ...model, variantIDs: [] }, prompt = new Prompt({ models: [['\u0000all-variants:fixture/tool_worker'], [variantless.reference]] });
    assert.deepEqual(await selectValidModels(prompt, [variantless], []), [variantless.reference]);
    assert.ok(prompt.messages.some(message => message.includes('not offered by this catalogue')));
});

test('expansion enforces the 32-reference limit without truncation and keeps the group draft for retry', async () => {
    const many = { ...model, variantIDs: Array.from({ length: 32 }, (_, index) => `level_${index}`) };
    const group = '\u0000all-variants:fixture/tool_worker', other = 'fixture/other';
    const prompt = new Prompt({ models: [[group, other], [group]] });
    assert.deepEqual(await selectValidModels(prompt, [many, { ...model, id: 'other', reference: other, variantIDs: [] }], []), many.variantIDs.map(id => `${many.reference}#${id}`));
    assert.deepEqual(prompt.modelInitials, [[], [group, other]]);
    assert.ok(prompt.messages.some(message => message.includes('selected 33 worker references; the limit is 32')));
});

test('saved exact individual references survive a partial catalogue, and cancellation never returns a draft', async () => {
    const retained = ['fixture/tool_worker#fast', 'retired/saved#max'];
    const prompt = new Prompt({ models: [[...retained, '\u0000all-variants:fixture/tool_worker']] });
    assert.deepEqual(await selectValidModels(prompt, [model], retained), retained);
    const cancelled = new Prompt({ models: [new WizardCancelled()] });
    await assert.rejects(selectValidModels(cancelled, [model], retained), WizardCancelled);
    assert.deepEqual(cancelled.modelInitials, [retained]);
});

test('terminal prompt treats EOF and Ctrl-C as cancellation and keeps input boundaries intact', async () => {
    const stream = () => {
        const input = new PassThrough() as PassThrough & { isTTY: boolean; isRaw: boolean; setRawMode(value: boolean): void };
        input.isTTY = true; input.isRaw = false; input.setRawMode = value => { input.isRaw = value; };
        const output = new PassThrough() as PassThrough & { isTTY: boolean; columns: number }; output.isTTY = true; output.columns = 80;
        return { input, output, prompt: new TerminalWizardPrompt(input, output) };
    };
    const eof = stream(), eofAnswer = eof.prompt.input('Path: '); eof.input.end(); await assert.rejects(eofAnswer, WizardCancelled);
    const interrupt = stream(), interrupted = interrupt.prompt.input('Path: '); interrupt.input.emit('keypress', '\u0003', { name: 'c', ctrl: true, sequence: '\u0003' });
    await assert.rejects(Promise.race([interrupted, new Promise((_, reject) => setTimeout(() => reject(new Error('Ctrl-C did not cancel')), 500))]), WizardCancelled);
    const answer = stream(), bounded = answer.prompt.input('Path: '); answer.input.write('  /tmp/repo with spaces  \r'); assert.equal(await bounded, '/tmp/repo with spaces');
});

test('prompt values escape terminal control and bidi code points', () => {
    const path = '/repo\ntrusted\u001b[2J\u202Espoof';
    assert.equal(renderPromptValue(path), '/repo\\u{000a}trusted\\u{001b}[2J\\u{202e}spoof');
});

async function runPtyHarness(source: string, keys: string[], startMarker = 'Worker models'): Promise<{ output: string; result: Record<string, unknown> }> {
    const cwd = await mkdtemp(join(tmpdir(), 'naru-wizard-pty-'));
    try {
        const driver = `import errno,fcntl,json,os,pty,select,signal,struct,sys,termios,time
node,source,keys,marker=sys.argv[1],sys.argv[2],json.loads(sys.argv[3]),sys.argv[4].encode(); pid,fd=pty.fork()
if pid == 0:
 env=os.environ.copy(); env['NO_COLOR']='1'; os.execve(node,[node,'--input-type=module','--eval',source],env)
fcntl.ioctl(fd,termios.TIOCSWINSZ,struct.pack('HHHH',24,80,0,0))
output=b''; index=0; next_key=0.0; deadline=time.time()+6; status=None; resized=False
while time.time() < deadline:
 ready,_,_=select.select([fd],[],[],0.02)
 if ready:
  try: output += os.read(fd,65536)
  except OSError as error:
   if error.errno != errno.EIO: raise
 if marker in output and not resized:
  fcntl.ioctl(fd,termios.TIOCSWINSZ,struct.pack('HHHH',18,60,0,0)); os.kill(pid,signal.SIGWINCH); resized=True
 if marker in output and index < len(keys) and time.time() >= next_key:
  os.write(fd,keys[index].encode()); index += 1; next_key=time.time()+0.12
 done,status=os.waitpid(pid,os.WNOHANG)
 if done: break
else:
 os.kill(pid,signal.SIGKILL); os.waitpid(pid,0); sys.stdout.buffer.write(output); print('PTY timeout',file=sys.stderr); sys.exit(124)
sys.stdout.buffer.write(output); sys.exit(os.waitstatus_to_exitcode(status))`;
        const child = spawn('/usr/bin/python3', ['-c', driver, process.execPath, source, JSON.stringify(keys), startMarker], {
            cwd, env: { ...process.env, NO_COLOR: '1' }, stdio: ['pipe', 'pipe', 'pipe'],
        });
        let output = '', stderr = ''; child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
        child.stdout.on('data', chunk => { output += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
        const code = await new Promise<number | null>((resolvePromise, reject) => {
            const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`PTY prompt did not exit: ${output}${stderr}`)); }, 8_000);
            child.once('error', error => { clearTimeout(timer); reject(error); });
            child.once('exit', value => { clearTimeout(timer); resolvePromise(value); });
        });
        assert.equal(code, 0, output + stderr);
        const match = output.match(/NARU_RESULT:(\{[^\r\n]+\})/u); assert.ok(match, output);
        return { output, result: JSON.parse(match[1]!) };
    } finally { await rm(cwd, { recursive: true, force: true }); }
}

test('native Clack model picker filters live, preserves hidden selections, toggles multiple workers, and restores the terminal', { skip: !supportsPty }, async () => {
    const isolated = await mkdtemp(join(tmpdir(), 'naru-wizard-installed-'));
    try {
        await cp(join(built, 'tools'), join(isolated, 'tools'), { recursive: true });
        await assert.rejects(lstat(join(isolated, 'node_modules')), { code: 'ENOENT' });
        const module = pathToFileURL(join(isolated, 'tools', 'naru-lib', 'configure-wizard.mjs')).href;
        const models = [
            { id: 'alpha', providerID: 'fixture', name: 'Alpha Worker', reference: 'fixture/alpha', variantIDs: [] },
            { id: 'beta', providerID: 'second', name: 'Beta Worker', reference: 'second/beta', variantIDs: [] },
            { id: 'gamma', providerID: 'third', name: 'Gamma Worker', reference: 'third/gamma', variantIDs: ['deep'] },
        ];
        const source = `import { TerminalWizardPrompt } from ${JSON.stringify(module)};
const before = process.stdin.listenerCount('keypress');
const value = await new TerminalWizardPrompt().selectModels(${JSON.stringify(models)}, ['fixture/alpha', 'retired/worker']);
console.log('NARU_RESULT:' + JSON.stringify({ value, raw: process.stdin.isRaw, listeners: process.stdin.listenerCount('keypress') - before }));`;
        const { output, result } = await runPtyHarness(source, ['no-match', '\u0015', 'beta', '\u001b[B', ' ', '\u0015', 'gamma', '\u001b[B', '\u001b[A', ' ', '\u0015', '\r']);
        assert.deepEqual(result.value, ['fixture/alpha', 'retired/worker', 'second/beta', 'third/gamma']);
        assert.equal(result.raw, false); assert.equal(result.listeners, 0);
        assert.match(output, /Type:.*search/s); assert.match(output, /No matches found/); assert.match(output, /unavailable \(saved; retain or remove\)/); assert.match(output, /4 items selected/); assert.ok(output.includes('\u001b[?25h'));
    } finally { await rm(isolated, { recursive: true, force: true }); }
});

test('native Clack offers all advertised variants only for catalogue models with variants', { skip: !supportsPty }, async () => {
    const module = pathToFileURL(join(built, 'tools', 'naru-lib', 'configure-wizard.mjs')).href;
    const source = `import { TerminalWizardPrompt, selectValidModels } from ${JSON.stringify(module)};
 const models=[{id:'plain',providerID:'fixture',name:'Plain Worker',reference:'fixture/plain',variantIDs:[]},{id:'fast',providerID:'fixture',name:'Fast Worker',reference:'fixture/fast',variantIDs:['none','low','high']}];
 const value=await selectValidModels(new TerminalWizardPrompt(),models,[]);
 console.log('NARU_RESULT:'+JSON.stringify({value,raw:process.stdin.isRaw}));`;
    const { output, result } = await runPtyHarness(source, ['all', '\t', '\r']);
    assert.deepEqual(result, { value: ['fixture/fast#none', 'fixture/fast#low', 'fixture/fast#high'], raw: false });
    assert.match(output, /Fast Worker \/ all 3 advertised variants/);
    assert.doesNotMatch(output, /Plain Worker \/ all/);
});

test('native text, arrow menu, and safe-default confirmation use the expected terminal keys', { skip: !supportsPty }, async () => {
    const module = pathToFileURL(join(built, 'tools', 'naru-lib', 'configure-wizard.mjs')).href;
    const source = `import { TerminalWizardPrompt } from ${JSON.stringify(module)};
const prompt = new TerminalWizardPrompt(); const path = await prompt.input('Repository path:');
const access = await prompt.choose('Repository access policy:', [{ value: 'inspect', label: 'Inspect only' }, { value: 'write', label: 'Scoped edits' }]);
const approved = await prompt.confirm('Save this repository policy and launch Naru?');
console.log('NARU_RESULT:' + JSON.stringify({ path, access, approved, raw: process.stdin.isRaw }));`;
    const { result } = await runPtyHarness(source, ['/tmp/repo with spaces', '\r', '\u001b[B', '\r', '\r'], 'Repository path');
    assert.deepEqual(result, { path: '/tmp/repo with spaces', access: 'write', approved: false, raw: false });
});
