import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { AuditLog } from "../src/core/audit.js";
import { scrub } from "../src/core/errors.js";

test("audit record stores a hash and key names, never input values", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "audit-"));
  const file = path.join(dir, "a.jsonl");
  const audit = new AuditLog(file);
  const inputs = { jql: "project = XS AND text ~ 'customer secret'", maxResults: 5 };
  await audit.record({ ts: "t", traceId: "tr", principal: "rodi", tool: "jira_search_issues", tier: "read", inputsHash: AuditLog.hashInputs(inputs), inputKeys: Object.keys(inputs), outcome: "ok", durationMs: 3 });
  const line = (await readFile(file, "utf8")).trim();
  assert.ok(!line.includes("customer secret"));
  assert.ok(line.includes('"inputKeys":["jql","maxResults"]'));
  assert.equal(JSON.parse(line).inputsHash.length, 64);
});

test("hash is stable across key order", () => {
  assert.equal(AuditLog.hashInputs({ a: 1, b: [1, { c: 2 }] }), AuditLog.hashInputs({ b: [1, { c: 2 }], a: 1 }));
});

test("scrub redacts any credential-looking key at any depth", () => {
  const out = scrub({ Authorization: "Bearer x", nested: { jira_pat: "y", password: "z", ok: "keep" }, list: [{ token: "t" }] }) as any;
  assert.equal(out.Authorization, "<redacted>");
  assert.equal(out.nested.jira_pat, "<redacted>");
  assert.equal(out.nested.password, "<redacted>");
  assert.equal(out.nested.ok, "keep");
  assert.equal(out.list[0].token, "<redacted>");
});

test("audit log creates a missing parent directory instead of failing", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "audit-"));
  const file = path.join(dir, "nested", "deeper", "a.jsonl");
  const audit = new AuditLog(file);
  await audit.record({ ts: "t", traceId: "tr", principal: "p", tool: "jira_list_projects", tier: "read", inputsHash: AuditLog.hashInputs({}), inputKeys: [], outcome: "ok", durationMs: 1 });
  assert.ok((await readFile(file, "utf8")).includes("jira_list_projects"));
});
