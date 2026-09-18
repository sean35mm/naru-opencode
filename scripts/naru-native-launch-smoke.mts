#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, cp, lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadOc2NativeModelProfile } from '../tools/naru-lib/oc2-native-config.mjs';
import { oc2NativeEnvironment, oc2NativePaths } from '../tools/naru-lib/oc2-profile.mjs';
import { cleanProcessEnvironment, nodeSpawner } from '../tools/naru-lib/preview-process.mjs';
import { validateSmokeNative } from './naru-smoke-native.mjs';

if (process.platform !== 'darwin') throw new Error('Native launcher acceptance requires the certified macOS network sandbox');
const nativeArgument = process.argv[2];
if (!nativeArgument) throw new Error('Usage: node scripts/naru-native-launch-smoke.mjs /absolute/path/to/opencode2-beta-19425');
const native = await validateSmokeNative(nativeArgument);
const temporary = await realpath(await mkdtemp('/tmp/naru-native-launch-smoke-'));
const root = join(temporary, 'installed'), one = join(temporary, 'project-one'), two = join(temporary, 'project-two');
const home = join(temporary, 'home'), scratch = join(temporary, 'tmp'), paths = oc2NativePaths(root);
const builtRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..'), oc2 = join(builtRoot, 'tools', 'oc2.mjs');
const children: ChildProcess[] = [];

function launch(args: string[], cwd: string, env: NodeJS.ProcessEnv): ChildProcess {
    const child = spawn('/usr/bin/script', ['-q', '/dev/null', process.execPath, oc2, ...args], { cwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout?.resume(); child.stderr?.resume(); children.push(child); return child;
}
function stopChild(child: ChildProcess): void {
    if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
    try { process.kill(-child.pid, 'SIGTERM'); } catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ESRCH')) throw error; }
}
async function waitFor<T>(operation: () => Promise<T | null>, message: string): Promise<T> {
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
        const value = await operation(); if (value !== null) return value;
        await new Promise(resolvePromise => setTimeout(resolvePromise, 100));
    }
    throw new Error(message);
}

let environment: NodeJS.ProcessEnv | undefined;
try {
    for (const directory of [root, one, two, home, scratch, join(root, 'lib'), join(home, '.config', 'opencode')]) await mkdir(directory, { recursive: true, mode: 0o700 });
    await cp(join(builtRoot, 'tools'), join(root, 'lib', 'tools'), { recursive: true });
    await writeFile(join(one, 'project.txt'), 'one\n'); await writeFile(join(two, 'project.txt'), 'two\n');

    const stableSentinel = join(home, '.config', 'opencode', 'opencode.json');
    await writeFile(stableSentinel, JSON.stringify({ agents: { stable: { mode: 'primary', system: 'MUST_NOT_LOAD' } } }) + '\n', { mode: 0o600 });
    const stableHash = createHash('sha256').update(await readFile(stableSentinel)).digest('hex');

    const wrapper = join(temporary, 'sandboxed-native');
    const sandbox = '(version 1)(allow default)(deny network-outbound)(allow network-outbound (remote ip "localhost:*"))(allow network-outbound (remote unix-socket))';
    await writeFile(wrapper, `#!/bin/sh\nexec /usr/bin/sandbox-exec -p '${sandbox}' '${native}' "$@"\n`, { mode: 0o700 }); await chmod(wrapper, 0o700);
    await writeFile(join(root, 'host.json'), JSON.stringify({ root, executable: wrapper, executableHash: createHash('sha256').update(await readFile(wrapper)).digest('hex'), node: process.execPath, cli: join(root, 'lib', 'tools', 'naru-preview.mjs') }), { mode: 0o600 });
    await writeFile(join(root, 'state.json'), JSON.stringify({ schemaVersion: 6, globalWorkerPool: { models: ['fixture/worker#high'], revision: 1 }, globalInstructions: { revision: 0, source: null }, repositories: [], tasks: [] }), { mode: 0o600 });
    const modelSource = join(temporary, 'models.json');
    await writeFile(modelSource, JSON.stringify({ fixture: { id: 'fixture', name: 'Fixture', env: [], npm: '@ai-sdk/openai-compatible', models: { worker: { id: 'worker', name: 'Fixture worker', release_date: '2026-09-13', attachment: false, reasoning: true, tool_call: true, modalities: { input: ['text'], output: ['text'] }, limit: { context: 200000, output: 8000 }, provider: { npm: '@ai-sdk/openai' } } } } }), { mode: 0o600 });

    environment = {
        ...cleanProcessEnvironment(process.execPath), HOME: home, TMPDIR: scratch, NARU_OC2_ROOT: root,
        OPENCODE_DISABLE_MODELS_FETCH: 'true', OPENCODE_MODELS_PATH: modelSource,
    };
    const routed = oc2NativeEnvironment(paths, environment), run = nodeSpawner(routed);

    const bare = launch([], one, environment);
    await waitFor(async () => {
        try {
            const profile = await loadOc2NativeModelProfile(root);
            if (profile?.models.join(',') !== 'fixture/worker#high') return null;
            const status = await run([wrapper, 'service', 'status'], { cwd: one, timeout: 3_000, maxBytes: 64 * 1024 });
            return status.ok ? true : null;
        } catch { return null; }
    }, 'bare production oc2 did not initialize the native profile and shared service');

    const first = launch(['naru', one], one, environment), second = launch(['naru', two], two, environment);
    const sessions = await waitFor(async () => {
        const result = await run([wrapper, 'api', 'GET', '/api/session'], { cwd: one, timeout: 3_000, maxBytes: 256 * 1024 });
        if (!result.ok) return null;
        let value: unknown; try { value = JSON.parse(result.stdout); } catch { return null; }
        const data = value && typeof value === 'object' && !Array.isArray(value) ? (value as { data?: unknown }).data : undefined;
        if (!Array.isArray(data)) return null;
        const selected = data.filter(session => session && typeof session === 'object' && (session as { agent?: unknown }).agent === 'naru');
        return [one, two].every(directory => selected.some(session => (session as { location?: { directory?: unknown } }).location?.directory === directory)) ? selected : null;
    }, 'production oc2 naru did not create sessions in both requested directories');

    const selected = (sessions as Array<{ id?: unknown; agent?: unknown; model?: unknown; location?: { directory?: unknown } }>).filter(session => [one, two].includes(String(session.location?.directory)));
    assert.equal(selected.length, 2); assert.notEqual(selected[0]!.id, selected[1]!.id);
    for (const session of selected) { assert.equal(session.agent, 'naru'); assert.equal(session.model, undefined); }
    assert.equal(createHash('sha256').update(await readFile(stableSentinel)).digest('hex'), stableHash);

    for (const child of [first, second, bare]) stopChild(child);
    const profileFiles = [paths.configFile, paths.ownership, paths.profileState];
    const beforeStop = await Promise.all(profileFiles.map(path => lstat(path, { bigint: true })));
    const stopped = await nodeSpawner(environment)([process.execPath, oc2, 'service', 'stop'], { cwd: one, timeout: 10_000, maxBytes: 64 * 1024 });
    assert.equal(stopped.ok, true, stopped.stderr || stopped.stdout);
    const afterStop = await Promise.all(profileFiles.map(path => lstat(path, { bigint: true })));
    for (let index = 0; index < beforeStop.length; index++) { assert.equal(afterStop[index]!.ino, beforeStop[index]!.ino); assert.equal(afterStop[index]!.mtimeNs, beforeStop[index]!.mtimeNs); }

    console.log(JSON.stringify({ status: 'PASS', native, service: 'bare production oc2 shared service', sessions: selected.map(session => ({ id: session.id, agent: session.agent, directory: session.location?.directory, model: session.model ?? null })), serviceStop: 'production oc2 service stop; profile unchanged', stableSentinel: 'unchanged', sandbox: 'loopback-only' }));
} finally {
    for (const child of children) stopChild(child);
    if (environment) try { await nodeSpawner(environment)([process.execPath, oc2, 'service', 'stop'], { cwd: one, timeout: 5_000, maxBytes: 16 * 1024 }); } catch {}
    await rm(temporary, { recursive: true, force: true });
}
