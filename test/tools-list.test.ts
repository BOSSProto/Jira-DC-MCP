import { test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { createTools, allToolNames } from "../src/tools/factory.js";
import { Policy } from "../src/core/policy.js";
import { JiraClient } from "../src/services/jira-client.js";
import { testConfig } from "./helpers.js";

function deps(overrides: Record<string, string> = {}) {
  const config = testConfig(overrides);
  return { config, policy: new Policy(config), jira: new JiraClient(config), startedAt: Date.now() };
}

test("tool names follow jira_<verb>_<object>, are unique, and writes carry the write_ prefix", () => {
  const seen = new Set<string>();
  for (const t of allToolNames()) {
    assert.match(t.name, /^jira_[a-z]+(_[a-z]+)*$/, t.name);
    assert.ok(!seen.has(t.name), `duplicate ${t.name}`);
    seen.add(t.name);
    if (t.tier === "write") assert.match(t.name, /^jira_write_/, t.name);
    else assert.doesNotMatch(t.name, /^jira_write_/, t.name);
  }
});

test("every tool has a strict object schema, annotations consistent with tier, and a when-to-call description", () => {
  for (const t of createTools(deps({ JIRA_MCP_MODE: "full" }))) {
    const def = t.inputSchema.def as any;
    assert.equal(def.type, "object", t.name);
    assert.equal(def.catchall?.def?.type, "never", `${t.name} must be .strict()`);
    assert.equal(t.annotations.readOnlyHint, t.tier !== "write", t.name);
    assert.ok(t.description.length > 60, `${t.name} description too short to guide a model`);
    assert.equal(typeof t.annotations.destructiveHint, "boolean", t.name);
    if (t.tier === "write") assert.ok("confirm" in t.inputSchema.shape, `${t.name} must take confirm`);
    // The contract the client sees is the emitted JSON schema: every parameter described, every integer bounded below.
    const props = (z.toJSONSchema(t.inputSchema) as any).properties ?? {};
    for (const [param, js] of Object.entries<any>(props)) {
      assert.ok(js.description, `${t.name}.${param} needs a description`);
      if (js.type === "integer") {
        const lower = typeof js.minimum === "number" ? js.minimum : typeof js.exclusiveMinimum === "number" ? js.exclusiveMinimum : undefined;
        assert.ok(lower !== undefined && lower >= 0, `${t.name}.${param} must be bounded below (got ${lower})`);
      }
    }
  }
});

test("golden: exposed tool list is derived from the factory, read-only vs full", () => {
  const readOnly = createTools(deps()).map((t) => t.name).sort();
  const full = createTools(deps({ JIRA_MCP_MODE: "full" })).map((t) => t.name).sort();
  assert.deepEqual(readOnly, allToolNames().filter((t) => t.tier !== "write").map((t) => t.name).sort());
  assert.deepEqual(full, allToolNames().map((t) => t.name).sort());
  assert.equal(full.length, 17);
});

test("tier prefix is the only extra verb: write tools are jira_write_<object>", () => {
  for (const t of allToolNames().filter((t) => t.tier === "write")) assert.match(t.name, /^jira_write_[a-z_]+$/, t.name);
});

test("page-size schemas are bound to JIRA_MAX_RESULTS_CAP", () => {
  const tools = createTools(deps({ JIRA_MAX_RESULTS_CAP: "25" }));
  const search = tools.find((t) => t.name === "jira_search_issues")!;
  assert.equal(search.inputSchema.safeParse({ jql: "x", maxResults: 26 }).success, false);
  assert.equal(search.inputSchema.safeParse({ jql: "x", maxResults: 25 }).success, true);
  assert.equal(search.inputSchema.safeParse({ jql: "x", startAt: -1 }).success, false);
  const sprints = tools.find((t) => t.name === "jira_list_sprints")!;
  assert.equal(sprints.inputSchema.safeParse({ boardId: -5 }).success, false);
});

test("issue keys are validated on every key parameter", () => {
  const tools = createTools(deps({ JIRA_MCP_MODE: "full" }));
  for (const name of ["jira_get_issue", "jira_get_issue_context", "jira_list_issue_comments", "jira_write_comment", "jira_write_transition", "jira_write_fields"]) {
    const t = tools.find((x) => x.name === name)!;
    assert.equal(t.inputSchema.safeParse({ key: "not a key", body: "b", transitionName: "t", fields: { a: 1 } }).success, false, name);
  }
  const move = tools.find((x) => x.name === "jira_write_move_to_epic")!;
  assert.equal(move.inputSchema.safeParse({ epicKey: "PAY-1", issueKeys: ["bad"] }).success, false);
});

test("jira_server_info never returns the audit path or credentials", async () => {
  const d = deps({ JIRA_MCP_AUDIT_LOG: "C:/Users/someone/.jira-dc-mcp/audit.jsonl" });
  const info = createTools(d).find((t) => t.name === "jira_server_info")!;
  const out = JSON.stringify(await info.handler({ checkConnectivity: false } as never, { traceId: "t", jira: d.jira, config: d.config }));
  assert.ok(!out.includes("audit.jsonl"));
  assert.ok(!out.includes("C:/Users"));
  assert.ok(!out.includes("pat-secret-value"));
  assert.ok(out.includes('"auditLog":"enabled"'));
});
