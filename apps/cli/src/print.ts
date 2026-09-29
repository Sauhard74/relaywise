/** `jev -p "…"`: one turn, streamed as plain text; exit code reflects the result. */
import { clip, duration, routeLine, toolLine, usd } from "./format.ts";
import type { Session } from "./session.ts";

const tty = process.stdout.isTTY;
const c = (code: string) => (s: string) => (tty ? `\x1b[${code}m${s}\x1b[0m` : s);
const dim = c("2");
const turq = c("38;2;48;213;200"); // jev turquoise
const red = c("31");
const accent = c("38;2;48;213;200");

export async function printMode(session: Session, prompt: string, json: boolean): Promise<number> {
  const err = (s: string) => process.stderr.write(`${s}\n`);
  let atLineStart = true;
  const result = await session.turn(
    prompt,
    (e) => {
      if (json) return;
      switch (e.type) {
        case "created": {
          const d = e.response.metadata.route;
          if (d) {
            const { head, meta } = routeLine(d);
            err(`${dim("⎿")} ${accent(head)}${d.handoff ? " ↪ handoff" : ""} ${dim(meta)}`);
          }
          break;
        }
        case "tool": {
          const t = toolLine(e.name, e.args);
          if (!atLineStart) process.stdout.write("\n");
          err(dim(`⏺ ${t.name} ${t.detail}`));
          atLineStart = true;
          break;
        }
        case "text":
          process.stdout.write(e.delta);
          atLineStart = e.delta.endsWith("\n");
          break;
        case "message_done":
          if (!atLineStart) process.stdout.write("\n");
          atLineStart = true;
          break;
        default:
          break;
      }
    },
    (p) => {
      if (!json && p.kind === "syncing") err(dim(`syncing ${p.files} files…`));
    },
  );
  const r = result.response;
  if (json) {
    process.stdout.write(`${JSON.stringify({ ...r, local_patch_applied: Boolean(result.stats && !result.applyError) }, null, 2)}\n`);
  } else {
    const ok = r.status === "completed";
    const files = result.stats ? ` · ${result.stats.files.length} files +${result.stats.added} −${result.stats.removed}` : "";
    err(`${ok ? turq("✓ done") : red(`✗ ${r.status}`)}${dim(` · ${usd(r.metadata.cost_usd)} · ${duration(r.metadata.duration_ms)}${files}`)}`);
    if (r.error && !ok) err(red(clip(r.error.message, 400)));
    if (result.applyError) err(red(`couldn't apply the change locally: ${result.applyError}`));
  }
  return r.status === "completed" && !result.applyError ? 0 : 1;
}
