import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { delimiter, isAbsolute, resolve } from 'node:path';

import { runAuthorizedLiveEvaluation } from './live-evaluation.mjs';

const LOOPBACK_HOST = '127.0.0.1';
const PROCESS_STOP_MS = 1_000;
const VERSION_CAPTURE_BYTES = 4 * 1024;
const MAX_EXECUTABLE_BYTES = 64 * 1024 * 1024;

function codedError(code, message) {
  return Object.assign(new Error(message), { code });
}

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function linkedAbortSignal(signal, timeoutMs) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (signal?.aborted) abort();
  else signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(abort, timeoutMs);
  return {
    signal: controller.signal,
    cleanup() {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
    },
  };
}

function validateLocalBaseUrl(value) {
  let parsed;
  try { parsed = new URL(value); } catch { throw codedError('NARU_LIVE_NETWORK_LIMIT', 'OpenCode base URL must be loopback HTTP'); }
  if (parsed.protocol !== 'http:' || !['127.0.0.1', '[::1]'].includes(parsed.hostname)
    || parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash) {
    throw codedError('NARU_LIVE_NETWORK_LIMIT', 'OpenCode base URL must be loopback HTTP');
  }
  return parsed;
}

async function resolveExecutable(executable, environment) {
  const candidates = isAbsolute(executable) || executable.includes('/') || executable.includes('\\')
    ? [resolve(executable)]
    : String(environment?.PATH ?? '').split(delimiter).filter(Boolean).map((entry) => resolve(entry, executable));
  for (const candidate of candidates) {
    try {
      const metadata = await lstat(candidate);
      if (metadata.isSymbolicLink() || !metadata.isFile()) {
        throw codedError('NARU_LIVE_PROVENANCE_FAILURE', 'OpenCode executable must be a regular non-symlink file');
      }
      if (metadata.size > MAX_EXECUTABLE_BYTES) {
        throw codedError('NARU_LIVE_PROVENANCE_FAILURE', 'OpenCode executable exceeds the provenance inspection limit');
      }
      return { path: candidate, bytes: await readFile(candidate) };
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }
  throw codedError('NARU_LIVE_PROVENANCE_FAILURE', 'OpenCode executable could not be resolved without a shell');
}

async function readOpenCodeVersion(executable, environment, spawnImplementation) {
  const child = spawnImplementation(executable, ['--version'], {
    env: Object.fromEntries(['PATH', 'LANG', 'LC_ALL', 'TERM', 'TZ']
      .filter((key) => typeof environment?.[key] === 'string')
      .map((key) => [key, environment[key]])),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  let capturedBytes = 0;
  const capture = (chunk) => {
    capturedBytes += chunk.length;
    if (capturedBytes <= VERSION_CAPTURE_BYTES) output += chunk.toString('utf8');
    else child.kill('SIGKILL');
  };
  child.stdout?.on('data', capture);
  child.stderr?.on('data', capture);
  const result = await new Promise((resolvePromise, reject) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(codedError('NARU_LIVE_PROVENANCE_FAILURE', 'OpenCode version preflight timed out'));
    }, PROCESS_STOP_MS);
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      resolvePromise({ code, signal });
    });
  });
  if (capturedBytes > VERSION_CAPTURE_BYTES || result.code !== 0) {
    throw codedError('NARU_LIVE_PROVENANCE_FAILURE', `OpenCode version preflight failed (${result.code ?? result.signal})`);
  }
  const version = output.trim().replace(/^opencode\s+v?/i, '').replace(/^v/, '');
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9._:-]*[A-Za-z0-9])?$/.test(version)) {
    throw codedError('NARU_LIVE_PROVENANCE_FAILURE', 'OpenCode version preflight returned an invalid version');
  }
  return version;
}

export async function inspectOpenCodeExecutable({
  executable = 'opencode',
  environment = process.env,
  spawnImplementation = spawn,
} = {}) {
  const inspected = await resolveExecutable(executable, environment);
  return {
    version: await readOpenCodeVersion(inspected.path, environment, spawnImplementation),
    executableDigest: createHash('sha256').update(inspected.bytes).digest('hex'),
  };
}

async function readBoundedJson(response, maximumBytes, onCapture) {
  if (!response.body) return null;
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maximumBytes) throw codedError('NARU_LIVE_CAPTURE_LIMIT', 'OpenCode response exceeded the capture limit');
      onCapture?.(value.byteLength);
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  if (size === 0) return null;
  const bytes = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
  try {
    return JSON.parse(bytes.toString('utf8'));
  } catch {
    throw codedError('NARU_LIVE_CAPTURE_LIMIT', 'OpenCode returned invalid bounded JSON');
  }
}

export async function requestOpenCode({
  baseUrl,
  path,
  method = 'GET',
  body,
  signal,
  timeoutMs,
  maxCaptureBytes,
  runtime,
  fetchImplementation = globalThis.fetch,
} = {}) {
  const base = validateLocalBaseUrl(baseUrl);
  if (typeof path !== 'string' || !path.startsWith('/') || path.startsWith('//')) {
    throw codedError('NARU_LIVE_NETWORK_LIMIT', 'OpenCode request path must be local and absolute');
  }
  const target = new URL(path, base);
  if (target.origin !== base.origin) throw codedError('NARU_LIVE_NETWORK_LIMIT', 'OpenCode request escaped loopback origin');
  runtime?.assertLoopback(target.href);
  runtime?.beforeRequest();
  const linked = linkedAbortSignal(signal, timeoutMs);
  try {
    const response = await fetchImplementation(target, {
      method,
      headers: body === undefined ? undefined : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: 'error',
      signal: linked.signal,
    });
    const result = await readBoundedJson(response, maxCaptureBytes, (bytes) => runtime?.recordCapture(bytes));
    if (!response.ok) throw codedError('NARU_LIVE_EXECUTION_FAILURE', `OpenCode loopback request failed with status ${response.status}`);
    return result;
  } catch (error) {
    if (linked.signal.aborted && !signal?.aborted) throw codedError('NARU_LIVE_TIMEOUT', 'OpenCode request timed out');
    throw error;
  } finally {
    linked.cleanup();
  }
}

async function availableLoopbackPort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, LOOPBACK_HOST, resolve);
  });
  const address = server.address();
  await new Promise((resolve) => server.close(resolve));
  if (!address || typeof address === 'string') throw new Error('loopback port allocation failed');
  return address.port;
}

function signalOwnedProcess(child, signal) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  try {
    if (child.pid && process.platform !== 'win32') process.kill(-child.pid, signal);
    else child.kill(signal);
  } catch (error) {
    if (error?.code !== 'ESRCH') throw error;
  }
}

async function waitForExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) return true;
  return new Promise((resolve) => {
    const exited = () => {
      clearTimeout(timer);
      resolve(true);
    };
    const timer = setTimeout(() => {
      child.removeListener('exit', exited);
      resolve(false);
    }, timeoutMs);
    child.once('exit', exited);
  });
}

async function terminateOwnedProcess(child) {
  if (!child.pid) return;
  if (await waitForExit(child, 1)) return;
  signalOwnedProcess(child, 'SIGTERM');
  if (await waitForExit(child, PROCESS_STOP_MS)) return;
  signalOwnedProcess(child, 'SIGKILL');
  if (!await waitForExit(child, PROCESS_STOP_MS)) {
    throw codedError('NARU_LIVE_CLEANUP_FAILURE', 'owned OpenCode process did not terminate');
  }
}

function safeSessionId(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(value)) {
    throw codedError('NARU_LIVE_EXECUTION_FAILURE', 'OpenCode returned an invalid session identifier');
  }
  return value;
}

function sessionDepth(session, byId, seen = new Set()) {
  if (!session?.parentID) return 0;
  if (seen.has(session.id)) return Number.MAX_SAFE_INTEGER;
  seen.add(session.id);
  return 1 + sessionDepth(byId.get(session.parentID), byId, seen);
}

function tokenUsage(response) {
  const tokens = response?.info?.tokens ?? response?.tokens ?? {};
  const input = Number.isSafeInteger(tokens.input) && tokens.input >= 0 ? tokens.input : 0;
  const output = Number.isSafeInteger(tokens.output) && tokens.output >= 0 ? tokens.output : 0;
  return { input, output };
}

function usageCostUsdMicros(response) {
  const cost = response?.info?.cost ?? response?.cost;
  if (cost === null || cost === undefined) return null;
  if (typeof cost !== 'number' || !Number.isFinite(cost) || cost < 0) {
    throw codedError('NARU_LIVE_EXECUTION_FAILURE', 'OpenCode returned invalid cost usage');
  }
  const micros = Math.round(cost * 1_000_000);
  if (!Number.isSafeInteger(micros)) throw codedError('NARU_LIVE_EXECUTION_FAILURE', 'OpenCode cost usage is out of range');
  return micros;
}

function rubricResults(response, expectedIds) {
  const entries = response?.naruEvaluation?.rubric ?? response?.rubric;
  if (!Array.isArray(entries)) return expectedIds.map((id) => ({ id, passed: false }));
  const byId = new Map(entries
    .filter((entry) => entry && typeof entry.id === 'string' && typeof entry.passed === 'boolean')
    .map((entry) => [entry.id, entry.passed]));
  return expectedIds.map((id) => ({ id, passed: byId.get(id) === true }));
}

export function createInjectedOpenCodeExecutor(execute) {
  if (typeof execute !== 'function') throw new Error('OpenCode live evaluation requires an injected executor');
  const injected = async (context) => execute(context);
  if (typeof execute.preflight === 'function') injected.preflight = (context) => execute.preflight(context);
  return injected;
}

export function createLocalOpenCodeExecutor({
  executable = 'opencode',
  spawnImplementation = spawn,
  fetchImplementation = globalThis.fetch,
} = {}) {
  if (typeof executable !== 'string' || !executable || /[\u0000\r\n]/.test(executable)) {
    throw new Error('OpenCode executable must be one explicit command path or name');
  }
  const executeLocalOpenCode = async function executeLocalOpenCode(context) {
    const startedAt = Date.now();
    const port = await availableLoopbackPort();
    const baseUrl = `http://${LOOPBACK_HOST}:${port}/`;
    context.runtime.assertLoopback(baseUrl);
    const child = spawnImplementation(executable, ['serve', '--hostname', LOOPBACK_HOST, '--port', String(port)], {
      cwd: context.workspace,
      detached: process.platform !== 'win32',
      env: context.environment,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let processFailure = null;
    let stopping;
    const sessions = new Set();
    const stop = async () => {
      if (stopping) return stopping;
      stopping = (async () => {
        for (const sessionId of [...sessions].reverse()) {
          try {
            await requestOpenCode({
              baseUrl,
              path: `/session/${encodeURIComponent(sessionId)}`,
              method: 'DELETE',
              timeoutMs: Math.min(1_000, context.limits.request.timeoutMs),
              maxCaptureBytes: context.limits.request.maxCaptureBytes,
              runtime: context.runtime,
              fetchImplementation,
            });
          } catch {
            // Process termination remains the final session cleanup boundary.
          }
        }
        await terminateOwnedProcess(child);
      })();
      return stopping;
    };
    context.registerCleanup(stop);
    const captureProcessOutput = (chunk) => {
      try { context.runtime.recordCapture(chunk.length); }
      catch (error) {
        processFailure = error;
        void stop().catch((cleanupError) => { processFailure = cleanupError; });
      }
    };
    child.stdout?.on('data', captureProcessOutput);
    child.stderr?.on('data', captureProcessOutput);
    child.once('error', (error) => { processFailure = error; });
    child.once('exit', (code, signal) => {
      if (!stopping && code !== 0) processFailure = new Error(`OpenCode exited before completion (${code ?? signal})`);
    });

    const request = (options) => requestOpenCode({
      baseUrl,
      signal: context.signal,
      timeoutMs: context.limits.request.timeoutMs,
      maxCaptureBytes: context.limits.request.maxCaptureBytes,
      runtime: context.runtime,
      fetchImplementation,
      ...options,
    });

    try {
      const startupDeadline = Date.now() + context.limits.request.timeoutMs;
      while (true) {
        if (processFailure) throw processFailure;
        try {
          await request({ path: '/global/health' });
          break;
        } catch (error) {
          if (error?.code?.endsWith('_LIMIT') || context.signal.aborted || Date.now() >= startupDeadline) throw error;
          await wait(25);
        }
      }
      const created = await request({ path: '/session', method: 'POST', body: {} });
      const rootSessionId = safeSessionId(created?.id);
      sessions.add(rootSessionId);
      const prompt = JSON.stringify({ input: context.execution.input, topology: context.execution.topology });
      const message = await request({
        path: `/session/${encodeURIComponent(rootSessionId)}/message`,
        method: 'POST',
        body: {
          model: { providerID: context.contract.provider.id, modelID: context.contract.model.id },
          ...(context.baseline ? {} : { agent: context.contract.candidate.id }),
          parts: [{ type: 'text', text: prompt }],
        },
      });
      const listed = await request({ path: `/session?directory=${encodeURIComponent(context.workspace)}` });
      const listedSessions = Array.isArray(listed) ? listed : [];
      const byId = new Map();
      for (const entry of listedSessions) {
        if (entry && typeof entry.id === 'string') {
          const sessionId = safeSessionId(entry.id);
          sessions.add(sessionId);
          byId.set(sessionId, entry);
          if (byId.size > context.limits.session.maxDescendants + 1) {
            throw codedError('NARU_LIVE_SESSION_LIMIT', 'OpenCode exceeded the descendant session limit');
          }
        }
      }
      const descendants = listedSessions.filter((entry) => entry?.id !== rootSessionId);
      const depth = descendants.reduce((maximum, entry) => Math.max(maximum, sessionDepth(entry, byId)), 0);
      context.runtime.recordSessions(descendants.length, depth, descendants.length);
      const tokens = tokenUsage(message);
      context.runtime.recordTokens(tokens.input, tokens.output);
      const rubric = rubricResults(message, context.execution.rubricIds);
      return {
        passed: rubric.every((entry) => entry.passed),
        stopCode: null,
        metrics: {
          elapsedMs: Math.min(Date.now() - startedAt, context.limits.timeout.caseMs),
          ...context.runtime.observed,
        },
        usageCostUsdMicros: usageCostUsdMicros(message),
        rubric,
        safety: {
          deadlineMet: Date.now() < context.limits.deadline ? 'observed' : 'failed',
          networkContained: 'not-enforced',
          noPersistentDataWrite: 'not-enforced',
          noPost: 'unknown',
          noRawOutput: 'observed',
          noSecret: 'not-enforced',
          scopeContained: 'not-enforced',
        },
        limitations: rubric.every((entry) => entry.passed)
          ? ['containment-not-enforced', 'provider-reported-rubric']
          : ['containment-not-enforced', 'semantic-judging-unavailable'],
      };
    } finally {
      await stop();
    }
  };
  executeLocalOpenCode.preflight = async ({ contract }) => {
    if (contract.provider.id !== 'none') {
      throw codedError(
        'NARU_LIVE_BUDGET_UNENFORCED',
        'local OpenCode provider execution is unavailable without enforceable output-token and cost ceilings',
      );
    }
    throw codedError(
      'NARU_LIVE_PROVENANCE_FAILURE',
      'local OpenCode live execution is unavailable because candidate and executable bytes are not bound through execution',
    );
  };
  return executeLocalOpenCode;
}

export async function runOpenCodeLiveEvaluation(options = {}) {
  const execute = typeof options.execute === 'function'
    ? createInjectedOpenCodeExecutor(options.execute)
    : createLocalOpenCodeExecutor({
        executable: options.opencodeExecutable,
        spawnImplementation: options.spawnImplementation,
        fetchImplementation: options.fetchImplementation,
        preflightImplementation: options.opencodePreflightImplementation,
      });
  const {
    opencodeExecutable,
    spawnImplementation,
    fetchImplementation,
    opencodePreflightImplementation,
    ...runnerOptions
  } = options;
  return runAuthorizedLiveEvaluation({ ...runnerOptions, execute });
}
