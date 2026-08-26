import type { DiscoveredEndpoint, FrameworkAdapter, SourceFile } from "./scan.js";
import { normalizePathTemplate } from "./scan.js";
import type { HttpMethod } from "./types.js";

/** Confidence for a route stated by an explicit method call naming its own path. */
const ROUTE_CONFIDENCE = 0.9;

const EXTENSIONS: readonly string[] = [".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx"];

/**
 * Matches only up to the opening quote. The scan runs over masked text, where
 * every literal is blanked, so the path itself is read back from the original.
 */
const ROUTE_PATTERN =
  /\b(\w+)\s*\.\s*(get|post|put|patch|delete|head|options|all)\s*\(\s*(['"`])/gi;

const ROUTE_CHAIN_PATTERN = /\b(\w+)\s*\.\s*route\s*\(\s*(['"`])/gi;

/** Anchored: a chain link must start where the previous call ended, not 400 characters later. */
const CHAINED_METHOD_PATTERN =
  /^\s*\.\s*(get|post|put|patch|delete|head|options|all)\s*\(/i;

/** `app = express()`, `router = express.Router()`, `router = Router()`. */
const RECEIVER_PATTERN =
  /\b(\w+)\s*(?::\s*[^=;\n]+)?=\s*(?:await\s+)?(?:new\s+)?(?:express\s*\.\s*Router|express|Router)\s*\(/g;

const IMPORT_PATTERN = /require\(\s*['"]express['"]\s*\)|from\s+['"]express['"]/;

const INTERPOLATION_PATTERN = /\$\{([^}]*)\}/g;

const IDENTIFIER_TAIL_PATTERN = /([A-Za-z_$][\w$]*)\s*$/;

const ALL_METHODS: readonly HttpMethod[] = ["GET", "POST", "PUT", "PATCH", "DELETE"];

const HTTP_METHODS = new Set<HttpMethod>([
  "GET",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "HEAD",
  "OPTIONS",
]);

/** Longest argument list a single call may span before the scan gives up on it. */
const MAX_CALL_SPAN = 400;

/** Longest `.route()` chain read, so one malformed file cannot stall the scan. */
const MAX_CHAIN_LINKS = 8;

/** Express route calls on an app or router declared in the same file. */
export const expressAdapter: FrameworkAdapter = {
  name: "express",
  extensions: EXTENSIONS,
  matches: (files) => files.some((file) => isSource(file.path) && IMPORT_PATTERN.test(file.text)),
  extract: (file) => extractExpressRoutes(file),
};

function isSource(path: string): boolean {
  return EXTENSIONS.some((extension) => path.endsWith(extension));
}

function extractExpressRoutes(file: SourceFile): DiscoveredEndpoint[] {
  if (!IMPORT_PATTERN.test(file.text)) {
    return [];
  }
  const code = maskNonCode(file.text);
  const receivers = routeReceivers(code);
  if (receivers.size === 0) {
    return [];
  }
  const lines = lineOffsets(file.text);
  const endpoints: DiscoveredEndpoint[] = [];

  for (const match of code.matchAll(ROUTE_PATTERN)) {
    const [whole, receiver, method] = match;
    const index = match.index ?? 0;
    if (!receiver || !method || !whole || !receivers.has(receiver)) continue;
    const path = literalAt(file.text, code, index + whole.length - 1);
    if (path === undefined) continue;
    endpoints.push(...routesFor(file, lines, index, method, path));
  }

  for (const match of code.matchAll(ROUTE_CHAIN_PATTERN)) {
    const [whole, receiver] = match;
    const index = match.index ?? 0;
    if (!receiver || !whole || !receivers.has(receiver)) continue;
    const path = literalAt(file.text, code, index + whole.length - 1);
    if (path === undefined) continue;
    const open = code.indexOf("(", index);
    const call = open < 0 ? undefined : closingParen(code, open);
    if (call === undefined) continue;
    for (const method of chainedMethods(code, call)) {
      endpoints.push(...routesFor(file, lines, index, method, path));
    }
  }

  return endpoints;
}

/**
 * Blanks comments and literal contents, keeping every offset and newline, so a
 * route in a comment or inside a string is not code and cannot be discovered.
 * Quote characters survive, so the masked text still shows where a literal is.
 */
function maskNonCode(text: string): string {
  const out = text.split("");
  let index = 0;
  while (index < text.length) {
    const char = text.charAt(index);
    const next = text.charAt(index + 1);
    if (char === "/" && next === "/") {
      const end = endOfLine(text, index);
      blankRange(out, text, index, end);
      index = end;
      continue;
    }
    if (char === "/" && next === "*") {
      const close = text.indexOf("*/", index + 2);
      const end = close < 0 ? text.length : close + 2;
      blankRange(out, text, index, end);
      index = end;
      continue;
    }
    if (char === "'" || char === '"' || char === "`") {
      index = maskLiteral(out, text, index);
      continue;
    }
    index += 1;
  }
  return out.join("");
}

/**
 * A quoted string ends at its quote, and — for `'` and `"` — at the newline too:
 * an apostrophe in a regex literal then costs one line rather than the whole file.
 */
function maskLiteral(out: string[], text: string, start: number): number {
  const quote = text.charAt(start);
  let index = start + 1;
  while (index < text.length) {
    const char = text.charAt(index);
    if (char === "\\") {
      blankRange(out, text, index, index + 2);
      index += 2;
      continue;
    }
    if (char === quote) return index + 1;
    if (char === "\n" && quote !== "`") return index;
    blankRange(out, text, index, index + 1);
    index += 1;
  }
  return index;
}

function blankRange(out: string[], text: string, start: number, end: number): void {
  for (let index = start; index < end && index < text.length; index += 1) {
    if (text.charAt(index) !== "\n") out[index] = " ";
  }
}

function endOfLine(text: string, start: number): number {
  const newline = text.indexOf("\n", start);
  return newline < 0 ? text.length : newline;
}

/** Only a name assigned from Express itself is a route receiver; `cache.get()` is not. */
function routeReceivers(code: string): Set<string> {
  const receivers = new Set<string>();
  for (const match of code.matchAll(RECEIVER_PATTERN)) {
    const name = match[1];
    if (name) receivers.add(name);
  }
  return receivers;
}

/** Reads the literal from the original text at an offset the masked text located. */
function literalAt(text: string, code: string, quoteIndex: number): string | undefined {
  const quote = code.charAt(quoteIndex);
  const start = quoteIndex + 1;
  const offset = code.slice(start, start + MAX_CALL_SPAN).indexOf(quote);
  if (offset < 0) return undefined;
  const raw = text.slice(start, start + offset);
  if (quote !== "`" && raw.includes("\n")) return undefined;
  return raw;
}

/** Bounded so an unbalanced file cannot make the whole scan quadratic. */
function closingParen(code: string, open: number): number | undefined {
  const limit = Math.min(code.length, open + MAX_CALL_SPAN);
  let depth = 0;
  for (let index = open; index < limit; index += 1) {
    const char = code.charAt(index);
    if (char === "(") {
      depth += 1;
      continue;
    }
    if (char === ")") {
      depth -= 1;
      if (depth === 0) return index + 1;
    }
  }
  return undefined;
}

/**
 * Walks the actual chained expression: each link must begin where the previous
 * call ended, so unrelated code after the statement is never read as a link.
 */
function chainedMethods(code: string, start: number): string[] {
  const methods: string[] = [];
  let index = start;
  while (methods.length < MAX_CHAIN_LINKS) {
    const link = CHAINED_METHOD_PATTERN.exec(code.slice(index, index + MAX_CALL_SPAN));
    const method = link?.[1];
    if (!link || !method) break;
    const call = closingParen(code, index + link[0].length - 1);
    if (call === undefined) break;
    methods.push(method);
    index = call;
  }
  return methods;
}

function routesFor(
  file: SourceFile,
  lines: readonly number[],
  index: number,
  method: string,
  path: string,
): DiscoveredEndpoint[] {
  const location = `${file.path}:${lineAt(lines, index)}`;
  const template = normalizePathTemplate(interpolatedPath(path));
  return expandMethod(method).map((entry) => ({
    method: entry,
    path_template: template,
    source_location: location,
    confidence: ROUTE_CONFIDENCE,
  }));
}

/**
 * A template literal's `${version}` becomes `{version}`: the route is real and a
 * substituted segment is exactly what a path template's placeholder means, so
 * dropping the route would lose more than naming the hole does.
 */
function interpolatedPath(path: string): string {
  return path.replace(INTERPOLATION_PATTERN, (_, expression: string) => {
    const name = IDENTIFIER_TAIL_PATTERN.exec(expression);
    return `{${name?.[1] ?? "param"}}`;
  });
}

/** `.all()` states every method, so it expands rather than inventing a pseudo-method. */
function expandMethod(method: string): readonly HttpMethod[] {
  if (method.toLowerCase() === "all") return ALL_METHODS;
  const named = httpMethod(method);
  return named ? [named] : [];
}

function httpMethod(value: string): HttpMethod | undefined {
  const method = value.toUpperCase() as HttpMethod;
  return HTTP_METHODS.has(method) ? method : undefined;
}

/** Every newline offset, read once: a file with many routes must not cost a scan per route. */
function lineOffsets(text: string): number[] {
  const offsets: number[] = [];
  for (let index = text.indexOf("\n"); index >= 0; index = text.indexOf("\n", index + 1)) {
    offsets.push(index);
  }
  return offsets;
}

function lineAt(offsets: readonly number[], index: number): number {
  let low = 0;
  let high = offsets.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    const offset = offsets[middle];
    if (offset === undefined || offset >= index) high = middle;
    else low = middle + 1;
  }
  return low + 1;
}
