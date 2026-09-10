import { randomUUID } from "node:crypto";

export type ErrorCode =
  | "AUTH_FAILED"
  | "SSO_REDIRECT"
  | "NOT_FOUND"
  | "RATE_LIMITED"
  | "UPSTREAM_ERROR"
  | "TIMEOUT"
  | "POLICY_BLOCKED"
  | "CONFIRMATION_REQUIRED"
  | "INVALID_INPUT";

export class ToolError extends Error {
  constructor(
    public readonly code: ErrorCode,
    message: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "ToolError";
  }
}

export const SERVICE = "jira-dc-mcp";
export const VERSION = "0.2.1";

export function newTraceId(): string {
  return randomUUID();
}

/**
 * Structured log line to stderr (stdout is the MCP transport and must stay clean).
 * Every line carries event, service, version, traceId. Free text goes in msg, never instead.
 */
export function log(event: string, fields: Record<string, unknown> & { traceId?: string; msg?: string }): void {
  const line = { ts: new Date().toISOString(), event, service: SERVICE, version: VERSION, ...fields };
  process.stderr.write(JSON.stringify(scrub(line)) + "\n");
}

const SECRET_PATTERN = /(pat|password|token|authorization|secret)/i;

/** Defensive: drop any field whose key looks like a credential, at any depth. Tested in test/audit.test.ts. */
export function scrub<T>(value: T): T {
  if (Array.isArray(value)) return value.map(scrub) as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SECRET_PATTERN.test(k) ? "<redacted>" : scrub(v);
    }
    return out as T;
  }
  return value;
}
