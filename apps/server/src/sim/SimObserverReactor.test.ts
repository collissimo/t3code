// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import {
  ProjectId,
  RunId,
  ThreadId,
  type OrchestrationProjectShell,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2Run,
  type OrchestrationV2RunStatus,
} from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import { ProjectStoreV2 } from "../orchestration-v2/ProjectStore.ts";
import { USER_STOP_REASON } from "../orchestration-v2/RunExecutionService.ts";
import * as ServerSettings from "../serverSettings.ts";
import {
  type SimState,
  SimService,
  type SimTelemetryEvent,
  canonicalHarnessFile,
  resolveSimPaths,
} from "./SimContracts.ts";
import * as SimObserverReactor from "./SimObserverReactor.ts";

const THREAD_ID = ThreadId.make("thread-sim");
const RUN_ID = RunId.make("run-1");
const OCCURRED_AT = "2026-11-19T12:00:00.000Z";
const ROOT = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "sim-observer-"));
const HARNESS_DIR = NodePath.join(ROOT, "harness");
const SIM_DIR = NodePath.join(HARNESS_DIR, "sim");
const KNOWN_MODEL = "codex:gpt-5";

const localDay = (iso: string) =>
  DateTime.formatIsoDate(DateTime.setZone(DateTime.makeUnsafe(iso), DateTime.zoneMakeLocal()));

type Call =
  | { readonly kind: "reset"; readonly threadId: string; readonly sessions: ReadonlyArray<string> }
  | {
      readonly kind: "track";
      readonly threadId: string;
      readonly providerThreadId: string;
      readonly sessions: ReadonlyArray<string>;
    }
  | {
      readonly kind: "hasRecent";
      readonly file: string;
      readonly workspaceRoot: string | undefined;
    }
  | { readonly kind: "telemetry"; readonly event: SimTelemetryEvent }
  | { readonly kind: "read" };

interface SetupOptions {
  readonly enabled?: boolean;
  readonly runs?: ReadonlyArray<OrchestrationV2Run>;
  readonly activeProviderThreadId?: string;
  readonly worktreePath?: string | null;
  readonly projectWorkspaceRoot?: string;
  readonly hasRecentAttempt?: boolean;
  readonly state?: Partial<SimState>;
}

const setup = Effect.fnUntraced(function* (options: SetupOptions = {}) {
  const calls: Array<Call> = [];
  const projection = { activeProviderThreadId: options.activeProviderThreadId ?? null };
  const read = <A>(value: A) => Effect.sync(() => (calls.push({ kind: "read" }), value));
  const dependencies = Layer.mergeAll(
    Layer.mock(Orchestrator.OrchestratorV2)({}),
    Layer.mock(ProjectionStore.ProjectionStoreV2)({
      findThread: () =>
        read({
          id: THREAD_ID,
          projectId: ProjectId.make("project-sim"),
          worktreePath: options.worktreePath ?? null,
          activeProviderThreadId: projection.activeProviderThreadId,
        } as never),
      getThreadRecords: () =>
        read({ thread: { id: THREAD_ID }, runs: options.runs ?? [] } as never),
    }),
    ...(options.projectWorkspaceRoot === undefined
      ? []
      : [
          Layer.mock(ProjectStoreV2)({
            getShell: () =>
              Effect.succeedSome({
                title: "Sim Repo",
                workspaceRoot: options.projectWorkspaceRoot!,
              } as OrchestrationProjectShell),
          }),
        ]),
    Layer.mock(SimService)({
      resetThreadSeenEpoch: (threadId, sessions) =>
        Effect.sync(() => {
          calls.push({ kind: "reset", threadId, sessions: sessions ?? [] });
          return calls.length;
        }),
      trackProviderThread: ({ threadId, providerThreadId, extraSessionIds }) =>
        Effect.sync(() => {
          calls.push({
            kind: "track",
            threadId,
            providerThreadId,
            sessions: extraSessionIds ?? [],
          });
          return true;
        }),
      recordTelemetry: (event) => Effect.sync(() => void calls.push({ kind: "telemetry", event })),
      hasRecentAttemptForFile: ({ file, workspaceRoot }) =>
        Effect.sync(() => {
          calls.push({ kind: "hasRecent", file, workspaceRoot });
          return options.hasRecentAttempt ?? false;
        }),
      getStateSnapshot: () =>
        read(
          options.state
            ? ({ state: { problems: [], ...options.state }, broken: null } as never)
            : null,
        ),
      getObservedModels: () => read(new Set([KNOWN_MODEL])),
    }),
    ServerSettings.layerTest({
      sim: { enabled: options.enabled ?? true, simDir: SIM_DIR, harnessDir: HARNESS_DIR },
    }),
  );
  const reactor = yield* SimObserverReactor.SimObserverReactor.pipe(
    Effect.provide(SimObserverReactor.layer.pipe(Layer.provide(dependencies))),
  );
  const telemetry = () => calls.flatMap((call) => (call.kind === "telemetry" ? [call.event] : []));
  const resets = () => calls.filter((call) => call.kind === "reset");
  const tracks = () => calls.filter((call) => call.kind === "track");
  return { reactor, calls, telemetry, resets, tracks, projection };
});

const event = (type: string, payload: object, extra: object = {}) =>
  ({
    id: `event-${type}`,
    type,
    threadId: THREAD_ID,
    occurredAt: DateTime.makeUnsafe(OCCURRED_AT),
    payload,
    ...extra,
  }) as unknown as OrchestrationV2DomainEvent;

const turnItem = (id: string, fields: object) =>
  event(
    "turn-item.updated",
    { id, threadId: THREAD_ID, runId: RUN_ID, status: "completed", ...fields },
    { runId: RUN_ID },
  );

const fileChange = (id: string, fileName: string) =>
  turnItem(id, { type: "file_change", fileName });
const command = (id: string, input: string) => turnItem(id, { type: "command_execution", input });

function makeRun(
  id: string,
  status: OrchestrationV2RunStatus,
  options: {
    readonly ordinal?: number;
    readonly instanceId?: string;
    readonly model?: string;
  } = {},
) {
  return {
    id: RunId.make(id),
    threadId: THREAD_ID,
    ordinal: options.ordinal ?? 1,
    providerInstanceId: options.instanceId ?? "codex",
    modelSelection: { instanceId: options.instanceId ?? "codex", model: options.model ?? "gpt-5" },
    requestedAt: DateTime.makeUnsafe(OCCURRED_AT),
    status,
  } as unknown as OrchestrationV2Run;
}

const runEvent = (type: "run.created" | "run.updated", run: OrchestrationV2Run) =>
  event(type, run, { runId: run.id });

const selectionEvent = (instanceId: string, model: string) =>
  event("thread.model-selection-updated", {
    id: THREAD_ID,
    providerInstanceId: instanceId,
    modelSelection: { instanceId, model },
  });

const providerThread = (id: string, nativeId: string) =>
  event("provider-thread.updated", {
    id,
    driver: "claudeAgent",
    appThreadId: THREAD_ID,
    nativeThreadRef: { driver: "claudeAgent", nativeId, strength: "strong" },
    status: "active",
  });

describe("SimObserverReactor", () => {
  it.effect(
    "resets the seen epoch once per completed compaction, handoff, and context switch",
    () =>
      Effect.gen(function* () {
        const { reactor, resets } = yield* setup({ activeProviderThreadId: "pt-2" });
        const compaction = turnItem("item-compact", { type: "compaction", driver: "codex" });
        const handoff = event("context-handoff.updated", { id: "handoff-1", status: "ready" });
        for (const repeated of [compaction, compaction, handoff, handoff]) {
          yield* reactor.handle(repeated);
        }
        assert.strictEqual(resets().length, 2);

        const switching = yield* setup({ activeProviderThreadId: "pt-1" });
        yield* switching.reactor.handle(providerThread("pt-1", "native-a"));
        assert.deepStrictEqual(switching.tracks(), [
          {
            kind: "track",
            threadId: THREAD_ID,
            providerThreadId: "pt-1",
            sessions: ["cc:native-a"],
          },
        ]);
        // A native subagent's provider thread is not the thread's context.
        yield* switching.reactor.handle(providerThread("pt-sub", "native-sub"));
        assert.strictEqual(switching.tracks().length, 1);
      }),
  );

  it.effect("tracks active provider thread changes with both Claude sessions (restart-safe)", () =>
    Effect.gen(function* () {
      const { reactor, tracks, projection } = yield* setup({ activeProviderThreadId: "pt-1" });
      yield* reactor.handle(providerThread("pt-1", "native-a"));
      projection.activeProviderThreadId = "pt-2";
      yield* reactor.handle(providerThread("pt-2", "native-b"));
      yield* reactor.handle(providerThread("pt-2", "native-b"));
      assert.deepStrictEqual(tracks(), [
        {
          kind: "track",
          threadId: THREAD_ID,
          providerThreadId: "pt-1",
          sessions: ["cc:native-a"],
        },
        {
          kind: "track",
          threadId: THREAD_ID,
          providerThreadId: "pt-2",
          sessions: ["cc:native-a", "cc:native-b"],
        },
      ]);
    }),
  );

  it.effect(
    "resolves relative workspace harness edits against project workspaceRoot when no worktree is set",
    () =>
      Effect.gen(function* () {
        const workspace = NodePath.join(ROOT, "project-repo");
        const { reactor, calls, telemetry } = yield* setup({
          worktreePath: null,
          projectWorkspaceRoot: workspace,
        });
        yield* reactor.handle(command("item-rel", "sed -i 's/old/new/' AGENTS.md"));
        yield* reactor.handle(runEvent("run.updated", makeRun(RUN_ID, "completed")));
        const expectedFile = canonicalHarnessFile(
          NodePath.join(workspace, "AGENTS.md"),
          resolveSimPaths({ simDir: SIM_DIR, harnessDir: HARNESS_DIR }),
        );
        assert.deepStrictEqual(
          calls.filter((call) => call.kind === "hasRecent"),
          [{ kind: "hasRecent", file: expectedFile, workspaceRoot: workspace }],
        );
        assert.deepStrictEqual(telemetry(), [
          {
            ts: OCCURRED_AT,
            kind: "unrecorded_harness_edit",
            threadId: THREAD_ID,
            runId: RUN_ID,
            providerInstanceId: "codex",
            model: "gpt-5",
            files: [expectedFile],
          },
        ]);
      }),
  );

  it.effect.each([
    { name: "unrecorded edit is reported", options: {}, reported: true },
    {
      name: "suppressed by a recent attempt in the turn",
      options: { hasRecentAttempt: true },
      reported: false,
    },
    {
      name: "suppressed by a same-day attempt from this thread",
      options: {
        state: {
          problems: [
            {
              attempts: [
                {
                  by: `t3:${THREAD_ID}`,
                  round: localDay(OCCURRED_AT),
                  files: ["~/.claude/AGENTS.md"],
                },
              ],
            },
          ],
        } as never,
      },
      reported: false,
    },
  ])("harness file_change at run end: $name", ({ options, reported }) =>
    Effect.gen(function* () {
      const { reactor, telemetry } = yield* setup(options);
      yield* reactor.handle(fileChange("item-edit", NodePath.join(HARNESS_DIR, "AGENTS.md")));
      yield* reactor.handle(command("item-ws", "echo hi > ./notes.txt"));
      assert.deepStrictEqual(telemetry(), [], "nothing is reported before the run ends");
      yield* reactor.handle(runEvent("run.updated", makeRun(RUN_ID, "completed")));
      assert.deepStrictEqual(
        telemetry(),
        reported
          ? [
              {
                ts: OCCURRED_AT,
                kind: "unrecorded_harness_edit",
                threadId: THREAD_ID,
                runId: RUN_ID,
                providerInstanceId: "codex",
                model: "gpt-5",
                files: ["~/.claude/AGENTS.md"],
              },
            ]
          : [],
      );
    }),
  );

  it.effect(
    "reports direct SIM record edits immediately and ignores sim.mjs and heredoc bodies",
    () =>
      Effect.gen(function* () {
        const { reactor, telemetry } = yield* setup();
        const journal = NodePath.join(SIM_DIR, "sim.jsonl");
        yield* reactor.handle(command("item-sim", `node ${SIM_DIR}/sim.mjs attempt --what x`));
        yield* reactor.handle(
          command("item-heredoc", `cat > /dev/null <<'EOF'\necho x >> ${journal}\nEOF`),
        );
        assert.deepStrictEqual(telemetry(), []);

        yield* reactor.handle(fileChange("item-journal", journal));
        yield* reactor.handle(command("item-bash", `echo '{}' >> "${journal}" && ls`));
        yield* reactor.handle(command("item-bash", `echo '{}' >> "${journal}"`));
        assert.deepStrictEqual(
          telemetry().map((entry) => [entry.kind, "files" in entry ? entry.files : []]),
          [
            ["direct_sim_record_edit", ["~/.claude/sim/sim.jsonl"]],
            ["direct_sim_record_edit", ["~/.claude/sim/sim.jsonl"]],
          ],
        );
      }),
  );

  it.effect("reports checkpoint rollbacks", () =>
    Effect.gen(function* () {
      const { reactor, telemetry } = yield* setup();
      yield* reactor.handle(runEvent("run.created", makeRun(RUN_ID, "running")));
      yield* reactor.handle(
        event(
          "checkpoint.rollback-requested",
          { scopeId: "scope", checkpointId: "cp-1" },
          { runId: RUN_ID },
        ),
      );
      assert.deepStrictEqual(telemetry(), [
        {
          ts: OCCURRED_AT,
          kind: "checkpoint_rollback",
          threadId: THREAD_ID,
          runId: RUN_ID,
          checkpointId: "cp-1",
          providerInstanceId: "codex",
          model: "gpt-5",
        },
      ]);
    }),
  );

  it.effect.each([
    { name: "before the first turn", runs: [], switched: false },
    { name: "after a turn", runs: [makeRun(RUN_ID, "completed")], switched: true },
  ])("model selection change $name", ({ runs, switched }) =>
    Effect.gen(function* () {
      const { reactor, telemetry } = yield* setup({ runs });
      yield* reactor.handle(
        event("thread.created", {
          id: THREAD_ID,
          providerInstanceId: "codex",
          modelSelection: { instanceId: "codex", model: "gpt-5" },
        }),
      );
      yield* reactor.handle(selectionEvent("claudeAgent", "claude-opus-5-5"));
      yield* reactor.handle(selectionEvent("claudeAgent", "claude-opus-5-5"));
      assert.deepStrictEqual(
        telemetry(),
        switched
          ? [
              {
                ts: OCCURRED_AT,
                kind: "mid_thread_model_switch",
                threadId: THREAD_ID,
                fromProvider: "codex",
                fromModel: "gpt-5",
                toProvider: "claudeAgent",
                toModel: "claude-opus-5-5",
              },
            ]
          : [],
      );
    }),
  );

  it.effect.each([
    { name: "a person's stop", reason: USER_STOP_REASON, steered: true },
    { name: "an unknown stop", reason: undefined, steered: true },
    { name: "an agent's stop", reason: "Stopped by the orchestrator", steered: false },
  ])("interrupted run followed by a new run after $name", ({ reason, steered }) =>
    Effect.gen(function* () {
      const { reactor, telemetry } = yield* setup();
      if (reason !== undefined) {
        yield* reactor.handle(
          turnItem("item-stop", {
            type: "run_interrupt_request",
            message: reason,
            status: "running",
          }),
        );
      }
      yield* reactor.handle(runEvent("run.updated", makeRun(RUN_ID, "interrupted")));
      yield* reactor.handle(runEvent("run.created", makeRun("run-2", "queued", { ordinal: 2 })));
      yield* reactor.handle(runEvent("run.created", makeRun("run-3", "queued", { ordinal: 3 })));
      assert.deepStrictEqual(
        telemetry(),
        steered
          ? [
              {
                ts: OCCURRED_AT,
                kind: "interrupted_with_steer",
                threadId: THREAD_ID,
                interruptedRunId: RUN_ID,
                followupRunId: "run-2",
                providerInstanceId: "codex",
                model: "gpt-5",
                reason,
              },
            ]
          : [],
      );
    }),
  );

  it.effect("reports a newly observed model once", () =>
    Effect.gen(function* () {
      const { reactor, telemetry } = yield* setup();
      const newModel = { instanceId: "antigravity", model: "gemini-4-argon" };
      yield* reactor.handle(runEvent("run.updated", makeRun(RUN_ID, "running")));
      yield* reactor.handle(runEvent("run.updated", makeRun("run-2", "running", newModel)));
      yield* reactor.handle(runEvent("run.updated", makeRun("run-2", "completed", newModel)));
      assert.deepStrictEqual(telemetry(), [
        {
          ts: OCCURRED_AT,
          kind: "new_model_observed",
          threadId: THREAD_ID,
          providerInstanceId: "antigravity",
          model: "gemini-4-argon",
        },
      ]);
    }),
  );

  it.effect("reports completed review subagents with a bounded excerpt", () =>
    Effect.gen(function* () {
      const { reactor, telemetry } = yield* setup();
      const subagent = (id: string, title: string, result: string) =>
        event("subagent.updated", {
          id,
          status: "completed",
          title,
          prompt: "Look at the change.",
          result,
          childThreadId: "child-1",
          providerInstanceId: "claudeAgent",
          model: "claude-fable-5-2",
        });
      const verdict = `Verdict: ship it. ${"x".repeat(400)}`;
      yield* reactor.handle(subagent("task-impl", "Implement the parser", "Done."));
      yield* reactor.handle(subagent("task-review", "Check the parser diff", verdict));
      yield* reactor.handle(subagent("task-review", "Check the parser diff", verdict));
      const reports = telemetry();
      assert.strictEqual(reports.length, 1);
      const [review] = reports;
      assert.strictEqual(review?.kind, "delegated_review_completed");
      if (review?.kind !== "delegated_review_completed") return;
      assert.strictEqual(review.title, "Check the parser diff");
      assert.strictEqual(review.childThreadId, "child-1");
      assert.strictEqual(review.model, "claude-fable-5-2");
      assert.strictEqual(review.excerpt?.length, 300);
    }),
  );

  it.effect("does nothing while SIM is disabled", () =>
    Effect.gen(function* () {
      const { reactor, calls } = yield* setup({
        enabled: false,
        runs: [makeRun(RUN_ID, "completed")],
        activeProviderThreadId: "pt-1",
      });
      for (const disabled of [
        turnItem("item-compact", { type: "compaction", driver: "codex" }),
        event("context-handoff.updated", { id: "handoff-1", status: "ready" }),
        providerThread("pt-1", "native-a"),
        fileChange("item-journal", NodePath.join(SIM_DIR, "sim.jsonl")),
        fileChange("item-edit", NodePath.join(HARNESS_DIR, "AGENTS.md")),
        event("checkpoint.rollback-requested", { scopeId: "s", checkpointId: "cp" }),
        selectionEvent("claudeAgent", "claude-opus-5-5"),
        runEvent("run.updated", makeRun(RUN_ID, "interrupted", { model: "new-model" })),
        runEvent("run.created", makeRun("run-2", "queued", { ordinal: 2 })),
      ]) {
        yield* reactor.handle(disabled);
      }
      assert.deepStrictEqual(calls, []);
    }),
  );
});
