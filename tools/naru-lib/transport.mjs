// Injectable argv transport. In production this spawns processes via Bun.spawn
// with fixed argv arrays (no shell). Tests inject a fake spawn to avoid real
// network or file-system calls.

const DEFAULT_TIMEOUT = 30000;
const DEFAULT_MAX_BYTES = 10 * 1024 * 1024;
const DEFAULT_KILL_GRACE_MS = 1000;
const FINALIZATION_GRACE_MS = 250;
const MAX_TIMEOUT_MS = 60 * 60 * 1000;
const MAX_KILL_GRACE_MS = 30000;

function truncateUtf8(buf, maxBytes) {
  if (buf.length <= maxBytes) return { text: buf.toString('utf-8'), truncated: false };
  const slice = buf.subarray(0, maxBytes);
  let end = slice.length;
  while (end > 0 && (slice[end - 1] & 0xc0) === 0x80) {
    end -= 1;
  }
  return { text: slice.subarray(0, end).toString('utf-8'), truncated: true };
}

function capture(reader, maxBytes) {
  const chunks = [];
  let kept = 0;
  let truncated = false;
  let cancelled = false;
  let error;
  const promise = (async () => {
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
        const take = Math.max(0, Math.min(chunk.length, maxBytes - kept));
        if (take > 0) chunks.push(chunk.subarray(0, take));
        kept += take;
        if (take < chunk.length) truncated = true;
      }
    } catch (readError) {
      if (!cancelled) error = readError;
    }
  })();
  return {
    promise,
    snapshot() {
      return { buffer: Buffer.concat(chunks), truncated, error };
    },
    cancel() {
      cancelled = true;
      try {
        Promise.resolve(reader.cancel()).catch(() => {});
      } catch {
        // ignore
      }
    },
  };
}

function waitFor(promise, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve({ timedOut: true });
    }, timeoutMs);
    promise.then((value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ timedOut: false, value });
    }, (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ timedOut: false, error });
    });
  });
}

function resultFromCaptures({ exitCode, stdoutCapture, stderrCapture, timedOut, terminationEscalated }) {
  const stdoutResult = stdoutCapture.snapshot();
  const stderrResult = stderrCapture.snapshot();
  if (!timedOut && stdoutResult.error) throw stdoutResult.error;
  if (!timedOut && stderrResult.error) throw stderrResult.error;
  const out = truncateUtf8(stdoutResult.buffer, stdoutResult.buffer.length);
  const err = truncateUtf8(stderrResult.buffer, stderrResult.buffer.length);
  return {
    ok: !timedOut && exitCode === 0,
    code: exitCode,
    stdout: out.text,
    stderr: err.text,
    stdoutTruncated: stdoutResult.truncated || out.truncated,
    stderrTruncated: stderrResult.truncated || err.truncated,
    ...(timedOut ? { timedOut: true, terminationEscalated } : {}),
  };
}

function kill(proc, signal) {
  try {
    proc.kill(signal);
  } catch {
    // ignore
  }
}

function validateOptions({ timeout, maxBytes, killGraceMs }, prefix) {
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > MAX_TIMEOUT_MS) {
    throw new Error(`${prefix} timeout must be from 1 to ${MAX_TIMEOUT_MS} milliseconds`);
  }
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    throw new Error(`${prefix} maxBytes must be a positive safe integer`);
  }
  if (!Number.isSafeInteger(killGraceMs) || killGraceMs < 1 || killGraceMs > MAX_KILL_GRACE_MS) {
    throw new Error(`${prefix} killGraceMs must be from 1 to ${MAX_KILL_GRACE_MS} milliseconds`);
  }
}

async function defaultSpawn(argv, {
  input,
  cwd,
  timeout = DEFAULT_TIMEOUT,
  maxBytes = DEFAULT_MAX_BYTES,
  killGraceMs = DEFAULT_KILL_GRACE_MS,
} = {}) {
  if (typeof Bun === 'undefined' || !Bun.spawn) {
    throw new Error('Bun.spawn is unavailable; this transport requires Bun in production');
  }
  validateOptions({ timeout, maxBytes, killGraceMs }, 'run');

  const proc = Bun.spawn(argv, {
    cwd,
    stdin: input === undefined ? 'ignore' : Buffer.from(input, 'utf-8'),
    stdout: 'pipe',
    stderr: 'pipe',
    env: {
      ...process.env,
      NO_COLOR: '1',
      PAGER: 'cat',
      GIT_PAGER: 'cat',
    },
  });

  const stdoutCapture = capture(proc.stdout.getReader(), maxBytes);
  const stderrCapture = capture(proc.stderr.getReader(), maxBytes);
  const exited = Promise.resolve(proc.exited);
  const completed = Promise.all([exited, stdoutCapture.promise, stderrCapture.promise])
    .then(([exitCode]) => exitCode);
  const initial = await waitFor(completed, timeout);
  if (!initial.timedOut) {
    if (initial.error) throw initial.error;
    return resultFromCaptures({
      exitCode: initial.value,
      stdoutCapture,
      stderrCapture,
      timedOut: false,
      terminationEscalated: false,
    });
  }

  kill(proc, 'SIGTERM');
  const gracefulExit = await waitFor(exited, killGraceMs);
  let terminationEscalated = false;
  let exitCode = gracefulExit.value ?? null;
  if (gracefulExit.timedOut) {
    terminationEscalated = true;
    kill(proc, 'SIGKILL');
    const forcedExit = await waitFor(exited, FINALIZATION_GRACE_MS);
    exitCode = forcedExit.value ?? null;
  }
  stdoutCapture.cancel();
  stderrCapture.cancel();
  await waitFor(Promise.all([stdoutCapture.promise, stderrCapture.promise]), FINALIZATION_GRACE_MS);
  return resultFromCaptures({
    exitCode,
    stdoutCapture,
    stderrCapture,
    timedOut: true,
    terminationEscalated,
  });
}

export async function run(argv, { spawn, input, cwd, timeout, maxBytes, killGraceMs } = {}) {
  const spawner = spawn || defaultSpawn;
  if (!Array.isArray(argv)) throw new Error('run argv must be an array');
  if (argv.length === 0) throw new Error('run argv must not be empty');
  if (argv.some((a) => typeof a !== 'string')) throw new Error('run argv must contain only strings');
  validateOptions({
    timeout: timeout ?? DEFAULT_TIMEOUT,
    maxBytes: maxBytes ?? DEFAULT_MAX_BYTES,
    killGraceMs: killGraceMs ?? DEFAULT_KILL_GRACE_MS,
  }, 'run');
  return spawner(argv, { input, cwd, timeout, maxBytes, killGraceMs });
}

export { defaultSpawn };
