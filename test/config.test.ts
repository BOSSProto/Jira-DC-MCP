import { test } from "node:test";
import assert from "node:assert/strict";
import { loadConfig, redactedConfig } from "../src/core/config.js";
import { testEnv } from "./helpers.js";

test("config fails fast and names the key and received value", () => {
  assert.throws(() => loadConfig({ JIRA_BASE_URL: "not a url", JIRA_PAT: "x" }), (e: Error) => e.message.includes("JIRA_BASE_URL") && e.message.includes('"not a url"'));
});

test("config errors redact secret values", () => {
  assert.throws(
    () => loadConfig({ JIRA_BASE_URL: "https://j.example.com", JIRA_AUTH_METHOD: "pat", JIRA_PAT: "pat-secret-value", JIRA_TIMEOUT_MS: "1" }),
    (e: Error) => e.message.includes("JIRA_TIMEOUT_MS") && !e.message.includes("pat-secret-value"),
  );
});

test("pat auth requires JIRA_PAT; basic requires username and password", () => {
  assert.throws(() => loadConfig({ JIRA_BASE_URL: "https://j.example.com", JIRA_AUTH_METHOD: "pat" }), /JIRA_PAT is required/);
  assert.throws(() => loadConfig({ JIRA_BASE_URL: "https://j.example.com", JIRA_AUTH_METHOD: "basic" }), /JIRA_USERNAME and JIRA_PASSWORD/);
});

test("defaults: read-only mode, cap 100, timeout 15000, trailing slash stripped", () => {
  const c = loadConfig(testEnv({ JIRA_BASE_URL: "https://jira.example.com/" }));
  assert.equal(c.JIRA_MCP_MODE, "read-only");
  assert.equal(c.JIRA_MAX_RESULTS_CAP, 100);
  assert.equal(c.JIRA_TIMEOUT_MS, 15000);
  assert.equal(c.JIRA_BASE_URL, "https://jira.example.com");
});

test("redactedConfig contains no credential values or keys", () => {
  const c = loadConfig(testEnv());
  const s = JSON.stringify(redactedConfig(c));
  assert.ok(!s.includes("pat-secret-value"));
  assert.ok(!("JIRA_PAT" in redactedConfig(c)));
});

test("config error says whether a .env was found", async () => {
  const { loadDotEnvIfPresent } = await import("../src/core/config.js");
  const cwd = process.cwd();
  const tmp = await import("node:os").then((os) => os.tmpdir());
  process.chdir(tmp);
  try {
    loadDotEnvIfPresent();
    assert.throws(() => loadConfig({}), (e: Error) => e.message.includes("No .env file was found") && e.message.includes(".env.txt"));
  } finally {
    process.chdir(cwd);
  }
});
