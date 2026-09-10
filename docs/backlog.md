# Backlog

Deferred items and why. Items from the first external review are marked (review).

- **Per-subsystem health registry** (review). Health is a single component today. The moment a cache, rate limiter, or circuit breaker lands, `DEGRADED` needs to name the component. Deferred until one of those exists; adding the registry before it would be an abstraction with zero cases.
- **Issue linking.** The `POST /rest/api/2/issueLink` endpoint returned 500s from my previous server on one DC instance and I never isolated whether it was the instance or the payload. Shipping a tool I can't vouch for is worse than not shipping it. Add when reproduced against a second instance.
- **Bulk transitions.** Wanted for sprint close-out, but a bulk write behind a single `confirm` is exactly the blast radius the confirm gate exists to prevent. Needs a per-issue preview design first.
- **Attachments and watchers.** No PM workflow I run needs them yet. Three cases before an abstraction.
- **Per-tool eval set.** Golden prompts per tool with expected tool selection, to catch description regressions. This is the item I most want; it's the one that made the biggest difference in v1.
- **Progressive disclosure via a capabilities tool.** Load reads first and writes on demand. The mode env var does this coarsely today; a client-driven version waits for a client that supports dynamic tool lists well.
- **HTTP transport.** Would turn this into a shared service, which triggers the per-tenant rules (auth, rate limits, circuit breakers keyed on `(service, user)`). Not worth it for a laptop tool.
