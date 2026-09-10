import { loadConfig, loadDotEnvIfPresent } from "../src/core/config.js";
import { JiraClient } from "../src/services/jira-client.js";
import { newTraceId } from "../src/core/errors.js";

// Read-only smoke test against a live Jira DC. Never writes. Run: npm run smoke
loadDotEnvIfPresent();
const config = loadConfig();
const jira = new JiraClient(config);
const traceId = newTraceId();
const me = await jira.myself(traceId);
process.stdout.write(`auth ok: ${me.displayName ?? me.name}\n`);
const projects = await jira.listProjects(traceId);
process.stdout.write(`projects visible: ${projects.length}\n`);
const fields = await jira.listFields(traceId);
const epicName = fields.find((f) => f.name.toLowerCase() === "epic name");
process.stdout.write(`fields: ${fields.length}; Epic Name field: ${epicName?.id ?? "not found"}\n`);
const r = await jira.search(traceId, "updated >= -7d ORDER BY updated DESC", { fields: ["summary", "status"], maxResults: 3 });
process.stdout.write(`search ok: ${r.total} issues updated in 7d; first: ${r.issues[0]?.key ?? "none"}\n`);
