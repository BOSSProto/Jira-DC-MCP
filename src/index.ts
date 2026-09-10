#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig, loadDotEnvIfPresent, redactedConfig } from "./core/config.js";
import { AuditLog } from "./core/audit.js";
import { Policy } from "./core/policy.js";
import { JiraClient } from "./services/jira-client.js";
import { createTools, type FactoryDeps } from "./tools/factory.js";
import { ToolError, VERSION, SERVICE, log, newTraceId } from "./core/errors.js";

export function buildServer(deps: FactoryDeps & { audit: AuditLog }): McpServer {
  const server = new McpServer({ name: SERVICE, version: VERSION }, { capabilities: { tools: { listChanged: true } } });

  for (const tool of createTools(deps)) {
    server.registerTool(
      tool.name,
      { description: tool.description, inputSchema: tool.inputSchema, annotations: tool.annotations },
      async (args: Record<string, unknown>) => {
        const traceId = newTraceId();
        const started = Date.now();
        const base = { traceId, principal: deps.config.JIRA_MCP_PRINCIPAL, tool: tool.name, tier: tool.tier, inputsHash: AuditLog.hashInputs(args), inputKeys: Object.keys(args ?? {}) };
        log("tool.invocation", { traceId, tool: tool.name, tier: tool.tier, inputKeys: base.inputKeys });
        try {
          deps.policy.assertAllowed({ name: tool.name, tier: tool.tier });
          deps.policy.assertConfirmed({ name: tool.name, tier: tool.tier }, (args as { confirm?: boolean })?.confirm);
          const result = await tool.handler(args as never, { traceId, jira: deps.jira, config: deps.config });
          await deps.audit.record({ ...base, ts: new Date().toISOString(), outcome: "ok", durationMs: Date.now() - started });
          return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
        } catch (err) {
          const te = err instanceof ToolError ? err : new ToolError("UPSTREAM_ERROR", (err as Error).message);
          await deps.audit.record({ ...base, ts: new Date().toISOString(), outcome: "error", errorCode: te.code, durationMs: Date.now() - started });
          log("tool.error", { traceId, tool: tool.name, code: te.code, msg: te.message });
          return { isError: true, content: [{ type: "text" as const, text: JSON.stringify({ error: te.code, message: te.message, ...(te.details ? { details: te.details } : {}) }, null, 2) }] };
        }
      },
    );
  }
  return server;
}

async function main() {
  loadDotEnvIfPresent();
  const config = loadConfig();
  const deps = { config, policy: new Policy(config), jira: new JiraClient(config), audit: new AuditLog(config.JIRA_MCP_AUDIT_LOG), startedAt: Date.now() };
  const server = buildServer(deps);
  // The audit path is operator information: it goes to stderr at startup and never into tool output.
  log("server.start", { ...redactedConfig(config), auditLogPath: config.JIRA_MCP_AUDIT_LOG, toolCount: createTools(deps).length });
  await server.connect(new StdioServerTransport());
}

// Only start the transport when run directly; tests and scripts import buildServer.
if (process.argv[1] && /index\.js$/.test(process.argv[1])) {
  main().catch((err) => {
    process.stderr.write(`${(err as Error).message}\n`);
    process.exit(1);
  });
}
