// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it } from "@effect/vitest";
import { RunId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ServerSettings from "../serverSettings.ts";
import {
  SimService,
  type SimApplyHarnessChangeRequest,
  type SimCallerContext,
  type SimServiceError,
} from "./SimContracts.ts";
import * as SimServiceLive from "./SimService.ts";

const RULE = "Always run the build before you claim done.";

function sandbox(enabled = true) {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-sim-test-"));
  const harnessDir = NodePath.join(root, "claude");
  const workspace = NodePath.join(root, "repo");
  NodeFS.mkdirSync(NodePath.join(harnessDir, "sim"), { recursive: true });
  NodeFS.mkdirSync(workspace, { recursive: true });
  NodeFS.writeFileSync(NodePath.join(harnessDir, "AGENTS.md"), `# Rules\n- ${RULE}\n`);
  const layer = SimServiceLive.layer.pipe(
    Layer.provide(
      ServerSettings.layerTest({ sim: { enabled, harnessDir, advisorModelSelection: null } }),
    ),
  );
  return {
    harnessDir,
    workspace,
    agents: NodePath.join(harnessDir, "AGENTS.md"),
    journal: NodePath.join(harnessDir, "sim", "sim.jsonl"),
    layer,
    [Symbol.dispose]: () => NodeFS.rmSync(root, { recursive: true, force: true }),
  };
}

const threadId = ThreadId.make("editor");
const runId = RunId.make("run-1");
const editor = (workspaceRoot: string): SimCallerContext => ({
  sessionId: "t3:editor",
  threadId,
  activeRunId: runId,
  model: "gpt-5",
  driver: "codex",
  projectName: "repo",
  workspaceRoot,
});

const quoteRule = (
  extra: Partial<SimApplyHarnessChangeRequest> = {},
): SimApplyHarnessChangeRequest => ({
  file: "~/.claude/AGENTS.md",
  oldText: `- ${RULE}\n`,
  newText: `- ${RULE}\n- Always quote the failing build output verbatim.\n`,
  attempt: {
    new: "Agents paraphrase the failing build output instead of quoting it",
    action: "add",
    what: "Rule to quote the failing build output",
    why: "Paraphrased errors hid the real cause twice",
    anchor: "quote the failing build output verbatim",
    depends_on: ["model"],
    predicted: ["paraphrased-build-errors"],
    expect: "Build errors appear verbatim in reports",
  },
  ...extra,
});

const flipFailure = <A>(effect: Effect.Effect<A, SimServiceError>) => Effect.flip(effect);

describe("SimService.applyHarnessChange", () => {
  it.effect("previews a dry run without writing, then edits and records in one step", () => {
    const sb = sandbox();
    return Effect.gen(function* () {
      const sim = yield* SimService;
      const caller = editor(sb.workspace);
      // Must consult index or by_file before applying or previewing.
      expect((yield* flipFailure(sim.applyHarnessChange(caller, quoteRule()))).code).toBe(
        "seen_required",
      );
      yield* sim.read(caller, { action: "index" });

      const preview = yield* sim.applyHarnessChange(caller, { ...quoteRule(), dryRun: true });
      expect(preview.dryRun).toBe(true);
      expect(preview.predictionLine).toBe(
        "predicted to fix: paraphrased-build-errors; expect: Build errors appear verbatim in reports",
      );
      expect(preview.diffPreview).toContain("+- Always quote the failing build output verbatim.");
      expect(NodeFS.readFileSync(sb.agents, "utf8")).toBe(`# Rules\n- ${RULE}\n`);
      expect(NodeFS.existsSync(sb.journal)).toBe(false);

      const live = yield* sim.applyHarnessChange(caller, quoteRule());
      expect(live).toMatchObject({
        dryRun: false,
        problemId: "P1",
        attemptId: "A1",
        file: "~/.claude/AGENTS.md",
      });
      expect(NodeFS.readFileSync(sb.agents, "utf8")).toContain(
        "quote the failing build output verbatim",
      );
      const event = JSON.parse(NodeFS.readFileSync(sb.journal, "utf8").trim());
      expect(event).toMatchObject({ by: "t3:editor", harness: "codex", op: "attempt" });
      expect(event.data).toMatchObject({
        policy: "gpt-5",
        domain: "global",
        files: ["~/.claude/AGENTS.md"],
      });

      expect(yield* sim.hasRecentAttemptForFile({ threadId, runId, file: sb.agents })).toBe(true);
      expect(yield* sim.hasRecentAttemptForFile({ threadId, file: "~/.claude/AGENTS.md" })).toBe(
        true,
      );
      expect(
        yield* sim.hasRecentAttemptForFile({
          threadId,
          runId: RunId.make("run-2"),
          file: sb.agents,
        }),
      ).toBe(false);

      // Relative workspace paths resolve against workspaceRoot consistently on record and lookup.
      yield* sim.recordRecentAttemptInTurn({
        threadId,
        runId,
        workspaceRoot: sb.workspace,
        files: ["AGENTS.md"],
      });
      expect(
        yield* sim.hasRecentAttemptForFile({
          threadId,
          runId,
          workspaceRoot: sb.workspace,
          file: NodePath.join(sb.workspace, "AGENTS.md"),
        }),
      ).toBe(true);
    }).pipe(Effect.provide(sb.layer), Effect.ensuring(Effect.sync(() => sb[Symbol.dispose]())));
  });

  it.effect(
    "refuses before editing when the caller has not read the index or entry, and again after compaction",
    () => {
      const sb = sandbox();
      return Effect.gen(function* () {
        const sim = yield* SimService;
        const caller = editor(sb.workspace);
        yield* sim.read(caller, { action: "index" });
        yield* sim.applyHarnessChange(caller, quoteRule());
        // Add a second problem so show P1 alone does not cover the full record.
        yield* sim.read(caller, { action: "brief_all" });
        yield* sim.read(caller, { action: "show", ids: ["P1"] });
        yield* sim.applyHarnessChange(caller, {
          file: sb.agents,
          append: true,
          content: "- Never force push shared branches.\n",
          attempt: {
            new: "Agents force push shared branches without asking first",
            action: "add",
            what: "Forbid force pushing shared branches",
            why: "Force push overwrote teammate work",
            anchor: "Never force push shared branches.",
            depends_on: ["user"],
            predicted: ["force-push-loss"],
            expect: "No force pushes",
          },
        });
        const other = {
          ...editor(sb.workspace),
          sessionId: "t3:other",
          threadId: ThreadId.make("other"),
        };
        const revise: SimApplyHarnessChangeRequest = {
          file: sb.agents,
          oldText: "quote the failing build output verbatim",
          newText: "quote the failing build output verbatim, with its exit code",
          attempt: {
            problem: "P1",
            action: "revise",
            supersedes: ["A1"],
            what: "Also quote the exit code",
            why: "Reports dropped the exit code",
            anchor: "with its exit code",
            depends_on: ["model"],
            predicted: ["paraphrased-build-errors"],
            expect: "Exit codes appear in reports",
          },
        };
        const before = NodeFS.readFileSync(sb.agents, "utf8");
        const unread = yield* flipFailure(sim.applyHarnessChange(other, revise));
        expect(unread.code).toBe("seen_required");
        expect(NodeFS.readFileSync(sb.agents, "utf8")).toBe(before);

        // show P1 alone is not enough when other problems exist and index/by_file was not consulted.
        yield* sim.read(other, { action: "show", ids: ["P1"] });
        expect((yield* flipFailure(sim.applyHarnessChange(other, revise))).code).toBe(
          "seen_required",
        );

        yield* sim.read(other, { action: "by_file", file: sb.agents });
        yield* sim.resetThreadSeenEpoch(other.threadId);
        expect(yield* sim.getThreadSeenEpoch(other.threadId)).toBe(1);
        expect((yield* flipFailure(sim.applyHarnessChange(other, revise))).code).toBe(
          "seen_required",
        );

        yield* sim.read(other, { action: "by_file", file: sb.agents });
        yield* sim.read(other, { action: "show", ids: ["P1"] });
        expect((yield* sim.applyHarnessChange(other, revise)).attemptId).toBe("A3");
      }).pipe(Effect.provide(sb.layer), Effect.ensuring(Effect.sync(() => sb[Symbol.dispose]())));
    },
  );

  it.effect("puts the file back when the journal append fails", () => {
    const sb = sandbox();
    return Effect.gen(function* () {
      const sim = yield* SimService;
      const caller = editor(sb.workspace);
      yield* sim.read(caller, { action: "index" });
      // A dangling link reads as an empty journal but cannot be appended to.
      NodeFS.symlinkSync(NodePath.join(sb.harnessDir, "missing", "sim.jsonl"), sb.journal);
      const before = NodeFS.readFileSync(sb.agents);
      const error = yield* flipFailure(sim.applyHarnessChange(caller, quoteRule()));
      expect(error.code).toBe("io");
      expect(NodeFS.readFileSync(sb.agents).equals(before)).toBe(true);

      const created = NodePath.join(sb.harnessDir, "notes", "new.md");
      yield* flipFailure(
        sim.applyHarnessChange(caller, {
          ...quoteRule(),
          file: created,
          oldText: undefined,
          newText: undefined,
          content: "- Always quote the failing build output verbatim.\n",
        }),
      );
      expect(NodeFS.existsSync(created)).toBe(false);
    }).pipe(Effect.provide(sb.layer), Effect.ensuring(Effect.sync(() => sb[Symbol.dispose]())));
  });

  it.effect("preserves symlinks and executable permissions when applying harness edits", () => {
    const sb = sandbox();
    return Effect.gen(function* () {
      const sim = yield* SimService;
      const caller = editor(sb.workspace);
      yield* sim.read(caller, { action: "index" });

      // Dotfiles-style symlinked AGENTS.md stays a symlink while updating its realpath target.
      const dotfilesDir = NodePath.join(NodePath.dirname(sb.harnessDir), "dotfiles");
      NodeFS.mkdirSync(dotfilesDir, { recursive: true });
      const realAgents = NodePath.join(dotfilesDir, "AGENTS.md");
      NodeFS.writeFileSync(realAgents, `# Rules\n- ${RULE}\n`, { mode: 0o640 });
      NodeFS.chmodSync(realAgents, 0o640);
      NodeFS.rmSync(sb.agents);
      NodeFS.symlinkSync(realAgents, sb.agents);

      const applied = yield* sim.applyHarnessChange(caller, quoteRule());
      expect(applied.attemptId).toBe("A1");
      expect(NodeFS.lstatSync(sb.agents).isSymbolicLink()).toBe(true);
      expect(NodeFS.readFileSync(realAgents, "utf8")).toContain(
        "quote the failing build output verbatim",
      );
      expect(NodeFS.statSync(realAgents).mode & 0o777).toBe(0o640);

      // Executable hook script preserves +x bit.
      const hooksDir = NodePath.join(sb.harnessDir, "hooks");
      NodeFS.mkdirSync(hooksDir, { recursive: true });
      const script = NodePath.join(hooksDir, "check.sh");
      NodeFS.writeFileSync(script, "#!/bin/sh\necho ok\n", { mode: 0o755 });
      NodeFS.chmodSync(script, 0o755);
      yield* sim.read(caller, { action: "brief_all" });
      yield* sim.read(caller, { action: "show", ids: ["P1"] });
      const hookResult = yield* sim.applyHarnessChange(caller, {
        file: "~/.claude/hooks/check.sh",
        oldText: "echo ok",
        newText: "echo verified-ok",
        attempt: {
          new: "Shell hooks omit verification markers in stdout logs",
          action: "add",
          what: "Emit verified-ok marker in check.sh",
          why: "Log parser could not distinguish dry-run from real pass",
          anchor: "echo verified-ok",
          depends_on: ["environment"],
          predicted: ["ambiguous-hook-log"],
          expect: "Hook stdout contains verified-ok",
        },
      });
      expect(hookResult.attemptId).toBe("A2");
      expect(NodeFS.statSync(script).mode & 0o777).toBe(0o755);
    }).pipe(Effect.provide(sb.layer), Effect.ensuring(Effect.sync(() => sb[Symbol.dispose]())));
  });

  it.effect(
    "refuses SIM record files, non-harness files, and harness files outside harnessDir and workspace",
    () => {
      const sb = sandbox();
      return Effect.gen(function* () {
        const sim = yield* SimService;
        const outsideDir = NodePath.join(NodePath.dirname(sb.workspace), "other-repo");
        NodeFS.mkdirSync(outsideDir, { recursive: true });
        const outsideAgents = NodePath.join(outsideDir, "AGENTS.md");
        NodeFS.writeFileSync(outsideAgents, "# Other repo\n");
        NodeFS.writeFileSync(NodePath.join(sb.workspace, "README.md"), "hello\n");
        const targets = [
          "~/.claude/sim/sim.jsonl",
          "~/.claude/sim/sim.json",
          "~/.claude/sim/sim.lock",
          "~/.claude/sim/seen/abcd.json",
          "~/.claude/sim/telemetry.jsonl",
          "README.md",
          outsideAgents,
        ].map((file) => file.replace("~/.claude", sb.harnessDir));
        for (const file of targets) {
          const error = yield* flipFailure(
            sim.applyHarnessChange(editor(sb.workspace), {
              ...quoteRule(),
              file,
              oldText: undefined,
              newText: undefined,
              content: "x",
            }),
          );
          expect([file, error.code]).toEqual([file, "forbidden_path"]);
        }
        expect(NodeFS.existsSync(sb.journal)).toBe(false);
      }).pipe(Effect.provide(sb.layer), Effect.ensuring(Effect.sync(() => sb[Symbol.dispose]())));
    },
  );

  it.effect("does nothing while SIM is turned off", () => {
    const sb = sandbox(false);
    return Effect.gen(function* () {
      const sim = yield* SimService;
      expect(
        (yield* flipFailure(sim.applyHarnessChange(editor(sb.workspace), quoteRule()))).code,
      ).toBe("disabled");
      expect((yield* flipFailure(sim.read(editor(sb.workspace), { action: "index" }))).code).toBe(
        "disabled",
      );
      expect(yield* sim.getStateSnapshot()).toBeNull();
    }).pipe(Effect.provide(sb.layer), Effect.ensuring(Effect.sync(() => sb[Symbol.dispose]())));
  });
});
