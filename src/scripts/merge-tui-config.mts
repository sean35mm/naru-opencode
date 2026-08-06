import { readFile, writeFile } from 'node:fs/promises';

type UnknownRecord = Record<string, unknown>;
type Operation = 'register' | 'remove';

interface SourceRange {
  start: number;
  end: number;
}

interface EntryBoundary extends SourceRange {
  comma?: number;
}

interface PluginEntryRange extends EntryBoundary {
  value: unknown;
  valueStart: number;
  valueEnd: number;
}

interface TextEdit extends SourceRange {
  text: string;
}

function isOperation(value: unknown): value is Operation {
  return value === 'register' || value === 'remove';
}

function recordValue(value: unknown): UnknownRecord | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as UnknownRecord
    : null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const [input, output, pluginSpec, operationValue = 'register'] = process.argv.slice(2);
if (!input || !output || !pluginSpec || !isOperation(operationValue)) {
  throw new Error('usage: merge-tui-config INPUT OUTPUT PLUGIN_SPEC [register|remove]');
}
const operation: Operation = operationValue;

const naruSpecs = new Set([
  './plugins/naru-minions-dashboard.js',
  './plugins/naru-minions-dashboard.tsx',
  'plugins/naru-minions-dashboard.js',
  'plugins/naru-minions-dashboard.tsx',
]);

function stripJsonc(source: string): string {
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
      while (/\s/.test(result.charAt(cursor))) cursor += 1;
      if (result[cursor] !== '}' && result[cursor] !== ']') normalized += char;
    } else {
      normalized += char;
    }
  }
  return normalized;
}

function skipTrivia(source: string, cursor: number): number {
  while (cursor < source.length) {
    if (/\s/.test(source.charAt(cursor))) { cursor += 1; continue; }
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

function topLevelPluginRange(source: string): SourceRange | undefined {
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
        if (source[cursor] === '\\') { value += source.charAt(cursor) + source.charAt(cursor + 1); cursor += 1; continue; }
        if (source[cursor] === '"') break;
        value += source[cursor];
      }
      if ((JSON.parse(`"${value}"`) as unknown) !== 'plugin') { i = cursor; continue; }
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
  return undefined;
}

function jsonValueEnd(source: string, start: number): number {
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

function entryRanges(source: string, range: SourceRange): PluginEntryRange[] {
  const entries: PluginEntryRange[] = [];
  let segmentStart = range.start + 1;
  let depth = 1;
  let string = false;
  let escaped = false;
  let lineComment = false;
  let blockComment = false;
  const boundaries: EntryBoundary[] = [];
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
    const value = JSON.parse(clean.slice(first).trim()) as unknown;
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

function specifier(entry: unknown): string {
  if (typeof entry === 'string') return entry;
  if (Array.isArray(entry) && entry.length === 2 && typeof entry[0] === 'string' && entry[1] &&
      !Array.isArray(entry[1]) && typeof entry[1] === 'object') return entry[0];
  throw new Error('plugin entries must be strings or [string, options-object] tuples');
}

function applyEdits(source: string, edits: TextEdit[]): string {
  for (const edit of edits.sort((a, b) => b.start - a.start)) {
    source = source.slice(0, edit.start) + edit.text + source.slice(edit.end);
  }
  return source;
}

function removalEdits(
  source: string,
  range: SourceRange,
  entries: PluginEntryRange[],
  indexes: number[],
): TextEdit[] {
  const edits: TextEdit[] = [];
  for (let cursor = 0; cursor < indexes.length;) {
    const firstIndex = indexes[cursor];
    if (firstIndex === undefined) break;
    let lastIndex = firstIndex;
    while (indexes[cursor + 1] === lastIndex + 1) {
      cursor += 1;
      lastIndex += 1;
    }
    const firstEntry = entries[firstIndex];
    const lastEntry = entries[lastIndex];
    if (!firstEntry || !lastEntry) throw new Error('plugin entry range is invalid');
    if (lastIndex < entries.length - 1) {
      if (lastEntry.comma === undefined) throw new Error('plugin entry separator is missing');
      edits.push({ start: firstEntry.valueStart, end: lastEntry.comma + 1, text: '' });
    } else if (firstIndex === 0) {
      const end = lastEntry.comma === undefined ? lastEntry.valueEnd : lastEntry.comma + 1;
      edits.push({ start: firstEntry.valueStart, end, text: '' });
    } else {
      let comma = firstEntry.start - 1;
      while (comma > range.start && /\s/.test(source.charAt(comma))) comma -= 1;
      const end = lastEntry.comma === undefined ? lastEntry.valueEnd : lastEntry.comma + 1;
      edits.push({ start: source[comma] === ',' ? comma : firstEntry.valueStart, end, text: '' });
    }
    cursor += 1;
  }
  return edits;
}

const newline = input === '-' ? '\n' : (await readFile(input)).includes(13) ? '\r\n' : '\n';
let source = input === '-'
  ? `{${newline}  "$schema": "https://opencode.ai/tui.json",${newline}  "plugin": []${newline}}${newline}`
  : await readFile(input, 'utf8');

let parsed: unknown;
try {
  parsed = JSON.parse(stripJsonc(source)) as unknown;
} catch (error) {
  throw new Error(`malformed TUI config: ${errorMessage(error)}`);
}
const parsedRecord = recordValue(parsed);
if (!parsedRecord) throw new Error('TUI config root must be an object');
if (Object.hasOwn(parsedRecord, 'plugin') && !Array.isArray(parsedRecord.plugin)) throw new Error('top-level plugin must be an array');
for (const entry of Array.isArray(parsedRecord.plugin) ? parsedRecord.plugin : []) specifier(entry);

const range = topLevelPluginRange(source);
if (range) {
  const entries = entryRanges(source, range);
  const matches = entries.filter(entry => naruSpecs.has(specifier(entry.value)));
  const edits = [];
  if (operation === 'register' && matches.length) {
    const firstMatch = matches[0];
    if (!firstMatch) throw new Error('plugin match is unavailable');
    edits.push({ start: firstMatch.valueStart, end: firstMatch.valueEnd, text: JSON.stringify(pluginSpec) });
  }
  const removals = matches.slice(operation === 'register' ? 1 : 0).map(entry => entries.indexOf(entry));
  edits.push(...removalEdits(source, range, entries, removals));
  source = applyEdits(source, edits);
  if (operation === 'register' && !matches.length) {
    const updatedRange = topLevelPluginRange(source);
    if (!updatedRange) throw new Error('top-level plugin array is unavailable');
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
  source = `${before}${Object.keys(parsedRecord).length && !hasTrailingComma ? ',' : ''}${newline}  "plugin": [${newline}    ${JSON.stringify(pluginSpec)}${newline}  ]${newline}${source.slice(close)}`;
}

try {
  JSON.parse(stripJsonc(source));
} catch (error) {
  throw new Error(`generated malformed TUI config: ${errorMessage(error)}`);
}

await writeFile(output, source);
