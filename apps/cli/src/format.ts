import type { ResponseObject, RouteDecision } from "./client.ts";

/** relaywise turquoise. */
export const ACCENT = "#30d5c8";
export const DIFFICULTY = ["", "trivial", "easy", "moderate", "hard", "very hard"];

export function usd(v: number | undefined | null): string {
  if (v === undefined || v === null) return "—";
  if (v === 0) return "$0";
  return v < 0.01 ? `$${v.toFixed(4)}` : `$${v.toFixed(2)}`;
}

export function duration(ms: number | undefined | null): string {
  if (ms === undefined || ms === null) return "—";
  if (ms < 1000) return `${ms}ms`;
  const s = ms / 1000;
  return s < 60 ? `${s.toFixed(1)}s` : `${Math.floor(s / 60)}m ${Math.round(s % 60)}s`;
}

export function clip(s: string, n: number): string {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > n ? `${flat.slice(0, n - 1)}…` : flat;
}

export function routeLine(d: RouteDecision): { head: string; meta: string } {
  const head = `${d.harness} · ${d.model}${d.effort ? ` · ${d.effort}` : ""}`;
  const via = d.source === "jev" ? `Jev ${d.latency_ms}ms` : d.source === "cache" ? "Jev (cached)" : d.source;
  const task = d.features ? `${DIFFICULTY[d.features.difficulty] ?? ""} ${d.features.task_type.replace("_", " ")}` : "";
  const est = d.est_cost_usd ? ` · est ${usd(d.est_cost_usd)}` : "";
  return { head, meta: `${via} · ${task}${est}` };
}

/** Shortens a tool call to one readable line: `Bash  npm test`. */
export function toolLine(name: string, args: string): { name: string; detail: string } {
  let parsed: Record<string, unknown> = {};
  try {
    parsed = JSON.parse(args) as Record<string, unknown>;
  } catch {
    /* not JSON */
  }
  const pick =
    parsed.command ?? parsed.cmd ?? parsed.file_path ?? parsed.path ?? parsed.filePath ?? parsed.pattern ?? parsed.query ?? parsed.url;
  const detail = Array.isArray(pick) ? pick.join(" ") : typeof pick === "string" ? pick : args === "{}" ? "" : args;
  // Paths inside the sandbox read better relative to the project.
  const rel = detail.replace(/\/home\/agent\/workspace\/?/g, "") || ".";
  return { name: name.replace(/^functions\./, ""), detail: clip(rel, 90) };
}

export function statusGlyph(r: ResponseObject): { glyph: string; color: string; label: string } {
  switch (r.status) {
    case "completed":
      return { glyph: "✓", color: ACCENT, label: "done" };
    case "cancelled":
      return { glyph: "■", color: "yellow", label: "cancelled" };
    case "incomplete":
      return { glyph: "◐", color: "yellow", label: "incomplete" };
    default:
      return { glyph: "✗", color: "red", label: "failed" };
  }
}

export const HELP: [string, string][] = [
  ["/route <task>", "show where Jev would send a task, without running it"],
  ["/harness <name|auto>", "pin claude-code · codex · opencode · hermes, or let Jev pick"],
  ["/model <id|auto>", "pin a model"],
  ["/effort <level|auto>", "low · medium · high · xhigh · max"],
  ["/objective <mode>", "cheapest · balanced · best"],
  ["/budget <usd|off>", "refuse routes estimated above this"],
  ["/memory [turn]", "show the project ledger, or one turn in full"],
  ["/diff", "show the last change applied to your files"],
  ["/undo", "revert the last applied change"],
  ["/new", "start a fresh session (the project ledger carries over)"],
  ["/status", "gateway, agents and settings"],
  ["/cost", "spend and savings so far"],
  ["/exit", "quit (or ctrl+c twice)"],
];
