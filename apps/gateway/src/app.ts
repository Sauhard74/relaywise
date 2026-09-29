import { createHash, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { Hono, type Context } from "hono";
import { stream } from "hono/streaming";
import { ApiError, type GatewayService } from "./service.ts";

export const UHP_VERSION = "2026-09-12";
const KEEPALIVE_MS = 15_000;
const DASHBOARD_HTML = readFileSync(new URL("../public/dashboard.html", import.meta.url), "utf8");

export function createApp(service: GatewayService, apiKeys: string[]): Hono {
  const app = new Hono();
  const keyDigests = apiKeys.map(sha256);

  app.use("*", async (c, next) => {
    await next();
    c.header("UHP-Version", UHP_VERSION);
    c.header("X-Content-Type-Options", "nosniff");
  });

  app.onError((err, c) => {
    if (err instanceof ApiError) return errorResponse(c, err);
    console.error(err);
    return errorResponse(c, new ApiError(500, "server_error", "jevroute.internal_error", "internal server error"));
  });
  app.notFound((c) => errorResponse(c, new ApiError(404, "invalid_request_error", "jevroute.not_found", `no route ${c.req.method} ${c.req.path}`)));

  // ---- version negotiation ---------------------------------------------------------------------
  app.use("*", async (c, next) => {
    const asked = c.req.header("uhp-version");
    if (asked && asked !== UHP_VERSION) {
      throw new ApiError(400, "invalid_request_error", "unsupported_protocol_version", `UHP-Version ${asked} is not supported`, null, {
        supported: [UHP_VERSION],
      });
    }
    return next();
  });

  // ---- public ---------------------------------------------------------------------------------
  app.get("/", (c) => c.redirect("/dashboard"));
  app.get("/healthz", (c) => c.json({ ok: true }));
  app.get("/dashboard", (c) => c.html(DASHBOARD_HTML));
  app.get("/v1/uhp", (c) =>
    c.json({
      object: "uhp.discovery",
      protocol: "uhp",
      versions: [UHP_VERSION],
      default_version: UHP_VERSION,
      conformance_class: "core",
      implementation: { name: "jev-route", version: "0.1.0" },
      capabilities: {
        streaming: true,
        sessions: true,
        cancellation: true,
        idempotency: true,
        files_input: false,
        files_output: false,
        session_listing: false,
        harness_management: false,
        session_sharing: false,
        plugins: false,
        "jevroute.auto_routing": true,
      },
    }),
  );

  // ---- auth -----------------------------------------------------------------------------------
  const requireAuth = async (c: Context, next: () => Promise<void>) => {
    if (keyDigests.length === 0) return next();
    const header = c.req.header("authorization") ?? "";
    const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
    const digest = sha256(token);
    if (!token) throw new ApiError(401, "authentication_error", "missing_credential", "missing API key");
    if (!keyDigests.some((k) => timingSafeEqual(k, digest))) {
      throw new ApiError(401, "authentication_error", "invalid_credential", "invalid API key");
    }
    return next();
  };
  app.use("/v1/*", async (c, next) => (c.req.path === "/v1/uhp" ? next() : requireAuth(c, next)));
  app.use("/api/*", requireAuth);
  app.use("/:harness/v1/*", requireAuth);

  // ---- discovery ------------------------------------------------------------------------------
  app.get("/v1/harnesses", (c) => c.json(service.listHarnesses()));
  app.get("/v1/harnesses/:id", (c) => {
    const h = service.getHarness(c.req.param("id"));
    if (!h) throw new ApiError(404, "invalid_request_error", "harness_not_found", `unknown harness '${c.req.param("id")}'`);
    return c.json(h);
  });
  app.get("/v1/harnesses/:id/models", (c) => c.json(service.harnessModels(c.req.param("id"))));
  app.get("/v1/models", (c) => c.json(service.listModels()));

  // ---- routing --------------------------------------------------------------------------------
  app.post("/v1/route", async (c) => c.json(await service.dryRoute(await jsonBody(c))));

  // ---- responses ------------------------------------------------------------------------------
  const createHandler = (harnessFromPath?: (c: Context) => string) => async (c: Context) => {
    const body = (await jsonBody(c)) as Record<string, unknown>;
    if (harnessFromPath) {
      const metadata = (body.metadata as Record<string, unknown> | undefined) ?? {};
      body.metadata = { ...metadata, harness_id: metadata.harness_id ?? harnessFromPath(c) };
    }
    const result = await service.create(body, {
      idempotencyKey: c.req.header("idempotency-key"),
      harnessId: c.req.header("x-harness-id"),
      projectId: c.req.header("x-project-id"),
    });
    if (result.kind === "json") return c.json(result.body);
    return sse(c, service, result.id);
  };
  app.post("/v1/responses", createHandler());
  app.post("/api/harness/v1/responses", createHandler()); // HarnessRouter CE path
  app.post("/:harness/v1/responses", createHandler((c) => c.req.param("harness")!)); // HarnessRouter Cloud path

  app.get("/v1/responses", (c) => {
    const limit = Math.min(200, Math.max(1, Number(c.req.query("limit") ?? 50)));
    return c.json({ object: "list", data: service.listRecent(limit) });
  });
  app.get("/v1/responses/:id", (c) => {
    if (c.req.query("stream") === "true") return sse(c, service, c.req.param("id"));
    return c.json(service.snapshot(c.req.param("id")));
  });
  app.get("/v1/responses/:id/input_items", (c) => c.json(service.inputItems(c.req.param("id"))));
  app.delete("/v1/responses/:id", (c) => c.json(service.delete(c.req.param("id"))));
  app.post("/v1/responses/:id/cancel", async (c) => c.json(await service.cancel(c.req.param("id"))));
  app.post("/v1/responses/:id/feedback", async (c) => c.json(service.feedback(c.req.param("id"), await jsonBody(c))));
  app.post("/v1/sessions/:id/cancel", async (c) => c.json(await service.cancelSession(c.req.param("id"))));

  app.get("/v1/stats", (c) => c.json(service.stats()));

  app.get("/v1/projects/:id", (c) => c.json(service.getProject(c.req.param("id"))));
  app.get("/v1/projects/:id/memory", async (c) => {
    const turn = c.req.query("turn") ? Number(c.req.query("turn")) : undefined;
    if (turn !== undefined && !(Number.isInteger(turn) && turn > 0)) {
      throw new ApiError(400, "invalid_request_error", "invalid_input", "turn must be a positive integer", "turn");
    }
    const text = await service.projectMemory(c.req.param("id"), turn);
    return c.body(text, 200, { "Content-Type": "text/markdown; charset=utf-8" });
  });
  app.delete("/v1/projects/:id", async (c) => c.json(await service.deleteProject(c.req.param("id"))));
  app.post("/v1/projects/:id/sync", async (c) => {
    const tar = Buffer.from(await c.req.arrayBuffer());
    if (tar.length > 200 * 1024 * 1024) throw new ApiError(413, "invalid_request_error", "jevroute.too_large", "workspace upload is over 200 MB");
    return c.json(await service.syncProject(validProject(c.req.param("id")), tar));
  });
  app.get("/v1/projects/:id/diff", async (c) =>
    c.body(await service.projectDiff(c.req.param("id"), c.req.query("commit") ?? ""), 200, {
      "Content-Type": "text/x-diff; charset=utf-8",
    }),
  );

  return app;
}

function sse(c: Context, service: GatewayService, id: string) {
  service.snapshot(id); // 404s before we commit to a stream
  c.header("Content-Type", "text/event-stream");
  c.header("Cache-Control", "no-cache");
  c.header("Connection", "keep-alive");
  c.header("X-Accel-Buffering", "no");
  return stream(c, async (s) => {
    const queue: string[] = [];
    let wake: (() => void) | undefined;
    let done = false;
    const unsubscribe = service.subscribe(id, (e) => {
      queue.push(`data: ${JSON.stringify(e)}\n\n`);
      if (e.type === "response.completed" || e.type === "response.failed" || e.type === "response.incomplete") done = true;
      wake?.();
    });
    s.onAbort(() => {
      done = true;
      wake?.();
    });
    try {
      while (true) {
        while (queue.length) await s.write(queue.shift()!);
        if (done || s.aborted) break;
        const timedOut = await new Promise<boolean>((resolve) => {
          const t = setTimeout(() => resolve(true), KEEPALIVE_MS);
          wake = () => {
            clearTimeout(t);
            resolve(false);
          };
        });
        wake = undefined;
        if (timedOut && !done) await s.write(": keepalive\n\n");
      }
    } finally {
      unsubscribe();
    }
  });
}

async function jsonBody(c: Context): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    throw new ApiError(400, "invalid_request_error", "invalid_input", "request body must be valid JSON");
  }
}

function errorResponse(c: Context, err: ApiError) {
  return c.json(
    {
      error: { type: err.type, code: err.code, message: err.message, param: err.param, ...(err.detail ? { detail: err.detail } : {}) },
      detail: err.message,
    },
    err.status as 400,
  );
}

function validProject(id: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(id)) {
    throw new ApiError(400, "invalid_request_error", "invalid_input", "invalid project id", "id");
  }
  return id;
}

function sha256(s: string): Buffer {
  return createHash("sha256").update(s).digest();
}
