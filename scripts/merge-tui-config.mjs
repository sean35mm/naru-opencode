import { readFile, writeFile } from 'node:fs/promises';

const [input, output, pluginSpec, operation = 'register'] = process.argv.slice(2);
if (!input || !output || !pluginSpec || !['register', 'remove'].includes(operation)) {
  throw new Error('usage: merge-tui-config INPUT OUTPUT PLUGIN_SPEC [register|remove]');
}

const naruSpecs = new Set([
  './plugins/naru-minions-dashboard.js',
  './plugins/naru-minions-dashboard.tsx',
  'plugins/naru-minions-dashboard.js',
  'plugins/naru-minions-dashboard.tsx',
]);

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

function topLevelPluginRange(source) {
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
      let cursor = i + 1;
      let value = '';
      for (; cursor < source.length; cursor += 1) {
        if (source[cursor] === '\\') { value += source[cursor] + source[cursor + 1]; cursor += 1; continue; }
        if (source[cursor] === '"') break;
        value += source[cursor];
      }
      if (JSON.parse(`"${value}"`) !== 'plugin') { i = cursor; continue; }
      cursor = skipTrivia(source, cursor + 1);
      if (source[cursor] !== ':') { i = cursor - 1; continue; }
      cursor = skipTrivia(source, cursor + 1);
      if (source[cursor] !== '[') throw new Error('top-level plugin must be an array');
      const start = cursor;
      let arrayDepth = 0;
      let arrayString = false;
      let arrayEscaped = false;
      let arrayLineComment = false;
      let arrayBlockComment = false;
      for (; cursor < source.length; cursor += 1) {
        const token = source[cursor];
        const nextToken = source[cursor + 1];
        if (arrayLineComment) { if (token === '\n') arrayLineComment = false; continue; }
        if (arrayBlockComment) { if (token === '*' && nextToken === '/') { arrayBlockComment = false; cursor += 1; } continue; }
        if (arrayString) {
          if (arrayEscaped) arrayEscaped = false;
          else if (token === '\\') arrayEscaped = true;
          else if (token === '"') arrayString = false;
        } else if (token === '/' && nextToken === '/') { arrayLineComment = true; cursor += 1; }
        else if (token === '/' && nextToken === '*') { arrayBlockComment = true; cursor += 1; }
        else if (token === '"') arrayString = true;
        else if (token === '[') arrayDepth += 1;
        else if (token === ']' && --arrayDepth === 0) return { start, end: cursor + 1 };
      }
      throw new Error('unterminated plugin array');
    }
    if (char === '"') string = true;
    else if (char === '{' || char === '[') depth += 1;
    else if (char === '}' || char === ']') depth -= 1;
  }
}

function jsonValueEnd(source, start) {
  if (source[start] === '"') {
    for (let i = start + 1, escaped = false; i < source.length; i += 1) {
      if (escaped) escaped = false;
      else if (source[i] === '\\') escaped = true;
      else if (source[i] === '"') return i + 1;
    }
  }
  const opening = source[start];
  if (opening !== '[' && opening !== '{') return start;
  let depth = 0;
  let string = false;
  let escaped = false;
  let lineComment = false;
  let blockComment = false;
  for (let i = start; i < source.length; i += 1) {
    const char = source[i];
    const next = source[i + 1];
    if (lineComment) { if (char === '\n') lineComment = false; continue; }
    if (blockComment) { if (char === '*' && next === '/') { blockComment = false; i += 1; } continue; }
    if (string) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') string = false;
    } else if (char === '/' && next === '/') { lineComment = true; i += 1; }
    else if (char === '/' && next === '*') { blockComment = true; i += 1; }
    else if (char === '"') string = true;
    else if (char === '[' || char === '{') depth += 1;
    else if ((char === ']' || char === '}') && --depth === 0) return i + 1;
  }
  return start;
}

function entryRanges(source, range) {
  const entries = [];
  let segmentStart = range.start + 1;
  let depth = 1;
  let string = false;
  let escaped = false;
  let lineComment = false;
  let blockComment = false;
  const boundaries = [];
  for (let i = segmentStart; i < range.end - 1; i += 1) {
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
    if (char === '/' && next === '/') { lineComment = true; i += 1; }
    else if (char === '/' && next === '*') { blockComment = true; i += 1; }
    else if (char === '"') string = true;
    else if (char === '[' || char === '{') depth += 1;
    else if (char === ']' || char === '}') depth -= 1;
    else if (char === ',' && depth === 1) {
      boundaries.push({ start: segmentStart, end: i, comma: i });
      segmentStart = i + 1;
    }
  }
  boundaries.push({ start: segmentStart, end: range.end - 1 });

  for (const boundary of boundaries) {
    const segment = source.slice(boundary.start, boundary.end);
    const clean = stripJsonc(segment);
    const first = clean.search(/\S/);
    if (first < 0) continue;
    const value = JSON.parse(clean.slice(first).trim());
    const valueStart = boundary.start + first;
    entries.push({
      ...boundary,
      value,
      valueStart,
      valueEnd: jsonValueEnd(source, valueStart),
    });
  }
  return entries;
}

function specifier(entry) {
  if (typeof entry === 'string') return entry;
  if (Array.isArray(entry) && entry.length === 2 && typeof entry[0] === 'string' && entry[1] &&
      !Array.isArray(entry[1]) && typeof entry[1] === 'object') return entry[0];
  throw new Error('plugin entries must be strings or [string, options-object] tuples');
}

function applyEdits(source, edits) {
  for (const edit of edits.sort((a, b) => b.start - a.start)) {
    source = source.slice(0, edit.start) + edit.text + source.slice(edit.end);
  }
  return source;
}

function removalEdits(source, range, entries, indexes) {
  const edits = [];
  for (let cursor = 0; cursor < indexes.length;) {
    const firstIndex = indexes[cursor];
    let lastIndex = firstIndex;
    while (indexes[cursor + 1] === lastIndex + 1) {
      cursor += 1;
      lastIndex += 1;
    }
    if (lastIndex < entries.length - 1) {
      edits.push({ start: entries[firstIndex].valueStart, end: entries[lastIndex].comma + 1, text: '' });
    } else if (firstIndex === 0) {
      const end = entries[lastIndex].comma === undefined ? entries[lastIndex].valueEnd : entries[lastIndex].comma + 1;
      edits.push({ start: entries[firstIndex].valueStart, end, text: '' });
    } else {
      let comma = entries[firstIndex].start - 1;
      while (comma > range.start && /\s/.test(source[comma])) comma -= 1;
      const end = entries[lastIndex].comma === undefined ? entries[lastIndex].valueEnd : entries[lastIndex].comma + 1;
      edits.push({ start: source[comma] === ',' ? comma : entries[firstIndex].valueStart, end, text: '' });
    }
    cursor += 1;
  }
  return edits;
}

const newline = input === '-' ? '\n' : (await readFile(input)).includes(13) ? '\r\n' : '\n';
let source = input === '-'
  ? `{${newline}  "$schema": "https://opencode.ai/tui.json",${newline}  "plugin": []${newline}}${newline}`
  : await readFile(input, 'utf8');

let parsed;
try {
  parsed = JSON.parse(stripJsonc(source));
} catch (error) {
  throw new Error(`malformed TUI config: ${error.message}`);
}
if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') throw new Error('TUI config root must be an object');
if (Object.hasOwn(parsed, 'plugin') && !Array.isArray(parsed.plugin)) throw new Error('top-level plugin must be an array');
for (const entry of parsed.plugin ?? []) specifier(entry);

const range = topLevelPluginRange(source);
if (range) {
  const entries = entryRanges(source, range);
  const matches = entries.filter(entry => naruSpecs.has(specifier(entry.value)));
  const edits = [];
  if (operation === 'register' && matches.length) {
    edits.push({ start: matches[0].valueStart, end: matches[0].valueEnd, text: JSON.stringify(pluginSpec) });
  }
  const removals = matches.slice(operation === 'register' ? 1 : 0).map(entry => entries.indexOf(entry));
  edits.push(...removalEdits(source, range, entries, removals));
  source = applyEdits(source, edits);
  if (operation === 'register' && !matches.length) {
    const updatedRange = topLevelPluginRange(source);
    const existing = entryRanges(source, updatedRange);
    const lineStart = source.lastIndexOf('\n', updatedRange.start) + 1;
    const indent = source.slice(lineStart, updatedRange.start).match(/^\s*/)?.[0] ?? '  ';
    const content = source.slice(updatedRange.start + 1, updatedRange.end - 1);
    const separator = existing.length && !/,\s*(?:\/\*[\s\S]*?\*\/\s*|\/\/[^\n]*(?:\n|$)\s*)*$/.test(content) ? ',' : '';
    const insertion = `${separator}${newline}${indent}  ${JSON.stringify(pluginSpec)}${newline}${indent}`;
    source = source.slice(0, updatedRange.end - 1) + insertion + source.slice(updatedRange.end - 1);
  }
} else if (operation === 'register') {
  const rootStart = skipTrivia(source, 0);
  const close = jsonValueEnd(source, rootStart) - 1;
  if (close < rootStart || source[close] !== '}') throw new Error('TUI config root is not closed');
  const before = source.slice(0, close);
  const hasTrailingComma = /,\s*(?:\/\*[\s\S]*?\*\/\s*|\/\/[^\n]*(?:\n|$)\s*)*$/.test(before);
  source = `${before}${Object.keys(parsed).length && !hasTrailingComma ? ',' : ''}${newline}  "plugin": [${newline}    ${JSON.stringify(pluginSpec)}${newline}  ]${newline}${source.slice(close)}`;
}

try {
  JSON.parse(stripJsonc(source));
} catch (error) {
  throw new Error(`generated malformed TUI config: ${error.message}`);
}

await writeFile(output, source);
