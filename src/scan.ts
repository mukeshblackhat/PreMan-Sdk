import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

import { expressAdapter } from "./scan-express.js";
import { fastapiAdapter } from "./scan-fastapi.js";
import { fromOpenApi } from "./importers.js";
import { PremanConfigError } from "./errors.js";
import type { EndpointDefinition, HttpMethod } from "./types.js";

/**
 * One route found in a checkout. Field names are the shape
 * `register_discovered_endpoints` accepts, so scan output feeds the hosted API
 * with no translation.
 *
 * Deliberately no body or query schema. A scan auto-discovers every `openapi*.json`
 * under the scanned directory, so anything copied out of a spec is printed by
 * `scan --json` — into CI logs — without the user ever naming that file. Schema
 * extraction is `preman import openapi --file X`, where the user picks the file.
 */
export type DiscoveredEndpoint = {
  method: HttpMethod;
  path_template: string;
  source_location: string;
  confidence: number;
  tags?: string[];
};

/** A source file handed to an adapter. Adapters never touch the filesystem themselves. */
export type SourceFile = {
  path: string;
  text: string;
};

/**
 * A framework's route reader. Adapters are pure functions of file content so each
 * one is independently testable and the whole scan stays offline and deterministic.
 */
export type FrameworkAdapter = {
  name: string;
  extensions: readonly string[];
  matches: (files: readonly SourceFile[]) => boolean;
  extract: (file: SourceFile) => DiscoveredEndpoint[];
};

/**
 * A spec file that was found but contributed nothing, with the reason. Keeping these
 * out of `specs` is the point: `specs` names files that were actually read, so it can
 * never imply a spec was used when it was not.
 */
export type UnsupportedSpec = {
  path: string;
  reason: string;
};

export type ScanResult = {
  dir: string;
  frameworks: string[];
  endpoints: DiscoveredEndpoint[];
  /** Spec files that parsed. A file listed here was read and its routes are included. */
  specs: string[];
  unsupportedSpecs: UnsupportedSpec[];
  fileCount: number;
  /** True when a cap stopped the walk early, so the result describes part of the tree. */
  truncated: boolean;
};

export type ScanOptions = {
  dir?: string;
  adapters?: readonly FrameworkAdapter[];
  ignore?: readonly string[];
  maxFiles?: number;
  maxTotalBytes?: number;
};

type ReadTree = {
  files: SourceFile[];
  truncated: boolean;
  oversized: UnsupportedSpec[];
};

type SpecParse = {
  value: DiscoveredEndpoint[];
  error?: string;
};

type ParsedSpec = {
  path: string;
  count: number;
};

type EmptyScanFacts = {
  dir: string;
  adapters: readonly FrameworkAdapter[];
  matched: readonly FrameworkAdapter[];
  parsed: readonly ParsedSpec[];
  unsupported: readonly UnsupportedSpec[];
  tree: ReadTree;
};

const DEFAULT_IGNORED_DIRS: readonly string[] = [
  ".git",
  "node_modules",
  "dist",
  "build",
  "out",
  "coverage",
  "vendor",
  "__pycache__",
  ".venv",
  "venv",
  ".next",
  ".tox",
  ".mypy_cache",
  ".pytest_cache",
];

const SPEC_FILE_PATTERN = /(^|[/\\])(openapi|swagger)[^/\\]*\.(json|ya?ml)$/i;

/**
 * One `:name` parameter, with an optional Express regex constraint and modifier.
 * Global so a segment holding several (`/a/:b-:c`) rewrites every one.
 */
const COLON_PARAMETER_PATTERN = /:([A-Za-z_][A-Za-z0-9_]*)(?:\([^)]*\))?[?*+]?/g;

const SOURCE_EXTENSIONS: readonly string[] = [".py", ".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx"];

const DEFAULT_MAX_FILES = 5_000;

const MAX_FILE_BYTES = 1_000_000;

/**
 * Aggregate budget across the whole walk. `MAX_FILE_BYTES` alone is not a bound:
 * thousands of legally-sized files still hold every byte in memory at once.
 */
const DEFAULT_MAX_TOTAL_BYTES = 32_000_000;

/** Confidence for a route read from a committed spec, which states its own contract. */
const SPEC_CONFIDENCE = 1;

const YAML_SPEC_REASON =
  "YAML specs are not read: the SDK has no runtime dependencies and ships no YAML parser. "
  + "Convert it to JSON, or import it with `preman import openapi --file`.";

/**
 * Read a checkout and report the routes it exposes. Deterministic and offline:
 * no network, no model call, and the same tree always produces the same result.
 *
 * Throws rather than returning an empty endpoint list: a silent `[]` reads as
 * "no endpoints here" when the truth is "nothing here could be read".
 */
export function scanDirectory(options: ScanOptions = {}): ScanResult {
  const dir = options.dir ?? process.cwd();
  const adapters = options.adapters ?? builtInAdapters();
  const tree = readSourceTree(dir, options);

  const matched = adapters.filter((adapter) => adapter.matches(tree.files));
  const specFiles = tree.files.filter((file) => SPEC_FILE_PATTERN.test(file.path));

  if (matched.length === 0 && specFiles.length === 0) {
    const skipped = tree.oversized.length
      ? ` ${tree.oversized.length} file(s) were skipped for exceeding the ${MAX_FILE_BYTES}-byte scan cap: `
        + `${tree.oversized.map((file) => file.path).join(", ")}.`
      : "";
    throw new PremanConfigError(
      `No adapter matched ${dir}. Tried: ${adapters.map((adapter) => adapter.name).join(", ")}. `
      + `No committed OpenAPI or Swagger spec was found either.${skipped}`,
    );
  }

  const found: DiscoveredEndpoint[] = [];
  for (const adapter of matched) {
    for (const file of tree.files) {
      if (!adapter.extensions.some((extension) => file.path.endsWith(extension))) continue;
      // Appended one at a time: `push(...extracted)` passes every endpoint as an
      // argument, which throws RangeError once a single file yields enough of them.
      for (const endpoint of adapter.extract(file)) {
        found.push(endpoint);
      }
    }
  }

  const parsed: ParsedSpec[] = [];
  const unsupported: UnsupportedSpec[] = [...tree.oversized];
  for (const spec of specFiles) {
    const result = endpointsFromSpec(spec);
    if (result.error !== undefined) {
      unsupported.push({ path: spec.path, reason: result.error });
      continue;
    }
    parsed.push({ path: spec.path, count: result.value.length });
    for (const endpoint of result.value) {
      found.push(endpoint);
    }
  }

  const endpoints = mergeEndpoints(found);
  if (endpoints.length === 0) {
    throw new PremanConfigError(emptyScanMessage({ dir, adapters, matched, parsed, unsupported, tree }));
  }

  return {
    dir,
    frameworks: matched.map((adapter) => adapter.name),
    endpoints,
    specs: parsed.map((spec) => spec.path),
    unsupportedSpecs: unsupported,
    fileCount: tree.files.length,
    truncated: tree.truncated,
  };
}

/**
 * Normalize a route to a path template: concrete ids collapse to `{id}`, and each
 * framework's own parameter syntax becomes `{name}`, so two routes differing only
 * by a real id are one route.
 */
export function normalizePathTemplate(path: string): string {
  const withoutQuery = stripQueryString(path);
  const segments = withoutQuery.split("/").filter((segment) => segment.length > 0);
  const normalized = segments.map((segment) => normalizeSegment(segment));
  return `/${normalized.join("/")}`;
}

/** Deterministic order so two scans of one tree are byte-identical. */
export function sortEndpoints(endpoints: readonly DiscoveredEndpoint[]): DiscoveredEndpoint[] {
  return [...endpoints].sort((left, right) => {
    if (left.path_template !== right.path_template) {
      return left.path_template < right.path_template ? -1 : 1;
    }
    if (left.method !== right.method) {
      return left.method < right.method ? -1 : 1;
    }
    return left.source_location < right.source_location ? -1 : 1;
  });
}

function readSourceTree(dir: string, options: ScanOptions): ReadTree {
  let root: string;
  try {
    root = statSync(dir).isDirectory() ? dir : "";
  } catch {
    throw new PremanConfigError(`Scan directory ${dir} could not be read.`);
  }
  if (!root) {
    throw new PremanConfigError(`Scan path ${dir} is not a directory.`);
  }

  const ignored = new Set([...DEFAULT_IGNORED_DIRS, ...(options.ignore ?? [])]);
  const maxFiles = options.maxFiles ?? DEFAULT_MAX_FILES;
  const maxTotalBytes = options.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES;
  const files: SourceFile[] = [];
  const oversized: UnsupportedSpec[] = [];
  const queue: string[] = [root];
  let totalBytes = 0;
  let truncated = false;

  // `truncated` ends the whole walk, not just the current directory: breaking out of
  // the inner loop alone still reads every directory left in the queue.
  while (queue.length > 0 && !truncated) {
    const current = queue.shift();
    if (current === undefined) break;
    for (const entry of sortedEntries(current)) {
      if (ignored.has(entry.name) || entry.name.startsWith(".") && entry.isDirectory()) continue;
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        queue.push(full);
        continue;
      }
      if (!entry.isFile()) continue;
      const path = relative(root, full).split(sep).join("/");
      if (!isReadableSource(path)) continue;
      const bytes = fileSize(full);
      if (bytes === undefined) continue;
      // A file too large to read is reported rather than dropped: silently skipping it
      // would let the result claim to be complete while a real spec sat unread.
      if (bytes > MAX_FILE_BYTES) {
        oversized.push({
          path,
          reason: `File is ${bytes} bytes, larger than the ${MAX_FILE_BYTES}-byte scan cap, so it was not read.`,
        });
        continue;
      }
      if (files.length >= maxFiles || totalBytes + bytes > maxTotalBytes) {
        truncated = true;
        break;
      }
      const text = readTextFile(full);
      if (text !== undefined) {
        totalBytes += bytes;
        files.push({ path, text });
      }
    }
  }

  return { files, truncated, oversized };
}

function sortedEntries(dir: string): { name: string; isDirectory: () => boolean; isFile: () => boolean }[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .sort((left, right) => (left.name < right.name ? -1 : 1));
  } catch {
    return [];
  }
}

function isReadableSource(path: string): boolean {
  if (SPEC_FILE_PATTERN.test(path)) return true;
  return SOURCE_EXTENSIONS.some((extension) => path.endsWith(extension));
}

/** Size is read before the file is, so the byte budget is never blown by the read itself. */
function fileSize(full: string): number | undefined {
  try {
    return statSync(full).size;
  } catch {
    return undefined;
  }
}

function readTextFile(full: string): string | undefined {
  try {
    return readFileSync(full, "utf8");
  } catch {
    return undefined;
  }
}

/** Returns the reason on failure instead of swallowing it, so the caller can say why. */
function endpointsFromSpec(spec: SourceFile): SpecParse {
  if (!spec.path.toLowerCase().endsWith(".json")) {
    return { value: [], error: YAML_SPEC_REASON };
  }
  let parsed: EndpointDefinition[];
  try {
    parsed = fromOpenApi(spec.text);
  } catch (error) {
    return {
      value: [],
      error: error instanceof Error ? error.message : "The spec could not be parsed.",
    };
  }
  return {
    value: parsed.flatMap((endpoint) => {
      const path = endpoint.path_template ?? endpoint.pathTemplate ?? endpoint.path;
      if (!path) return [];
      return [omitUndefined({
        method: endpoint.method,
        path_template: normalizePathTemplate(path),
        source_location: spec.path,
        confidence: SPEC_CONFIDENCE,
        tags: endpoint.tags,
      })];
    }),
  };
}

/** Names every reason the scan came up empty, so the failure is actionable without a rerun. */
function emptyScanMessage(facts: EmptyScanFacts): string {
  const parts = [`Scanned ${facts.dir} and found no endpoints.`];

  parts.push(facts.matched.length > 0
    ? `Matched but produced no routes: ${facts.matched.map((adapter) => adapter.name).join(", ")}.`
    : `No adapter matched. Tried: ${facts.adapters.map((adapter) => adapter.name).join(", ")}.`);

  parts.push(facts.parsed.length > 0
    ? `Specs parsed with no usable operation: ${facts.parsed.map((spec) => `${spec.path} (${spec.count})`).join(", ")}.`
    : "No spec file was parsed.");

  if (facts.unsupported.length > 0) {
    parts.push(`Specs found but not used: ${facts.unsupported.map((spec) => `${spec.path} — ${spec.reason}`).join(" ")}`);
  }

  const read = `${facts.tree.files.length} ${facts.tree.files.length === 1 ? "file" : "files"}`;
  parts.push(facts.tree.truncated
    ? `Read ${read} before hitting a scan cap, so the tree was only partly read.`
    : `Read ${read}.`);

  return parts.join(" ");
}

/**
 * Collapse duplicates field-wise. A spec that states a field wins; a spec that is
 * silent yields to the source-derived value, so neither side discards the other.
 */
function mergeEndpoints(endpoints: readonly DiscoveredEndpoint[]): DiscoveredEndpoint[] {
  const byRoute = new Map<string, DiscoveredEndpoint>();
  for (const endpoint of endpoints) {
    const key = `${endpoint.method} ${endpoint.path_template}`;
    const existing = byRoute.get(key);
    byRoute.set(key, existing ? mergeEndpointPair(existing, endpoint) : endpoint);
  }
  return sortEndpoints([...byRoute.values()]);
}

function mergeEndpointPair(left: DiscoveredEndpoint, right: DiscoveredEndpoint): DiscoveredEndpoint {
  const [stronger, weaker] = right.confidence > left.confidence ? [right, left] : [left, right];
  return omitUndefined({
    method: stronger.method,
    path_template: stronger.path_template,
    source_location: sourceLocationFor(stronger, weaker),
    confidence: stronger.confidence,
    tags: stronger.tags ?? weaker.tags,
  });
}

/** A spec path is not a handler location, so a real `file:line` always wins. */
function sourceLocationFor(stronger: DiscoveredEndpoint, weaker: DiscoveredEndpoint): string {
  if (stronger.source_location.includes(":")) return stronger.source_location;
  if (weaker.source_location.includes(":")) return weaker.source_location;
  return stronger.source_location;
}

/**
 * Drops a real trailing query string only. A `?` followed by `/` is an optional
 * parameter mid-path (`/mid/:a?/tail`); cutting at the first `?` would throw the
 * rest of the route away.
 */
function stripQueryString(path: string): string {
  for (let index = 0; index < path.length; index += 1) {
    if (path[index] !== "?") continue;
    const next = path[index + 1];
    if (next === undefined || next === "/") continue;
    return path.slice(0, index);
  }
  return path;
}

function normalizeSegment(segment: string): string {
  if (segment.startsWith(":")) return colonParameters(segment);
  const framework = frameworkParameter(segment);
  if (framework) return `{${framework}}`;
  if (isConcreteId(segment)) return "{id}";
  return segment;
}

/**
 * Rewrites every `:name` in one segment, not just the first: Express allows several
 * in a segment (`/a/:b-:c`) and a regex constraint after the name (`/users/:id(\d+)`),
 * which is a matching rule, not part of the template.
 */
function colonParameters(segment: string): string {
  const rewritten = segment.replace(COLON_PARAMETER_PATTERN, (_match, name: string) => `{${name}}`);
  return rewritten.includes("{") ? rewritten : "{id}";
}

function frameworkParameter(segment: string): string | undefined {
  if (segment.startsWith("{") && segment.endsWith("}")) {
    return parameterName(segment.slice(1, -1), "first");
  }
  if (segment.startsWith("[") && segment.endsWith("]")) {
    return parameterName(segment.replace(/^\[+|\]+$/g, "").replace(/^\.\.\./, ""), "first");
  }
  if (segment.startsWith("<") && segment.endsWith(">")) {
    return parameterName(segment.slice(1, -1), "last");
  }
  if (segment === "*") {
    return "wildcard";
  }
  return undefined;
}

/**
 * Strips converters, constraints, and modifiers, keeping the name. Which half of
 * `a:b` is the name depends on the framework: FastAPI and Starlette write
 * `{item_id:int}` with the name first, while Flask and Django write `<int:pk>` with
 * the converter first, so the bracket style decides which side to take.
 */
function parameterName(raw: string, side: "first" | "last"): string {
  const withoutConstraint = raw.replace(/\([\s\S]*$/, "");
  const parts = withoutConstraint.split(":");
  const picked = side === "first" ? parts[0] : parts[parts.length - 1];
  const name = (picked ?? "").replace(/[?*+]/g, "").trim();
  return name || "id";
}

function isConcreteId(segment: string): boolean {
  if (/^\d+$/.test(segment)) return true;
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(segment);
}

function omitUndefined<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(
    Object.entries(value).filter(([, item]) => item !== undefined),
  ) as T;
}

/**
 * Resolved on call, not at module load. The adapter modules import this one for
 * `normalizePathTemplate`, so a top-level array here is in the temporal dead zone
 * whenever an adapter module is evaluated first.
 */
function builtInAdapters(): readonly FrameworkAdapter[] {
  return [fastapiAdapter, expressAdapter];
}
