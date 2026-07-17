import { createHash } from 'node:crypto';

import { getSchedulerRuntimeRegistry, pruneSchedulerRuntime } from './scheduler-token.mjs';

const MAX_JOURNAL_ROOTS = 64;
const MAX_ENTRIES_PER_ROOT = 256;
const MAX_METADATA_BYTES = 4096;
const MAX_STRING_LENGTH = 256;
const REDACTED = '[redacted]';
const SENSITIVE_KEY = /(?:prompt|diff|path|directory|secret|token|authorization|command|output|content|model)/i;
const SENSITIVE_VALUE = /(?:\b(?:authorization|proxy-authorization)\s*[:=]\s*|\bbearer\s+|\b(?:api[_ -]?key|access[_ -]?token|auth[_ -]?token|client[_ -]?secret|password|passwd|credential)\s*[:=]\s*)\S+|\b(?:gh[pousr]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{16,}|sk-[A-Za-z0-9_-]{16,}|AKIA[A-Z0-9]{16}|xox[baprs]-[A-Za-z0-9-]{10,}|npm_[A-Za-z0-9]{16,}|AIza[0-9A-Za-z_-]{16,}|eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,})\b/i;

function safeString(value) {
  if (SENSITIVE_VALUE.test(value)) return REDACTED;
  if (/[/\\]/.test(value) || /[\u0000-\u001f\u007f]/.test(value)) return REDACTED;
  return value.length <= MAX_STRING_LENGTH ? value : `${value.slice(0, MAX_STRING_LENGTH)}…`;
}

function sanitize(value, depth = 0) {
  if (depth > 3) return '[bounded]';
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : REDACTED;
  if (typeof value === 'string') return safeString(value);
  if (Array.isArray(value)) return value.slice(0, 32).map((entry) => sanitize(entry, depth + 1));
  if (value && typeof value === 'object') {
    const result = {};
    for (const key of Object.keys(value).sort().slice(0, 32)) {
      result[key] = SENSITIVE_KEY.test(key) ? REDACTED : sanitize(value[key], depth + 1);
    }
    return result;
  }
  return REDACTED;
}

export function redactJournalMetadata(metadata) {
  const sanitized = sanitize(metadata ?? {});
  let text = JSON.stringify(sanitized);
  if (Buffer.byteLength(text, 'utf8') <= MAX_METADATA_BYTES) return sanitized;
  const bounded = { truncated: true };
  for (const key of Object.keys(sanitized).sort()) {
    bounded[key] = sanitized[key];
    text = JSON.stringify(bounded);
    if (Buffer.byteLength(text, 'utf8') > MAX_METADATA_BYTES) {
      delete bounded[key];
      break;
    }
  }
  return bounded;
}

function digest(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function pruneJournals(registry) {
  while (registry.journals.size > MAX_JOURNAL_ROOTS) {
    registry.journals.delete(registry.journals.keys().next().value);
  }
  pruneSchedulerRuntime(registry);
}

export function appendSchedulerJournal(rootSessionID, type, metadata = {}, {
  now = Date.now(),
  registry = getSchedulerRuntimeRegistry(),
} = {}) {
  if (typeof rootSessionID !== 'string' || rootSessionID.length === 0) {
    throw new Error('journal root session ID is required');
  }
  if (typeof type !== 'string' || !/^[a-z][a-z0-9.-]{0,63}$/.test(type)) {
    throw new Error('journal event type is invalid');
  }
  if (!Number.isSafeInteger(now) || now < 0) throw new Error('journal timestamp is invalid');
  const current = registry.journals.get(rootSessionID) ?? { nextSequence: 1, entries: [], runtimeMode: null };
  current.runtimeMode ??= null;
  if (type === 'run.created' && (metadata?.mode === 'observe' || metadata?.mode === 'enforce')) {
    current.runtimeMode = metadata.mode;
  }
  registry.journals.delete(rootSessionID);
  registry.journals.set(rootSessionID, current);
  const previousDigest = current.entries.at(-1)?.digest ?? null;
  const body = {
    schemaVersion: 1,
    sequence: current.nextSequence,
    timestamp: now,
    type,
    previousDigest,
    metadata: redactJournalMetadata(metadata),
  };
  const envelope = { ...body, digest: digest(body) };
  current.nextSequence += 1;
  current.entries.push(envelope);
  if (current.entries.length > MAX_ENTRIES_PER_ROOT) {
    current.entries.splice(0, current.entries.length - MAX_ENTRIES_PER_ROOT);
  }
  pruneJournals(registry);
  return structuredClone(envelope);
}

export function schedulerJournalSnapshot(rootSessionID, {
  registry = getSchedulerRuntimeRegistry(),
} = {}) {
  const journal = registry.journals.get(rootSessionID);
  return journal ? structuredClone(journal.entries) : [];
}

export function schedulerJournalRuntimeMode(rootSessionID, {
  registry = getSchedulerRuntimeRegistry(),
} = {}) {
  const mode = registry.journals.get(rootSessionID)?.runtimeMode;
  return mode === 'observe' || mode === 'enforce' ? mode : null;
}

export function resetSchedulerJournalForTests(registry = getSchedulerRuntimeRegistry()) {
  registry.journals.clear();
}

export const SCHEDULER_JOURNAL_LIMITS = Object.freeze({
  maxRoots: MAX_JOURNAL_ROOTS,
  maxEntriesPerRoot: MAX_ENTRIES_PER_ROOT,
  maxMetadataBytes: MAX_METADATA_BYTES,
});
