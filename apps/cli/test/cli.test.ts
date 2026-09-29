import { describe, expect, it } from "vitest";
import { clip, routeLine, toolLine, usd } from "../src/format.ts";
import { patchStats, projectIdFor } from "../src/workspace.ts";

describe("workspace helpers", () => {
  it("derives a stable, readable project id from the directory", () => {
    const id = projectIdFor("/Users/me/Code/My App!");
    expect(id).toMatch(/^my-app-[0-9a-f]{8}$/);
    expect(projectIdFor("/Users/me/Code/My App!")).toBe(id);
    expect(projectIdFor("/Users/you/Code/My App!")).not.toBe(id);
  });

  it("counts lines per file in a patch", () => {
    const patch = [
      "diff --git a/a.py b/a.py",
      "--- a/a.py",
      "+++ b/a.py",
      "@@ -1 +1,2 @@",
      "-x = 1",
      "+x = 2",
      "+y = 3",
      "diff --git a/b.py b/b.py",
      "new file mode 100644",
      "--- /dev/null",
      "+++ b/b.py",
      "@@ -0,0 +1 @@",
      "+print('hi')",
    ].join("\n");
    expect(patchStats(patch)).toEqual({
      files: [
        { path: "a.py", added: 2, removed: 1 },
        { path: "b.py", added: 1, removed: 0 },
      ],
      added: 3,
      removed: 1,
    });
  });
});

describe("formatting", () => {
  it("shortens tool calls to their most useful argument", () => {
    expect(toolLine("Bash", JSON.stringify({ command: "npm test" }))).toEqual({ name: "Bash", detail: "npm test" });
    expect(toolLine("shell", JSON.stringify({ command: ["bash", "-lc", "ls"] })).detail).toBe("bash -lc ls");
    expect(toolLine("Edit", JSON.stringify({ file_path: "/w/a.ts", old_string: "x" })).detail).toBe("/w/a.ts");
  });

  it("formats money, clipping and the route line", () => {
    expect(usd(0.0031)).toBe("$0.0031");
    expect(usd(1.5)).toBe("$1.50");
    expect(clip("a  b\nc", 10)).toBe("a b c");
    expect(clip("x".repeat(20), 5)).toBe("xxxx…");
    const { head, meta } = routeLine({
      harness: "codex",
      model: "gpt-5.6-terra",
      effort: "high",
      option_id: "codex:gpt-5.6-terra",
      source: "jev",
      objective: "balanced",
      features: { task_type: "code_change", difficulty: 4 },
      est_cost_usd: 0.12,
      latency_ms: 340,
      reason: "",
      candidates: [],
    });
    expect(head).toBe("codex · gpt-5.6-terra · high");
    expect(meta).toBe("jev 340ms · hard code change · est $0.12");
  });
});
