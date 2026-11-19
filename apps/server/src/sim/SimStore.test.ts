// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it } from "@effect/vitest";
import { ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import {
  classifyHarnessPath,
  resolveSimPaths,
  SimServiceError,
  type SimCallerContext,
  type SimJournalEvent,
  type SimResolvedPaths,
  type SimWriteRequest,
} from "./SimContracts.ts";
import * as SimStore from "./SimStore.ts";

function sandbox() {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-sim-test-"));
  const harnessDir = NodePath.join(root, "claude");
  NodeFS.mkdirSync(NodePath.join(harnessDir, "notes"), { recursive: true });
  const paths = resolveSimPaths({ harnessDir }, root);
  return {
    paths,
    harness: (rel: string, text: string) => {
      NodeFS.mkdirSync(NodePath.dirname(NodePath.join(harnessDir, rel)), { recursive: true });
      NodeFS.writeFileSync(NodePath.join(harnessDir, rel), text);
    },
    [Symbol.dispose]: () => NodeFS.rmSync(root, { recursive: true, force: true }),
  };
}

const caller = (name: string, extra: Partial<SimCallerContext> = {}): SimCallerContext => ({
  sessionId: `t3:${name}`,
  threadId: ThreadId.make(name),
  model: "gpt-5",
  driver: "codex",
  ...extra,
});
const author = caller("author", { alsoSessionId: "cc:author-native" });
const reviewer = caller("reviewer", { model: "claude-opus-5-5", driver: "claudeAgent" });

const write = (paths: SimResolvedPaths, who: SimCallerContext, request: SimWriteRequest) =>
  SimStore.runWrite(paths, who, request);

const journal = (paths: SimResolvedPaths): Array<SimJournalEvent> =>
  NodeFS.readFileSync(paths.journalPath, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as SimJournalEvent);

const isSimServiceError = Schema.is(SimServiceError);

const failure = (run: () => unknown) => {
  try {
    run();
  } catch (error) {
    if (isSimServiceError(error)) return error;
    throw error;
  }
  throw new Error("expected a SimServiceError");
};

const RULE = "Always run the build before you claim done.";

function readIndex(paths: SimResolvedPaths, who = author) {
  return SimStore.runRead(
    {
      paths,
      loaded: SimStore.loadReadOnly(paths),
      caller: who,
      settings: { advisorModelSelection: null },
      telemetry: [],
    },
    { action: "index" },
  );
}

function recordRule(paths: SimResolvedPaths, who = author) {
  readIndex(paths, who);
  return write(paths, who, {
    action: "attempt",
    input: {
      new: "Agents claim done without running the build",
      action: "add",
      what: "Rule to run the build first",
      why: "Two threads claimed done on a red build",
      files: ["~/.claude/AGENTS.md"],
      anchor: "run the build before you claim done",
      depends_on: ["model"],
      predicted: ["unverified-done"],
      expect: "No done claim without build output",
    },
  });
}

const observe = (
  paths: SimResolvedPaths,
  who: SimCallerContext,
  extra: Record<string, unknown> = {},
) =>
  write(paths, who, {
    action: "observe",
    input: {
      attempt: "A1",
      target: "unverified-done",
      result: "fixed",
      evidence: "the next thread ran the build before claiming done",
      source: "log",
      ...extra,
    },
  });

describe("SimStore journal", () => {
  it("keeps harness on the event envelope and replays it onto attempts and outcomes", () => {
    using sb = sandbox();
    sb.harness("AGENTS.md", `# Rules\n- ${RULE}\n`);
    recordRule(sb.paths);
    observe(sb.paths, reviewer);

    const [attemptEvent, observeEvent] = journal(sb.paths);
    expect(attemptEvent?.harness).toBe("codex");
    expect(attemptEvent?.also).toBe("cc:author-native");
    expect(attemptEvent?.data).not.toHaveProperty("harness");
    expect(observeEvent?.harness).toBe("claudeAgent");
    expect(observeEvent?.data.observation).not.toHaveProperty("harness");

    const { state } = SimStore.load(sb.paths);
    const attempt = state.problems[0]!.attempts[0]!;
    expect(attempt.harness).toBe("codex");
    expect(attempt.observations[0]?.harness).toBe("claudeAgent");
    expect(attempt.fixed).toEqual(["unverified-done"]);
  });

  it("writes schema-3 sim.json without harness fields, never rewrites on read-only load, and notes hand edits on locked load", () => {
    using sb = sandbox();
    sb.harness("AGENTS.md", `- ${RULE}\n`);
    recordRule(sb.paths);
    observe(sb.paths, reviewer);
    const written = NodeFS.readFileSync(sb.paths.recordPath, "utf8");
    const parsed = JSON.parse(written) as {
      schema: number;
      problems: Array<{ attempts: Array<Record<string, unknown>> }>;
    };
    expect(parsed.schema).toBe(3);
    expect(parsed.problems[0]!.attempts[0]).not.toHaveProperty("harness");
    expect(
      (parsed.problems[0]!.attempts[0]!.observations as Array<Record<string, unknown>>)[0],
    ).not.toHaveProperty("harness");

    // Read-only load replays harness in memory from sim.jsonl without rewriting sim.json on disk.
    const edited = JSON.stringify({ ...parsed, problems: [] });
    NodeFS.writeFileSync(sb.paths.recordPath, edited);
    const ro = SimStore.loadReadOnly(sb.paths);
    expect(ro.healed).toBe(false);
    expect(ro.state.problems[0]!.attempts[0]!.harness).toBe("codex");
    expect(NodeFS.readFileSync(sb.paths.recordPath, "utf8")).toBe(edited);

    // Locked load rebuilds a hand-edited schema-3 sim.json and notes it, while an older schema rebuilds silently.
    expect(SimStore.load(sb.paths).healed).toBe(true);
    expect(NodeFS.readFileSync(sb.paths.recordPath, "utf8")).toBe(written);

    NodeFS.writeFileSync(
      sb.paths.recordPath,
      JSON.stringify({ ...parsed, schema: 2, problems: [] }),
    );
    expect(SimStore.load(sb.paths).healed).toBe(false);
    expect(NodeFS.readFileSync(sb.paths.recordPath, "utf8")).toBe(written);
  });

  it("refuses writes after a past line was edited, and restore puts back the last written journal", () => {
    using sb = sandbox();
    sb.harness("AGENTS.md", `- ${RULE}\n`);
    recordRule(sb.paths);
    observe(sb.paths, reviewer);
    const lines = NodeFS.readFileSync(sb.paths.journalPath, "utf8").split("\n");
    NodeFS.writeFileSync(
      sb.paths.journalPath,
      [lines[0]!.replace("Two threads", "Ten threads"), ...lines.slice(1)].join("\n"),
    );

    expect(SimStore.load(sb.paths).journal.broken).toMatch(/does not continue the line before it/);
    expect(failure(() => observe(sb.paths, reviewer)).code).toBe("journal_broken");

    const restored = SimStore.restore(sb.paths);
    expect(restored.events).toBe(2);
    expect(restored.kept && NodeFS.existsSync(restored.kept)).toBe(true);
    expect(SimStore.load(sb.paths).journal.broken).toBeNull();
  });

  it("flags a journal that was cut below what sim.json and the backup hold", () => {
    using sb = sandbox();
    sb.harness("AGENTS.md", `- ${RULE}\n`);
    recordRule(sb.paths);
    observe(sb.paths, reviewer);
    const first = NodeFS.readFileSync(sb.paths.journalPath, "utf8").split("\n")[0];
    NodeFS.writeFileSync(sb.paths.journalPath, `${first}\n`);
    expect(SimStore.load(sb.paths).journal.broken).toMatch(/sim\.json holds 2 events/);
    NodeFS.rmSync(sb.paths.recordPath);
    expect(SimStore.load(sb.paths).journal.broken).toMatch(/backup sim-.*holds 2 events/);
  });

  it("refuses the same change twice and a backfill of today's own change", () => {
    using sb = sandbox();
    sb.harness("AGENTS.md", `- ${RULE}\n`);
    recordRule(sb.paths);
    expect(failure(() => recordRule(sb.paths)).problems.join()).toMatch(
      /already in the record as A1/,
    );
    const backfill = failure(() =>
      write(sb.paths, author, {
        action: "attempt",
        input: {
          problem: "P1",
          action: "add",
          what: "Another rule",
          why: "Backfilling my own change",
          files: ["~/.claude/AGENTS.md"],
          anchor: "run the build before you claim done",
          depends_on: ["model"],
          predicted: ["unverified-done"],
          backfilled: true,
          round: SimStore.today(),
        },
      }),
    );
    expect(backfill.problems.join()).toMatch(/a change made today is recorded as it is/);
  });
});

describe("SimStore self-grading", () => {
  const cases: Array<[string, SimCallerContext, Record<string, unknown>, string | null]> = [
    ["the same session", author, {}, "same session as the change"],
    [
      "a session sharing the native cc: id",
      caller("other", { alsoSessionId: "cc:author-native" }),
      {},
      "same session as the change",
    ],
    [
      "the same id under the other kind",
      { ...caller("x"), sessionId: "cc:author" },
      {},
      "same session as the change",
    ],
    ["a self-reported source", reviewer, { source: "self" }, "self-reported"],
    [
      "an unknown session",
      { sessionId: "unknown", model: "gpt-5" },
      {},
      "the reporting session is unknown",
    ],
    [
      "a fork of the author",
      caller("fork", { forkFamilySessionIds: ["t3:author"] }),
      {},
      "reported from the fork or side-chat family of the session that made the change",
    ],
    [
      "a server-detected self grade",
      reviewer,
      { selfGradeReason: "side chat of the author" },
      "side chat of the author",
    ],
    ["an unrelated session", reviewer, {}, null],
  ];

  it.each(cases)("a fix reported by %s", (_label, who, extra, reason) => {
    using sb = sandbox();
    sb.harness("AGENTS.md", `- ${RULE}\n`);
    recordRule(sb.paths);
    const result = observe(sb.paths, who, extra);
    expect(result.unconfirmedReason ?? null).toBe(reason);
    expect(result.settled).toBe(reason === null);
    const recorded = journal(sb.paths)[1]!.data.observation as Record<string, unknown>;
    if (
      reason !== null &&
      reason !== "same session as the change" &&
      reason !== "the reporting session is unknown"
    ) {
      // Coerced to "self" on disk, so sim.mjs refuses to settle it as well.
      expect(recorded.source).toBe("self");
    }
    expect(SimStore.load(sb.paths).state.problems[0]!.attempts[0]!.fixed).toEqual(
      reason === null ? ["unverified-done"] : [],
    );
  });

  it("preserves the original source when a fork records a non-fixed observation", () => {
    using sb = sandbox();
    sb.harness("AGENTS.md", `- ${RULE}\n`);
    recordRule(sb.paths);
    observe(sb.paths, caller("fork", { forkFamilySessionIds: ["t3:author"] }), {
      result: "missed",
      source: "user",
      evidence: "user caught another unverified done claim in a fork",
    });
    const recorded = journal(sb.paths)[1]!.data.observation as Record<string, unknown>;
    expect(recorded.result).toBe("missed");
    expect(recorded.source).toBe("user");
  });
});

describe("classifyHarnessPath", () => {
  it("matches sim-gate.mjs for harness directories, project .claude directories, and /var/tmp", () => {
    using sb = sandbox();
    const project = NodePath.join(sb.paths.homeDir, "repo");
    const opts = { allowTmp: false };
    expect(
      classifyHarnessPath(
        NodePath.join(sb.paths.harnessDir, "skills/review/SKILL.md"),
        sb.paths,
        undefined,
        opts,
      ),
    ).toBe("harness");
    expect(
      classifyHarnessPath(
        NodePath.join(sb.paths.harnessDir, "agents/critic.md"),
        sb.paths,
        undefined,
        opts,
      ),
    ).toBe("harness");
    expect(
      classifyHarnessPath(
        NodePath.join(sb.paths.harnessDir, "commands/check.md"),
        sb.paths,
        undefined,
        opts,
      ),
    ).toBe("harness");
    expect(
      classifyHarnessPath(
        NodePath.join(sb.paths.harnessDir, "output-styles/concise.md"),
        sb.paths,
        undefined,
        opts,
      ),
    ).toBe("harness");
    expect(
      classifyHarnessPath(
        NodePath.join(sb.paths.harnessDir, "settings.local.json"),
        sb.paths,
        undefined,
        opts,
      ),
    ).toBe("harness");
    expect(
      classifyHarnessPath(NodePath.join(project, ".claude/hooks/check.mjs"), sb.paths, undefined, {
        allowTmp: true,
      }),
    ).toBe("harness");
    expect(
      classifyHarnessPath(
        NodePath.join(project, ".claude/skills/foo/SKILL.md"),
        sb.paths,
        undefined,
        { allowTmp: true },
      ),
    ).toBe("harness");
    expect(classifyHarnessPath("/var/tmp/AGENTS.md", sb.paths, undefined, opts)).toBeNull();
  });
});

describe("SimStore harness inspection", () => {
  it("reports Scars and hooks without a record, and drift once a recorded anchor vanishes", () => {
    using sb = sandbox();
    sb.harness(
      "AGENTS.md",
      `# Rules\n\n## Scars\n- Scar: ${RULE}\n- Scar: never push to main without asking.\n`,
    );
    sb.harness("hooks/gate.mjs", "export {};\n");
    recordRule(sb.paths);

    const before = SimStore.inspectHarness(SimStore.load(sb.paths).state, sb.paths);
    expect(before.drift).toEqual([]);
    expect(before.uncovered.map((unit) => unit.text ?? unit.file)).toEqual([
      "- Scar: never push to main without asking.",
      "~/.claude/hooks/gate.mjs",
    ]);

    sb.harness("AGENTS.md", "# Rules\n\n## Scars\n- Scar: build first.\n");
    const after = SimStore.inspectHarness(SimStore.load(sb.paths).state, sb.paths);
    expect(after.drift.map((item) => item.attempt.id)).toEqual(["A1"]);
  });
});

describe("SimStore seen tracking", () => {
  const read = (paths: SimResolvedPaths, who: SimCallerContext, ids?: Array<string>) =>
    SimStore.runRead(
      {
        paths,
        loaded: SimStore.load(paths),
        caller: who,
        settings: { advisorModelSelection: null },
        telemetry: [],
      },
      ids ? { action: "show", ids } : { action: "brief_all" },
    );

  it("counts an entry shown in parts only once every part was shown", () => {
    using sb = sandbox();
    sb.harness("AGENTS.md", `- ${RULE}\n`);
    recordRule(sb.paths);
    const { state } = SimStore.load(sb.paths);
    const problem = state.problems[0]!;
    const scope = SimStore.seenScope(sb.paths, reviewer);
    SimStore.markShown(sb.paths, state, [{ problem, from: 0, to: 40, of: 100 }], "full", scope);
    SimStore.markShown(sb.paths, state, [{ problem, from: 60, to: 100, of: 100 }], "full", scope);
    expect(SimStore.shownTo(sb.paths, state, scope).has("P1")).toBe(false);
    SimStore.markShown(sb.paths, state, [{ problem, from: 35, to: 65, of: 100 }], "full", scope);
    expect(SimStore.shownTo(sb.paths, state, scope).get("P1")).toBe("full");
  });

  it("asks a new root cause for the whole record in brief and its closest entries in full", () => {
    using sb = sandbox();
    sb.harness("AGENTS.md", `- ${RULE}\n- Always quote the failing build output.\n`);
    recordRule(sb.paths);
    const newCause = () =>
      write(sb.paths, reviewer, {
        action: "attempt",
        input: {
          new: "Agents paraphrase the failing build output instead of quoting it",
          action: "add",
          what: "Rule to quote the failing build output",
          why: "Paraphrased errors hid the real cause",
          files: ["~/.claude/AGENTS.md"],
          anchor: "quote the failing build output",
          depends_on: ["model"],
          predicted: ["paraphrased-build-errors"],
          expect: "Build errors appear verbatim",
        },
      });
    const unseen = failure(newCause);
    expect(unseen.code).toBe("seen_required");
    expect(unseen.problems.join("\n")).toMatch(/read this entry in full first: .*P1/);
    read(sb.paths, reviewer);
    expect(failure(newCause).problems.join("\n")).toMatch(/shares words with your change/);
    read(sb.paths, reviewer, ["P1"]);
    expect(newCause().problemId).toBe("P2");
  });

  it("voids readings from before a compaction, across reloads and for the native session too", () => {
    using sb = sandbox();
    sb.harness("AGENTS.md", `- ${RULE}\n`);
    recordRule(sb.paths);
    const reader = caller("reader", { alsoSessionId: "cc:reader-native" });
    const continueP1 = () =>
      write(sb.paths, reader, {
        action: "amend",
        target: "A1",
        field: "why",
        value: "Two threads claimed done on a red build, seen twice",
        reason: "more evidence",
      });
    read(sb.paths, reader, ["P1"]);
    const nativeLog = NodePath.join(
      sb.paths.seenDir,
      `${SimStore.sha("cc:reader-native").slice(0, 16)}.json`,
    );
    const preCompaction = NodeFS.readFileSync(nativeLog, "utf8");
    expect(JSON.parse(preCompaction).full.P1).toBeTypeOf("string");

    expect(SimStore.resetThreadSeenEpoch(sb.paths, "reader", ["cc:reader-native"])).toBe(1);
    expect(SimStore.getThreadSeenEpoch(sb.paths, "reader")).toBe(1);
    // A log from the old context put back (or written late) must not count either.
    NodeFS.writeFileSync(nativeLog, preCompaction);
    const scope = SimStore.seenScope(sb.paths, reader);
    expect(SimStore.shownTo(sb.paths, SimStore.load(sb.paths).state, scope).size).toBe(0);
    expect(failure(continueP1).code).toBe("seen_required");

    read(sb.paths, reader, ["P1"]);
    expect(JSON.parse(NodeFS.readFileSync(nativeLog, "utf8")).t3_epoch).toBe(1);
    expect(continueP1().text).toBe("amended A1.");
  });

  it("requires index or by_file in the current epoch before recording an attempt, even after show P1", () => {
    using sb = sandbox();
    sb.harness("AGENTS.md", `- ${RULE}\n- Always quote build errors.\n- Never force push.\n`);
    recordRule(sb.paths);
    // Add a second problem so show P1 alone does not cover the entire record.
    read(sb.paths, author);
    read(sb.paths, author, ["P1"]);
    write(sb.paths, author, {
      action: "attempt",
      input: {
        new: "Agents force push shared feature branches without consent",
        action: "add",
        what: "Forbid force push",
        why: "Lost reviewer commits",
        files: ["~/.claude/AGENTS.md"],
        anchor: "Never force push.",
        depends_on: ["user"],
        predicted: ["force-push-loss"],
        expect: "No force pushes",
      },
    });
    const other = caller("other-reader");
    read(sb.paths, other, ["P1"]);
    const revise = () =>
      write(sb.paths, other, {
        action: "attempt",
        input: {
          problem: "P1",
          action: "revise",
          supersedes: ["A1"],
          what: "Tighten build rule",
          why: "Still missed once",
          files: ["~/.claude/AGENTS.md"],
          anchor: "Always quote build errors.",
          depends_on: ["model"],
          predicted: ["unverified-done"],
          expect: "Build output quoted",
        },
      });
    const missingIndex = failure(revise);
    expect(missingIndex.code).toBe("seen_required");
    expect(missingIndex.problems.join("\n")).toMatch(/index.*by_file/);

    SimStore.runRead(
      {
        paths: sb.paths,
        loaded: SimStore.loadReadOnly(sb.paths),
        caller: other,
        settings: { advisorModelSelection: null },
        telemetry: [],
      },
      { action: "by_file", file: "~/.claude/AGENTS.md" },
    );
    expect(revise().attemptId).toBe("A3");
  });

  it("persists active providerThreadId across reloads and bumps the epoch when it switches", () => {
    using sb = sandbox();
    sb.harness("AGENTS.md", `- ${RULE}\n`);
    recordRule(sb.paths);
    const reader = caller("restart-reader", { alsoSessionId: "cc:old-native" });
    readIndex(sb.paths, reader);
    read(sb.paths, reader, ["P1"]);

    expect(
      SimStore.trackProviderThread(sb.paths, "restart-reader", "pt-1", ["cc:old-native"]),
    ).toBe(false);
    expect(SimStore.getThreadSeenEpoch(sb.paths, "restart-reader")).toBe(0);
    // Same provider thread after a simulated restart does not reset.
    expect(
      SimStore.trackProviderThread(sb.paths, "restart-reader", "pt-1", ["cc:old-native"]),
    ).toBe(false);
    expect(SimStore.getThreadSeenEpoch(sb.paths, "restart-reader")).toBe(0);

    // Switching provider thread after a restart resets the epoch and clears prior readings.
    expect(SimStore.trackProviderThread(sb.paths, "restart-reader", "pt-2", [])).toBe(true);
    expect(SimStore.getThreadSeenEpoch(sb.paths, "restart-reader")).toBe(1);
    const scope = SimStore.seenScope(sb.paths, reader);
    expect(SimStore.shownTo(sb.paths, SimStore.loadReadOnly(sb.paths).state, scope).size).toBe(0);
  });
});

describe("SimStore review and escalation", () => {
  const advisor = {
    advisorModelSelection: {
      instanceId: ProviderInstanceId.make("claudeAgent"),
      model: "claude-fable-5-2",
    },
  };

  it("reviews live rules under the newest carried model and harness, failures first", () => {
    using sb = sandbox();
    sb.harness("AGENTS.md", `- ${RULE}\n- Always quote the failing build output.\n`);
    recordRule(sb.paths);
    SimStore.runRead(
      {
        paths: sb.paths,
        loaded: SimStore.load(sb.paths),
        caller: author,
        settings: advisor,
        telemetry: [],
      },
      { action: "show", ids: ["P1"] },
    );
    write(sb.paths, author, {
      action: "attempt",
      input: {
        problem: "P1",
        action: "add",
        what: "Rule to quote the failing build output",
        why: "Paraphrased errors hid the real cause",
        files: ["~/.claude/AGENTS.md"],
        anchor: "quote the failing build output",
        depends_on: ["user"],
        predicted: ["paraphrased-build-errors"],
        expect: "Build errors appear verbatim",
      },
    });
    write(sb.paths, author, {
      action: "carry",
      fromPolicy: "gpt-5",
      toPolicy: "gpt-6",
      fromHarness: "codex",
      toHarness: "codex",
    });
    write(sb.paths, caller("tester", { model: "gpt-6" }), {
      action: "observe",
      input: {
        attempt: "A2",
        target: "paraphrased-build-errors",
        result: "missed",
        evidence: "gpt-6 paraphrased the error again",
        source: "user",
      },
    });
    const review = SimStore.renderReview(SimStore.load(sb.paths).state, {});
    const rows = review.split("\n").filter((line) => /^A\d/.test(line));
    expect(review).toMatch(/under gpt-6 on codex: 2 \(1 with a failure/);
    expect(rows.map((row) => row.split(" ")[0])).toEqual(["A2", "A1"]);
  });

  it("escalates recurring failures, cross-harness conflicts, unseen models and repeated drift only when an advisor is set", () => {
    using sb = sandbox();
    sb.harness("AGENTS.md", `- ${RULE}\n- Always quote the failing build output.\n`);
    recordRule(sb.paths);
    observe(sb.paths, reviewer);
    observe(sb.paths, caller("codex-user"), {
      result: "missed",
      evidence: "codex claimed done on a red build again",
    });
    const { state } = SimStore.load(sb.paths);
    const telemetry = [
      {
        ts: "2026-11-10T00:00:00Z",
        kind: "new_model_observed" as const,
        providerInstanceId: "antigravity",
        model: "gemini-4",
      },
      {
        ts: "2026-11-10T00:00:00Z",
        kind: "new_model_observed" as const,
        providerInstanceId: "codex",
        model: "gpt-5",
      },
      {
        ts: "2026-11-10T00:00:00Z",
        kind: "unrecorded_harness_edit" as const,
        threadId: "t",
        files: ["~/.claude/AGENTS.md"],
      },
    ];
    const health = { drift: [{ attempt: state.problems[0]!.attempts[0]!, reason: "gone" }] };
    const escalation = SimStore.buildAdvisorEscalation(state, advisor, health, telemetry);
    expect(escalation?.candidates.map((candidate) => candidate.kind)).toEqual([
      "cross_harness_conflict",
      "new_model_generation",
      "repeated_drift",
    ]);
    expect(escalation?.guidance).toMatch(
      /delegate_task with role "design" and target \{"providerInstanceId":"claudeAgent","model":"claude-fable-5-2"\}/,
    );
    expect(escalation?.guidance).not.toContain("modelSelection");
    expect(
      SimStore.buildAdvisorEscalation(state, { advisorModelSelection: null }, health, telemetry),
    ).toBeUndefined();
    expect(
      SimStore.buildAdvisorEscalation(state, advisor, { drift: [] }, [])?.candidates.map(
        (c) => c.kind,
      ),
    ).toEqual(["cross_harness_conflict"]);

    // index and check never attach advisorEscalation; review does.
    const readCtx = {
      paths: sb.paths,
      loaded: SimStore.loadReadOnly(sb.paths),
      caller: reviewer,
      settings: advisor,
      telemetry,
    };
    expect(SimStore.runRead(readCtx, { action: "index" }).advisorEscalation).toBeUndefined();
    expect(SimStore.runRead(readCtx, { action: "check" }).advisorEscalation).toBeUndefined();
    expect(
      SimStore.runRead(readCtx, { action: "review", policy: "gpt-5" }).advisorEscalation?.candidates
        .length,
    ).toBeGreaterThan(0);

    // Once a superseding live attempt fixes the problem with no failures, recurring_failures stays quiet.
    readIndex(sb.paths, author);
    SimStore.runRead({ ...readCtx, caller: author }, { action: "show", ids: ["P1"] });
    write(sb.paths, author, {
      action: "attempt",
      input: {
        problem: "P1",
        action: "revise",
        supersedes: ["A1"],
        what: "Tighten build verification rule",
        why: "A1 missed under codex",
        files: ["~/.claude/AGENTS.md"],
        anchor: "Always quote the failing build output.",
        depends_on: ["user"],
        predicted: ["unverified-done"],
        expect: "Verified every run",
      },
    });
    observe(sb.paths, caller("codex-user"), {
      attempt: "A2",
      result: "missed",
      evidence: "A2 missed once too before A3",
    });
    expect(
      SimStore.buildAdvisorEscalation(
        SimStore.loadReadOnly(sb.paths).state,
        advisor,
        { drift: [] },
        [],
      )?.candidates.map((c) => c.kind),
    ).toContain("recurring_failures");
    sb.harness(
      "AGENTS.md",
      `- ${RULE}\n- Always quote the failing build output.\n- Paste build exit code.\n`,
    );
    readIndex(sb.paths, author);
    SimStore.runRead(
      { ...readCtx, loaded: SimStore.loadReadOnly(sb.paths), caller: author },
      { action: "show", ids: ["P1"] },
    );
    write(sb.paths, author, {
      action: "attempt",
      input: {
        problem: "P1",
        action: "revise",
        supersedes: ["A2"],
        what: "Require exit code",
        why: "A2 still missed",
        files: ["~/.claude/AGENTS.md"],
        anchor: "Paste build exit code.",
        depends_on: ["user"],
        predicted: ["unverified-done"],
        expect: "Exit code pasted",
      },
    });
    observe(sb.paths, reviewer, {
      attempt: "A3",
      result: "fixed",
      evidence: "A3 fixed the issue cleanly",
    });
    expect(
      SimStore.buildAdvisorEscalation(
        SimStore.loadReadOnly(sb.paths).state,
        advisor,
        { drift: [] },
        [],
      ),
    ).toBeUndefined();
  });
});

describe("SimStore telemetry", () => {
  it("trims the telemetry file to its newest lines once it grows past its cap", () => {
    using sb = sandbox();
    const event = (index: number) => ({
      ts: "2026-11-10T00:00:00Z",
      kind: "checkpoint_rollback" as const,
      threadId: `thread-${index}`,
      checkpointId: `checkpoint-${"x".repeat(200)}-${index}`,
    });
    for (let index = 0; index < 2_100; index += 1) SimStore.appendTelemetry(sb.paths, event(index));
    const kept = SimStore.readTelemetry(sb.paths);
    expect(kept.length).toBeLessThanOrEqual(2_000);
    expect(kept[kept.length - 1]).toEqual(event(2_099));
    expect(SimStore.readTelemetry(sb.paths, Date.parse("2026-11-11T00:00:00Z"))).toEqual([]);
  });

  it("renders compact brief with folded test counts and metrics/roi views", () => {
    using sb = sandbox();
    NodeFS.writeFileSync(
      NodePath.join(sb.paths.harnessDir, "AGENTS.md"),
      "- Require end-to-end command proof before reporting done.\n",
      "utf8",
    );
    const author = { sessionId: "t3:author-brief", model: "claude-opus-5-5" };
    const grader = { sessionId: "t3:grader-brief", model: "claude-opus-5-5" };
    SimStore.runRead(
      {
        paths: sb.paths,
        loaded: SimStore.loadReadOnly(sb.paths),
        caller: author,
        settings: { advisorModelSelection: null },
        telemetry: [],
      },
      { action: "index" },
    );
    SimStore.runRead(
      {
        paths: sb.paths,
        loaded: SimStore.loadReadOnly(sb.paths),
        caller: author,
        settings: { advisorModelSelection: null },
        telemetry: [],
      },
      { action: "brief_all" },
    );
    SimStore.runWrite(sb.paths, author, {
      action: "attempt",
      input: {
        new: "Repeated unverified claims",
        action: "add",
        what: "Require end-to-end command proof before reporting done",
        why: "Agents called tasks done after edits alone",
        files: ["~/.claude/AGENTS.md"],
        anchor: "Require end-to-end command proof",
        depends_on: ["model"],
        predicted: ["unverified-done"],
        expect: "Command output included",
      },
    });
    for (let i = 0; i < 4; i += 1) {
      SimStore.runWrite(sb.paths, grader, {
        action: "observe",
        input: {
          attempt: "A1",
          target: "unverified-done",
          result: "fixed",
          evidence: `Synthetic harness test pass ${i}`,
          source: "test",
        },
      });
    }
    const brief = SimStore.runRead(
      {
        paths: sb.paths,
        loaded: SimStore.loadReadOnly(sb.paths),
        caller: grader,
        settings: { advisorModelSelection: null },
        telemetry: [],
      },
      { action: "brief", maxTokens: 500 },
    );
    expect(brief.text).toContain("tests(fixed:4)");
    expect(brief.text).toContain("P1: Repeated unverified claims");

    const roi = SimStore.runRead(
      {
        paths: sb.paths,
        loaded: SimStore.loadReadOnly(sb.paths),
        caller: grader,
        settings: { advisorModelSelection: null },
        telemetry: [],
        metrics: [
          {
            ts: "2026-11-19T10:00:00.000Z",
            kind: "injection",
            ruleKey: "verified-commit-trailer",
            problemId: "P44",
            delivery: "base",
            bytes: 120_000,
            estimatedTokens: 30_000,
            providerInstanceId: "claudeAgent",
            model: "claude-opus-5-5",
          },
        ],
      },
      { action: "roi" },
    );
    expect(roi.text).toContain("demote_to_jit");
    expect(roi.text).toContain("verified-commit-trailer");
  });
});
