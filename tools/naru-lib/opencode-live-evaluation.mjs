import { spawn } from 'node:child_process';
import { request as httpRequest } from 'node:http';
import { createServer } from 'node:net';

import { LIVE_EVALUATION_CASES, evaluateLiveCapture } from './live-evaluation.mjs';

const MAX_SERVER_OUTPUT = 8192;
const MAX_RESPONSE_BYTES = 10 * 1024 * 1024;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

async function startServer({ executable, directory, startupTimeoutMs }) {
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
      reject(error);
    });
    proc.once('exit', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`OpenCode server exited before startup with code ${code}: ${output.trim()}`));
    });
  }).catch((error) => {
    proc.kill('SIGTERM');
    throw error;
  });

  const readyDeadline = Date.now() + startupTimeoutMs;
  let readinessError;
  while (Date.now() < readyDeadline) {
    try {
      const response = await fetch(new URL('/global/health', url));
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
    proc.kill('SIGTERM');
    const cause = readinessError.cause?.code ?? readinessError.message;
    throw new Error(`OpenCode server was not reachable after startup (${cause}): ${output.trim()}`);
  }

  return {
    url,
    async close() {
      if (proc.exitCode !== null || proc.signalCode !== null) return;
      proc.kill('SIGTERM');
      await Promise.race([
        new Promise((resolve) => proc.once('exit', resolve)),
        sleep(2000).then(() => {
          if (proc.exitCode === null && proc.signalCode === null) proc.kill('SIGKILL');
        }),
      ]);
    },
  };
}

async function request(baseURL, directory, method, path, body) {
  const url = new URL(path, baseURL);
  url.searchParams.set('directory', directory);
  if (url.protocol !== 'http:') throw new Error('live evaluation requires a localhost HTTP OpenCode server');
  const payload = body === undefined ? undefined : JSON.stringify(body);
  const { status, text } = await new Promise((resolve, reject) => {
    const req = httpRequest(url, {
      method,
      headers: payload === undefined ? undefined : {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(payload),
      },
    }, (response) => {
      const chunks = [];
      let size = 0;
      response.on('data', (chunk) => {
        size += chunk.length;
        if (size > MAX_RESPONSE_BYTES) {
          req.destroy(new Error(`OpenCode ${method} ${path} response exceeded ${MAX_RESPONSE_BYTES} bytes`));
          return;
        }
        chunks.push(chunk);
      });
      response.on('end', () => resolve({
        status: response.statusCode ?? 0,
        text: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    req.once('error', (error) => {
      const cause = error.cause?.code ?? error.cause?.message ?? error.message;
      reject(new Error(`OpenCode ${method} ${path} transport failed: ${cause}`));
    });
    if (payload !== undefined) req.write(payload);
    req.end();
  });
  if (status < 200 || status >= 300) {
    throw new Error(`OpenCode ${method} ${path} failed (${status}): ${text.slice(0, 512)}`);
  }
  return text ? JSON.parse(text) : undefined;
}

async function collectSessions(baseURL, directory, rootID) {
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

async function hydrateSessions(baseURL, directory, sessions) {
  return Promise.all(sessions.map(async (session) => {
    const messages = await request(
      baseURL,
      directory,
      'GET',
      `/session/${encodeURIComponent(session.id)}/message`,
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
} = {}) {
  const scenario = LIVE_EVALUATION_CASES[caseId];
  if (!scenario) throw new Error(`unknown live evaluation case: ${caseId}`);
  if (typeof directory !== 'string' || !directory) throw new Error('live evaluation directory is required');
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 60 * 60 * 1000) {
    throw new Error('live evaluation timeout must be from 1000 to 3600000 milliseconds');
  }
  if (typeof onProgress !== 'function') throw new Error('live evaluation onProgress must be a function');

  const server = await startServer({ executable, directory, startupTimeoutMs });
  let root;
  const observedStatuses = new Map();
  const discovered = new Set();
  let polls = 0;
  let statusTransitions = 0;
  try {
    root = await request(server.url, directory, 'POST', '/session', {
      title: `Naru live evaluation: ${caseId}`,
    });
    onProgress({ event: 'root-started', rootSessionId: root.id });
    let commandDone = false;
    let commandResult;
    let commandError;
    const command = request(
      server.url,
      directory,
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

    const deadline = Date.now() + timeoutMs;
    while (!commandDone) {
      if (Date.now() >= deadline) {
        await request(server.url, directory, 'POST', `/session/${encodeURIComponent(root.id)}/abort`);
        throw new Error(`live evaluation timed out after ${timeoutMs}ms`);
      }
      const [sessions, statuses] = await Promise.all([
        collectSessions(server.url, directory, root.id),
        request(server.url, directory, 'GET', '/session/status'),
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

    const sessions = await collectSessions(server.url, directory, root.id);
    const hydrated = await hydrateSessions(server.url, directory, sessions);
    const rootCompletedAt = commandResult?.info?.time?.completed ?? Date.now();
    const report = evaluateLiveCapture({
      caseId,
      root: { id: root.id, createdAt: root.time.created, completedAt: rootCompletedAt },
      sessions: hydrated,
      observation: { polls, statusTransitions },
    }, scenario);
    onProgress({ event: 'completed', passed: report.passed, childCount: report.metrics.childCount });
    return report;
  } finally {
    await server.close();
  }
}
