import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

// Opt-in end-to-end test: real stdio server against a mock Jira. Run with RUN_E2E_TESTS=1 npm test
const enabled = process.env.RUN_E2E_TESTS === "1";

async function mockJira(): Promise<{ url: string; close: () => void; calls: string[] }> {
  const calls: string[] = [];
  const server = http.createServer((req, res) => {
    calls.push(`${req.method} ${req.url}`);
    const send = (code: number, body: unknown) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(body)); };
    if (req.headers.authorization !== "Bearer test-token") return send(401, { error: "no" });
    const u = new URL(req.url ?? "/", "http://x");
    if (u.pathname === "/rest/api/2/myself") return send(200, { name: "rodi", displayName: "Rodi B" });
    if (u.pathname === "/rest/api/2/search") return send(200, { total: 1, startAt: 0, maxResults: 50, issues: [{ id: "1", key: "PAY-1", fields: { summary: "Hello", status: { name: "Open", statusCategory: { name: "To Do" } }, issuetype: { name: "Story" }, assignee: null, priority: { name: "High" }, fixVersions: [{ name: "4.2.0" }], updated: "2026-09-10" } }] });
    if (u.pathname === "/rest/api/2/issue/PAY-1/comment" && req.method === "POST") return send(201, { id: "42" });
    return send(404, {});
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as { port: number }).port;
  return { url: `http://127.0.0.1:${port}`, close: () => server.close(), calls };
}

async function connect(env: Record<string, string>) {
  const transport = new StdioClientTransport({ command: "node", args: [path.resolve("dist/src/index.js")], env: { ...process.env, ...env } as Record<string, string>, stderr: "ignore" });
  const client = new Client({ name: "e2e", version: "0.0.0" });
  await client.connect(transport);
  return client;
}

test("e2e: read-only server lists 12 tools and answers a search through the mock Jira", { skip: !enabled }, async () => {
  const jira = await mockJira();
  const audit = path.join(process.cwd(), "dist", "e2e.audit.jsonl");
  const client = await connect({ JIRA_BASE_URL: jira.url, JIRA_PAT: "test-token", JIRA_MCP_AUDIT_LOG: audit });
  try {
    const tools = await client.listTools();
    assert.equal(tools.tools.length, 12);
    assert.ok(!tools.tools.some((t) => t.name.startsWith("jira_write_")));
    const r = await client.callTool({ name: "jira_search_issues", arguments: { jql: "project = PAY" } });
    const text = (r.content as Array<{ text: string }>)[0].text;
    assert.ok(text.includes('"key": "PAY-1"'));
    assert.ok(jira.calls.some((c) => c.startsWith("GET /rest/api/2/search?")), "search must use GET");
    const info = await client.callTool({ name: "jira_server_info", arguments: {} });
    const infoText = (info.content as Array<{ text: string }>)[0].text;
    assert.ok(infoText.includes('"status": "HEALTHY"'));
    assert.ok(!infoText.includes("test-token"));
  } finally {
    await client.close();
    jira.close();
  }
});

test("e2e: full mode exposes writes, refuses without confirm, writes with confirm", { skip: !enabled }, async () => {
  const jira = await mockJira();
  const client = await connect({ JIRA_BASE_URL: jira.url, JIRA_PAT: "test-token", JIRA_MCP_MODE: "full", JIRA_MCP_AUDIT_LOG: path.join(process.cwd(), "dist", "e2e.audit.jsonl") });
  try {
    const tools = await client.listTools();
    assert.equal(tools.tools.length, 17);
    const refused = await client.callTool({ name: "jira_write_comment", arguments: { key: "PAY-1", body: "hi" } });
    assert.equal(refused.isError, true);
    assert.ok((refused.content as Array<{ text: string }>)[0].text.includes("CONFIRMATION_REQUIRED"));
    assert.ok(!jira.calls.some((c) => c.startsWith("POST")), "no write reached Jira without confirm");
    const ok = await client.callTool({ name: "jira_write_comment", arguments: { key: "PAY-1", body: "hi", confirm: true } });
    assert.notEqual(ok.isError, true);
    assert.ok((ok.content as Array<{ text: string }>)[0].text.includes('"commentId": "42"'));
  } finally {
    await client.close();
    jira.close();
  }
});
