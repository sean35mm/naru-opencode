import { lstat, mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { evaluateOpenCodeVersion } from '../tools/naru-lib/compatibility.mjs';
import { PREVIEW_VERSION } from '../tools/naru-lib/preview-host.mjs';
import { cleanProcessEnvironment, nodeSpawner } from '../tools/naru-lib/preview-process.mjs';

const nativeSignatures = new Set(['cffaedfe', 'feedfacf', 'cefaedfe', 'feedface', 'cafebabe', 'cafebabf', 'bfbafeca', '7f454c46']);
const noEgressProfile = '(version 1)(allow default)(deny network-outbound)';

export async function validateSmokeNative(target: string): Promise<string> {
    if (process.platform !== 'darwin') throw new Error('Native smoke requires the certified macOS network sandbox');
    if (!isAbsolute(target)) throw new Error('Smoke target must be a canonical regular native executable');
    const info = await lstat(target);
    if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o111) === 0) throw new Error('Smoke target must be a canonical regular native executable');
    const native = await realpath(target);
    if (native !== target) throw new Error('Smoke target must be a canonical regular native executable');
    const bytes = await readFile(native);
    if (!nativeSignatures.has(bytes.subarray(0, 4).toString('hex'))) throw new Error('Smoke target must be a Mach-O or ELF native executable, not a wrapper');

    const temporary = await realpath(await mkdtemp('/tmp/naru-smoke-native-check-'));
    try {
        const environment = { ...cleanProcessEnvironment(process.execPath), HOME: temporary, XDG_CONFIG_HOME: temporary, XDG_DATA_HOME: temporary, XDG_CACHE_HOME: temporary, XDG_STATE_HOME: temporary, TMPDIR: temporary,
            OPENCODE_DB: join(temporary, 'opencode.db'), OPENCODE_DISABLE_AUTOUPDATE: 'true', OPENCODE_DISABLE_PROJECT_CONFIG: 'true' };
        const result = await nodeSpawner(environment)(['/usr/bin/sandbox-exec', '-p', noEgressProfile, native, '--version'], { cwd: temporary, timeout: 10_000 });
        if (!result.ok || evaluateOpenCodeVersion('v2-beta-exploratory', result.stdout).status !== 'supported') throw new Error(`Smoke target must be the exact native OpenCode ${PREVIEW_VERSION} binary`);
    } finally { await rm(temporary, { recursive: true, force: true }); }
    return native;
}
