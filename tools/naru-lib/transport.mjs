// Injectable argv transport. In production this spawns processes via Bun.spawn
// with fixed argv arrays (no shell). Tests inject a fake spawn to avoid real
// network or file-system calls.

const DEFAULT_TIMEOUT = 30000;
const DEFAULT_MAX_BYTES = 10 * 1024 * 1024;

function truncateUtf8(buf, maxBytes) {
  if (buf.length <= maxBytes) return { text: buf.toString('utf-8'), truncated: false };
  const slice = buf.subarray(0, maxBytes);
  let end = slice.length;
  while (end > 0 && (slice[end - 1] & 0xc0) === 0x80) {
    end -= 1;
  }
  return { text: slice.subarray(0, end).toString('utf-8'), truncated: true };
}

async function drain(reader, maxBytes) {
  const chunks = [];
  let kept = 0;
  let truncated = false;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
    const take = Math.max(0, Math.min(chunk.length, maxBytes - kept));
    if (take > 0) chunks.push(chunk.subarray(0, take));
    kept += take;
    if (take < chunk.length) truncated = true;
  }
  return { buffer: Buffer.concat(chunks), truncated };
}

async function defaultSpawn(argv, { input, cwd, timeout = DEFAULT_TIMEOUT, maxBytes = DEFAULT_MAX_BYTES }) {
  if (typeof Bun === 'undefined' || !Bun.spawn) {
    throw new Error('Bun.spawn is unavailable; this transport requires Bun in production');
  }

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

  const timer = setTimeout(() => {
    try {
      proc.kill('SIGTERM');
    } catch {
      // ignore
    }
  }, timeout);

  let stdoutResult;
  let stderrResult;
  try {
    [stdoutResult, stderrResult] = await Promise.all([
      drain(proc.stdout.getReader(), maxBytes),
      drain(proc.stderr.getReader(), maxBytes),
    ]);
  } catch (e) {
    clearTimeout(timer);
    throw e;
  }

  const exitCode = await proc.exited;
  clearTimeout(timer);

  const out = truncateUtf8(stdoutResult.buffer, maxBytes);
  const err = truncateUtf8(stderrResult.buffer, maxBytes);
  return {
    ok: exitCode === 0,
    code: exitCode,
    stdout: out.text,
    stderr: err.text,
    stdoutTruncated: stdoutResult.truncated || out.truncated,
    stderrTruncated: stderrResult.truncated || err.truncated,
  };
}

export async function run(argv, { spawn, input, cwd, timeout, maxBytes } = {}) {
  const spawner = spawn || defaultSpawn;
  if (!Array.isArray(argv)) throw new Error('run argv must be an array');
  if (argv.length === 0) throw new Error('run argv must not be empty');
  if (argv.some((a) => typeof a !== 'string')) throw new Error('run argv must contain only strings');
  return spawner(argv, { input, cwd, timeout, maxBytes });
}

export { defaultSpawn };
