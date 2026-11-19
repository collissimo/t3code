// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it } from "@effect/vitest";
import { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as SimAuditServiceLive from "./SimAuditService.ts";
import { SimAuditService, SimService, resolveSimPaths } from "./SimContracts.ts";
import * as SimServiceLive from "./SimService.ts";
import * as SimStore from "./SimStore.ts";

const RULE = "Always run the build before you claim done.";
const at = (day: number, minute = 0) =>
  `2026-11-${String(day).padStart(2, "0")}T10:${String(minute).padStart(2, "0")}:00.000Z`;

function sandbox() {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-sim-test-"));
  const harnessDir = NodePath.join(root, "claude");
  NodeFS.mkdirSync(NodePath.join(harnessDir, "notes"), { recursive: true });
  NodeFS.writeFileSync(NodePath.join(harnessDir, "AGENTS.md"), `# Rules\n- ${RULE}\n`);
  const layer = SimAuditServiceLive.layer.pipe(
    Layer.provideMerge(SimServiceLive.layer),
    Layer.provideMerge(ServerSettings.layerTest({ sim: { harnessDir } })),
    Layer.provideMerge(SqlitePersistence.layerMemory),
  );
  return {
    root,
    harnessDir,
    paths: resolveSimPaths({ harnessDir }),
    layer,
    [Symbol.dispose]: () => NodeFS.rmSync(root, { recursive: true, force: true }),
  };
}

interface SeedThread {
  readonly id: string;
  readonly title: string;
  readonly provider: string;
  readonly parent?: string;
  readonly relationship?: "subagent" | "fork";
  readonly sideChat?: boolean;
  readonly runs: ReadonlyArray<{
    readonly model: string;
    readonly provider?: string;
    readonly status?: string;
    readonly user?: string;
  }>;
  readonly assistant?: string;
}

const seedThread = Effect.fn("test.seedThread")(function* (thread: SeedThread, day: number) {
  const sql = yield* SqlClient.SqlClient;
  const payload = {
    id: thread.id,
    title: thread.title,
    providerInstanceId: thread.provider,
    modelSelection: { instanceId: thread.provider, model: thread.runs[0]?.model ?? "unknown" },
    worktreePath: "/work/repo",
    ...(thread.parent
      ? {
          lineage: {
            parentThreadId: thread.parent,
            relationshipToParent: thread.relationship ?? "subagent",
            ...(thread.sideChat ? { sideChat: true } : {}),
          },
        }
      : {}),
  };
  yield* sql`
    INSERT INTO orchestration_v2_projection_threads
      (thread_id, project_id, title, default_provider, runtime_mode, interaction_mode, created_at, updated_at, payload_json)
    VALUES (${thread.id}, 'project-1', ${thread.title}, ${thread.provider}, 'full-access', 'default', ${at(day)}, ${at(day, 30)}, ${JSON.stringify(payload)})`;
  for (const [index, run] of thread.runs.entries()) {
    const ordinal = index + 1;
    const runId = `${thread.id}:run:${ordinal}`;
    const provider = run.provider ?? thread.provider;
    const messageId = `${runId}:user`;
    yield* sql`
      INSERT INTO orchestration_v2_projection_runs
        (run_id, thread_id, ordinal, provider, status, requested_at, payload_json)
      VALUES (${runId}, ${thread.id}, ${ordinal}, ${provider}, ${run.status ?? "completed"}, ${at(day, ordinal)},
        ${JSON.stringify({ providerInstanceId: provider, modelSelection: { instanceId: provider, model: run.model }, userMessageId: messageId })})`;
    if (run.user) {
      yield* sql`
        INSERT INTO orchestration_v2_projection_messages
          (message_id, thread_id, run_id, role, streaming, created_at, updated_at, payload_json)
        VALUES (${messageId}, ${thread.id}, ${runId}, 'user', 0, ${at(day, ordinal)}, ${at(day, ordinal)},
          ${JSON.stringify({ text: `<t3_code_instructions>be terse, wrong instead</t3_code_instructions>${run.user}` })})`;
    }
  }
  if (thread.assistant) {
    yield* sql`
      INSERT INTO orchestration_v2_projection_messages
        (message_id, thread_id, run_id, role, streaming, created_at, updated_at, payload_json)
      VALUES (${`${thread.id}:assistant`}, ${thread.id}, NULL, 'assistant', 0, ${at(day, 20)}, ${at(day, 20)},
        ${JSON.stringify({ text: thread.assistant })})`;
  }
});

const seedItem = Effect.fn("test.seedItem")(function* (
  threadId: string,
  type: string,
  payload: object,
  day: number,
) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    INSERT INTO orchestration_v2_projection_turn_items
      (turn_item_id, thread_id, run_id, ordinal, type, status, updated_at, payload_json)
    VALUES (${`${threadId}:${type}:${JSON.stringify(payload).length}`}, ${threadId}, ${`${threadId}:run:1`}, 1, ${type}, 'completed', ${at(day, 5)}, ${JSON.stringify({ type, ...payload })})`;
});

const seedEvent = Effect.fn("test.seedEvent")(function* (
  threadId: string,
  type: string,
  payload: object,
  day: number,
) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    INSERT INTO orchestration_v2_events (event_id, thread_id, event_type, occurred_at, payload_json)
    VALUES (${`${threadId}:${type}`}, ${threadId}, ${type}, ${at(day, 10)}, ${JSON.stringify(payload)})`;
});

const auditor = { sessionId: "t3:auditor", threadId: ThreadId.make("auditor") };

const seedWorld = (harnessDir: string) =>
  Effect.gen(function* () {
    const sim = yield* SimService;
    // SIM already knows claude-opus-5-5 and has thread-recorded edited a note.
    NodeFS.writeFileSync(
      NodePath.join(harnessDir, "notes", "build-notes.md"),
      "## Build\nRun the build first.\n",
    );
    const recorder = {
      sessionId: "t3:thread-recorded",
      threadId: ThreadId.make("thread-recorded"),
      model: "claude-opus-5-5",
      driver: "claudeAgent",
      workspaceRoot: "/work/repo",
    };
    yield* sim.read(recorder, { action: "index" });
    yield* sim.applyHarnessChange(recorder, {
      file: "~/.claude/AGENTS.md",
      oldText: `- ${RULE}\n`,
      newText: `- ${RULE}\n- Always quote the failing build output.\n`,
      attempt: {
        new: "Agents paraphrase failing build output instead of quoting it",
        action: "add",
        what: "Quote rule",
        why: "Paraphrased errors hid causes",
        anchor: "quote the failing build output",
        depends_on: ["model"],
        predicted: ["paraphrased-build-errors"],
        expect: "Errors appear verbatim",
      },
    });
    yield* seedThread(
      {
        id: "thread-claude",
        title: "Fix the login form",
        provider: "claudeAgent",
        runs: [
          { model: "claude-opus-5-5", user: "Fix the login form" },
          {
            model: "gpt-5",
            provider: "codex",
            user: "Nein, das ist falsch, ich meinte das Passwortfeld",
          },
        ],
      },
      10,
    );
    yield* seedItem(
      "thread-claude",
      "file_change",
      { fileName: NodePath.join(harnessDir, "AGENTS.md") },
      10,
    );
    yield* seedThread(
      {
        id: "thread-codex",
        title: "Refactor parser",
        provider: "codex",
        runs: [
          { model: "gpt-5", status: "interrupted", user: "Refactor the parser" },
          { model: "gpt-5", user: "Stop, keep the old API instead" },
        ],
      },
      11,
    );
    yield* seedEvent(
      "thread-codex",
      "checkpoint.rollback-requested",
      { checkpointId: "checkpoint-7" },
      11,
    );
    yield* seedThread(
      {
        id: "thread:delegated-task:review-1",
        title: "Review the parser refactor",
        provider: "antigravity",
        parent: "thread-codex",
        runs: [{ model: "gemini-4-ultra", user: "Review the diff for bugs" }],
        assistant: "Found 2 issues: the old API lost its default export.",
      },
      12,
    );
    yield* seedThread(
      {
        id: "thread-recorded",
        title: "Notes",
        provider: "claudeAgent",
        runs: [{ model: "claude-opus-5-5", user: "Tidy notes" }],
      },
      12,
    );
    yield* seedItem(
      "thread-recorded",
      "command_execution",
      { input: `echo hi >> ${NodePath.join(harnessDir, "notes", "build-notes.md")}` },
      12,
    );
    yield* seedThread(
      {
        id: "thread-self",
        title: "[SIM-AUDIT] weekly",
        provider: "claudeAgent",
        runs: [{ model: "claude-opus-5-5", user: "nein, wrong" }],
      },
      12,
    );
    yield* seedThread(
      {
        id: "auditor",
        title: "Audit",
        provider: "claudeAgent",
        runs: [
          { model: "claude-opus-5-5", user: "a" },
          { model: "claude-opus-5-5", user: "nein, falsch" },
        ],
      },
      12,
    );
    yield* sim.recordTelemetry({
      ts: at(13),
      kind: "new_model_observed",
      providerInstanceId: "kimi",
      model: "kimi-k3",
    });
    yield* sim.recordTelemetry({
      ts: at(13),
      kind: "checkpoint_rollback",
      threadId: "thread-other",
      checkpointId: "c-1",
    });
  });

describe("SimAuditService", () => {
  it.effect(
    "aggregates corrections, harness edits and runtime signals across every provider",
    () => {
      const sb = sandbox();
      return Effect.gen(function* () {
        yield* seedWorld(sb.harnessDir);
        const projects = NodePath.join(sb.harnessDir, "projects");
        NodeFS.mkdirSync(NodePath.join(projects, "-work-repo"), { recursive: true });
        NodeFS.mkdirSync(NodePath.join(projects, "-tmp-sandbox"), { recursive: true });
        const transcript = [
          {
            type: "user",
            timestamp: at(14),
            cwd: "/work/repo",
            message: { content: "Add caching" },
          },
          {
            type: "assistant",
            timestamp: at(14, 1),
            message: {
              model: "claude-opus-5-5",
              content: [
                {
                  type: "tool_use",
                  name: "Edit",
                  input: { file_path: NodePath.join(sb.harnessDir, "AGENTS.md") },
                },
              ],
            },
          },
          {
            type: "user",
            timestamp: at(14, 2),
            message: { content: "why did you change AGENTS.md? that's not what I asked" },
          },
        ];
        NodeFS.writeFileSync(
          NodePath.join(projects, "-work-repo", "session-1.jsonl"),
          transcript.map((row) => JSON.stringify(row)).join("\n"),
        );
        NodeFS.writeFileSync(
          NodePath.join(projects, "-tmp-sandbox", "session-2.jsonl"),
          transcript.map((row) => JSON.stringify(row)).join("\n"),
        );

        const audit = yield* SimAuditService;
        const report = yield* audit.audit(auditor, { since: "2026-11-01" });

        expect(report.threadsScanned).toBe(4);
        expect(report.claudeSessionsScanned).toBe(1);
        expect(report.signals).toMatchObject({
          verbalCorrections: 3,
          checkpointRollbacks: 2,
          midThreadModelSwitches: 1,
          interruptedWithSteer: 1,
          delegatedReviews: 1,
          unrecordedHarnessEdits: 2,
        });
        expect(report.signals.newlyObservedModels.map((item) => item.model).sort()).toEqual([
          "gemini-4-ultra",
          "gpt-5",
          "kimi-k3",
        ]);
        expect(report.sim).toMatchObject({ journalBroken: null, liveRules: 1, openPredictions: 1 });
        expect(report.text).toContain(
          "SWITCH thread-claude: claudeAgent/claude-opus-5-5 -> codex/gpt-5",
        );
        expect(report.text).toMatch(/INTERRUPTED .*then: "Stop, keep the old API instead"/);
        expect(report.text).toMatch(
          /REVIEW thread:delegated-task:review-1 \[antigravity\/gemini-4-ultra\].*default export/,
        );
        expect(report.text).toMatch(
          /t3 thread-recorded .* recorded: ~\/\.claude\/notes\/build-notes\.md/,
        );
        expect(report.text).toMatch(/t3 thread-claude .* UNRECORDED\?: ~\/\.claude\/AGENTS\.md/);
        expect(report.text).toContain(
          'U2 (followup-correction): "Nein, das ist falsch, ich meinte das Passwortfeld"',
        );
        expect(report.text).not.toContain("thread-self");
        expect(report.text).not.toContain("session-2");
        expect(report.advisorEscalation?.candidates.map((candidate) => candidate.kind)).toContain(
          "new_model_generation",
        );
      }).pipe(Effect.provide(sb.layer), Effect.ensuring(Effect.sync(() => sb[Symbol.dispose]())));
    },
  );

  it.effect("inspects one thread turn by turn and keeps a watermark for the next audit", () => {
    const sb = sandbox();
    return Effect.gen(function* () {
      yield* seedWorld(sb.harnessDir);
      const audit = yield* SimAuditService;
      const inspection = yield* audit.inspectThread(auditor, "thread-co");
      expect(inspection.threadId).toBe("thread-codex");
      expect(inspection.text.split("\n")).toEqual([
        "Thread thread-codex | Refactor parser | models: codex/gpt-5 | runs: 2 | user turns: 2 | has interrupted runs",
        "run 1 [codex/gpt-5] interrupted",
        "U1 [2026-11-11 10:01:00]: Refactor the parser",
        "run 2 [codex/gpt-5] completed",
        "U2 [2026-11-11 10:02:00]: Stop, keep the old API instead",
        "ROLLBACK requested to checkpoint-7",
      ]);
      expect((yield* Effect.flip(audit.inspectThread(auditor, "thread-"))).code).toBe("validation");
      expect((yield* Effect.flip(audit.inspectThread(auditor, "nope"))).code).toBe("not_found");

      const done = yield* audit.markAuditDone(auditor);
      expect(JSON.parse(NodeFS.readFileSync(done.statePath, "utf8"))).toEqual({
        last_audit_at: done.lastAuditAt,
        by: "t3:auditor",
      });
      const next = yield* audit.audit(auditor, { includeClaudeLogs: false });
      expect(next.window.source).toBe(`watermark (${done.lastAuditAt})`);
      expect(SimStore.isTestSimDir(sb.paths)).toBe(true);
    }).pipe(Effect.provide(sb.layer), Effect.ensuring(Effect.sync(() => sb[Symbol.dispose]())));
  });

  it.effect(
    "flags standing fixed observations from a fork thread recorded via CLI, while allowing delegated children",
    () => {
      const sb = sandbox();
      return Effect.gen(function* () {
        yield* seedWorld(sb.harnessDir);
        // Simulate a fork thread and an independent delegated child in SQLite.
        yield* seedThread(
          {
            id: "thread-fork",
            title: "Fork of recorded",
            provider: "codex",
            parent: "thread-recorded",
            relationship: "fork",
            runs: [{ model: "gpt-5", user: "Check build output" }],
          },
          13,
        );
        yield* seedThread(
          {
            id: "thread-delegate-grader",
            title: "Independent grader",
            provider: "codex",
            parent: "thread-recorded",
            relationship: "subagent",
            runs: [{ model: "gpt-5", user: "Verify build quoting" }],
          },
          13,
        );
        // Write observations directly through SimStore without MCP forkFamilySessionIds (like CLI sim.mjs).
        const sim = yield* SimService;
        yield* sim.write(
          { sessionId: "t3:thread-fork", model: "gpt-5", driver: "codex" },
          {
            action: "observe",
            input: {
              attempt: "A1",
              target: "paraphrased-build-errors",
              result: "fixed",
              evidence: "Fork ran CLI sim.mjs observe fixed directly",
              source: "test",
            },
          },
        );
        yield* sim.write(
          { sessionId: "t3:thread-delegate-grader", model: "gpt-5", driver: "codex" },
          {
            action: "observe",
            input: {
              attempt: "A1",
              target: "paraphrased-build-errors",
              result: "fixed",
              evidence: "Delegated grader independently verified verbatim build output",
              source: "test",
            },
          },
        );

        const audit = yield* SimAuditService;
        const report = yield* audit.audit(auditor, {
          since: "2026-11-01",
          includeClaudeLogs: false,
        });
        expect(report.text).toContain(
          "FORK SELF-GRADE A1 (P1) outcome 1: fixed by t3:thread-fork (same fork/side-chat family as t3:thread-recorded",
        );
        expect(report.text).not.toContain("t3:thread-delegate-grader");
      }).pipe(Effect.provide(sb.layer), Effect.ensuring(Effect.sync(() => sb[Symbol.dispose]())));
    },
  );

  it.effect("refuses audit, inspectThread, and markAuditDone while sim.enabled is off", () => {
    const sb = sandbox();
    return Effect.gen(function* () {
      yield* seedWorld(sb.harnessDir);
      const settings = yield* ServerSettings.ServerSettingsService;
      const audit = yield* SimAuditService;

      yield* settings.updateSettings({ sim: { enabled: false } });
      expect((yield* Effect.flip(audit.audit(auditor, { includeClaudeLogs: false }))).code).toBe(
        "disabled",
      );
      expect((yield* Effect.flip(audit.inspectThread(auditor, "thread-co"))).code).toBe("disabled");
      expect((yield* Effect.flip(audit.markAuditDone(auditor))).code).toBe("disabled");

      yield* settings.updateSettings({ sim: { enabled: true } });
      const inspection = yield* audit.inspectThread(auditor, "thread-co");
      expect(inspection.threadId).toBe("thread-codex");
    }).pipe(Effect.provide(sb.layer), Effect.ensuring(Effect.sync(() => sb[Symbol.dispose]())));
  });
});
