import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { normalizePathTemplate, scanDirectory, sortEndpoints } from "../dist/scan.js";
import { PremanConfigError } from "../dist/errors.js";
import * as main from "../dist/index.js";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures");

function fixture(name) {
  return join(FIXTURES, name);
}

/**
 * Every fixture tree that scans successfully. Used by the whole-suite invariants
 * so a new fixture cannot quietly opt out of them.
 */
const SCANNABLE_FIXTURES = [
  "fastapi-app",
  "express-app",
  "express-receivers",
  "express-decoys",
  "express-chain",
  "express-template",
  "express-yaml-spec",
  "fastapi-decoys",
  "fastapi-methods",
  "spec-secrets",
];

/** Every endpoint `fastapi-app/` must produce, in `sortEndpoints()` order. */
const FASTAPI_ENDPOINTS = [
  { method: "GET", path_template: "/api/v1/items/{item_id}", source_location: "routers/items.py:8", confidence: 0.9 },
  { method: "PUT", path_template: "/api/v1/items/{item_id}", source_location: "routers/items.py:13", confidence: 0.9 },
  { method: "GET", path_template: "/api/v1/users", source_location: "routers/users.py:8", confidence: 0.9 },
  { method: "DELETE", path_template: "/api/v1/users/{user_id}", source_location: "routers/users.py:18", confidence: 0.9 },
  { method: "GET", path_template: "/api/v1/users/{user_id}", source_location: "routers/users.py:13", confidence: 0.9 },
  { method: "GET", path_template: "/health", source_location: "main.py:13", confidence: 0.9 },
  { method: "GET", path_template: "/legacy", source_location: "main.py:28", confidence: 0.9 },
  { method: "POST", path_template: "/legacy", source_location: "main.py:28", confidence: 0.9 },
  {
    method: "GET",
    path_template: "/reports/summary",
    source_location: "openapi.json",
    confidence: 1,
    tags: ["reports"],
  },
  {
    method: "POST",
    path_template: "/users",
    source_location: "main.py:23",
    confidence: 1,
    tags: ["users"],
  },
  {
    method: "GET",
    path_template: "/users/{user_id}",
    source_location: "main.py:18",
    confidence: 1,
    tags: ["users"],
  },
];

/** Every endpoint `express-app/` must produce, in `sortEndpoints()` order. */
const EXPRESS_ENDPOINTS = [
  { method: "DELETE", path_template: "/health", source_location: "app.js:25", confidence: 0.9 },
  { method: "GET", path_template: "/health", source_location: "app.js:25", confidence: 0.9 },
  { method: "PATCH", path_template: "/health", source_location: "app.js:25", confidence: 0.9 },
  { method: "POST", path_template: "/health", source_location: "app.js:25", confidence: 0.9 },
  { method: "PUT", path_template: "/health", source_location: "app.js:25", confidence: 0.9 },
  { method: "GET", path_template: "/status", source_location: "app.js:21", confidence: 0.9 },
  { method: "GET", path_template: "/things", source_location: "routes/things.js:15", confidence: 0.9 },
  { method: "POST", path_template: "/things", source_location: "routes/things.js:15", confidence: 0.9 },
  { method: "POST", path_template: "/users", source_location: "routes/users.js:6", confidence: 0.9 },
  { method: "DELETE", path_template: "/users/{id}", source_location: "app.js:17", confidence: 0.9 },
  { method: "GET", path_template: "/users/{id}", source_location: "app.js:13", confidence: 0.9 },
  { method: "PATCH", path_template: "/users/{id}", source_location: "routes/users.js:10", confidence: 0.9 },
];

/** The fake bait planted in `spec-secrets/openapi.json`, none of which may reach the output. */
const PLANTED_SECRETS = [
  "pm_live_FAKEinDescription",
  "pm_live_FAKEinExample",
  "pm_live_FAKEinDefault",
  "pm_live_FAKEinEnum",
  "pm_test_FAKEinQueryExample",
  "pm_test_FAKEinQueryDefault",
];

function endpointFor(result, method, pathTemplate) {
  const found = result.endpoints.filter(
    (endpoint) => endpoint.method === method && endpoint.path_template === pathTemplate,
  );
  assert.equal(found.length, 1, `expected exactly one ${method} ${pathTemplate}`);
  return found[0];
}

/** Asserts the scan fails loudly and hands the message back for content assertions. */
function scanFailure(name) {
  let thrown;
  try {
    scanDirectory({ dir: fixture(name) });
    thrown = undefined;
  } catch (error) {
    thrown = error;
  }
  assert.equal(
    thrown instanceof PremanConfigError,
    true,
    `${name} must throw PremanConfigError, not return an empty endpoint list`,
  );
  return thrown;
}

function routes(result) {
  return result.endpoints.map((endpoint) => `${endpoint.method} ${endpoint.path_template}`);
}

test("scans the FastAPI fixture tree into the full expected endpoint set", () => {
  const result = scanDirectory({ dir: fixture("fastapi-app") });

  assert.deepEqual(result.frameworks, ["fastapi"]);
  assert.deepEqual(result.specs, ["openapi.json"]);
  assert.deepEqual(result.unsupportedSpecs, []);
  assert.equal(result.truncated, false);
  assert.equal(result.fileCount, 7);
  assert.equal(result.dir, fixture("fastapi-app"));
  assert.equal(result.endpoints.length, 11);
  assert.deepEqual(result.endpoints, FASTAPI_ENDPOINTS);
});

test("scans the Express fixture tree into the full expected endpoint set", () => {
  const result = scanDirectory({ dir: fixture("express-app") });

  assert.deepEqual(result.frameworks, ["express"]);
  assert.deepEqual(result.specs, []);
  assert.deepEqual(result.unsupportedSpecs, []);
  assert.equal(result.truncated, false);
  assert.equal(result.fileCount, 4);
  assert.equal(result.dir, fixture("express-app"));
  assert.equal(result.endpoints.length, 12);
  assert.deepEqual(result.endpoints, EXPRESS_ENDPOINTS);
});

test("app.all fans out to exactly the five write-and-read methods on one line", () => {
  const result = scanDirectory({ dir: fixture("express-app") });
  const health = result.endpoints.filter((endpoint) => endpoint.path_template === "/health");

  assert.deepEqual(health.map((endpoint) => endpoint.method), ["DELETE", "GET", "PATCH", "POST", "PUT"]);
  assert.deepEqual([...new Set(health.map((endpoint) => endpoint.source_location))], ["app.js:25"]);
  assert.equal(health.some((endpoint) => endpoint.method === "HEAD"), false);
  assert.equal(health.some((endpoint) => endpoint.method === "OPTIONS"), false);
});

test("an unsupported tree throws PremanConfigError naming the adapters tried", () => {
  const dir = fixture("unknown-app");

  const thrown = scanFailure("unknown-app");
  assert.equal(thrown.name, "PremanConfigError");
  assert.equal(thrown.code, "config_error");
  assert.equal(
    thrown.message,
    `No adapter matched ${dir}. Tried: fastapi, express. `
    + "No committed OpenAPI or Swagger spec was found either.",
  );
  assert.match(thrown.message, /Tried: fastapi, express/);

  assert.throws(() => scanDirectory({ dir }), PremanConfigError);
});

test("a commented route in a file with no express import is never discovered", () => {
  const result = scanDirectory({ dir: fixture("express-app") });

  assert.equal(result.endpoints.some((endpoint) => endpoint.path_template === "/not-a-route"), false);
  assert.equal(
    result.endpoints.some((endpoint) => endpoint.source_location.startsWith("lib/format.js")),
    false,
  );
  assert.equal(JSON.stringify(result).includes("not-a-route"), false);
});

test("express decoys in comments and strings are dropped beside a real route in the same file", () => {
  const result = scanDirectory({ dir: fixture("express-decoys") });

  assert.deepEqual(result.frameworks, ["express"]);
  assert.deepEqual(routes(result), ["GET /real"]);
  assert.deepEqual(result.endpoints, [
    { method: "GET", path_template: "/real", source_location: "routes.js:14", confidence: 0.9 },
  ]);

  const json = JSON.stringify(result);
  assert.equal(json.includes("commented-out"), false);
  assert.equal(json.includes("block-commented"), false);
  assert.equal(json.includes("in-a-string"), false);
  assert.equal(json.includes("in-another-string"), false);
});

test("FastAPI decoys in # comments and docstrings are dropped beside a real route in the same file", () => {
  const result = scanDirectory({ dir: fixture("fastapi-decoys") });

  assert.deepEqual(result.frameworks, ["fastapi"]);
  assert.deepEqual(routes(result), ["GET /real"]);
  assert.deepEqual(result.endpoints, [
    { method: "GET", path_template: "/real", source_location: "app.py:15", confidence: 0.9 },
  ]);

  const json = JSON.stringify(result);
  assert.equal(json.includes("commented-out"), false);
  assert.equal(json.includes("also-commented-out"), false);
  assert.equal(json.includes("module-docstring"), false);
  assert.equal(json.includes("handler-docstring"), false);
});

test("only a variable assigned from express carries routes", () => {
  const result = scanDirectory({ dir: fixture("express-receivers") });

  assert.deepEqual(routes(result), ["GET /real"]);
  assert.deepEqual(result.endpoints, [
    { method: "GET", path_template: "/real", source_location: "app.js:6", confidence: 0.9 },
  ]);

  const json = JSON.stringify(result);
  assert.equal(json.includes("some-cache-key"), false);
  assert.equal(json.includes("another-key"), false);
  assert.equal(json.includes("api.example.com"), false);
  assert.equal(json.includes("/v1/remote"), false);
});

test("a .route() chain stops at its own expression and does not reach the next statement", () => {
  const result = scanDirectory({ dir: fixture("express-chain") });

  assert.deepEqual(routes(result), ["GET /chain", "POST /chain"]);
  assert.deepEqual(result.endpoints, [
    { method: "GET", path_template: "/chain", source_location: "router.js:8", confidence: 0.9 },
    { method: "POST", path_template: "/chain", source_location: "router.js:8", confidence: 0.9 },
  ]);
  assert.equal(JSON.stringify(result).includes("leaked"), false);
});

test("api_route keeps only methods that are real HTTP methods", () => {
  const result = scanDirectory({ dir: fixture("fastapi-methods") });

  assert.deepEqual(routes(result), ["GET /brew"]);
  assert.deepEqual(result.endpoints, [
    { method: "GET", path_template: "/brew", source_location: "app.py:6", confidence: 0.9 },
  ]);
  assert.equal(JSON.stringify(result).includes("BREW"), false);
});

test("a template literal path becomes a named placeholder, never a raw interpolation", () => {
  const result = scanDirectory({ dir: fixture("express-template") });

  assert.deepEqual(routes(result), ["PUT /tpl-{version}/users"]);
  assert.deepEqual(result.endpoints, [
    { method: "PUT", path_template: "/tpl-{version}/users", source_location: "app.js:6", confidence: 0.9 },
  ]);

  const json = JSON.stringify(result);
  assert.equal(json.includes("${"), false);
  assert.equal(json.includes("`"), false);
});

test("normalizePathTemplate rewrites each framework's parameter syntax to {name}", () => {
  assert.equal(normalizePathTemplate("/items/{item_id:int}"), "/items/{item_id}");
  assert.equal(normalizePathTemplate("/items/{item_id}"), "/items/{item_id}");
  assert.equal(normalizePathTemplate("/things/<int:pk>"), "/things/{pk}");
  assert.equal(normalizePathTemplate("/things/<pk>"), "/things/{pk}");
  assert.equal(normalizePathTemplate("/users/:id"), "/users/{id}");
  assert.equal(normalizePathTemplate("/blog/[slug]"), "/blog/{slug}");
  assert.equal(normalizePathTemplate("/docs/[...rest]"), "/docs/{rest}");

  // An optional parameter mid-path: the `?` belongs to the parameter, not a query string.
  assert.equal(normalizePathTemplate("/mid/:a?/tail"), "/mid/{a}/tail");
  // An Express regex constraint is a matching rule, not part of the template.
  assert.equal(normalizePathTemplate("/users/:id(\\d+)"), "/users/{id}");
  // Two parameters in one segment: every `:name` is rewritten, not just the first.
  assert.equal(normalizePathTemplate("/a/:b-:c"), "/a/{b}-{c}");
});

test("normalizePathTemplate collapses concrete ids and strips the query string", () => {
  assert.equal(normalizePathTemplate("/users/42"), "/users/{id}");
  assert.equal(
    normalizePathTemplate("/users/3fa85f64-5717-4562-b3fc-2c963f66afa6"),
    "/users/{id}",
  );
  assert.equal(normalizePathTemplate("/search?q=refund&limit=10"), "/search");
  assert.equal(normalizePathTemplate("/users/42?expand=orders"), "/users/{id}");
  assert.equal(normalizePathTemplate("/users/v2"), "/users/v2");
  assert.equal(normalizePathTemplate("/mid/:a?/tail?q=1"), "/mid/{a}/tail");
});

test("spec and source merge field-wise without either side discarding the other", () => {
  const result = scanDirectory({ dir: fixture("fastapi-app") });

  const getUser = endpointFor(result, "GET", "/users/{user_id}");
  assert.equal(getUser.source_location, "main.py:18");
  assert.equal(getUser.confidence, 1);
  assert.deepEqual(getUser.tags, ["users"]);
  assert.deepEqual(Object.keys(getUser).sort(), ["confidence", "method", "path_template", "source_location", "tags"]);

  const postUsers = endpointFor(result, "POST", "/users");
  assert.equal(postUsers.source_location, "main.py:23");
  assert.equal(postUsers.confidence, 1);
  assert.deepEqual(postUsers.tags, ["users"]);
  // The spec states a requestBody for this operation; the scan must not carry it.
  assert.equal("request_body_schema" in postUsers, false);
  assert.equal("query_schema" in postUsers, false);

  const specOnly = endpointFor(result, "GET", "/reports/summary");
  assert.equal(specOnly.source_location, "openapi.json");
  assert.equal(specOnly.confidence, 1);
  assert.deepEqual(specOnly.tags, ["reports"]);

  const sourceOnly = endpointFor(result, "GET", "/health");
  assert.equal(sourceOnly.source_location, "main.py:13");
  assert.equal(sourceOnly.confidence, 0.9);
  assert.equal("tags" in sourceOnly, false);
});

test("every tree that yields zero endpoints throws PremanConfigError explaining why", () => {
  const noRoutes = scanFailure("fastapi-no-routes");
  assert.match(noRoutes.message, /found no endpoints/);
  assert.match(noRoutes.message, /Matched but produced no routes: fastapi\./);
  assert.match(noRoutes.message, /No spec file was parsed\./);
  assert.match(noRoutes.message, /Read 1 file\./);

  const notASpec = scanFailure("spec-not-openapi");
  assert.match(notASpec.message, /found no endpoints/);
  assert.match(notASpec.message, /No adapter matched\. Tried: fastapi, express\./);
  assert.match(notASpec.message, /Specs found but not used: openapi\.json/);
  assert.match(notASpec.message, /must include a paths object/);

  const yamlOnly = scanFailure("spec-yaml-only");
  assert.match(yamlOnly.message, /found no endpoints/);
  assert.match(yamlOnly.message, /Specs found but not used: openapi\.yaml/);
  assert.match(yamlOnly.message, /YAML specs are not read/);
  assert.match(yamlOnly.message, /preman import openapi --file/);

  const jsxNoRoutes = scanFailure("express-no-routes");
  assert.match(jsxNoRoutes.message, /found no endpoints/);
  assert.match(jsxNoRoutes.message, /Matched but produced no routes: express\./);
  assert.match(jsxNoRoutes.message, /Read 1 file\./);
});

test("a YAML spec is reported as unsupported rather than silently used", () => {
  const result = scanDirectory({ dir: fixture("express-yaml-spec") });

  assert.deepEqual(result.frameworks, ["express"]);
  assert.deepEqual(result.specs, [], "specs names files that were read, so the yaml must not appear");
  assert.equal(result.unsupportedSpecs.length, 1);
  assert.equal(result.unsupportedSpecs[0].path, "openapi.yaml");
  assert.match(result.unsupportedSpecs[0].reason, /YAML/);
  assert.match(result.unsupportedSpecs[0].reason, /preman import openapi --file/);

  // `/yaml-only` exists only in the yaml, so its absence proves the yaml was not parsed.
  assert.deepEqual(routes(result), ["GET /ping"]);
  assert.equal(JSON.stringify(result.endpoints).includes("yaml-only"), false);
});

test("a scan cap sets truncated and stops the whole walk, not just one directory", () => {
  const byFiles = scanDirectory({ dir: fixture("express-app"), maxFiles: 1 });
  assert.equal(byFiles.truncated, true);
  assert.equal(byFiles.fileCount, 1);
  assert.deepEqual(
    [...new Set(byFiles.endpoints.map((endpoint) => endpoint.source_location.split(":")[0]))],
    ["app.js"],
    "the cap must end the walk, so no file below the first directory is read",
  );
  assert.equal(byFiles.endpoints.some((endpoint) => endpoint.path_template === "/things"), false);

  // 900 bytes fits app.js (630) but not app.js plus lib/format.js (979).
  const byBytes = scanDirectory({ dir: fixture("express-app"), maxTotalBytes: 900 });
  assert.equal(byBytes.truncated, true);
  assert.equal(byBytes.fileCount, 1);
  assert.deepEqual(byBytes.endpoints, byFiles.endpoints);

  const uncapped = scanDirectory({ dir: fixture("express-app") });
  assert.equal(uncapped.truncated, false);
  assert.equal(uncapped.fileCount, 4);
});

test("no endpoint carries a schema and a spec's planted secrets never reach the output", () => {
  for (const name of SCANNABLE_FIXTURES) {
    const result = scanDirectory({ dir: fixture(name) });
    for (const endpoint of result.endpoints) {
      assert.equal("request_body_schema" in endpoint, false, `${name} leaked request_body_schema`);
      assert.equal("query_schema" in endpoint, false, `${name} leaked query_schema`);
      assert.deepEqual(
        Object.keys(endpoint).filter((key) => key !== "tags").sort(),
        ["confidence", "method", "path_template", "source_location"],
        `${name} endpoint carries an unexpected field`,
      );
    }
  }

  const secrets = scanDirectory({ dir: fixture("spec-secrets") });
  assert.deepEqual(routes(secrets), ["POST /charges"], "the bait spec must still yield its route");
  assert.deepEqual(secrets.specs, ["openapi.json"]);

  const json = JSON.stringify(secrets);
  for (const secret of PLANTED_SECRETS) {
    assert.equal(json.includes(secret), false, `scan output leaked ${secret}`);
  }
  assert.equal(/pm_(live|test)_/.test(json), false);
  assert.equal(json.includes("example"), false);
  assert.equal(json.includes("default"), false);
  assert.equal(json.includes("enum"), false);
  assert.equal(json.includes("description"), false);
});

test("scanning the same tree twice produces deep-equal results", () => {
  for (const name of SCANNABLE_FIXTURES) {
    const first = scanDirectory({ dir: fixture(name) });
    const second = scanDirectory({ dir: fixture(name) });
    assert.deepEqual(first, second);
    assert.equal(JSON.stringify(first), JSON.stringify(second));
  }
});

test("sortEndpoints orders by path_template, then method, then source_location", () => {
  const unsorted = [
    { method: "GET", path_template: "/users/{id}", source_location: "b.js:2", confidence: 0.9 },
    { method: "POST", path_template: "/users", source_location: "a.js:1", confidence: 0.9 },
    { method: "GET", path_template: "/users/{id}", source_location: "a.js:9", confidence: 0.9 },
    { method: "DELETE", path_template: "/users/{id}", source_location: "z.js:1", confidence: 0.9 },
    { method: "GET", path_template: "/users", source_location: "a.js:1", confidence: 0.9 },
  ];
  const input = [...unsorted];

  assert.deepEqual(sortEndpoints(input), [
    { method: "GET", path_template: "/users", source_location: "a.js:1", confidence: 0.9 },
    { method: "POST", path_template: "/users", source_location: "a.js:1", confidence: 0.9 },
    { method: "DELETE", path_template: "/users/{id}", source_location: "z.js:1", confidence: 0.9 },
    { method: "GET", path_template: "/users/{id}", source_location: "a.js:9", confidence: 0.9 },
    { method: "GET", path_template: "/users/{id}", source_location: "b.js:2", confidence: 0.9 },
  ]);
  assert.deepEqual(input, unsorted, "sortEndpoints must not mutate its input");

  const scanned = scanDirectory({ dir: fixture("express-app") });
  assert.deepEqual(sortEndpoints(scanned.endpoints), scanned.endpoints);
});

test("main package re-exports scan helpers", () => {
  assert.equal(typeof main.scanDirectory, "function");
  assert.equal(typeof main.normalizePathTemplate, "function");
  assert.equal(typeof main.sortEndpoints, "function");
  assert.equal(typeof main.fastapiAdapter, "object");
  assert.equal(typeof main.expressAdapter, "object");
  assert.equal(main.scanDirectory, scanDirectory);
  assert.equal(main.normalizePathTemplate, normalizePathTemplate);
  assert.equal(main.sortEndpoints, sortEndpoints);
  assert.equal("mergeEndpoints" in main, false);
  assert.equal("mergeEndpointPair" in main, false);
  assert.equal("readSourceTree" in main, false);
  assert.equal("endpointsFromSpec" in main, false);
  assert.equal("sourceLocationFor" in main, false);
  assert.equal("builtInAdapters" in main, false);
  assert.equal("normalizeSegment" in main, false);
  assert.equal("parameterName" in main, false);
  assert.equal("emptyScanMessage" in main, false);
  assert.equal("stripQueryString" in main, false);
  assert.equal("colonParameters" in main, false);
  assert.equal("frameworkParameter" in main, false);
  assert.equal("isConcreteId" in main, false);
  assert.equal("isReadableSource" in main, false);
});

test("preman scan CLI reports endpoints without PREMAN_API_KEY and exits by outcome", () => {
  const dir = mkdtempSync(join(tmpdir(), "preman-scan-"));

  const runCli = (args) => spawnSync(process.execPath, ["dist/cli.js", "scan", ...args], {
    cwd: process.cwd(),
    env: {},
    encoding: "utf8",
  });

  const json = runCli(["--dir", "test/fixtures/fastapi-app", "--json"]);
  assert.equal(json.status, 0, json.stderr);
  const parsed = JSON.parse(json.stdout);
  assert.equal(parsed.dir, "test/fixtures/fastapi-app");
  assert.deepEqual(parsed.frameworks, ["fastapi"]);
  assert.deepEqual(parsed.specs, ["openapi.json"]);
  assert.deepEqual(parsed.unsupportedSpecs, []);
  assert.equal(parsed.truncated, false);
  assert.equal(parsed.fileCount, 7);
  assert.deepEqual(parsed.endpoints, FASTAPI_ENDPOINTS);
  assert.equal("error" in parsed, false);
  assert.equal(json.stdout.includes("request_body_schema"), false);
  assert.equal(json.stdout.includes("query_schema"), false);

  const text = runCli(["--dir", "test/fixtures/express-app"]);
  assert.equal(text.status, 0, text.stderr);
  assert.match(text.stdout, /Frameworks: express/);
  assert.match(text.stdout, /Total endpoints: 12/);
  assert.equal(text.stdout.includes("not-a-route"), false);
  assert.equal(text.stdout.includes("partial result"), false);

  const yamlSpec = runCli(["--dir", "test/fixtures/express-yaml-spec"]);
  assert.equal(yamlSpec.status, 0, yamlSpec.stderr);
  assert.match(yamlSpec.stdout, /Spec not used: openapi\.yaml/);
  assert.match(yamlSpec.stdout, /YAML specs are not read/);
  assert.equal(yamlSpec.stdout.includes("Specs: openapi.yaml"), false);
  assert.equal(yamlSpec.stdout.includes("yaml-only"), false);

  const bait = runCli(["--dir", "test/fixtures/spec-secrets", "--json"]);
  assert.equal(bait.status, 0, bait.stderr);
  const parsedBait = JSON.parse(bait.stdout);
  assert.deepEqual(parsedBait.endpoints.map((endpoint) => endpoint.path_template), ["/charges"]);

  const unsupported = runCli(["--dir", "test/fixtures/unknown-app", "--json"]);
  assert.equal(unsupported.status, 2);
  const parsedUnsupported = JSON.parse(unsupported.stdout);
  assert.deepEqual(parsedUnsupported.endpoints, []);
  assert.equal(parsedUnsupported.error.code, "invalid_config");
  assert.match(parsedUnsupported.error.message, /Tried: fastapi, express/);

  const noEndpoints = runCli(["--dir", "test/fixtures/fastapi-no-routes", "--json"]);
  assert.equal(noEndpoints.status, 2);
  const parsedNoEndpoints = JSON.parse(noEndpoints.stdout);
  assert.deepEqual(parsedNoEndpoints.endpoints, []);
  assert.equal(parsedNoEndpoints.error.code, "invalid_config");
  assert.match(parsedNoEndpoints.error.message, /Matched but produced no routes: fastapi/);

  const belowFloor = runCli(["--dir", "test/fixtures/express-app", "--min-endpoints", "50", "--json"]);
  assert.equal(belowFloor.status, 1);
  assert.equal(JSON.parse(belowFloor.stdout).endpoints.length, 12);
  assert.match(belowFloor.stderr, /min_endpoints_not_met/);

  const metFloor = runCli(["--dir", "test/fixtures/express-app", "--min-endpoints", "12", "--json"]);
  assert.equal(metFloor.status, 0, metFloor.stderr);

  const missingDir = runCli(["--dir", join(dir, "does-not-exist"), "--json"]);
  assert.equal(missingDir.status, 2);
  assert.equal(JSON.parse(missingDir.stdout).error.code, "invalid_config");

  const emptyDir = runCli(["--dir", dir, "--json"]);
  assert.equal(emptyDir.status, 2);
  assert.equal(JSON.parse(emptyDir.stdout).error.code, "invalid_config");

  const allOutput = [
    json, text, yamlSpec, bait, unsupported, noEndpoints, belowFloor, metFloor, missingDir, emptyDir,
  ].map((run) => `${run.stdout}${run.stderr}`).join("");
  for (const secret of PLANTED_SECRETS) {
    assert.equal(allOutput.includes(secret), false, `CLI output leaked ${secret}`);
  }
  assert.equal(/pm_(live|test)_/.test(allOutput), false);
  assert.equal(allOutput.includes("PREMAN_API_KEY"), false);
  assert.equal(allOutput.includes("Missing API key"), false);
  assert.equal(allOutput.includes("Authorization"), false);
});
