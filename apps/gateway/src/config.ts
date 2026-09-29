import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { DEFAULT_CATALOG, type Catalog } from "@relaywise/core";

/** Provider credentials forwarded into sandboxes (only when set). */
export const PROVIDER_ENV_KEYS = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_BASE_URL",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "OPENAI_API_KEY",
  "OPENAI_BASE_URL",
  "CODEX_API_KEY",
  "CODEX_AUTH_JSON",
  "OPENROUTER_API_KEY",
] as const;

export interface Config {
  port: number;
  host: string;
  apiKeys: string[];
  executor: "docker" | "local";
  dockerImage: string;
  /** Labels this gateway's session containers, so several gateways can share one Docker. */
  instance: string;
  dockerNetwork: string;
  containerCpus: string;
  containerMemory: string;
  dbPath: string;
  workspacesDir: string;
  typesafeApiKey?: string;
  typesafeBaseUrl?: string;
  jevModel: string;
  jevDeadlineMs: number;
  enableMock: boolean;
  defaultTimeoutMs: number;
  containerIdleMs: number;
  sessionRetentionMs: number;
  providerEnv: Record<string, string>;
  catalog: Catalog;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const num = (k: string, d: number) => (env[k] ? Number(env[k]) : d);
  const providerEnv: Record<string, string> = {};
  for (const k of PROVIDER_ENV_KEYS) if (env[k]) providerEnv[k] = env[k]!;
  // A ChatGPT login for Codex: the contents of ~/.codex/auth.json (after `codex login`).
  if (env.CODEX_AUTH_FILE && !providerEnv.CODEX_AUTH_JSON) {
    try {
      providerEnv.CODEX_AUTH_JSON = readFileSync(env.CODEX_AUTH_FILE, "utf8").trim();
    } catch (err) {
      console.warn(`  WARNING: cannot read CODEX_AUTH_FILE (${(err as Error).message}); Codex ChatGPT login disabled`);
    }
  }

  return {
    port: num("PORT", 8420),
    host: env.HOST ?? "127.0.0.1",
    apiKeys: (env.RELAYWISE_API_KEYS ?? "").split(",").map((s) => s.trim()).filter(Boolean),
    executor: env.RELAYWISE_EXECUTOR === "local" ? "local" : "docker",
    dockerImage: env.RELAYWISE_IMAGE ?? "relaywise/agent-runtime:latest",
    instance: env.RELAYWISE_INSTANCE ?? "relaywise",
    dockerNetwork: env.RELAYWISE_CONTAINER_NETWORK ?? "bridge",
    containerCpus: env.RELAYWISE_CONTAINER_CPUS ?? "2",
    containerMemory: env.RELAYWISE_CONTAINER_MEMORY ?? "4g",
    dbPath: resolve(env.RELAYWISE_DB ?? "data/relaywise.db"),
    workspacesDir: resolve(env.RELAYWISE_WORKSPACES ?? "data/workspaces"),
    typesafeApiKey: env.TYPESAFE_API_KEY || undefined,
    typesafeBaseUrl: env.TYPESAFE_BASE_URL || undefined,
    jevModel: env.JEV_MODEL ?? "jev-latest",
    jevDeadlineMs: num("JEV_DEADLINE_MS", 900),
    enableMock: env.RELAYWISE_ENABLE_MOCK === "1",
    defaultTimeoutMs: num("RELAYWISE_RUN_TIMEOUT_MS", 30 * 60_000),
    containerIdleMs: num("RELAYWISE_CONTAINER_IDLE_MS", 10 * 60_000),
    sessionRetentionMs: num("RELAYWISE_SESSION_RETENTION_MS", 24 * 60 * 60_000),
    providerEnv,
    catalog: env.RELAYWISE_CATALOG ? loadCatalog(env.RELAYWISE_CATALOG) : DEFAULT_CATALOG,
  };
}

/** A catalog file may replace `options` and/or override individual harness fields. */
function loadCatalog(path: string): Catalog {
  const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<Catalog>;
  return {
    harnesses: { ...DEFAULT_CATALOG.harnesses, ...(raw.harnesses ?? {}) },
    options: raw.options ?? DEFAULT_CATALOG.options,
  };
}
