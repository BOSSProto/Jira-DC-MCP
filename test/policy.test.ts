import { test } from "node:test";
import assert from "node:assert/strict";
import { Policy } from "../src/core/policy.js";
import { ToolError } from "../src/core/errors.js";
import { testConfig } from "./helpers.js";

const read = { name: "jira_search_issues", tier: "read" as const };
const write = { name: "jira_write_comment", tier: "write" as const };

test("read-only mode hides write tools and names the knob when invoked anyway", () => {
  const p = new Policy(testConfig());
  assert.equal(p.isExposed(read), true);
  assert.equal(p.isExposed(write), false);
  assert.throws(() => p.assertAllowed(write), (e: ToolError) => e.code === "POLICY_BLOCKED" && e.message.includes("JIRA_MCP_MODE"));
});

test("full mode exposes writes but every write still needs confirm: true", () => {
  const p = new Policy(testConfig({ JIRA_MCP_MODE: "full" }));
  assert.equal(p.isExposed(write), true);
  p.assertAllowed(write);
  assert.throws(() => p.assertConfirmed(write, undefined), (e: ToolError) => e.code === "CONFIRMATION_REQUIRED");
  assert.throws(() => p.assertConfirmed(write, false), (e: ToolError) => e.code === "CONFIRMATION_REQUIRED");
  p.assertConfirmed(write, true);
  p.assertConfirmed(read, undefined);
});

test("block list wins regardless of mode and names itself", () => {
  const p = new Policy(testConfig({ JIRA_MCP_MODE: "full", JIRA_MCP_DISABLED_TOOLS: "jira_write_comment, jira_search_issues" }));
  assert.equal(p.isExposed(write), false);
  assert.equal(p.isExposed(read), false);
  assert.throws(() => p.assertAllowed(read), (e: ToolError) => e.message.includes("JIRA_MCP_DISABLED_TOOLS"));
});
