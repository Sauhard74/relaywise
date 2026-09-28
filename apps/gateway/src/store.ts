import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import type { HarnessId, RouteDecision, TaskType } from "@jev-route/core";
import type { OptionStats, PriorsProvider } from "@jev-route/router";

export type ResponseStatus = "queued" | "in_progress" | "completed" | "incomplete" | "failed" | "cancelled";

export interface ResponseRow {
  id: string;
  session_id: string;
  previous_response_id: string | null;
  status: ResponseStatus;
  harness: HarnessId;
  model: string;
  effort: string | null;
  input_text: string;
  output_json: string;
  output_text: string;
  usage_json: string | null;
  cost_usd: number | null;
  est_cost_usd: number | null;
  task_type: TaskType | null;
  option_id: string | null;
  route_source: string | null;
  route_json: string | null;
  error_json: string | null;
  checkpoint_json: string | null;
  metadata_json: string;
  idempotency_key: string | null;
  request_hash: string | null;
  created_at: number;
  completed_at: number | null;
  duration_ms: number | null;
}

export interface SessionRow {
  id: string;
  harness: HarnessId;
  model: string;
  /** What the client addressed: "auto" sessions are re-routed every turn. */
  requested_harness: string;
  /** Native session id per harness (JSON map), for resuming when a harness is reused. */
  harness_sessions: string;
  sandbox_id: string | null;
  project_id: string | null;
  busy: number;
  created_at: number;
  last_used_at: number;
  expired: number;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  busy INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  harness TEXT NOT NULL,
  model TEXT NOT NULL,
  requested_harness TEXT NOT NULL DEFAULT 'auto',
  harness_sessions TEXT NOT NULL DEFAULT '{}',
  sandbox_id TEXT,
  project_id TEXT,
  busy INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER NOT NULL,
  expired INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS responses (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  previous_response_id TEXT,
  status TEXT NOT NULL,
  harness TEXT NOT NULL,
  model TEXT NOT NULL,
  effort TEXT,
  input_text TEXT NOT NULL,
  output_json TEXT NOT NULL DEFAULT '[]',
  output_text TEXT NOT NULL DEFAULT '',
  usage_json TEXT,
  cost_usd REAL,
  est_cost_usd REAL,
  task_type TEXT,
  option_id TEXT,
  route_source TEXT,
  route_json TEXT,
  error_json TEXT,
  checkpoint_json TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  idempotency_key TEXT,
  request_hash TEXT,
  created_at INTEGER NOT NULL,
  completed_at INTEGER,
  duration_ms INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS responses_idem ON responses(idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS responses_created ON responses(created_at DESC);
CREATE INDEX IF NOT EXISTS responses_task ON responses(task_type, option_id);
CREATE TABLE IF NOT EXISTS feedback (
  response_id TEXT PRIMARY KEY REFERENCES responses(id) ON DELETE CASCADE,
  score REAL NOT NULL,
  comment TEXT,
  created_at INTEGER NOT NULL
);
`;

export class Store {
  readonly db: Database.Database;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.db.exec(SCHEMA);
    this.migrate();
  }

  /** Additive migrations for databases created by earlier versions. */
  private migrate(): void {
    const add = (table: string, column: string, ddl: string) => {
      const cols = this.db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
      if (!cols.some((c) => c.name === column)) this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
    };
    add("sessions", "requested_harness", "TEXT NOT NULL DEFAULT 'auto'");
    add("sessions", "harness_sessions", "TEXT NOT NULL DEFAULT '{}'");
    add("responses", "checkpoint_json", "TEXT");
    add("sessions", "project_id", "TEXT");
  }

  createSession(
    s: Pick<SessionRow, "id" | "harness" | "model"> & { requested_harness?: string; project_id?: string | null },
  ): SessionRow {
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO sessions (id, harness, model, requested_harness, project_id, created_at, last_used_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(s.id, s.harness, s.model, s.requested_harness ?? "auto", s.project_id ?? null, now, now);
    return this.getSession(s.id)!;
  }

  getSession(id: string): SessionRow | undefined {
    return this.db.prepare(`SELECT * FROM sessions WHERE id = ?`).get(id) as SessionRow | undefined;
  }

  /** Atomically marks a session busy. Returns false if it already was. */
  claimSession(id: string): boolean {
    return this.db.prepare(`UPDATE sessions SET busy = 1, last_used_at = ? WHERE id = ? AND busy = 0`).run(Date.now(), id)
      .changes === 1;
  }

  updateSession(id: string, patch: Partial<Omit<SessionRow, "id">>): void {
    const keys = Object.keys(patch);
    if (keys.length === 0) return;
    this.db
      .prepare(`UPDATE sessions SET ${keys.map((k) => `${k} = @${k}`).join(", ")} WHERE id = @id`)
      .run({ ...patch, id });
  }

  idleSessions(idleBefore: number): SessionRow[] {
    return this.db
      .prepare(`SELECT * FROM sessions WHERE busy = 0 AND expired = 0 AND sandbox_id IS NOT NULL AND last_used_at < ?`)
      .all(idleBefore) as SessionRow[];
  }

  staleSessions(before: number): SessionRow[] {
    return this.db.prepare(`SELECT * FROM sessions WHERE busy = 0 AND expired = 0 AND last_used_at < ?`).all(before) as SessionRow[];
  }

  /**
   * Locks an idle session for reaping (busy=1) only if it is still idle, so a turn that
   * claimed it in the meantime can't have its sandbox removed underneath it.
   */
  lockForReap(id: string, idleBefore: number): boolean {
    return this.db.prepare(`UPDATE sessions SET busy = 1 WHERE id = ? AND busy = 0 AND last_used_at < ?`).run(id, idleBefore)
      .changes === 1;
  }

  // ---- projects: a persistent workspace + ledger shared by many sessions ----

  ensureProject(id: string): void {
    const now = Date.now();
    this.db
      .prepare(`INSERT INTO projects (id, created_at, last_used_at) VALUES (?, ?, ?) ON CONFLICT(id) DO NOTHING`)
      .run(id, now, now);
  }

  getProject(id: string): { id: string; busy: number; created_at: number; last_used_at: number } | undefined {
    return this.db.prepare(`SELECT * FROM projects WHERE id = ?`).get(id) as never;
  }

  /** One turn at a time per project: its sessions share files. */
  claimProject(id: string): boolean {
    return this.db.prepare(`UPDATE projects SET busy = 1, last_used_at = ? WHERE id = ? AND busy = 0`).run(Date.now(), id)
      .changes === 1;
  }

  releaseProject(id: string): void {
    this.db.prepare(`UPDATE projects SET busy = 0, last_used_at = ? WHERE id = ?`).run(Date.now(), id);
  }

  deleteProject(id: string): void {
    this.db.prepare(`UPDATE sessions SET expired = 1, sandbox_id = NULL WHERE project_id = ?`).run(id);
    this.db.prepare(`DELETE FROM projects WHERE id = ?`).run(id);
  }

  projectStats(id: string): { sessions: number; turns: number } {
    return this.db
      .prepare(
        `SELECT COUNT(DISTINCT s.id) AS sessions, COUNT(r.id) AS turns
         FROM sessions s LEFT JOIN responses r ON r.session_id = s.id WHERE s.project_id = ?`,
      )
      .get(id) as { sessions: number; turns: number };
  }

  /** Recent turns across every session of a project, oldest first. */
  projectTurns(projectId: string, limit: number): ResponseRow[] {
    return (
      this.db
        .prepare(
          `SELECT r.* FROM responses r JOIN sessions s ON s.id = r.session_id
           WHERE s.project_id = ? ORDER BY r.created_at DESC LIMIT ?`,
        )
        .all(projectId, limit) as ResponseRow[]
    ).reverse();
  }

  /** Clears busy flags left behind by a crash. */
  resetBusy(): void {
    this.db.prepare(`UPDATE sessions SET busy = 0 WHERE busy = 1`).run();
    this.db.prepare(`UPDATE projects SET busy = 0 WHERE busy = 1`).run();
    this.db
      .prepare(
        `UPDATE responses SET status = 'failed', error_json = '{"type":"server_error","code":"jevroute.gateway_restarted","message":"gateway restarted during the run"}', completed_at = ? WHERE status IN ('queued', 'in_progress')`,
      )
      .run(Date.now());
  }

  insertResponse(r: ResponseRow): void {
    const cols = Object.keys(r);
    this.db
      .prepare(`INSERT INTO responses (${cols.join(", ")}) VALUES (${cols.map((c) => `@${c}`).join(", ")})`)
      .run(r);
  }

  updateResponse(id: string, patch: Partial<Omit<ResponseRow, "id">>): void {
    const keys = Object.keys(patch);
    if (keys.length === 0) return;
    this.db
      .prepare(`UPDATE responses SET ${keys.map((k) => `${k} = @${k}`).join(", ")} WHERE id = @id`)
      .run({ ...patch, id });
  }

  getResponse(id: string): ResponseRow | undefined {
    return this.db.prepare(`SELECT * FROM responses WHERE id = ?`).get(id) as ResponseRow | undefined;
  }

  getByIdempotencyKey(key: string): ResponseRow | undefined {
    return this.db.prepare(`SELECT * FROM responses WHERE idempotency_key = ?`).get(key) as ResponseRow | undefined;
  }

  deleteResponse(id: string): boolean {
    return this.db.prepare(`DELETE FROM responses WHERE id = ?`).run(id).changes === 1;
  }

  /** Earlier turns of a session, oldest first. */
  sessionTurns(sessionId: string, limit: number): ResponseRow[] {
    return (
      this.db
        .prepare(`SELECT * FROM responses WHERE session_id = ? ORDER BY created_at DESC LIMIT ?`)
        .all(sessionId, limit) as ResponseRow[]
    ).reverse();
  }

  listResponses(limit: number): ResponseRow[] {
    return this.db.prepare(`SELECT * FROM responses ORDER BY created_at DESC LIMIT ?`).all(limit) as ResponseRow[];
  }

  setFeedback(responseId: string, score: number, comment?: string): void {
    this.db
      .prepare(
        `INSERT INTO feedback (response_id, score, comment, created_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(response_id) DO UPDATE SET score = excluded.score, comment = excluded.comment, created_at = excluded.created_at`,
      )
      .run(responseId, score, comment ?? null, Date.now());
  }

  /** Per-option outcome stats for one task type — the routing learning loop. */
  optionStats(taskType: TaskType): Map<string, OptionStats> {
    const rows = this.db
      .prepare(
        `SELECT r.option_id AS option_id,
                COUNT(*) AS runs,
                AVG(COALESCE(f.score, CASE r.status WHEN 'completed' THEN 1.0 ELSE 0.0 END)) AS quality,
                AVG(CASE WHEN r.cost_usd > 0 AND r.est_cost_usd > 0 THEN r.cost_usd / r.est_cost_usd END) AS cost_ratio
         FROM responses r LEFT JOIN feedback f ON f.response_id = r.id
         WHERE r.task_type = ? AND r.option_id IS NOT NULL AND r.status IN ('completed', 'failed', 'incomplete')
         GROUP BY r.option_id`,
      )
      .all(taskType) as { option_id: string; runs: number; quality: number; cost_ratio: number | null }[];
    return new Map(rows.map((r) => [r.option_id, { runs: r.runs, quality: r.quality, cost_ratio: r.cost_ratio ?? 1 }]));
  }

  stats(): Record<string, unknown> {
    const totals = this.db
      .prepare(
        `SELECT COUNT(*) AS runs,
                SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completed,
                SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed,
                SUM(COALESCE(cost_usd, 0)) AS cost_usd,
                AVG(duration_ms) AS avg_duration_ms
         FROM responses`,
      )
      .get();
    const byOption = this.db
      .prepare(
        `SELECT option_id, harness, model, COUNT(*) AS runs,
                SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completed,
                SUM(COALESCE(cost_usd, 0)) AS cost_usd, AVG(duration_ms) AS avg_duration_ms
         FROM responses GROUP BY option_id ORDER BY runs DESC`,
      )
      .all();
    const bySource = this.db
      .prepare(`SELECT route_source, COUNT(*) AS runs FROM responses GROUP BY route_source`)
      .all();
    const byTask = this.db
      .prepare(`SELECT task_type, COUNT(*) AS runs FROM responses GROUP BY task_type ORDER BY runs DESC`)
      .all();
    return { totals, by_option: byOption, by_route_source: bySource, by_task_type: byTask };
  }

  close(): void {
    this.db.close();
  }
}

/** PriorsProvider backed by the store, cached briefly so routing stays sub-millisecond. */
export class StorePriors implements PriorsProvider {
  private cache = new Map<TaskType, { at: number; stats: Map<string, OptionStats> }>();

  constructor(
    private readonly store: Store,
    private readonly ttlMs = 30_000,
  ) {}

  stats(taskType: TaskType): Map<string, OptionStats> {
    const hit = this.cache.get(taskType);
    if (hit && Date.now() - hit.at < this.ttlMs) return hit.stats;
    const stats = this.store.optionStats(taskType);
    this.cache.set(taskType, { at: Date.now(), stats });
    return stats;
  }

  invalidate(): void {
    this.cache.clear();
  }
}

export function routeColumns(d: RouteDecision | undefined) {
  return {
    task_type: d?.features.task_type ?? null,
    option_id: d?.option_id ?? null,
    route_source: d?.source ?? null,
    route_json: d ? JSON.stringify(d) : null,
    // Continuations aren't routed, so they carry no estimate.
    est_cost_usd: d && d.source !== "session" ? d.est_cost_usd : null,
  };
}
