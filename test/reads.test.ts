import { test } from "node:test";
import assert from "node:assert/strict";
import { buildJql, createReadTools } from "../src/tools/reads.js";
import { jqlQuote } from "../src/tools/params.js";
import { testConfig } from "./helpers.js";

test("buildJql compiles a structured filter and escapes quotes", () => {
  const jql = buildJql({ projectKey: "PAY", fixVersion: '4.2.0 "GA"', statusCategory: "open", assignee: "me", updatedSince: "-7d", labels: ["a"], text: "crash" } as any, "updated DESC");
  assert.equal(jql, 'project = PAY AND fixVersion = "4.2.0 \\"GA\\"" AND statusCategory != Done AND assignee = currentUser() AND updated >= "-7d" AND labels = "a" AND text ~ "crash" ORDER BY updated DESC');
  assert.equal(jqlQuote('a"b\\c'), '"a\\"b\\\\c"');
  assert.throws(() => buildJql({ labels: [] } as any, "x"), /no criteria/);
});

test("release health is entirely count-based, complete on large releases, and names partial failures", async () => {
  const calls: string[] = [];
  const jira = {
    countIssues: async (_t: string, jql: string) => {
      calls.push(jql);
      if (jql.includes("subTaskIssueTypes")) return 35;
      if (jql.includes('issuetype = "Bug"')) return 410;
      if (jql.includes('issuetype = "Story"')) return 900;
      if (jql.includes('issuetype = "Improvement"')) return 260;
      if (jql.includes('issuetype = "Epic"')) return 80;
      if (jql.endsWith("Done")) return 3420;
      if (jql.includes("To Do")) return 1450;
      if (jql.includes("In Progress")) return 440;
      return 5310;
    },
    search: async () => { throw new Error("search must not be called"); },
  } as any;
  const tool = createReadTools(100).find((t) => t.name === "jira_get_release_health")!;
  const out = (await tool.handler({ projectKey: "PAY", fixVersion: "4.2.0", openIssueTypes: ["Bug", "Story", "Improvement", "Epic"] } as never, { traceId: "t", jira, config: testConfig() })) as any;
  assert.equal(out.total, 5310);
  assert.deepEqual(out.byCategory, { todo: 1450, inProgress: 440, done: 3420 });
  assert.equal(out.percentDone, 64.4);
  assert.equal(out.openTotal, 1890);
  assert.deepEqual(out.openByType, { Bug: 410, Story: 900, Improvement: 260, Epic: 80, subTasks: 35, other: 205 });
  assert.equal(out.complete, true);
  assert.deepEqual(out.partial, []);
  assert.equal(calls.length, 9);
  assert.ok(calls.every((c) => c.startsWith('project = PAY AND fixVersion = "4.2.0"')));

  const flaky = { ...jira, countIssues: async (_t: string, jql: string) => { if (jql.includes("In Progress")) throw new Error("boom"); return jira.countIssues(_t, jql); } } as any;
  const bad = (await tool.handler({ projectKey: "PAY", fixVersion: "4.2.0", openIssueTypes: ["Bug"] } as never, { traceId: "t", jira: flaky, config: testConfig() })) as any;
  assert.equal(bad.byCategory.inProgress, null);
  assert.equal(bad.openTotal, null);
  assert.equal(bad.openByType.other, null);
  assert.equal(bad.openByType.Bug, 410);
  assert.deepEqual(bad.partial, ["inProgress"]);
  assert.equal(bad.complete, false);
});

// A mock Agile boards endpoint with 55 boards across 3 pages, server-side partial name filter, isLast/total envelope.
function boardsMock(opts: { serverNameFilter?: boolean } = { serverNameFilter: true }) {
  const boards = Array.from({ length: 53 }, (_, i) => ({ id: i + 1, name: `Board ${String(i + 1).padStart(2, "0")}`, type: "scrum" }));
  boards.push({ id: 1106, name: "Payments - Team Orion", type: "scrum" }, { id: 900, name: "Payments Checkout", type: "kanban" });
  const calls: Array<Record<string, unknown>> = [];
  return {
    calls,
    listBoards: async (_t: string, o: { name?: string; startAt?: number; maxResults?: number }) => {
      calls.push(o);
      const filtered = opts.serverNameFilter && o.name ? boards.filter((b) => b.name.toLowerCase().includes(o.name!.toLowerCase())) : boards;
      const startAt = o.startAt ?? 0, max = Math.min(o.maxResults ?? 50, 20);
      const values = filtered.slice(startAt, startAt + max);
      return { values, startAt, maxResults: max, total: filtered.length, isLast: startAt + values.length >= filtered.length };
    },
    listSprints: async (_t: string, _b: number, o: { state?: string; startAt?: number }) => {
      const closed = Array.from({ length: 45 }, (_, i) => ({ id: 100 + i, name: `Orion ${i + 1}`, state: "closed" }));
      const byState: Record<string, any[]> = { active: [{ id: 555, name: "Orion 46", state: "active" }], future: [{ id: 556, name: "Orion 47", state: "future" }], closed };
      const list = o.state ? byState[o.state] : [...closed, ...byState.active, ...byState.future];
      const startAt = o.startAt ?? 0, values = list.slice(startAt, startAt + 20);
      return { values, startAt, maxResults: 20, isLast: startAt + values.length >= list.length };
    },
    sprintIssues: async () => ({ total: 1, startAt: 0, maxResults: 100, issues: [{ id: "1", key: "PAY-1", fields: { status: { name: "Open", statusCategory: { name: "To Do" } }, assignee: null, labels: ["blocked"] } }] }),
  } as any;
}
const health = () => createReadTools(100).find((t) => t.name === "jira_get_sprint_health")!;
const ctxFor = (jira: any) => ({ traceId: "t", jira, config: testConfig() });

test("board past page one is found via Jira's server-side name filter, case-insensitively", async () => {
  const jira = boardsMock();
  const out = (await health().handler({ boardName: "payments - team orion", maxResults: 100 } as never, ctxFor(jira))) as any;
  assert.deepEqual(out.sprint, { id: 555, name: "Orion 46", board: { id: 1106, name: "Payments - Team Orion" } });
  assert.equal(jira.calls[0].name, "payments - team orion");
});

test("falls back to a bounded full scan when the instance ignores the name filter", async () => {
  const jira = boardsMock({ serverNameFilter: false });
  const out = (await health().handler({ boardName: "Payments - Team Orion", maxResults: 100 } as never, ctxFor(jira))) as any;
  assert.equal(out.sprint.board.id, 1106);
  assert.ok(jira.calls.length >= 3, "walked past page one");
});

test("ambiguous names list up to 10 candidates with ids; missing names point to jira_list_boards without dumping the list", async () => {
  const jira = boardsMock();
  await assert.rejects(() => health().handler({ boardName: "payments", maxResults: 100 } as never, ctxFor(jira)), (e: any) => e.code === "INVALID_INPUT" && /matches 2 boards/.test(e.message) && /id 1106/.test(e.message));
  await assert.rejects(() => health().handler({ boardName: "nope", maxResults: 100 } as never, ctxFor(jira)), (e: any) => e.code === "NOT_FOUND" && /jira_list_boards/.test(e.message) && !/Board 01/.test(e.message));
});

test("sprintName is found among closed sprints by walking pages; active sprint is the default", async () => {
  const jira = boardsMock();
  const named = (await health().handler({ boardId: 1106, sprintName: "Orion 3", maxResults: 100 } as never, ctxFor(jira))) as any;
  assert.deepEqual([named.sprint.id, named.sprint.name], [102, "Orion 3"]);
  const active = (await health().handler({ boardId: 1106, maxResults: 100 } as never, ctxFor(jira))) as any;
  assert.equal(active.sprint.id, 555);
  assert.deepEqual(active.unassigned, ["PAY-1"]);
});

test("jira_list_boards reports Jira's total and paging, not the page length", async () => {
  const jira = boardsMock();
  const tool = createReadTools(100).find((t) => t.name === "jira_list_boards")!;
  const out = (await tool.handler({ nameContains: "board", startAt: 0, maxResults: 20 } as never, ctxFor(jira))) as any;
  assert.equal(out.total, 53);
  assert.equal(out.returned, 20);
  assert.equal(out.isLast, false);
  assert.equal(out.nextStartAt, 20);
});
