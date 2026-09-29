import type { Difficulty, RouteFeatures, TaskType } from "@relaywise/core";

/**
 * Keyword fallback used when Jev is unavailable, slow or errors. Deliberately simple and
 * general; `pnpm eval:router` measures it against Jev on a labelled task set.
 */
const TASK_RULES: [TaskType, RegExp][] = [
  ["code_review", /\b(review|audit|critique|code smell|look over)\b/i],
  ["data_analysis", /\b(csv|dataset|spreadsheet|sql query|metrics|pandas|chart|(error |access |server )?logs?( file)?\b.*\b(summar|count|common|most|analy))|\banaly[sz]e\b/i],
  ["debugging", /\b(bug|debug(ging)? (the|this|why)|exception|stack ?trace|failing|fails|broken|crash(es|ing)?|regression|doesn'?t work|not working|leak|oom\w*|re-?renders?|p9\d|latency|slow)\b/i],
  ["research", /\b(research|literature|compare|comparison|find out|survey|market|competitors?|state of)\b/i],
  ["ops_shell", /\b(deploy|install|docker(file)?|kubernetes|k8s|helm|github actions|ci\b|workflow|pipeline|shell|bash|terminal|configure|nginx|ssh|cron|list the files)\b/i],
  ["writing", /\b(draft|email|blog|essay|documentation|document for|design doc(ument)?|readme for|copy|announcement)\b/i],
  ["explain", /\b(explain|how does|what does|why does|walk me through|difference between)\b/i],
  ["code_change", /\b(implement|refactor|build|migrate|convert|rename|fix|add|update|write|create|make|port|redesign|optimi[sz]e)\b|\b[\w-]+\.(py|ts|tsx|js|go|rs|java|rb|sh)\b/i],
];

/** Engineering scope/complexity signals. Each distinct one adds a point (capped). */
const COMPLEX =
  /\b(architect(ure)?|redesign|design doc(ument)?|migrat(e|ion)|refactor|across|entire|whole|all (routes|services|endpoints)|multi-?(file|tenan\w*|region)|end[- ]to[- ]end|from scratch|distributed|concurren(t|cy)|race condition|intermittent|flaky|deadlock|memory leak|leak|profil(e|ing)|bottlenecks?|optimi[sz]e|security|vulnerabilit(y|ies)|encryption|consisten(t|cy)|crdt|scal(e|ing)|production|investigate|root cause|comprehensive|literature review|implement|pagination|middleware|rate limit\w*|regression test|property-based)\b/gi;
const EASY = /\b(typo|rename|one[- ]liner|quick|simple|small|tiny|short|just)\b/i;
const QUESTION = /^((what|who|when|where|which|why|how|is|are|does|do|can|should)\b[^.!]*|[^.!]{1,120})\?\s*$/i;

export function heuristicFeatures(prompt: string): RouteFeatures {
  const text = prompt.slice(0, 20_000).trim();
  let task_type: TaskType =
    TASK_RULES.find(([, re]) => re.test(text))?.[0] ?? (QUESTION.test(text) ? "quick_answer" : "code_change");
  if (task_type === "explain" && QUESTION.test(text) && text.length < 80) task_type = "quick_answer";

  const words = text.split(/\s+/).length;
  const complex = new Set((text.match(COMPLEX) ?? []).map((m) => m.toLowerCase().replace(/s$/, "")));
  const clauses = (text.match(/,|;|\band\b|\bthen\b|\bwith\b/gi) ?? []).length;

  let score = task_type === "quick_answer" ? 1 : 2;
  score += Math.min(3, complex.size);
  if (clauses >= 3) score += 1;
  if (words > 60) score += 1;
  if (EASY.test(text) && complex.size === 0) score -= 1;
  const difficulty = Math.min(5, Math.max(1, score)) as Difficulty;

  return {
    task_type,
    difficulty,
    edits_code: task_type === "code_change" || task_type === "debugging",
    long_horizon: difficulty >= 4,
    needs_web: /\b(web|internet|online|latest|current state|news|website|url|https?:\/\/)\b/i.test(text),
  };
}
