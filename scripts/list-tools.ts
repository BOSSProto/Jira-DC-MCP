import { loadConfig, loadDotEnvIfPresent } from "../src/core/config.js";
import { Policy } from "../src/core/policy.js";
import { JiraClient } from "../src/services/jira-client.js";
import { createTools } from "../src/tools/factory.js";

// Prints the tool surface for the current configuration. No Jira calls.
loadDotEnvIfPresent();
const config = loadConfig();
const tools = createTools({ config, policy: new Policy(config), jira: new JiraClient(config), startedAt: Date.now() });
for (const t of tools) process.stdout.write(`${t.tier.padEnd(11)} ${t.name}\n`);
process.stdout.write(`\n${tools.length} tools exposed (mode=${config.JIRA_MCP_MODE})\n`);
