#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateOfficialModelFeed } from '../tools/naru-lib/preview-model-catalogue.mjs';
import { cleanProcessEnvironment, differentialCatalogueWitness, fetchPreviewCatalogue, waitForPreviewReadiness } from '../tools/naru-lib/preview-process.mjs';
import { validateSmokeNative } from './naru-smoke-native.mjs';

const nativeArgument = process.argv[2];
if (!nativeArgument) throw new Error('Usage: node scripts/naru-native-catalogue-smoke.mjs /absolute/path/to/opencode2-beta-19425');
const native = await validateSmokeNative(nativeArgument);
const root = await realpath(await mkdtemp('/tmp/naru-native-catalogue-smoke-'));
const fixturePath = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'tests', 'fixtures', 'current-public-models.json');
const sandbox = '(version 1)(allow default)(deny network-outbound)(allow network-outbound (remote ip "localhost:*"))(allow network-outbound (remote unix-socket))';
async function observe(name: 'baseline' | 'candidate', source: Record<string, unknown>) {
    const hostRoot = join(root, name), home = join(hostRoot, 'home'), configRoot = join(hostRoot, 'config'), dataRoot = join(hostRoot, 'data'), cacheRoot = join(hostRoot, 'cache'), stateRoot = join(hostRoot, 'state'), temporary = join(hostRoot, 'tmp');
    for (const path of [home, configRoot, dataRoot, cacheRoot, stateRoot, temporary, join(configRoot, 'opencode')]) await mkdir(path, { recursive: true, mode: 0o700 });
    const sourcePath = join(hostRoot, 'models.json');
    await writeFile(sourcePath, JSON.stringify(validateOfficialModelFeed(source).value), { mode: 0o600 });
    await writeFile(join(configRoot, 'opencode', 'opencode.json'), JSON.stringify({ update: 'disable', providers: { openai: { settings: { baseURL: 'http://127.0.0.1:9/validation-only' } } } }), { mode: 0o600 });
    const password = randomBytes(32).toString('hex');
    const environment = {
        ...cleanProcessEnvironment(process.execPath), HOME: home, XDG_CONFIG_HOME: configRoot, XDG_DATA_HOME: dataRoot, XDG_CACHE_HOME: cacheRoot, XDG_STATE_HOME: stateRoot, TMPDIR: temporary,
        OPENCODE_DB: join(hostRoot, 'opencode.db'), OPENCODE_DISABLE_AUTOUPDATE: 'true', OPENCODE_DISABLE_PROJECT_CONFIG: 'true', OPENCODE_DISABLE_MODELS_FETCH: 'true', OPENCODE_MODELS_PATH: sourcePath, OPENCODE_PASSWORD: password,
    };
    const processChild = spawn('/usr/bin/sandbox-exec', ['-p', sandbox, native, 'serve', '--stdio', '--hostname', '127.0.0.1', '--port', '0'], { cwd: hostRoot, env: environment, detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
    processChild.stderr!.resume();
    try {
        const url = await new Promise<string>((resolvePromise, reject) => {
            let buffer = '';
            const timeout = setTimeout(() => reject(new Error(`Native ${name} catalogue server startup timed out`)), 20_000);
            const finish = (value?: string) => { clearTimeout(timeout); value ? resolvePromise(value) : reject(new Error(`Native ${name} catalogue server failed to start`)); };
            processChild.once('error', () => finish()); processChild.once('close', () => finish());
            processChild.stdout!.on('data', chunk => {
                buffer += chunk.toString();
                for (const line of buffer.split('\n')) {
                    try { const parsed = JSON.parse(line); if (typeof parsed.url === 'string' && /^http:\/\/127\.0\.0\.1:\d+$/.test(parsed.url)) return finish(parsed.url); } catch {}
                }
            });
        });
        const headers = { authorization: 'Basic ' + Buffer.from(`opencode:${password}`).toString('base64') };
        await waitForPreviewReadiness(url, hostRoot, headers, 'catalogue');
        const catalogue = await fetchPreviewCatalogue(url, hostRoot, headers);
        const response = await fetch(`${url}/api/model?location%5Bdirectory%5D=${encodeURIComponent(hostRoot)}`, { headers });
        assert.equal(response.status, 200);
        const raw = await response.json() as { data: Array<Record<string, any>> };
        return { catalogue, byReference: new Map(raw.data.map(model => [`${model.providerID}/${model.id}`, model])) };
    } finally {
        processChild.stdin?.end();
        if (processChild.pid) { try { process.kill(-processChild.pid, 'SIGKILL'); } catch {} }
    }
}
try {
    const candidateSource = JSON.parse(await readFile(fixturePath, 'utf8'));
    const baselineSource = structuredClone(candidateSource);
    for (const model of Object.values(baselineSource.openai.models) as Array<Record<string, unknown>>) delete model.experimental;
    const baseline = await observe('baseline', baselineSource), candidate = await observe('candidate', candidateSource);
    const sourceEntries = validateOfficialModelFeed(candidateSource).entries.filter(entry => entry.providerID === 'openai');
    assert.ok(differentialCatalogueWitness(sourceEntries, baseline.catalogue, candidate.catalogue));
    for (const family of ['sol', 'luna', 'terra']) {
        const base = `openai/gpt-5.6-${family}`, fast = `${base}-fast`;
        assert.ok(baseline.byReference.has(base), base); assert.equal(baseline.byReference.has(fast), false); assert.equal(baseline.byReference.has(`${base}-pro`), false);
        assert.ok(candidate.byReference.has(base), base); assert.ok(candidate.byReference.has(fast), fast); assert.ok(candidate.byReference.has(`${base}-pro`), `${base}-pro`);
        assert.deepEqual(candidate.byReference.get(fast)!.variants.map((variant: { id: string }) => variant.id).filter((id: string) => ['medium', 'high', 'xhigh', 'max'].includes(id)), ['medium', 'high', 'xhigh', 'max']);
        assert.deepEqual(candidate.byReference.get(fast)!.body, { service_tier: 'priority' });
        assert.deepEqual(candidate.byReference.get(`${base}-pro`)!.body, { reasoning: { mode: 'pro' } });
        assert.equal(candidate.byReference.get(fast)!.modelID, `gpt-5.6-${family}`);
    }
    assert.deepEqual(candidate.byReference.get('openai/gpt-5.6-sol-fast')!.cost[0], { input: 8, output: 40, cache: { read: 0.8, write: 10 } });
    assert.ok(candidate.catalogue.models.some(model => model.reference === 'openai/gpt-5.6-sol-fast' && model.variantIDs.includes('max')));
    console.log(JSON.stringify({ native, sandbox: 'loopback-only', credentials: 'none', cleanHosts: ['baseline', 'candidate'], baseline: ['openai/gpt-5.6-sol'], candidate: ['openai/gpt-5.6-sol', 'openai/gpt-5.6-sol-fast', 'openai/gpt-5.6-sol-pro', 'openai/gpt-5.6-luna-fast', 'openai/gpt-5.6-terra-fast'], fastCost: candidate.byReference.get('openai/gpt-5.6-sol-fast')!.cost[0], fastBody: candidate.byReference.get('openai/gpt-5.6-sol-fast')!.body }));
} finally {
    await rm(root, { recursive: true, force: true });
}
