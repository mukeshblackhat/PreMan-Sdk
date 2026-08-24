import type {
  AssertionConfig,
  AssertionConfigResult,
  AssertionVerdict,
  JsonValue,
  StateAssertion,
} from "./assertions.js";
import { runStateAssertionConfig } from "./assertions.js";
import { PremanConfigError } from "./errors.js";

export type AgentTestSuite = {
  version: 1;
  name: string;
  tests: AgentTestCase[];
};

export type AgentTestCase = {
  id: string;
  description?: string;
  action: AgentAction;
  expect?: StateAssertion[];
  verify?: AssertionConfig;
};

export type AgentAction = HttpAction | NoopAction;

export type HttpActionMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD";

export type HttpAction = {
  kind: "http";
  url: string;
  method?: HttpActionMethod;
  headers?: Record<string, string>;
  headersFromEnv?: Record<string, string>;
  body?: JsonValue;
  timeoutMs?: number;
};

/** Verification-only case: runs `verify` without driving an action first. */
export type NoopAction = {
  kind: "noop";
};

export type ActionError = {
  code: string;
  message: string;
};

export type ActionOutcome = {
  kind: AgentAction["kind"];
  name: string;
  durationMs: number;
  input?: JsonValue;
  output?: JsonValue;
  status?: number;
  error?: ActionError;
};

export type AgentTestResult = {
  id: string;
  verdict: AssertionVerdict;
  durationMs: number;
  action: ActionOutcome;
  description?: string;
  expect?: AssertionConfigResult;
  verify?: AssertionConfigResult;
  failureReason?: string;
};

export type AgentTestSummary = {
  total: number;
  passed: number;
  failed: number;
  errored: number;
  skipped: number;
};

export type AgentTestSuiteResult = {
  suite: string;
  verdict: AssertionVerdict;
  durationMs: number;
  summary: AgentTestSummary;
  tests: AgentTestResult[];
};

export type AgentTestRunOptions = {
  fetchImpl?: typeof fetch;
  env?: Record<string, string | undefined>;
  filter?: string;
  bail?: boolean;
};

const DEFAULT_ACTION_TIMEOUT_MS = 5_000;
const DEFAULT_ACTION_METHOD: HttpActionMethod = "POST";

const HTTP_ACTION_METHODS: readonly HttpActionMethod[] = [
  "GET",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "HEAD",
];

/**
 * Parse an agent test suite file. Assertion bodies are validated at run time by
 * runStateAssertionConfig() so the suite parser stays responsible only for structure.
 */
export function parseAgentTestSuite(value: string | unknown): AgentTestSuite {
  const parsed = typeof value === "string" ? JSON.parse(value) : value;
  const record = asRecord(parsed);
  if (!record) {
    throw new PremanConfigError("Agent test suite must be a JSON object.");
  }
  if (record["version"] !== 1) {
    throw new PremanConfigError("Agent test suite must set \"version\": 1.");
  }
  const name = stringAt(record, "name");
  if (!name) {
    throw new PremanConfigError("Agent test suite must have a name.");
  }
  const rawTests = record["tests"];
  if (!Array.isArray(rawTests) || rawTests.length === 0) {
    throw new PremanConfigError("Agent test suite must have a non-empty tests array.");
  }
  const tests = rawTests.map((test, index) => parseAgentTestCase(test, index));
  requireUniqueIds(tests);
  return { version: 1, name, tests };
}

/** Run every case in a suite. All I/O is injected so callers can run this offline. */
export async function runAgentTestSuite(
  suite: AgentTestSuite,
  options: AgentTestRunOptions = {},
): Promise<AgentTestSuiteResult> {
  const started = Date.now();
  const selected = options.filter
    ? suite.tests.filter((test) => test.id === options.filter)
    : suite.tests;

  const tests: AgentTestResult[] = [];
  for (const testCase of selected) {
    const result = await runAgentTestCase(testCase, options);
    tests.push(result);
    if (options.bail && result.verdict !== "passed") {
      break;
    }
  }

  return {
    suite: suite.name,
    verdict: aggregateVerdict(tests.map((test) => test.verdict)),
    durationMs: Math.max(0, Date.now() - started),
    summary: summarize(tests, suite.tests.length),
    tests,
  };
}

/** Run one case: drive the action, check the response, then verify backend state. */
export async function runAgentTestCase(
  testCase: AgentTestCase,
  options: AgentTestRunOptions = {},
): Promise<AgentTestResult> {
  const started = Date.now();
  const action = await runAgentAction(testCase.action, options);
  const base = omitUndefined({
    id: testCase.id,
    description: testCase.description,
    action,
  });

  if (action.error) {
    return omitUndefined({
      ...base,
      verdict: "error" as const,
      durationMs: Math.max(0, Date.now() - started),
      failureReason: `action: ${action.error.message}`,
    });
  }

  const env = options.env ?? process.env;
  const expect = testCase.expect
    ? await runStateAssertionConfig({
      id: `${testCase.id}:expect`,
      observation: {
        found: action.output !== undefined,
        value: action.output,
        latencyMs: action.durationMs,
      },
      assertions: testCase.expect,
    }, { env })
    : undefined;

  const verify = testCase.verify
    ? await runStateAssertionConfig({
      ...testCase.verify,
      id: testCase.verify.id ?? `${testCase.id}:verify`,
    }, omitUndefined({ env, fetchImpl: options.fetchImpl }))
    : undefined;

  return omitUndefined({
    ...base,
    verdict: aggregateVerdict([expect?.verdict, verify?.verdict]),
    durationMs: Math.max(0, Date.now() - started),
    expect,
    verify,
    failureReason: firstFailureReason(expect, verify),
  });
}

/** Human-readable suite output. Callers print this; --json prints the result object instead. */
export function formatAgentTestSuiteResult(result: AgentTestSuiteResult): string {
  const lines: string[] = [];
  lines.push(`Suite: ${result.suite}`);
  for (const test of result.tests) {
    lines.push(`  ${verdictSigil(test.verdict)} ${test.id} (${test.action.name}, ${test.durationMs}ms)`);
    if (test.failureReason) {
      lines.push(`      ${test.failureReason}`);
    }
  }
  const { total, passed, failed, errored, skipped } = result.summary;
  lines.push(`Total: ${total}  passed: ${passed}  failed: ${failed}  errored: ${errored}  skipped: ${skipped}`);
  lines.push(result.verdict === "passed" ? "All action tests passed." : `Suite verdict: ${result.verdict}.`);
  return `${lines.join("\n")}\n`;
}

function parseAgentTestCase(value: unknown, index: number): AgentTestCase {
  const record = asRecord(value);
  if (!record) {
    throw new PremanConfigError(`tests[${index}] must be an object.`);
  }
  const id = stringAt(record, "id");
  if (!id) {
    throw new PremanConfigError(`tests[${index}] must have an id.`);
  }

  const expect = parseExpect(record["expect"], id);
  const verify = parseVerify(record["verify"], id);
  if (!expect && !verify) {
    throw new PremanConfigError(`Test "${id}" must have expect or verify.`);
  }

  return omitUndefined({
    id,
    description: stringAt(record, "description") || undefined,
    action: parseAgentAction(record["action"], id),
    expect,
    verify,
  });
}

function parseExpect(value: unknown, testId: string): StateAssertion[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    throw new PremanConfigError(`Test "${testId}" expect must be an array of assertions.`);
  }
  return value as StateAssertion[];
}

function parseVerify(value: unknown, testId: string): AssertionConfig | undefined {
  if (value === undefined) return undefined;
  if (!asRecord(value)) {
    throw new PremanConfigError(`Test "${testId}" verify must be an object.`);
  }
  return value as AssertionConfig;
}

function parseAgentAction(value: unknown, testId: string): AgentAction {
  const record = asRecord(value);
  if (!record) {
    throw new PremanConfigError(`Test "${testId}" must have an action object.`);
  }
  const kind = record["kind"];
  if (kind === "noop") {
    return { kind: "noop" };
  }
  if (kind !== "http") {
    throw new PremanConfigError(
      `Test "${testId}" has unsupported action kind ${JSON.stringify(kind)}. Supported kinds: http, noop.`,
    );
  }
  if (record["headers"] !== undefined) {
    throw new PremanConfigError(
      `Test "${testId}" must use headersFromEnv instead of literal headers so secrets stay out of the suite file.`,
    );
  }

  const method = parseActionMethod(record["method"], testId);
  return omitUndefined({
    kind: "http" as const,
    url: parseActionUrl(record["url"], testId),
    method,
    headersFromEnv: parseStringMap(record["headersFromEnv"], testId, "headersFromEnv"),
    body: parseActionBody(record["body"], method ?? DEFAULT_ACTION_METHOD, testId),
    timeoutMs: parseActionTimeout(record["timeoutMs"], testId),
  });
}

function parseActionMethod(value: unknown, testId: string): HttpActionMethod | undefined {
  if (value === undefined) return undefined;
  if (!isHttpActionMethod(value)) {
    throw new PremanConfigError(`Test "${testId}" has unsupported action method ${JSON.stringify(value)}.`);
  }
  return value;
}

function parseActionBody(
  value: unknown,
  method: HttpActionMethod,
  testId: string,
): JsonValue | undefined {
  if (value === undefined) return undefined;
  if (method === "GET" || method === "HEAD") {
    throw new PremanConfigError(`Test "${testId}" cannot send a body with a ${method} action.`);
  }
  return value as JsonValue;
}

function parseActionTimeout(value: unknown, testId: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new PremanConfigError(`Test "${testId}" timeoutMs must be a positive number.`);
  }
  return value;
}

function parseActionUrl(value: unknown, testId: string): string {
  if (typeof value !== "string" || !value) {
    throw new PremanConfigError(`Test "${testId}" http action must have a url.`);
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new PremanConfigError(`Test "${testId}" http action url is not a valid URL.`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new PremanConfigError(`Test "${testId}" http action url must use http or https.`);
  }
  return url.toString();
}

function parseStringMap(
  value: unknown,
  testId: string,
  field: string,
): Record<string, string> | undefined {
  if (value === undefined) return undefined;
  const record = asRecord(value);
  if (!record) {
    throw new PremanConfigError(`Test "${testId}" ${field} must be an object.`);
  }
  const result: Record<string, string> = {};
  for (const [key, item] of Object.entries(record)) {
    if (typeof item !== "string") {
      throw new PremanConfigError(`Test "${testId}" ${field}.${key} must be a string.`);
    }
    result[key] = item;
  }
  return result;
}

function requireUniqueIds(tests: AgentTestCase[]): void {
  const seen = new Set<string>();
  for (const test of tests) {
    if (seen.has(test.id)) {
      throw new PremanConfigError(`Duplicate test id "${test.id}".`);
    }
    seen.add(test.id);
  }
}

function isHttpActionMethod(value: unknown): value is HttpActionMethod {
  return typeof value === "string" && HTTP_ACTION_METHODS.includes(value as HttpActionMethod);
}

async function runAgentAction(
  action: AgentAction,
  options: AgentTestRunOptions,
): Promise<ActionOutcome> {
  if (action.kind === "noop") {
    return { kind: "noop", name: "noop", durationMs: 0 };
  }
  return runHttpAction(action, options);
}

async function runHttpAction(
  action: HttpAction,
  options: AgentTestRunOptions,
): Promise<ActionOutcome> {
  const method = action.method ?? DEFAULT_ACTION_METHOD;
  const base = omitUndefined({
    kind: "http" as const,
    name: `${method} ${sanitizeEndpoint(action.url)}`,
    input: action.body,
  });

  const headers = resolveActionHeaders(action, options.env ?? process.env);
  if (headers.error) {
    return actionError(base, 0, headers.error.code, headers.error.message);
  }

  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") {
    return actionError(base, 0, "action_fetch_unavailable", "No fetch implementation available.");
  }

  const controller = new AbortController();
  const timeoutMs = action.timeoutMs ?? DEFAULT_ACTION_TIMEOUT_MS;
  const started = Date.now();
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  try {
    const response = await fetchImpl(action.url, {
      method,
      headers: headers.headers,
      redirect: "manual",
      signal: controller.signal,
      ...(action.body === undefined ? {} : { body: JSON.stringify(action.body) }),
    });
    const durationMs = Math.max(0, Date.now() - started);

    if (response.status >= 300 && response.status < 400) {
      return actionError(base, durationMs, "action_redirect_rejected", "Action request was redirected.", response.status);
    }
    if (!response.ok) {
      return actionError(
        base,
        durationMs,
        "action_http_error",
        `Action request returned status ${response.status}.`,
        response.status,
      );
    }

    const body = await readActionBody(response, method);
    if (body.error) {
      return actionError(base, durationMs, body.error.code, body.error.message, response.status);
    }
    return omitUndefined({ ...base, durationMs, status: response.status, output: body.value });
  } catch (error) {
    const durationMs = Math.max(0, Date.now() - started);
    if (timedOut || isAbortError(error)) {
      return actionError(base, durationMs, "action_timeout", `Action request timed out after ${timeoutMs}ms.`);
    }
    return actionError(base, durationMs, "action_network_error", "Action request could not be completed.");
  } finally {
    clearTimeout(timeout);
  }
}

function actionError(
  base: Pick<ActionOutcome, "kind" | "name" | "input">,
  durationMs: number,
  code: string,
  message: string,
  status?: number,
): ActionOutcome {
  return omitUndefined({
    ...base,
    durationMs,
    status,
    error: { code, message },
  });
}

async function readActionBody(
  response: Response,
  method: HttpActionMethod,
): Promise<{ value?: JsonValue; error?: undefined } | { error: ActionError }> {
  if (method === "HEAD" || response.status === 204) {
    return {};
  }
  const contentType = response.headers.get("content-type") ?? "";
  let text: string;
  try {
    text = await response.text();
  } catch {
    return { error: { code: "action_body_unreadable", message: "Action response body could not be read." } };
  }
  if (!text) {
    return {};
  }
  if (!isJsonContentType(contentType)) {
    return { value: text };
  }
  try {
    return { value: JSON.parse(text) as JsonValue };
  } catch {
    return { error: { code: "action_invalid_json", message: "Action response was not valid JSON." } };
  }
}

function resolveActionHeaders(
  action: HttpAction,
  env: Record<string, string | undefined>,
): { headers: Record<string, string>; error?: undefined } | { error: ActionError } {
  const headers: Record<string, string> = { ...action.headers };
  for (const [header, envName] of Object.entries(action.headersFromEnv ?? {})) {
    const secret = env[envName];
    if (!secret) {
      return {
        error: {
          code: "action_missing_secret",
          message: `Environment variable ${envName} is required for action header ${header}.`,
        },
      };
    }
    headers[header] = secret;
  }
  if (action.body !== undefined && !("content-type" in headers) && !("Content-Type" in headers)) {
    headers["Content-Type"] = "application/json";
  }
  return { headers };
}

function summarize(tests: AgentTestResult[], total: number): AgentTestSummary {
  return {
    total,
    passed: countVerdict(tests, "passed"),
    failed: countVerdict(tests, "failed"),
    errored: countVerdict(tests, "error"),
    skipped: Math.max(0, total - tests.length),
  };
}

function countVerdict(tests: AgentTestResult[], verdict: AssertionVerdict): number {
  return tests.filter((test) => test.verdict === verdict).length;
}

function firstFailureReason(
  expect: AssertionConfigResult | undefined,
  verify: AssertionConfigResult | undefined,
): string | undefined {
  return failureReasonFor("expect", expect) ?? failureReasonFor("verify", verify);
}

function failureReasonFor(
  scope: string,
  outcome: AssertionConfigResult | undefined,
): string | undefined {
  if (!outcome || outcome.verdict === "passed") return undefined;
  if (outcome.error) {
    return `${scope}: ${outcome.error.message}`;
  }
  const failed = outcome.assertions.find((assertion) => assertion.verdict !== "passed");
  return failed ? `${scope}: ${failed.message}` : undefined;
}

function verdictSigil(verdict: AssertionVerdict): string {
  if (verdict === "passed") return "+";
  if (verdict === "failed") return "-";
  return "!";
}

function aggregateVerdict(verdicts: (AssertionVerdict | undefined)[]): AssertionVerdict {
  if (verdicts.includes("error")) return "error";
  if (verdicts.includes("failed")) return "failed";
  return "passed";
}

function isJsonContentType(contentType: string): boolean {
  const value = contentType.toLowerCase();
  return value.includes("application/json") || value.includes("+json");
}

function isAbortError(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && (error as { name?: string }).name === "AbortError");
}

function sanitizeEndpoint(rawUrl: string): string {
  try {
    const url = new URL(rawUrl);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return "<invalid-url>";
    }
    url.username = "";
    url.password = "";
    url.hash = "";
    for (const key of [...url.searchParams.keys()]) {
      url.searchParams.set(key, "REDACTED");
    }
    return url.toString();
  } catch {
    return "<invalid-url>";
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function stringAt(value: Record<string, unknown> | undefined, key: string): string {
  const item = value?.[key];
  return typeof item === "string" ? item : "";
}

function omitUndefined<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(
    Object.entries(value).filter(([, item]) => item !== undefined),
  ) as T;
}
