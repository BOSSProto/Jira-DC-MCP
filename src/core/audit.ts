import { createHash } from "node:crypto";
import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { log } from "./errors.js";

export type ToolTier = "read" | "write" | "diagnostics";

export interface AuditRecord {
  ts: string;
  traceId: string;
  principal: string;
  tool: string;
  tier: ToolTier;
  /** SHA-256 of the canonical JSON of the inputs. Lets you prove what was asked without storing what was asked. */
  inputsHash: string;
  /** Top-level argument names only, so a reviewer can see the shape of the request. */
  inputKeys: string[];
  outcome: "ok" | "error";
  errorCode?: string;
  durationMs: number;
}

export class AuditLog {
  constructor(private readonly path: string) {}

  static hashInputs(inputs: unknown): string {
    return createHash("sha256").update(canonical(inputs)).digest("hex");
  }

  private dirReady = false;

  async record(rec: AuditRecord): Promise<void> {
    try {
      if (!this.dirReady) {
        // Clients such as Claude Desktop start the server with an arbitrary working directory; create the folder rather than fail.
        await mkdir(dirname(this.path), { recursive: true });
        this.dirReady = true;
      }
      await appendFile(this.path, JSON.stringify(rec) + "\n", "utf8");
    } catch (err) {
      // An audit write failure must be visible, but must not take the tool call down with it.
      log("audit.write_failed", { traceId: rec.traceId, msg: (err as Error).message, path: this.path });
    }
  }
}

/** Stable key order so the same request always hashes the same. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (value && typeof value === "object") {
    const keys = Object.keys(value as Record<string, unknown>).sort();
    return "{" + keys.map((k) => JSON.stringify(k) + ":" + canonical((value as Record<string, unknown>)[k])).join(",") + "}";
  }
  return JSON.stringify(value);
}
