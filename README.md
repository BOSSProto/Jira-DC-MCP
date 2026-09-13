# jira-dc-mcp

An MCP server for Jira Data Center that is read-only by default, explicit about writes, and audits every call.

I'm a product manager. I live in Jira, and I wanted my assistant to see what I see: sprint health, release readiness, what changed on a ticket since yesterday. The first version I built (44 tools, private) taught me what a Jira MCP gets wrong when you build it fast. This is the rewrite.

## What it does

Seventeen tools over Jira DC's REST and Agile APIs, in three tiers:

| Tier | Tools | Exposed when |
|---|---|---|
| read | `jira_search_issues`, `jira_get_issue`, `jira_get_issue_context`, `jira_list_issue_comments`, `jira_list_projects`, `jira_list_versions`, `jira_get_release_health`, `jira_list_boards`, `jira_list_sprints`, `jira_get_sprint_health`, `jira_list_fields` | always |
| diagnostics | `jira_server_info` | always |
| write | `jira_write_comment`, `jira_write_transition`, `jira_write_issue`, `jira_write_fields`, `jira_write_move_to_epic` | `JIRA_MCP_MODE=full` |

The one-call readouts are the reason this exists. `jira_get_release_health` answers "how is 4.2 tracking" with exact counts. `jira_get_sprint_health` takes a board name and finds the active sprint itself. `jira_get_issue_context` returns the ticket, its comments, its links and its epic together, so "draft a reply on PAY-4821" is one call, not three. `jira_search_issues` takes a structured filter (project, version, status category, assignee, updated-since, text) as well as raw JQL, because raw JQL is where other people's calls fail.

## Design notes

These are the decisions, and what each one costs.

**Read by default.** The server starts in `read-only` mode and the five write tools don't appear in `tools/list` at all. You opt in with one env var. Cost: a user who wants writes has to know the knob exists. `jira_server_info` tells them, by name.

**Writes are named as writes.** Every tool that changes Jira is prefixed `jira_write_` and carries `readOnlyHint: false`. A model scanning the tool list can't mistake a transition for a lookup. Cost: names are longer.

**Writes require `confirm: true`.** Without it the call returns `CONFIRMATION_REQUIRED` and nothing reaches Jira. The intended loop is: draft, show the user, then call again with confirm. This is enforced server-side, not left to the client. Cost: one extra round trip on every write. That's the point.

**Release health is counted, not paged.** A 6,000-issue release can't be summarised by reading pages until a cap; the split comes out wrong by whatever the cap missed. Every number in the readout is one count query (`maxResults=0`, read `total`): the total, each status category, each open issue type, and sub-tasks as an aggregate. They run with bounded parallelism and settle individually, so the readout is always complete and a failed count is null and named in `partial` rather than silently zeroed. Cost: nine small requests instead of one large one. On a 6,000-issue release that's the difference between right and wrong by 30 points.

**Every call is audited.** One JSONL record per invocation: principal, tool, tier, a SHA-256 of the canonical inputs, the input key names, outcome, error code, duration. Inputs themselves are never written, so the log can prove what was asked without storing what was asked. Cost: you can't replay a call from the audit log alone.

**No hardcoded custom field IDs.** `customfield_10004` means "Epic Name" on one instance and nothing on the next. `jira_list_fields` discovers IDs at runtime, and `jira_write_create_issue` finds and fills Epic Name itself when creating an epic, because Jira DC rejects epics without it and the error doesn't say so.

**Search over GET, not POST.** Jira DC's `POST /search` fails deserialization on some versions with certain field lists. `GET /search` with query parameters has never failed me. Cost: very long JQL hits URL length limits; in practice a PM's JQL doesn't.

**Epic parenting via the Agile API.** `POST /rest/agile/1.0/epic/{key}/issue` is reliable. Writing the Epic Link custom field directly is not.

**Tool descriptions are written for the model.** Each one says when to call it and what to call instead, not just what it does. Rewriting descriptions against real prompts changed results more than any code change in v1.

**Results are slimmed.** A search returns eight fields per issue by default, not the forty Jira sends. Ask for more with `extraFields`. Cost: one more argument when you need a custom field. Benefit: fifty issues fit in the context budget.

**Errors name the knob.** `POLICY_BLOCKED` says which of `JIRA_MCP_MODE` or `JIRA_MCP_DISABLED_TOOLS` blocked the call. `TIMEOUT` says the `JIRA_TIMEOUT_MS` value. `SSO_REDIRECT` fires only on a cross-host redirect, because same-host redirects are normal Jira behaviour.

**Lists are enveloped.** Every list returns `{ total, <items> }`, never a bare array, so fields can be added later without a breaking change.

**One rule broken deliberately: the tier prefix.** The naming rule is `<service>_<verb>_<object>`, one verb. Write tools are `jira_write_<object>` anyway, because the model reads tool names on every call and annotations only the client sees; `jira_write_fields` warns in a way `jira_update_fields` with `readOnlyHint: false` does not. The cost is a slightly odd verb slot. It's worth it.

**Single tenant, on purpose.** One process, one principal, one PAT. The internal-tool standard I follow says per-tenant everything; this server breaks that rule because it runs on a PM's laptop next to their assistant, not as a shared service. If it ever becomes one, auth and rate limiting move to `(service, user)` keys. See `docs/backlog.md`.

## Setup

Requires Node 20+ and a Jira DC personal access token (Jira DC 8.14+; basic auth is supported as a fallback).

```bash
git clone https://github.com/BOSSProto/Jira-DC-MCP
cd Jira-DC-MCP
npm install
npm run build
cp .env.example .env   # fill in JIRA_BASE_URL and JIRA_PAT
npm run smoke          # read-only check against your Jira: auth, projects, fields, one search
```

Claude Desktop (`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "jira-dc": {
      "command": "node",
      "args": ["/absolute/path/to/Jira-DC-MCP/dist/src/index.js"],
      "env": {
        "JIRA_BASE_URL": "https://jira.example.com",
        "JIRA_PAT": "your-token",
        "JIRA_MCP_MODE": "read-only"
      }
    }
  }
}
```

On Windows use forward slashes in the path (`C:/Users/you/Jira-DC-MCP/dist/src/index.js`) and set `JIRA_MCP_AUDIT_LOG` to an absolute path; the server creates the folder if it's missing.

Fully quit and relaunch Claude Desktop after any change; it doesn't respawn servers on config edits. Then ask: *"Call jira_server_info."* You should see `HEALTHY`, the mode, and which tools are hidden and why.

Every env var is documented in `.env.example`.

## Development

```bash
npm run typecheck
npm test                     # unit tests
RUN_E2E_TESTS=1 npm test     # plus an end-to-end run: real stdio server, real MCP client, mock Jira
npm run tools                # print the exposed tool surface for the current config
```

The golden test for `tools/list` derives its expected list from the tool factory, not from a hardcoded mirror, so it can't silently protect a stale contract.

## What it doesn't do, yet

Issue linking, attachments, watchers, bulk transitions, a per-subsystem health registry, per-tool eval sets, and an HTTP transport. Each is in `docs/backlog.md` with the reason it's deferred.

## Licence

MIT.
