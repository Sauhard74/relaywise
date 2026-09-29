import { render } from "ink";
import { parseArgs } from "node:util";
import { Gateway, type Settings } from "./client.ts";
import { printMode } from "./print.ts";
import { Session } from "./session.ts";
import { App } from "./ui/App.tsx";
import { projectIdFor } from "./workspace.ts";

const VERSION = "0.1.0";

const USAGE = `jev — a terminal coding agent; Jev routes every request to the best agent

Usage
  jev                     interactive session in the current directory
  jev -p "<task>"         run one task and print the result (exit 1 on failure)
  jev memory [turn]       print this project's ledger (or one turn in full)
  jev status              gateway and agent availability

Options
  --harness <name>        auto (default) | claude-code | codex | opencode | hermes
  --model <id>            pin a model
  --effort <level>        low | medium | high | xhigh | max
  --objective <mode>      cheapest | balanced (default) | best
  --budget <usd>          refuse routes estimated above this
  --project <id>          project id (default: derived from this directory)
  --no-sync               don't mirror local files or apply changes back
  --json                  with -p: print the final response as JSON
  --url <url>             gateway (default $JEV_ROUTE_URL or http://127.0.0.1:8420)
  --key <key>             gateway API key (default $JEV_ROUTE_KEY)
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
    (values.url ?? process.env.JEV_ROUTE_URL ?? "http://127.0.0.1:8420").replace(/\/+$/, ""),
    values.key ?? process.env.JEV_ROUTE_KEY,
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
    process.stderr.write(`jev: ${err.message}\n`);
    process.exit(1);
  },
);
