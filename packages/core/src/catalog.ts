import type { Difficulty, Effort, HarnessId, TaskType } from "./types.ts";

export interface HarnessInfo {
  id: HarnessId;
  label: string;
  /** Any one of these env vars is enough to authenticate the harness. */
  auth_env: string[];
  /** Harness-native effort levels; empty = the harness has no effort knob. */
  efforts: Effort[];
  /** Whether the harness can resume its own session between turns. */
  native_resume: boolean;
  /** Multiplier on the token estimate (system prompt size, tool chatter). */
  token_overhead: number;
}

export interface CatalogOption {
  /** `${harness}:${model}` */
  id: string;
  harness: HarnessId;
  model: string;
  /** 1 = fast/cheap, 2 = strong, 3 = frontier. */
  tier: 1 | 2 | 3;
  price: { input_per_mtok: number; output_per_mtok: number };
  strengths: TaskType[];
  /** One line shown to Jev. Describe capability, never price — Jev is bad at arithmetic. */
  description: string;
  /** Credentials this option works with, when narrower than the harness's (any one suffices). */
  auth_env?: string[];
}

export interface Catalog {
  harnesses: Record<HarnessId, HarnessInfo>;
  options: CatalogOption[];
}

const ALL_EFFORTS: Effort[] = ["low", "medium", "high", "xhigh", "max"];

export const DEFAULT_HARNESSES: Record<HarnessId, HarnessInfo> = {
  "claude-code": {
    id: "claude-code",
    label: "Claude Code",
    auth_env: ["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN"],
    efforts: ALL_EFFORTS,
    native_resume: true,
    token_overhead: 1.25,
  },
  codex: {
    id: "codex",
    label: "Codex",
    auth_env: ["OPENAI_API_KEY", "CODEX_API_KEY", "CODEX_AUTH_JSON"],
    efforts: ALL_EFFORTS,
    native_resume: true,
    token_overhead: 1.0,
  },
  opencode: {
    id: "opencode",
    label: "OpenCode",
    auth_env: ["OPENROUTER_API_KEY"],
    efforts: [],
    native_resume: true,
    token_overhead: 1.0,
  },
  hermes: {
    id: "hermes",
    label: "Hermes Agent",
    auth_env: ["OPENROUTER_API_KEY"],
    efforts: [],
    native_resume: false,
    token_overhead: 0.8,
  },
  mock: {
    id: "mock",
    label: "Mock (testing)",
    auth_env: [],
    efforts: ALL_EFFORTS,
    native_resume: true,
    token_overhead: 1.0,
  },
};

const CODING: TaskType[] = ["code_change", "debugging", "code_review"];

/**
 * Default catalog. Prices are USD per million tokens as published 2026-09-28
 * (Anthropic, OpenAI, OpenRouter). Override with JEV_ROUTE_CATALOG=path/to/catalog.json.
 */
export const DEFAULT_OPTIONS: CatalogOption[] = [
  // Claude Code
  {
    id: "claude-code:claude-haiku-4-5",
    harness: "claude-code",
    model: "claude-haiku-4-5",
    tier: 1,
    price: { input_per_mtok: 1, output_per_mtok: 5 },
    strengths: ["quick_answer", "ops_shell", "explain"],
    description: "Claude Code with a fast small model: quick edits, shell tasks, short explanations.",
  },
  {
    id: "claude-code:claude-sonnet-5",
    harness: "claude-code",
    model: "claude-sonnet-5",
    tier: 2,
    price: { input_per_mtok: 2, output_per_mtok: 10 },
    strengths: [...CODING, "writing", "explain"],
    description: "Claude Code with a strong model: reliable multi-file code changes, debugging, reviews and writing.",
  },
  {
    id: "claude-code:claude-opus-5",
    harness: "claude-code",
    model: "claude-opus-5",
    tier: 3,
    price: { input_per_mtok: 5, output_per_mtok: 25 },
    strengths: [...CODING, "research", "writing"],
    description: "Claude Code with a frontier model: hardest refactors, architecture changes, long autonomous coding tasks.",
  },
  // Codex — gpt-6-luna/sol need an API key; a ChatGPT login (CODEX_AUTH_JSON) serves gpt-5.6-*.
  {
    id: "codex:gpt-6-luna",
    auth_env: ["OPENAI_API_KEY", "CODEX_API_KEY"],
    harness: "codex",
    model: "gpt-6-luna",
    tier: 1,
    price: { input_per_mtok: 0.1, output_per_mtok: 0.5 },
    strengths: ["quick_answer", "ops_shell", "data_analysis"],
    description: "Codex with a fast small model: well-scoped edits, scripts, extraction and summaries.",
  },
  {
    id: "codex:gpt-6-sol",
    auth_env: ["OPENAI_API_KEY", "CODEX_API_KEY"],
    harness: "codex",
    model: "gpt-6-sol",
    tier: 2,
    price: { input_per_mtok: 2, output_per_mtok: 10 },
    strengths: [...CODING, "data_analysis", "ops_shell"],
    description: "Codex with a strong model: building features, debugging, code review, data analysis.",
  },
  {
    id: "codex:gpt-6-astra",
    harness: "codex",
    model: "gpt-6-astra",
    tier: 3,
    price: { input_per_mtok: 10, output_per_mtok: 50 },
    strengths: [...CODING, "research", "data_analysis"],
    description: "Codex with a frontier model: hardest algorithmic, scientific and mathematical coding problems.",
  },
  {
    id: "codex:gpt-5.6-luna",
    auth_env: ["CODEX_AUTH_JSON"],
    harness: "codex",
    model: "gpt-5.6-luna",
    tier: 1,
    price: { input_per_mtok: 0.2, output_per_mtok: 1.2 },
    strengths: ["quick_answer", "ops_shell", "data_analysis"],
    description: "Codex with a fast small model: well-scoped edits, scripts, extraction and summaries.",
  },
  {
    id: "codex:gpt-5.6-terra",
    auth_env: ["CODEX_AUTH_JSON"],
    harness: "codex",
    model: "gpt-5.6-terra",
    tier: 2,
    price: { input_per_mtok: 2, output_per_mtok: 12 },
    strengths: [...CODING, "data_analysis", "ops_shell"],
    description: "Codex with a strong model: building features, debugging, code review, data analysis.",
  },
  // OpenCode (OpenRouter)
  {
    id: "opencode:openrouter/deepseek/deepseek-v4.1-flash",
    harness: "opencode",
    model: "openrouter/deepseek/deepseek-v4.1-flash",
    tier: 1,
    price: { input_per_mtok: 0.035, output_per_mtok: 0.29 },
    strengths: ["quick_answer", "code_change", "ops_shell"],
    description: "OpenCode with an open-weights flash model: very cheap simple edits, boilerplate, shell tasks.",
  },
  {
    id: "opencode:openrouter/deepseek/deepseek-v4-pro-0813",
    harness: "opencode",
    model: "openrouter/deepseek/deepseek-v4-pro-0813",
    tier: 2,
    price: { input_per_mtok: 0.225, output_per_mtok: 4.2 },
    strengths: [...CODING],
    description: "OpenCode with a strong open-weights reasoning model: solid code changes and debugging at low cost.",
  },
  {
    id: "opencode:openrouter/z-ai/glm-5.3",
    harness: "opencode",
    model: "openrouter/z-ai/glm-5.3",
    tier: 2,
    price: { input_per_mtok: 1.4, output_per_mtok: 4.4 },
    strengths: ["code_change", "writing", "explain"],
    description: "OpenCode with GLM: agentic coding and front-end work.",
  },
  // Hermes (OpenRouter)
  {
    id: "hermes:deepseek/deepseek-v4.1-flash",
    harness: "hermes",
    model: "deepseek/deepseek-v4.1-flash",
    tier: 1,
    price: { input_per_mtok: 0.035, output_per_mtok: 0.29 },
    strengths: ["research", "writing", "quick_answer", "data_analysis"],
    description: "Hermes general agent with a flash model: research, web lookups, writing and summaries.",
  },
  {
    id: "hermes:moonshotai/kimi-k3",
    harness: "hermes",
    model: "moonshotai/kimi-k3",
    tier: 2,
    price: { input_per_mtok: 3, output_per_mtok: 15 },
    strengths: ["research", "writing", "data_analysis"],
    description: "Hermes general agent with Kimi: long multi-step research, reports and non-coding workflows.",
  },
  // Mock (only eligible when enabled explicitly)
  {
    id: "mock:mock-small",
    harness: "mock",
    model: "mock-small",
    tier: 1,
    price: { input_per_mtok: 0.1, output_per_mtok: 0.4 },
    strengths: ["quick_answer", "explain"],
    description: "Mock harness, small tier (tests only).",
  },
  {
    id: "mock:mock-large",
    harness: "mock",
    model: "mock-large",
    tier: 3,
    price: { input_per_mtok: 5, output_per_mtok: 25 },
    strengths: ["code_change", "debugging"],
    description: "Mock harness, large tier (tests only).",
  },
];

export const DEFAULT_CATALOG: Catalog = { harnesses: DEFAULT_HARNESSES, options: DEFAULT_OPTIONS };

/** Rough agent-run token volume by difficulty (input dominates: context is re-sent every step). */
const BASE_INPUT_TOKENS: Record<Difficulty, number> = {
  1: 15_000,
  2: 50_000,
  3: 180_000,
  4: 500_000,
  5: 1_200_000,
};
const OUTPUT_RATIO = 0.04;
const EFFORT_MULTIPLIER: Record<Effort, number> = { low: 0.6, medium: 1, high: 1.5, xhigh: 2, max: 3 };

/** A-priori cost estimate for one run. Corrected at routing time by observed cost ratios. */
export function estimateCostUsd(
  option: CatalogOption,
  harness: HarnessInfo,
  difficulty: Difficulty,
  effort?: Effort,
): number {
  const input = BASE_INPUT_TOKENS[difficulty] * harness.token_overhead * (effort ? EFFORT_MULTIPLIER[effort] : 1);
  const output = input * OUTPUT_RATIO;
  return (input * option.price.input_per_mtok + output * option.price.output_per_mtok) / 1e6;
}

/** Actual cost from token usage when the harness doesn't report dollars. */
export function costFromUsage(option: Pick<CatalogOption, "price">, inputTokens: number, outputTokens: number): number {
  return (inputTokens * option.price.input_per_mtok + outputTokens * option.price.output_per_mtok) / 1e6;
}

export function optionId(harness: HarnessId, model: string): string {
  return `${harness}:${model}`;
}
