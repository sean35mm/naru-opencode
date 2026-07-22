import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { errEnvelope, okEnvelope } from './naru-lib/output.mjs';
import {
  SCHEDULING_PROTOCOL,
  adaptProtocol2Run,
  isSchedulerId,
  validateAdmissionTokenV1,
  validateArtifactV1,
  validateRunManifestV1,
  validateTransitionTokenV1,
  validateWorkItemV1,
} from './naru-lib/scheduler-protocol.mjs';
import {
  admissionDecision,
  createSchedulerState,
  reduceSchedulerState,
} from './naru-lib/scheduler-state.mjs';
import {
  DEFAULT_SCHEDULER_CONFIG,
  loadSchedulerConfigFile,
  parseSchedulerConfig,
  resolveSchedulerBudgets,
} from './naru-lib/scheduler-config.mjs';
import {
  addAdmissionMarker,
  admissionClaimsForWorkItem,
  ensureSchedulerRootCapacity,
  getSchedulerRuntimeRegistry,
  probeSchedulerRuntime,
  pruneSchedulerRuntime,
  reserveAdmission,
} from './naru-lib/scheduler-token.mjs';
import { appendSchedulerJournal, schedulerJournalSnapshot } from './naru-lib/scheduler-journal.mjs';

const TOOL_ID = 'naru-scheduler';
const AUTHORIZED_AGENT = 'naru-orchestrator';
const DEFAULT_CONFIG_PATH = fileURLToPath(new URL('../naru-runtime.json', import.meta.url));
const OPERATIONS = Object.freeze([
  'create_run',
  'declare_items',
  'issue_admission',
  'request_transition',
  'append_artifact',
  'snapshot',
  'freeze',
  'close',
]);

function plainObject(value, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be a plain object`);
  }
}

function exactInput(value, allowed, required) {
  plainObject(value, 'input');
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) throw new Error(`input contains unknown fields: ${unknown.sort().join(', ')}`);
  const missing = required.filter((key) => !Object.hasOwn(value, key));
  if (missing.length > 0) throw new Error(`input is missing required fields: ${missing.join(', ')}`);
}

function safeRevision(value, label = 'expectedRevision') {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label} must be a non-negative safe integer`);
  return value;
}

function safeId(value, label) {
  if (!isSchedulerId(value)) throw new Error(`${label} is not a valid scheduler ID`);
  return value;
}

function safeContextId(value, label) {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 256 ||
    value.trim() !== value ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new Error(`${label} is not a valid runtime ID`);
  }
  return value;
}

function safeDirectory(value) {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 4096 ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new Error('context.directory is not valid');
  }
  return value;
}

function validateOperation(raw, config) {
  plainObject(raw, 'input');
  if (!OPERATIONS.includes(raw.operation)) throw new Error(`operation must be one of ${OPERATIONS.join(', ')}`);
  switch (raw.operation) {
    case 'create_run':
      exactInput(raw, ['operation', 'runId', 'schedulingProtocol', 'revision', 'budgets'], ['operation', 'runId', 'schedulingProtocol']);
      return {
        operation: raw.operation,
        runId: safeId(raw.runId, 'runId'),
        schedulingProtocol: raw.schedulingProtocol,
        revision: raw.revision === undefined ? 0 : safeRevision(raw.revision, 'revision'),
        budgets: resolveSchedulerBudgets(raw.budgets, config),
      };
    case 'declare_items':
      exactInput(raw, ['operation', 'runId', 'expectedRevision', 'workItems'], ['operation', 'runId', 'expectedRevision', 'workItems']);
      if (!Array.isArray(raw.workItems)) throw new Error('workItems must be an array');
      return {
        operation: raw.operation,
        runId: safeId(raw.runId, 'runId'),
        expectedRevision: safeRevision(raw.expectedRevision),
        workItems: raw.workItems.map(validateWorkItemV1),
      };
    case 'issue_admission':
      exactInput(
        raw,
        ['operation', 'runId', 'workItemId', 'expectedRevision', 'lane', 'target'],
        ['operation', 'runId', 'workItemId', 'expectedRevision', 'lane', 'target'],
      );
      if (raw.lane !== 'writer' && raw.lane !== 'read-only') throw new Error('lane must be writer or read-only');
      return {
        operation: raw.operation,
        runId: safeId(raw.runId, 'runId'),
        workItemId: safeId(raw.workItemId, 'workItemId'),
        expectedRevision: safeRevision(raw.expectedRevision),
        lane: raw.lane,
        target: safeId(raw.target, 'target'),
      };
    case 'request_transition':
      exactInput(
        raw,
        ['operation', 'runId', 'workItemId', 'expectedRevision', 'admissionTokenId', 'toStatus'],
        ['operation', 'runId', 'workItemId', 'expectedRevision', 'admissionTokenId', 'toStatus'],
      );
      return {
        operation: raw.operation,
        runId: safeId(raw.runId, 'runId'),
        workItemId: safeId(raw.workItemId, 'workItemId'),
        expectedRevision: safeRevision(raw.expectedRevision),
        admissionTokenId: safeId(raw.admissionTokenId, 'admissionTokenId'),
        toStatus: raw.toStatus,
      };
    case 'append_artifact':
      exactInput(raw, ['operation', 'runId', 'token', 'artifact'], ['operation', 'runId', 'artifact']);
      {
        const artifact = validateArtifactV1(raw.artifact, { maxBytes: config.maxArtifactBytes });
        if (artifact.artifactType === 'transition' && raw.token === undefined) {
          throw new Error('transition artifact requires a transition token');
        }
        if (artifact.artifactType !== 'transition' && raw.token !== undefined) {
          throw new Error('quality artifact cannot include a transition token');
        }
        return {
          operation: raw.operation,
          runId: safeId(raw.runId, 'runId'),
          token: raw.token === undefined ? null : validateTransitionTokenV1(raw.token),
          artifact,
        };
      }
    case 'snapshot':
      exactInput(raw, ['operation', 'runId'], ['operation', 'runId']);
      return { operation: raw.operation, runId: safeId(raw.runId, 'runId') };
    case 'freeze':
      exactInput(
        raw,
        ['operation', 'runId', 'workItemId', 'expectedRevision', 'reason'],
        ['operation', 'runId', 'workItemId', 'expectedRevision', 'reason'],
      );
      if (typeof raw.reason !== 'string' || raw.reason.length === 0 || raw.reason.length > 512) {
        throw new Error('reason is invalid');
      }
      return {
        operation: raw.operation,
        runId: safeId(raw.runId, 'runId'),
        workItemId: safeId(raw.workItemId, 'workItemId'),
        expectedRevision: safeRevision(raw.expectedRevision),
        reason: raw.reason,
      };
    case 'close':
      exactInput(raw, ['operation', 'runId', 'expectedRevision'], ['operation', 'runId', 'expectedRevision']);
      return {
        operation: raw.operation,
        runId: safeId(raw.runId, 'runId'),
        expectedRevision: safeRevision(raw.expectedRevision),
      };
    default:
      throw new Error('unsupported operation');
  }
}

async function schedulerConfig(context) {
  if (context?.schedulerConfig !== undefined) return parseSchedulerConfig(context.schedulerConfig);
  if (context?.runtimeConfig?.scheduler !== undefined) return parseSchedulerConfig(context.runtimeConfig.scheduler);
  const path = context?.schedulerConfigPath ?? DEFAULT_CONFIG_PATH;
  try {
    return await loadSchedulerConfigFile(path);
  } catch (error) {
    if (error?.code === 'ENOENT' && path === DEFAULT_CONFIG_PATH) return { ...DEFAULT_SCHEDULER_CONFIG };
    throw error;
  }
}

function contextIdentity(context) {
  const rootSessionID = safeContextId(context?.sessionID, 'context.sessionID');
  const agent = safeContextId(context?.agent, 'context.agent');
  if (agent !== AUTHORIZED_AGENT) throw new Error(`context.agent must be ${AUTHORIZED_AGENT}`);
  const directory = safeDirectory(context?.directory);
  const directoryDigest = createHash('sha256').update(directory).digest('hex');
  return { rootSessionID, agent, directoryDigest };
}

function assertRunIdentity(run, identity) {
  if (run.rootSessionID !== identity.rootSessionID) throw new Error('scheduler run root session mismatch');
  if (run.agent !== identity.agent) throw new Error('scheduler run agent mismatch');
  if (run.directoryDigest !== identity.directoryDigest) throw new Error('scheduler run directory mismatch');
}

function runFor(registry, identity, runId) {
  const run = registry.roots.get(identity.rootSessionID);
  if (!run || run.runId !== runId) throw new Error(`unknown run: ${runId}`);
  assertRunIdentity(run, identity);
  if (run.closed) throw new Error('scheduler run is closed');
  registry.roots.delete(identity.rootSessionID);
  registry.roots.set(identity.rootSessionID, run);
  return run;
}

function verifyOperationIdentity(input, identity, registry) {
  const run = registry.roots.get(identity.rootSessionID);
  if (input.operation === 'create_run') {
    if (run) assertRunIdentity(run, identity);
    return;
  }
  if (!run || run.runId !== input.runId) throw new Error(`unknown run: ${input.runId}`);
  assertRunIdentity(run, identity);
}

function itemFor(run, workItemId) {
  if (!run.state) throw new Error('work items have not been declared');
  const item = run.state.workItems.find((candidate) => candidate.workItemId === workItemId);
  if (!item) throw new Error(`unknown work item: ${workItemId}`);
  return item;
}

function snapshot(run, registry) {
  return {
    processLocal: true,
    durable: false,
    crossProcess: false,
    runId: run.runId,
    schedulingProtocol: run.schedulingProtocol,
    declared: run.state !== null,
    closed: run.closed,
    state: run.state ? structuredClone(run.state) : null,
    journal: schedulerJournalSnapshot(run.rootSessionID, { registry }),
  };
}

function append(rootSessionID, type, metadata, registry, now) {
  return appendSchedulerJournal(rootSessionID, type, metadata, { registry, now });
}

async function executeOperation(input, context, config, registry, now) {
  const identity = contextIdentity(context);
  const capability = context?.schedulerCapability ?? probeSchedulerRuntime({ registry });
  if (config.mode === 'enforce' && (
    capability.available !== true ||
    capability.protocol !== SCHEDULING_PROTOCOL ||
    capability.synchronousAdmission !== true
  )) {
    throw new Error('scheduler enforcement capability is unavailable or incompatible');
  }

  switch (input.operation) {
    case 'create_run': {
      if (input.schedulingProtocol !== 2 && input.schedulingProtocol !== SCHEDULING_PROTOCOL) {
        throw new Error(`unsupported scheduling protocol: ${String(input.schedulingProtocol)}`);
      }
      if (config.mode === 'enforce' && input.schedulingProtocol !== SCHEDULING_PROTOCOL) {
        throw new Error('enforce mode refuses Protocol 2');
      }
      if (input.schedulingProtocol === 2 && config.legacyProtocol2 !== 'observe') {
        throw new Error('Protocol 2 observation is disabled');
      }
      if (registry.roots.has(identity.rootSessionID)) throw new Error('root session already has a scheduler run');
      ensureSchedulerRootCapacity(registry);
      const run = {
        ...identity,
        runId: input.runId,
        schedulingProtocol: input.schedulingProtocol,
        revision: input.revision,
        budgets: input.budgets,
        state: null,
        closed: false,
      };
      registry.roots.set(identity.rootSessionID, run);
      pruneSchedulerRuntime(registry);
      append(identity.rootSessionID, 'run.created', {
        runId: input.runId,
        protocol: input.schedulingProtocol,
        mode: config.mode,
      }, registry, now);
      return { capability, run: snapshot(run, registry) };
    }
    case 'declare_items': {
      const run = runFor(registry, identity, input.runId);
      if (run.state !== null) throw new Error('work items were already declared');
      if (run.revision !== input.expectedRevision) throw new Error('CAS mismatch while declaring work items');
      let manifest;
      if (run.schedulingProtocol === 2) {
        manifest = adaptProtocol2Run({
          schedulingProtocol: 2,
          cohortId: run.runId,
          workItems: input.workItems,
        }, { mode: 'observe', budgets: run.budgets });
        manifest.revision = run.revision;
      } else {
        manifest = validateRunManifestV1({
          schemaVersion: 1,
          schedulingProtocol: SCHEDULING_PROTOCOL,
          runId: run.runId,
          revision: run.revision,
          budgets: run.budgets,
          workItems: input.workItems,
        }, { maxBytes: config.maxManifestBytes, maxWorkItems: config.maxWorkItems });
      }
      run.state = createSchedulerState(manifest);
      append(identity.rootSessionID, 'run.items-declared', {
        runId: run.runId,
        itemCount: run.state.workItems.length,
        protocol: run.schedulingProtocol,
      }, registry, now);
      return { capability, run: snapshot(run, registry) };
    }
    case 'issue_admission': {
      const run = runFor(registry, identity, input.runId);
      const item = itemFor(run, input.workItemId);
      const token = validateAdmissionTokenV1({
        schemaVersion: 1,
        tokenType: 'admission',
        tokenId: `admission-${randomUUID()}`,
        runId: run.runId,
        workItemId: item.workItemId,
        expectedRevision: input.expectedRevision,
        lane: input.lane,
        activePeerIds: run.state.activeAdmissions.map((entry) => entry.workItemId).sort(),
        issuedAt: now,
        expiresAt: now + config.admissionTokenTtlMs,
      });
      const decision = admissionDecision(run.state, token, { now });
      if (!decision.allowed) throw new Error(`admission refused: ${decision.reason}`);
      reserveAdmission({
        token,
        rootSessionID: identity.rootSessionID,
        parentSessionID: context.sessionID,
        target: input.target,
        mode: config.mode,
        claims: admissionClaimsForWorkItem(item),
        version: 1,
        nonce: randomUUID(),
      }, { registry });
      append(identity.rootSessionID, 'admission.issued', {
        runId: run.runId,
        workItemId: item.workItemId,
        lane: input.lane,
        target: input.target,
      }, registry, now);
      return {
        capability,
        token,
        marker: addAdmissionMarker('', token.tokenId, token.lane),
        binding: { version: 1, rootSessionID: identity.rootSessionID, parentSessionID: context.sessionID },
      };
    }
    case 'request_transition': {
      const run = runFor(registry, identity, input.runId);
      const item = itemFor(run, input.workItemId);
      if (run.state.revision !== input.expectedRevision) throw new Error('CAS mismatch while requesting transition');
      if (item.status === input.toStatus) throw new Error('transition must change work item status');
      const token = validateTransitionTokenV1({
        schemaVersion: 1,
        tokenType: 'transition',
        tokenId: `transition-${randomUUID()}`,
        admissionTokenId: input.admissionTokenId,
        runId: run.runId,
        workItemId: item.workItemId,
        expectedRevision: input.expectedRevision,
        fromStatus: item.status,
        toStatus: input.toStatus,
        issuedAt: now,
        expiresAt: now + config.transitionTokenTtlMs,
      });
      append(identity.rootSessionID, 'transition.issued', {
        runId: run.runId,
        workItemId: item.workItemId,
        fromStatus: item.status,
        toStatus: input.toStatus,
      }, registry, now);
      return { capability, token };
    }
    case 'append_artifact': {
      const run = runFor(registry, identity, input.runId);
      if (input.artifact.runId !== run.runId || (input.token && input.token.runId !== run.runId)) {
        throw new Error('artifact run ID mismatch');
      }
      run.state = input.artifact.artifactType === 'transition'
        ? reduceSchedulerState(run.state, {
          type: 'transition',
          token: input.token,
          artifact: input.artifact,
          now,
        })
        : reduceSchedulerState(run.state, {
          type: 'append-quality-artifact',
          artifact: input.artifact,
        });
      append(identity.rootSessionID, 'artifact.appended', {
        runId: run.runId,
        artifactType: input.artifact.artifactType,
        workItemId: input.artifact.workItemId ?? null,
        status: input.artifact.toStatus ?? input.artifact.status ?? input.artifact.outcome ?? null,
        changedPathCount: input.artifact.changedPaths?.length ?? 0,
      }, registry, now);
      return { capability, artifact: input.artifact, run: snapshot(run, registry) };
    }
    case 'snapshot': {
      const run = runFor(registry, identity, input.runId);
      return { capability, run: snapshot(run, registry) };
    }
    case 'freeze': {
      const run = runFor(registry, identity, input.runId);
      run.state = reduceSchedulerState(run.state, {
        type: 'invalidate',
        workItemId: input.workItemId,
        reason: input.reason,
        expectedRevision: input.expectedRevision,
      });
      append(identity.rootSessionID, 'run.frozen', {
        runId: run.runId,
        workItemId: input.workItemId,
        reason: input.reason,
      }, registry, now);
      return { capability, run: snapshot(run, registry) };
    }
    case 'close': {
      const run = runFor(registry, identity, input.runId);
      if (!run.state) throw new Error('work items have not been declared');
      if (run.state.revision !== input.expectedRevision) throw new Error('CAS mismatch while closing run');
      if (run.state.activeAdmissions.length > 0) throw new Error('cannot close a run with active admissions');
      run.closed = true;
      append(identity.rootSessionID, 'run.closed', { runId: run.runId }, registry, now);
      return { capability, run: snapshot(run, registry) };
    }
    default:
      throw new Error('unsupported operation');
  }
}

function errorText(error) {
  return error instanceof Error ? error.message : String(error);
}

export default {
  description: 'Manage a process-local Protocol 3 Naru scheduler run. This tool never creates OpenCode sessions.',
  args: {
    input: {
      type: 'object',
      description: 'Strict scheduler operation request.',
      properties: {
        operation: { type: 'string', enum: OPERATIONS },
        runId: { type: 'string' },
        schedulingProtocol: { type: 'number' },
        revision: { type: 'number' },
        expectedRevision: { type: 'number' },
        budgets: { type: 'object' },
        workItems: { type: 'array', items: { type: 'object' } },
        workItemId: { type: 'string' },
        lane: { type: 'string', enum: ['writer', 'read-only'] },
        target: { type: 'string' },
        admissionTokenId: { type: 'string' },
        toStatus: { type: 'string' },
        token: { type: 'object' },
        artifact: { type: 'object' },
        reason: { type: 'string' },
      },
      required: ['operation'],
      additionalProperties: false,
    },
  },
  execute: async (args, context = {}) => {
    let input;
    let config;
    let identity;
    try {
      identity = contextIdentity(context);
      config = await schedulerConfig(context);
      input = validateOperation(args?.input, config);
    } catch (error) {
      return JSON.stringify(errEnvelope(TOOL_ID, `invalid input or config: ${errorText(error)}`), null, 2);
    }

    const capability = context.schedulerCapability ?? probeSchedulerRuntime({
      registry: context.schedulerRegistry ?? getSchedulerRuntimeRegistry(),
    });
    if (config.mode === 'off') {
      return JSON.stringify(okEnvelope(TOOL_ID, {
        mode: 'off',
        capability,
        processLocalOnly: true,
      }), null, 2);
    }

    const registry = context.schedulerRegistry ?? getSchedulerRuntimeRegistry();
    try {
      verifyOperationIdentity(input, identity, registry);
    } catch (error) {
      return JSON.stringify(errEnvelope(TOOL_ID, errorText(error)), null, 2);
    }
    const now = typeof context.now === 'function' ? context.now() : Date.now();
    try {
      const data = await executeOperation(input, context, config, registry, now);
      return JSON.stringify(okEnvelope(TOOL_ID, { mode: config.mode, ...data }), null, 2);
    } catch (error) {
      const rootSessionID = typeof context.sessionID === 'string' && context.sessionID ? context.sessionID : 'unknown-root';
      if (error?.code !== 'scheduler_capacity_exhausted') {
        appendSchedulerJournal(rootSessionID, 'tool.error', {
          operation: input.operation,
          code: 'operation_refused',
          reason: errorText(error),
        }, { registry, now });
      }
      return JSON.stringify(errEnvelope(TOOL_ID, errorText(error)), null, 2);
    }
  },
};
