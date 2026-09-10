import { test } from "node:test";
import assert from "node:assert/strict";
import { buildJql, createReadTools } from "../src/tools/reads.js";
import { jqlQuote } from "../src/tools/params.js";
import { testConfig } from "./helpers.js";

test("buildJql compiles a structured filter and escapes quotes", () => {
  const jql = buildJql({ projectKey: "XS", fixVersion: '2027.0.0 "GA"', statusCategory: "open", assignee: "me", updatedSince: "-7d", labels: ["a"], text: "crash" } as any, "updated DESC");
  assert.equal(jql, 'project = XS AND fixVersion = "2027.0.0 \\"GA\\"" AND statusCategory != Done AND assignee = currentUser() AND updated >= "-7d" AND labels = "a" AND text ~ "crash" ORDER BY updated DESC');
  assert.equal(jqlQuote('a"b\\c'), '"a\\"b\\\\c"');
  assert.throws(() => buildJql({ labels: [] } as any, "x"), /no criteria/);
});

test("release health is entirely count-based, complete on large releases, and names partial failures", async () => {
  const calls: string[] = [];
  const jira = {
    countIssues: async (_t: string, jql: string) => {
      calls.push(jql);
      if (jql.includes("subTaskIssueTypes")) return 40;
      if (jql.includes('issuetype = "Bug"')) return 528;
      if (jql.includes('issuetype = "Story"')) return 1200;
      if (jql.includes('issuetype = "Improvement"')) return 300;
      if (jql.includes('issuetype = "Epic"')) return 99;
      if (jql.endsWith("Done")) return 4207;
      if (jql.includes("To Do")) return 1769;
      if (jql.includes("In Progress")) return 498;
      return 6474;
    },
    search: async () => { throw new Error("search must not be called"); },
  } as any;
  const tool = createReadTools(100).find((t) => t.name === "jira_get_release_health")!;
  const out = (await tool.handler({ projectKey: "XS", fixVersion: "2027.0.0", openIssueTypes: ["Bug", "Story", "Improvement", "Epic"] } as never, { traceId: "t", jira, config: testConfig() })) as any;
  assert.equal(out.total, 6474);
  assert.deepEqual(out.byCategory, { todo: 1769, inProgress: 498, done: 4207 });
  assert.equal(out.percentDone, 65);
  assert.equal(out.openTotal, 2267);
  assert.deepEqual(out.openByType, { Bug: 528, Story: 1200, Improvement: 300, Epic: 99, subTasks: 40, other: 100 });
  assert.equal(out.complete, true);
  assert.deepEqual(out.partial, []);
  assert.equal(calls.length, 9);
  assert.ok(calls.every((c) => c.startsWith('project = XS AND fixVersion = "2027.0.0"')));

  const flaky = { ...jira, countIssues: async (_t: string, jql: string) => { if (jql.includes("In Progress")) throw new Error("boom"); return jira.countIssues(_t, jql); } } as any;
  const bad = (await tool.handler({ projectKey: "XS", fixVersion: "2027.0.0", openIssueTypes: ["Bug"] } as never, { traceId: "t", jira: flaky, config: testConfig() })) as any;
  assert.equal(bad.byCategory.inProgress, null);
  assert.equal(bad.openTotal, null);
  assert.equal(bad.openByType.other, null);
  assert.equal(bad.openByType.Bug, 528);
  assert.deepEqual(bad.partial, ["inProgress"]);
  assert.equal(bad.complete, false);
});

test("sprint health resolves board by unique name and picks the active sprint", async () => {
  const jira = {
    listBoards: async () => ({ values: [{ id: 7, name: "XSight Marvel", type: "scrum" }, { id: 9, name: "XSight Chat", type: "scrum" }] }),
    listSprints: async (_t: string, boardId: number, state?: string) => ({ values: state === "active" ? [{ id: 55, name: "Marvel 42", state: "active" }] : [] }),
    sprintIssues: async () => ({ total: 1, startAt: 0, maxResults: 100, issues: [{ id: "1", key: "XS-1", fields: { status: { name: "Open", statusCategory: { name: "To Do" } }, assignee: null, labels: ["blocked"] } }] }),
  } as any;
  const tool = createReadTools(100).find((t) => t.name === "jira_get_sprint_health")!;
  const out = (await tool.handler({ boardName: "marvel", maxResults: 100 } as never, { traceId: "t", jira, config: testConfig() })) as any;
  assert.deepEqual(out.sprint, { id: 55, name: "Marvel 42", board: { id: 7, name: "XSight Marvel" } });
  assert.deepEqual(out.unassigned, ["XS-1"]);
  assert.deepEqual(out.labelledBlocked, ["XS-1"]);
  await assert.rejects(() => tool.handler({ boardName: "xsight", maxResults: 100 } as never, { traceId: "t", jira, config: testConfig() }), /matches 2 boards/);
});
