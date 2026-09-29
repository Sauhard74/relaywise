/**
 * The local side of a project: your working tree is the source of truth. Before a turn it is
 * mirrored into the sandbox; after a turn the agent's commit comes back as a patch.
 */
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readdir, stat } from "node:fs/promises";
import { basename, join, relative, resolve } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
/** Never uploaded. */
const SKIP_DIRS = new Set([".git", ".jev", ".harness", "node_modules", ".venv", "venv", "__pycache__", "dist", "build", ".next", "target"]);
const MAX_FILES = 20_000;

export function projectIdFor(dir: string): string {
  const abs = resolve(dir);
  const name = basename(abs).toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "project";
  return `${name}-${createHash("sha256").update(abs).digest("hex").slice(0, 8)}`;
}

export async function isGitRepo(dir: string): Promise<boolean> {
  return run("git", ["rev-parse", "--is-inside-work-tree"], { cwd: dir }).then(
    (r) => r.stdout.trim() === "true",
    () => false,
  );
}

/** Files to mirror: git's view of the tree (tracked + untracked, not ignored), else a filtered walk. */
export async function listFiles(dir: string): Promise<string[]> {
  if (await isGitRepo(dir)) {
    const { stdout } = await run("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
      cwd: dir,
      maxBuffer: 64 * 1024 * 1024,
    });
    const files = stdout.split("\0").filter(Boolean);
    // ls-files --cached still lists deleted-but-unstaged files; keep only what exists.
    const present = await Promise.all(files.map((f) => stat(join(dir, f)).then(() => f, () => null)));
    return present.filter((f): f is string => f !== null && !isSkipped(f));
  }
  const out: string[] = [];
  const walk = async (d: string): Promise<void> => {
    for (const entry of await readdir(d, { withFileTypes: true })) {
      if (out.length >= MAX_FILES) return;
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) await walk(join(d, entry.name));
      } else if (entry.isFile() || entry.isSymbolicLink()) {
        out.push(relative(dir, join(d, entry.name)));
      }
    }
  };
  await walk(dir);
  return out;
}

function isSkipped(path: string): boolean {
  return path.split("/").some((part) => SKIP_DIRS.has(part));
}

export async function tarFiles(dir: string, files: string[]): Promise<Buffer> {
  return new Promise((resolvePromise, reject) => {
    // COPYFILE_DISABLE keeps macOS from adding ._ metadata files.
    const child = spawn("tar", ["-cf", "-", "--null", "-T", "-"], { cwd: dir, env: { ...process.env, COPYFILE_DISABLE: "1" } });
    const chunks: Buffer[] = [];
    let err = "";
    child.stdout.on("data", (c: Buffer) => chunks.push(c));
    child.stderr.on("data", (c: Buffer) => (err += c.toString()));
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolvePromise(Buffer.concat(chunks)) : reject(new Error(err.trim() || `tar exited ${code}`))));
    child.stdin.end(files.map((f) => `${f}\0`).join(""));
  });
}

export interface PatchStats {
  files: { path: string; added: number; removed: number }[];
  added: number;
  removed: number;
}

export function patchStats(patch: string): PatchStats {
  const files: PatchStats["files"] = [];
  let current: PatchStats["files"][number] | undefined;
  for (const line of patch.split("\n")) {
    const header = line.match(/^diff --git a\/(.+) b\/(.+)$/);
    if (header) {
      current = { path: header[2]!, added: 0, removed: 0 };
      files.push(current);
    } else if (current && line.startsWith("+") && !line.startsWith("+++")) current.added++;
    else if (current && line.startsWith("-") && !line.startsWith("---")) current.removed++;
  }
  return { files, added: files.reduce((n, f) => n + f.added, 0), removed: files.reduce((n, f) => n + f.removed, 0) };
}

/**
 * Applies a patch to the working tree, unstaged — like an agent editing your files. If you
 * changed the same lines meanwhile, falls back to a 3-way merge (inside a git repo).
 */
export async function applyPatch(dir: string, patch: string, reverse = false): Promise<void> {
  const base = ["apply", "--whitespace=nowarn", ...(reverse ? ["-R"] : [])];
  try {
    await gitApply(dir, base, patch);
  } catch (err) {
    if (reverse || !(await isGitRepo(dir))) throw err;
    await gitApply(dir, [...base, "--3way"], patch);
  }
}

function gitApply(dir: string, args: string[], patch: string): Promise<void> {
  return new Promise<void>((resolvePromise, reject) => {
    const child = spawn("git", args, { cwd: dir });
    let err = "";
    child.stderr.on("data", (c: Buffer) => (err += c.toString()));
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolvePromise() : reject(new Error(err.trim() || `git apply exited ${code}`))));
    child.stdin.end(patch);
  });
}
