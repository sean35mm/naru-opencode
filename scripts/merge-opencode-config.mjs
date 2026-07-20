import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';

const [input, output] = process.argv.slice(2);
if (!input || !output) {
  throw new Error('usage: merge-opencode-config INPUT OUTPUT');
}

const MAX_CONFIG_BYTES = 64 * 1024;
const SAFE_NEW_CONFIG_MODE = 0o600;

function stripJsonc(source) {
  let result = '';
  let string = false;
  let escaped = false;
  for (let i = 0; i < source.length; i += 1) {
    const char = source[i];
    const next = source[i + 1];
    if (string) {
      result += char;
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') string = false;
    } else if (char === '"') {
      string = true;
      result += char;
    } else if (char === '/' && next === '/') {
      result += '  ';
      i += 1;
      while (i + 1 < source.length && source[i + 1] !== '\n') { result += ' '; i += 1; }
    } else if (char === '/' && next === '*') {
      result += '  ';
      i += 1;
      while (i + 1 < source.length && !(source[i + 1] === '*' && source[i + 2] === '/')) {
        i += 1;
        result += source[i] === '\n' ? '\n' : ' ';
      }
      if (i + 2 >= source.length) throw new Error('unterminated block comment');
      result += '  ';
      i += 2;
    } else {
      result += char;
    }
  }
  if (string) throw new Error('unterminated string');

  let normalized = '';
  string = false;
  escaped = false;
  for (let i = 0; i < result.length; i += 1) {
    const char = result[i];
    if (string) {
      normalized += char;
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') string = false;
    } else if (char === '"') {
      string = true;
      normalized += char;
    } else if (char === ',') {
      let cursor = i + 1;
      while (/\s/.test(result[cursor])) cursor += 1;
      if (result[cursor] !== '}' && result[cursor] !== ']') normalized += char;
    } else {
      normalized += char;
    }
  }
  return normalized;
}

function skipTrivia(source, cursor) {
  while (cursor < source.length) {
    if (/\s/.test(source[cursor])) { cursor += 1; continue; }
    if (source[cursor] === '/' && source[cursor + 1] === '/') {
      const end = source.indexOf('\n', cursor + 2);
      return end < 0 ? source.length : skipTrivia(source, end + 1);
    }
    if (source[cursor] === '/' && source[cursor + 1] === '*') {
      const end = source.indexOf('*/', cursor + 2);
      if (end < 0) throw new Error('unterminated block comment');
      cursor = end + 2;
      continue;
    }
    return cursor;
  }
  return cursor;
}

function topLevelProperties(source) {
  const properties = [];
  let depth = 0;
  let string = false;
  let escaped = false;
  let lineComment = false;
  let blockComment = false;
  for (let i = 0; i < source.length; i += 1) {
    const char = source[i];
    const next = source[i + 1];
    if (lineComment) { if (char === '\n') lineComment = false; continue; }
    if (blockComment) { if (char === '*' && next === '/') { blockComment = false; i += 1; } continue; }
    if (string) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') string = false;
      continue;
    }
    if (char === '/' && next === '/') { lineComment = true; i += 1; continue; }
    if (char === '/' && next === '*') { blockComment = true; i += 1; continue; }
    if (char === '"' && depth === 1) {
      const keyStart = i;
      let cursor = i + 1;
      let raw = '';
      for (; cursor < source.length; cursor += 1) {
        if (source[cursor] === '\\') {
          if (cursor + 1 >= source.length) break;
          raw += source[cursor] + source[cursor + 1];
          cursor += 1;
          continue;
        }
        if (source[cursor] === '"') break;
        raw += source[cursor];
      }
      if (cursor >= source.length) throw new Error('unterminated string');
      const colon = skipTrivia(source, cursor + 1);
      if (source[colon] === ':') {
        properties.push({
          key: JSON.parse(`"${raw}"`),
          keyStart,
          valueStart: skipTrivia(source, colon + 1),
        });
      }
      i = cursor;
      continue;
    }
    if (char === '"') string = true;
    else if (char === '{' || char === '[') depth += 1;
    else if (char === '}' || char === ']') depth -= 1;
  }
  return properties;
}

async function readRegularConfig(path) {
  const info = await lstat(path);
  if (info.isSymbolicLink()) throw new Error(`OpenCode config must not be a symlink: ${path}`);
  if (!info.isFile()) throw new Error(`OpenCode config must be a regular file: ${path}`);
  if (info.size > MAX_CONFIG_BYTES) throw new Error(`OpenCode config exceeds ${MAX_CONFIG_BYTES} bytes`);

  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat();
    if (!opened.isFile()) throw new Error(`OpenCode config must be a regular file: ${path}`);
    if (opened.size > MAX_CONFIG_BYTES) throw new Error(`OpenCode config exceeds ${MAX_CONFIG_BYTES} bytes`);
    return {
      mode: opened.mode & 0o777,
      source: await handle.readFile('utf8'),
    };
  } finally {
    await handle.close();
  }
}

async function validateOutput(path) {
  try {
    const info = await lstat(path);
    if (info.isSymbolicLink()) throw new Error(`output must not be a symlink: ${path}`);
    if (!info.isFile()) throw new Error(`output must be a regular file: ${path}`);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
}

async function writePreparedConfig(path, source, mode) {
  await validateOutput(path);
  const handle = await open(
    path,
    constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | (constants.O_NOFOLLOW ?? 0),
    mode,
  );
  try {
    await handle.writeFile(source, 'utf8');
    await handle.chmod(mode);
  } finally {
    await handle.close();
  }
}

const newline = input === '-' ? '\n' : undefined;
const config = input === '-'
  ? {
      mode: SAFE_NEW_CONFIG_MODE,
      source: `{\n  "$schema": "https://opencode.ai/config.json",\n  "subagent_depth": 2\n}\n`,
    }
  : await readRegularConfig(input);
let { source } = config;
const lineEnding = newline ?? (source.includes('\r\n') ? '\r\n' : '\n');

let parsed;
try {
  parsed = JSON.parse(stripJsonc(source));
} catch (error) {
  throw new Error(`malformed OpenCode config: ${error.message}`);
}
if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') {
  throw new Error('OpenCode config root must be an object');
}

const properties = topLevelProperties(source);
const depthProperties = properties.filter(property => property.key === 'subagent_depth');
if (depthProperties.length > 1) throw new Error('duplicate top-level subagent_depth is ambiguous');

if (Object.hasOwn(parsed, 'subagent_depth')) {
  const depth = parsed.subagent_depth;
  if (!Number.isSafeInteger(depth) || depth < 0) {
    throw new Error('top-level subagent_depth must be a non-negative safe integer');
  }
  if (depth < 2) {
    const property = depthProperties[0];
    if (!property) throw new Error('could not locate top-level subagent_depth');
    const number = source.slice(property.valueStart).match(/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/)?.[0];
    if (!number) throw new Error('could not locate top-level subagent_depth value');
    source = source.slice(0, property.valueStart) + '2' + source.slice(property.valueStart + number.length);
  }
} else {
  const rootStart = skipTrivia(source, 0);
  if (source[rootStart] !== '{') throw new Error('OpenCode config root is not an object');
  const first = properties[0];
  let indent = '  ';
  if (first) {
    const lineStart = source.lastIndexOf('\n', first.keyStart) + 1;
    indent = source.slice(lineStart, first.keyStart).match(/^\s*/)?.[0] || indent;
  }
  const insertion = `${lineEnding}${indent}"subagent_depth": 2${Object.keys(parsed).length ? ',' : ''}${lineEnding}`;
  source = source.slice(0, rootStart + 1) + insertion + source.slice(rootStart + 1);
}

let generated;
try {
  generated = JSON.parse(stripJsonc(source));
} catch (error) {
  throw new Error(`generated malformed OpenCode config: ${error.message}`);
}
if (!Number.isSafeInteger(generated.subagent_depth) || generated.subagent_depth < 2) {
  throw new Error('generated OpenCode config has invalid subagent_depth');
}
if (topLevelProperties(source).filter(property => property.key === 'subagent_depth').length !== 1) {
  throw new Error('generated OpenCode config has ambiguous subagent_depth');
}

await writePreparedConfig(output, source, config.mode);
