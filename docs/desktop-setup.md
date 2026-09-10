# Desktop setup (Claude Desktop, Claude Code, Cursor)

1. Create a Jira DC personal access token: Profile → Personal Access Tokens → Create. Copy it once.
2. `npm install && npm run build` in the repo.
3. Add the server to your client config with `"command": "node"` and the absolute path to `dist/src/index.js` (see README for the JSON).
4. Set `JIRA_MCP_MODE=read-only` first. Run `jira_server_info`. Confirm `HEALTHY`.
5. Only after reads work, and only if you need writes: set `JIRA_MCP_MODE=full` and test `jira_write_comment` on a ticket in a sandbox project with `confirm: true`.
6. The audit log lands at `JIRA_MCP_AUDIT_LOG` (default `./jira-dc-mcp.audit.jsonl` relative to the working directory of the client). Point it somewhere you'll keep.
