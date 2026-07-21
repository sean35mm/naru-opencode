import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { basename } from 'node:path';

import {
  DEFAULT_SCHEDULER_BUDGETS,
  SCHEDULER_PROTOCOL_LIMITS,
  validateSchedulerBudgets,
} from './scheduler-protocol.mjs';

const MAX_CONFIG_BYTES = 64 * 1024;
const MODES = Object.freeze(['off', 'observe', 'enforce']);
const LEGACY_POLICIES = Object.freeze(['reject', 'observe']);
const WORKSPACE_MODES = Object.freeze(['auto', 'shared', 'worktree']);

export const DEFAULT_SCHEDULER_CONFIG = Object.freeze({
  mode: 'off',
  ...DEFAULT_SCHEDULER_BUDGETS,
  maxWorkItems: SCHEDULER_PROTOCOL_LIMITS.maxWorkItems,
  maxManifestBytes: SCHEDULER_PROTOCOL_LIMITS.maxManifestBytes,
  maxArtifactBytes: 64 * 1024,
  admissionTokenTtlMs: 5 * 60 * 1000,
  transitionTokenTtlMs: 5 * 60 * 1000,
  legacyProtocol2: 'reject',
});

export const DEFAULT_RUNTIME_CONFIG = Object.freeze({
  schemaVersion: 1,
  scheduler: DEFAULT_SCHEDULER_CONFIG,
  implementation: Object.freeze({
    workspaceMode: 'auto',
    maxConcurrentWriters: 6,
    maxWritersPerWorktree: 1,
    cleanWorkspaceRequired: true,
  }),
});

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertObject(value, label) {
  if (!isPlainObject(value)) throw new Error(`${label} must be a plain object`);
}

function assertAllowedKeys(value, fields, label) {
  const allowed = new Set(fields);
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length > 0) throw new Error(`${label} contains unknown fields: ${unknown.sort().join(', ')}`);
}

function integerOption(value, fallback, label, { minimum, maximum }) {
  const resolved = value === undefined ? fallback : value;
  if (!Number.isSafeInteger(resolved) || resolved < minimum || resolved > maximum) {
    throw new Error(`${label} must be an integer from ${minimum} to ${maximum}`);
  }
  return resolved;
}

function enumOption(value, fallback, allowed, label) {
  const resolved = value === undefined ? fallback : value;
  if (!allowed.includes(resolved)) throw new Error(`${label} must be one of ${allowed.join(', ')}`);
  return resolved;
}

export function parseSchedulerConfig(value) {
  if (value === undefined || value === null) return { ...DEFAULT_SCHEDULER_CONFIG };
  assertObject(value, 'scheduler config');
  assertAllowedKeys(value, Object.keys(DEFAULT_SCHEDULER_CONFIG), 'scheduler config');
  const config = {
    mode: enumOption(value.mode, DEFAULT_SCHEDULER_CONFIG.mode, MODES, 'scheduler.mode'),
    maxConcurrentWriters: integerOption(
      value.maxConcurrentWriters,
      DEFAULT_SCHEDULER_CONFIG.maxConcurrentWriters,
      'scheduler.maxConcurrentWriters',
      { minimum: 1, maximum: 10 },
    ),
    maxConcurrentReadOnly: integerOption(
      value.maxConcurrentReadOnly,
      DEFAULT_SCHEDULER_CONFIG.maxConcurrentReadOnly,
      'scheduler.maxConcurrentReadOnly',
      { minimum: 0, maximum: 4 },
    ),
    maxTotalChildren: integerOption(
      value.maxTotalChildren,
      DEFAULT_SCHEDULER_CONFIG.maxTotalChildren,
      'scheduler.maxTotalChildren',
      { minimum: 1, maximum: 14 },
    ),
    maxJudgePasses: integerOption(
      value.maxJudgePasses,
      DEFAULT_SCHEDULER_CONFIG.maxJudgePasses,
      'scheduler.maxJudgePasses',
      { minimum: 1, maximum: 3 },
    ),
    maxWorkItems: integerOption(
      value.maxWorkItems,
      DEFAULT_SCHEDULER_CONFIG.maxWorkItems,
      'scheduler.maxWorkItems',
      { minimum: 1, maximum: SCHEDULER_PROTOCOL_LIMITS.maxWorkItems },
    ),
    maxManifestBytes: integerOption(
      value.maxManifestBytes,
      DEFAULT_SCHEDULER_CONFIG.maxManifestBytes,
      'scheduler.maxManifestBytes',
      { minimum: 1024, maximum: 1024 * 1024 },
    ),
    maxArtifactBytes: integerOption(
      value.maxArtifactBytes,
      DEFAULT_SCHEDULER_CONFIG.maxArtifactBytes,
      'scheduler.maxArtifactBytes',
      { minimum: 1024, maximum: 256 * 1024 },
    ),
    admissionTokenTtlMs: integerOption(
      value.admissionTokenTtlMs,
      DEFAULT_SCHEDULER_CONFIG.admissionTokenTtlMs,
      'scheduler.admissionTokenTtlMs',
      { minimum: 1000, maximum: 24 * 60 * 60 * 1000 },
    ),
    transitionTokenTtlMs: integerOption(
      value.transitionTokenTtlMs,
      DEFAULT_SCHEDULER_CONFIG.transitionTokenTtlMs,
      'scheduler.transitionTokenTtlMs',
      { minimum: 1000, maximum: 24 * 60 * 60 * 1000 },
    ),
    legacyProtocol2: enumOption(
      value.legacyProtocol2,
      DEFAULT_SCHEDULER_CONFIG.legacyProtocol2,
      LEGACY_POLICIES,
      'scheduler.legacyProtocol2',
    ),
  };
  validateSchedulerBudgets({
    maxConcurrentWriters: config.maxConcurrentWriters,
    maxConcurrentReadOnly: config.maxConcurrentReadOnly,
    maxTotalChildren: config.maxTotalChildren,
    maxJudgePasses: config.maxJudgePasses,
  });
  if (config.mode === 'enforce' && config.legacyProtocol2 !== 'reject') {
    throw new Error('scheduler enforce mode must reject Protocol 2');
  }
  return config;
}

export function parseRuntimeConfig(value) {
  if (value === undefined || value === null) {
    return {
      schemaVersion: 1,
      scheduler: parseSchedulerConfig(),
      implementation: { ...DEFAULT_RUNTIME_CONFIG.implementation },
    };
  }
  assertObject(value, 'naru runtime config');
  assertAllowedKeys(value, ['schemaVersion', 'scheduler', 'implementation'], 'naru runtime config');
  if (value.schemaVersion !== undefined && value.schemaVersion !== 1) {
    throw new Error('naru runtime config schemaVersion must be 1');
  }
  const implementation = value.implementation ?? {};
  assertObject(implementation, 'implementation config');
  assertAllowedKeys(implementation, Object.keys(DEFAULT_RUNTIME_CONFIG.implementation), 'implementation config');
  if (implementation.cleanWorkspaceRequired !== undefined && implementation.cleanWorkspaceRequired !== true) {
    throw new Error('implementation.cleanWorkspaceRequired must be true');
  }
  return {
    schemaVersion: 1,
    scheduler: parseSchedulerConfig(value.scheduler),
    implementation: {
      workspaceMode: enumOption(
        implementation.workspaceMode,
        DEFAULT_RUNTIME_CONFIG.implementation.workspaceMode,
        WORKSPACE_MODES,
        'implementation.workspaceMode',
      ),
      maxConcurrentWriters: integerOption(
        implementation.maxConcurrentWriters,
        DEFAULT_RUNTIME_CONFIG.implementation.maxConcurrentWriters,
        'implementation.maxConcurrentWriters',
        { minimum: 1, maximum: 10 },
      ),
      maxWritersPerWorktree: integerOption(
        implementation.maxWritersPerWorktree,
        DEFAULT_RUNTIME_CONFIG.implementation.maxWritersPerWorktree,
        'implementation.maxWritersPerWorktree',
        { minimum: 1, maximum: 1 },
      ),
      cleanWorkspaceRequired: true,
    },
  };
}

function assertSafeConfigPath(path) {
  if (
    typeof path !== 'string' ||
    path.length === 0 ||
    path.length > 4096 ||
    /[\u0000-\u001f\u007f]/.test(path)
  ) {
    throw new Error('config path is invalid');
  }
  const name = basename(path);
  if (!name.endsWith('.json') || /(?:^|\.)(?:env|pem|key|p12|pfx)$/i.test(name)) {
    throw new Error('config path must identify a non-secret JSON file');
  }
}

export async function loadRuntimeConfigFile(path) {
  assertSafeConfigPath(path);
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const stats = await handle.stat();
    if (!stats.isFile()) throw new Error('config path must identify a regular file');
    if (stats.size > MAX_CONFIG_BYTES) throw new Error(`runtime config exceeds ${MAX_CONFIG_BYTES} bytes`);
    const text = await handle.readFile({ encoding: 'utf8' });
    if (Buffer.byteLength(text, 'utf8') > MAX_CONFIG_BYTES) {
      throw new Error(`runtime config exceeds ${MAX_CONFIG_BYTES} bytes`);
    }
    let value;
    try {
      value = JSON.parse(text);
    } catch {
      throw new Error('runtime config contains invalid JSON');
    }
    return parseRuntimeConfig(value);
  } finally {
    await handle.close();
  }
}

export async function loadSchedulerConfigFile(path) {
  return (await loadRuntimeConfigFile(path)).scheduler;
}

export const loadSchedulerConfig = loadSchedulerConfigFile;
export const SCHEDULER_CONFIG_MODES = MODES;
export const IMPLEMENTATION_WORKSPACE_MODES = WORKSPACE_MODES;
