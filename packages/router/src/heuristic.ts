import type { Difficulty, RouteFeatures, TaskType } from "@jev-route/core";

/** Keyword rules, checked in order. Used when Jev is unavailable, slow or errors. */
const TASK_RULES: [TaskType, RegExp][] = [
  ["debugging", /\b(bug|debug|error|exception|stack ?trace|failing|fails|broken|crash|regression|doesn'?t work|not working)\b/i],
  ["code_review", /\b(review|audit|critique|code smell|look over)\b/i],
  ["ops_shell", /\b(deploy|install|docker|kubernetes|k8s|ci\b|pipeline|shell|bash|terminal|configure|nginx|ssh|cron)\b/i],
  ["data_analysis", /\b(csv|dataset|analy[sz]e|spreadsheet|sql query|metrics|logs?\b|chart|pandas)\b/i],
  ["research", /\b(research|compare|find out|investigate|sources|survey|market|competitors?)\b/i],
  ["code_change", /\b(implement|refactor|add (a |an )?(feature|endpoint|test)|build|(write|create|make|add) (a |an |the )?(new )?(file|function|class|script|module|component|test|endpoint|cli)|migrate|fix|rename|code)\b|\b[\w-]+\.(py|ts|tsx|js|go|rs|java|rb|sh)\b/i],
  ["writing", /\b(write|draft|email|blog|essay|document(ation)?|readme|summar(y|ize)|copy)\b/i],
  ["explain", /\b(explain|how does|what does|why does|walk me through|understand)\b/i],
];

const HARD = /\b(architect(ure)?|redesign|migrat(e|ion)|across (the )?(codebase|repo)|multi-?file|end[- ]to[- ]end|from scratch|distributed|concurren(t|cy)|race condition|intermittent|flaky|deadlock|memory leak|performance|optimi[sz]e|security|scal(e|ing))\b/gi;
const EASY = /\b(typo|rename|one[- ]liner|quick|simple|small|tiny|just|what is|list)\b/i;

export function heuristicFeatures(prompt: string): RouteFeatures {
  const text = prompt.slice(0, 20_000);
  const task_type = TASK_RULES.find(([, re]) => re.test(text))?.[0] ?? (text.length < 200 ? "quick_answer" : "code_change");

  let score = 2;
  if (text.length > 400) score += 1;
  if (text.length > 2000) score += 1;
  // Each distinct hard signal adds a point, capped at two.
  const hardSignals = new Set((text.match(HARD) ?? []).map((m) => m.toLowerCase()));
  score += Math.min(2, hardSignals.size);
  if (EASY.test(text)) score -= 1;
  if (task_type === "quick_answer") score -= 1;
  const difficulty = Math.min(5, Math.max(1, score)) as Difficulty;

  return {
    task_type,
    difficulty,
    edits_code: task_type === "code_change" || task_type === "debugging",
    long_horizon: difficulty >= 4,
    needs_web: /\b(web|internet|online|latest|news|website|url|https?:\/\/)\b/i.test(text),
  };
}
