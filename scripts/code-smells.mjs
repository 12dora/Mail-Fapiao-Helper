#!/usr/bin/env node
/**
 * Informational, zero-dependency source inventory; this is not a lint gate.
 * Counts physical lines (including comments/blanks). Function/export discovery
 * is lexical: declarations, block arrows and methods are recognized, while
 * expression arrows, template interpolations and wildcard re-export targets
 * are not expanded. Complex TS return types / JSX can require manual review.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']);
const CONTROL_WORDS = new Set(['if', 'for', 'while', 'switch', 'catch', 'with']);
const REGEX_PREFIXES = new Set(['=', '(', '[', '{', ',', ':', ';', '!', '?', '=>', 'return', 'throw', 'case', '&&', '||', '??']);

function sourceFiles(directory) {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const filename = path.join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(filename);
    return entry.isFile() && SOURCE_EXTENSIONS.has(path.extname(filename)) ? [filename] : [];
  });
}

function quotedEnd(source, start) {
  const quote = source[start];
  let cursor = start + 1;
  while (cursor < source.length) {
    if (source[cursor] === '\\') cursor += 2;
    else if (source[cursor++] === quote) return cursor;
  }
  return cursor;
}

function regexEnd(source, start) {
  let cursor = start + 1;
  let inClass = false;
  while (cursor < source.length && source[cursor] !== '\n') {
    const char = source[cursor++];
    if (char === '\\') cursor++;
    else if (char === '[') inClass = true;
    else if (char === ']') inClass = false;
    else if (char === '/' && !inClass) return cursor;
  }
  return start + 1;
}

function tokenEnd(source, start, previous) {
  const rest = source.slice(start);
  if (rest.startsWith('//')) {
    const newline = source.indexOf('\n', start);
    return { end: newline < 0 ? source.length : newline, skip: true };
  }
  if (rest.startsWith('/*')) {
    const close = source.indexOf('*/', start + 2);
    return { end: close < 0 ? source.length : close + 2, skip: true };
  }
  if (/^['"`]/.test(rest)) return { end: quotedEnd(source, start), value: '<literal>' };
  if (rest[0] === '/' && (!previous || REGEX_PREFIXES.has(previous))) {
    return { end: regexEnd(source, start), value: '<literal>' };
  }
  const match = /^(?:[\p{ID_Start}_$][\p{ID_Continue}$]*|=>|\?\.|&&|\|\||\?\?|[^\s])/u.exec(rest);
  return { end: start + match[0].length, value: match[0] };
}

function tokenize(source) {
  const tokens = [];
  let line = 1;
  let cursor = 0;
  while (cursor < source.length) {
    if (/\s/.test(source[cursor])) {
      if (source[cursor] === '\n') line++;
      cursor++;
      continue;
    }
    const token = tokenEnd(source, cursor, tokens.at(-1)?.value);
    if (!token.skip) tokens.push({ value: token.value, line });
    line += (source.slice(cursor, token.end).match(/\n/g) || []).length;
    cursor = token.end;
  }
  return tokens;
}

function delimiterPairs(tokens) {
  const pairs = new Map();
  const stack = [];
  const opening = { ')': '(', ']': '[', '}': '{' };
  for (let index = 0; index < tokens.length; index++) {
    const value = tokens[index].value;
    if (['(', '[', '{'].includes(value)) stack.push(index);
    else if (opening[value] && tokens[stack.at(-1)]?.value === opening[value]) {
      const start = stack.pop();
      pairs.set(start, index);
      pairs.set(index, start);
    }
  }
  return pairs;
}

function identifier(value) {
  return !!value && /^[\p{ID_Start}_$][\p{ID_Continue}$]*$/u.test(value);
}

function assignedName(tokens, start) {
  for (let index = start - 1; index >= Math.max(0, start - 8); index--) {
    const value = tokens[index].value;
    if ([';', '{', '}', '=>', ','].includes(value)) break;
    if (['=', ':'].includes(value) && identifier(tokens[index - 1]?.value)) return tokens[index - 1].value;
  }
  return '<anonymous>';
}

function parameterEnd(tokens, pairs, body) {
  // Skip paired return types, including the object-shaped DI factory contracts.
  for (let index = body - 1; index >= 0; index--) {
    const value = tokens[index].value;
    if (value === ')') return index;
    if (['}', ']'].includes(value) && pairs.has(index)) {
      index = pairs.get(index);
      if (value === '}' && ![':', '|', '&'].includes(tokens[index - 1]?.value)) return undefined;
      continue;
    }
    if ([';', '{', '=', '=>'].includes(value)) break;
  }
  return undefined;
}

function arrowFunction(tokens, pairs, body) {
  const last = body - 2;
  const end = tokens[last]?.value === ')' ? last : parameterEnd(tokens, pairs, body - 1);
  let start = end === undefined ? last : pairs.get(end);
  if (start === undefined) return undefined;
  if (tokens[start - 1]?.value === 'async') start--;
  return { start, name: assignedName(tokens, start) };
}

function ordinaryFunction(tokens, pairs, body) {
  const end = parameterEnd(tokens, pairs, body);
  if (end === undefined) return undefined;
  const params = pairs.get(end);
  if (params === undefined) return undefined;
  const before = tokens[params - 1]?.value;
  if (CONTROL_WORDS.has(before)) return undefined;
  // Method/function generic parameters: name<T>(...).
  let nameIndex = params - 1;
  if (before === '>') {
    while (nameIndex > 0 && tokens[nameIndex].value !== '<') nameIndex--;
    nameIndex--;
  }
  const name = tokens[nameIndex]?.value;
  if (!identifier(name)) return undefined;
  let start = nameIndex;
  if (tokens[start - 1]?.value === '*') start--;
  if (tokens[start - 1]?.value === 'function') start--;
  if (tokens[start - 1]?.value === 'async') start--;
  if (name === 'function') return { start, name: assignedName(tokens, start) };
  // Reject calls followed by an unrelated block, but allow declarations/methods.
  if (['.', '?.', 'new', 'return', '='].includes(tokens[start - 1]?.value)) return undefined;
  return { start, name };
}

function functionsIn(tokens, pairs, filename) {
  const functions = [];
  for (let body = 0; body < tokens.length; body++) {
    if (tokens[body].value !== '{' || !pairs.has(body)) continue;
    if ([':', '<', '|', '&'].includes(tokens[body - 1]?.value)) {
      body = pairs.get(body);
      continue;
    }
    const fn = tokens[body - 1]?.value === '=>'
      ? arrowFunction(tokens, pairs, body)
      : ordinaryFunction(tokens, pairs, body);
    if (!fn) continue;
    const startLine = tokens[fn.start].line;
    const endLine = tokens[pairs.get(body)].line;
    functions.push({ file: filename, name: fn.name, startLine, endLine, lines: endLine - startLine + 1 });
  }
  return functions;
}

function namedExportCount(tokens, pairs, start) {
  const end = pairs.get(start);
  if (end === undefined || end === start + 1) return 0;
  let count = 1;
  for (let index = start + 1; index < end; index++) {
    if (tokens[index].value === ',' && index + 1 < end) count++;
  }
  return count;
}

function exportCount(tokens, pairs) {
  let count = 0;
  for (let index = 0; index < tokens.length; index++) {
    if (tokens[index].value !== 'export') continue;
    const next = tokens[index + 1]?.value === 'type' ? index + 2 : index + 1;
    count += tokens[next]?.value === '{' ? namedExportCount(tokens, pairs, next) : 1;
  }
  return count;
}

export function analyzeSource(source, filename) {
  const tokens = tokenize(source);
  const pairs = delimiterPairs(tokens);
  const lines = source.length ? source.split('\n').length - Number(source.endsWith('\n')) : 0;
  return { file: filename, lines, exports: exportCount(tokens, pairs), functions: functionsIn(tokens, pairs, filename) };
}

export function collectReport(root) {
  const files = ['src', 'gui-design/src'].flatMap(directory => sourceFiles(path.join(root, directory)));
  const results = files.map(filename => analyzeSource(fs.readFileSync(filename, 'utf8'), path.relative(root, filename).split(path.sep).join('/')));
  const descending = (a, b) => b.lines - a.lines || a.file.localeCompare(b.file);
  return {
    note: 'Informational lexical report; physical lines include comments/blanks. Expression arrows, template interpolations and wildcard targets are not expanded; complex TS/JSX may need review.',
    scannedFiles: results.length,
    largestFiles: results.map(({ functions: _functions, ...file }) => file).sort(descending).slice(0, 15),
    longFunctions: results.flatMap(file => file.functions).filter(fn => fn.lines > 80).sort(descending),
    exportHeavyFiles: results.filter(file => file.exports > 25).map(({ functions: _functions, ...file }) => file).sort((a, b) => b.exports - a.exports || a.file.localeCompare(b.file)),
  };
}

function printReport(report) {
  console.log(report.note);
  console.log(`\n15 largest files (${report.scannedFiles} source files scanned):`);
  for (const file of report.largestFiles) console.log(`  ${file.lines.toString().padStart(5)} lines  ${file.file}`);
  console.log('\nFunctions over 80 lines:');
  for (const fn of report.longFunctions) console.log(`  ${fn.lines.toString().padStart(5)} lines  ${fn.file}:${fn.startLine}  ${fn.name}`);
  if (!report.longFunctions.length) console.log('  None');
  console.log('\nFiles with more than 25 exports:');
  for (const file of report.exportHeavyFiles) console.log(`  ${file.exports.toString().padStart(5)} exports  ${file.file}`);
  if (!report.exportHeavyFiles.length) console.log('  None');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const report = collectReport(root);
  if (process.argv.includes('--json')) console.log(JSON.stringify(report, null, 2));
  else printReport(report);
}
