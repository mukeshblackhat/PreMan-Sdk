import type { DiscoveredEndpoint, FrameworkAdapter, SourceFile } from "./scan.js";
import { normalizePathTemplate } from "./scan.js";
import type { HttpMethod } from "./types.js";

/** Confidence for a route stated by an explicit decorator, which names its own method and path. */
const ROUTE_CONFIDENCE = 0.9;

const EXTENSIONS: readonly string[] = [".py"];

/**
 * Matches only up to the opening quote. The scan runs over masked text, where
 * every literal is blanked, so the path itself is read back from the original.
 */
const DECORATOR_PATTERN = /@(\w+)\.(get|post|put|patch|delete|head|options)\s*\(\s*(['"])/gi;

const API_ROUTE_PATTERN = /@(\w+)\.api_route\s*\(\s*(['"])/gi;

const METHODS_PATTERN = /methods\s*=\s*\[/i;

const METHOD_NAME_PATTERN = /['"](\w+)['"]/g;

/** `app = FastAPI()`, `router = APIRouter()`. */
const RECEIVER_PATTERN = /\b(\w+)\s*(?::\s*[^=\n]+)?=\s*(?:FastAPI|APIRouter)\s*\(/g;

const PREFIX_PATTERN = /prefix\s*=\s*(['"])/;

const IMPORT_PATTERN = /(from\s+fastapi\b|import\s+fastapi\b)/;

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

/** FastAPI route decorators, including APIRouter prefixes declared in the same file. */
export const fastapiAdapter: FrameworkAdapter = {
  name: "fastapi",
  extensions: EXTENSIONS,
  matches: (files) => files.some((file) => isSource(file.path) && IMPORT_PATTERN.test(file.text)),
  extract: (file) => extractFastapiRoutes(file),
};

function isSource(path: string): boolean {
  return EXTENSIONS.some((extension) => path.endsWith(extension));
}

function extractFastapiRoutes(file: SourceFile): DiscoveredEndpoint[] {
  if (!IMPORT_PATTERN.test(file.text)) {
    return [];
  }
  const code = maskNonCode(file.text);
  const receivers = routeReceivers(code, file.text);
  if (receivers.size === 0) {
    return [];
  }
  const lines = lineOffsets(file.text);
  const endpoints: DiscoveredEndpoint[] = [];

  for (const match of code.matchAll(DECORATOR_PATTERN)) {
    const [whole, target, method] = match;
    const index = match.index ?? 0;
    if (!whole || !target || !method) continue;
    const prefix = receivers.get(target);
    if (prefix === undefined) continue;
    const named = httpMethod(method);
    const path = literalAt(file.text, code, index + whole.length - 1);
    if (!named || path === undefined) continue;
    endpoints.push(routeFor(file, lines, index, named, joinPath(prefix, path)));
  }

  for (const match of code.matchAll(API_ROUTE_PATTERN)) {
    const [whole, target] = match;
    const index = match.index ?? 0;
    if (!whole || !target) continue;
    const prefix = receivers.get(target);
    if (prefix === undefined) continue;
    const path = literalAt(file.text, code, index + whole.length - 1);
    if (path === undefined) continue;
    const open = code.indexOf("(", index);
    const call = open < 0 ? undefined : closingParen(code, open);
    if (call === undefined) continue;
    for (const method of declaredMethods(file.text, code, open, call)) {
      endpoints.push(routeFor(file, lines, index, method, joinPath(prefix, path)));
    }
  }

  return endpoints;
}

/**
 * Blanks comments and literal contents, keeping every offset and newline, so a
 * decorator in a comment or inside a docstring is not code and cannot be
 * discovered. Quote characters survive, so the masked text still shows where a
 * literal is.
 */
function maskNonCode(text: string): string {
  const out = text.split("");
  let index = 0;
  while (index < text.length) {
    const char = text.charAt(index);
    if (char === "#") {
      const end = endOfLine(text, index);
      blankRange(out, text, index, end);
      index = end;
      continue;
    }
    if (char === "'" || char === '"') {
      index = maskLiteral(out, text, index);
      continue;
    }
    index += 1;
  }
  return out.join("");
}

/**
 * A `"""` docstring runs to its closing fence; a single-quoted string ends at its
 * quote or at the newline, so an unterminated one costs a line, not the file.
 */
function maskLiteral(out: string[], text: string, start: number): number {
  const quote = text.charAt(start);
  const fence = quote.repeat(3);
  const triple = text.startsWith(fence, start);
  const width = triple ? 3 : 1;
  let index = start + width;
  while (index < text.length) {
    const char = text.charAt(index);
    if (char === "\\") {
      blankRange(out, text, index, index + 2);
      index += 2;
      continue;
    }
    if (triple ? text.startsWith(fence, index) : char === quote) {
      return index + width;
    }
    if (!triple && char === "\n") return index;
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

/**
 * Only a name assigned from FastAPI itself carries routes. The value is the
 * prefix: `router = APIRouter(prefix="/api/v1")` stated in the same file is safe
 * to apply, and an app or a bare router simply has none.
 */
function routeReceivers(code: string, text: string): Map<string, string> {
  const receivers = new Map<string, string>();
  for (const match of code.matchAll(RECEIVER_PATTERN)) {
    const [whole, name] = match;
    if (!whole || !name) continue;
    const open = (match.index ?? 0) + whole.length - 1;
    const call = closingParen(code, open);
    if (call === undefined) {
      receivers.set(name, "");
      continue;
    }
    const declared = PREFIX_PATTERN.exec(code.slice(open, call));
    const quoteIndex = declared ? open + declared.index + declared[0].length - 1 : -1;
    receivers.set(name, (quoteIndex < 0 ? undefined : literalAt(text, code, quoteIndex)) ?? "");
  }
  return receivers;
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

/** Reads the literal from the original text at an offset the masked text located. */
function literalAt(text: string, code: string, quoteIndex: number): string | undefined {
  const quote = code.charAt(quoteIndex);
  const start = quoteIndex + 1;
  const offset = code.slice(start, start + MAX_CALL_SPAN).indexOf(quote);
  if (offset < 0) return undefined;
  const raw = text.slice(start, start + offset);
  return raw.includes("\n") ? undefined : raw;
}

/** `methods=["BREW", "GET"]` states one method FastAPI has and one it does not. */
function declaredMethods(text: string, code: string, open: number, call: number): HttpMethod[] {
  const declared = METHODS_PATTERN.exec(code.slice(open, call));
  if (!declared) return [];
  const list = open + declared.index + declared[0].length;
  const end = code.indexOf("]", list);
  if (end < 0 || end > call) return [];
  return [...text.slice(list, end).matchAll(METHOD_NAME_PATTERN)]
    .flatMap((entry) => {
      const method = entry[1] ? httpMethod(entry[1]) : undefined;
      return method ? [method] : [];
    });
}

function routeFor(
  file: SourceFile,
  lines: readonly number[],
  index: number,
  method: HttpMethod,
  path: string,
): DiscoveredEndpoint {
  return {
    method,
    path_template: normalizePathTemplate(path),
    source_location: `${file.path}:${lineAt(lines, index)}`,
    confidence: ROUTE_CONFIDENCE,
  };
}

function joinPath(prefix: string | undefined, path: string): string {
  if (!prefix) return path;
  return `${prefix.replace(/\/$/, "")}/${path.replace(/^\//, "")}`;
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
