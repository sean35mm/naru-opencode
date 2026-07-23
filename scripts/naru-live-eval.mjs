#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { createDryRunPlan } from '../tools/naru-lib/evaluation.mjs';
import { createLiveRunContract } from '../tools/naru-lib/live-evaluation.mjs';
import { runOpenCodeLiveEvaluation } from '../tools/naru-lib/opencode-live-evaluation.mjs';

function usage() {
  return [
    'Usage:',
    '  node scripts/naru-live-eval.mjs --manifest <path> --dry-run',
    '  node scripts/naru-live-eval.mjs --live --manifest <path> --fixtures <path> --contract <path>',
    '    --contract-sha256 <sha256> --confirm-contract-digest <sha256> --confirm-provider-cost',
    '    [--opencode-executable <path-or-name>]',
    '  node scripts/naru-live-eval.mjs --prepare-contract --manifest <path> --fixtures <path>',
    '    --candidate-id <id> --candidate-revision <id> --candidate-digest <sha256>',
    '    --opencode-version <version> --opencode-digest <sha256> --provider <id> --provider-version <version>',
    '    --model <id> --model-version <version>',
    '    [--repetitions <1-3>] [--case-timeout-ms <ms>] [--request-timeout-ms <ms>]',
    '    [--max-spend-usd-micros <integer>] [--max-cost-per-request-usd-micros <integer>]',
    '    [--network-mode <none|provider> --network-target <target>] [--baseline <single-agent-opencode|none>]',
    '    [--allow-env <comma-separated-names>]',
    '',
    'Contract preparation prints JSON and its exact stdout SHA-256. It never invokes OpenCode or a provider.',
    'Legacy bare --live is refused. Live traffic from this adapter is loopback-only and may cause provider cost.',
  ].join('\n');
}

function parseOptions(args) {
  const flags = new Set(['--dry-run', '--prepare-contract', '--live', '--confirm-provider-cost']);
  const values = new Map();
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (flags.has(argument)) {
      if (values.has(argument)) throw new Error(usage());
      values.set(argument, true);
      continue;
    }
    if (!argument.startsWith('--') || index + 1 >= args.length || args[index + 1].startsWith('--') || values.has(argument)) {
      throw new Error(usage());
    }
    values.set(argument, args[index + 1]);
    index += 1;
  }
  return values;
}

function required(options, name) {
  const value = options.get(name);
  if (typeof value !== 'string' || !value) throw new Error(usage());
  return value;
}

function optionalInteger(options, name, fallback) {
  if (!options.has(name)) return fallback;
  const value = Number(options.get(name));
  if (!Number.isSafeInteger(value)) throw new Error(`${name} must be an integer`);
  return value;
}

function environmentNames(value) {
  if (value === undefined || value === '') return [];
  const names = value.split(',');
  if (names.some((name) => !name)) throw new Error('--allow-env must contain comma-separated environment names');
  return names;
}

async function main(args) {
  const options = parseOptions(args);
  const dryRun = options.has('--dry-run');
  const prepare = options.has('--prepare-contract');
  const live = options.has('--live');
  if ([dryRun, prepare, live].filter(Boolean).length !== 1) throw new Error(usage());
  if (live && (!options.has('--contract') || !options.has('--contract-sha256')
    || !options.has('--confirm-contract-digest') || !options.has('--confirm-provider-cost'))) {
    throw new Error(`Legacy bare --live is unsafe and no longer supported. Prepare and review a contract, then supply its exact file SHA-256, contract digest, and --confirm-provider-cost.\n${usage()}`);
  }
  const manifestPath = required(options, '--manifest');
  const specification = JSON.parse(await readFile(manifestPath, 'utf8'));

  if (dryRun) {
    if (options.size !== 2) throw new Error(usage());
    process.stdout.write(`${JSON.stringify(createDryRunPlan(specification))}\n`);
    return;
  }


  if (live) {
    const allowed = new Set([
      '--live', '--manifest', '--fixtures', '--contract', '--contract-sha256',
      '--confirm-contract-digest', '--confirm-provider-cost', '--opencode-executable',
    ]);
    if ([...options.keys()].some((name) => !allowed.has(name))) throw new Error(usage());
    const controller = new AbortController();
    const cancel = () => controller.abort();
    process.once('SIGINT', cancel);
    process.once('SIGTERM', cancel);
    try {
      const report = await runOpenCodeLiveEvaluation({
        contractPath: resolve(required(options, '--contract')),
        confirmationSha256: required(options, '--contract-sha256'),
        contractDigestConfirmation: required(options, '--confirm-contract-digest'),
        specification,
        fixturesRoot: resolve(required(options, '--fixtures')),
        opencodeExecutable: options.get('--opencode-executable') ?? 'opencode',
        signal: controller.signal,
      });
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
      if (!report.aggregate.passed) process.exitCode = 1;
      return;
    } finally {
      process.removeListener('SIGINT', cancel);
      process.removeListener('SIGTERM', cancel);
    }
  }

  const allowed = new Set([
    '--prepare-contract', '--manifest', '--fixtures', '--candidate-id', '--candidate-revision', '--candidate-digest',
    '--opencode-version', '--opencode-digest', '--provider', '--provider-version', '--model', '--model-version', '--repetitions',
    '--case-timeout-ms', '--request-timeout-ms', '--max-spend-usd-micros', '--max-cost-per-request-usd-micros',
    '--network-mode', '--network-target', '--baseline', '--allow-env',
  ]);
  if ([...options.keys()].some((name) => !allowed.has(name))) throw new Error(usage());
  const networkMode = options.get('--network-mode') ?? 'none';
  const networkTarget = options.get('--network-target') ?? 'none';
  const contract = await createLiveRunContract({
    specification,
    fixturesRoot: resolve(required(options, '--fixtures')),
    candidate: {
      id: required(options, '--candidate-id'),
      revision: required(options, '--candidate-revision'),
      digest: required(options, '--candidate-digest'),
    },
    opencode: {
      id: 'opencode',
      version: required(options, '--opencode-version'),
      executableDigest: required(options, '--opencode-digest'),
    },
    provider: { id: required(options, '--provider'), version: required(options, '--provider-version') },
    model: { id: required(options, '--model'), version: required(options, '--model-version') },
    repetitions: optionalInteger(options, '--repetitions', 1),
    caseTimeoutMs: optionalInteger(options, '--case-timeout-ms', 60_000),
    requestTimeoutMs: optionalInteger(options, '--request-timeout-ms', 30_000),
    maxSpendUsdMicros: optionalInteger(options, '--max-spend-usd-micros', 0),
    maxCostPerRequestUsdMicros: optionalInteger(options, '--max-cost-per-request-usd-micros', 0),
    network: { mode: networkMode, target: networkTarget },
    baselineKind: options.get('--baseline') ?? 'single-agent-opencode',
    allowedEnvironmentKeys: environmentNames(options.get('--allow-env')),
  });
  const output = `${JSON.stringify(contract, null, 2)}\n`;
  const authorizationSha256 = createHash('sha256').update(output).digest('hex');
  process.stdout.write(output);
  process.stderr.write(`[naru-live-eval] exact stdout authorization SHA-256: ${authorizationSha256}\n`);
}

main(process.argv.slice(2)).catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 2;
});
