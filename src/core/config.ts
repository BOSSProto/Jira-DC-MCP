import { z } from "zod";
import os from "node:os";

// Precedence: env vars > defaults. No CLI flags or YAML in v0.1 (see docs/backlog.md).
const ConfigSchema = z
  .object({
    JIRA_BASE_URL: z.string().url().transform((u) => u.replace(/\/+$/, "")),
    JIRA_AUTH_METHOD: z.enum(["pat", "basic"]).default("pat"),
    JIRA_PAT: z.string().optional(),
    JIRA_USERNAME: z.string().optional(),
    JIRA_PASSWORD: z.string().optional(),
    JIRA_MCP_MODE: z.enum(["read-only", "full"]).default("read-only"),
    JIRA_MCP_DISABLED_TOOLS: z
      .string()
      .default("")
      .transform((s) => s.split(",").map((t) => t.trim()).filter(Boolean)),
    JIRA_MCP_PRINCIPAL: z.string().default(() => safeUsername()),
    JIRA_MCP_AUDIT_LOG: z.string().default("./jira-dc-mcp.audit.jsonl"),
    JIRA_TIMEOUT_MS: z.coerce.number().int().min(1000).max(120000).default(15000),
    JIRA_MAX_RESULTS_CAP: z.coerce.number().int().min(1).max(1000).default(100),
  })
  .superRefine((c, ctx) => {
    if (c.JIRA_AUTH_METHOD === "pat" && !c.JIRA_PAT) {
      ctx.addIssue({ code: "custom", path: ["JIRA_PAT"], message: "JIRA_PAT is required when JIRA_AUTH_METHOD=pat" });
    }
    if (c.JIRA_AUTH_METHOD === "basic" && (!c.JIRA_USERNAME || !c.JIRA_PASSWORD)) {
      ctx.addIssue({ code: "custom", path: ["JIRA_USERNAME"], message: "JIRA_USERNAME and JIRA_PASSWORD are required when JIRA_AUTH_METHOD=basic" });
    }
  });

export type Config = z.infer<typeof ConfigSchema>;

function safeUsername(): string {
  try {
    return os.userInfo().username;
  } catch {
    return "unknown";
  }
}

const SECRET_KEYS = new Set(["JIRA_PAT", "JIRA_PASSWORD"]);

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const result = ConfigSchema.safeParse(env);
  if (result.success) return result.data;
  // Show the received value for every failing key except secrets; the error is the operator's first debug tool.
  const lines = result.error.issues.map((i) => {
    const key = String(i.path[0] ?? "");
    const received = SECRET_KEYS.has(key) ? "<redacted>" : JSON.stringify(env[key] ?? undefined);
    return `  ${key}: ${i.message} (received ${received})`;
  });
  const hint =
    dotEnvStatus === "missing"
      ? `No .env file was found in ${process.cwd()}. Copy .env.example to .env (the name must be exactly .env, not .env.txt) or set the variables in your shell or MCP client config.`
      : dotEnvStatus === "loaded"
        ? `A .env file was loaded from ${process.cwd()}; check the variable names in it.`
        : "Variables come from the MCP client config or the shell.";
  throw new Error(`Invalid configuration:\n${lines.join("\n")}\n${hint}\nSee .env.example for every supported variable.`);
}

/** A view of config that is safe to print anywhere (diagnostics, logs). */
export function redactedConfig(c: Config) {
  return {
    baseUrlHost: new URL(c.JIRA_BASE_URL).host,
    authMethod: c.JIRA_AUTH_METHOD,
    mode: c.JIRA_MCP_MODE,
    disabledTools: c.JIRA_MCP_DISABLED_TOOLS,
    principal: c.JIRA_MCP_PRINCIPAL,
    auditLog: "enabled" as const,
    timeoutMs: c.JIRA_TIMEOUT_MS,
    maxResultsCap: c.JIRA_MAX_RESULTS_CAP,
  };
}

let dotEnvStatus: "not-attempted" | "loaded" | "missing" = "not-attempted";

/** Load ./.env if present so `npm run smoke` and `npm run tools` work without exporting variables. Client configs pass env directly. */
export function loadDotEnvIfPresent(): boolean {
  try {
    process.loadEnvFile(".env");
    dotEnvStatus = "loaded";
    return true;
  } catch {
    dotEnvStatus = "missing";
    return false;
  }
}
