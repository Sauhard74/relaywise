import { TASK_TYPES, type CatalogOption, type Difficulty, type RouteFeatures, type TaskType } from "@relaywise/core";
import type { JevAnswer, JevQuestion } from "./jev.ts";

const TASK_TYPE_CRITERIA: Record<TaskType, string> = {
  code_change: "Write, modify or refactor code in a repository (features, fixes with a known cause, migrations).",
  debugging: "Find the cause of a bug, failing test or error, then fix it.",
  code_review: "Review existing code or a diff and report problems; no new feature work.",
  explain: "Explain how code, a concept or a system works; no changes required.",
  research: "Gather information from multiple sources or the web and synthesize findings.",
  writing: "Produce prose: docs, emails, reports, specs, marketing copy.",
  data_analysis: "Analyze, transform or summarize data files, tables or logs.",
  ops_shell: "Run shell commands, configure tools, deploy, install or inspect a system.",
  quick_answer: "A short factual answer or a tiny one-step action.",
};

const DIFFICULTY_LEVELS = [
  "Trivial: one obvious step, seconds of work for an expert.",
  "Easy: a few straightforward steps in one place.",
  "Moderate: several steps or files; needs some investigation.",
  "Hard: many files or subtle reasoning; an expert would need an hour or more.",
  "Very hard: open-ended, architectural or research-grade; long autonomous work.",
];

/** Keep prompts small: Jev degrades on large states full of irrelevant detail. */
export function compactState(prompt: string, maxChars = 6000): string {
  const text = prompt.trim();
  if (text.length <= maxChars) return text;
  const head = Math.floor(maxChars * 0.7);
  const tail = maxChars - head;
  return `${text.slice(0, head)}\n…[${text.length - maxChars} chars omitted]…\n${text.slice(-tail)}`;
}

export function buildQuestions(options: CatalogOption[]): Record<string, JevQuestion> {
  const questions: Record<string, JevQuestion> = {
    task_type: {
      type: "choice",
      instructions:
        "What kind of task is the user asking the agent to do? If earlier turns are shown, classify only the new request, using the earlier turns to understand what it refers to.",
      criteria: TASK_TYPE_CRITERIA,
    },
    difficulty: {
      type: "score",
      instructions:
        "How difficult is the new request for a capable software agent to complete correctly, given the work already done?",
      criteria: DIFFICULTY_LEVELS,
    },
    edits_code: {
      type: "noul",
      instructions: "Does completing this task require creating or modifying code files?",
    },
    long_horizon: {
      type: "noul",
      instructions: "Will the agent likely need more than ten tool calls or steps to finish?",
    },
    needs_web: {
      type: "noul",
      instructions: "Does the task require looking up information on the internet?",
    },
  };
  if (options.length >= 2) {
    questions.best_option = {
      type: "choice",
      instructions:
        "Which agent setup is the best fit to complete this task well? Judge capability fit only.",
      criteria: Object.fromEntries(options.slice(0, 255).map((o) => [o.id, o.description])),
    };
  }
  return questions;
}

export interface ParsedAnswers {
  features: RouteFeatures;
  /** P(option is the best fit), keyed by option id. Empty when not asked. */
  optionProbabilities: Record<string, number>;
}

export function parseAnswers(answers: Record<string, JevAnswer>): ParsedAnswers {
  const taskType = answers.task_type;
  const difficulty = answers.difficulty;
  if (taskType?.type !== "choice" || !isTaskType(taskType.choice)) {
    throw new Error("jev answer missing task_type");
  }
  if (difficulty?.type !== "score" || !Number.isFinite(difficulty.score)) {
    throw new Error("jev answer missing difficulty");
  }
  const level = Math.min(4, Math.max(0, Math.round(difficulty.score)));
  const best = answers.best_option;
  return {
    features: {
      task_type: taskType.choice,
      difficulty: (level + 1) as Difficulty,
      edits_code: noul(answers.edits_code) >= 0.5,
      long_horizon: noul(answers.long_horizon) >= 0.5,
      needs_web: noul(answers.needs_web) >= 0.5,
    },
    optionProbabilities: best?.type === "choice" ? { ...best.probabilities } : {},
  };
}

function noul(a: JevAnswer | undefined): number {
  return a?.type === "noul" && Number.isFinite(a.noul) ? a.noul : 0;
}

function isTaskType(v: string): v is TaskType {
  return (TASK_TYPES as readonly string[]).includes(v);
}
