import fs from 'node:fs';
import path from 'node:path';
import { authorityContractRegistry, validateAuthorityProof } from './mutationAuthorityContracts.js';

const MUTATION_METHODS = new Set(['post', 'put', 'patch', 'delete']);

const WEBHOOK_ALLOWLIST = new Set([
  'src/routes/calls.js|POST|/asterisk/events',
  'src/routes/licenciasMp.js|POST|/mercadopago',
  'src/routes/whatsappCloudWebhook.js|POST|/',
  'src/qr/pagosWebhookRouter.js|POST|/pagos',
  'src/qr/pagosWebhookRouter.js|POST|/pagos/:proveedor',
]);
const CRON_ALLOWLIST = new Set([
  'src/wpp/cronRoutes.js|POST|/internal/cron/cleanup-tracking',
  'src/wpp/cronRoutes.js|POST|/internal/cron/cleanup-wpp',
]);


function skipString(text, start) {
  const quote = text[start];
  let i = start + 1;
  while (i < text.length) {
    if (text[i] === '\\') { i += 2; continue; }
    if (text[i] === quote) return i + 1;
    i += 1;
  }
  return text.length;
}

function skipSlashExpression(text, start) {
  if (text[start + 1] === '/') {
    const newline = text.indexOf('\n', start + 2);
    return newline === -1 ? text.length : newline;
  }
  if (text[start + 1] === '*') {
    const close = text.indexOf('*/', start + 2);
    return close === -1 ? text.length : close + 2;
  }
  let previous = start - 1;
  while (/\s/.test(text[previous] || '')) previous -= 1;
  const prefix = text.slice(Math.max(0, previous - 8), previous + 1);
  const regexContext = previous < 0 || /[=(:,!&|?{};\[]/.test(text[previous]) || /\b(?:return|case|throw)$/.test(prefix);
  if (!regexContext) return start + 1;
  let inClass = false;
  for (let i = start + 1; i < text.length; i += 1) {
    if (text[i] === '\\') { i += 1; continue; }
    if (text[i] === '[') inClass = true;
    else if (text[i] === ']') inClass = false;
    else if (text[i] === '/' && !inClass) {
      i += 1;
      while (/[A-Za-z]/.test(text[i] || '')) i += 1;
      return i;
    }
  }
  return text.length;
}

function matchingDelimiter(text, start, open = '(', close = ')') {
  let depth = 0;
  for (let i = start; i < text.length; i += 1) {
    const char = text[i];
    if (char === "'" || char === '"' || char === '`') { i = skipString(text, i) - 1; continue; }
    if (char === '/') { const next = skipSlashExpression(text, i); if (next > i + 1) { i = next - 1; continue; } }
    if (char === open) depth += 1;
    else if (char === close && --depth === 0) return i;
  }
  return text.length - 1;
}

function splitArguments(text, openParen) {
  const end = matchingDelimiter(text, openParen);
  const args = [];
  let depth = 0;
  let start = openParen + 1;
  for (let i = start; i < end; i += 1) {
    const char = text[i];
    if (char === "'" || char === '"' || char === '`') { i = skipString(text, i) - 1; continue; }
    if (char === '/') { const next = skipSlashExpression(text, i); if (next > i + 1) { i = next - 1; continue; } }
    if (char === '(' || char === '[' || char === '{') depth += 1;
    else if (char === ')' || char === ']' || char === '}') depth -= 1;
    else if (char === ',' && depth === 0) { args.push(text.slice(start, i).trim()); start = i + 1; }
  }
  args.push(text.slice(start, end).trim());
  return { args, end };
}

function readFirstArgument(text, openParen) {
  return splitArguments(text, openParen).args[0] || '';
}

function literalValue(expression) {
  const value = expression.trim();
  if (value.length < 2) return null;
  const quote = value[0];
  if (!["'", '"', '`'].includes(quote) || value.at(-1) !== quote) return null;
  if (quote === '`' && value.includes('${')) return null;
  try {
    if (quote === '`') return value.slice(1, -1).replace(/\\`/g, '`');
    return Function(`"use strict"; return (${value});`)();
  } catch { return null; }
}

function parsePaths(expression) {
  const direct = literalValue(expression);
  if (typeof direct === 'string') return [direct];
  const value = expression.trim();
  if (!value.startsWith('[') || !value.endsWith(']')) return [];
  const paths = [];
  let i = 1;
  while (i < value.length - 1) {
    while (/[\s,]/.test(value[i] || '')) i += 1;
    if (!["'", '"', '`'].includes(value[i])) return [];
    const end = skipString(value, i);
    const parsed = literalValue(value.slice(i, end));
    if (typeof parsed !== 'string') return [];
    paths.push(parsed);
    i = end;
  }
  return paths;
}

function functionRanges(text) {
  const ranges = [];
  const addBlock = (name, start, paramsOpen, exportName = null) => {
    const paramsEnd = matchingDelimiter(text, paramsOpen);
    const open = text.indexOf('{', paramsEnd);
    if (open === -1) return;
    const end = matchingDelimiter(text, open, '{', '}');
    ranges.push({ name, exportName, start, bodyStart: open + 1, bodyEnd: end, end });
  };

  const declaration = /\b(export\s+)?(?:default\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/g;
  for (const match of text.matchAll(declaration)) {
    addBlock(match[2], match.index, match.index + match[0].lastIndexOf('('), match[1] ? match[2] : null);
  }

  const arrow = /\b(export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>\s*/g;
  for (const match of text.matchAll(arrow)) {
    const after = match.index + match[0].length;
    if (text[after] === '{') {
      const end = matchingDelimiter(text, after, '{', '}');
      const enclosing = ranges.find(range => range.start < match.index && range.end >= end);
      if (enclosing && end === enclosing.end) continue;
      ranges.push({ name: match[2], exportName: match[1] ? match[2] : null, start: match.index, bodyStart: after + 1, bodyEnd: end, end });
    } else {
      const semicolon = text.indexOf(';', after);
      const end = semicolon === -1 ? text.length : semicolon;
      ranges.push({ name: match[2], exportName: match[1] ? match[2] : null, start: match.index, bodyStart: after, bodyEnd: end, end });
    }
  }
  const anonymousArrow = /(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>\s*\{/g;
  for (const match of text.matchAll(anonymousArrow)) {
    const open = match.index + match[0].lastIndexOf('{');
    if (ranges.some(range => range.bodyStart === open + 1)) continue;
    const end = matchingDelimiter(text, open, '{', '}');
    const enclosing = ranges.find(range => range.start < match.index && range.end >= end);
    if (enclosing && end === enclosing.end) continue;
    ranges.push({ name: `@callback:${match.index}`, exportName: null, start: match.index, bodyStart: open + 1, bodyEnd: end, end });
  }
  const anonymousFunction = /\b(?:async\s+)?function\s*\(/g;
  for (const match of text.matchAll(anonymousFunction)) {
    const paramsOpen = match.index + match[0].lastIndexOf('(');
    const paramsEnd = matchingDelimiter(text, paramsOpen);
    const open = text.indexOf('{', paramsEnd);
    if (open === -1 || ranges.some(range => range.bodyStart === open + 1)) continue;
    const end = matchingDelimiter(text, open, '{', '}');
    ranges.push({ name: `@callback:${match.index}`, exportName: null, start: match.index, bodyStart: open + 1, bodyEnd: end, end });
  }
  return ranges.sort((a, b) => a.start - b.start || b.end - a.end);
}

function ownerAt(ranges, index) {
  const containing = ranges.filter(range => range.start <= index && index <= range.end).sort((a, b) => b.start - a.start);
  return containing[0]?.name || 'default';
}

function routeUseRegistrations(text, ranges) {
  const uses = [];
  const pattern = /\b(app|router|r)\s*\.\s*use\s*\(/g;
  for (const match of text.matchAll(pattern)) {
    const openParen = match.index + match[0].lastIndexOf('(');
    const { args } = splitArguments(text, openParen);
    const prefixes = parsePaths(args[0] || '');
    const middleware = prefixes.length ? args.slice(1) : args;
    if (!middleware.length) continue;
    uses.push({
      index: match.index,
      receiver: match[1],
      owner: ownerAt(ranges, match.index),
      prefixes: prefixes.length ? prefixes : ['/'],
      middleware: middleware.map(value => value.trim()),
    });
  }
  return uses;
}

function prefixApplies(prefix, routePath) {
  if (prefix === '/' || prefix === '') return true;
  const normalized = prefix.replace(/\/$/, '');
  return routePath === normalized || routePath.startsWith(`${normalized}/`);
}

function applicableRouterMiddleware(uses, row) {
  return uses
    .filter(use => use.index < row.registrationIndex
      && use.receiver === row.receiver
      && use.owner === row.owner
      && use.prefixes.some(prefix => prefixApplies(prefix, row.path)))
    .flatMap(use => use.middleware);
}

export function extractMutationRegistrations(text, source = '<inline>') {
  const rows = [];
  const ranges = functionRanges(text);
  const uses = routeUseRegistrations(text, ranges);
  const direct = /\b(app|router|r)\s*\??\.\s*(post|put|patch|delete)\s*\(/gi;
  for (const match of text.matchAll(direct)) {
    const openParen = match.index + match[0].lastIndexOf('(');
    const parsed = splitArguments(text, openParen);
    const handlers = parsed.args.slice(1).map(value => value.trim());
    for (const routePath of parsePaths(parsed.args[0] || '')) {
      const row = {
        source,
        receiver: match[1],
        owner: ownerAt(ranges, match.index),
        method: match[2].toUpperCase(),
        path: routePath,
        registrationIndex: match.index,
        middleware: handlers.slice(0, -1),
        handler: handlers.at(-1) || '',
      };
      row.routerMiddleware = applicableRouterMiddleware(uses, row);
      row.applicableMiddleware = [...row.routerMiddleware, ...row.middleware];
      rows.push(row);
    }
  }

  const routeCall = /\b(app|router|r)\s*\??\.\s*route\s*\(/gi;
  for (const match of text.matchAll(routeCall)) {
    const openParen = match.index + match[0].lastIndexOf('(');
    const paths = parsePaths(readFirstArgument(text, openParen));
    if (!paths.length) continue;
    const statementEnd = text.indexOf(';', openParen);
    const chainEnd = statementEnd === -1 ? text.length : statementEnd;
    const chain = text.slice(openParen, chainEnd);
    for (const methodMatch of chain.matchAll(/\.\s*(post|put|patch|delete)\s*\(/gi)) {
      const methodOpen = openParen + methodMatch.index + methodMatch[0].lastIndexOf('(');
      const handlers = splitArguments(text, methodOpen).args.map(value => value.trim());
      for (const routePath of paths) {
        const row = {
          source,
          receiver: match[1],
          owner: ownerAt(ranges, match.index),
          method: methodMatch[1].toUpperCase(),
          path: routePath,
          registrationIndex: match.index,
          middleware: handlers.slice(0, -1),
          handler: handlers.at(-1) || '',
        };
        row.routerMiddleware = applicableRouterMiddleware(uses, row);
        row.applicableMiddleware = [...row.routerMiddleware, ...row.middleware];
        rows.push(row);
      }
    }
  }
  return rows;
}

function resolveLocalImport(root, fromRelative, specifier) {
  if (!specifier.startsWith('.')) return null;
  const base = path.resolve(root, path.dirname(fromRelative), specifier);
  const candidates = path.extname(base) ? [base] : [`${base}.js`, path.join(base, 'index.js')];
  const resolved = candidates.find(candidate => fs.existsSync(candidate) && fs.statSync(candidate).isFile());
  return resolved ? path.relative(root, resolved).split(path.sep).join('/') : null;
}

function importBindings(root, relative, text) {
  const bindings = new Map();
  const statements = [];
  const sideEffects = [];
  const pattern = /import\s+([\s\S]*?)\s+from\s+["']([^"']+)["']\s*;?/g;
  for (const match of text.matchAll(pattern)) {
    const source = resolveLocalImport(root, relative, match[2]);
    statements.push([match.index, match.index + match[0].length]);
    if (!source) continue;
    const clause = match[1].trim();
    const namedStart = clause.indexOf('{');
    const defaultPart = (namedStart === -1 ? clause : clause.slice(0, namedStart)).replace(/,$/, '').trim();
    if (defaultPart && !defaultPart.startsWith('*')) bindings.set(defaultPart, { source, export: 'default' });
    const named = clause.match(/\{([\s\S]*?)\}/)?.[1] || '';
    for (const item of named.split(',').map(value => value.trim()).filter(Boolean)) {
      const [exported, local = exported] = item.split(/\s+as\s+/);
      bindings.set(local.trim(), { source, export: exported.trim() });
    }
  }
  const sideEffectPattern = /import\s+["']([^"']+)["']\s*;?/g;
  for (const match of text.matchAll(sideEffectPattern)) {
    statements.push([match.index, match.index + match[0].length]);
    const source = resolveLocalImport(root, relative, match[1]);
    if (source) sideEffects.push(source);
  }
  return { bindings, statements, sideEffects };
}

function withoutImports(text, statements) {
  let result = text;
  for (const [start, end] of [...statements].sort((a, b) => b[0] - a[0])) result = `${result.slice(0, start)}${' '.repeat(end - start)}${result.slice(end)}`;
  return result;
}

function usedImports(root, relative, text) {
  const parsed = importBindings(root, relative, text);
  const body = withoutImports(text, parsed.statements);
  return [...parsed.bindings.entries()].filter(([name]) => new RegExp(`\\b${name.replace(/[$]/g, '\\$&')}\\b`).test(body));
}

function aliasBindings(text, bindings) {
  const aliases = new Map(bindings);
  let changed = true;
  while (changed) {
    changed = false;
    for (const match of text.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*([A-Za-z_$][\w$]*)\s*(?:\(|;)/g)) {
      if (!aliases.has(match[1]) && aliases.has(match[2])) { aliases.set(match[1], aliases.get(match[2])); changed = true; }
    }
    for (const match of text.matchAll(/\b([A-Za-z_$][\w$]*)\s*=\s*([A-Za-z_$][\w$]*)\b/g)) {
      if (!aliases.has(match[1]) && aliases.has(match[2])) { aliases.set(match[1], aliases.get(match[2])); changed = true; }
    }
  }
  return aliases;
}

function extractMounts(root, relative, text) {
  const { bindings } = importBindings(root, relative, text);
  const aliases = aliasBindings(text, bindings);
  const ranges = functionRanges(text);
  const mounts = [];
  const pattern = /\b(app|router|r)\s*\.\s*use\s*\(/g;
  for (const match of text.matchAll(pattern)) {
    const openParen = match.index + match[0].lastIndexOf('(');
    const { args, end } = splitArguments(text, openParen);
    const prefixes = parsePaths(args[0] || '');
    if (!prefixes.length || args.length < 2) continue;
    const expression = args.slice(1).join(', ');
    const candidates = [...aliases.entries()].filter(([name]) => new RegExp(`\\b${name.replace(/[$]/g, '\\$&')}\\b`).test(expression));
    for (const [, target] of candidates) {
      for (const prefix of prefixes) mounts.push({
        source: target.source,
        export: target.export,
        prefix,
        registrationIndex: match.index,
        mountSource: relative,
        mountOwner: ownerAt(ranges, match.index),
        receiver: match[1],
        expression: text.slice(match.index, end + 1),
      });
    }
  }
  return mounts;
}

function maskRanges(text, ranges) {
  const chars = [...text];
  for (const [start, end] of ranges) {
    for (let i = Math.max(0, start); i < Math.min(chars.length, end); i += 1) chars[i] = ' ';
  }
  return chars.join('');
}

function contextText(module, functionName) {
  const { text, ranges, imports } = module;
  const masks = [...imports.statements];
  if (functionName === 'default') {
    for (const range of ranges) masks.push([range.start, range.end + 1]);
    return maskRanges(text, masks);
  }
  const target = ranges.find(range => range.name === functionName);
  if (!target) return '';
  masks.push([0, target.bodyStart], [target.bodyEnd, text.length]);
  for (const child of ranges) {
    if (child === target) continue;
    if (child.start >= target.bodyStart && child.end <= target.bodyEnd) masks.push([child.start, child.end + 1]);
  }
  return maskRanges(text, masks);
}

const STATIC_UNKNOWN = Symbol('static-unknown');

function staticExpressionValue(root, module, expression, cache, seen = new Set()) {
  let value = expression.trim();
  while (value.startsWith('(') && matchingDelimiter(value, 0) === value.length - 1) value = value.slice(1, -1).trim();
  if (value.startsWith('!')) {
    const inner = staticExpressionValue(root, module, value.slice(1), cache, seen);
    return inner === STATIC_UNKNOWN ? STATIC_UNKNOWN : !inner;
  }
  if (value.includes('&&')) {
    let unknown = false;
    for (const part of value.split('&&')) {
      const inner = staticExpressionValue(root, module, part, cache, seen);
      if (inner !== STATIC_UNKNOWN && !inner) return false;
      if (inner === STATIC_UNKNOWN) unknown = true;
    }
    return unknown ? STATIC_UNKNOWN : true;
  }
  if (value.includes('||')) {
    let unknown = false;
    for (const part of value.split('||')) {
      const inner = staticExpressionValue(root, module, part, cache, seen);
      if (inner !== STATIC_UNKNOWN && inner) return true;
      if (inner === STATIC_UNKNOWN) unknown = true;
    }
    return unknown ? STATIC_UNKNOWN : false;
  }
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (value === 'null') return null;
  if (value === 'undefined') return undefined;
  if (/^-?\d+(?:\.\d+)?$/.test(value)) return Number(value);
  const string = literalValue(value);
  if (string !== null) return string;
  if (!/^[A-Za-z_$][\w$]*$/.test(value)) return STATIC_UNKNOWN;

  const token = `${module.relative}#${value}`;
  if (seen.has(token)) return STATIC_UNKNOWN;
  const nextSeen = new Set(seen).add(token);
  if (module.localFunctions.has(value)) return true;
  const escaped = value.replace(/[$]/g, '\\$&');
  const destructuredDependency = new RegExp(`\\b(?:const|let|var)\\s*\\{[^}]*\\b${escaped}\\b[^}]*\\}\\s*=\\s*[A-Za-z_$][\\w$]*`).test(module.text);
  if (destructuredDependency) {
    const calledAsFunction = new RegExp(`\\b${escaped}\\s*\\(`).test(module.text);
    const usedAsRouteCallable = extractMutationRegistrations(module.text, module.relative)
      .some(row => [...row.middleware, row.handler].some(handler => handler === value));
    if (calledAsFunction || usedAsRouteCallable) return true;
  }
  const declaration = new RegExp(`\\b(?:export\\s+)?const\\s+${escaped}\\s*=\\s*([^;]+);`).exec(module.text);
  if (declaration) return staticExpressionValue(root, module, declaration[1], cache, nextSeen);

  const imported = module.imports.bindings.get(value);
  if (!imported) return STATIC_UNKNOWN;
  const importedModule = moduleAnalysis(root, imported.source, cache);
  const importedFunction = importedModule.exports.get(imported.export) || imported.export;
  if (importedModule.localFunctions.has(importedFunction)) return true;
  return staticExpressionValue(root, importedModule, imported.export, cache, nextSeen);
}

function statementRange(text, start) {
  let bodyStart = start;
  while (/\s/.test(text[bodyStart] || '')) bodyStart += 1;
  if (text[bodyStart] === '{') return { start: bodyStart, end: matchingDelimiter(text, bodyStart, '{', '}') };
  const semicolon = text.indexOf(';', bodyStart);
  return { start: bodyStart, end: semicolon === -1 ? text.length : semicolon };
}

function expressionStart(text, index) {
  let depth = 0;
  for (let i = index - 1; i >= 0; i -= 1) {
    const char = text[i];
    if (char === ')' || char === ']' || char === '}') depth += 1;
    else if (char === '(' || char === '[' || char === '{') {
      if (depth > 0) depth -= 1;
      else return i + 1;
    } else if (depth === 0 && /[;,:=\n]/.test(char)) return i + 1;
  }
  return 0;
}

function maskComments(text) {
  const chars = [...text];
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === "'" || text[i] === '"' || text[i] === '`') {
      i = skipString(text, i) - 1;
      continue;
    }
    if (text[i] !== '/' || (text[i + 1] !== '/' && text[i + 1] !== '*')) continue;
    const end = skipSlashExpression(text, i);
    for (let cursor = i; cursor < end; cursor += 1) {
      if (chars[cursor] !== '\n') chars[cursor] = ' ';
    }
    i = end - 1;
  }
  return chars.join('');
}

function conditionalControlsAt(root, module, text, index, cache) {
  const controls = [];
  const scanText = maskComments(text);
  const targetOwner = ownerAt(module.ranges, index);
  const add = (state, condition, kind) => controls.push({ state, condition, kind });
  const evaluate = expression => {
    const value = staticExpressionValue(root, module, expression, cache);
    return value === STATIC_UNKNOWN ? null : Boolean(value);
  };

  for (const match of scanText.matchAll(/\bif\s*\(/g)) {
    if (ownerAt(module.ranges, match.index) !== targetOwner) continue;
    const open = match.index + match[0].lastIndexOf('(');
    const close = matchingDelimiter(text, open);
    const consequent = statementRange(text, close + 1);
    let alternate = null;
    let cursor = consequent.end + 1;
    while (/\s/.test(text[cursor] || '')) cursor += 1;
    if (text.slice(cursor, cursor + 4) === 'else') alternate = statementRange(text, cursor + 4);
    const condition = text.slice(open + 1, close).trim();
    const resolved = evaluate(condition);
    if (index >= consequent.start && index <= consequent.end) add(resolved, condition, 'if');
    else if (alternate && index >= alternate.start && index <= alternate.end) add(resolved == null ? null : !resolved, condition, 'if/else');
  }

  for (let question = scanText.indexOf('?'); question !== -1; question = scanText.indexOf('?', question + 1)) {
    if (text[question + 1] === '.' || text[question - 1] === '?') continue;
    if (ownerAt(module.ranges, question) !== targetOwner) continue;
    let depth = 0;
    let colon = -1;
    for (let i = question + 1; i < text.length; i += 1) {
      const char = text[i];
      if (char === "'" || char === '"' || char === '`') { i = skipString(text, i) - 1; continue; }
      if (char === '(' || char === '[' || char === '{') depth += 1;
      else if (char === ')' || char === ']' || char === '}') { if (depth === 0) break; depth -= 1; }
      else if (char === ':' && depth === 0) { colon = i; break; }
      else if (char === ';' && depth === 0) break;
    }
    if (colon === -1) continue;
    const end = text.indexOf(';', colon);
    const branchEnd = end === -1 ? text.length : end;
    const condition = text.slice(expressionStart(text, question), question).trim();
    const resolved = evaluate(condition);
    if (index > question && index < colon) add(resolved, condition, 'ternario');
    else if (index > colon && index <= branchEnd) add(resolved == null ? null : !resolved, condition, 'ternario');
  }

  for (const match of scanText.matchAll(/&&|\|\|/g)) {
    if (ownerAt(module.ranges, match.index) !== targetOwner) continue;
    const statementEnd = text.indexOf(';', match.index);
    if (index <= match.index || (statementEnd !== -1 && index > statementEnd)) continue;
    const condition = text.slice(expressionStart(text, match.index), match.index).trim();
    const resolved = evaluate(condition);
    add(match[0] === '&&' ? resolved : (resolved == null ? null : !resolved), condition, `lógico ${match[0]}`);
  }

  for (const match of scanText.matchAll(/\bswitch\s*\(/g)) {
    if (ownerAt(module.ranges, match.index) !== targetOwner) continue;
    const open = match.index + match[0].lastIndexOf('(');
    const close = matchingDelimiter(text, open);
    let bodyStart = close + 1;
    while (/\s/.test(text[bodyStart] || '')) bodyStart += 1;
    if (text[bodyStart] !== '{') continue;
    const bodyEnd = matchingDelimiter(text, bodyStart, '{', '}');
    if (index <= bodyStart || index >= bodyEnd) continue;
    const labels = [...scanText.slice(bodyStart + 1, bodyEnd).matchAll(/\b(case\s+([^:]+)|default)\s*:/g)]
      .map(label => ({
        start: bodyStart + 1 + label.index,
        bodyStart: bodyStart + 1 + label.index + label[0].length,
        expression: label[2] == null
          ? null
          : text.slice(
            bodyStart + 1 + label.index + label[0].indexOf(label[2]),
            bodyStart + 1 + label.index + label[0].indexOf(label[2]) + label[2].length,
          ).trim(),
      }));
    const current = labels.find((label, position) => index >= label.bodyStart && index < (labels[position + 1]?.start ?? bodyEnd));
    if (!current) continue;
    const condition = text.slice(open + 1, close).trim();
    const discriminant = staticExpressionValue(root, module, condition, cache);
    if (discriminant === STATIC_UNKNOWN) { add(null, condition, 'switch'); continue; }
    const selected = labels.find(label => label.expression !== null
      && staticExpressionValue(root, module, label.expression, cache) === discriminant)
      || labels.find(label => label.expression === null);
    add(selected === current, condition, 'switch');
  }
  return controls;
}

function staticConditionalStateAt(root, module, text, index, cache, options = {}) {
  const controls = conditionalControlsAt(root, module, text, index, cache);
  const blocked = controls.find(control => control.state === false);
  const ambiguous = controls.find(control => control.state == null);
  const selected = blocked || ambiguous || { state: true, condition: null, kind: null };
  return options.details ? selected : selected.state;
}

function moduleAnalysis(root, relative, cache) {
  if (cache.has(relative)) return cache.get(relative);
  const absolute = path.join(root, relative);
  if (!fs.existsSync(absolute)) throw new Error(`entry/import productivo inexistente: ${relative}`);
  const text = fs.readFileSync(absolute, 'utf8');
  const imports = importBindings(root, relative, text);
  const ranges = functionRanges(text);
  const localFunctions = new Map(ranges.filter(range => !range.name.startsWith('@')).map(range => [range.name, range]));
  const exports = new Map();
  for (const range of localFunctions.values()) {
    if (range.exportName) exports.set(range.exportName, range.name);
    if (/\bexport\s+default\b/.test(text.slice(Math.max(0, range.start - 20), range.bodyStart))) exports.set('default', range.name);
  }
  for (const match of text.matchAll(/\bexport\s*\{([^}]+)\}/g)) {
    for (const item of match[1].split(',').map(value => value.trim()).filter(Boolean)) {
      const [local, exported = local] = item.split(/\s+as\s+/);
      if (localFunctions.has(local.trim())) exports.set(exported.trim(), local.trim());
    }
  }
  const analysis = { relative, text, imports, ranges, localFunctions, exports };
  cache.set(relative, analysis);
  return analysis;
}

function calledNames(text, names) {
  const calls = [];
  for (const name of names) {
    const escaped = name.replace(/[$]/g, '\\$&');
    const pattern = new RegExp(`\\b${escaped}\\s*\\(`, 'g');
    for (const match of text.matchAll(pattern)) calls.push({ name, index: match.index });
  }
  return calls.sort((a, b) => a.index - b.index);
}

function functionRegistersMutation(root, module, functionName, cache) {
  return extractMutationRegistrations(module.text, module.relative)
    .filter(row => row.owner === functionName)
    .some(row => staticConditionalStateAt(root, module, module.text, row.registrationIndex, cache) !== false);
}

function registrationReachability(root, startModule, startFunction, cache) {
  const nodes = new Map();
  const pending = [{ module: startModule, functionName: startFunction }];
  while (pending.length) {
    const current = pending.pop();
    const token = `${current.module.relative}#${current.functionName}`;
    if (nodes.has(token)) continue;
    const code = contextText(current.module, current.functionName);
    const baseBindings = new Map([
      ...current.module.imports.bindings,
      ...[...current.module.localFunctions.keys()].map(name => [name, { source: current.module.relative, export: name, local: true }]),
    ]);
    const functionRange = current.functionName === 'default' ? null : current.module.localFunctions.get(current.functionName);
    const aliasSource = functionRange
      ? `${current.module.text.slice(functionRange.start, functionRange.bodyStart)}\n${code}`
      : code;
    const aliases = aliasBindings(aliasSource, baseBindings);
    const edges = new Set();
    for (const call of calledNames(code, aliases.keys())) {
      if (staticConditionalStateAt(root, current.module, code, call.index, cache) === false) continue;
      const target = aliases.get(call.name);
      const targetModule = target.local || target.source === current.module.relative
        ? current.module
        : moduleAnalysis(root, target.source, cache);
      const targetFunction = target.local || target.source === current.module.relative
        ? target.export
        : (targetModule.exports.get(target.export) || target.export);
      if (!targetModule.localFunctions.has(targetFunction)) continue;
      const targetToken = `${targetModule.relative}#${targetFunction}`;
      edges.add(targetToken);
      pending.push({ module: targetModule, functionName: targetFunction });
    }
    for (const mount of extractMounts(root, current.module.relative, current.module.text)
      .filter(item => item.mountOwner === current.functionName)) {
      const conditional = staticConditionalStateAt(root, current.module, current.module.text, mount.registrationIndex, cache);
      if (conditional === false) continue;
      const targetModule = moduleAnalysis(root, mount.source, cache);
      const targetFunction = targetModule.exports.get(mount.export) || mount.export;
      const targetToken = `${targetModule.relative}#${targetFunction}`;
      edges.add(targetToken);
      pending.push({ module: targetModule, functionName: targetFunction });
    }
    nodes.set(token, {
      direct: functionRegistersMutation(root, current.module, current.functionName, cache),
      edges,
    });
  }

  const registers = new Set([...nodes].filter(([, node]) => node.direct).map(([token]) => token));
  let changed = true;
  while (changed) {
    changed = false;
    for (const [token, node] of nodes) {
      if (registers.has(token)) continue;
      if ([...node.edges].some(edge => registers.has(edge))) {
        registers.add(token);
        changed = true;
      }
    }
  }
  return registers.has(`${startModule.relative}#${startFunction}`);
}

export function discoverProductionGraph({ root, entries = ['src/app.js'] }) {
  const sources = new Set();
  const reachable = new Map();
  const cache = new Map();
  const queue = [];
  const enqueued = new Set();
  const enqueue = (source, functionName = 'default') => {
    const token = `${source}#${functionName}`;
    if (enqueued.has(token)) return;
    enqueued.add(token);
    queue.push({ source, functionName });
  };

  for (const entry of entries) {
    enqueue(entry, 'default');
    const module = moduleAnalysis(root, entry, cache);
    if (module.localFunctions.has('createApp')) enqueue(entry, 'createApp');
  }

  while (queue.length) {
    const { source, functionName } = queue.shift();
    const module = moduleAnalysis(root, source, cache);
    sources.add(source);
    const reached = reachable.get(source) || new Set();
    reached.add(functionName);
    reachable.set(source, reached);

    if (functionName === 'default') {
      for (const sideEffect of module.imports.sideEffects) enqueue(sideEffect, 'default');
    }

    const code = contextText(module, functionName);
    for (const mount of extractMounts(root, source, module.text).filter(item => item.mountOwner === functionName)) {
      const mountIndex = mount.registrationIndex;
      const conditional = staticConditionalStateAt(root, module, module.text, mountIndex, cache);
      if (conditional === false) continue;
      if (conditional == null) {
        const mountedModule = moduleAnalysis(root, mount.source, cache);
        const mountedFunction = mountedModule.exports.get(mount.export) || mount.export;
        if (registrationReachability(root, mountedModule, mountedFunction, cache)) {
          const condition = staticConditionalStateAt(root, module, module.text, mountIndex, cache, { details: true });
          throw new Error(`mount condicional no resoluble en ${source}#${functionName}; callsite=${mount.expression}; condición=${condition?.condition || '<desconocida>'}; requiere anchor explícito`);
        }
      }
      enqueue(mount.source, 'default');
      const mountedModule = moduleAnalysis(root, mount.source, cache);
      const mountedFunction = mountedModule.exports.get(mount.export) || mount.export;
      if (mountedModule.localFunctions.has(mountedFunction) && new RegExp(`\\b${mount.export.replace(/[$]/g, '\\$&')}\\s*\\(`).test(mount.expression)) {
        enqueue(mount.source, mountedFunction);
      }
    }
    const baseBindings = new Map([
      ...module.imports.bindings,
      ...[...module.localFunctions.keys()].map(name => [name, { source, export: name, local: true }]),
    ]);
    const functionRange = functionName === 'default' ? null : module.localFunctions.get(functionName);
    const aliasSource = functionRange
      ? `${module.text.slice(functionRange.start, functionRange.bodyStart)}\n${code}`
      : code;
    const aliases = aliasBindings(aliasSource, baseBindings);
    for (const call of calledNames(code, aliases.keys())) {
      const conditional = staticConditionalStateAt(root, module, code, call.index, cache);
      if (conditional === false) continue;
      const target = aliases.get(call.name);
      if (conditional == null) {
        const targetModule = target.local || target.source === source
          ? module
          : moduleAnalysis(root, target.source, cache);
        const targetFunction = target.local || target.source === source
          ? target.export
          : (targetModule.exports.get(target.export) || target.export);
        if (registrationReachability(root, targetModule, targetFunction, cache)) {
          const condition = staticConditionalStateAt(root, module, code, call.index, cache, { details: true });
          const callsite = code.slice(call.index, matchingDelimiter(code, code.indexOf('(', call.index)) + 1).trim();
          throw new Error(`bootstrap condicional no resoluble en ${source}#${functionName}; callsite=${callsite}; condición=${condition?.condition || '<desconocida>'}; requiere anchor explícito`);
        }
      }
      if (target.local || target.source === source) {
        if (module.localFunctions.has(target.export)) enqueue(source, target.export);
        continue;
      }
      const importedModule = moduleAnalysis(root, target.source, cache);
      enqueue(target.source, 'default');
      const localExport = importedModule.exports.get(target.export) || target.export;
      if (importedModule.localFunctions.has(localExport)) enqueue(target.source, localExport);
    }
  }

  const mutations = [];
  const mounts = [];
  for (const source of sources) {
    const module = moduleAnalysis(root, source, cache);
    const reached = reachable.get(source) || new Set();
    for (const row of extractMutationRegistrations(module.text, source).filter(item => reached.has(item.owner))) {
      const conditional = staticConditionalStateAt(root, module, module.text, row.registrationIndex, cache, { details: true });
      if (conditional.state === false) continue;
      if (conditional.state == null) {
        const line = module.text.slice(0, row.registrationIndex).split('\n').length;
        throw new Error(`registro mutante condicional no resoluble en ${source}:${line}; ${row.method} ${row.path}; condición=${conditional.condition || '<desconocida>'}`);
      }
      mutations.push(row);
    }
    for (const mount of extractMounts(root, source, module.text).filter(item => reached.has(item.mountOwner))) {
      const mountIndex = mount.registrationIndex;
      if (staticConditionalStateAt(root, module, module.text, mountIndex, cache) !== false) mounts.push(mount);
    }
  }
  return { sources, mutations, mounts, reachable };
}

const key = row => `${row.source}|${row.method}|${row.path}`;

function expandApplicableMiddleware(row, text) {
  const expanded = [];
  for (const value of row.applicableMiddleware || row.middleware || []) {
    const spread = value.match(/^\.\.\.([A-Za-z_$][\w$]*)$/)?.[1];
    if (!spread) {
      expanded.push(value);
      continue;
    }
    const declaration = new RegExp(`\\b${spread}\\s*=\\s*\\[([^\\]]+)\\]`, 's').exec(text);
    if (declaration) expanded.push(...declaration[1].split(',').map(item => item.trim()).filter(Boolean));
  }
  return expanded;
}

function hasAdminEvidence(row, text) {
  const middleware = expandApplicableMiddleware(row, text);
  const authIndex = middleware.findIndex(value => /\b(?:withAuth(?:Fn)?|authMiddleware)\b/.test(value));
  const guardIndex = middleware.findIndex(value => /\brequireCanonicalBackofficeRole\b/.test(value));
  if (authIndex !== -1 && guardIndex === authIndex + 1) return true;

  const customGuard = middleware[authIndex + 1]?.match(/^[A-Za-z_$][\w$]*/)?.[0];
  if (authIndex !== -1 && customGuard) {
    const body = new RegExp(`function\\s+${customGuard}\\s*\\([^)]*\\)\\s*\\{[\\s\\S]*?role\\s*!==\\s*['\"]admin['\"][\\s\\S]*?role\\s*!==\\s*['\"]super['\"]`).test(text);
    if (body) return true;
  }
  if (authIndex !== -1 && middleware.includes('requireTransferApprovalRole')
      && /function\s+requireTransferApprovalRole[\s\S]*?role\s*!==\s*['"]admin['"]\s*&&\s*role\s*!==\s*['"]super['"]/.test(text)) return true;
  if (row.receiver === 'app' && authIndex !== -1 && /if\s*\(!isSuper\(req\)\)\s*return\s+res\.status\(403\)/.test(row.handler || '')) return true;
  return false;
}

function handlerEvidence({ root, row, text }) {
  const chunks = [];
  const visited = new Set();

  const collect = (source, sourceText, expression, depth = 0) => {
    if (depth > 4) return;
    chunks.push(expression);
    const ranges = functionRanges(sourceText);
    const imports = importBindings(root, source, sourceText).bindings;
    for (const match of expression.matchAll(/\b([A-Za-z_$][\w$]*)\s*\(/g)) {
      const identifier = match[1];
      const local = ranges.find(range => range.name === identifier || range.exportName === identifier);
      if (local) {
        const visitKey = `${source}#${local.name}`;
        if (visited.has(visitKey)) continue;
        visited.add(visitKey);
        collect(source, sourceText, sourceText.slice(local.start, local.end + 1), depth + 1);
        continue;
      }
      const imported = imports.get(identifier);
      if (!imported) continue;
      const importedText = fs.readFileSync(path.join(root, imported.source), 'utf8');
      const importedRanges = functionRanges(importedText);
      const target = importedRanges.find(range => range.name === imported.export || range.exportName === imported.export);
      if (!target) continue;
      const visitKey = `${imported.source}#${target.name}`;
      if (visited.has(visitKey)) continue;
      visited.add(visitKey);
      collect(imported.source, importedText, importedText.slice(target.start, target.end + 1), depth + 1);
    }
  };

  const handler = row.handler || '';
  const identifier = String(handler).trim().match(/^([A-Za-z_$][\w$]*)$/)?.[1];
  if (identifier) {
    const imported = importBindings(root, row.source, text).bindings.get(identifier);
    if (imported) {
      const importedText = fs.readFileSync(path.join(root, imported.source), 'utf8');
      const target = functionRanges(importedText).find(range => range.name === imported.export || range.exportName === imported.export);
      if (target) collect(imported.source, importedText, importedText.slice(target.start, target.end + 1));
    } else {
      const target = functionRanges(text).find(range => range.name === identifier);
      if (target) collect(row.source, text, text.slice(target.start, target.end + 1));
    }
  } else {
    collect(row.source, text, handler);
  }
  return chunks.join('\n');
}

function middlewareEvidence(row, text) {
  const chunks = [];
  const ranges = functionRanges(text);
  for (const middleware of expandApplicableMiddleware(row, text)) {
    const identifier = middleware.match(/^([A-Za-z_$][\w$]*)$/)?.[1];
    if (!identifier) continue;
    const target = ranges.find(range => range.name === identifier);
    if (target) chunks.push(text.slice(target.start, target.end + 1));
  }
  return chunks.join('\n');
}

function executeAuthorityContract({ root, item, endpointKey, row, evidence, middlewareText }) {
  const metadata = item.authorityEvidence;
  if (!metadata?.module || !metadata?.export || !metadata?.case) {
    return { ok: false, reason: 'falta authorityEvidence de evidencia ejecutable', marker: '' };
  }
  if (metadata.module !== 'tests/support/mutationAuthorityContracts.js') {
    return { ok: false, reason: `módulo de evidencia no registrado: ${metadata.module}`, marker: '' };
  }
  const contract = authorityContractRegistry[metadata.export];
  if (typeof contract !== 'function') {
    return { ok: false, reason: `export de evidencia no registrado: ${metadata.export}`, marker: '' };
  }
  const outcome = contract({
    root,
    caseId: metadata.case,
    endpointKey,
    classification: item.classification,
    row,
    evidence,
    middlewareText,
  });
  if (item.classification === 'publico_capability_explicita'
    && outcome.ok
    && !validateAuthorityProof(outcome.proof, { caseId: metadata.case, endpointKey })) {
    return { ok: false, reason: 'proof público missing/malformed o de endpoint distinto', marker: '' };
  }
  return outcome;
}

function hasExactGuard(row, text, pattern) {
  return expandApplicableMiddleware(row, text).some(value => pattern.test(value));
}

export function deriveAuthorityEvidence({ root, actual, inventory }) {
  const actualByKey = new Map(actual.map(row => [key(row), row]));
  const evidence = new Map();
  const invalid = [];
  for (const item of inventory) {
    const endpointKey = key(item);
    const row = actualByKey.get(endpointKey);
    if (!row) continue;
    const text = fs.readFileSync(path.join(root, row.source), 'utf8');
    const handlerText = handlerEvidence({ root, row, text });
    const middlewareText = `${expandApplicableMiddleware(row, text).join('\n')}\n${middlewareEvidence(row, text)}`;
    const guardText = `${middlewareText}\n${handlerText}`;
    let ok = false;
    let marker = '';
    let reason = '';
    switch (item.classification) {
      case 'admin_exacto':
        ok = hasAdminEvidence(row, text);
        marker = 'withAuth->canonical-admin-guard@applicable-chain';
        break;
      case 'publico_capability_explicita': {
        const contract = executeAuthorityContract({
          root,
          item,
          endpointKey,
          row,
          evidence: handlerText,
          middlewareText,
        });
        ok = contract.ok;
        marker = contract.marker;
        reason = contract.reason;
        break;
      }
      case 'webhook_firmado':
        ok = WEBHOOK_ALLOWLIST.has(endpointKey)
          && /(requireSharedSecret|requireAsteriskWebhookSecret|requireWebhookSignature|timingSafeEqual|timingSafeEqualHex)/.test(guardText);
        marker = 'fail-closed-signature-guard@applicable-chain';
        break;
      case 'cron_secret':
        ok = CRON_ALLOWLIST.has(endpointKey)
          && /require(?:Cron|Shared)Secret/.test(guardText);
        marker = 'fail-closed-cron-secret@applicable-chain';
        break;
      case 'repartidor_exacto_ownership':
        if (hasExactGuard(row, text, /\brequire(?:Exact)?Repartidor\b/)) {
          const contract = executeAuthorityContract({ root, item, endpointKey, row, evidence: handlerText, middlewareText });
          ok = contract.ok;
          marker = contract.marker;
          reason = contract.reason;
        } else reason = 'falta guard exacto repartidor';
        break;
      case 'referente_exacto_ownership':
        if (hasExactGuard(row, text, /\brequireReferente\b/)) {
          const contract = executeAuthorityContract({ root, item, endpointKey, row, evidence: handlerText, middlewareText });
          ok = contract.ok;
          marker = contract.marker;
          reason = contract.reason;
        } else reason = 'falta guard exacto referente';
        break;
      case 'repartidor_o_admin_ownership':
        if (hasExactGuard(row, text, /\brequireCanonicalGastosMutationRole\b/)) {
          const contract = executeAuthorityContract({ root, item, endpointKey, row, evidence: handlerText, middlewareText });
          ok = contract.ok;
          marker = contract.marker;
          reason = contract.reason;
        } else reason = 'falta guard mixto repartidor/admin';
        break;
      default:
        ok = false;
    }
    if (!ok) invalid.push(`${item.classification}: ${endpointKey}${reason ? ` (${reason})` : ''}`);
    else evidence.set(endpointKey, { classification: item.classification, marker, source: row.source });
  }
  if (invalid.length) throw new Error(`autoridad real no respalda clasificación:\n${invalid.join('\n')}`);
  return evidence;
}

export function validateMutationInventory({ actual, inventory, baselineKeys = null, root = null }) {
  const actualKeys = actual.map(key);
  const duplicate = actualKeys.find((value, index) => actualKeys.indexOf(value) !== index);
  if (duplicate) throw new Error(`endpoint duplicado ambiguo: ${duplicate}`);
  const expectedKeys = inventory.map(key);
  const fixtureDuplicate = expectedKeys.find((value, index) => expectedKeys.indexOf(value) !== index);
  if (fixtureDuplicate) throw new Error(`fila fixture duplicada ambigua: ${fixtureDuplicate}`);
  const expectedSet = new Set(expectedKeys);
  const actualSet = new Set(actualKeys);
  const missing = actualKeys.find(value => !expectedSet.has(value));
  if (missing) throw new Error(`mutación productiva no inventariada: ${missing}`);
  const ghost = expectedKeys.find(value => !actualSet.has(value));
  if (ghost) throw new Error(`fila fixture sin endpoint real: ${ghost}`);
  if (baselineKeys) {
    const added = actualKeys.find(value => !baselineKeys.has(value));
    if (added) throw new Error(`endpoint nuevo fuera del baseline aprobado: ${added}`);
  }
  if (root) deriveAuthorityEvidence({ root, actual, inventory });
  return true;
}

function joinRoute(prefix, routePath) {
  if (!prefix) return routePath;
  if (routePath === '/') return prefix || '/';
  return `${prefix.replace(/\/$/, '')}/${routePath.replace(/^\//, '')}`;
}

export function resolveMountedMutations(mutations, mounts) {
  const resolvePrefix = (mount, seen = new Set()) => {
    const mountKey = `${mount.mountSource}|${mount.source}|${mount.export}|${mount.prefix}`;
    if (seen.has(mountKey)) throw new Error(`ciclo de mounts productivos: ${mountKey}`);
    if (mount.receiver === 'app') return mount.prefix;
    const nextSeen = new Set(seen).add(mountKey);
    const parents = mounts.filter(parent => parent.source === mount.mountSource && parent.export === mount.mountOwner);
    if (parents.length !== 1) throw new Error(`subrouter sin mount padre único: ${mount.mountSource}#${mount.mountOwner}`);
    return joinRoute(resolvePrefix(parents[0], nextSeen), mount.prefix);
  };
  const mounted = [];
  for (const row of mutations) {
    if (row.receiver === 'app') {
      mounted.push({ ...row, mountedPath: row.path });
      continue;
    }
    const candidates = mounts.filter(mount => mount.source === row.source && (mount.export === row.owner || mount.export === 'default'));
    if (!candidates.length) throw new Error(`fuente mutante sin mount productivo: ${row.source}#${row.owner}`);
    for (const mount of candidates) mounted.push({ ...row, mountedPath: joinRoute(resolvePrefix(mount), row.path), mount });
  }
  const finalKeys = mounted.map(row => `${row.method}|${row.mountedPath}`);
  const duplicate = finalKeys.find((value, index) => finalKeys.indexOf(value) !== index);
  if (duplicate) throw new Error(`endpoint productivo duplicado ambiguo: ${duplicate}`);
  return mounted;
}

export function validateMountFixture({ root, derivedMounts, fixture }) {
  for (const item of fixture) {
    const anchor = item.anchor;
    if (!anchor?.source || !anchor?.expression) throw new Error(`mount fixture sin anchor verificable: ${item.source}`);
    const text = fs.readFileSync(path.join(root, anchor.source), 'utf8');
    if (!text.includes(anchor.expression)) throw new Error(`anchor de mount inexistente: ${item.source}`);
    const derived = derivedMounts.find(mount => mount.source === item.source && mount.export === item.export && mount.mountSource === anchor.source);
    if (!derived) throw new Error(`mount fixture sin callsite productivo: ${item.source}`);
    if (derived.prefix !== item.prefix) throw new Error(`prefijo fixture no coincide con mount productivo: ${item.source}`);
  }
  return true;
}

export function findAllMutationSources(root, directory = 'src') {
  const found = new Map();
  const walk = relative => {
    const absolute = path.join(root, relative);
    for (const entry of fs.readdirSync(absolute, { withFileTypes: true })) {
      const child = path.join(relative, entry.name).split(path.sep).join('/');
      if (entry.isDirectory()) walk(child);
      else if (entry.isFile() && entry.name.endsWith('.js')) {
        const rows = extractMutationRegistrations(fs.readFileSync(path.join(root, child), 'utf8'), child);
        if (rows.length) found.set(child, rows);
      }
    }
  };
  walk(directory);
  return found;
}
