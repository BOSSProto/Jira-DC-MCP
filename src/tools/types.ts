import type { z } from "zod";
import type { ToolTier } from "../core/audit.js";
import type { JiraClient } from "../services/jira-client.js";
import type { Config } from "../core/config.js";

export interface ToolContext {
  traceId: string;
  jira: JiraClient;
  config: Config;
}

export interface ToolDef<S extends z.ZodObject<z.ZodRawShape> = z.ZodObject<z.ZodRawShape>> {
  name: string;
  tier: ToolTier;
  /** Written for the model: when to call it, not just what it does. */
  description: string;
  inputSchema: S;
  annotations: { readOnlyHint: boolean; destructiveHint: boolean; idempotentHint: boolean; openWorldHint: boolean };
  handler: (args: z.infer<S>, ctx: ToolContext) => Promise<unknown>;
}

export const READ_ANNOTATIONS = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true } as const;
/** Additive writes (comment, create, parent): nothing existing is overwritten. */
export const WRITE_ADDITIVE = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true } as const;
/** Overwriting writes (field updates, transitions): the previous value or status is replaced. */
export const WRITE_DESTRUCTIVE = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true } as const;

/** Preserves the schema's inferred arg type inside the handler while storing tools in a plain ToolDef[]. */
export function tool<S extends z.ZodObject<z.ZodRawShape>>(def: ToolDef<S>): ToolDef {
  return def as unknown as ToolDef;
}
