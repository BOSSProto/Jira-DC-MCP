# Changelog

All notable changes to this project are documented here. Format follows Keep a Changelog; versions follow SemVer. Pre-1.0, minor versions may break.

## [0.2.3] - 2026-09-13

### Changed
- Fixtures, examples and tool-description samples now use generic identifiers (project PAY, release 4.2.0, board "Payments Orion"). No behaviour change.

## [0.2.2] - 2026-09-10

### Fixed
- Board resolution walked only the first page and filtered client-side, so boards past page one were reported as missing and the NOT_FOUND error dumped the first 50 boards. It now passes `name=` to Jira for a server-side partial match, pages on `isLast` (bounded at 10 pages), and falls back to a bounded full scan for instances that ignore the filter. NOT_FOUND now says to try `jira_list_boards` with `nameContains` or `projectKey`; ambiguity lists at most 10 candidates with ids.
- Sprint resolution by name walks active and future first, then closed sprints page by page, instead of the first 100.
- `jira_list_boards` and `jira_list_sprints` report Jira's `total` (null when the instance omits it), plus `startAt`, `returned`, `isLast`, `nextStartAt`. `total` was the page length.

### Added
- `startAt` on `jira_list_boards` and `jira_list_sprints`; `nameContains` on boards is applied server-side.

## [0.2.1] - 2026-09-10

### Fixed
- `jira_get_release_health` `openByType` is now count-based like the rest of the readout: one count per configured issue type (default Bug, Story, Improvement, Epic), one aggregate for sub-tasks via `issuetype in subTaskIssueTypes()`, and an `other` remainder derived from the open total. The page-based sample and its `openByTypeComplete` flag are gone. Nine count queries total, bounded at four in flight.

### Added
- `openIssueTypes` parameter on `jira_get_release_health` (1 to 8 names) so instances with different type names aren't stuck with the default set.
- `openTotal` in the release health response.

## [0.2.0] - 2026-09-10

Response to the first external review. Everything here is a hard cut; no shims.

### Fixed
- `jira_server_info` no longer returns the audit log path (reported `auditLog: "enabled"`); explicit test added.
- `jira_get_release_health` rebuilt on exact count queries per status category with bounded parallelism. It previously paged to the cap and mis-stated large releases. `complete: false` now means a count failed, and `partial` names it; the open-by-type drill-down carries its own `openByTypeComplete` flag.
- Page-size schema maxima are bound to `JIRA_MAX_RESULTS_CAP` at startup instead of advertising 1000.
- `boardId`, `sprintId` positive; `startAt` non-negative. Integer params are bounded below in the emitted JSON schema (tested).
- Issue-key regex applied to every key parameter, including `epicKey` and `issueKeys[]`.
- Every parameter has a description in the emitted schema (tested).

### Changed
- Renamed `jira_write_create_issue` → `jira_write_issue` and `jira_write_update_fields` → `jira_write_fields` (one verb slot; tier prefix documented as a deliberate rule-break).
- `destructiveHint: true` on `jira_write_transition` and `jira_write_fields`; additive writes stay `false`.
- All list tools return an envelope `{ total, <items> }` instead of a bare array.
- `jira_list_versions` defaults to unreleased, unarchived versions and takes `released` and `nameContains` filters.

### Added
- `jira_get_issue_context`: issue + comments + links + epic in one call, with `partial` reporting.
- Board and sprint resolution by name; `jira_get_sprint_health` finds the active sprint from a board name.
- Structured `filter` on `jira_search_issues` compiled to JQL with quoting; raw `jql` still accepted.
- `settleLimit` bounded-parallelism helper; logs `fanout.cap_engaged` when the cap engages.

## [0.1.0] - 2026-09-10

### Added
- stdio MCP server with 16 tools over Jira DC REST v2 and Agile 1.0 (10 read, 5 write, 1 diagnostics).
- Policy layer: `JIRA_MCP_MODE` (read-only | full), `JIRA_MCP_DISABLED_TOOLS` block list, server-side `confirm: true` gate on every write.
- JSONL audit log per invocation with hashed inputs, principal, tier, outcome, duration.
- Runtime custom-field discovery (`jira_list_fields`) and automatic Epic Name fill on epic creation.
- One-call `jira_get_release_health` and `jira_get_sprint_health` readouts.
- Structured stderr logging with trace IDs; credential scrubbing at any depth.
- `.env` auto-loaded when present (Node `process.loadEnvFile`); audit log creates its parent directory.
- Unit tests (config, policy, audit, tool-surface golden) and opt-in end-to-end test against a mock Jira.
