import { createHash } from "node:crypto";
import { z } from "zod";
import {
  EFFORTS,
  HARNESS_IDS,
  OBJECTIVES,
  costFromUsage,
  type CatalogOption,
  type Effort,
  type HarnessId,
  type Objective,
  type RouteDecision,
  type RunSpec,
} from "@jev-route/core";
import { RouteError, heuristicFeatures, type Router } from "@jev-route/router";
import type { Config } from "./config.ts";
import type { Executor, RunHandle } from "./executors/types.ts";
import { ResponseBuilder, newId, type ErrorInfo, type OutputItem, type SseEvent, type Usage } from "./responses.ts";
import { routeColumns, type ResponseRow, type ResponseStatus, type SessionRow, type Store, type StorePriors } from "./store.ts";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly type: string,
    readonly code: string,
    message: string,
    readonly param: string | null = null,
    readonly detail?: Record<string, unknown>,
  ) {
    super(message);
  }
}

const InputItem = z
  .object({
    type: z.string().optional(),
    role: z.string().optional(),
    content: z.union([z.string(), z.array(z.object({ type: z.string(), text: z.string().optional() }).passthrough())]).optional(),
    text: z.string().optional(),
  })
  .passthrough();

export const CreateBody = z
  .object({
    model: z.string().optional(),
    input: z.union([z.string().min(1), z.array(InputItem).min(1)]),
    instructions: z.string().optional(),
    stream: z.boolean().optional(),
    background: z.boolean().optional(),
    store: z.boolean().optional(),
    previous_response_id: z.string().optional(),
    metadata: z.record(z.unknown()).optional(),
    reasoning: z.object({ effort: z.enum(EFFORTS).optional() }).passthrough().optional(),
    routing: z
      .object({ objective: z.enum(OBJECTIVES).optional(), max_cost_usd: z.number().positive().optional() })
      .strict()
      .optional(),
    timeout_seconds: z.number().positive().max(86_400).optional(),
    max_step: z.number().int().positive().optional(),
  })
  .passthrough();
export type CreateBody = z.infer<typeof CreateBody>;

const HANDLED_FIELDS = new Set(Object.keys(CreateBody.shape));
const BARE_MODELS = new Set(["", "auto", "claude", "claude-code", "codex", "opencode", "hermes"]);

/** Least privilege: each harness only receives the credentials it uses. */
const HARNESS_ENV: Record<HarnessId, string[]> = {
  "claude-code": ["ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL", "CLAUDE_CODE_OAUTH_TOKEN"],
  codex: ["OPENAI_API_KEY", "OPENAI_BASE_URL", "CODEX_API_KEY", "CODEX_AUTH_JSON"],
  opencode: ["OPENROUTER_API_KEY"],
  hermes: ["OPENROUTER_API_KEY"],
  mock: [],
};

interface ActiveRun {
  builder: ResponseBuilder;
  events: SseEvent[];
  listeners: Set<(e: SseEvent) => void>;
  handle?: RunHandle;
  cancelRequested: boolean;
  finished: Promise<void>;
}

export type CreateResult = { kind: "json"; body: Record<string, unknown> } | { kind: "stream"; id: string };

export class GatewayService {
  private readonly active = new Map<string, ActiveRun>();
  private installed?: Record<HarnessId, boolean>;
  private hostCredentials?: Set<string>;
  private reaper?: NodeJS.Timeout;

  constructor(
    private readonly cfg: Config,
    private readonly store: Store,
    private readonly executor: Executor,
    private readonly router: Router,
    private readonly priors?: StorePriors,
  ) {}

  async init(): Promise<void> {
    this.store.resetBusy();
    this.installed = await this.executor.installed().catch(() => this.emptyInstalled());
    this.hostCredentials = this.executor.hostCredentials?.();
  }

  startReaper(intervalMs = 60_000): void {
    this.reaper = setInterval(() => void this.reap(), intervalMs);
    this.reaper.unref();
  }

  async shutdown(): Promise<void> {
    if (this.reaper) clearInterval(this.reaper);
    await Promise.all([...this.active.values()].map(async (a) => a.handle?.cancel()));
  }

  // ---- availability -------------------------------------------------------------------------

  harnessStatus(id: HarnessId): { available: boolean; missing: string[] } {
    const missing: string[] = [];
    if (id === "mock" && !this.cfg.enableMock) missing.push("disabled (set JEV_ROUTE_ENABLE_MOCK=1)");
    else if (!this.installed?.[id]) missing.push(this.executor.kind === "docker" ? "CLI missing from sandbox image" : "CLI not installed on this host");
    const auth = this.cfg.catalog.harnesses[id].auth_env;
    // Local mode may use the host's CLI logins, so only Docker requires forwarded keys.
    if (this.executor.kind === "docker" && auth.length > 0 && !auth.some((k) => this.cfg.providerEnv[k])) {
      missing.push(`no credentials (set one of ${auth.join(", ")})`);
    }
    return { available: missing.length === 0, missing };
  }

  isOptionAvailable = (o: CatalogOption): boolean =>
    this.harnessStatus(o.harness).available && (!o.auth_env || o.auth_env.some((k) => this.hasCredential(k)));

  /** A forwarded key, or (local executor only) a login the host CLI already has. */
  private hasCredential(key: string): boolean {
    return Boolean(this.cfg.providerEnv[key]) || (this.hostCredentials?.has(key) ?? false);
  }

  /**
   * UHP harness objects: `id` is `chrn_<base>`; `base` is the harness family. Plain base ids
   * ("codex", "auto") are accepted everywhere a harness id is.
   */
  listHarnesses() {
    const harnesses = [
      {
        id: "chrn_auto",
        object: "harness",
        name: "Auto (routed by Jev)",
        base: "auto",
        baseLabel: "Auto",
        defaultModel: "auto",
        available: this.visibleHarnesses().some((id) => this.harnessStatus(id).available),
        routing: { engine: this.cfg.typesafeApiKey ? "jev" : "heuristic", model: this.cfg.jevModel },
      },
      ...this.visibleHarnesses().map((id) => {
        const h = this.cfg.catalog.harnesses[id];
        const status = this.harnessStatus(id);
        const models = this.cfg.catalog.options.filter((o) => o.harness === id);
        return {
          id: `chrn_${id}`,
          object: "harness",
          name: h.label,
          base: id,
          baseLabel: h.label,
          ...(models[0] ? { defaultModel: models[0].model } : {}),
          available: status.available,
          ...(status.missing.length ? { unavailable_reasons: status.missing } : {}),
          supports_effort: h.efforts.length > 0,
          native_resume: h.native_resume,
        };
      }),
    ];
    return { object: "list", harnesses, data: harnesses };
  }

  getHarness(id: string) {
    const base = normalizeHarnessId(id);
    const h = this.listHarnesses().harnesses.find((x) => x.base === base);
    if (!h) throw new ApiError(404, "invalid_request_error", "harness_not_found", `unknown harness '${id}'`);
    return h;
  }

  /** UHP ModelCatalog: models grouped by harness base. */
  listModels() {
    const backends: Record<string, { default: string; models: { id: string; available: boolean }[] }> = {
      auto: { default: "auto", models: [this.autoModel()] },
    };
    for (const id of this.visibleHarnesses()) {
      const models = this.cfg.catalog.options.filter((o) => o.harness === id).map((o) => this.modelEntry(o));
      if (models.length) backends[id] = { default: models[0]!.id, models };
    }
    const data = Object.values(backends).flatMap((b) => b.models);
    return { object: "list", backends, data };
  }

  harnessModels(id: string) {
    const base = this.getHarness(id).base;
    if (base === "auto") {
      return { harness_id: `chrn_auto`, backend: "auto", default: "auto", models: [this.autoModel()] };
    }
    const models = this.cfg.catalog.options.filter((o) => o.harness === base).map((o) => this.modelEntry(o));
    return { harness_id: `chrn_${base}`, backend: base, default: models[0]?.id ?? "", models };
  }

  private modelEntry(o: CatalogOption) {
    return {
      id: o.model,
      label: o.model,
      backend: o.harness,
      available: this.isOptionAvailable(o),
      option_id: o.id,
      tier: o.tier,
      pricing: o.price,
      strengths: o.strengths,
    };
  }

  private autoModel() {
    return {
      id: "auto",
      label: "Routed by Jev",
      backend: "auto",
      available: this.cfg.catalog.options.some((o) => this.isOptionAvailable(o)),
      default: true,
    };
  }

  private visibleHarnesses(): HarnessId[] {
    return HARNESS_IDS.filter((id) => id !== "mock" || this.cfg.enableMock);
  }

  // ---- routing -------------------------------------------------------------------------------

  async dryRoute(raw: unknown): Promise<RouteDecision> {
    const body = parseBody(raw);
    const { harness } = this.requestedHarness(body, undefined);
    return this.route(body, harness);
  }

  private requestedHarness(body: CreateBody, headerHarness: string | undefined): { harness: HarnessId | "auto" } {
    const given = (body.metadata?.harness_id as string | undefined) ?? headerHarness ?? "auto";
    const raw = normalizeHarnessId(given);
    if (raw !== "auto" && !(HARNESS_IDS as readonly string[]).includes(raw)) {
      throw new ApiError(404, "invalid_request_error", "harness_not_found", `unknown harness '${given}'`, "metadata.harness_id");
    }
    return { harness: raw as HarnessId | "auto" };
  }

  private async route(body: CreateBody, harness: HarnessId | "auto"): Promise<RouteDecision> {
    const model = body.model && !BARE_MODELS.has(body.model) ? body.model : (body.metadata?.model as string | undefined);
    const effort = body.reasoning?.effort ?? (body.metadata?.reasoning_effort as Effort | undefined);
    if (effort && !(EFFORTS as readonly string[]).includes(effort)) {
      throw new ApiError(400, "invalid_request_error", "invalid_input", `invalid effort '${effort}'`, "reasoning.effort");
    }
    if (harness !== "auto") {
      const status = this.harnessStatus(harness);
      if (!status.available) {
        throw new ApiError(422, "invalid_request_error", "harness_unavailable", `harness '${harness}' is unavailable: ${status.missing.join("; ")}`, "metadata.harness_id");
      }
    }
    const objectiveRaw = body.routing?.objective ?? body.metadata?.routing_objective;
    const objective = (OBJECTIVES as readonly unknown[]).includes(objectiveRaw) ? (objectiveRaw as Objective) : undefined;
    const maxCost = body.routing?.max_cost_usd ?? numberOrUndefined(body.metadata?.max_cost_usd);
    try {
      return await this.router.route({
        prompt: promptOf(body),
        objective,
        max_cost_usd: maxCost,
        pin: {
          ...(harness !== "auto" ? { harness } : {}),
          ...(model ? { model } : {}),
          ...(effort ? { effort } : {}),
        },
      });
    } catch (err) {
      if (err instanceof RouteError) {
        throw new ApiError(422, "invalid_request_error", `jevroute.${err.code}`, err.message, null, err.detail);
      }
      throw err;
    }
  }

  // ---- create --------------------------------------------------------------------------------

  async create(raw: unknown, headers: { idempotencyKey?: string; harnessId?: string }): Promise<CreateResult> {
    const body = parseBody(raw);
    const idemKey = headers.idempotencyKey ?? (body.metadata?.idempotency_key as string | undefined);
    const requestHash = createHash("sha256").update(stableStringify(body)).digest("hex");

    if (idemKey) {
      const prior = this.store.getByIdempotencyKey(idemKey);
      if (prior) {
        if (prior.request_hash !== requestHash) {
          throw new ApiError(409, "invalid_request_error", "jevroute.idempotency_key_reused", "Idempotency-Key was already used with a different request body");
        }
        return this.deliver(prior.id, body);
      }
    }

    const { harness: requested } = this.requestedHarness(body, headers.harnessId);
    let session: SessionRow;
    let decision: RouteDecision;
    let transcript: { role: "user" | "assistant"; text: string }[] = [];

    if (body.previous_response_id) {
      const prev = this.store.getResponse(body.previous_response_id);
      if (!prev) throw new ApiError(404, "invalid_request_error", "response_not_found", `no response '${body.previous_response_id}'`, "previous_response_id");
      const s = this.store.getSession(prev.session_id);
      if (!s || s.expired) throw new ApiError(404, "invalid_request_error", "session_expired", "the session for this response has expired", "previous_response_id");
      if (requested !== "auto" && requested !== s.harness) {
        throw new ApiError(409, "invalid_request_error", "harness_mismatch", `session runs '${s.harness}', not '${requested}'`, "metadata.harness_id");
      }
      session = s;
      transcript = JSON.parse(s.transcript_json);
      const effort = body.reasoning?.effort ?? (prev.effort as Effort | null) ?? undefined;
      decision = {
        harness: s.harness,
        model: s.model,
        effort,
        option_id: `${s.harness}:${s.model}`,
        source: "session",
        objective: body.routing?.objective ?? "balanced",
        features: heuristicFeatures(promptOf(body)),
        est_cost_usd: 0,
        latency_ms: 0,
        candidates: [],
        reason: "continuation keeps the session's harness and model",
      };
      if (!this.store.claimSession(s.id)) {
        const replay = idemKey ? this.store.getByIdempotencyKey(idemKey) : undefined;
        if (replay?.request_hash === requestHash) return this.deliver(replay.id, body);
        throw new ApiError(409, "invalid_request_error", "session_busy", "a turn is already running in this session");
      }
    } else {
      decision = await this.route(body, requested);
      session = this.store.createSession({ id: newId("sess"), harness: decision.harness, model: decision.model });
      this.store.claimSession(session.id);
    }

    const id = newId("resp");
    const clientMetadata = { ...(body.metadata ?? {}) };
    const ignored = Object.keys(body).filter((k) => !HANDLED_FIELDS.has(k));
    const row: ResponseRow = {
      id,
      session_id: session.id,
      previous_response_id: body.previous_response_id ?? null,
      status: "in_progress",
      harness: decision.harness,
      model: decision.model,
      effort: decision.effort ?? null,
      input_text: promptOf(body),
      output_json: "[]",
      output_text: "",
      usage_json: null,
      cost_usd: null,
      error_json: null,
      metadata_json: JSON.stringify({ ...clientMetadata, ...(ignored.length ? { ignored_fields: ignored } : {}) }),
      idempotency_key: idemKey ?? null,
      request_hash: requestHash,
      created_at: Date.now(),
      completed_at: null,
      duration_ms: null,
      ...routeColumns(decision),
    };
    try {
      this.store.insertResponse(row);
    } catch (err) {
      this.store.updateSession(session.id, { busy: 0 });
      // Concurrent duplicate with the same idempotency key.
      if (idemKey && String(err).includes("UNIQUE")) return this.deliver(this.store.getByIdempotencyKey(idemKey)!.id, body);
      throw err;
    }

    this.startRun(row, session, decision, body, transcript);
    return this.deliver(id, body);
  }

  private async deliver(id: string, body: CreateBody): Promise<CreateResult> {
    if (body.stream) return { kind: "stream", id };
    if (!body.background) await this.active.get(id)?.finished;
    return { kind: "json", body: this.snapshot(id) };
  }

  // ---- execution -----------------------------------------------------------------------------

  private startRun(
    row: ResponseRow,
    session: SessionRow,
    decision: RouteDecision,
    body: CreateBody,
    transcript: { role: "user" | "assistant"; text: string }[],
  ): void {
    const run: ActiveRun = {
      events: [],
      listeners: new Set(),
      cancelRequested: false,
      finished: Promise.resolve(),
      builder: undefined as unknown as ResponseBuilder,
    };
    run.builder = new ResponseBuilder(
      (e) => {
        run.events.push(e);
        for (const l of run.listeners) l(e);
      },
      () => this.snapshot(row.id),
    );
    this.active.set(row.id, run);
    run.builder.start();
    run.finished = this.execute(row, session, decision, body, transcript, run).finally(() => {
      setTimeout(() => this.active.delete(row.id), 30_000).unref();
    });
  }

  private async execute(
    row: ResponseRow,
    session: SessionRow,
    decision: RouteDecision,
    body: CreateBody,
    transcript: { role: "user" | "assistant"; text: string }[],
    run: ActiveRun,
  ): Promise<void> {
    const started = Date.now();
    let status: ResponseStatus = "failed";
    try {
      const sandbox = await this.executor.ensureSandbox(session.id, session.sandbox_id);
      if (sandbox.id !== session.sandbox_id) this.store.updateSession(session.id, { sandbox_id: sandbox.id });
      if (run.cancelRequested) {
        status = "cancelled";
      } else {
        const harness = this.cfg.catalog.harnesses[decision.harness];
        const env: Record<string, string> = {};
        for (const k of HARNESS_ENV[decision.harness]) if (this.cfg.providerEnv[k]) env[k] = this.cfg.providerEnv[k]!;
        const spec: RunSpec = {
          run_id: row.id,
          harness: decision.harness,
          model: decision.model,
          ...(decision.effort ? { effort: decision.effort } : {}),
          prompt: row.input_text,
          cwd: sandbox.cwd,
          ...(harness.native_resume && session.harness_session_id ? { harness_session_id: session.harness_session_id } : {}),
          ...(!harness.native_resume && transcript.length ? { transcript } : {}),
          env,
          ...(body.max_step ? { max_turns: body.max_step } : {}),
          timeout_ms: body.timeout_seconds ? body.timeout_seconds * 1000 : this.cfg.defaultTimeoutMs,
        };
        run.handle = this.executor.run(sandbox, spec, (e) => run.builder.handle(e));
        const result = await run.handle.done;
        status = run.cancelRequested || result === "cancelled" ? "cancelled" : result;
      }
    } catch (err) {
      run.builder.error = { type: "server_error", code: "harness_unavailable", message: `sandbox unavailable: ${(err as Error).message}` };
      status = "failed";
    }

    const b = run.builder;
    const option = this.cfg.catalog.options.find((o) => o.id === decision.option_id);
    const cost =
      b.harnessCostUsd ?? (b.usage && option ? costFromUsage(option, b.usage.input_tokens + (b.usage.cache_read_tokens ?? 0) * 0.1, b.usage.output_tokens) : null);
    if (status === "failed" && !b.error) b.error = { type: "harness_error", code: "turn_failed", message: "the harness run failed" };

    this.store.updateResponse(row.id, {
      status,
      output_json: JSON.stringify(b.output),
      output_text: b.outputText(),
      usage_json: b.usage ? JSON.stringify(b.usage) : null,
      cost_usd: cost === null ? null : Math.round(cost * 1e6) / 1e6,
      error_json: status === "failed" && b.error ? JSON.stringify(b.error) : null,
      completed_at: Date.now(),
      duration_ms: Date.now() - started,
    });
    const nextTranscript = [...transcript, { role: "user" as const, text: row.input_text }];
    if (b.outputText()) nextTranscript.push({ role: "assistant", text: b.outputText() });
    this.store.updateSession(session.id, {
      busy: 0,
      last_used_at: Date.now(),
      harness_session_id: b.harnessSessionId ?? session.harness_session_id,
      transcript_json: JSON.stringify(nextTranscript.slice(-40)),
    });
    this.priors?.invalidate();
    b.finish(status);
  }

  // ---- read / cancel / feedback --------------------------------------------------------------

  snapshot(id: string): Record<string, unknown> {
    const row = this.store.getResponse(id);
    if (!row) throw new ApiError(404, "invalid_request_error", "response_not_found", `no response '${id}'`);
    const run = this.active.get(id);
    const live = row.status === "in_progress" && run;
    const output: OutputItem[] = live ? run.builder.output : JSON.parse(row.output_json);
    const usage: Usage | null = live ? run.builder.usage : row.usage_json ? JSON.parse(row.usage_json) : null;
    const error: ErrorInfo | null = row.error_json ? JSON.parse(row.error_json) : null;
    const route = row.route_json ? (JSON.parse(row.route_json) as RouteDecision) : null;
    return {
      id: row.id,
      object: "response",
      created_at: Math.floor(row.created_at / 1000),
      status: row.status,
      error,
      incomplete_details: null,
      previous_response_id: row.previous_response_id,
      model: row.model,
      output,
      output_text: live ? run.builder.outputText() : row.output_text,
      store: true,
      usage,
      metadata: {
        ...JSON.parse(row.metadata_json),
        session_id: row.session_id,
        harness_id: row.harness,
        ...(row.effort ? { reasoning_effort: row.effort } : {}),
        ...(route ? { route } : {}),
        ...(row.cost_usd !== null ? { cost_usd: row.cost_usd } : {}),
        ...(row.duration_ms !== null ? { duration_ms: row.duration_ms } : {}),
      },
    };
  }

  /** SSE subscription: replays everything so far, then streams live until the terminal event. */
  subscribe(id: string, onEvent: (e: SseEvent) => void): () => void {
    const run = this.active.get(id);
    if (!run) {
      // Finished (or from before a restart): minimal created + terminal replay.
      const snap = this.snapshot(id);
      const terminal =
        snap.status === "completed" ? "response.completed" : snap.status === "incomplete" ? "response.incomplete" : "response.failed";
      onEvent({ type: "response.created", sequence_number: 0, response: { ...snap, status: "in_progress", output: [] } });
      onEvent({ type: terminal, sequence_number: 1, response: snap });
      return () => {};
    }
    for (const e of run.events) onEvent(e);
    run.listeners.add(onEvent);
    return () => run.listeners.delete(onEvent);
  }

  async cancel(id: string): Promise<Record<string, unknown>> {
    const row = this.store.getResponse(id);
    if (!row) throw new ApiError(404, "invalid_request_error", "response_not_found", `no response '${id}'`);
    const run = this.active.get(id);
    if (row.status !== "in_progress" || !run) return this.snapshot(id);
    run.cancelRequested = true;
    await run.handle?.cancel();
    await Promise.race([run.finished, new Promise((r) => setTimeout(r, 1_000))]);
    return this.snapshot(id);
  }

  async cancelSession(sessionId: string): Promise<{ id: string; object: string; cancelled: string[] }> {
    if (!this.store.getSession(sessionId)) throw new ApiError(404, "invalid_request_error", "session_not_found", `no session '${sessionId}'`);
    const running = this.store.db
      .prepare(`SELECT id FROM responses WHERE session_id = ? AND status = 'in_progress'`)
      .all(sessionId) as { id: string }[];
    await Promise.all(running.map((r) => this.cancel(r.id)));
    return { id: sessionId, object: "session", cancelled: running.map((r) => r.id) };
  }

  delete(id: string): { id: string; object: string; deleted: boolean } {
    const row = this.store.getResponse(id);
    if (!row) throw new ApiError(404, "invalid_request_error", "response_not_found", `no response '${id}'`);
    if (row.status === "in_progress") throw new ApiError(409, "invalid_request_error", "jevroute.response_in_progress", "cancel the response before deleting it");
    this.store.deleteResponse(id);
    return { id, object: "response.deleted", deleted: true };
  }

  inputItems(id: string) {
    const row = this.store.getResponse(id);
    if (!row) throw new ApiError(404, "invalid_request_error", "response_not_found", `no response '${id}'`);
    return {
      object: "list",
      data: [{ id: `msg_in_${id.slice(5)}`, type: "message", role: "user", content: [{ type: "input_text", text: row.input_text }] }],
    };
  }

  feedback(id: string, raw: unknown) {
    const parsed = z.object({ score: z.number().min(0).max(1), comment: z.string().max(2000).optional() }).safeParse(raw);
    if (!parsed.success) throw new ApiError(400, "invalid_request_error", "invalid_input", "body must be {score: 0..1, comment?}");
    const row = this.store.getResponse(id);
    if (!row) throw new ApiError(404, "invalid_request_error", "response_not_found", `no response '${id}'`);
    this.store.setFeedback(id, parsed.data.score, parsed.data.comment);
    this.priors?.invalidate();
    return { id, object: "response.feedback", score: parsed.data.score };
  }

  /** Compact rows for the dashboard. */
  listRecent(limit: number) {
    return this.store.listResponses(limit).map((r) => {
      const route = r.route_json ? (JSON.parse(r.route_json) as RouteDecision) : null;
      return {
        id: r.id,
        session_id: r.session_id,
        status: r.status,
        harness_id: r.harness,
        model: r.model,
        reasoning_effort: r.effort,
        task_type: r.task_type,
        difficulty: route?.features.difficulty ?? null,
        route_source: r.route_source,
        route_reason: route?.reason ?? null,
        router_latency_ms: route?.latency_ms ?? null,
        est_cost_usd: r.est_cost_usd,
        cost_usd: r.cost_usd,
        duration_ms: r.duration_ms,
        created_at: Math.floor(r.created_at / 1000),
        input_preview: r.input_text.slice(0, 160),
      };
    });
  }

  stats() {
    const base = this.store.stats();
    // Savings vs always running the most capable eligible option, scaled by how far each
    // run's actual cost landed from its estimate.
    const rows = this.store.db
      .prepare(`SELECT route_json, cost_usd FROM responses WHERE route_json IS NOT NULL AND cost_usd IS NOT NULL`)
      .all() as { route_json: string; cost_usd: number }[];
    let baseline = 0;
    let actual = 0;
    let counted = 0;
    for (const r of rows) {
      const d = JSON.parse(r.route_json) as RouteDecision;
      if (!d.baseline_est_cost_usd || !d.est_cost_usd) continue;
      baseline += d.baseline_est_cost_usd * (r.cost_usd / d.est_cost_usd);
      actual += r.cost_usd;
      counted++;
    }
    return {
      ...base,
      savings: {
        baseline: "most capable eligible option for each task",
        runs_counted: counted,
        baseline_cost_usd: round(baseline),
        actual_cost_usd: round(actual),
        saved_usd: round(baseline - actual),
      },
    };
  }

  // ---- housekeeping --------------------------------------------------------------------------

  async reap(now = Date.now()): Promise<void> {
    const staleBefore = now - this.cfg.sessionRetentionMs;
    for (const s of this.store.staleSessions(staleBefore)) {
      if (!this.store.lockForReap(s.id, staleBefore)) continue;
      await this.executor.destroySandbox(s.id, s.sandbox_id);
      this.store.updateSession(s.id, { expired: 1, sandbox_id: null, busy: 0 });
    }
    const idleBefore = now - this.cfg.containerIdleMs;
    for (const s of this.store.idleSessions(idleBefore)) {
      if (!this.store.lockForReap(s.id, idleBefore)) continue;
      await this.executor.stopSandbox(s.sandbox_id!);
      this.store.updateSession(s.id, { sandbox_id: null, busy: 0 });
    }
  }

  private emptyInstalled(): Record<HarnessId, boolean> {
    return Object.fromEntries(HARNESS_IDS.map((h) => [h, false])) as Record<HarnessId, boolean>;
  }
}

export function normalizeHarnessId(id: string): string {
  return id.startsWith("chrn_") ? id.slice(5) : id;
}

export function parseBody(raw: unknown): CreateBody {
  const parsed = CreateBody.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0]!;
    throw new ApiError(400, "invalid_request_error", "invalid_input", issue.message, issue.path.join(".") || null);
  }
  return parsed.data;
}

export function promptOf(body: CreateBody): string {
  const parts: string[] = [];
  if (typeof body.input === "string") parts.push(body.input);
  else {
    for (const item of body.input) {
      if (item.role && item.role !== "user" && item.role !== "system" && item.role !== "developer") continue;
      if (typeof item.content === "string") parts.push(item.content);
      else if (Array.isArray(item.content)) {
        for (const c of item.content) if (typeof c.text === "string") parts.push(c.text);
      } else if (typeof item.text === "string") parts.push(item.text);
    }
  }
  const text = parts.join("\n\n").trim();
  if (!text) throw new ApiError(400, "invalid_request_error", "invalid_input", "input contains no text", "input");
  return body.instructions ? `${body.instructions.trim()}\n\n${text}` : text;
}

function numberOrUndefined(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : undefined;
}

function round(v: number): number {
  return Math.round(v * 1e4) / 1e4;
}

function stableStringify(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(",")}]`;
  if (v && typeof v === "object") {
    return `{${Object.keys(v)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableStringify((v as Record<string, unknown>)[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(v);
}
