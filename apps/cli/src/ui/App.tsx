import { Box, Static, Text, useApp, useInput } from "ink";
import Spinner from "ink-spinner";
import TextInput from "ink-text-input";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { homedir } from "node:os";
import type { ResponseObject, RouteDecision, Settings } from "../client.ts";
import { ACCENT, HELP, clip, duration, routeLine, statusGlyph, toolLine, usd } from "../format.ts";
import type { Phase, Session, TurnResult } from "../session.ts";
import { patchStats } from "../workspace.ts";

type Entry =
  | { id: number; kind: "banner"; agents: { name: string; available: boolean }[]; engine: string }
  | { id: number; kind: "user"; text: string }
  | { id: number; kind: "route"; decision: RouteDecision }
  | { id: number; kind: "tool"; name: string; detail: string }
  | { id: number; kind: "text"; text: string }
  | { id: number; kind: "result"; result: TurnResult }
  | { id: number; kind: "info"; node: ReactNode }
  | { id: number; kind: "error"; message: string };

type NewEntry = Entry extends infer E ? (E extends { id: number } ? Omit<E, "id"> : never) : never;

const HARNESSES = ["auto", "claude-code", "codex", "opencode", "hermes"];
const EFFORTS = ["low", "medium", "high", "xhigh", "max"];
const OBJECTIVES = ["cheapest", "balanced", "best"];

export function App({ session, version }: { session: Session; version: string }) {
  const { exit } = useApp();
  const [entries, setEntries] = useState<Entry[]>([]);
  const nextId = useRef(0);
  const [input, setInput] = useState("");
  const [history, setHistory] = useState<string[]>([]);
  const [historyIndex, setHistoryIndex] = useState<number | null>(null);
  // Remounting the input puts the cursor at the end after a programmatic change (history, clear).
  const [inputKey, setInputKey] = useState(0);
  // ink-text-input also sees ctrl+u and would insert a "u"; drop that change.
  const clearedAt = useRef(0);
  const replaceInput = useCallback((v: string) => {
    setInput(v);
    setInputKey((k) => k + 1);
  }, []);
  const [running, setRunning] = useState(false);
  const [phase, setPhase] = useState<string>("");
  const [liveText, setLiveText] = useState("");
  const [startedAt, setStartedAt] = useState(0);
  const [, setTick] = useState(0);
  const [exitArmed, setExitArmed] = useState(false);
  const [settings, setSettings] = useState<Settings>(session.settings);
  const liveTextRef = useRef("");

  const push = useCallback((...items: NewEntry[]) => {
    setEntries((prev) => [...prev, ...items.map((e) => ({ ...e, id: nextId.current++ }) as Entry)]);
  }, []);

  // Welcome banner with live gateway status.
  useEffect(() => {
    session.gateway
      .harnesses()
      .then((h) => {
        const auto = h.harnesses.find((x) => x.base === "auto");
        push({
          kind: "banner",
          agents: h.harnesses.filter((x) => x.base !== "auto").map((x) => ({ name: x.base, available: x.available })),
          engine: auto?.routing ? `${auto.routing.engine}${auto.routing.engine === "jev" ? ` (${auto.routing.model})` : ""}` : "?",
        });
      })
      .catch((err: Error) => {
        push({ kind: "banner", agents: [], engine: "offline" });
        push({ kind: "error", message: `${err.message}. Start it with \`docker compose up -d\` or set JEV_ROUTE_URL.` });
      });
  }, [push, session]);

  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [running]);

  const flushText = useCallback(() => {
    const text = liveTextRef.current.trim();
    liveTextRef.current = "";
    setLiveText("");
    if (text) push({ kind: "text", text });
  }, [push]);

  const runTurn = useCallback(
    async (prompt: string) => {
      push({ kind: "user", text: prompt });
      setRunning(true);
      setStartedAt(Date.now());
      setPhase("routing");
      try {
        const result = await session.turn(
          prompt,
          (e) => {
            switch (e.type) {
              case "created":
                if (e.response.metadata.route) push({ kind: "route", decision: e.response.metadata.route });
                setPhase(`${e.response.metadata.harness_id} is working`);
                break;
              case "text":
                liveTextRef.current += e.delta;
                setLiveText(liveTextRef.current);
                break;
              case "message_done":
                flushText();
                break;
              case "tool": {
                flushText();
                push({ kind: "tool", ...toolLine(e.name, e.args) });
                break;
              }
              case "reasoning":
                setPhase((p) => (p.endsWith("is working") ? p.replace("is working", "is thinking") : p));
                break;
              default:
                break;
            }
          },
          (p: Phase) => setPhase(p.kind === "syncing" ? `syncing ${p.files} files` : p.kind === "applying" ? "applying changes" : "routing"),
        );
        flushText();
        push({ kind: "result", result });
      } catch (err) {
        flushText();
        push({ kind: "error", message: (err as Error).message });
      } finally {
        setRunning(false);
        setPhase("");
      }
    },
    [flushText, push, session],
  );

  const command = useCallback(
    async (line: string) => {
      const [cmd, ...rest] = line.slice(1).split(/\s+/);
      const arg = rest.join(" ").trim();
      const update = (patch: Partial<Settings>, note: string) => {
        const next = { ...session.settings, ...patch };
        session.settings = next;
        setSettings(next);
        push({ kind: "info", node: <Text dimColor>{note}</Text> });
      };
      try {
        switch (cmd) {
          case "help":
          case "?":
            push({
              kind: "info",
              node: (
                <Box flexDirection="column">
                  {HELP.map(([c, d]) => (
                    <Text key={c}>
                      <Text color={ACCENT}>{c.padEnd(22)}</Text>
                      <Text dimColor>{d}</Text>
                    </Text>
                  ))}
                  <Text dimColor>esc cancels a running turn · ↑↓ history · ctrl+u clears the line · ctrl+c twice to quit</Text>
                </Box>
              ),
            });
            break;
          case "exit":
          case "quit":
            exit();
            break;
          case "new":
          case "clear":
            session.reset();
            push({ kind: "info", node: <Text dimColor>New session. The project ledger carries over, so the next agent is briefed on earlier work.</Text> });
            break;
          case "harness":
            if (!HARNESSES.includes(arg)) throw new Error(`usage: /harness ${HARNESSES.join("|")}`);
            session.reset();
            update({ harness: arg, model: undefined }, arg === "auto" ? "Jev picks the agent for each request." : `Pinned to ${arg} (new session).`);
            break;
          case "model":
            if (!arg) throw new Error("usage: /model <id|auto>");
            update({ model: arg === "auto" ? undefined : arg }, arg === "auto" ? "Jev picks the model." : `Model pinned to ${arg}.`);
            break;
          case "effort":
            if (arg !== "auto" && !EFFORTS.includes(arg)) throw new Error(`usage: /effort ${EFFORTS.join("|")}|auto`);
            update({ effort: arg === "auto" ? undefined : arg }, arg === "auto" ? "Jev picks the effort." : `Effort pinned to ${arg}.`);
            break;
          case "objective":
            if (!OBJECTIVES.includes(arg)) throw new Error(`usage: /objective ${OBJECTIVES.join("|")}`);
            update({ objective: arg as Settings["objective"] }, `Objective: ${arg}.`);
            break;
          case "budget": {
            if (arg === "off" || arg === "") {
              update({ budget: undefined }, "No budget limit.");
              break;
            }
            const v = Number(arg.replace(/^\$/, ""));
            if (!(v > 0)) throw new Error("usage: /budget <usd|off>");
            update({ budget: v }, `Routes estimated above ${usd(v)} are refused.`);
            break;
          }
          case "route": {
            if (!arg) throw new Error("usage: /route <task>");
            const d = await session.gateway.route(arg, session.settings, session.project);
            push({ kind: "route", decision: d });
            push({
              kind: "info",
              node: (
                <Box flexDirection="column" marginLeft={2}>
                  {d.candidates.map((c, i) => (
                    <Text key={c.option_id} dimColor={i > 0}>
                      {i === 0 ? "▸ " : "  "}
                      {c.option_id.padEnd(48)} score {c.score.toFixed(2)} · est {usd(c.est_cost_usd)}
                    </Text>
                  ))}
                </Box>
              ),
            });
            break;
          }
          case "memory": {
            const turn = arg ? Number(arg) : undefined;
            try {
              const text = await session.gateway.memory(session.project, turn);
              push({ kind: "info", node: <Markdown text={text.trim()} /> });
            } catch (err) {
              if ((err as { status?: number }).status !== 404) throw err;
              push({ kind: "info", node: <Text dimColor>{turn ? `No turn ${turn} in this project.` : "No memory yet — the ledger starts with your first task here."}</Text> });
            }
            break;
          }
          case "diff":
            if (!session.lastPatch) throw new Error("no change has been applied in this session yet");
            push({ kind: "info", node: <Diff patch={session.lastPatch} /> });
            break;
          case "undo": {
            const stats = await session.undo();
            if (!stats) throw new Error("nothing to undo");
            push({ kind: "info", node: <Text>↶ reverted {stats.files.length} file{stats.files.length === 1 ? "" : "s"} ({stats.files.map((f) => f.path).join(", ")})</Text> });
            break;
          }
          case "cost": {
            const s = await session.gateway.stats();
            push({
              kind: "info",
              node: (
                <Text>
                  {s.totals.runs} runs · {usd(s.totals.cost_usd)} spent
                  {s.savings.runs_counted ? <Text color={ACCENT}> · {usd(Math.max(0, s.savings.saved_usd))} saved vs always top-tier</Text> : null}
                </Text>
              ),
            });
            break;
          }
          case "status": {
            const h = await session.gateway.harnesses();
            push({
              kind: "info",
              node: (
                <Box flexDirection="column">
                  <Text>
                    <Text dimColor>gateway </Text>
                    {session.gateway.url} <Text dimColor>· project </Text>
                    {session.project} <Text dimColor>· sync </Text>
                    {session.sync ? "on" : "off"}
                  </Text>
                  {h.harnesses.map((x) => (
                    <Text key={x.base}>
                      <Text color={x.available ? ACCENT : "gray"}>{x.available ? "●" : "○"}</Text> {x.base.padEnd(12)}
                      <Text dimColor>{x.available ? (x.routing ? `routing: ${x.routing.engine}` : "ready") : (x.unavailable_reasons ?? []).join("; ")}</Text>
                    </Text>
                  ))}
                </Box>
              ),
            });
            break;
          }
          default:
            throw new Error(`unknown command /${cmd} — try /help`);
        }
      } catch (err) {
        push({ kind: "error", message: (err as Error).message });
      }
    },
    [exit, push, session],
  );

  const submit = useCallback(
    (value: string) => {
      const line = value.trim();
      if (!line || running) return;
      setInput("");
      setHistory((h) => [...h.filter((x) => x !== line), line]);
      setHistoryIndex(null);
      if (line.startsWith("/")) void command(line);
      else void runTurn(line);
    },
    [command, runTurn, running],
  );

  useInput((ch, key) => {
    if (key.ctrl && ch === "c") {
      if (running) {
        void session.cancel();
        setPhase("cancelling");
        return;
      }
      if (exitArmed) exit();
      setExitArmed(true);
      setTimeout(() => setExitArmed(false), 1500);
      return;
    }
    if (key.ctrl && ch === "d" && !input) exit();
    if (key.ctrl && ch === "u" && !running) {
      clearedAt.current = Date.now();
      replaceInput("");
      setHistoryIndex(null);
      return;
    }
    if (key.escape && running) {
      void session.cancel();
      setPhase("cancelling");
      return;
    }
    if (running || history.length === 0) return;
    if (key.upArrow) {
      const i = historyIndex === null ? history.length - 1 : Math.max(0, historyIndex - 1);
      setHistoryIndex(i);
      replaceInput(history[i]!);
    } else if (key.downArrow && historyIndex !== null) {
      const i = historyIndex + 1;
      if (i >= history.length) {
        setHistoryIndex(null);
        replaceInput("");
      } else {
        setHistoryIndex(i);
        replaceInput(history[i]!);
      }
    }
  });

  const elapsed = running ? Math.floor((Date.now() - startedAt) / 1000) : 0;
  const liveTail = liveText.split("\n").slice(-14).join("\n");

  return (
    <Box flexDirection="column">
      <Static items={entries}>{(e) => <EntryView key={e.id} entry={e} session={session} version={version} />}</Static>

      {running && (
        <Box flexDirection="column" marginLeft={2}>
          {liveTail ? <Markdown text={liveTail} /> : null}
          <Text>
            <Text color={ACCENT}>
              <Spinner type="dots" />
            </Text>{" "}
            <Text>{phase}</Text>
            <Text dimColor>
              {" "}
              · {elapsed}s · esc to cancel
            </Text>
          </Text>
        </Box>
      )}

      <Box borderStyle="round" borderColor={running ? "gray" : ACCENT} paddingX={1} marginTop={1}>
        <Text color={ACCENT}>› </Text>
        <TextInput
          key={inputKey}
          value={input}
          onChange={(v) => {
            if (Date.now() - clearedAt.current < 100) return;
            setInput(v);
            setHistoryIndex(null);
          }}
          onSubmit={submit}
          focus={!running}
          placeholder={running ? "working…" : "Ask for a change, or /help"}
          showCursor={!running}
        />
      </Box>
      <Box paddingX={2} justifyContent="space-between">
        <Text dimColor>
          {settings.harness === "auto" ? "auto-routing" : `pinned: ${settings.harness}`}
          {settings.model ? ` · ${settings.model}` : ""}
          {settings.effort ? ` · effort ${settings.effort}` : ""} · {settings.objective}
          {settings.budget ? ` · ≤ ${usd(settings.budget)}` : ""}
        </Text>
        <Text dimColor>{exitArmed ? "press ctrl+c again to exit" : session.project}</Text>
      </Box>
    </Box>
  );
}

function EntryView({ entry, session, version }: { entry: Entry; session: Session; version: string }) {
  switch (entry.kind) {
    case "banner":
      return (
        <Box borderStyle="round" borderColor={ACCENT} paddingX={1} flexDirection="column" marginBottom={1}>
          <Text>
            <Text color={ACCENT} bold>
              ✻ jev
            </Text>
            <Text dimColor> v{version} · every request routed to the right agent</Text>
          </Text>
          <Text> </Text>
          <Text>
            <Text dimColor>cwd      </Text>
            {session.cwd.replace(homedir(), "~")}
          </Text>
          <Text>
            <Text dimColor>project  </Text>
            {session.project}
            <Text dimColor>{session.sync ? "  (files sync to the sandbox each turn)" : "  (sync off)"}</Text>
          </Text>
          <Text>
            <Text dimColor>routing  </Text>
            {entry.engine}
          </Text>
          {entry.agents.length > 0 && (
            <Text>
              <Text dimColor>agents   </Text>
              {entry.agents.map((a) => (
                <Text key={a.name} color={a.available ? undefined : "gray"}>
                  <Text color={a.available ? ACCENT : "gray"}>{a.available ? "●" : "○"}</Text> {a.name}
                  {"  "}
                </Text>
              ))}
            </Text>
          )}
          <Text> </Text>
          <Text dimColor>/help for commands · esc to cancel · ctrl+c twice to quit</Text>
        </Box>
      );
    case "user":
      return (
        <Box marginTop={1}>
          <Box width={2} flexShrink={0}>
            <Text color={ACCENT} bold>
              ›
            </Text>
          </Box>
          <Box flexGrow={1}>
            <Text bold wrap="wrap">
              {entry.text}
            </Text>
          </Box>
        </Box>
      );
    case "route": {
      const { head, meta } = routeLine(entry.decision);
      return (
        <Box flexDirection="column" marginLeft={2}>
          <Text>
            <Text dimColor>⎿ </Text>
            <Text color={ACCENT}>{head}</Text>
            {entry.decision.handoff ? <Text color="yellow"> ↪ handoff</Text> : null}
            <Text dimColor>  {meta}</Text>
          </Text>
          {entry.decision.fallback_reason ? <Text dimColor>  jev unavailable, used keyword fallback</Text> : null}
        </Box>
      );
    }
    case "tool":
      return (
        <Box marginLeft={2}>
          <Text>
            <Text color="gray">⏺ </Text>
            <Text bold>{entry.name}</Text>
            <Text dimColor> {entry.detail}</Text>
          </Text>
        </Box>
      );
    case "text":
      return (
        <Box marginLeft={2} marginTop={0}>
          <Markdown text={entry.text} />
        </Box>
      );
    case "result":
      return <ResultView result={entry.result} />;
    case "info":
      return <Box marginLeft={2}>{entry.node}</Box>;
    case "error":
      return (
        <Box marginLeft={2}>
          <Text color="red">✗ {entry.message}</Text>
        </Box>
      );
  }
}

function ResultView({ result }: { result: TurnResult }) {
  const r: ResponseObject = result.response;
  const g = statusGlyph(r);
  const stats = result.stats;
  return (
    <Box flexDirection="column" marginLeft={2}>
      <Text>
        <Text color={g.color}>
          {g.glyph} {g.label}
        </Text>
        <Text dimColor>
          {" "}
          · {usd(r.metadata.cost_usd)} · {duration(r.metadata.duration_ms)}
          {r.metadata.checkpoint ? ` · turn ${r.metadata.checkpoint.turn}` : ""}
        </Text>
        {stats ? (
          <Text>
            <Text dimColor> · </Text>
            {stats.files.length} file{stats.files.length === 1 ? "" : "s"} <Text color="green">+{stats.added}</Text>{" "}
            <Text color="red">−{stats.removed}</Text>
          </Text>
        ) : null}
      </Text>
      {r.error && r.status === "failed" ? <Text color="red">  {clip(r.error.message, 300)}</Text> : null}
      {stats?.files.slice(0, 12).map((f) => (
        <Text key={f.path}>
          <Text dimColor>  </Text>
          {f.path} <Text color="green">+{f.added}</Text> <Text color="red">−{f.removed}</Text>
        </Text>
      ))}
      {result.applyError ? <Text color="yellow">  ⚠ couldn't apply the change locally: {clip(result.applyError, 200)} (see /diff)</Text> : null}
    </Box>
  );
}

/** Minimal markdown: headings, bold, inline code, fenced code, bullets. */
export function Markdown({ text }: { text: string }) {
  let inCode = false;
  return (
    <Box flexDirection="column">
      {text.split("\n").map((line, i) => {
        if (line.trim().startsWith("```")) {
          inCode = !inCode;
          return null;
        }
        if (inCode) return <Text key={i} color="cyan">{`  ${line}`}</Text>;
        const heading = line.match(/^#{1,6}\s+(.*)$/);
        if (heading) return <Text key={i} bold>{heading[1]}</Text>;
        const bullet = line.match(/^(\s*)[-*]\s+(.*)$/);
        return (
          <Text key={i}>
            {bullet ? `${bullet[1]}• ` : ""}
            <Inline text={bullet ? bullet[2]! : line} />
          </Text>
        );
      })}
    </Box>
  );
}

function Inline({ text }: { text: string }) {
  const parts = text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g);
  return (
    <>
      {parts.map((p, i) =>
        p.startsWith("**") && p.endsWith("**") ? (
          <Text key={i} bold>
            {p.slice(2, -2)}
          </Text>
        ) : p.startsWith("`") && p.endsWith("`") && p.length > 1 ? (
          <Text key={i} color="cyan">
            {p.slice(1, -1)}
          </Text>
        ) : (
          <Text key={i}>{p}</Text>
        ),
      )}
    </>
  );
}

export function Diff({ patch }: { patch: string }) {
  const stats = patchStats(patch);
  const lines = patch.split("\n");
  return (
    <Box flexDirection="column">
      <Text dimColor>
        {stats.files.length} file(s) · +{stats.added} −{stats.removed}
      </Text>
      {lines.slice(0, 200).map((l, i) => (
        <Text
          key={i}
          color={l.startsWith("+") && !l.startsWith("+++") ? "green" : l.startsWith("-") && !l.startsWith("---") ? "red" : l.startsWith("@@") ? "cyan" : undefined}
          dimColor={l.startsWith("diff ") || l.startsWith("index ") || l.startsWith("+++") || l.startsWith("---")}
        >
          {l || " "}
        </Text>
      ))}
      {lines.length > 200 ? <Text dimColor>… {lines.length - 200} more lines</Text> : null}
    </Box>
  );
}
