import { join } from "node:path";
import type { RunEvent } from "@jev-route/core";
import { parseJsonLine, promptArg, toText, type Driver } from "../driver.ts";

/** OpenCode headless: `opencode run --format json`. Permissions are pre-approved via config. */
export const opencodeDriver: Driver = {
  build(spec) {
    const configPath = join(spec.cwd, ".harness", "opencode.json");
    const args = ["run", "--format", "json", "--pure", "--auto", "-m", spec.model, "--dir", spec.cwd];
    if (spec.effort) args.push("--variant", spec.effort);
    if (spec.harness_session_id) args.push("--session", spec.harness_session_id);
    args.push(promptArg(spec.prompt));
    return {
      cmd: "opencode",
      args,
      env: { OPENCODE_CONFIG: configPath, OPENCODE_DISABLE_AUTOUPDATE: "1" },
      files: {
        [configPath]: JSON.stringify(
          {
            $schema: "https://opencode.ai/config.json",
            permission: { edit: "allow", bash: "allow", webfetch: "allow" },
            autoupdate: false,
            share: "disabled",
          },
          null,
          2,
        ),
      },
    };
  },

  parser() {
    let sessionSent = false;
    let pendingText = "";
    let cost = 0;
    let costSeen = false;
    const tokens = { input: 0, output: 0, cacheRead: 0 };
    let sawStep = false;
    const flushText = (): RunEvent[] => {
      if (!pendingText) return [];
      const text = pendingText;
      pendingText = "";
      return [{ type: "text_done", text }];
    };
    return {
      line(line) {
        const ev = parseJsonLine(line);
        if (!ev) return [];
        const out: RunEvent[] = [];
        if (!sessionSent && typeof ev.sessionID === "string") {
          sessionSent = true;
          out.push({ type: "session", harness_session_id: ev.sessionID });
        }
        const part = ev.part ?? {};
        switch (ev.type) {
          case "text":
            if (part.text) {
              pendingText += part.text;
              out.push({ type: "text_delta", text: String(part.text) });
            }
            break;
          case "reasoning":
            if (part.text) out.push({ type: "reasoning", text: String(part.text) });
            break;
          case "tool_use": {
            out.push(...flushText());
            const state = part.state ?? {};
            const id = String(part.callID ?? part.id ?? `call_${Date.now()}`);
            out.push({ type: "tool_call", call_id: id, name: String(part.tool ?? "tool"), arguments: JSON.stringify(state.input ?? {}) });
            if (state.status === "completed" || state.status === "error") {
              out.push({
                type: "tool_result",
                call_id: id,
                output: toText(state.output ?? state.error ?? ""),
                ...(state.status === "error" ? { is_error: true } : {}),
              });
            }
            break;
          }
          case "step_finish": {
            sawStep = true;
            out.push(...flushText());
            const t = part.tokens ?? {};
            tokens.input += (t.input ?? 0) + (t.cache?.write ?? 0);
            tokens.output += (t.output ?? 0) + (t.reasoning ?? 0);
            tokens.cacheRead += t.cache?.read ?? 0;
            if (typeof part.cost === "number") {
              cost += part.cost;
              costSeen = true;
            }
            break;
          }
          case "error": {
            const e = ev.error ?? {};
            out.push({ type: "error", code: "harness_error", message: String(e.data?.message ?? e.message ?? e.name ?? "opencode error") });
            break;
          }
        }
        return out;
      },
      end(exitCode) {
        const out = flushText();
        if (sawStep) {
          out.push({
            type: "usage",
            input_tokens: tokens.input,
            output_tokens: tokens.output,
            cache_read_tokens: tokens.cacheRead,
            ...(costSeen ? { cost_usd: cost } : {}),
          });
        }
        if (exitCode !== 0 && exitCode !== null) {
          out.push({ type: "error", code: "harness_exit", message: `opencode exited with code ${exitCode}` });
        }
        return out;
      },
    };
  },
};
