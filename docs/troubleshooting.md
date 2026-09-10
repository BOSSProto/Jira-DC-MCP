# Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Server shows "Running" in Claude Desktop but no tools | Stale `dist/` or Desktop didn't respawn | `npm run build`, fully quit and relaunch Claude Desktop |
| `jira_write_*` tools missing | `JIRA_MCP_MODE=read-only` (default) | Set `JIRA_MCP_MODE=full`; `jira_server_info` lists what's hidden and why |
| A tool returns `CONFIRMATION_REQUIRED` | Write called without `confirm: true` | Show the user the change, then call again with `confirm: true` |
| `SSO_REDIRECT` | Jira bounced the request to an SSO host; the PAT wasn't accepted | Regenerate the PAT; confirm the user has API access; try `JIRA_AUTH_METHOD=basic` with a service account |
| `AUTH_FAILED` (401/403) | Token expired, or the principal lacks project permission | Check the token and Browse Projects permission |
| `TIMEOUT` | Jira slower than `JIRA_TIMEOUT_MS` | Raise the value (max 120000) or narrow the JQL |
| Release health says `complete: false` | One of the count queries failed; `partial` names which (e.g. `openByType.Bug`) | Retry; if it persists, run that JQL by hand and check the type name exists on your instance |
| Release health `openByType.other` is large | Your instance uses type names outside the default set | Pass `openIssueTypes` with your names (see `jira_list_fields` won't help here; check the project's issue types) |
| `boardName` matches N boards | Substring hit more than one board | Use the exact name or pass `boardId` from the error message |
| Epic creation fails with a field error | Instance has no field named "Epic Name" or names it differently | `jira_list_fields nameContains:"epic"` and pass the ID in `extraFields` |
| "Python not found" on start | Another MCP's config uses `command: python` | This server's config must use `"command": "node"` |
