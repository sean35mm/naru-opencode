#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { createDryRunPlan } from '../tools/naru-lib/evaluation.mjs';
import { LIVE_EVALUATION_CASES } from '../tools/naru-lib/live-evaluation.mjs';
import { runOpenCodeLiveEvaluation } from '../tools/naru-lib/opencode-live-evaluation.mjs';

function usage() {
  return [
    'Usage:',
    '  node scripts/naru-live-eval.mjs --manifest <path> --dry-run',
    '  node scripts/naru-live-eval.mjs --live --case plan-fanout --dir <path> --confirm-provider-cost [--timeout-ms <ms>]',
  ].join('\n');
}

async function main(args) {
  const dryRun = args.includes('--dry-run');
  const live = args.includes('--live');
  const manifestIndex = args.indexOf('--manifest');
  if (dryRun === live) throw new Error(usage());

  if (dryRun) {
    if (manifestIndex === -1 || manifestIndex + 1 >= args.length || args.length !== 3) throw new Error(usage());
    const manifestPath = args[manifestIndex + 1];
    if (manifestPath.startsWith('-')) throw new Error(usage());
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    process.stdout.write(`${JSON.stringify(createDryRunPlan(manifest))}\n`);
    return;
  }

  if (!args.includes('--confirm-provider-cost')) {
    throw new Error('live evaluation requires --confirm-provider-cost because it launches paid provider sessions');
  }
  const caseIndex = args.indexOf('--case');
  const directoryIndex = args.indexOf('--dir');
  const timeoutIndex = args.indexOf('--timeout-ms');
  const caseId = args[caseIndex + 1];
  const directory = args[directoryIndex + 1];
  if (caseIndex === -1 || directoryIndex === -1 || !caseId || !directory || caseId.startsWith('-') || directory.startsWith('-')) {
    throw new Error(usage());
  }
  if (!LIVE_EVALUATION_CASES[caseId]) throw new Error(`unknown live evaluation case: ${caseId}`);
  const knownArgs = new Set(['--live', '--case', caseId, '--dir', directory, '--confirm-provider-cost']);
  let timeoutMs;
  if (timeoutIndex !== -1) {
    const rawTimeout = args[timeoutIndex + 1];
    timeoutMs = Number(rawTimeout);
    knownArgs.add('--timeout-ms');
    knownArgs.add(rawTimeout);
  }
  if (args.some((arg) => !knownArgs.has(arg))) throw new Error(usage());

  const report = await runOpenCodeLiveEvaluation({
    caseId,
    directory: resolve(directory),
    onProgress(event) {
      if (event.event === 'root-started') {
        process.stderr.write(`[naru-live-eval] root started: ${event.rootSessionId}\n`);
      } else if (event.event === 'descendants-observed') {
        process.stderr.write(`[naru-live-eval] observed ${event.added} new descendant(s), ${event.total} total\n`);
      } else if (event.event === 'completed') {
        process.stderr.write(`[naru-live-eval] completed with ${event.childCount} descendant(s): ${event.passed ? 'pass' : 'fail'}\n`);
      }
    },
    timeoutMs,
  });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!report.passed) process.exitCode = 1;
}

main(process.argv.slice(2)).catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 2;
});
