import type { RunEvent } from "@jev-route/core";
import { parseJsonLine, promptArg, toText, type Driver } from "../driver.ts";

/** Claude Code headless: `claude -p … --output-format stream-json`. */
export const claudeDriver: Driver = {
  build(spec) {
    const args = [
      "-p",
      promptArg(spec.prompt),
      "--output-format",
      "stream-json",
      "--verbose",
      "--include-partial-messages",
      "--dangerously-skip-permissions",
      "--model",
      spec.model,
    ];
    if (spec.effort) args.push("--effort", spec.effort);
    if (spec.max_turns) args.push("--max-turns", String(spec.max_turns));
    if (spec.harness_session_id) args.push("--resume", spec.harness_session_id);
    return { cmd: "claude", args, env: { CLAUDE_CODE_ENTRYPOINT: "sdk-jev-route", DISABLE_AUTOUPDATER: "1" } };
  },

  parser() {
    let sessionSent = false;
    let sawResult = false;
    return {
      line(line) {
        const ev = parseJsonLine(line);
        if (!ev) return [];
        const out: RunEvent[] = [];
        if (!sessionSent && typeof ev.session_id === "string") {
          sessionSent = true;
          out.push({ type: "session", harness_session_id: ev.session_id });
        }
        switch (ev.type) {
          case "stream_event": {
            const delta = ev.event?.type === "content_block_delta" ? ev.event.delta : undefined;
            if (delta?.type === "text_delta" && delta.text) out.push({ type: "text_delta", text: delta.text });
            if (delta?.type === "thinking_delta" && delta.thinking) out.push({ type: "reasoning", text: delta.thinking });
            break;
          }
          case "assistant":
            for (const block of ev.message?.content ?? []) {
              if (block.type === "text" && block.text) out.push({ type: "text_done", text: block.text });
              if (block.type === "tool_use") {
                out.push({
                  type: "tool_call",
                  call_id: String(block.id),
                  name: String(block.name),
                  arguments: JSON.stringify(block.input ?? {}),
                });
              }
            }
            break;
          case "user":
            for (const block of Array.isArray(ev.message?.content) ? ev.message.content : []) {
              if (block.type === "tool_result") {
                out.push({
                  type: "tool_result",
                  call_id: String(block.tool_use_id),
                  output: toText(block.content),
                  ...(block.is_error ? { is_error: true } : {}),
                });
              }
            }
            break;
          case "result": {
            sawResult = true;
            const u = ev.usage ?? {};
            out.push({
              type: "usage",
              input_tokens: (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0),
              output_tokens: u.output_tokens ?? 0,
              cache_read_tokens: u.cache_read_input_tokens ?? 0,
              ...(typeof ev.total_cost_usd === "number" ? { cost_usd: ev.total_cost_usd } : {}),
            });
            if (ev.is_error || (ev.subtype && ev.subtype !== "success")) {
              out.push({
                type: "error",
                code: String(ev.subtype ?? "error"),
                message: typeof ev.result === "string" && ev.result ? ev.result : `claude ended with ${ev.subtype}`,
              });
            }
            break;
          }
        }
        return out;
      },
      end(exitCode) {
        return !sawResult && exitCode !== 0
          ? [{ type: "error", code: "harness_exit", message: `claude exited with code ${exitCode}` }]
          : [];
      },
    };
  },
};
