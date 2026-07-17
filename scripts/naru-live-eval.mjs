#!/usr/bin/env node
import { readFile } from 'node:fs/promises';

import { createDryRunPlan } from '../tools/naru-lib/evaluation.mjs';

function usage() {
  return 'Usage: node scripts/naru-live-eval.mjs --manifest <path> --dry-run';
}

async function main(args) {
  const dryRun = args.includes('--dry-run');
  const manifestIndex = args.indexOf('--manifest');
  if (!dryRun) throw new Error('unsupported: only --dry-run is available; no live evaluation was started');
  if (manifestIndex === -1 || manifestIndex + 1 >= args.length || args.length !== 3) throw new Error(usage());
  const manifestPath = args[manifestIndex + 1];
  if (manifestPath.startsWith('-')) throw new Error(usage());
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  process.stdout.write(`${JSON.stringify(createDryRunPlan(manifest))}\n`);
}

main(process.argv.slice(2)).catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 2;
});
