import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  formatAgentTestSuiteResult,
  parseAgentTestSuite,
  runAgentTestSuite,
} from "../dist/agent-tests.js";
import * as main from "../dist/index.js";

function jsonResponse(body, init = {}) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });
}

function suite(tests, name = "demo-suite") {
  return { version: 1, name, tests };
}

function runCli(args) {
  return spawnSync(process.execPath, ["dist/cli.js", "test", ...args], {
    cwd: process.cwd(),
    env: {},
    encoding: "utf8",
  });
}

const httpAction = {
  kind: "http",
  method: "POST",
  url: "https://staging.example.com/agent/refund",
  body: { order_id: 1049 },
};

test("parses a valid suite", () => {
  const parsed = parseAgentTestSuite(JSON.stringify(suite([
    { id: "a", action: httpAction, expect: [{ op: "exists" }] },
  ])));
  assert.equal(parsed.version, 1);
  assert.equal(parsed.name, "demo-suite");
  assert.equal(parsed.tests.length, 1);
  assert.equal(parsed.tests[0].action.kind, "http");
  assert.equal(parsed.tests[0].action.method, "POST");
});

test("parses an already-parsed object as well as a string", () => {
  const parsed = parseAgentTestSuite(suite([
    { id: "a", action: { kind: "noop" }, verify: { probe: { url: "https://x.example.com/a" }, assertions: [{ op: "exists" }] } },
  ]));
  assert.equal(parsed.tests[0].action.kind, "noop");
});

test("rejects a suite that is not an object", () => {
  assert.throws(() => parseAgentTestSuite("[]"), /must be a JSON object/);
});

test("rejects a missing or wrong version", () => {
  assert.throws(() => parseAgentTestSuite({ name: "x", tests: [] }), /"version": 1/);
});

test("rejects a missing name", () => {
  assert.throws(() => parseAgentTestSuite({ version: 1, tests: [] }), /must have a name/);
});

test("rejects an empty tests array", () => {
  assert.throws(() => parseAgentTestSuite({ version: 1, name: "x", tests: [] }), /non-empty tests array/);
});

test("rejects duplicate test ids", () => {
  assert.throws(
    () => parseAgentTestSuite(suite([
      { id: "dup", action: httpAction, expect: [{ op: "exists" }] },
      { id: "dup", action: httpAction, expect: [{ op: "exists" }] },
    ])),
    /Duplicate test id "dup"/,
  );
});

test("rejects an unknown action kind", () => {
  assert.throws(
    () => parseAgentTestSuite(suite([{ id: "a", action: { kind: "grpc" }, expect: [{ op: "exists" }] }])),
    /unsupported action kind/,
  );
});

test("rejects an http action without a usable url", () => {
  assert.throws(
    () => parseAgentTestSuite(suite([{ id: "a", action: { kind: "http" }, expect: [{ op: "exists" }] }])),
    /must have a url/,
  );
  assert.throws(
    () => parseAgentTestSuite(suite([{ id: "a", action: { kind: "http", url: "ftp://x/y" }, expect: [{ op: "exists" }] }])),
    /must use http or https/,
  );
});

test("rejects literal headers so secrets stay out of the suite file", () => {
  assert.throws(
    () => parseAgentTestSuite(suite([{
      id: "a",
      action: { ...httpAction, headers: { Authorization: "Bearer top-secret" } },
      expect: [{ op: "exists" }],
    }])),
    /headersFromEnv/,
  );
});

test("rejects a body on GET or HEAD actions", () => {
  assert.throws(
    () => parseAgentTestSuite(suite([{
      id: "a",
      action: { kind: "http", method: "GET", url: "https://x.example.com/a", body: { a: 1 } },
      expect: [{ op: "exists" }],
    }])),
    /cannot send a body with a GET action/,
  );
});

test("rejects a test that asserts nothing", () => {
  assert.throws(
    () => parseAgentTestSuite(suite([{ id: "a", action: httpAction }])),
    /must have expect or verify/,
  );
});

test("passes when the action response and backend state both match", async () => {
  const calls = [];
  const parsed = parseAgentTestSuite(suite([{
    id: "refund-created",
    action: httpAction,
    expect: [{ op: "equals", pointer: "/status", expected: "accepted" }],
    verify: {
      probe: { url: "https://staging.example.com/refunds" },
      assertions: [{ op: "equals", pointer: "/refunds/0/status", expected: "issued" }],
    },
  }]));

  const result = await runAgentTestSuite(parsed, {
    env: {},
    fetchImpl: async (url, init) => {
      calls.push({ url: String(url), method: init.method });
      return String(url).includes("/agent/refund")
        ? jsonResponse({ status: "accepted" })
        : jsonResponse({ refunds: [{ status: "issued" }] });
    },
  });

  assert.equal(result.verdict, "passed");
  assert.deepEqual(result.summary, { total: 1, passed: 1, failed: 0, errored: 0, skipped: 0 });
  assert.equal(result.tests[0].action.status, 200);
  assert.deepEqual(result.tests[0].action.input, { order_id: 1049 });
  assert.deepEqual(result.tests[0].action.output, { status: "accepted" });
  assert.equal(result.tests[0].failureReason, undefined);
  assert.equal(calls[0].method, "POST");
  assert.equal(calls.length, 2);
});

test("fails when the action response does not match expect", async () => {
  const parsed = parseAgentTestSuite(suite([{
    id: "refund-created",
    action: httpAction,
    expect: [{ op: "equals", pointer: "/status", expected: "accepted" }],
  }]));

  const result = await runAgentTestSuite(parsed, {
    env: {},
    fetchImpl: async () => jsonResponse({ status: "pending" }),
  });

  assert.equal(result.verdict, "failed");
  assert.equal(result.summary.failed, 1);
  assert.match(result.tests[0].failureReason, /^expect: /);
});

test("fails when backend state does not match verify", async () => {
  const parsed = parseAgentTestSuite(suite([{
    id: "refund-created",
    action: httpAction,
    verify: {
      probe: { url: "https://staging.example.com/refunds" },
      assertions: [{ op: "no_duplicate", pointer: "/refunds" }],
    },
  }]));

  const result = await runAgentTestSuite(parsed, {
    env: {},
    fetchImpl: async (url) => String(url).includes("/agent/refund")
      ? jsonResponse({ status: "accepted" })
      : jsonResponse({ refunds: [{ id: 1 }, { id: 2 }] }),
  });

  assert.equal(result.verdict, "failed");
  assert.match(result.tests[0].failureReason, /^verify: /);
});

test("reports an errored verdict when the action itself fails", async () => {
  const parsed = parseAgentTestSuite(suite([{
    id: "refund-created",
    action: httpAction,
    expect: [{ op: "exists" }],
  }]));

  const result = await runAgentTestSuite(parsed, {
    env: {},
    fetchImpl: async () => new Response("", { status: 500 }),
  });

  assert.equal(result.verdict, "error");
  assert.equal(result.summary.errored, 1);
  assert.equal(result.tests[0].action.error.code, "action_http_error");
  assert.equal(result.tests[0].expect, undefined);
  assert.match(result.tests[0].failureReason, /^action: /);
});

test("times out a slow action without hanging the suite", async () => {
  const parsed = parseAgentTestSuite(suite([{
    id: "slow",
    action: { ...httpAction, timeoutMs: 10 },
    expect: [{ op: "exists" }],
  }]));

  const result = await runAgentTestSuite(parsed, {
    env: {},
    fetchImpl: (_url, init) => new Promise((_resolve, reject) => {
      init.signal.addEventListener("abort", () => {
        const error = new Error("aborted");
        error.name = "AbortError";
        reject(error);
      });
    }),
  });

  assert.equal(result.verdict, "error");
  assert.equal(result.tests[0].action.error.code, "action_timeout");
});

test("sends headers from env and never serializes the secret", async () => {
  let authorization;
  const parsed = parseAgentTestSuite(suite([{
    id: "refund-created",
    action: { ...httpAction, headersFromEnv: { Authorization: "STAGING_AUTHORIZATION" } },
    expect: [{ op: "exists" }],
  }]));

  const result = await runAgentTestSuite(parsed, {
    env: { STAGING_AUTHORIZATION: "Bearer top-secret" },
    fetchImpl: async (_url, init) => {
      authorization = init.headers.Authorization;
      return jsonResponse({ status: "accepted" });
    },
  });

  assert.equal(result.verdict, "passed");
  assert.equal(authorization, "Bearer top-secret");
  assert.equal(JSON.stringify(result).includes("top-secret"), false);
});

test("errors when a required env secret is missing", async () => {
  const parsed = parseAgentTestSuite(suite([{
    id: "refund-created",
    action: { ...httpAction, headersFromEnv: { Authorization: "STAGING_AUTHORIZATION" } },
    expect: [{ op: "exists" }],
  }]));

  const result = await runAgentTestSuite(parsed, { env: {}, fetchImpl: async () => jsonResponse({}) });

  assert.equal(result.verdict, "error");
  assert.equal(result.tests[0].action.error.code, "action_missing_secret");
});

test("redacts query parameters from the reported action name", async () => {
  const parsed = parseAgentTestSuite(suite([{
    id: "refund-created",
    action: { kind: "http", method: "GET", url: "https://staging.example.com/agent?token=top-secret" },
    expect: [{ op: "exists" }],
  }]));

  const result = await runAgentTestSuite(parsed, {
    env: {},
    fetchImpl: async () => jsonResponse({ ok: true }),
  });

  assert.equal(result.tests[0].action.name.includes("top-secret"), false);
  assert.equal(result.tests[0].action.name.includes("REDACTED"), true);
});

test("runs a verification-only noop case without any action request", async () => {
  let actionCalls = 0;
  const parsed = parseAgentTestSuite(suite([{
    id: "no-orphan-refund",
    action: { kind: "noop" },
    verify: {
      probe: { url: "https://staging.example.com/refunds" },
      assertions: [{ op: "not_exists", pointer: "/refunds/0" }],
    },
  }]));

  const result = await runAgentTestSuite(parsed, {
    env: {},
    fetchImpl: async (url) => {
      if (String(url).includes("/agent")) actionCalls += 1;
      return jsonResponse({ refunds: [] });
    },
  });

  assert.equal(result.verdict, "passed");
  assert.equal(actionCalls, 0);
  assert.equal(result.tests[0].action.kind, "noop");
});

test("filter runs one test and counts the rest as skipped", async () => {
  const parsed = parseAgentTestSuite(suite([
    { id: "first", action: httpAction, expect: [{ op: "exists" }] },
    { id: "second", action: httpAction, expect: [{ op: "exists" }] },
  ]));

  const result = await runAgentTestSuite(parsed, {
    env: {},
    filter: "second",
    fetchImpl: async () => jsonResponse({ status: "accepted" }),
  });

  assert.equal(result.tests.length, 1);
  assert.equal(result.tests[0].id, "second");
  assert.deepEqual(result.summary, { total: 2, passed: 1, failed: 0, errored: 0, skipped: 1 });
});

test("bail stops the suite at the first non-passing test", async () => {
  const parsed = parseAgentTestSuite(suite([
    { id: "first", action: httpAction, expect: [{ op: "equals", pointer: "/status", expected: "accepted" }] },
    { id: "second", action: httpAction, expect: [{ op: "exists" }] },
  ]));

  const result = await runAgentTestSuite(parsed, {
    env: {},
    bail: true,
    fetchImpl: async () => jsonResponse({ status: "pending" }),
  });

  assert.equal(result.tests.length, 1);
  assert.equal(result.verdict, "failed");
  assert.equal(result.summary.skipped, 1);
});

test("formats a suite result as plain text", async () => {
  const parsed = parseAgentTestSuite(suite([{
    id: "refund-created",
    action: httpAction,
    expect: [{ op: "equals", pointer: "/status", expected: "accepted" }],
  }]));

  const passing = await runAgentTestSuite(parsed, {
    env: {},
    fetchImpl: async () => jsonResponse({ status: "accepted" }),
  });
  const passingText = formatAgentTestSuiteResult(passing);
  assert.match(passingText, /Suite: demo-suite/);
  assert.match(passingText, /\+ refund-created/);
  assert.match(passingText, /All action tests passed\./);
  assert.equal(passingText.endsWith("\n"), true);

  const failing = await runAgentTestSuite(parsed, {
    env: {},
    fetchImpl: async () => jsonResponse({ status: "pending" }),
  });
  const failingText = formatAgentTestSuiteResult(failing);
  assert.match(failingText, /- refund-created/);
  assert.match(failingText, /Suite verdict: failed\./);
});

test("rejects an empty expect array", () => {
  assert.throws(
    () => parseAgentTestSuite(suite([{ id: "a", action: httpAction, expect: [] }])),
    /expect must be a non-empty array/,
  );
});

test("rejects action urls that embed credentials", () => {
  assert.throws(
    () => parseAgentTestSuite(suite([{
      id: "a",
      action: { ...httpAction, url: "https://user:pass@staging.example.com/agent/refund" },
      expect: [{ op: "exists" }],
    }])),
    /username or password/,
  );
});

test("throws when a filter matches no test id", async () => {
  const parsed = parseAgentTestSuite(suite([{ id: "real", action: httpAction, expect: [{ op: "exists" }] }]));
  await assert.rejects(
    () => runAgentTestSuite(parsed, { env: {}, filter: "typo", fetchImpl: async () => jsonResponse({}) }),
    /matches filter "typo"/,
  );
});

test("treats a completed action with no body as found, like a probe", async () => {
  const parsed = parseAgentTestSuite(suite([{
    id: "no-content",
    action: httpAction,
    expect: [{ op: "exists" }],
  }]));

  const result = await runAgentTestSuite(parsed, {
    env: {},
    fetchImpl: async () => new Response(null, { status: 204 }),
  });

  assert.equal(result.verdict, "passed");
  assert.equal(result.tests[0].action.status, 204);
  assert.equal(result.tests[0].action.output, null);
});

test("reports a timeout during body download as a timeout", async () => {
  const parsed = parseAgentTestSuite(suite([{
    id: "slow-body",
    action: { ...httpAction, timeoutMs: 40 },
    expect: [{ op: "exists" }],
  }]));

  const result = await runAgentTestSuite(parsed, {
    env: {},
    fetchImpl: async () => new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"partial":'));
        },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    ),
  });

  assert.equal(result.verdict, "error");
  assert.equal(result.tests[0].action.error.code, "action_timeout");
});

test("rejects action responses that are neither JSON nor text", async () => {
  const parsed = parseAgentTestSuite(suite([{
    id: "binary",
    action: httpAction,
    expect: [{ op: "exists" }],
  }]));

  const result = await runAgentTestSuite(parsed, {
    env: {},
    fetchImpl: async () => new Response("binary", { status: 200, headers: { "content-type": "image/png" } }),
  });

  assert.equal(result.verdict, "error");
  assert.equal(result.tests[0].action.error.code, "action_unsupported_content_type");
});

test("action latency covers body download, not just time to headers", async () => {
  const parsed = parseAgentTestSuite(suite([{
    id: "slow-body-latency",
    action: httpAction,
    expect: [{ op: "latency_threshold", maxMs: 50 }],
  }]));

  const result = await runAgentTestSuite(parsed, {
    env: {},
    fetchImpl: async () => new Response(
      new ReadableStream({
        start(controller) {
          setTimeout(() => {
            controller.enqueue(new TextEncoder().encode('{"ok":true}'));
            controller.close();
          }, 120);
        },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    ),
  });

  assert.equal(result.verdict, "failed");
  assert.equal(result.tests[0].action.durationMs >= 100, true);
});

test("rejects a JSON body that is not a serializable JSON value", async () => {
  const parsed = parseAgentTestSuite(suite([{
    id: "non-finite",
    action: httpAction,
    expect: [{ op: "exists" }],
  }]));

  const result = await runAgentTestSuite(parsed, {
    env: {},
    fetchImpl: async () => new Response('{"amount":1e999}', {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  });

  assert.equal(result.verdict, "error");
  assert.equal(result.tests[0].action.error.code, "action_invalid_json");
});

test("json content-type detection matches probe word-boundary rules", async () => {
  const parsed = parseAgentTestSuite(suite([{ id: "a", action: httpAction, expect: [{ op: "exists" }] }]));

  const jsonp = await runAgentTestSuite(parsed, {
    env: {},
    fetchImpl: async () => new Response('{"a":1}', {
      status: 200,
      headers: { "content-type": "application/jsonp" },
    }),
  });
  assert.equal(jsonp.tests[0].action.error.code, "action_unsupported_content_type");

  const vendorJson = await runAgentTestSuite(parsed, {
    env: {},
    fetchImpl: async () => new Response('{"a":1}', {
      status: 200,
      headers: { "content-type": "application/vnd.api+json; charset=utf-8" },
    }),
  });
  assert.equal(vendorJson.verdict, "passed");
  assert.deepEqual(vendorJson.tests[0].action.output, { a: 1 });
});

test("main package re-exports agent test helpers", () => {
  assert.equal(typeof main.parseAgentTestSuite, "function");
  assert.equal(typeof main.runAgentTestSuite, "function");
  assert.equal(typeof main.runAgentTestCase, "function");
  assert.equal(typeof main.formatAgentTestSuiteResult, "function");
  assert.equal("sanitizeEndpoint" in main, false);
  assert.equal("aggregateVerdict" in main, false);
});

test("preman test CLI runs a suite without PREMAN_API_KEY and exits by verdict", () => {
  const dir = mkdtempSync(join(tmpdir(), "preman-agent-tests-"));
  const suiteFile = join(dir, "suite.json");
  const literalHeaderFile = join(dir, "literal-header.json");
  const malformedFile = join(dir, "malformed.json");
  const unreachableFile = join(dir, "unreachable.json");
  writeFileSync(suiteFile, `${JSON.stringify(suite([{
    id: "refund-created",
    action: httpAction,
    expect: [{ op: "exists" }],
  }]))}\n`);
  writeFileSync(literalHeaderFile, `${JSON.stringify(suite([{
    id: "refund-created",
    action: { ...httpAction, headers: { Authorization: "Bearer super-secret-value" } },
    expect: [{ op: "exists" }],
  }]))}\n`);
  writeFileSync(malformedFile, `{
  "version": 1,
  "headers": { "Authorization": Bearer super-secret-value }
}\n`);
  writeFileSync(unreachableFile, `${JSON.stringify(suite([{
    id: "unreachable",
    action: { kind: "http", method: "POST", url: "http://127.0.0.1:1/agent/refund", body: { a: 1 } },
    expect: [{ op: "exists" }],
  }]))}\n`);

  const dryRun = runCli(["--suite", suiteFile, "--dry-run", "--json"]);
  assert.equal(dryRun.status, 0, dryRun.stderr);
  const plan = JSON.parse(dryRun.stdout);
  assert.equal(plan.suite, "demo-suite");
  assert.deepEqual(plan.tests, [{ id: "refund-created", action: "http" }]);

  assert.equal(runCli([]).status, 2);

  const missingFile = runCli(["--suite", "does-not-exist.json", "--json"]);
  assert.equal(missingFile.status, 2);
  assert.equal(JSON.parse(missingFile.stdout).error.code, "invalid_config");

  const malformed = runCli(["--suite", malformedFile, "--json"]);
  assert.equal(malformed.status, 2);
  const parsedMalformed = JSON.parse(malformed.stdout);
  assert.equal(parsedMalformed.verdict, "error");
  assert.equal(parsedMalformed.error.code, "invalid_config");
  assert.equal(`${malformed.stdout}${malformed.stderr}`.includes("super-secret-value"), false);

  const literalHeader = runCli(["--suite", literalHeaderFile, "--json"]);
  assert.equal(literalHeader.status, 2);
  assert.equal(`${literalHeader.stdout}${literalHeader.stderr}`.includes("super-secret-value"), false);

  const badFilter = runCli(["--suite", suiteFile, "--filter", "not-a-test-id", "--json"]);
  assert.equal(badFilter.status, 2);
  assert.equal(JSON.parse(badFilter.stdout).error.code, "invalid_config");

  const unreachable = runCli(["--suite", unreachableFile, "--json"]);
  assert.equal(unreachable.status, 1);
  const parsedUnreachable = JSON.parse(unreachable.stdout);
  assert.equal(parsedUnreachable.verdict, "error");
  assert.equal(parsedUnreachable.tests[0].action.error.code, "action_network_error");
});
