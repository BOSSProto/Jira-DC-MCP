# Architecture and status

## Layers (one-way dependencies, top to bottom)

```
transport   src/index.ts            stdio; wraps every tool call with policy, confirm, audit, error mapping
tools       src/tools/*             single factory (factory.ts) assembles the surface; reads.ts, writes.ts, diagnostics
services    src/services/jira-client.ts   fetch with timeout, auth header, SSO detection, error taxonomy, paging cap
core        src/core/*              config (Zod, fail-fast), policy, audit, errors/logging, parallel (bounded settle)
```

Any second transport (HTTP) must call `createTools()` from the same factory and add a drift test comparing the two `tools/list` outputs.

## Request path

1. Client calls tool → `index.ts` allocates a `traceId`, logs `tool.invocation`.
2. `Policy.assertAllowed` (mode, block list) → `Policy.assertConfirmed` (writes only).
3. Handler runs against `JiraClient`; every HTTP call logs `jira_client.request_start` / `request_end` with the same `traceId`.
4. Audit record appended (ok or error). Errors return `isError: true` with `{ error, message, details }`; the process never crashes on a tool error.

## Error taxonomy

`AUTH_FAILED`, `SSO_REDIRECT`, `NOT_FOUND`, `RATE_LIMITED`, `UPSTREAM_ERROR`, `TIMEOUT`, `POLICY_BLOCKED`, `CONFIRMATION_REQUIRED`, `INVALID_INPUT`. Each message names the knob or the upstream status that caused it.

## Fan-out

`settleLimit` caps concurrent Jira calls at 4 and settles each task individually. Readouts that fan out (release health, issue context) return partial results with the failed part named, never a batch failure.

## Status

v0.2.2. Read tools exercised against a live Jira DC via `npm run smoke`. Write tools exercised end-to-end against the mock only; test them in a sandbox project before enabling `full` mode against production.

## Deliberate rule-breaks

- Single tenant (one principal per process). See README, "Single tenant, on purpose."
- No CLI flags or YAML config; env vars only. Three cases before an abstraction; there's one.
