import { randomBytes } from "node:crypto";
import type { RunEvent } from "@jev-route/core";
import type { ResponseStatus } from "./store.ts";

export type OutputItem =
  | {
      id: string;
      type: "message";
      role: "assistant";
      status: "in_progress" | "completed";
      content: { type: "output_text"; text: string; annotations: unknown[] }[];
    }
  | { id: string; type: "reasoning"; summary: { type: "summary_text"; text: string }[] }
  | { id: string; type: "function_call"; call_id: string; name: string; arguments: string; status: "completed" }
  | { id: string; type: "function_call_output"; call_id: string; output: string };

export interface Usage {
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  cache_read_tokens?: number;
}

export interface ErrorInfo {
  type: string;
  code: string;
  message: string;
}

export interface SseEvent {
  type: string;
  sequence_number: number;
  [k: string]: unknown;
}

export function newId(prefix: string): string {
  return `${prefix}_${randomBytes(12).toString("hex")}`;
}

/**
 * Folds normalized RunEvents into a Responses-API `output` array and emits the matching
 * SSE events (gapless sequence numbers, exactly one terminal event).
 */
export class ResponseBuilder {
  readonly output: OutputItem[] = [];
  usage: Usage | null = null;
  harnessCostUsd: number | undefined;
  harnessSessionId: string | undefined;
  error: ErrorInfo | null = null;
  notices: string[] = [];
  checkpoint: Extract<RunEvent, { type: "checkpoint" }> | undefined;
  private seq = 0;
  private openMessage: { item: Extract<OutputItem, { type: "message" }>; index: number } | null = null;
  private openReasoning: { item: Extract<OutputItem, { type: "reasoning" }>; index: number } | null = null;
  private readonly callIndex = new Map<string, number>();

  constructor(
    private readonly emit: (e: SseEvent) => void,
    private readonly snapshot: () => Record<string, unknown>,
  ) {}

  start(): void {
    this.send("response.created", { response: this.snapshot() });
    this.send("response.in_progress", { response: this.snapshot() });
  }

  handle(ev: RunEvent): void {
    if (ev.type !== "reasoning") this.closeReasoning();
    switch (ev.type) {
      case "session":
        this.harnessSessionId = ev.harness_session_id;
        break;
      case "text_delta":
        this.textDelta(ev.text);
        break;
      case "text_done":
        this.textDone(ev.text);
        break;
      case "reasoning":
        this.reasoning(ev.text);
        break;
      case "tool_call": {
        this.closeMessage();
        const item: OutputItem = {
          id: newId("fc"),
          type: "function_call",
          call_id: ev.call_id,
          name: ev.name,
          arguments: ev.arguments,
          status: "completed",
        };
        const index = this.push(item);
        this.callIndex.set(ev.call_id, index);
        this.send("response.output_item.added", { output_index: index, item: { ...item, arguments: "" } });
        this.send("response.function_call_arguments.delta", { item_id: item.id, output_index: index, delta: ev.arguments });
        this.send("response.function_call_arguments.done", { item_id: item.id, output_index: index, arguments: ev.arguments });
        this.send("response.output_item.done", { output_index: index, item });
        break;
      }
      case "tool_result": {
        this.closeMessage();
        const item: OutputItem = { id: newId("fco"), type: "function_call_output", call_id: ev.call_id, output: ev.output };
        const index = this.push(item);
        this.send("response.output_item.added", { output_index: index, item });
        this.send("response.output_item.done", { output_index: index, item });
        break;
      }
      case "usage": {
        const prev = this.usage ?? { input_tokens: 0, output_tokens: 0, total_tokens: 0 };
        const input = prev.input_tokens + ev.input_tokens;
        const output = prev.output_tokens + ev.output_tokens;
        const cacheRead = (prev.cache_read_tokens ?? 0) + (ev.cache_read_tokens ?? 0);
        this.usage = {
          input_tokens: input,
          output_tokens: output,
          total_tokens: input + output,
          ...(cacheRead ? { cache_read_tokens: cacheRead } : {}),
        };
        if (ev.cost_usd !== undefined) this.harnessCostUsd = (this.harnessCostUsd ?? 0) + ev.cost_usd;
        break;
      }
      case "error":
        this.error = { type: "harness_error", code: ev.code ?? "turn_failed", message: ev.message };
        break;
      case "notice":
        this.notices.push(ev.message);
        break;
      case "checkpoint":
        this.checkpoint = ev;
        break;
      case "started":
      case "exit":
        break;
    }
  }

  /** Emits the single terminal event. `snapshot()` must already reflect the final status. */
  finish(status: ResponseStatus): void {
    this.closeReasoning();
    this.closeMessage();
    const response = this.snapshot();
    if (status === "completed") this.send("response.completed", { response });
    else if (status === "incomplete") this.send("response.incomplete", { response });
    else {
      if (this.error && status === "failed") {
        this.send("error", { code: this.error.code, message: this.error.message, param: null });
      }
      this.send("response.failed", { response });
    }
  }

  outputText(): string {
    return this.output
      .filter((i): i is Extract<OutputItem, { type: "message" }> => i.type === "message")
      .map((i) => i.content.map((c) => c.text).join(""))
      .join("\n\n");
  }

  private textDelta(text: string): void {
    if (!this.openMessage) this.openNewMessage();
    const m = this.openMessage!;
    m.item.content[0]!.text += text;
    this.send("response.output_text.delta", { item_id: m.item.id, output_index: m.index, content_index: 0, delta: text });
  }

  private textDone(text: string): void {
    if (!this.openMessage) {
      this.openNewMessage();
      this.textDelta(text);
    } else {
      const m = this.openMessage;
      const streamed = m.item.content[0]!.text;
      // The final text is authoritative; stream whatever the deltas missed.
      if (text.startsWith(streamed) && text.length > streamed.length) this.textDelta(text.slice(streamed.length));
      m.item.content[0]!.text = text;
    }
    this.closeMessage();
  }

  private openNewMessage(): void {
    const item: Extract<OutputItem, { type: "message" }> = {
      id: newId("msg"),
      type: "message",
      role: "assistant",
      status: "in_progress",
      content: [{ type: "output_text", text: "", annotations: [] }],
    };
    const index = this.push(item);
    this.openMessage = { item, index };
    this.send("response.output_item.added", { output_index: index, item: { ...item, content: [] } });
    this.send("response.content_part.added", {
      item_id: item.id,
      output_index: index,
      content_index: 0,
      part: { type: "output_text", text: "", annotations: [] },
    });
  }

  private closeMessage(): void {
    const m = this.openMessage;
    if (!m) return;
    this.openMessage = null;
    m.item.status = "completed";
    const part = m.item.content[0]!;
    this.send("response.output_text.done", { item_id: m.item.id, output_index: m.index, content_index: 0, text: part.text });
    this.send("response.content_part.done", { item_id: m.item.id, output_index: m.index, content_index: 0, part });
    this.send("response.output_item.done", { output_index: m.index, item: m.item });
  }

  private reasoning(text: string): void {
    this.closeMessage();
    if (!this.openReasoning) {
      const item: Extract<OutputItem, { type: "reasoning" }> = {
        id: newId("rs"),
        type: "reasoning",
        summary: [{ type: "summary_text", text: "" }],
      };
      const index = this.push(item);
      this.openReasoning = { item, index };
      this.send("response.output_item.added", { output_index: index, item: { ...item, summary: [] } });
      this.send("response.reasoning_summary_part.added", {
        item_id: item.id,
        output_index: index,
        summary_index: 0,
        part: { type: "summary_text", text: "" },
      });
    }
    const r = this.openReasoning;
    r.item.summary[0]!.text += text;
    this.send("response.reasoning_summary_text.delta", { item_id: r.item.id, output_index: r.index, summary_index: 0, delta: text });
  }

  private closeReasoning(): void {
    const r = this.openReasoning;
    if (!r) return;
    this.openReasoning = null;
    this.send("response.reasoning_summary_part.done", {
      item_id: r.item.id,
      output_index: r.index,
      summary_index: 0,
      part: r.item.summary[0],
    });
    this.send("response.output_item.done", { output_index: r.index, item: r.item });
  }

  private push(item: OutputItem): number {
    this.output.push(item);
    return this.output.length - 1;
  }

  private send(type: string, payload: Record<string, unknown>): void {
    this.emit({ type, sequence_number: this.seq++, ...payload });
  }
}
