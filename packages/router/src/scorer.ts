import {
  EFFORTS,
  estimateCostUsd,
  type CandidateScore,
  type Catalog,
  type CatalogOption,
  type Effort,
  type Objective,
  type RouteFeatures,
} from "@relaywise/core";

/** Observed outcomes for one option on one task type. */
export interface OptionStats {
  runs: number;
  /** Mean quality in [0,1]: explicit feedback when given, else 1 for completed / 0 for failed. */
  quality: number;
  /** Mean of actual_cost / estimated_cost over runs with a known cost. 1 when unknown. */
  cost_ratio: number;
}

export interface PriorsProvider {
  stats(taskType: RouteFeatures["task_type"]): Map<string, OptionStats>;
}

const COST_WEIGHT: Record<Objective, number> = { cheapest: 0.9, balanced: 0.35, best: 0.05 };
const UNDER_TIER_PENALTY = 0.35;
const OVER_TIER_PENALTY = 0.03;
const AFFINITY_BONUS = 0.1;
const JEV_WEIGHT = 0.25;
const PRIOR_WEIGHT = 0.5;
const PRIOR_MEAN = 0.8;
const PRIOR_STRENGTH = 5;
/** Staying on the previous turn's harness keeps its native context; switching costs a briefing. */
const SAME_OPTION_BONUS = 0.12;
const SAME_HARNESS_BONUS = 0.06;

export interface ScoredCandidate extends CandidateScore {
  option: CatalogOption;
  effort?: Effort;
}

export function requiredTier(features: RouteFeatures): 1 | 2 | 3 {
  if (features.difficulty <= 2) return features.long_horizon ? 2 : 1;
  if (features.difficulty === 3) return 2;
  return 3;
}

/** Effort from difficulty, nudged by objective, snapped to what the harness supports. */
export function chooseEffort(
  features: RouteFeatures,
  objective: Objective,
  supported: readonly Effort[],
): Effort | undefined {
  if (supported.length === 0) return undefined;
  const byDifficulty: Record<RouteFeatures["difficulty"], number> = { 1: 0, 2: 0, 3: 1, 4: 2, 5: 3 };
  let idx = byDifficulty[features.difficulty] + (objective === "cheapest" ? -1 : objective === "best" ? 1 : 0);
  idx = Math.min(EFFORTS.length - 1, Math.max(0, idx));
  const wanted = EFFORTS[idx]!;
  if (supported.includes(wanted)) return wanted;
  // nearest supported level
  return [...supported].sort(
    (a, b) => Math.abs(EFFORTS.indexOf(a) - idx) - Math.abs(EFFORTS.indexOf(b) - idx),
  )[0];
}

export interface ScoreInput {
  catalog: Catalog;
  options: CatalogOption[];
  features: RouteFeatures;
  objective: Objective;
  optionProbabilities: Record<string, number>;
  priors?: Map<string, OptionStats>;
  effortOverride?: Effort;
  continuity?: { harness: string; model: string };
}

export function scoreOptions(input: ScoreInput): ScoredCandidate[] {
  const { catalog, options, features, objective, optionProbabilities, priors } = input;
  if (options.length === 0) return [];
  const need = requiredTier(features);
  const maxP = Math.max(0, ...options.map((o) => optionProbabilities[o.id] ?? 0));

  const base = options.map((option) => {
    const harness = catalog.harnesses[option.harness];
    const effort = input.effortOverride ?? chooseEffort(features, objective, harness.efforts);
    const stats = priors?.get(option.id);
    const ratio = stats && stats.runs > 0 ? clamp(stats.cost_ratio, 0.2, 5) : 1;
    const est = estimateCostUsd(option, harness, features.difficulty, effort) * ratio;

    const gap = option.tier - need;
    let quality = 1 - (gap < 0 ? -gap * UNDER_TIER_PENALTY : gap * OVER_TIER_PENALTY);
    if (option.strengths.includes(features.task_type)) quality += AFFINITY_BONUS;
    if (features.long_horizon && option.tier === 1) quality -= 0.1;
    if (input.continuity?.harness === option.harness) {
      quality += input.continuity.model === option.model ? SAME_OPTION_BONUS : SAME_HARNESS_BONUS;
    }

    const p = optionProbabilities[option.id] ?? 0;
    const jev = maxP > 0 ? JEV_WEIGHT * (p / maxP) : 0;

    let prior = 0;
    if (stats && stats.runs > 0) {
      const posterior = (stats.quality * stats.runs + PRIOR_MEAN * PRIOR_STRENGTH) / (stats.runs + PRIOR_STRENGTH);
      prior = PRIOR_WEIGHT * (posterior - PRIOR_MEAN);
    }
    return { option, effort, est, quality, jev, prior };
  });

  const costs = base.map((b) => Math.max(b.est, 1e-6));
  const lo = Math.log10(Math.min(...costs));
  const hi = Math.log10(Math.max(...costs));
  const span = hi - lo;

  return base
    .map((b): ScoredCandidate => {
      const normCost = span > 0 ? (Math.log10(Math.max(b.est, 1e-6)) - lo) / span : 0;
      const costPenalty = COST_WEIGHT[objective] * normCost;
      return {
        option: b.option,
        effort: b.effort,
        option_id: b.option.id,
        est_cost_usd: round(b.est, 6),
        quality_fit: round(b.quality, 4),
        jev_preference: round(b.jev, 4),
        prior_bonus: round(b.prior, 4),
        cost_penalty: round(costPenalty, 4),
        score: round(b.quality + b.jev + b.prior - costPenalty, 4),
      };
    })
    .sort((a, b) => b.score - a.score || a.est_cost_usd - b.est_cost_usd);
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

function round(v: number, digits: number): number {
  const f = 10 ** digits;
  return Math.round(v * f) / f;
}
