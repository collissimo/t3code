// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { assert, describe, it } from "@effect/vitest";

import { resolveSimPaths, type SimMetricEvent } from "./SimContracts.ts";
import {
  appendMetrics,
  readMetrics,
  renderMetricsMatrixText,
  renderRuleRoiText,
  summarizeMetricsMatrix,
  summarizeRuleRoi,
} from "./SimMetricsStore.ts";

describe("SimMetricsStore", () => {
  it("persists and reads metrics.jsonl with time filtering and malformed-line resilience", () => {
    const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "sim-metrics-"));
    const paths = resolveSimPaths({ simDir: NodePath.join(root, "sim") }, root);

    const events: ReadonlyArray<SimMetricEvent> = [
      {
        ts: "2026-11-10T10:00:00.000Z",
        kind: "observation",
        detectorId: "det:verified_commit_trailer",
        ruleKey: "verified-commit-trailer",
        problemId: "P44",
        verdict: "passed",
        source: "deterministic",
        providerInstanceId: "claudeAgent",
        model: "claude-opus-5-5",
      },
      {
        ts: "2026-11-19T10:00:00.000Z",
        kind: "injection",
        ruleKey: "rare-ssh-rule",
        problemId: "P1",
        delivery: "base",
        bytes: 100_000,
        estimatedTokens: 25_000,
        providerInstanceId: "antigravity",
        model: "gemini-4-neon",
      },
    ];
    appendMetrics(paths, events);
    NodeFS.appendFileSync(paths.metricsPath, "{corrupt json\n", "utf8");

    const all = readMetrics(paths);
    assert.equal(all.length, 2);
    const recent = readMetrics(paths, Date.parse("2026-11-15T00:00:00.000Z"));
    assert.equal(recent.length, 1);
    assert.equal(recent[0]?.kind, "injection");
  });

  it("computes compliance matrix and Token-ROI recommendations accurately", () => {
    const events: Array<SimMetricEvent> = [
      // High token burn with zero opportunities -> demote_to_jit
      {
        ts: "2026-11-19T10:00:00.000Z",
        kind: "injection",
        ruleKey: "never-fired-rule",
        problemId: "P37",
        delivery: "base",
        bytes: 120_000,
        estimatedTokens: 30_000,
        providerInstanceId: "claudeAgent",
        model: "claude-opus-5-5",
      },
      // Repeated violations -> needs_mechanism
      ...Array.from({ length: 3 }, (_, idx): SimMetricEvent => ({
        ts: `2026-11-19T10:0${idx}:00.000Z`,
        kind: "observation",
        detectorId: "det:foreign_repo_attribution",
        ruleKey: "foreign-repo-attribution",
        problemId: "P22",
        verdict: idx === 0 ? "passed" : "violated",
        source: "deterministic",
        providerInstanceId: "codex",
        model: "gpt-6-luna",
      })),
      // 16 clean opportunities with 100% compliance -> ablation_candidate
      ...Array.from({ length: 16 }, (_, idx): SimMetricEvent => ({
        ts: `2026-11-19T11:${String(idx).padStart(2, "0")}:00.000Z`,
        kind: "observation",
        detectorId: "det:verified_commit_trailer",
        ruleKey: "verified-commit-trailer",
        problemId: "P44",
        verdict: "passed",
        source: "deterministic",
        providerInstanceId: "claudeAgent",
        model: "claude-opus-5-5",
      })),
    ];

    const matrix = summarizeMetricsMatrix(events);
    assert.equal(matrix.length, 2);
    const foreign = matrix.find((b) => b.ruleKey === "foreign-repo-attribution");
    assert.equal(foreign?.opportunities, 3);
    assert.equal(foreign?.violated, 2);
    assert.equal(Math.round((foreign?.complianceRate ?? 0) * 100), 33);

    const roi = summarizeRuleRoi(events);
    const rec = new Map(roi.rows.map((row) => [row.ruleKey, row.recommendation]));
    assert.equal(rec.get("never-fired-rule"), "demote_to_jit");
    assert.equal(rec.get("foreign-repo-attribution"), "needs_mechanism");
    assert.equal(rec.get("verified-commit-trailer"), "ablation_candidate");
    assert.isAbove(roi.totalEstimatedCostUsd, 0.4);
    assert.include(renderMetricsMatrixText(matrix), "foreign-repo-attribution");
    assert.include(renderRuleRoiText(roi), "ablation_candidate");
  });
});
