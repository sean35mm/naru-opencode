import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { differentialSourceProof } from '../naru-preview.mjs';
import { loadOc2NativeModelProfile, updateOc2NativeProfile } from './oc2-native-config.mjs';
import { loadManagedModelSource, readManagedModelFeed, refreshManagedModelSource, type PreviewModelSource } from './preview-model-catalogue.mjs';
import { inspectOc2NativeDirectories, loadOc2Host, oc2NativeEnvironment, oc2NativePaths, type Oc2HostMetadata } from './oc2-profile.mjs';
import { diagnoseExactPreviewCatalogue, diagnosePreviewCatalogue, fetchPreviewCatalogue, startPreviewServer, type PreviewCatalogue } from './preview-process.mjs';
import { parseCatalogueReference } from './native-reader-projection.mjs';
import { selectValidModels, TerminalWizardPrompt, WizardCancelled, type WizardPrompt } from './preview-wizard.mjs';

type Management = 'configure' | 'models-list' | 'models-catalogue' | 'setup';
export interface NativeLaunchPlan { executable: string; argv: string[]; cwd: string; env: NodeJS.ProcessEnv; management?: Management; legacy?: true; selectNaruSession?: true; initializeProfile?: true; requiresNaruPool?: true }
export interface NativeLaunchTargets { root: string; legacy?: string }

const nativeSubcommands = new Set(['upgrade', 'update', 'uninstall', 'acp', 'api', 'debug', 'auth', 'mcp', 'plugin', 'models', 'stats', 'mini', 'run', 'session', 'service', 'pair', 'serve']);
function modelValues(args: string[]): string[] | null {
    const index = args.indexOf('--set');
    if (index < 0) return null;
    if (args.length !== 2 || index !== 0 || !args[1]) throw new Error('models --set requires one comma-separated list of exact provider/model#variant references');
    return args[1].split(',').map(value => value.trim()).filter(Boolean);
}
function isHelp(args: string[]): boolean { return args.some(value => value === '--help' || value === '-h' || value === '--version' || value === '-v'); }
function isTopLevelTui(args: string[]): boolean { return args.length === 0 || args[0]!.startsWith('-') || !nativeSubcommands.has(args[0]!); }
function naruTuiPlan(args: string[], cwd: string): { argv: string[]; cwd: string; select: boolean } {
    if (!isTopLevelTui(args) || args.some(value => value === '--continue' || value === '-c' || value === '--session' || value === '-s')) return { argv: [...args], cwd, select: false };
    if (args.length === 1 && !args[0]!.startsWith('-')) return { argv: [], cwd: resolve(cwd, args[0]!), select: true };
    return { argv: [...args], cwd, select: true };
}

export async function planOc2NativeLaunch(argv: string[], targets: NativeLaunchTargets, cwd = process.cwd(), sourceEnv: NodeJS.ProcessEnv = process.env): Promise<NativeLaunchPlan> {
    const root = resolve(targets.root), host = await loadOc2Host(root), paths = oc2NativePaths(host.root);
    await inspectOc2NativeDirectories(paths);
    const env = oc2NativeEnvironment(paths, sourceEnv);
    const naru = argv[0] === 'naru', args = naru ? argv.slice(1) : [...argv];
    if (naru && args[0] === 'legacy') {
        if (!targets.legacy) throw new Error('Legacy OC2 recovery launcher is unavailable');
        return { executable: targets.legacy, argv: args.slice(1), cwd, env: sourceEnv, legacy: true };
    }
    if (naru && args[0] === 'setup') return { executable: host.executable, argv: [], cwd, env, management: 'setup' };
    if (naru && args[0] === 'configure') {
        if (args.length !== 1) throw new Error('oc2 naru configure does not accept additional arguments');
        return { executable: host.executable, argv: [], cwd, env, management: 'configure' };
    }
    if (naru && args[0] === 'models') {
        if (args.length === 2 && args[1] === '--list') return { executable: host.executable, argv: [], cwd, env, management: 'models-list' };
        const selected = modelValues(args.slice(1));
        if (selected) return { executable: host.executable, argv: ['--set', selected.join(',')], cwd, env, management: 'setup' };
        if (args.slice(1).some(value => value === '--refresh' || value === '--check' || value === '--search')) return { executable: host.executable, argv: args.slice(1), cwd, env, management: 'models-catalogue' };
        if (args.length > 1) throw new Error('Unknown native model option; use --list, --set, --refresh, --check, or --search');
        return { executable: host.executable, argv: [], cwd, env, management: process.stdin.isTTY && process.stdout.isTTY ? 'configure' : 'models-list' };
    }
    if (naru && args[0] === 'run') {
        if (args.slice(1).some(value => value === '--agent' || value === '-a' || value.startsWith('--agent='))) throw new Error('oc2 naru run always uses agent "naru"; remove the additional --agent option');
        return { executable: host.executable, argv: ['run', '--agent', 'naru', ...args.slice(1)], cwd, env, initializeProfile: true, requiresNaruPool: true };
    }
    if (naru) {
        const tui = naruTuiPlan(args, cwd);
        return { executable: host.executable, argv: tui.argv, cwd: tui.cwd, env, ...(tui.select ? { selectNaruSession: true as const, initializeProfile: true as const, requiresNaruPool: true as const } : {}) };
    }
    const initializeProfile = !isHelp(args) && isTopLevelTui(args);
    return { executable: host.executable, argv: args, cwd, env, ...(initializeProfile ? { initializeProfile: true as const } : {}) };
}

async function verifyHost(host: Oc2HostMetadata): Promise<void> {
    const digest = createHash('sha256').update(await readFile(host.executable)).digest('hex');
    if (digest !== host.executableHash) throw new Error('OC2 native executable does not match host metadata');
}
async function waitForConcurrentInitialization(root: string): Promise<Awaited<ReturnType<typeof loadOc2NativeModelProfile>>> {
    const lock = oc2NativePaths(root).lock;
    for (let attempt = 0; attempt < 50; attempt++) {
        try { await lstat(lock); }
        catch (error) {
            if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return ensureInitialized(root);
            throw error;
        }
        await new Promise(resolvePromise => setTimeout(resolvePromise, 20));
    }
    return null;
}

async function ensureInitialized(root: string): Promise<Awaited<ReturnType<typeof loadOc2NativeModelProfile>>> {
    let existing: Awaited<ReturnType<typeof loadOc2NativeModelProfile>> = null;
    try { existing = await loadOc2NativeModelProfile(root); }
    catch (error) { if (!(error instanceof Error) || !/interrupted transaction/.test(error.message)) throw error; }
    if (existing) return existing;
    try { return await updateOc2NativeProfile(root); }
    catch (error) {
        if (!(error instanceof Error) || !/Another OC2 native profile update is active/.test(error.message)) throw error;
        const initialized = await waitForConcurrentInitialization(root);
        if (initialized) return initialized;
        throw error;
    }
}
async function configureModels(plan: NativeLaunchPlan, root: string, prompt: WizardPrompt = new TerminalWizardPrompt()): Promise<void> {
    if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error('Interactive global model configuration requires a TTY. For scripts use: oc2 naru models --set provider/model#variant[,provider/model#variant]');
    const current = await ensureInitialized(root);
    let server: Awaited<ReturnType<typeof startPreviewServer>> | undefined;
    try {
        server = await startPreviewServer(plan.executable, plan.cwd, plan.env, 'catalogue');
        const catalogue = await fetchPreviewCatalogue(server.url, plan.cwd, server.headers);
        const models = await selectValidModels(prompt, catalogue.models, current!.models);
        prompt.message(`Global native models: ${models.join(', ')}\nOne reader, runner, and writer definition will be projected for each exact reference. Existing OpenCode services and sessions are not restarted or changed.`);
        if (!await prompt.confirm('Save these global worker models?')) throw new WizardCancelled();
        await updateOc2NativeProfile(root, models);
        prompt.message('Global native models saved. Restart any active OC2 service, then start a new session to load the refreshed projection.');
    } finally { server?.stop(); }
}
function spawnInherited(plan: NativeLaunchPlan): Promise<number> {
    return new Promise((resolvePromise, reject) => {
        const child = spawn(plan.executable, plan.argv, { cwd: plan.cwd, env: plan.env, stdio: 'inherit' });
        child.once('error', reject);
        child.once('exit', (code, signal) => signal ? reject(new Error(`OC2 native host terminated by ${signal}`)) : resolvePromise(code ?? 1));
    });
}
async function capture(executable: string, argv: string[], cwd: string, env: NodeJS.ProcessEnv): Promise<string> {
    return new Promise((resolvePromise, reject) => {
        const child = spawn(executable, argv, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
        let stdout = '', stderr = '', bytes = 0, settled = false;
        const finish = (run: () => void) => { if (!settled) { settled = true; clearTimeout(timer); run(); } };
        const timer = setTimeout(() => { child.kill('SIGTERM'); finish(() => reject(new Error('OC2 session creation timed out'))); }, 30_000);
        child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
        child.stdout.on('data', chunk => { bytes += Buffer.byteLength(chunk); if (bytes > 1024 * 1024) child.kill('SIGTERM'); else stdout += chunk; });
        child.stderr.on('data', chunk => { if (Buffer.byteLength(stderr) < 64 * 1024) stderr += chunk; });
        child.once('error', error => finish(() => reject(error)));
        child.once('exit', code => finish(() => code === 0 && bytes <= 1024 * 1024 ? resolvePromise(stdout) : reject(new Error(`OC2 session creation failed${stderr.trim() ? `: ${stderr.trim().slice(0, 512)}` : ''}`))));
    });
}
async function selectNaruSession(plan: NativeLaunchPlan): Promise<void> {
    const output = await capture(plan.executable, ['api', 'POST', '/api/session', '--data', JSON.stringify({ agent: 'naru', location: { directory: plan.cwd } })], plan.cwd, plan.env);
    let value: unknown;
    try { value = JSON.parse(output); } catch { throw new Error('OC2 session creation returned malformed JSON'); }
    const data = value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>).data : undefined;
    if (!data || typeof data !== 'object' || Array.isArray(data) || typeof (data as Record<string, unknown>).id !== 'string' || (data as Record<string, unknown>).agent !== 'naru') throw new Error('OC2 session creation did not select the Naru agent');
    plan.argv = [...plan.argv, '--session', (data as Record<string, unknown>).id as string];
}

async function observeCatalogue(plan: NativeLaunchPlan, source?: PreviewModelSource | null): Promise<PreviewCatalogue> {
    const env = { ...plan.env };
    if (source) { env.OPENCODE_MODELS_PATH = source.path; env.OPENCODE_DISABLE_MODELS_FETCH = 'true'; }
    let server: Awaited<ReturnType<typeof startPreviewServer>> | undefined;
    try { server = await startPreviewServer(plan.executable, plan.cwd, env, 'catalogue'); return await fetchPreviewCatalogue(server.url, plan.cwd, server.headers); }
    finally { server?.stop(); }
}
function modelOption(args: string[], name: '--check' | '--search'): string | undefined {
    const index = args.indexOf(name); if (index < 0) return undefined;
    const value = args[index + 1]; if (!value || value.startsWith('--')) throw new Error(`${name} requires a value`);
    args.splice(index, 2); return value;
}
async function manageCatalogue(plan: NativeLaunchPlan, host: Oc2HostMetadata): Promise<void> {
    const args = [...plan.argv], check = modelOption(args, '--check'), search = modelOption(args, '--search');
    if (check && search) throw new Error('models accepts either --check REF or --search NAME, not both');
    const refreshIndex = args.indexOf('--refresh'), refresh = refreshIndex >= 0;
    if (refresh) args.splice(refreshIndex, 1);
    if (args.length) throw new Error('models accepts --refresh and one optional --check REF or --search NAME');
    if (search && (!search.length || search.length > 256 || /[\u0000-\u001f\u007f-\u009f]/u.test(search))) throw new Error('models --search requires 1–256 safe characters');
    let source = await loadManagedModelSource(host.root);
    if (refresh) source = await refreshManagedModelSource(host.root, candidate => differentialSourceProof(host, candidate));
    const catalogue = await observeCatalogue(plan, source), entries = source ? (await readManagedModelFeed(source)).entries : [];
    const diagnostic = check ? diagnoseExactPreviewCatalogue(parseCatalogueReference(check), catalogue, entries)
        : search ? diagnosePreviewCatalogue(search, catalogue, entries) : undefined;
    process.stdout.write(JSON.stringify({ ...(source ? { source: { digest: source.digest, bytes: source.bytes, requestedAt: source.requestedAt, completedAt: source.completedAt, outcome: source.outcome, upstreamFreshness: 'unknown', accountAccess: 'unknown' } } : { source: { management: 'host-managed-unverified', upstreamFreshness: 'unknown', accountAccess: 'unknown' } }), observedAt: catalogue.observedAt, eligibleModels: catalogue.models.length, ...(diagnostic ? { diagnostic } : {}) }, null, 2) + '\n');
}

export async function runOc2Native(argv: string[], targets: NativeLaunchTargets): Promise<number> {
    const plan = await planOc2NativeLaunch(argv, targets);
    if (plan.legacy) return spawnInherited(plan);
    const host = await loadOc2Host(targets.root); await verifyHost(host);
    if (plan.management === 'models-list') {
        const profile = await loadOc2NativeModelProfile(host.root);
        process.stdout.write(profile?.models.length ? profile.models.join('\n') + '\n' : 'No initialized global native model pool. Run "oc2 naru configure" or "oc2 naru models --set ...". Bare oc2 remains available.\n');
        return 0;
    }
    if (plan.management === 'models-catalogue') { await manageCatalogue(plan, host); return 0; }
    if (plan.management === 'setup') {
        const set = plan.argv[0] === '--set' ? plan.argv[1]!.split(',') : undefined;
        const profile = await updateOc2NativeProfile(host.root, set);
        process.stdout.write(`OC2 native profile ready with ${profile.models.length} global model${profile.models.length === 1 ? '' : 's'}. Active services were not restarted.\n`);
        return 0;
    }
    if (plan.management === 'configure') {
        try { await configureModels(plan, host.root); return 0; }
        catch (error) { if (error instanceof WizardCancelled) { process.stdout.write('Global native model configuration cancelled; no model changes were saved.\n'); return 0; } throw error; }
    }
    let profile = plan.initializeProfile ? await ensureInitialized(host.root) : null;
    if (plan.requiresNaruPool && !profile?.models.length) {
        if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error('Naru has no global native models. Run "oc2 naru models --set ..." first. Bare oc2 remains available for native OpenCode.');
        await configureModels(plan, host.root); profile = await loadOc2NativeModelProfile(host.root);
    }
    if (plan.selectNaruSession) await selectNaruSession(plan);
    return spawnInherited(plan);
}
