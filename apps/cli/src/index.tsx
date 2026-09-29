import { render } from "ink";
import { parseArgs } from "node:util";
import { Gateway, type Settings } from "./client.ts";
import { printMode } from "./print.ts";
import { Session } from "./session.ts";
import { down, logs, up } from "./stack.ts";
import { App } from "./ui/App.tsx";
import { projectIdFor } from "./workspace.ts";

const VERSION = "0.2.0";

const USAGE = `relay — a terminal coding agent (relaywise); every request goes to the right agent,
        model and effort, chosen with TypeSafe's Jev

Usage
  relay up                start the relaywise gateway with Docker (asks for keys the first time)
  relay down | logs       stop it, or follow its logs
  relay                   interactive session in the current directory
  relay -p "<task>"       run one task and print the result (exit 1 on failure)
  relay memory [turn]     print this project's ledger (or one turn in full)
  relay status            gateway and agent availability

Options
  --harness <name>        auto (default) | claude-code | codex | opencode | hermes
  --model <id>            pin a model
  --effort <level>        low | medium | high | xhigh | max
  --objective <mode>      cheapest | balanced (default) | best
  --budget <usd>          refuse routes estimated above this
  --project <id>          project id (default: derived from this directory)
  --no-sync               don't mirror local files or apply changes back
  --json                  with -p: print the final response as JSON
  --port <n>              with up: local port (default 8420)
  --reconfigure           with up: ask for keys again
  --url <url>             gateway (default $RELAYWISE_URL or http://127.0.0.1:8420)
  --key <key>             gateway API key (default $RELAYWISE_KEY)
  -v, --version · -h, --help
`;

async function main(): Promise<number> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      print: { type: "string", short: "p" },
      json: { type: "boolean" },
      harness: { type: "string", default: "auto" },
      model: { type: "string" },
      effort: { type: "string" },
      objective: { type: "string", default: "balanced" },
      budget: { type: "string" },
      project: { type: "string" },
      "no-sync": { type: "boolean" },
      url: { type: "string" },
      key: { type: "string" },
      port: { type: "string", default: "8420" },
      reconfigure: { type: "boolean" },
      help: { type: "boolean", short: "h" },
      version: { type: "boolean", short: "v" },
    },
  });
  if (values.help) {
    process.stdout.write(USAGE);
    return 0;
  }
  if (values.version) {
    process.stdout.write(`${VERSION}\n`);
    return 0;
  }

  const gateway = new Gateway(
    (values.url ?? process.env.RELAYWISE_URL ?? "http://127.0.0.1:8420").replace(/\/+$/, ""),
    values.key ?? process.env.RELAYWISE_KEY,
  );
  const settings: Settings = {
    harness: values.harness!,
    model: values.model,
    effort: values.effort,
    objective: values.objective as Settings["objective"],
    budget: values.budget ? Number(values.budget) : undefined,
  };
  const cwd = process.cwd();
  const session = new Session(gateway, cwd, values.project ?? projectIdFor(cwd), settings, !values["no-sync"]);

  const [sub, arg] = positionals;
  if (sub === "up") return up({ version: VERSION, port: Number(values.port), reconfigure: values.reconfigure });
  if (sub === "down") return down();
  if (sub === "logs") return logs();
  if (sub === "memory") {
    process.stdout.write(`${await gateway.memory(session.project, arg ? Number(arg) : undefined)}\n`);
    return 0;
  }
  if (sub === "status") {
    const h = await gateway.harnesses();
    for (const x of h.harnesses) {
      process.stdout.write(`${x.available ? "●" : "○"} ${x.base.padEnd(12)} ${x.available ? "" : (x.unavailable_reasons ?? []).join("; ")}\n`);
    }
    return 0;
  }
  if (sub) {
    process.stderr.write(`unknown command '${sub}'\n\n${USAGE}`);
    return 2;
  }

  const prompt = values.print ?? (!process.stdin.isTTY ? await readStdin() : undefined);
  if (prompt !== undefined) {
    if (!prompt.trim()) {
      process.stderr.write("empty prompt\n");
      return 2;
    }
    return printMode(session, prompt, Boolean(values.json));
  }

  const app = render(<App session={session} version={VERSION} />, { exitOnCtrlC: false });
  await app.waitUntilExit();
  return 0;
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

main().then(
  (code) => process.exit(code),
  (err: Error) => {
    process.stderr.write(`relay: ${err.message}\n`);
    process.exit(1);
  },
);
