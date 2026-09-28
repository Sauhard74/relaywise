import type { RunEvent, RunSpec } from "@jev-route/core";

export interface Command {
  cmd: string;
  args: string[];
  /** Extra env on top of the minimal base + spec.env. */
  env?: Record<string, string>;
  /** Files to write (absolute path → content) before spawning. */
  files?: Record<string, string>;
}

/** Stateful per-run parser: one stdout line in, zero or more normalized events out. */
export interface OutputParser {
  line(line: string): RunEvent[];
  /** Called once after the process exits, before the final `exit` event. */
  end(exitCode: number | null): RunEvent[] | Promise<RunEvent[]>;
}

export interface Driver {
  build(spec: RunSpec): Command;
  parser(spec: RunSpec): OutputParser;
}

export function parseJsonLine(line: string): Record<string, any> | undefined {
  const trimmed = line.trim();
  if (!trimmed.startsWith("{")) return undefined;
  try {
    return JSON.parse(trimmed) as Record<string, any>;
  } catch {
    return undefined;
  }
}

export function toText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((c) => (typeof c === "string" ? c : typeof c?.text === "string" ? c.text : JSON.stringify(c)))
      .join("");
  }
  if (content == null) return "";
  return JSON.stringify(content);
}

/** Prepends earlier turns for harnesses that can't resume their own sessions. */
export function withTranscript(spec: RunSpec): string {
  if (!spec.transcript?.length) return spec.prompt;
  const history = spec.transcript
    .map((t) => `<${t.role}>\n${t.text}\n</${t.role}>`)
    .join("\n");
  return `Conversation so far:\n${history}\n\nContinue the conversation. New user message:\n${spec.prompt}`;
}
