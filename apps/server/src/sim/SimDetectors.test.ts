// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { assert, describe, it } from "@effect/vitest";

import { resolveSimPaths } from "./SimContracts.ts";
import {
  diffHarnessSnapshots,
  evaluatePreTurnDeterministicTriggers,
  evaluateRunDetectors,
  snapshotRealHarnessFiles,
  type SimTurnEvidence,
} from "./SimDetectors.ts";

const baseEvidence = (overrides: Partial<SimTurnEvidence> = {}): SimTurnEvidence => ({
  ts: "2026-11-19T20:00:00.000Z",
  threadId: "thread-1",
  runId: "run-1",
  providerInstanceId: "claudeAgent",
  model: "claude-opus-5-5",
  project: "demo-repo",
  commands: [],
  changedFiles: [],
  toolCalls: [],
  ...overrides,
});

describe("SimDetectors", () => {
  it("detects only real harness file hash changes across snapshots and ignores scratch copies", () => {
    const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "sim-det-snap-"));
    const harnessDir = NodePath.join(root, ".claude");
    const simDir = NodePath.join(harnessDir, "sim");
    const scratchDir = NodePath.join(root, "scratch");
    NodeFS.mkdirSync(NodePath.join(harnessDir, "notes"), { recursive: true });
    NodeFS.mkdirSync(simDir, { recursive: true });
    NodeFS.mkdirSync(scratchDir, { recursive: true });

    const agentsPath = NodePath.join(harnessDir, "AGENTS.md");
    const notePath = NodePath.join(harnessDir, "notes", "learning.md");
    const scratchCopy = NodePath.join(scratchDir, "AGENTS.md");
    NodeFS.writeFileSync(agentsPath, "rule one\n", "utf8");
    NodeFS.writeFileSync(notePath, "note one\n", "utf8");
    NodeFS.writeFileSync(scratchCopy, "rule one\n", "utf8");

    const paths = resolveSimPaths({ simDir, harnessDir }, root);
    const before = snapshotRealHarnessFiles(paths);

    // Editing a scratch copy outside harnessDir changes nothing in real harness snapshot.
    NodeFS.writeFileSync(scratchCopy, "scratch mutation\n", "utf8");
    assert.deepEqual(diffHarnessSnapshots(before, snapshotRealHarnessFiles(paths)), []);

    // Editing a real harness file produces the exact canonical path.
    NodeFS.writeFileSync(notePath, "note updated\n", "utf8");
    assert.deepEqual(diffHarnessSnapshots(before, snapshotRealHarnessFiles(paths)), [
      "~/.claude/notes/learning.md",
    ]);
  });

  it("matches pre-turn deterministic triggers for STT, rule inquiries, git workflow, and delegation", () => {
    const triggers = evaluatePreTurnDeterministicTriggers({
      userText:
        "[STT] Soll die Regel in AGENTS.md bleiben oder weg? Danach bitte git commit und einen Opus Reviewer delegieren.",
    });
    const ids = triggers.map((t) => t.triggerId);
    assert.include(ids, "det:stt_dictation");
    assert.include(ids, "det:harness_rule_inquiry");
    assert.include(ids, "det:git_workflow");
    assert.include(ids, "det:delegation");
  });

  it("evaluates foreign-repo attribution, Verified trailer, direct push, and PR linking as both pass and violation", () => {
    const violated = evaluateRunDetectors(
      baseEvidence({
        repoOwnership: "foreign",
        commands: [
          'git commit -m "fix bug\n\nCo-Authored-By: Bot <bot@example.test>"',
          "git push origin HEAD:main",
          'gh pr create --title "Fix" --body "Body"',
        ],
        currentBranch: "feat/fix",
        defaultBranch: "main",
      }),
    );
    const byId = new Map(violated.map((item) => [item.detectorId, item.verdict]));
    assert.equal(byId.get("det:foreign_repo_attribution"), "violated");
    assert.equal(byId.get("det:direct_push_default_branch"), "violated");
    assert.equal(byId.get("det:pr_linked_after_create"), "violated");

    const passed = evaluateRunDetectors(
      baseEvidence({
        repoOwnership: "mine",
        commands: [
          'git commit -m "feat: add detector\n\nVerified: vp test run"',
          "git push -u origin feat/detectors",
          'gh pr create --title "Detectors" --body "Body"',
        ],
        toolCalls: [{ name: "link_pull_request" }],
        currentBranch: "feat/detectors",
        defaultBranch: "main",
      }),
    );
    const passById = new Map(passed.map((item) => [item.detectorId, item.verdict]));
    assert.equal(passById.get("det:verified_commit_trailer"), "passed");
    assert.equal(passById.get("det:direct_push_default_branch"), "passed");
    assert.equal(passById.get("det:pr_linked_after_create"), "passed");
  });

  it("catches STT missing reading, check-only edits, pkill -f, rule inquiry without sim_read, and same-tier planner delegation", () => {
    const results = evaluateRunDetectors(
      baseEvidence({
        model: "claude-fable-5-2",
        userText: "[STT] Soll die Regel in AGENTS.md bleiben oder weg?",
        assistantText: "Die Regel kann weg.",
        changedFiles: ["apps/server/src/sim/SimDetectors.test.ts"],
        commands: ["vp test run apps/server/src/sim/SimDetectors.test.ts", "pkill -f dev-server"],
        toolCalls: [{ name: "delegate_task", input: '{"model":"claude-fable-5-2"}' }],
        hasRemote: true,
        currentBranch: "main",
        defaultBranch: "main",
      }),
    );
    const byId = new Map(results.map((item) => [item.detectorId, item.verdict]));
    assert.equal(byId.get("det:stt_reading_declared"), "violated");
    assert.equal(byId.get("det:check_modified_instead_of_code"), "violated");
    assert.equal(byId.get("det:pkill_f_hazard"), "violated");
    assert.equal(byId.get("det:harness_rule_inquiry_read_sim"), "violated");
    assert.equal(byId.get("det:planner_child_model_tier"), "violated");

    const clean = evaluateRunDetectors(
      baseEvidence({
        model: "claude-fable-5-2",
        userText: "[STT] Soll die Regel in AGENTS.md bleiben oder weg?",
        assistantText:
          "Ich verstehe: Du willst prüfen, ob die Regel bleibt. Nicht: direkt löschen.",
        changedFiles: [
          "apps/server/src/sim/SimDetectors.ts",
          "apps/server/src/sim/SimDetectors.test.ts",
        ],
        commands: ["vp test run apps/server/src/sim/SimDetectors.test.ts"],
        toolCalls: [
          { name: "sim_read" },
          { name: "delegate_task", input: '{"model":"claude-opus-5-5"}' },
        ],
      }),
    );
    const cleanById = new Map(clean.map((item) => [item.detectorId, item.verdict]));
    assert.equal(cleanById.get("det:stt_reading_declared"), "passed");
    assert.equal(cleanById.get("det:check_modified_instead_of_code"), "passed");
    assert.equal(cleanById.get("det:harness_rule_inquiry_read_sim"), "passed");
    assert.equal(cleanById.get("det:planner_child_model_tier"), "passed");
  });
});
