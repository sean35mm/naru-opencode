import { stat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';

import { errEnvelope, okEnvelope } from './naru-lib/output.mjs';
import {
  cleanupWorktreeRun,
  createWorktreeRun,
  createWriterWorktree,
  finalizeWorktreeRun,
  integrateWriterWorktree,
  recoverWorktreeRun,
  worktreeRunSnapshot,
} from './naru-lib/worktree.mjs';
import { loadRuntimeConfigFile, parseRuntimeConfig } from './naru-lib/scheduler-config.mjs';

const TOOL_ID = 'naru-worktree';
const DEFAULT_CONFIG_PATH = fileURLToPath(new URL('../naru-runtime.json', import.meta.url));
const OPERATIONS = ['prepare_run', 'recover_run', 'prepare_item', 'integrate_item', 'snapshot', 'finalize_run', 'cleanup_run'];

async function runtimeConfig(context) {
  if (context?.runtimeConfig !== undefined) return parseRuntimeConfig(context.runtimeConfig);
  const path = context?.runtimeConfigPath ?? DEFAULT_CONFIG_PATH;
  try {
    return await loadRuntimeConfigFile(path);
  } catch (error) {
    if (error?.code === 'ENOENT' && path === DEFAULT_CONFIG_PATH) return parseRuntimeConfig();
    throw error;
  }
}

function validate(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('input must be an object');
  const operation = raw.operation;
  if (!OPERATIONS.includes(operation)) throw new Error(`operation must be one of ${OPERATIONS.join(', ')}`);
  const allowed = new Set(['operation', 'runId', 'itemId', 'ownedWriteScope']);
  const unknown = Object.keys(raw).filter((key) => !allowed.has(key));
  if (unknown.length) throw new Error(`input contains unknown fields: ${unknown.sort().join(', ')}`);
  if (typeof raw.runId !== 'string') throw new Error('runId is required');
  if (operation === 'prepare_item' || operation === 'integrate_item') {
    if (typeof raw.itemId !== 'string') throw new Error('itemId is required');
  }
  if (operation === 'prepare_item' && !Array.isArray(raw.ownedWriteScope)) {
    throw new Error('ownedWriteScope is required');
  }
  return raw;
}

function errorText(error) {
  return error instanceof Error ? error.message : String(error);
}

async function workspaceDirectory(context) {
  const directory = context.worktree ?? context.directory;
  if (typeof directory !== 'string' || !isAbsolute(directory) || directory.includes('\0')) {
    throw new Error('an absolute workspace directory is required');
  }
  const stats = await stat(directory);
  if (!stats.isDirectory()) throw new Error('workspace directory must be a directory');
  return directory;
}

export default {
  description: 'Manage clean-repository isolated Naru writer worktrees and serialized integration. Never pushes or creates delivery commits.',
  args: {
    input: {
      type: 'object',
      properties: {
        operation: { type: 'string', enum: OPERATIONS },
        runId: { type: 'string' },
        itemId: { type: 'string' },
        ownedWriteScope: { type: 'array', items: { type: 'string' } },
      },
      required: ['operation', 'runId'],
      additionalProperties: false,
    },
  },
  execute: async (args, context = {}) => {
    let input;
    try {
      if (context.agent !== 'naru-orchestrator') throw new Error('naru-worktree is restricted to naru-orchestrator');
      const directory = await workspaceDirectory(context);
      input = validate(args?.input);
      const config = await runtimeConfig(context);
      const implementation = config.implementation;
      if (implementation.workspaceMode === 'shared') throw new Error('isolated writer mode is disabled');
      const common = {
        runId: input.runId,
        spawn: context.spawn,
        stateRegistry: context.worktreeRegistry,
      };
      let data;
      switch (input.operation) {
        case 'prepare_run':
          data = await createWorktreeRun({
            ...common,
            directory,
            maxWriters: implementation.maxConcurrentWriters,
            worktreeRoot: context.worktreeRoot,
          });
          break;
        case 'prepare_item':
          data = await createWriterWorktree({
            ...common,
            itemId: input.itemId,
            ownedWriteScope: input.ownedWriteScope,
          });
          break;
        case 'recover_run':
          data = await recoverWorktreeRun({
            ...common,
            directory,
            worktreeRoot: context.worktreeRoot,
          });
          break;
        case 'integrate_item':
          data = await integrateWriterWorktree({ ...common, itemId: input.itemId });
          break;
        case 'snapshot':
          data = worktreeRunSnapshot(input.runId, context.worktreeRegistry);
          break;
        case 'finalize_run':
          data = await finalizeWorktreeRun(common);
          break;
        case 'cleanup_run':
          data = await cleanupWorktreeRun(common);
          break;
        default:
          throw new Error('unsupported operation');
      }
      return JSON.stringify(okEnvelope(TOOL_ID, data), null, 2);
    } catch (error) {
      return JSON.stringify(errEnvelope(TOOL_ID, errorText(error)), null, 2);
    }
  },
};
