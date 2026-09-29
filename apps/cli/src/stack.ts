/**
 * `relay up | down | logs`: runs the relaywise gateway locally with Docker, using images
 * published for this exact CLI version — the way `supabase start` does. Config lives in
 * ~/.relaywise (override with RELAYWISE_HOME).
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";

const REGISTRY = "ghcr.io/sauhard74";

export interface StackOptions {
  version: string;
  port: number;
  reconfigure?: boolean;
}

const home = () => process.env.RELAYWISE_HOME ?? join(homedir(), ".relaywise");
const composePath = () => join(home(), "compose.yml");
const envPath = () => join(home(), ".env");
const project = () => process.env.RELAYWISE_PROJECT ?? "relaywise";
const codexLogin = () => join(homedir(), ".codex-relaywise", "auth.json");

export function images(version: string) {
  return {
    gateway: process.env.RELAYWISE_GATEWAY_IMAGE ?? `${REGISTRY}/relaywise-gateway:${version}`,
    runtime: process.env.RELAYWISE_RUNTIME_IMAGE ?? `${REGISTRY}/relaywise-runtime:${version}`,
  };
}

/** Keys asked for on first run. Any one provider is enough to start. */
const KEYS: { name: string; label: string }[] = [
  { name: "TYPESAFE_API_KEY", label: "TypeSafe API key (for Jev routing; blank = keyword fallback)" },
  { name: "ANTHROPIC_API_KEY", label: "Anthropic API key (Claude Code)" },
  { name: "CLAUDE_CODE_OAUTH_TOKEN", label: "…or a Claude subscription token from `claude setup-token`" },
  { name: "OPENAI_API_KEY", label: "OpenAI API key (Codex)" },
  { name: "OPENROUTER_API_KEY", label: "OpenRouter API key (OpenCode, Hermes)" },
];

function say(s = ""): void {
  process.stderr.write(`${s}\n`);
}

function docker(args: string[], opts: { quiet?: boolean } = {}): { ok: boolean; out: string } {
  const r = spawnSync("docker", args, { encoding: "utf8", stdio: opts.quiet ? "pipe" : ["ignore", "pipe", "pipe"] });
  return { ok: r.status === 0, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

function run(args: string[]): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn("docker", args, { stdio: "inherit" });
    child.on("close", (code) => resolve(code ?? 1));
    child.on("error", () => resolve(127));
  });
}

function checkDocker(): string | null {
  if (spawnSync("docker", ["--version"], { stdio: "ignore" }).error) {
    return "Docker isn't installed. Install Docker Desktop (or Docker Engine) and run `relay up` again.";
  }
  if (!docker(["info", "--format", "{{.ServerVersion}}"], { quiet: true }).ok) {
    return "Docker is installed but not running. Start Docker Desktop and run `relay up` again.";
  }
  if (!docker(["compose", "version"], { quiet: true }).ok) {
    return "Docker Compose v2 is missing. Update Docker so `docker compose` works.";
  }
  return null;
}

async function ask(rl: ReturnType<typeof createInterface>, q: string): Promise<string> {
  return new Promise((resolve) => rl.question(q, (a) => resolve(a.trim())));
}

/** Creates ~/.relaywise/.env on first run: from the environment, or by asking. */
async function ensureEnv(reconfigure: boolean): Promise<void> {
  const path = envPath();
  const existing = existsSync(path) ? parseEnv(readFileSync(path, "utf8")) : {};
  if (existsSync(path) && !reconfigure) return;

  const values: Record<string, string> = { ...existing };
  for (const k of KEYS) if (process.env[k.name] && !values[k.name]) values[k.name] = process.env[k.name]!;

  if (process.stdin.isTTY) {
    say("\nrelaywise needs at least one agent provider. Press enter to skip any of these;");
    say(`they're saved to ${path} (readable only by you). Re-run with \`relay up --reconfigure\` to change them.\n`);
    const rl = createInterface({ input: process.stdin, output: process.stderr });
    for (const k of KEYS) {
      const current = values[k.name] ? " [keep current]" : "";
      const answer = await ask(rl, `  ${k.label}${current}: `);
      if (answer) values[k.name] = answer;
    }
    rl.close();
    if (!existsSync(codexLogin())) {
      say("\n  Codex with a ChatGPT plan instead of an API key: run `CODEX_HOME=~/.codex-relaywise codex login`,");
      say("  then `relay up` again.");
    }
  }
  if (!KEYS.slice(1).some((k) => values[k.name]) && !existsSync(codexLogin())) {
    say("\nNo agent credentials yet — the gateway will start, but no agent can run until you add one.");
  }
  mkdirSync(home(), { recursive: true });
  writeFileSync(
    path,
    `${Object.entries(values)
      .filter(([, v]) => v)
      .map(([k, v]) => `${k}=${v}`)
      .join("\n")}\n`,
  );
  chmodSync(path, 0o600);
}

function parseEnv(text: string): Record<string, string> {
  return Object.fromEntries(
    text
      .split("\n")
      .map((l) => l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/))
      .filter((m): m is RegExpMatchArray => m !== null)
      .map((m) => [m[1]!, m[2]!]),
  );
}

export function composeFile(version: string, port: number): string {
  const img = images(version);
  const codex = existsSync(codexLogin());
  return `# Written by \`relay up\` (relaywise ${version}). Edit keys in .env; this file is regenerated.
name: ${project()}
services:
  gateway:
    image: ${img.gateway}
    env_file: .env
    environment:
      RELAYWISE_IMAGE: ${img.runtime}
      RELAYWISE_INSTANCE: ${project()}${codex ? "\n      CODEX_AUTH_FILE: /run/codex/auth.json" : ""}
    ports:
      - "127.0.0.1:${port}:8420"
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
      - relaywise-data:/app/data${codex ? `\n      - ${join(homedir(), ".codex-relaywise")}:/run/codex:ro` : ""}
    restart: unless-stopped
volumes:
  relaywise-data:
`;
}

async function waitHealthy(port: number, timeoutMs = 90_000): Promise<boolean> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/healthz`);
      if (res.ok) return true;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  return false;
}

export async function up(opts: StackOptions): Promise<number> {
  const problem = checkDocker();
  if (problem) {
    say(problem);
    return 1;
  }
  await ensureEnv(Boolean(opts.reconfigure));
  writeFileSync(composePath(), composeFile(opts.version, opts.port));

  const img = images(opts.version);
  say(`\nPulling relaywise ${opts.version} images (the agent sandbox is ~2 GB the first time)…`);
  // RELAYWISE_*_IMAGE overrides point at local builds, which aren't in a registry.
  const local = Boolean(process.env.RELAYWISE_GATEWAY_IMAGE || process.env.RELAYWISE_RUNTIME_IMAGE);
  for (const image of local ? [] : [img.gateway, img.runtime]) {
    if ((await run(["pull", image])) !== 0) {
      say(`\nCouldn't pull ${image}. Check your network, or build from source: https://github.com/Sauhard74/relaywise`);
      return 1;
    }
  }
  if ((await run(["compose", "-f", composePath(), "up", "-d", "--remove-orphans"])) !== 0) return 1;

  say("\nWaiting for the gateway…");
  if (!(await waitHealthy(opts.port))) {
    say(`It didn't come up in time. See \`relay logs\`.`);
    return 1;
  }
  const h = (await (await fetch(`http://127.0.0.1:${opts.port}/v1/harnesses`)).json()) as {
    harnesses: { base: string; available: boolean; unavailable_reasons?: string[]; routing?: { engine: string } }[];
  };
  say(`\nrelaywise is running at http://127.0.0.1:${opts.port}  (dashboard: /dashboard)\n`);
  for (const x of h.harnesses) {
    if (x.base === "auto") {
      say(`  routing   ${x.routing?.engine === "jev" ? "Jev" : "keyword rules (add TYPESAFE_API_KEY for Jev)"}`);
      continue;
    }
    say(`  ${x.available ? "●" : "○"} ${x.base.padEnd(12)}${x.available ? "ready" : (x.unavailable_reasons ?? []).join("; ")}`);
  }
  say(`\nNext: cd into a repo and run \`relay\`.${opts.port !== 8420 ? ` (set RELAYWISE_URL=http://127.0.0.1:${opts.port})` : ""}`);
  return 0;
}

export async function down(): Promise<number> {
  if (!existsSync(composePath())) {
    say("relaywise isn't set up here yet — nothing to stop.");
    return 0;
  }
  const code = await run(["compose", "-f", composePath(), "down"]);
  // Session sandboxes are started by the gateway, not compose; stop those too.
  const ids = docker(["ps", "-aq", "--filter", `label=relaywise.instance=${project()}`], { quiet: true }).out.trim().split("\n").filter(Boolean);
  if (ids.length) docker(["rm", "-f", ...ids], { quiet: true });
  if (code === 0) say("relaywise stopped. Your projects and history are kept; `relay up` starts it again.");
  return code;
}

export async function logs(): Promise<number> {
  if (!existsSync(composePath())) {
    say("relaywise isn't set up yet — run `relay up`.");
    return 1;
  }
  return run(["compose", "-f", composePath(), "logs", "-f", "--tail", "100", "gateway"]);
}
