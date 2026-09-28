/**
 * Session ledger: the workspace is a git repo, every turn is a commit, and `.jev/` holds a
 * human- and agent-readable record of the session. When a turn moves to a different harness
 * or model, the new agent is briefed from this ledger instead of relying on its own memory.
 */
import { execFile } from "node:child_process";
import { mkdir, readFile, readdir, writeFile, appendFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const LEDGER_DIR = ".jev";
const TURNS_DIR = join(LEDGER_DIR, "turns");
const MEMORY_FILE = join(LEDGER_DIR, "MEMORY.md");
/** Never committed: harness configs and credentials live here. */
const IGNORED = [".harness/"];
const SKILL_FILE = join(LEDGER_DIR, "SKILL.md");
const BLOCK_START = "<!-- jev-route:start (managed, edits are overwritten) -->";
const BLOCK_END = "<!-- jev-route:end -->";
const BRIEFING_CHARS = 8_000;

/** What every agent in a jev-route session should know. Kept short: it rides along every turn. */
export const SKILL = `# Working in a jev-route session

Several agents (Claude Code, Codex, OpenCode, Hermes) may take turns on this workspace — a
router picks the best one for each request. Shared memory lives in files, not in your context.

- **Session ledger.** \`${MEMORY_FILE}\` has one entry per turn: what was asked, which agent
  and model did it, a short result and the files changed. \`${TURNS_DIR}/NNNN.md\` holds the
  full request and result of each turn.
- **Version control.** Each turn is a git commit, authored as \`<agent>/<model>\`. Use
  \`git log --oneline\`, \`git show <commit>\` and \`git diff\` to see what earlier turns changed.
- **Picking up work.** If the request refers to earlier work ("it", "the function", "now add
  tests"), read \`${MEMORY_FILE}\` and the relevant commits before acting.

Rules:
1. Leave your changes uncommitted — jev-route commits them at the end of your turn. Never rewrite
   history (no \`reset\`, \`rebase\`, \`commit --amend\` or force operations).
2. Do not edit anything under \`${LEDGER_DIR}/\`; it is written for you.
3. **Start your final message with one or two sentences saying what you did and what is left.**
   That sentence becomes this turn's entry in the ledger that the next agent reads.
`;
const SUMMARY_CHARS = 400;
const MAX_FILES_LISTED = 25;

export interface TurnRecord {
  harness: string;
  model: string;
  effort?: string;
  status: "completed" | "failed" | "cancelled";
  prompt: string;
  /** The agent's last message — the skill asks it to open with a summary. */
  finalText: string;
  /** Every message of the turn, kept in the turn file. */
  fullText?: string;
  error?: string;
}

export interface Checkpoint {
  turn: number;
  commit: string | null;
  files: { status: string; path: string }[];
  summary: string;
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await run(
    "git",
    ["-c", "user.name=jev-route", "-c", "user.email=agent@jev-route.local", "-c", "commit.gpgsign=false", ...args],
    { cwd, maxBuffer: 16 * 1024 * 1024 },
  );
  return stdout;
}

/** Makes the workspace a git repo (once) with harness internals ignored. */
export async function ensureRepo(cwd: string): Promise<void> {
  await mkdir(join(cwd, TURNS_DIR), { recursive: true });
  const gitignore = join(cwd, ".gitignore");
  const current = await readFile(gitignore, "utf8").catch(() => "");
  const missing = IGNORED.filter((p) => !current.split("\n").includes(p));
  if (missing.length) await appendFile(gitignore, `${current && !current.endsWith("\n") ? "\n" : ""}${missing.join("\n")}\n`);
  const isRepo = await git(cwd, ["rev-parse", "--is-inside-work-tree"]).then(
    (o) => o.trim() === "true",
    () => false,
  );
  if (!isRepo) await git(cwd, ["init", "-q", "-b", "main"]);
  const instructionsChanged = await ensureInstructions(cwd);
  if (!isRepo || missing.length || instructionsChanged) {
    // Baseline, so turn diffs show only what agents changed.
    await git(cwd, ["add", "-A"]);
    await git(cwd, ["commit", "-q", "--allow-empty", "-m", "jev-route: workspace baseline"]);
  }
}

/**
 * Writes the session skill and points each harness's native instruction file at it:
 * AGENTS.md (Codex, OpenCode, Hermes) inline, CLAUDE.md (Claude Code) via an @import.
 * Only a marked block is managed, so a project's own instructions are kept.
 */
async function ensureInstructions(cwd: string): Promise<boolean> {
  let changed = await writeIfDifferent(join(cwd, SKILL_FILE), SKILL);
  changed = (await upsertBlock(join(cwd, "AGENTS.md"), SKILL.trim())) || changed;
  changed = (await upsertBlock(join(cwd, "CLAUDE.md"), `Read and follow @${SKILL_FILE}`)) || changed;
  return changed;
}

async function writeIfDifferent(path: string, content: string): Promise<boolean> {
  if ((await readFile(path, "utf8").catch(() => null)) === content) return false;
  await writeFile(path, content);
  return true;
}

async function upsertBlock(path: string, body: string): Promise<boolean> {
  const current = await readFile(path, "utf8").catch(() => "");
  const block = `${BLOCK_START}\n${body}\n${BLOCK_END}`;
  const start = current.indexOf(BLOCK_START);
  const end = current.indexOf(BLOCK_END);
  const next =
    start >= 0 && end > start
      ? current.slice(0, start) + block + current.slice(end + BLOCK_END.length)
      : current
        ? `${current.trimEnd()}\n\n${block}\n`
        : `${block}\n`;
  return writeIfDifferent(path, next);
}

/** Briefing for an agent picking up a session another harness/model worked on. */
export async function briefing(cwd: string): Promise<string | null> {
  const memory = await readFile(join(cwd, MEMORY_FILE), "utf8").catch(() => "");
  const turns = memory.split(/^(?=## Turn )/m).filter((s) => s.startsWith("## Turn "));
  if (turns.length === 0) return null;
  const recent: string[] = [];
  let size = 0;
  for (const t of [...turns].reverse()) {
    if (size + t.length > BRIEFING_CHARS && recent.length > 0) break;
    recent.unshift(t.trim());
    size += t.length;
  }
  const older = turns.length - recent.length;
  return [
    "You are continuing a task that other agents have been working on in this workspace.",
    "The files here reflect all prior work. Each earlier turn is a git commit (`git log`, `git show`),",
    `and ${MEMORY_FILE} plus ${TURNS_DIR}/ record what was asked and done. Recent turns:`,
    "",
    ...recent,
    older > 0 ? `\n(${older} older turn${older === 1 ? "" : "s"} in ${TURNS_DIR}/)` : "",
    "",
    "---",
    "",
    "New request:",
  ].join("\n");
}

/** Commits the turn's changes and appends it to the ledger. Never throws. */
export async function recordTurn(cwd: string, t: TurnRecord): Promise<Checkpoint | null> {
  try {
    await ensureRepo(cwd);
    const turn = (await readdir(join(cwd, TURNS_DIR)).catch(() => [])).filter((f) => f.endsWith(".md")).length + 1;
    await git(cwd, ["add", "-A"]);
    const files = parseNameStatus(await git(cwd, ["diff", "--cached", "--name-status", "--no-renames"])).filter(
      (f) => !f.path.startsWith(`${LEDGER_DIR}/`),
    );
    const summary = summarize(t);
    const header = `## Turn ${turn} — ${t.harness} · ${t.model}${t.effort ? ` · ${t.effort}` : ""} · ${t.status}`;
    const fileLine = files.length
      ? files.slice(0, MAX_FILES_LISTED).map((f) => `${f.status} ${f.path}`).join(", ") +
        (files.length > MAX_FILES_LISTED ? `, … (+${files.length - MAX_FILES_LISTED})` : "")
      : "none";
    const entry = `${header}\n**Asked:** ${oneLine(t.prompt, 300)}\n**Result:** ${summary}\n**Files:** ${fileLine}\n\n`;

    await writeFile(
      join(cwd, TURNS_DIR, `${String(turn).padStart(4, "0")}.md`),
      `${header}\n\n### Request\n\n${t.prompt}\n\n### Result\n\n${t.fullText || t.finalText || t.error || "(no output)"}\n\n### Files\n\n${fileLine}\n`,
    );
    const memoryPath = join(cwd, MEMORY_FILE);
    const memory = await readFile(memoryPath, "utf8").catch(
      () => "# Session memory\n\nMaintained by jev-route. Every turn is also a git commit (`git log --oneline`).\n\n",
    );
    await writeFile(memoryPath, memory + entry);

    await git(cwd, ["add", "-A"]);
    await git(cwd, [
      "-c",
      `user.name=${t.harness}/${t.model}`,
      "commit",
      "-q",
      "--allow-empty",
      "-m",
      `turn ${turn} (${t.harness}/${t.model}, ${t.status}): ${oneLine(t.prompt, 60)}`,
      "-m",
      summary,
    ]);
    const commit = (await git(cwd, ["rev-parse", "--short", "HEAD"])).trim();
    return { turn, commit, files, summary };
  } catch {
    return null;
  }
}

function summarize(t: TurnRecord): string {
  if (t.status !== "completed") return oneLine(t.error ?? `turn ${t.status}`, SUMMARY_CHARS);
  // Drop code blocks; the diff already carries the code.
  const prose = t.finalText.replace(/```[\s\S]*?```/g, " ").replace(/\s+/g, " ").trim();
  return oneLine(prose || "(no text output)", SUMMARY_CHARS);
}

function oneLine(s: string, max: number): string {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function parseNameStatus(out: string): { status: string; path: string }[] {
  return out
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      const [status, ...rest] = l.split("\t");
      return { status: status ?? "?", path: rest.join("\t") };
    });
}
