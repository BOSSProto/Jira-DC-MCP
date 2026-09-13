import { z } from "zod";
import { READ_ANNOTATIONS, tool, type ToolDef, type ToolContext } from "./types.js";
import { IssueKey, ProjectKey, FixVersionName, ExtraFields, Id, pageSize, StartAt, jqlQuote } from "./params.js";
import { ToolError } from "../core/errors.js";
import { settleLimit } from "../core/parallel.js";
import type { JiraIssue, AgilePage, Board, Sprint } from "../services/jira-client.js";

const DEFAULT_ISSUE_FIELDS = ["summary", "status", "issuetype", "assignee", "priority", "fixVersions", "updated"];

/** Trim a raw issue to the fields a PM asks about, so a 50-issue result stays inside the context budget. */
function slim(issue: JiraIssue) {
  const f = issue.fields;
  const pick = (v: unknown) => (v && typeof v === "object" && "name" in (v as object) ? (v as { name: string }).name : (v ?? null));
  return {
    key: issue.key,
    summary: f.summary ?? null,
    status: pick(f.status),
    type: pick(f.issuetype),
    assignee: f.assignee ? ((f.assignee as { displayName?: string }).displayName ?? null) : null,
    priority: pick(f.priority),
    fixVersions: Array.isArray(f.fixVersions) ? (f.fixVersions as Array<{ name: string }>).map((v) => v.name) : [],
    updated: f.updated ?? null,
  };
}

function detail(issue: JiraIssue, baseUrl: string, extraFields: string[]) {
  const f = issue.fields;
  return {
    ...slim(issue),
    description: f.description ?? null,
    labels: f.labels ?? [],
    components: Array.isArray(f.components) ? (f.components as Array<{ name: string }>).map((c) => c.name) : [],
    reporter: f.reporter ? ((f.reporter as { displayName?: string }).displayName ?? null) : null,
    created: f.created ?? null,
    links: Array.isArray(f.issuelinks)
      ? (f.issuelinks as Array<Record<string, any>>).map((l) => ({ type: l.type?.name, direction: l.outwardIssue ? "outward" : "inward", key: l.outwardIssue?.key ?? l.inwardIssue?.key }))
      : [],
    extra: Object.fromEntries(extraFields.map((k) => [k, f[k] ?? null])),
    url: `${baseUrl}/browse/${issue.key}`,
  };
}

function tallyByStatus(issues: JiraIssue[]) {
  const byStatus: Record<string, number> = {};
  const byCategory: Record<string, number> = { "To Do": 0, "In Progress": 0, Done: 0 };
  for (const i of issues) {
    const status = i.fields.status as { name?: string; statusCategory?: { name?: string } } | undefined;
    const name = status?.name ?? "Unknown";
    byStatus[name] = (byStatus[name] ?? 0) + 1;
    const cat = status?.statusCategory?.name ?? "Unknown";
    byCategory[cat] = (byCategory[cat] ?? 0) + 1;
  }
  return { byStatus, byCategory };
}

// ---------- Structured search filter → JQL ----------

export const SearchFilter = z
  .object({
    projectKey: ProjectKey.optional(),
    fixVersion: FixVersionName.optional(),
    issueType: z.string().optional().describe("Issue type name, e.g. Bug, Story, Epic"),
    statusCategory: z.enum(["todo", "inProgress", "done", "open"]).optional().describe("Jira status category; 'open' means not Done"),
    assignee: z.string().optional().describe("Jira username, or 'me' for the configured principal, or 'unassigned'"),
    updatedSince: z.string().optional().describe("Relative or absolute date accepted by JQL, e.g. -7d, -2w, 2026-09-01"),
    labels: z.array(z.string()).default([]).describe("All listed labels must be present"),
    text: z.string().optional().describe("Free text matched against summary and description"),
  })
  .strict();

export function buildJql(filter: z.infer<typeof SearchFilter>, orderBy: string): string {
  const clauses: string[] = [];
  if (filter.projectKey) clauses.push(`project = ${filter.projectKey}`);
  if (filter.fixVersion) clauses.push(`fixVersion = ${jqlQuote(filter.fixVersion)}`);
  if (filter.issueType) clauses.push(`issuetype = ${jqlQuote(filter.issueType)}`);
  if (filter.statusCategory) {
    const map = { todo: 'statusCategory = "To Do"', inProgress: 'statusCategory = "In Progress"', done: "statusCategory = Done", open: "statusCategory != Done" };
    clauses.push(map[filter.statusCategory]);
  }
  if (filter.assignee === "me") clauses.push("assignee = currentUser()");
  else if (filter.assignee === "unassigned") clauses.push("assignee is EMPTY");
  else if (filter.assignee) clauses.push(`assignee = ${jqlQuote(filter.assignee)}`);
  if (filter.updatedSince) clauses.push(`updated >= ${jqlQuote(filter.updatedSince)}`);
  for (const l of filter.labels) clauses.push(`labels = ${jqlQuote(l)}`);
  if (filter.text) clauses.push(`text ~ ${jqlQuote(filter.text)}`);
  if (clauses.length === 0) throw new ToolError("INVALID_INPUT", "filter has no criteria; provide at least one field or pass jql.");
  return `${clauses.join(" AND ")} ORDER BY ${orderBy}`;
}

// ---------- Board / sprint resolution ----------

/** Hard cap on pages walked while resolving a name; Jira's own `name` filter makes more than a page rare. */
const MAX_RESOLVE_PAGES = 10;

async function walkPages<T>(ctx: ToolContext, fetchPage: (startAt: number) => Promise<AgilePage<T>>, stopWhen?: (acc: T[]) => boolean): Promise<T[]> {
  const acc: T[] = [];
  let startAt = 0;
  for (let page = 0; page < MAX_RESOLVE_PAGES; page++) {
    const r = await fetchPage(startAt);
    acc.push(...r.values);
    if (r.isLast || r.values.length === 0 || (stopWhen && stopWhen(acc))) break;
    startAt += r.values.length;
  }
  return acc;
}

function pickByName<T extends { id: number; name: string }>(candidates: T[], query: string): T[] {
  const q = query.toLowerCase();
  const exact = candidates.filter((c) => c.name.toLowerCase() === q);
  return exact.length ? exact : candidates.filter((c) => c.name.toLowerCase().includes(q));
}

function ambiguous(kind: string, query: string, matches: Array<{ id: number; name: string }>, idParam: string): never {
  const shown = matches.slice(0, 10).map((m) => `${m.name} (id ${m.id})`).join(", ");
  throw new ToolError("INVALID_INPUT", `'${query}' matches ${matches.length} ${kind}s: ${shown}${matches.length > 10 ? ", ..." : ""}. Pass ${idParam} or a more specific name.`);
}

async function resolveBoard(ctx: ToolContext, boardId?: number, boardName?: string): Promise<{ id: number; name: string | null }> {
  if (boardId) return { id: boardId, name: null };
  if (!boardName) throw new ToolError("INVALID_INPUT", "Provide boardId or boardName. Use jira_list_boards to see boards.");
  const cap = ctx.config.JIRA_MAX_RESULTS_CAP;
  // Server-side match first (Jira filters by partial name), walking pages on isLast.
  let found = pickByName(await walkPages<Board>(ctx, (startAt) => ctx.jira.listBoards(ctx.traceId, { name: boardName, startAt, maxResults: cap })), boardName);
  // Fallback: some instances ignore or case-fold `name` differently; scan without the filter, bounded, and stop as soon as something matches.
  if (found.length === 0) {
    const all = await walkPages<Board>(ctx, (startAt) => ctx.jira.listBoards(ctx.traceId, { startAt, maxResults: cap }), (acc) => pickByName(acc, boardName).length > 0);
    found = pickByName(all, boardName);
  }
  if (found.length === 1) return { id: found[0].id, name: found[0].name };
  if (found.length === 0) throw new ToolError("NOT_FOUND", `No board matches '${boardName}'. Try jira_list_boards with nameContains or projectKey, then pass boardId.`);
  return ambiguous("board", boardName, found, "boardId");
}

async function resolveSprint(ctx: ToolContext, a: { sprintId?: number; sprintName?: string; boardId?: number; boardName?: string }) {
  if (a.sprintId) return { id: a.sprintId, name: null as string | null, board: null as { id: number; name: string | null } | null };
  const board = await resolveBoard(ctx, a.boardId, a.boardName);
  const cap = ctx.config.JIRA_MAX_RESULTS_CAP;
  if (a.sprintName) {
    // No server-side name filter on sprints: check active and future first (small), then walk closed sprints until a match.
    const recent = await walkPages<Sprint>(ctx, (startAt) => ctx.jira.listSprints(ctx.traceId, board.id, { state: "active", startAt, maxResults: cap }));
    const future = await walkPages<Sprint>(ctx, (startAt) => ctx.jira.listSprints(ctx.traceId, board.id, { state: "future", startAt, maxResults: cap }));
    let found = pickByName([...recent, ...future], a.sprintName);
    if (found.length === 0) {
      const closed = await walkPages<Sprint>(ctx, (startAt) => ctx.jira.listSprints(ctx.traceId, board.id, { state: "closed", startAt, maxResults: cap }), (acc) => pickByName(acc, a.sprintName!).length > 0);
      found = pickByName(closed, a.sprintName);
    }
    if (found.length === 1) return { id: found[0].id, name: found[0].name, board };
    if (found.length === 0) throw new ToolError("NOT_FOUND", `No sprint on board ${board.name ?? board.id} matches '${a.sprintName}'. Try jira_list_sprints with state, then pass sprintId.`);
    return ambiguous("sprint", a.sprintName, found, "sprintId");
  }
  const active = await ctx.jira.listSprints(ctx.traceId, board.id, { state: "active", maxResults: 5 });
  if (active.values.length === 0) throw new ToolError("NOT_FOUND", `Board ${board.name ?? board.id} has no active sprint. Pass sprintName or sprintId.`);
  return { id: active.values[0].id, name: active.values[0].name, board };
}

function envelope<T>(r: AgilePage<T>, key: string, items: unknown[]) {
  return { total: r.total ?? null, startAt: r.startAt, returned: items.length, isLast: r.isLast, nextStartAt: r.isLast ? null : r.startAt + r.values.length, [key]: items };
}

// ---------- Tools ----------

export function createReadTools(cap: number): ToolDef[] {
  return [
    tool({
      name: "jira_search_issues",
      tier: "read",
      description:
        "Find issues and return a compact list (key, summary, status, type, assignee, priority, fixVersions, updated). Use for any question that maps to a filter: 'what is open in 4.2', 'my bugs updated this week', 'unassigned stories in PAY'. Pass either raw jql or a structured filter, not both. Results are paged; pass startAt from nextStartAt to continue. For one known ticket use jira_get_issue.",
      inputSchema: z
        .object({
          jql: z.string().min(1).optional().describe("Raw Jira Query Language, e.g. project = PAY AND fixVersion = '4.2.0' AND status != Done"),
          filter: SearchFilter.optional().describe("Structured criteria compiled to JQL; safer than raw JQL for common questions"),
          orderBy: z.string().default("updated DESC").describe("JQL ORDER BY clause used with filter; ignored when jql is given"),
          startAt: StartAt,
          maxResults: pageSize(cap, 50),
          extraFields: ExtraFields,
        })
        .strict(),
      annotations: READ_ANNOTATIONS,
      handler: async (a, ctx) => {
        if (a.jql && a.filter) throw new ToolError("INVALID_INPUT", "Pass jql or filter, not both.");
        if (!a.jql && !a.filter) throw new ToolError("INVALID_INPUT", "Pass jql or filter.");
        const jql = a.jql ?? buildJql(a.filter!, a.orderBy);
        const r = await ctx.jira.search(ctx.traceId, jql, { fields: [...DEFAULT_ISSUE_FIELDS, ...a.extraFields], startAt: a.startAt, maxResults: a.maxResults });
        return {
          jql,
          total: r.total,
          startAt: r.startAt,
          returned: r.issues.length,
          nextStartAt: r.startAt + r.issues.length < r.total ? r.startAt + r.issues.length : null,
          issues: r.issues.map((i) => ({ ...slim(i), ...(a.extraFields.length ? { extra: Object.fromEntries(a.extraFields.map((k) => [k, i.fields[k] ?? null])) } : {}) })),
        };
      },
    }),

    tool({
      name: "jira_get_issue",
      tier: "read",
      description: "Fetch one issue by key with description, labels, components, links and dates. Use when the user names a ticket. For the ticket plus its comments and epic in one call, use jira_get_issue_context. For lists, use jira_search_issues.",
      inputSchema: z.object({ key: IssueKey, extraFields: ExtraFields }).strict(),
      annotations: READ_ANNOTATIONS,
      handler: async (a, ctx) => {
        const fields = [...DEFAULT_ISSUE_FIELDS, "description", "labels", "components", "issuelinks", "created", "reporter", ...a.extraFields];
        return detail(await ctx.jira.getIssue(ctx.traceId, a.key, fields), ctx.config.JIRA_BASE_URL, a.extraFields);
      },
    }),

    tool({
      name: "jira_get_issue_context",
      tier: "read",
      description:
        "Everything needed to act on one ticket in a single call: the issue, its most recent comments, its links, and its parent epic (key, summary, status). Use before drafting a reply, a status update, or a transition. If a part fails, the response still returns the rest and lists what's missing in partial.",
      inputSchema: z.object({ key: IssueKey, maxComments: pageSize(Math.min(cap, 50), 10).describe("How many of the newest comments to include"), extraFields: ExtraFields }).strict(),
      annotations: READ_ANNOTATIONS,
      handler: async (a, ctx) => {
        const epicLinkField = await ctx.jira.findFieldByName(ctx.traceId, "Epic Link").catch(() => undefined);
        const fields = [...DEFAULT_ISSUE_FIELDS, "description", "labels", "components", "issuelinks", "created", "reporter", "parent", ...(epicLinkField ? [epicLinkField.id] : []), ...a.extraFields];
        type Part = { kind: "issue"; issue: JiraIssue } | { kind: "comments"; comments: Array<Record<string, unknown>> };
        const [issueR, commentsR] = await settleLimit<Part>(ctx.traceId, [
          async () => ({ kind: "issue", issue: await ctx.jira.getIssue(ctx.traceId, a.key, fields) }),
          async () => ({ kind: "comments", comments: (await ctx.jira.listComments(ctx.traceId, a.key, a.maxComments)).comments }),
        ]);
        if (issueR.status === "rejected") throw issueR.reason;
        const issue = (issueR.value as { kind: "issue"; issue: JiraIssue }).issue;
        const partial: string[] = [];
        const comments = commentsR.status === "fulfilled" ? (commentsR.value as { kind: "comments"; comments: Array<Record<string, unknown>> }).comments.map((c) => ({ id: c.id, author: (c.author as { displayName?: string })?.displayName ?? null, created: c.created, body: c.body })) : (partial.push("comments"), []);
        const parent = issue.fields.parent as { key?: string } | undefined;
        const epicKey = (epicLinkField ? (issue.fields[epicLinkField.id] as string | undefined) : undefined) ?? parent?.key;
        let epic: { key: string; summary: unknown; status: unknown } | null = null;
        if (epicKey) {
          try {
            const e = await ctx.jira.getIssue(ctx.traceId, epicKey, ["summary", "status"]);
            epic = { key: e.key, summary: e.fields.summary ?? null, status: (e.fields.status as { name?: string })?.name ?? null };
          } catch {
            partial.push("epic");
            epic = { key: epicKey, summary: null, status: null };
          }
        }
        return { issue: detail(issue, ctx.config.JIRA_BASE_URL, a.extraFields), comments, epic, partial };
      },
    }),

    tool({
      name: "jira_list_issue_comments",
      tier: "read",
      description: "Return the newest comments on an issue. Use for 'what's the latest on X' when you already have the issue; otherwise jira_get_issue_context gets both at once.",
      inputSchema: z.object({ key: IssueKey, maxResults: pageSize(Math.min(cap, 100), 10) }).strict(),
      annotations: READ_ANNOTATIONS,
      handler: async (a, ctx) => {
        const r = await ctx.jira.listComments(ctx.traceId, a.key, a.maxResults);
        return { total: r.total, comments: r.comments.map((c) => ({ id: c.id, author: (c.author as { displayName?: string })?.displayName ?? null, created: c.created, body: c.body })) };
      },
    }),

    tool({
      name: "jira_list_projects",
      tier: "read",
      description: "List projects visible to the configured principal, with keys. Call first when you don't know the project key.",
      inputSchema: z.object({}).strict(),
      annotations: READ_ANNOTATIONS,
      handler: async (_a, ctx) => {
        const projects = (await ctx.jira.listProjects(ctx.traceId)).map((p) => ({ key: p.key, name: p.name, id: p.id }));
        return { total: projects.length, projects };
      },
    }),

    tool({
      name: "jira_list_versions",
      tier: "read",
      description: "List fix versions (releases) for a project. Defaults to unreleased, unarchived versions so a release name like '4.2.0' resolves quickly; widen with released: 'all' for history.",
      inputSchema: z
        .object({
          projectKey: ProjectKey,
          released: z.enum(["unreleased", "released", "all"]).default("unreleased").describe("Which versions to include"),
          includeArchived: z.boolean().default(false).describe("Include archived versions"),
          nameContains: z.string().optional().describe("Case-insensitive substring filter on the version name"),
        })
        .strict(),
      annotations: READ_ANNOTATIONS,
      handler: async (a, ctx) => {
        const q = a.nameContains?.toLowerCase();
        const versions = (await ctx.jira.listVersions(ctx.traceId, a.projectKey))
          .filter((v) => a.includeArchived || !v.archived)
          .filter((v) => a.released === "all" || (a.released === "released") === v.released)
          .filter((v) => !q || v.name.toLowerCase().includes(q))
          .map((v) => ({ id: v.id, name: v.name, released: v.released, archived: v.archived, releaseDate: v.releaseDate ?? null }));
        return { total: versions.length, versions };
      },
    }),

    tool({
      name: "jira_get_release_health",
      tier: "read",
      description:
        "One-call release status for a fix version, entirely from exact count queries: total, counts by status category (To Do, In Progress, Done), percent done, and open issues by type (a configurable set plus sub-tasks and a remainder). Always complete regardless of release size; if any count fails it is null and named in partial. Use for 'how is 4.2 tracking' or a release readout.",
      inputSchema: z
        .object({
          projectKey: ProjectKey,
          fixVersion: FixVersionName,
          openIssueTypes: z
            .array(z.string().min(1))
            .min(1)
            .max(8)
            .default(["Bug", "Story", "Improvement", "Epic"])
            .describe("Issue type names to count among open issues; sub-tasks are always counted as one aggregate and anything else lands in 'other'"),
        })
        .strict(),
      annotations: READ_ANNOTATIONS,
      handler: async (a, ctx) => {
        const base = `project = ${a.projectKey} AND fixVersion = ${jqlQuote(a.fixVersion)}`;
        const open = `${base} AND statusCategory != Done`;
        const queries: Array<[string, string]> = [
          ["total", base],
          ["todo", `${base} AND statusCategory = "To Do"`],
          ["inProgress", `${base} AND statusCategory = "In Progress"`],
          ["done", `${base} AND statusCategory = Done`],
          ...a.openIssueTypes.map((t): [string, string] => [`openByType.${t}`, `${open} AND issuetype = ${jqlQuote(t)}`]),
          ["openByType.subTasks", `${open} AND issuetype in subTaskIssueTypes()`],
        ];
        const results = await settleLimit(ctx.traceId, queries.map(([, jql]) => () => ctx.jira.countIssues(ctx.traceId, jql)));
        const partial: string[] = [];
        const value = (i: number): number | null => (results[i].status === "fulfilled" ? (results[i] as PromiseFulfilledResult<number>).value : (partial.push(queries[i][0]), null));
        const total = value(0);
        const byCategory = { todo: value(1), inProgress: value(2), done: value(3) };
        const openByType: Record<string, number | null> = {};
        for (let i = 4; i < queries.length; i++) openByType[queries[i][0].slice("openByType.".length)] = value(i);
        const openTotal = byCategory.todo !== null && byCategory.inProgress !== null ? byCategory.todo + byCategory.inProgress : null;
        const typed = Object.values(openByType);
        openByType.other = openTotal !== null && typed.every((v) => v !== null) ? Math.max(0, openTotal - typed.reduce((s, v) => s + (v as number), 0)) : null;
        const percentDone = total && byCategory.done !== null ? Math.round((byCategory.done / total) * 1000) / 10 : null;
        return { fixVersion: a.fixVersion, total, byCategory, percentDone, openTotal, openByType, complete: partial.length === 0, partial };
      },
    }),

    tool({
      name: "jira_list_boards",
      tier: "read",
      description: "List Agile boards, filtered server-side by project or name substring, paged. Use when jira_get_sprint_health's boardName lookup reports an ambiguous or missing board, then pass the boardId it returns.",
      inputSchema: z
        .object({
          projectKey: ProjectKey.optional(),
          nameContains: z.string().optional().describe("Substring matched by Jira against the board name"),
          startAt: StartAt,
          maxResults: pageSize(cap, 20),
        })
        .strict(),
      annotations: READ_ANNOTATIONS,
      handler: async (a, ctx) => {
        const r = await ctx.jira.listBoards(ctx.traceId, { projectKey: a.projectKey, name: a.nameContains, startAt: a.startAt, maxResults: a.maxResults });
        return envelope(r, "boards", r.values.map((b) => ({ id: b.id, name: b.name, type: b.type })));
      },
    }),

    tool({
      name: "jira_list_sprints",
      tier: "read",
      description: "List sprints for a board (by id or name) filtered by state, paged. Use to find a sprint id or see upcoming sprints; for the current sprint's status go straight to jira_get_sprint_health.",
      inputSchema: z
        .object({
          boardId: Id.optional().describe("Board id from jira_list_boards"),
          boardName: z.string().optional().describe("Board name or unique substring; resolved server-side"),
          state: z.enum(["active", "future", "closed"]).optional().describe("Sprint state filter; omit for all"),
          startAt: StartAt,
          maxResults: pageSize(cap, 20),
        })
        .strict(),
      annotations: READ_ANNOTATIONS,
      handler: async (a, ctx) => {
        const board = await resolveBoard(ctx, a.boardId, a.boardName);
        const r = await ctx.jira.listSprints(ctx.traceId, board.id, { state: a.state, startAt: a.startAt, maxResults: a.maxResults });
        return { board, ...envelope(r, "sprints", r.values.map((s) => ({ id: s.id, name: s.name, state: s.state, startDate: s.startDate ?? null, endDate: s.endDate ?? null, goal: s.goal ?? null }))) };
      },
    }),

    tool({
      name: "jira_get_sprint_health",
      tier: "read",
      description:
        "One-call sprint readout: counts by status and category, unassigned items, and items labelled blocked. Resolves the sprint for you: pass boardName (or boardId) and it uses the active sprint; add sprintName for a specific one; or pass sprintId directly. Use for standups or 'how is the sprint going'.",
      inputSchema: z
        .object({
          sprintId: Id.optional().describe("Sprint id; skips board resolution"),
          sprintName: z.string().optional().describe("Sprint name or unique substring on the board; omit for the active sprint"),
          boardId: Id.optional().describe("Board id"),
          boardName: z.string().optional().describe("Board name or unique substring"),
          maxResults: pageSize(cap, cap),
        })
        .strict(),
      annotations: READ_ANNOTATIONS,
      handler: async (a, ctx) => {
        const sprint = await resolveSprint(ctx, a);
        const r = await ctx.jira.sprintIssues(ctx.traceId, sprint.id, ["status", "issuetype", "summary", "assignee", "priority", "labels"], a.maxResults);
        const tally = tallyByStatus(r.issues);
        const unassigned = r.issues.filter((i) => !i.fields.assignee).map((i) => i.key);
        const labelledBlocked = r.issues.filter((i) => Array.isArray(i.fields.labels) && (i.fields.labels as string[]).some((l) => /block/i.test(l))).map((i) => i.key);
        return { sprint, total: r.total, counted: r.issues.length, complete: r.issues.length >= r.total, ...tally, unassigned, labelledBlocked };
      },
    }),

    tool({
      name: "jira_list_fields",
      tier: "read",
      description:
        "List field definitions including custom field IDs, optionally filtered by name substring. Call before reading or writing any custom field (Epic Name, Team, Story Points): IDs differ per Jira instance and must never be hardcoded.",
      inputSchema: z.object({ nameContains: z.string().optional().describe("Case-insensitive substring filter on field name"), customOnly: z.boolean().default(false).describe("Only custom fields") }).strict(),
      annotations: READ_ANNOTATIONS,
      handler: async (a, ctx) => {
        const q = a.nameContains?.toLowerCase();
        const fields = (await ctx.jira.listFields(ctx.traceId)).filter((f) => (!a.customOnly || f.custom) && (!q || f.name.toLowerCase().includes(q))).map((f) => ({ id: f.id, name: f.name, custom: f.custom, type: f.schema?.type ?? null }));
        return { total: fields.length, fields };
      },
    }),
  ];
}
