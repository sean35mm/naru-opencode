import { spawn } from 'node:child_process';
import { request as httpRequest } from 'node:http';
import { createServer } from 'node:net';

import { LIVE_EVALUATION_CASES, evaluateLiveCapture } from './live-evaluation.mjs';
import { safeError } from './validate.mjs';

const MAX_SERVER_OUTPUT = 8192;
const MAX_RESPONSE_BYTES = 10 * 1024 * 1024;
const MAX_DIAGNOSTIC_CHARS = 512;
const DEFAULT_REQUEST_TIMEOUT_MS = 5 * 60 * 1000;
const MAX_REQUEST_TIMEOUT_MS = 15 * 60 * 1000;
const SERVER_TERMINATION_GRACE_MS = 2000;
const SERVER_FINALIZATION_GRACE_MS = 250;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function diagnostic(error, fallback) {
  const text = safeError(error).replace(/[\r\n\t]+/g, ' ').trim().slice(0, MAX_DIAGNOSTIC_CHARS);
  return text || fallback;
}

function waitForExit(proc, timeoutMs) {
  if (proc.exitCode !== null || proc.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      proc.removeListener('exit', onExit);
      resolve(false);
    }, timeoutMs);
    function onExit() {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(true);
    }
    proc.once('exit', onExit);
  });
}

function kill(proc, signal) {
  try {
    proc.kill(signal);
  } catch {
    // ignore
  }
}

async function stopServerProcess(proc) {
  if (proc.exitCode !== null || proc.signalCode !== null) return;
  kill(proc, 'SIGTERM');
  if (await waitForExit(proc, SERVER_TERMINATION_GRACE_MS)) return;
  kill(proc, 'SIGKILL');
  await waitForExit(proc, SERVER_FINALIZATION_GRACE_MS);
}

async function fetchWithTimeout(url, timeoutMs) {
  const controller = new AbortController();
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      controller.abort();
      reject(new Error(`OpenCode health request timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    Promise.resolve(fetch(url, { signal: controller.signal })).then((response) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(response);
    }, (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`OpenCode health request failed: ${diagnostic(error, 'unknown transport error')}`));
    });
  });
}

async function availablePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  await new Promise((resolve) => server.close(resolve));
  if (!address || typeof address === 'string') throw new Error('failed to allocate a localhost port');
  return address.port;
}

async function startServer({ executable, directory, startupTimeoutMs, requestTimeoutMs }) {
  const port = await availablePort();
  const proc = spawn(executable, ['serve', '--hostname', '127.0.0.1', '--port', String(port)], {
    cwd: directory,
    env: { ...process.env, NO_COLOR: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  let settled = false;
  const url = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error(`OpenCode server did not start within ${startupTimeoutMs}ms`));
    }, startupTimeoutMs);
    const inspect = (chunk) => {
      output = `${output}${chunk}`.slice(-MAX_SERVER_OUTPUT);
      const match = output.match(/opencode server listening on (https?:\/\/[^\s]+)/);
      if (!match || settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(match[1]);
    };
    proc.stdout.on('data', inspect);
    proc.stderr.on('data', inspect);
    proc.once('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`OpenCode server failed to start: ${diagnostic(error, 'unknown process error')}`));
    });
    proc.once('exit', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`OpenCode server exited before startup with code ${code}; startup output omitted`));
    });
  }).catch(async (error) => {
    await stopServerProcess(proc);
    throw error;
  });
  let parsedURL;
  try {
    parsedURL = new URL(url);
  } catch {
    await stopServerProcess(proc);
    throw new Error('OpenCode server reported an invalid address; startup output omitted');
  }
  if (parsedURL.protocol !== 'http:'
    || parsedURL.username
    || parsedURL.password
    || !['127.0.0.1', 'localhost', '[::1]'].includes(parsedURL.hostname)) {
    await stopServerProcess(proc);
    throw new Error('OpenCode server reported a non-local address; startup output omitted');
  }

  const readyDeadline = Date.now() + startupTimeoutMs;
  let readinessError;
  while (Date.now() < readyDeadline) {
    try {
      const remaining = Math.max(1, readyDeadline - Date.now());
      const response = await fetchWithTimeout(
        new URL('/global/health', url),
        Math.min(requestTimeoutMs, remaining),
      );
      response.body?.cancel().catch(() => {});
      if (response.ok) {
        readinessError = undefined;
        break;
      }
      readinessError = new Error(`health endpoint returned ${response.status}`);
    } catch (error) {
      readinessError = error;
    }
    await sleep(100);
  }
  if (readinessError) {
    await stopServerProcess(proc);
    throw new Error(`OpenCode server was not reachable after startup (${diagnostic(readinessError, 'unknown health error')}); startup output omitted`);
  }

  return {
    url,
    async close() {
      await stopServerProcess(proc);
    },
  };
}

async function request(baseURL, directory, method, path, body, {
  timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  deadline,
} = {}) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_REQUEST_TIMEOUT_MS) {
    throw new Error(`OpenCode request timeout must be from 1 to ${MAX_REQUEST_TIMEOUT_MS} milliseconds`);
  }
  if (deadline !== undefined) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error('live evaluation request deadline elapsed');
    timeoutMs = Math.min(timeoutMs, remaining);
  }
  const url = new URL(path, baseURL);
  url.searchParams.set('directory', directory);
  if (url.protocol !== 'http:'
    || url.username
    || url.password
    || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) {
    throw new Error('live evaluation requires a localhost HTTP OpenCode server');
  }
  const payload = body === undefined ? undefined : JSON.stringify(body);
  const { status, text } = await new Promise((resolve, reject) => {
    let settled = false;
    let response;
    let timer;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback(value);
    };
    const req = httpRequest(url, {
      method,
      headers: payload === undefined ? undefined : {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(payload),
      },
    }, (incoming) => {
      response = incoming;
      const chunks = [];
      let size = 0;
      incoming.on('data', (chunk) => {
        size += chunk.length;
        if (size > MAX_RESPONSE_BYTES) {
          req.destroy(new Error(`OpenCode ${method} ${path} response exceeded ${MAX_RESPONSE_BYTES} bytes`));
          return;
        }
        chunks.push(chunk);
      });
      incoming.on('end', () => finish(resolve, {
        status: response.statusCode ?? 0,
        text: Buffer.concat(chunks).toString('utf8'),
      }));
      incoming.once('aborted', () => {
        finish(reject, new Error(`OpenCode ${method} ${path} response ended unexpectedly`));
      });
      incoming.once('error', (error) => {
        finish(reject, new Error(`OpenCode ${method} ${path} response failed: ${diagnostic(error, 'unknown response error')}`));
      });
    });
    timer = setTimeout(() => {
      if (settled) return;
      finish(reject, new Error(`OpenCode ${method} ${path} request timed out after ${timeoutMs}ms`));
      response?.destroy();
      req.destroy();
    }, timeoutMs);
    req.once('error', (error) => {
      const cause = error.cause?.code ?? error.cause?.message ?? error.message;
      finish(reject, new Error(`OpenCode ${method} ${path} transport failed: ${diagnostic(cause, 'unknown transport error')}`));
    });
    if (payload !== undefined) req.write(payload);
    req.end();
  });
  if (status < 200 || status >= 300) {
    throw new Error(`OpenCode ${method} ${path} failed (${status}); response body omitted`);
  }
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`OpenCode ${method} ${path} returned invalid JSON; response body omitted`);
  }
}

async function collectSessions(baseURL, directory, rootID, requestOptions) {
  const sessions = [];
  const queue = [rootID];
  const seen = new Set(queue);
  while (queue.length) {
    const parentID = queue.shift();
    const children = await request(
      baseURL,
      directory,
      'GET',
      `/session/${encodeURIComponent(parentID)}/children`,
      undefined,
      requestOptions,
    );
    for (const child of children ?? []) {
      if (seen.has(child.id)) continue;
      seen.add(child.id);
      sessions.push(child);
      queue.push(child.id);
    }
  }
  return sessions;
}

function metadataFromMessages(session, messages) {
  const assistants = (messages ?? []).map((message) => message.info ?? message)
    .filter((message) => message?.role === 'assistant');
  const first = assistants.find((message) => message.agent);
  const last = [...assistants].reverse().find((message) => message.agent) ?? first;
  const created = assistants.map((message) => message.time?.created).filter(Number.isFinite);
  const completed = assistants.map((message) => message.time?.completed).filter(Number.isFinite);
  return {
    id: session.id,
    parentID: session.parentID,
    agent: last?.agent,
    provider: last?.providerID,
    model: last?.modelID,
    variant: last?.variant,
    createdAt: created.length ? Math.min(...created) : session.time?.created,
    completedAt: completed.length ? Math.max(...completed) : undefined,
    error: assistants.some((message) => message.error),
  };
}

async function hydrateSessions(baseURL, directory, sessions, requestOptions) {
  return Promise.all(sessions.map(async (session) => {
    const messages = await request(
      baseURL,
      directory,
      'GET',
      `/session/${encodeURIComponent(session.id)}/message`,
      undefined,
      requestOptions,
    );
    return metadataFromMessages(session, messages);
  }));
}

export async function runOpenCodeLiveEvaluation({
  caseId,
  directory,
  executable = 'opencode',
  onProgress = () => {},
  timeoutMs = 15 * 60 * 1000,
  pollIntervalMs = 500,
  startupTimeoutMs = 10000,
  requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
} = {}) {
  const scenario = LIVE_EVALUATION_CASES[caseId];
  if (!scenario) throw new Error(`unknown live evaluation case: ${caseId}`);
  if (typeof directory !== 'string' || !directory) throw new Error('live evaluation directory is required');
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 60 * 60 * 1000) {
    throw new Error('live evaluation timeout must be from 1000 to 3600000 milliseconds');
  }
  if (!Number.isSafeInteger(requestTimeoutMs)
    || requestTimeoutMs < 100
    || requestTimeoutMs > MAX_REQUEST_TIMEOUT_MS) {
    throw new Error(`live evaluation request timeout must be from 100 to ${MAX_REQUEST_TIMEOUT_MS} milliseconds`);
  }
  if (typeof onProgress !== 'function') throw new Error('live evaluation onProgress must be a function');

  const server = await startServer({ executable, directory, startupTimeoutMs, requestTimeoutMs });
  let root;
  const observedStatuses = new Map();
  const discovered = new Set();
  let polls = 0;
  let statusTransitions = 0;
  const deadline = Date.now() + timeoutMs;
  const requestWithinDeadline = (method, path, body) => {
    return request(server.url, directory, method, path, body, {
      timeoutMs: requestTimeoutMs,
      deadline,
    });
  };
  const abortRoot = () => request(
    server.url,
    directory,
    'POST',
    `/session/${encodeURIComponent(root.id)}/abort`,
    undefined,
    { timeoutMs: Math.min(requestTimeoutMs, 1000) },
  ).catch(() => {});
  try {
    root = await requestWithinDeadline('POST', '/session', {
      title: `Naru live evaluation: ${caseId}`,
    });
    onProgress({ event: 'root-started', rootSessionId: root.id });
    let commandDone = false;
    let commandResult;
    let commandError;
    const command = requestWithinDeadline(
      'POST',
      `/session/${encodeURIComponent(root.id)}/command`,
      {
        agent: scenario.rootAgent,
        arguments: scenario.arguments,
        command: scenario.command,
      },
    ).then((result) => {
      commandResult = result;
    }).catch((error) => {
      commandError = error;
    }).finally(() => {
      commandDone = true;
    });

    while (!commandDone) {
      if (Date.now() >= deadline) {
        throw new Error(`live evaluation timed out after ${timeoutMs}ms`);
      }
      const [sessions, statuses] = await Promise.all([
        collectSessions(server.url, directory, root.id, {
          timeoutMs: requestTimeoutMs,
          deadline,
        }),
        requestWithinDeadline('GET', '/session/status'),
      ]);
      polls += 1;
      const added = sessions.filter((session) => !discovered.has(session.id));
      for (const session of added) discovered.add(session.id);
      if (added.length) onProgress({ event: 'descendants-observed', added: added.length, total: discovered.size });
      for (const sessionID of [root.id, ...discovered]) {
        const value = statuses?.[sessionID]?.type ?? 'idle';
        if (observedStatuses.has(sessionID) && observedStatuses.get(sessionID) !== value) statusTransitions += 1;
        observedStatuses.set(sessionID, value);
      }
      await sleep(Math.min(pollIntervalMs, Math.max(1, deadline - Date.now())));
    }
    await command;
    if (commandError) throw commandError;

    const sessions = await collectSessions(server.url, directory, root.id, {
      timeoutMs: requestTimeoutMs,
      deadline,
    });
    const hydrated = await hydrateSessions(server.url, directory, sessions, {
      timeoutMs: requestTimeoutMs,
      deadline,
    });
    const rootCompletedAt = commandResult?.info?.time?.completed ?? Date.now();
    const report = evaluateLiveCapture({
      caseId,
      root: { id: root.id, createdAt: root.time.created, completedAt: rootCompletedAt },
      sessions: hydrated,
      observation: { polls, statusTransitions },
    }, scenario);
    onProgress({ event: 'completed', passed: report.passed, childCount: report.metrics.childCount });
    return report;
  } catch (error) {
    if (root?.id && Date.now() >= deadline) {
      await abortRoot();
      throw new Error(`live evaluation timed out after ${timeoutMs}ms`);
    }
    throw new Error(diagnostic(error, 'live evaluation failed'));
  } finally {
    await server.close();
  }
}

export { request as requestOpenCode };
