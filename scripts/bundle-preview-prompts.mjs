import { randomBytes } from 'node:crypto';
import { rename, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const output = join(root, '.naru-build', 'tools', 'naru-lib', 'preview-wizard.mjs');
const temporary = `${output}.tmp-${process.pid}-${randomBytes(6).toString('hex')}`;

try {
  await build({
    entryPoints: [join(root, 'tools', 'naru-lib', 'preview-wizard.mts')],
    outfile: temporary,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node24',
    external: ['node:*'],
    legalComments: 'none',
    sourcemap: false,
  });
  await rename(temporary, output);
} finally {
  await rm(temporary, { force: true });
}
