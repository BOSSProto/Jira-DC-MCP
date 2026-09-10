import { z } from "zod";
import { createReadTools } from "./reads.js";
import { createWriteTools } from "./writes.js";
import { READ_ANNOTATIONS, type ToolDef } from "./types.js";
import { redactedConfig, type Config } from "../core/config.js";
import { VERSION } from "../core/errors.js";
import type { Policy } from "../core/policy.js";
import type { JiraClient } from "../services/jira-client.js";

export interface FactoryDeps {
  config: Config;
  policy: Policy;
  jira: JiraClient;
  startedAt: number;
}

/**
 * The only place the tool surface is assembled. Any transport (stdio today, HTTP later) must call this,
 * so the golden test in test/tools-list.test.ts derives its expected list from here and never from a mirror.
 */
export function createTools(deps: FactoryDeps): ToolDef[] {
  const all: ToolDef[] = [...createReadTools(deps.config.JIRA_MAX_RESULTS_CAP), ...createWriteTools(), serverInfoTool(deps)];
  return all.filter((t) => deps.policy.isExposed({ name: t.name, tier: t.tier }));
}

/** Everything in the factory regardless of policy, for diagnostics and tests. */
export function allToolNames(): Array<{ name: string; tier: ToolDef["tier"] }> {
  return [...createReadTools(100), ...createWriteTools()].map((t) => ({ name: t.name, tier: t.tier })).concat([{ name: "jira_server_info", tier: "diagnostics" }]);
}

function serverInfoTool(deps: FactoryDeps): ToolDef {
  return {
    name: "jira_server_info",
    tier: "diagnostics",
    description:
      "Report server version, mode, which tools are exposed vs hidden and why, auth method, target host, health, and uptime. Never returns credentials. Call this first in a new session, or when a tool you expected is missing.",
    inputSchema: z.object({ checkConnectivity: z.boolean().default(true).describe("Also call Jira /myself to verify auth") }).strict(),
    annotations: READ_ANNOTATIONS,
    handler: async (a, ctx) => {
      const exposed = new Set(createTools(deps).map((t) => t.name));
      const tools = allToolNames().map((t) => ({
        name: t.name,
        tier: t.tier,
        exposed: exposed.has(t.name),
        hiddenBy: exposed.has(t.name) ? null : deps.config.JIRA_MCP_DISABLED_TOOLS.includes(t.name) ? "JIRA_MCP_DISABLED_TOOLS" : t.tier === "write" ? "JIRA_MCP_MODE=read-only" : null,
      }));
      let health: { status: "HEALTHY" | "DEGRADED" | "UNHEALTHY"; detail: string } = { status: "HEALTHY", detail: "connectivity check skipped" };
      if (a.checkConnectivity) {
        try {
          const me = await ctx.jira.myself(ctx.traceId);
          health = { status: "HEALTHY", detail: `authenticated as ${me.displayName ?? me.name}` };
        } catch (err) {
          health = { status: "UNHEALTHY", detail: (err as Error).message };
        }
      }
      return { version: VERSION, ...redactedConfig(deps.config), uptimeSeconds: Math.round((Date.now() - deps.startedAt) / 1000), health, tools };
    },
  };
}
