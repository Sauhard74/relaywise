/**
 * Opt-in: JEV_ROUTE_DOCKER_E2E=1 pnpm test apps/gateway/test/docker.e2e.test.ts
 * Needs Docker and the image from `pnpm build:image`.
 */
import { execFileSync } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { RunEvent, RunSpec } from "@jev-route/core";
import { DockerExecutor } from "../src/executors/docker.ts";

const enabled = process.env.JEV_ROUTE_DOCKER_E2E === "1";
const session = `e2e${Date.now().toString(36)}`;
const image = process.env.JEV_ROUTE_IMAGE ?? "jev-route/agent-runtime:latest";

describe.skipIf(!enabled)("DockerExecutor (real containers)", () => {
  const executor = new DockerExecutor({ image, network: "none", cpus: "1", memory: "1g", enableMock: true });

  beforeAll(async () => {
    await executor.destroySandbox(session, null);
  });
  afterAll(async () => {
    await executor.destroySandbox(session, null);
  });

  const spec = (over: Partial<RunSpec> = {}): RunSpec => ({
    run_id: `r${Math.random().toString(36).slice(2)}`,
    harness: "mock",
    model: "mock-small",
    prompt: "hello from docker",
    cwd: "/home/agent/workspace",
    env: { OPENAI_API_KEY: "sk-e2e-secret-value-123" },
    ...over,
  });

  const run = async (s: RunSpec, cancelAfterMs?: number) => {
    const sandbox = await executor.ensureSandbox(session, null);
    const events: RunEvent[] = [];
    const handle = executor.run(sandbox, s, (e) => events.push(e));
    if (cancelAfterMs) setTimeout(() => void handle.cancel(), cancelAfterMs);
    return { status: await handle.done, events, sandbox };
  };

  it("reports installed harnesses from the image", async () => {
    expect(await executor.installed()).toMatchObject({ "claude-code": true, codex: true, opencode: true, hermes: true, mock: true });
  });

  it("runs a harness inside a hardened, per-session container", async () => {
    const { status, events, sandbox } = await run(spec());
    expect(status).toBe("completed");
    expect(events.find((e) => e.type === "text_done")).toMatchObject({ text: expect.stringContaining("hello from docker") });

    const inspect = JSON.parse(execFileSync("docker", ["inspect", sandbox.id], { encoding: "utf8" }))[0];
    expect(inspect.Config.User).toBe("agent");
    expect(inspect.HostConfig.CapDrop).toContain("ALL");
    expect(inspect.HostConfig.SecurityOpt).toContain("no-new-privileges");
    expect(inspect.HostConfig.NetworkMode).toBe("none");
    // credentials travel over stdin, never as container env
    expect(JSON.stringify(inspect.Config.Env)).not.toContain("sk-e2e-secret-value-123");
  });

  it("cancels a running harness", async () => {
    const t0 = Date.now();
    const { status } = await run(spec({ prompt: "MOCK_SLOW" }), 1_000);
    expect(status).toBe("cancelled");
    expect(Date.now() - t0).toBeLessThan(8_000);
  });

  it("keeps the workspace when an idle container is reaped and recreated", async () => {
    const first = await executor.ensureSandbox(session, null);
    execFileSync("docker", ["exec", first.id, "sh", "-c", "echo persisted > /home/agent/workspace/note.txt"]);
    await executor.stopSandbox(first.id);
    const second = await executor.ensureSandbox(session, null);
    const note = execFileSync("docker", ["exec", second.id, "cat", "/home/agent/workspace/note.txt"], { encoding: "utf8" });
    expect(note.trim()).toBe("persisted");
  });
});
