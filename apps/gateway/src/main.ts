import { serve } from "@hono/node-server";
import { JevClient, Router } from "@jev-route/router";
import { createApp } from "./app.ts";
import { loadConfig } from "./config.ts";
import { DockerExecutor } from "./executors/docker.ts";
import { LocalExecutor } from "./executors/local.ts";
import { GatewayService } from "./service.ts";
import { Store, StorePriors } from "./store.ts";

const cfg = loadConfig();
const store = new Store(cfg.dbPath);
const priors = new StorePriors(store);
const executor =
  cfg.executor === "local"
    ? new LocalExecutor(cfg.workspacesDir, cfg.enableMock)
    : new DockerExecutor({
        image: cfg.dockerImage,
        network: cfg.dockerNetwork,
        cpus: cfg.containerCpus,
        memory: cfg.containerMemory,
        enableMock: cfg.enableMock,
      });

const service: GatewayService = new GatewayService(
  cfg,
  store,
  executor,
  new Router({
    catalog: cfg.catalog,
    jev: cfg.typesafeApiKey
      ? new JevClient({ apiKey: cfg.typesafeApiKey, baseUrl: cfg.typesafeBaseUrl, model: cfg.jevModel })
      : undefined,
    deadlineMs: cfg.jevDeadlineMs,
    priors,
    isAvailable: (o) => service.isOptionAvailable(o),
  }),
  priors,
);
await service.init();
service.startReaper();

const app = createApp(service, cfg.apiKeys);
const server = serve({ fetch: app.fetch, port: cfg.port, hostname: cfg.host }, (info) => {
  const harnesses = service
    .listHarnesses()
    .data.filter((h) => h.id !== "auto")
    .map((h) => `${h.id}${h.available ? "" : " (unavailable)"}`)
    .join(", ");
  console.log(`jev-route listening on http://${info.address}:${info.port}  (executor=${cfg.executor})`);
  console.log(`  routing: ${cfg.typesafeApiKey ? `Jev (${cfg.jevModel}, deadline ${cfg.jevDeadlineMs}ms)` : "heuristic only — set TYPESAFE_API_KEY for Jev"}`);
  console.log(`  harnesses: ${harnesses}`);
  if (cfg.apiKeys.length === 0) console.warn("  WARNING: JEV_ROUTE_API_KEYS is not set — the API is unauthenticated");
});

const shutdown = async () => {
  await service.shutdown();
  server.close();
  store.close();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
