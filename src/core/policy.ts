import type { Config } from "./config.js";
import { ToolError } from "./errors.js";
import type { ToolTier } from "./audit.js";

export interface ToolPolicyInfo {
  name: string;
  tier: ToolTier;
}

export class Policy {
  constructor(private readonly config: Config) {}

  /** Coarse gate (mode) then explicit deny (block list). Client annotations are the third layer and live on the tool. */
  isExposed(tool: ToolPolicyInfo): boolean {
    if (this.config.JIRA_MCP_DISABLED_TOOLS.includes(tool.name)) return false;
    if (tool.tier === "write" && this.config.JIRA_MCP_MODE !== "full") return false;
    return true;
  }

  /** Called at invocation time as well, so a tool hidden after startup still cannot run. */
  assertAllowed(tool: ToolPolicyInfo): void {
    if (this.config.JIRA_MCP_DISABLED_TOOLS.includes(tool.name)) {
      throw new ToolError("POLICY_BLOCKED", `${tool.name} is blocked by JIRA_MCP_DISABLED_TOOLS.`, { knob: "JIRA_MCP_DISABLED_TOOLS" });
    }
    if (tool.tier === "write" && this.config.JIRA_MCP_MODE !== "full") {
      throw new ToolError("POLICY_BLOCKED", `${tool.name} is a write tool and JIRA_MCP_MODE=${this.config.JIRA_MCP_MODE}. Set JIRA_MCP_MODE=full to enable writes.`, { knob: "JIRA_MCP_MODE" });
    }
  }

  /** Every write requires an explicit confirm flag so a model cannot write by accident while exploring. */
  assertConfirmed(tool: ToolPolicyInfo, confirm: boolean | undefined): void {
    if (tool.tier === "write" && confirm !== true) {
      throw new ToolError("CONFIRMATION_REQUIRED", `${tool.name} changes Jira. Re-call it with confirm: true after showing the user exactly what will change.`, { knob: "confirm" });
    }
  }
}
