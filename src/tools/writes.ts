import { z } from "zod";
import { WRITE_ADDITIVE, WRITE_DESTRUCTIVE, tool, type ToolDef } from "./types.js";
import { IssueKey, ProjectKey, FixVersionName } from "./params.js";
import { ToolError } from "../core/errors.js";

const confirm = z.boolean().default(false).describe("Must be true to execute. Show the user exactly what will change first, then call again with confirm: true.");

export function createWriteTools(): ToolDef[] {
  return [
    tool({
      name: "jira_write_comment",
      tier: "write",
      description: "Add a comment to an issue. Changes Jira (additive; nothing is overwritten). Draft the comment, show it to the user, then call with confirm: true.",
      inputSchema: z.object({ key: IssueKey, body: z.string().min(1).describe("Comment text in Jira wiki markup or plain text"), confirm }).strict(),
      annotations: WRITE_ADDITIVE,
      handler: async (a, ctx) => {
        const r = await ctx.jira.addComment(ctx.traceId, a.key, a.body);
        return { key: a.key, commentId: r.id, url: `${ctx.config.JIRA_BASE_URL}/browse/${a.key}` };
      },
    }),

    tool({
      name: "jira_write_transition",
      tier: "write",
      description:
        "Move an issue to a new status by transition name (e.g. 'Done', 'In Progress'). Changes Jira and replaces the current status. The name is resolved against the transitions available from the current status; if it doesn't match, the error lists the valid options. Call with confirm: true.",
      inputSchema: z
        .object({
          key: IssueKey,
          transitionName: z.string().min(1).describe("Transition name or target status name as shown in Jira, e.g. 'In Progress'"),
          comment: z.string().optional().describe("Optional comment recorded with the transition"),
          confirm,
        })
        .strict(),
      annotations: WRITE_DESTRUCTIVE,
      handler: async (a, ctx) => {
        const { transitions } = await ctx.jira.listTransitions(ctx.traceId, a.key);
        const q = a.transitionName.toLowerCase();
        const match = transitions.find((t) => t.name.toLowerCase() === q || t.to.name.toLowerCase() === q);
        if (!match) throw new ToolError("INVALID_INPUT", `No transition named '${a.transitionName}' from the current status of ${a.key}. Available: ${transitions.map((t) => `${t.name} -> ${t.to.name}`).join(", ")}`);
        await ctx.jira.transition(ctx.traceId, a.key, match.id, a.comment);
        return { key: a.key, transition: match.name, newStatus: match.to.name };
      },
    }),

    tool({
      name: "jira_write_issue",
      tier: "write",
      description:
        "Create a new issue. Changes Jira (additive). For Epics, the instance's 'Epic Name' custom field is discovered and filled automatically because Jira DC rejects epics without it. Pass instance-specific custom fields in extraFields using IDs from jira_list_fields. Call with confirm: true.",
      inputSchema: z
        .object({
          projectKey: ProjectKey,
          issueType: z.string().min(1).describe("Issue type name, e.g. Story, Bug, Epic"),
          summary: z.string().min(1).describe("Issue title"),
          description: z.string().optional().describe("Issue body in Jira wiki markup or plain text"),
          fixVersion: FixVersionName.optional(),
          components: z.array(z.string()).default([]).describe("Component names as shown in the project"),
          labels: z.array(z.string()).default([]).describe("Labels to apply"),
          extraFields: z.record(z.string(), z.unknown()).default({}).describe("Raw Jira field map merged last, e.g. { customfield_10206: { id: '14300' } }. IDs from jira_list_fields."),
          confirm,
        })
        .strict(),
      annotations: WRITE_ADDITIVE,
      handler: async (a, ctx) => {
        const fields: Record<string, unknown> = {
          project: { key: a.projectKey },
          issuetype: { name: a.issueType },
          summary: a.summary,
          ...(a.description ? { description: a.description } : {}),
          ...(a.fixVersion ? { fixVersions: [{ name: a.fixVersion }] } : {}),
          ...(a.components.length ? { components: a.components.map((name) => ({ name })) } : {}),
          ...(a.labels.length ? { labels: a.labels } : {}),
        };
        if (a.issueType.toLowerCase() === "epic") {
          const epicName = await ctx.jira.findFieldByName(ctx.traceId, "Epic Name");
          if (epicName && !(epicName.id in a.extraFields)) fields[epicName.id] = a.summary;
        }
        Object.assign(fields, a.extraFields);
        const r = await ctx.jira.createIssue(ctx.traceId, fields);
        return { key: r.key, id: r.id, url: `${ctx.config.JIRA_BASE_URL}/browse/${r.key}` };
      },
    }),

    tool({
      name: "jira_write_fields",
      tier: "write",
      description:
        "Set fields on an existing issue (summary, description, labels, fixVersions, assignee, priority, or custom fields by ID). Changes Jira and overwrites the previous values of those fields. Send only the fields that change. Call with confirm: true.",
      inputSchema: z
        .object({
          key: IssueKey,
          fields: z.record(z.string(), z.unknown()).describe("Jira field map, e.g. { summary: 'New title', assignee: { name: 'jdoe' } }. Custom field IDs from jira_list_fields."),
          confirm,
        })
        .strict(),
      annotations: WRITE_DESTRUCTIVE,
      handler: async (a, ctx) => {
        if (Object.keys(a.fields).length === 0) throw new ToolError("INVALID_INPUT", "fields is empty; nothing to update.");
        await ctx.jira.updateIssue(ctx.traceId, a.key, a.fields);
        return { key: a.key, updatedFields: Object.keys(a.fields) };
      },
    }),

    tool({
      name: "jira_write_move_to_epic",
      tier: "write",
      description:
        "Parent one or more issues under an epic using the Agile API, the reliable path on Jira DC (writing the Epic Link field directly is not). Changes Jira (additive to the epic; replaces an existing parent on the issue). Call with confirm: true.",
      inputSchema: z.object({ epicKey: IssueKey.describe("Epic issue key, e.g. PAY-900"), issueKeys: z.array(IssueKey).min(1).max(50).describe("Issues to move under the epic, up to 50"), confirm }).strict(),
      annotations: WRITE_ADDITIVE,
      handler: async (a, ctx) => {
        await ctx.jira.moveToEpic(ctx.traceId, a.epicKey, a.issueKeys);
        return { epicKey: a.epicKey, moved: a.issueKeys };
      },
    }),
  ];
}
