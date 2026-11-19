// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import type { UsageModelPriceOverride } from "@t3tools/contracts";

import type { SimMetricEvent, SimResolvedPaths } from "./SimContracts.ts";

/** Conservative fallback input USD/1M token rates when no override matches. */
const DEFAULT_INPUT_USD_PER_MILLION: ReadonlyArray<readonly [RegExp, number]> = [
  [/fable|mythos/i, 15],
  [/opus/i, 15],
  [/sonnet/i, 3],
  [/haiku/i, 0.8],
  [/gemini-4-neon|gemini.*pro/i, 2.5],
  [/gemini.*flash/i, 0.3],
  [/gpt-6|astra|sol/i, 5],
  [/luna|mini|nano/i, 0.5],
  [/jev/i, 0.042],
];

const FALLBACK_INPUT_USD_PER_MILLION = 3;

function estimateInputCostUsd(
  model: string,
  tokens: number,
  overrides?: Readonly<Record<string, UsageModelPriceOverride>>,
): number {
  if (!Number.isFinite(tokens) || tokens <= 0) return 0;
  const trimmed = model.trim();
  const override = overrides?.[trimmed];
  if (override !== undefined && Number.isFinite(override.inputCostPerMillionTokens)) {
    return (tokens / 1_000_000) * override.inputCostPerMillionTokens;
  }
  const matched = DEFAULT_INPUT_USD_PER_MILLION.find(([pattern]) => pattern.test(trimmed));
  const rate = matched?.[1] ?? FALLBACK_INPUT_USD_PER_MILLION;
  return (tokens / 1_000_000) * rate;
}

export function appendMetrics(
  paths: Pick<SimResolvedPaths, "metricsPath">,
  events: ReadonlyArray<SimMetricEvent>,
): void {
  if (events.length === 0) return;
  NodeFS.mkdirSync(NodePath.dirname(paths.metricsPath), { recursive: true });
  const payload = `${events.map((event) => JSON.stringify(event)).join("\n")}\n`;
  NodeFS.appendFileSync(paths.metricsPath, payload, "utf8");
}

export function readMetrics(
  paths: Pick<SimResolvedPaths, "metricsPath">,
  sinceMs?: number,
): Array<SimMetricEvent> {
  let raw: string;
  try {
    raw = NodeFS.readFileSync(paths.metricsPath, "utf8");
  } catch {
    return [];
  }
  const out: Array<SimMetricEvent> = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as SimMetricEvent;
      if (!parsed || typeof parsed !== "object" || typeof parsed.kind !== "string") continue;
      if (sinceMs !== undefined) {
        const ms = Date.parse(parsed.ts);
        if (Number.isFinite(ms) && ms < sinceMs) continue;
      }
      out.push(parsed);
    } catch {
      // Ignore partial or malformed lines.
    }
  }
  return out;
}

export interface SimComplianceBucket {
  readonly ruleKey: string;
  readonly problemId?: string | undefined;
  readonly providerInstanceId: string;
  readonly model: string;
  readonly opportunities: number;
  readonly passed: number;
  readonly violated: number;
  readonly uncertain: number;
  readonly misfired: number;
  readonly complianceRate: number | null;
}

export type SimRoiRecommendation =
  | "needs_mechanism"
  | "demote_to_jit"
  | "ablation_candidate"
  | "healthy"
  | "untested";

export interface SimRuleRoiRow {
  readonly ruleKey: string;
  readonly problemId?: string | undefined;
  readonly injections: number;
  readonly tokensInjected: number;
  readonly estimatedCostUsd: number;
  readonly opportunities: number;
  readonly passed: number;
  readonly violated: number;
  readonly uncertain: number;
  readonly misfired: number;
  readonly complianceRate: number | null;
  readonly recommendation: SimRoiRecommendation;
  readonly reason: string;
}

export interface SimRoiSummary {
  readonly totalTokensInjected: number;
  readonly totalEstimatedCostUsd: number;
  readonly totalOpportunities: number;
  readonly totalViolations: number;
  readonly rows: ReadonlyArray<SimRuleRoiRow>;
}

/** Aggregate observation events into a Rule x Provider x Model compliance matrix. */
export function summarizeMetricsMatrix(
  events: ReadonlyArray<SimMetricEvent>,
): ReadonlyArray<SimComplianceBucket> {
  const buckets = new Map<
    string,
    {
      ruleKey: string;
      problemId?: string | undefined;
      providerInstanceId: string;
      model: string;
      opportunities: number;
      passed: number;
      violated: number;
      uncertain: number;
      misfired: number;
    }
  >();

  for (const event of events) {
    if (event.kind !== "observation") continue;
    const key = `${event.ruleKey}\u0000${event.providerInstanceId}\u0000${event.model}`;
    const existing = buckets.get(key) ?? {
      ruleKey: event.ruleKey,
      problemId: event.problemId,
      providerInstanceId: event.providerInstanceId,
      model: event.model,
      opportunities: 0,
      passed: 0,
      violated: 0,
      uncertain: 0,
      misfired: 0,
    };
    if (!existing.problemId && event.problemId) existing.problemId = event.problemId;
    existing.opportunities += 1;
    if (event.verdict === "passed") existing.passed += 1;
    else if (event.verdict === "violated") existing.violated += 1;
    else if (event.verdict === "uncertain") existing.uncertain += 1;
    else if (event.verdict === "misfired") existing.misfired += 1;
    buckets.set(key, existing);
  }

  return [...buckets.values()]
    .map((bucket): SimComplianceBucket => {
      const settled = bucket.passed + bucket.violated;
      return {
        ...bucket,
        complianceRate: settled > 0 ? bucket.passed / settled : null,
      };
    })
    .toSorted(
      (a, b) =>
        b.violated - a.violated ||
        b.opportunities - a.opportunities ||
        a.ruleKey.localeCompare(b.ruleKey),
    );
}

const HIGH_TAX_ZERO_TRIGGER_TOKENS = 20_000;
const ABLATION_MIN_OPPORTUNITIES = 15;
const ABLATION_MIN_COMPLIANCE = 0.95;

/** Compute Token-ROI ("Rule Tax") per rule combining injection cost and observed compliance. */
export function summarizeRuleRoi(
  events: ReadonlyArray<SimMetricEvent>,
  options?: {
    readonly priceOverrides?: Readonly<Record<string, UsageModelPriceOverride>> | undefined;
    readonly highTaxTokensThreshold?: number | undefined;
    readonly ablationMinOpportunities?: number | undefined;
  },
): SimRoiSummary {
  const highTaxThreshold = options?.highTaxTokensThreshold ?? HIGH_TAX_ZERO_TRIGGER_TOKENS;
  const ablationMin = options?.ablationMinOpportunities ?? ABLATION_MIN_OPPORTUNITIES;

  const byRule = new Map<
    string,
    {
      ruleKey: string;
      problemId?: string | undefined;
      injections: number;
      tokensInjected: number;
      estimatedCostUsd: number;
      opportunities: number;
      passed: number;
      violated: number;
      uncertain: number;
      misfired: number;
    }
  >();

  const ensure = (ruleKey: string, problemId?: string) => {
    const existing = byRule.get(ruleKey) ?? {
      ruleKey,
      problemId,
      injections: 0,
      tokensInjected: 0,
      estimatedCostUsd: 0,
      opportunities: 0,
      passed: 0,
      violated: 0,
      uncertain: 0,
      misfired: 0,
    };
    if (!existing.problemId && problemId) existing.problemId = problemId;
    byRule.set(ruleKey, existing);
    return existing;
  };

  for (const event of events) {
    const row = ensure(event.ruleKey, event.problemId);
    if (event.kind === "injection") {
      row.injections += 1;
      row.tokensInjected += event.estimatedTokens;
      row.estimatedCostUsd += estimateInputCostUsd(
        event.model,
        event.estimatedTokens,
        options?.priceOverrides,
      );
    } else {
      row.opportunities += 1;
      if (event.verdict === "passed") row.passed += 1;
      else if (event.verdict === "violated") row.violated += 1;
      else if (event.verdict === "uncertain") row.uncertain += 1;
      else if (event.verdict === "misfired") row.misfired += 1;
    }
  }

  const rows: Array<SimRuleRoiRow> = [...byRule.values()]
    .map((row): SimRuleRoiRow => {
      const settled = row.passed + row.violated;
      const complianceRate = settled > 0 ? row.passed / settled : null;
      let recommendation: SimRoiRecommendation = "healthy";
      let reason = "Balanced compliance and token footprint";

      if (row.violated >= 2 && (complianceRate === null || complianceRate < 0.8)) {
        recommendation = "needs_mechanism";
        reason = `Violated ${row.violated}/${settled} times; consider enforcing at tool boundary or revising rule`;
      } else if (row.misfired >= 2) {
        recommendation = "demote_to_jit";
        reason = `Misfired ${row.misfired} times; narrow trigger or move to just-in-time delivery`;
      } else if (row.opportunities === 0 && row.tokensInjected >= highTaxThreshold) {
        recommendation = "demote_to_jit";
        reason = `Injected ${row.tokensInjected.toLocaleString("en-US")} tokens with 0 triggered opportunities`;
      } else if (
        settled >= ablationMin &&
        complianceRate !== null &&
        complianceRate >= ABLATION_MIN_COMPLIANCE &&
        row.misfired === 0
      ) {
        recommendation = "ablation_candidate";
        reason = `${Math.round(complianceRate * 100)}% compliance across ${settled} opportunities; candidate for ablation test`;
      } else if (row.opportunities === 0) {
        recommendation = "untested";
        reason = "No triggered opportunities recorded yet";
      }

      return {
        ...row,
        complianceRate,
        recommendation,
        reason,
      };
    })
    .toSorted(
      (a, b) =>
        b.violated - a.violated ||
        b.tokensInjected - a.tokensInjected ||
        b.opportunities - a.opportunities ||
        a.ruleKey.localeCompare(b.ruleKey),
    );

  return {
    totalTokensInjected: rows.reduce((sum, row) => sum + row.tokensInjected, 0),
    totalEstimatedCostUsd: rows.reduce((sum, row) => sum + row.estimatedCostUsd, 0),
    totalOpportunities: rows.reduce((sum, row) => sum + row.opportunities, 0),
    totalViolations: rows.reduce((sum, row) => sum + row.violated, 0),
    rows,
  };
}

export function renderMetricsMatrixText(buckets: ReadonlyArray<SimComplianceBucket>): string {
  if (buckets.length === 0) {
    return "SIM Metrics Matrix: no detector or sensor observations recorded yet.";
  }
  const lines = [
    `SIM Metrics Matrix (${buckets.length} rule x provider/model buckets):`,
    "rule | problem | provider/model | opps | passed | violated | uncertain | misfired | compliance",
  ];
  for (const bucket of buckets) {
    const rate =
      bucket.complianceRate === null ? "n/a" : `${Math.round(bucket.complianceRate * 100)}%`;
    lines.push(
      `${bucket.ruleKey} | ${bucket.problemId ?? "-"} | ${bucket.providerInstanceId}/${bucket.model} | ${bucket.opportunities} | ${bucket.passed} | ${bucket.violated} | ${bucket.uncertain} | ${bucket.misfired} | ${rate}`,
    );
  }
  return lines.join("\n");
}

export function renderRuleRoiText(summary: SimRoiSummary): string {
  if (summary.rows.length === 0) {
    return "SIM Rule Tax / Token-ROI: no injection or detector metrics recorded yet.";
  }
  const lines = [
    `SIM Rule Tax / Token-ROI: ${summary.totalTokensInjected.toLocaleString("en-US")} tokens (~$${summary.totalEstimatedCostUsd.toFixed(4)}) | ${summary.totalOpportunities} opportunities | ${summary.totalViolations} violations`,
    "rule | problem | tokens | est_usd | opps | pass/viol/misfire | recommendation | reason",
  ];
  for (const row of summary.rows) {
    lines.push(
      `${row.ruleKey} | ${row.problemId ?? "-"} | ${row.tokensInjected} | $${row.estimatedCostUsd.toFixed(4)} | ${row.opportunities} | ${row.passed}/${row.violated}/${row.misfired} | ${row.recommendation} | ${row.reason}`,
    );
  }
  return lines.join("\n");
}
