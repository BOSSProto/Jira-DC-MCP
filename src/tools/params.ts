import { z } from "zod";

export const IssueKey = z.string().regex(/^[A-Z][A-Z0-9_]*-\d+$/i, "Expected an issue key like PAY-1234").describe("Issue key, e.g. PAY-1234");

export const ProjectKey = z.string().regex(/^[A-Z][A-Z0-9_]*$/i, "Expected a project key like PAY").describe("Project key, e.g. PAY. Use jira_list_projects if unknown.");

export const FixVersionName = z.string().min(1).describe("Fix version name exactly as Jira shows it, e.g. 4.2.0. Use jira_list_versions to resolve it.");

export const ExtraFields = z
  .array(z.string())
  .default([])
  .describe("Additional Jira field IDs to include verbatim, e.g. ['customfield_10004']. Get IDs from jira_list_fields; never guess them.");

export const Id = z.number().int().positive().describe("Numeric Jira id");

/** Page size bound to JIRA_MAX_RESULTS_CAP at startup so the schema and the cap can't disagree. */
export const pageSize = (cap: number, dflt: number) =>
  z.number().int().min(1).max(cap).default(Math.min(dflt, cap)).describe(`Page size, 1 to ${cap} (the server's JIRA_MAX_RESULTS_CAP)`);

export const StartAt = z.number().int().nonnegative().default(0).describe("Zero-based offset for paging; use nextStartAt from the previous response");

/** Escape a value for use inside JQL double quotes. */
export function jqlQuote(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}
