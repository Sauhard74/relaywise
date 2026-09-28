import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { DEFAULT_CATALOG, type Catalog } from "@jev-route/core";

/** Provider credentials forwarded into sandboxes (only when set). */
export const PROVIDER_ENV_KEYS = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_BASE_URL",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "OPENAI_API_KEY",
  "OPENAI_BASE_URL",
  "CODEX_API_KEY",
  "OPENROUTER_API_KEY",
] as const;

export interface Config {
  port: number;
  host: string;
  apiKeys: string[];
  executor: "docker" | "local";
  dockerImage: string;
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

  return {
    port: num("PORT", 8787),
    host: env.HOST ?? "127.0.0.1",
    apiKeys: (env.JEV_ROUTE_API_KEYS ?? "").split(",").map((s) => s.trim()).filter(Boolean),
    executor: env.JEV_ROUTE_EXECUTOR === "local" ? "local" : "docker",
    dockerImage: env.JEV_ROUTE_IMAGE ?? "jev-route/agent-runtime:latest",
    dockerNetwork: env.JEV_ROUTE_CONTAINER_NETWORK ?? "bridge",
    containerCpus: env.JEV_ROUTE_CONTAINER_CPUS ?? "2",
    containerMemory: env.JEV_ROUTE_CONTAINER_MEMORY ?? "4g",
    dbPath: resolve(env.JEV_ROUTE_DB ?? "data/jev-route.db"),
    workspacesDir: resolve(env.JEV_ROUTE_WORKSPACES ?? "data/workspaces"),
    typesafeApiKey: env.TYPESAFE_API_KEY || undefined,
    typesafeBaseUrl: env.TYPESAFE_BASE_URL || undefined,
    jevModel: env.JEV_MODEL ?? "jev-latest",
    jevDeadlineMs: num("JEV_DEADLINE_MS", 900),
    enableMock: env.JEV_ROUTE_ENABLE_MOCK === "1",
    defaultTimeoutMs: num("JEV_ROUTE_RUN_TIMEOUT_MS", 30 * 60_000),
    containerIdleMs: num("JEV_ROUTE_CONTAINER_IDLE_MS", 10 * 60_000),
    sessionRetentionMs: num("JEV_ROUTE_SESSION_RETENTION_MS", 24 * 60 * 60_000),
    providerEnv,
    catalog: env.JEV_ROUTE_CATALOG ? loadCatalog(env.JEV_ROUTE_CATALOG) : DEFAULT_CATALOG,
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
