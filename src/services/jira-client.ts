import type { Config } from "../core/config.js";
import { ToolError, log } from "../core/errors.js";

export interface JiraIssue {
  id: string;
  key: string;
  fields: Record<string, unknown>;
}

export interface SearchResult {
  total: number;
  startAt: number;
  maxResults: number;
  issues: JiraIssue[];
}

export interface FieldDef {
  id: string;
  name: string;
  custom: boolean;
  schema?: { type?: string; custom?: string };
}

type Query = Record<string, string | number | undefined>;

export class JiraClient {
  private readonly host: string;
  private fieldCache: FieldDef[] | null = null;

  constructor(private readonly config: Config) {
    this.host = new URL(config.JIRA_BASE_URL).hostname;
  }

  // ---------- Read endpoints ----------

  /** Uses GET /rest/api/2/search. The POST variant fails deserialization on some DC versions; GET is the reliable path. */
  search(traceId: string, jql: string, opts: { fields?: string[]; startAt?: number; maxResults?: number } = {}): Promise<SearchResult> {
    return this.get<SearchResult>(traceId, "/rest/api/2/search", {
      jql,
      fields: opts.fields?.join(","),
      startAt: opts.startAt ?? 0,
      maxResults: this.capResults(opts.maxResults),
    });
  }

  /** Count matching issues with maxResults=0: Jira returns `total` and no issues, so the answer is always complete and cheap. */
  async countIssues(traceId: string, jql: string): Promise<number> {
    const r = await this.get<SearchResult>(traceId, "/rest/api/2/search", { jql, maxResults: 0, fields: "id" });
    return r.total;
  }

  getIssue(traceId: string, key: string, fields?: string[]): Promise<JiraIssue> {
    return this.get<JiraIssue>(traceId, `/rest/api/2/issue/${enc(key)}`, { fields: fields?.join(",") });
  }

  listComments(traceId: string, key: string, maxResults?: number) {
    return this.get<{ total: number; comments: Array<Record<string, unknown>> }>(traceId, `/rest/api/2/issue/${enc(key)}/comment`, {
      maxResults: this.capResults(maxResults),
      orderBy: "-created",
    });
  }

  listProjects(traceId: string) {
    return this.get<Array<{ id: string; key: string; name: string; projectTypeKey?: string }>>(traceId, "/rest/api/2/project");
  }

  listVersions(traceId: string, projectKey: string) {
    return this.get<Array<{ id: string; name: string; released: boolean; archived: boolean; releaseDate?: string }>>(
      traceId,
      `/rest/api/2/project/${enc(projectKey)}/versions`,
    );
  }

  listTransitions(traceId: string, key: string) {
    return this.get<{ transitions: Array<{ id: string; name: string; to: { name: string } }> }>(traceId, `/rest/api/2/issue/${enc(key)}/transitions`);
  }

  /** Custom field IDs differ per instance; discover them instead of hardcoding. Cached for the process lifetime. */
  async listFields(traceId: string): Promise<FieldDef[]> {
    if (!this.fieldCache) this.fieldCache = await this.get<FieldDef[]>(traceId, "/rest/api/2/field");
    return this.fieldCache;
  }

  async findFieldByName(traceId: string, name: string): Promise<FieldDef | undefined> {
    const fields = await this.listFields(traceId);
    const lower = name.toLowerCase();
    return fields.find((f) => f.name.toLowerCase() === lower);
  }

  listBoards(traceId: string, projectKey?: string, maxResults?: number) {
    return this.get<{ values: Array<{ id: number; name: string; type: string }> }>(traceId, "/rest/agile/1.0/board", {
      projectKeyOrId: projectKey,
      maxResults: this.capResults(maxResults),
    });
  }

  listSprints(traceId: string, boardId: number, state?: "active" | "future" | "closed", maxResults?: number) {
    return this.get<{ values: Array<{ id: number; name: string; state: string; startDate?: string; endDate?: string; goal?: string }> }>(
      traceId,
      `/rest/agile/1.0/board/${boardId}/sprint`,
      { state, maxResults: this.capResults(maxResults) },
    );
  }

  sprintIssues(traceId: string, sprintId: number, fields: string[], maxResults?: number) {
    return this.get<SearchResult>(traceId, `/rest/agile/1.0/sprint/${sprintId}/issue`, {
      fields: fields.join(","),
      maxResults: this.capResults(maxResults),
    });
  }

  myself(traceId: string) {
    return this.get<{ name: string; displayName: string }>(traceId, "/rest/api/2/myself");
  }

  // ---------- Write endpoints ----------

  addComment(traceId: string, key: string, body: string) {
    return this.send<{ id: string }>(traceId, "POST", `/rest/api/2/issue/${enc(key)}/comment`, { body });
  }

  transition(traceId: string, key: string, transitionId: string, comment?: string) {
    const payload: Record<string, unknown> = { transition: { id: transitionId } };
    if (comment) payload.update = { comment: [{ add: { body: comment } }] };
    return this.send<void>(traceId, "POST", `/rest/api/2/issue/${enc(key)}/transitions`, payload);
  }

  createIssue(traceId: string, fields: Record<string, unknown>) {
    return this.send<{ id: string; key: string }>(traceId, "POST", "/rest/api/2/issue", { fields });
  }

  updateIssue(traceId: string, key: string, fields: Record<string, unknown>) {
    return this.send<void>(traceId, "PUT", `/rest/api/2/issue/${enc(key)}`, { fields });
  }

  /** The Agile endpoint is the reliable way to parent issues under an epic on DC; setting the Epic Link field directly is not. */
  moveToEpic(traceId: string, epicKey: string, issueKeys: string[]) {
    return this.send<void>(traceId, "POST", `/rest/agile/1.0/epic/${enc(epicKey)}/issue`, { issues: issueKeys });
  }

  // ---------- Transport ----------

  private capResults(n: number | undefined): number {
    const cap = this.config.JIRA_MAX_RESULTS_CAP;
    if (n === undefined) return Math.min(50, cap);
    return Math.max(1, Math.min(n, cap));
  }

  private get<T>(traceId: string, path: string, query: Query = {}): Promise<T> {
    return this.send<T>(traceId, "GET", path, undefined, query);
  }

  private async send<T>(traceId: string, method: "GET" | "POST" | "PUT", path: string, body?: unknown, query: Query = {}): Promise<T> {
    const url = new URL(this.config.JIRA_BASE_URL + path);
    for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== "") url.searchParams.set(k, String(v));

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.JIRA_TIMEOUT_MS);
    const started = Date.now();
    log("jira_client.request_start", { traceId, method, path });

    let res: Response;
    try {
      res = await fetch(url, {
        method,
        headers: { ...this.authHeader(), Accept: "application/json", ...(body ? { "Content-Type": "application/json" } : {}) },
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
        redirect: "follow",
      });
    } catch (err) {
      clearTimeout(timer);
      const aborted = (err as Error).name === "AbortError";
      log("jira_client.request_failed", { traceId, method, path, durationMs: Date.now() - started, reason: aborted ? "timeout" : "network" });
      if (aborted) throw new ToolError("TIMEOUT", `Jira did not respond within JIRA_TIMEOUT_MS=${this.config.JIRA_TIMEOUT_MS}ms for ${method} ${path}.`, { knob: "JIRA_TIMEOUT_MS" });
      throw new ToolError("UPSTREAM_ERROR", `Network error calling Jira: ${(err as Error).message}`);
    }
    clearTimeout(timer);
    log("jira_client.request_end", { traceId, method, path, status: res.status, durationMs: Date.now() - started });

    // Only a cross-host redirect means SSO; same-host redirects are normal Jira behaviour.
    if (res.redirected && new URL(res.url).hostname !== this.host) {
      throw new ToolError("SSO_REDIRECT", `Jira redirected to ${new URL(res.url).hostname}. The credentials for JIRA_AUTH_METHOD=${this.config.JIRA_AUTH_METHOD} were not accepted; check JIRA_PAT or use a service account.`, { knob: "JIRA_AUTH_METHOD" });
    }
    if (res.status === 401 || res.status === 403) throw new ToolError("AUTH_FAILED", `Jira returned ${res.status} for ${method} ${path}. Check the token/permissions for the configured principal.`);
    if (res.status === 404) throw new ToolError("NOT_FOUND", `Jira returned 404 for ${method} ${path}.`);
    if (res.status === 429) throw new ToolError("RATE_LIMITED", "Jira rate-limited this request (429). Retry after a short wait.");
    if (res.status >= 500) throw new ToolError("UPSTREAM_ERROR", `Jira returned ${res.status} for ${method} ${path}.`, { body: await safeText(res) });
    if (!res.ok) throw new ToolError("INVALID_INPUT", `Jira rejected ${method} ${path} with ${res.status}: ${await safeText(res)}`);

    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }

  private authHeader(): Record<string, string> {
    if (this.config.JIRA_AUTH_METHOD === "pat") return { Authorization: `Bearer ${this.config.JIRA_PAT}` };
    const token = Buffer.from(`${this.config.JIRA_USERNAME}:${this.config.JIRA_PASSWORD}`).toString("base64");
    return { Authorization: `Basic ${token}` };
  }
}

function enc(s: string): string {
  return encodeURIComponent(s);
}

async function safeText(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 500);
  } catch {
    return "";
  }
}
