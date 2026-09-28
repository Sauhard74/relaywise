export const HARNESS_IDS = ["claude-code", "codex", "opencode", "hermes", "mock"] as const;
export type HarnessId = (typeof HARNESS_IDS)[number];

export const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
export type Effort = (typeof EFFORTS)[number];

export const OBJECTIVES = ["cheapest", "balanced", "best"] as const;
export type Objective = (typeof OBJECTIVES)[number];

export const TASK_TYPES = [
  "code_change",
  "debugging",
  "code_review",
  "explain",
  "research",
  "writing",
  "data_analysis",
  "ops_shell",
  "quick_answer",
] as const;
export type TaskType = (typeof TASK_TYPES)[number];

/** 1 = trivial … 5 = very hard. */
export type Difficulty = 1 | 2 | 3 | 4 | 5;

/** What agentd needs to run one turn of one harness. Sent as JSON on agentd's stdin. */
export interface RunSpec {
  run_id: string;
  harness: HarnessId;
  model: string;
  effort?: Effort;
  prompt: string;
  cwd: string;
  /** Harness-native session/thread id from the previous turn, for continuation. */
  harness_session_id?: string;
  /** Prior turns, for harnesses without native resume (replayed into the prompt). */
  transcript?: { role: "user" | "assistant"; text: string }[];
  env: Record<string, string>;
  max_turns?: number;
  timeout_ms?: number;
}

/** Normalized events agentd emits as NDJSON on stdout, one per line. */
export type RunEvent =
  | { type: "started"; harness: HarnessId; model: string; pid?: number }
  | { type: "session"; harness_session_id: string }
  | { type: "text_delta"; text: string }
  /** Closes the current assistant message; `text` is the full message. */
  | { type: "text_done"; text: string }
  | { type: "reasoning"; text: string }
  | { type: "tool_call"; call_id: string; name: string; arguments: string }
  | { type: "tool_result"; call_id: string; output: string; is_error?: boolean }
  | {
      type: "usage";
      input_tokens: number;
      output_tokens: number;
      cache_read_tokens?: number;
      /** Only when the harness reports a real dollar figure. */
      cost_usd?: number;
    }
  | { type: "error"; message: string; code?: string }
  /** Non-fatal harness warning; logged, never fails the run. */
  | { type: "notice"; message: string }
  | { type: "exit"; status: "completed" | "failed" | "cancelled"; exit_code?: number | null };

export interface RouteFeatures {
  task_type: TaskType;
  difficulty: Difficulty;
  edits_code: boolean;
  long_horizon: boolean;
  needs_web: boolean;
}

export interface CandidateScore {
  option_id: string;
  est_cost_usd: number;
  quality_fit: number;
  jev_preference: number;
  prior_bonus: number;
  cost_penalty: number;
  score: number;
}

export type RouteSource = "jev" | "heuristic" | "cache" | "pinned" | "session";

export interface RouteDecision {
  harness: HarnessId;
  model: string;
  effort?: Effort;
  option_id: string;
  source: RouteSource;
  objective: Objective;
  features: RouteFeatures;
  est_cost_usd: number;
  /** Estimate for the most capable eligible option — the "no router" baseline for savings. */
  baseline_est_cost_usd?: number;
  /** Router latency in ms (Jev call included). */
  latency_ms: number;
  /** Top candidates, best first. */
  candidates: CandidateScore[];
  reason: string;
  /** Set when Jev failed and we fell back. */
  fallback_reason?: string;
}
