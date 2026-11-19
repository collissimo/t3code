import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  type OrchestrationProjectShell,
  type OrchestrationV2ThreadShell,
  ProviderInstanceId,
  ProviderThreadId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import { ProjectionStoreV2 } from "../../../orchestration-v2/ProjectionStore.ts";
import { ProjectStoreV2 } from "../../../orchestration-v2/ProjectStore.ts";
import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import {
  type SimCallerContext,
  SimAuditService,
  SimService,
  SimServiceError,
  type SimWriteRequest,
} from "../../../sim/SimContracts.ts";
import { advertisedJsonSchema } from "../../advertisedJsonSchema.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { liveThreadShell } from "../../McpToolAccess.testkit.ts";
import * as SimHandlers from "./handlers.ts";
import { SimToolkit } from "./tools.ts";

const environmentId = EnvironmentId.make("environment:sim");
const parentId = ThreadId.make("thread:parent");
const callerId = ThreadId.make("thread:caller");
const runId = RunId.make("run:mcp-test");
const providerThreadId = ProviderThreadId.make("provider-thread:caller");

type Lineage = OrchestrationV2ThreadShell["lineage"];
const forkOf = (parent: ThreadId, extra: Partial<Lineage> = {}): Lineage => ({
  rootThreadId: parentId,
  parentThreadId: parent,
  relationshipToParent: "fork",
  ...extra,
});

interface Setup {
  readonly caller?: "thread" | "client";
  readonly shells?: ReadonlyArray<OrchestrationV2ThreadShell>;
  readonly authors?: ReadonlyArray<string>;
  readonly failWith?: SimServiceError;
}

const setup = (options: Setup = {}) => {
  const reads: Array<{ caller: SimCallerContext; action: string }> = [];
  const writes: Array<{ caller: SimCallerContext; request: SimWriteRequest }> = [];
  const applies: Array<{ caller: SimCallerContext; dryRun: boolean }> = [];
  const recent: Array<{
    threadId: string;
    runId?: string | undefined;
    workspaceRoot?: string | undefined;
    files: ReadonlyArray<string>;
  }> = [];
  const shells = new Map(
    (options.shells ?? [liveThreadShell(callerId)]).map((shell) => [shell.id, shell]),
  );
  const fail = options.failWith === undefined ? undefined : Effect.fail(options.failWith);

  const records = {
    thread: undefined,
    runs: [
      {
        id: runId,
        threadId: callerId,
        modelSelection: { instanceId: ProviderInstanceId.make("claude"), model: "claude-opus-5-5" },
        providerThreadId,
      },
    ],
    providerThreads: [
      {
        id: providerThreadId,
        driver: "claudeAgent",
        nativeThreadRef: {
          driver: "claudeAgent",
          nativeId: "native-claude-session",
          strength: "strong",
        },
      },
    ],
  };

  const scope: McpInvocationContext.McpInvocationScope = {
    environmentId,
    requestNamespace: "provider:sim",
    thread:
      options.caller === "client"
        ? undefined
        : {
            threadId: callerId,
            providerSessionId: "internal-provider-session-uuid",
            providerInstanceId: ProviderInstanceId.make("codex"),
          },
    client:
      options.caller === "client"
        ? { sessionId: "oauth-session", label: "Outside", access: "full-access" }
        : undefined,
    capabilities: new Set(["orchestration" as const]),
    issuedAt: 0,
  };

  const layer = McpToolAccess.HandlersLayer.layer(SimHandlers.layer).pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        Layer.succeed(McpInvocationContext.McpInvocationContext, scope),
        Layer.mock(ThreadManagement.ThreadManagementService)({
          getThreadShell: (threadId) => Effect.succeed(shells.get(threadId) ?? null),
        }),
        Layer.mock(ProjectionStoreV2)({
          getThreadRecords: (() =>
            Effect.succeed(records)) as unknown as ProjectionStoreV2["Service"]["getThreadRecords"],
        }),
        Layer.mock(ProjectStoreV2)({
          getShell: () =>
            Effect.succeedSome({
              title: "Harness Lab",
              workspaceRoot: "/work/harness-lab",
            } as OrchestrationProjectShell),
        }),
        Layer.mock(SimService)({
          read: (caller, request) => {
            reads.push({ caller, action: request.action });
            return fail ?? Effect.succeed({ text: `read ${request.action}` });
          },
          write: (caller, request) => {
            writes.push({ caller, request });
            return (
              fail ??
              Effect.succeed(
                request.action === "observe" && request.input.selfGradeReason !== undefined
                  ? {
                      text: "observed",
                      settled: false,
                      unconfirmedReason: request.input.selfGradeReason,
                    }
                  : { text: `wrote ${request.action}`, attemptId: "A7", problemId: "P3" },
              )
            );
          },
          applyHarnessChange: (caller, request) => {
            applies.push({ caller, dryRun: request.dryRun === true });
            return (
              fail ??
              Effect.succeed({
                dryRun: request.dryRun === true,
                file: "~/.claude/AGENTS.md",
                text: request.dryRun === true ? "preview" : "applied",
                ...(request.dryRun === true ? { diffPreview: "+ new rule" } : { attemptId: "A8" }),
              })
            );
          },
          findAttemptAuthorSessions: () => Effect.succeed(options.authors ?? []),
          recordRecentAttemptInTurn: (input) => Effect.sync(() => void recent.push(input)),
        }),
        Layer.mock(SimAuditService)({
          audit: () =>
            Effect.succeed({
              text: "audit report",
              window: { since: "2026-11-01", source: "days" },
              threadsScanned: 4,
              claudeSessionsScanned: 0,
              sim: {
                journalBroken: null,
                driftCount: 0,
                uncoveredCount: 1,
                liveRules: 3,
                openPredictions: 2,
                missedLiveRules: 0,
              },
              signals: {
                verbalCorrections: 1,
                unrecordedHarnessEdits: 0,
                checkpointRollbacks: 0,
                midThreadModelSwitches: 0,
                interruptedWithSteer: 0,
                delegatedReviews: 0,
                newlyObservedModels: [],
              },
            }),
          inspectThread: (_caller, prefix) => Effect.succeed({ threadId: prefix, text: "thread" }),
          markAuditDone: () =>
            Effect.succeed({ lastAuditAt: "2026-11-19", statePath: "/state", text: "audit done" }),
        }),
      ),
    ),
  );

  const call = <Name extends keyof typeof SimToolkit.tools>(name: Name, params: unknown) =>
    Effect.gen(function* () {
      const toolkit = yield* SimToolkit;
      return yield* toolkit.handle(name, params as never).pipe(
        Stream.unwrap,
        Stream.runCollect,
        Effect.map((parts) => parts.at(-1)?.result as Record<string, unknown> | undefined),
      );
    }).pipe(Effect.provide(layer));

  return { call, reads, writes, applies, recent };
};

it.effect("derives caller identity from server state, never from the provider session id", () =>
  Effect.gen(function* () {
    const thread = setup({
      shells: [
        {
          ...liveThreadShell(callerId),
          activeProviderThreadId: providerThreadId,
          worktreePath: "/work/worktree-branch",
        },
      ],
    });
    expect(yield* thread.call("sim_read", { action: "index" })).toEqual({
      action: "index",
      text: "read index",
    });
    expect(thread.reads[0]?.caller).toMatchObject({
      sessionId: `t3:${callerId}`,
      alsoSessionId: "cc:native-claude-session",
      threadId: callerId,
      activeRunId: runId,
      driver: "claudeAgent",
      model: "claude-opus-5-5",
      projectName: "Harness Lab",
      workspaceRoot: "/work/worktree-branch",
    });
    expect(JSON.stringify(thread.reads[0]?.caller)).not.toContain("internal-provider-session-uuid");

    const mainCheckout = setup({
      shells: [{ ...liveThreadShell(callerId), activeProviderThreadId: providerThreadId }],
    });
    yield* mainCheckout.call("sim_read", { action: "index" });
    expect(mainCheckout.reads[0]?.caller.workspaceRoot).toBe("/work/harness-lab");

    const outside = setup({ caller: "client" });
    yield* outside.call("sim_read", { action: "check" });
    expect(outside.reads[0]?.caller).toEqual({ sessionId: "client:oauth-session" });
  }),
);

it.effect("routes audit and inspect_thread to the audit service", () =>
  Effect.gen(function* () {
    const { call, reads } = setup();
    expect(yield* call("sim_read", { action: "audit", days: 7 })).toMatchObject({
      action: "audit",
      text: "audit report",
      summary: { threadsScanned: 4, sim: { openPredictions: 2 } },
    });
    expect(yield* call("sim_read", { action: "inspect_thread", threadId: " thread:x " })).toEqual({
      action: "inspect_thread",
      text: "thread",
    });
    expect(yield* call("sim_read", { action: "inspect_thread" })).toMatchObject({
      code: "invalid_request",
    });
    expect(reads).toEqual([]);
  }),
);

it.effect("maps every sim_write action to its request and ignores a caller-supplied author", () =>
  Effect.gen(function* () {
    const { call, writes, recent } = setup();
    const cases: ReadonlyArray<readonly [Record<string, unknown>, SimWriteRequest]> = [
      [
        {
          action: "attempt",
          problem: "P3",
          changeAction: "add",
          what: "rule",
          why: "reason",
          files: ["~/.claude/AGENTS.md"],
          by: "t3:spoofed",
          session: "t3:spoofed",
        },
        {
          action: "attempt",
          input: expect.objectContaining({
            problem: "P3",
            action: "add",
            what: "rule",
            why: "reason",
            files: ["~/.claude/AGENTS.md"],
          }),
        },
      ],
      [
        { action: "observe", attempt: "A1", result: "missed", evidence: "log", source: "log" },
        {
          action: "observe",
          input: expect.objectContaining({ attempt: "A1", result: "missed", source: "log" }),
        },
      ],
      [
        { action: "amend", amendTarget: "A1", field: "why", value: "better", reason: "typo" },
        { action: "amend", target: "A1", field: "why", value: "better", reason: "typo" },
      ],
      [
        { action: "retract", attempt: "A1", reason: "wrong", outcome: 2 },
        { action: "retract", attempt: "A1", reason: "wrong", outcome: 2, undo: undefined },
      ],
      [
        { action: "link", a: "P1", kind: "refines", b: "P2" },
        { action: "link", a: "P1", kind: "refines", b: "P2" },
      ],
      [
        { action: "merge", from: "P1", into: "P2" },
        { action: "merge", from: "P1", into: "P2" },
      ],
      [
        { action: "carry", fromHarness: "claude", toHarness: "codex" },
        expect.objectContaining({ action: "carry", fromHarness: "claude", toHarness: "codex" }),
      ],
    ];
    for (const [params] of cases) yield* call("sim_write", params);

    expect(writes.map(({ request }) => request)).toEqual(cases.map(([, request]) => request));
    for (const { caller, request } of writes) {
      expect(caller.sessionId).toBe(`t3:${callerId}`);
      expect(JSON.stringify(request)).not.toContain("spoofed");
    }
    expect(recent).toEqual([
      {
        threadId: callerId,
        runId,
        workspaceRoot: "/work/harness-lab",
        files: ["~/.claude/AGENTS.md"],
      },
    ]);
    expect(yield* call("sim_write", { action: "mark_audit_done" })).toEqual({
      action: "mark_audit_done",
      text: "audit done",
    });
    expect(yield* call("sim_write", { action: "attempt", what: "rule" })).toMatchObject({
      code: "invalid_request",
      message: "attempt needs changeAction, why.",
    });
    expect(writes).toHaveLength(cases.length);
  }),
);

it.effect("refuses sim_write and live harness edits from outside clients", () =>
  Effect.gen(function* () {
    const { call, writes, applies } = setup({ caller: "client" });
    expect(yield* call("sim_write", { action: "merge", from: "P1", into: "P2" })).toMatchObject({
      code: "thread_credential_required",
    });
    expect(
      yield* call("sim_apply_harness_change", {
        file: "~/.claude/AGENTS.md",
        content: "x",
        dryRun: true,
        attempt: { action: "add", what: "w", why: "y" },
      }),
    ).toMatchObject({ code: "thread_credential_required" });
    expect(writes).toEqual([]);
    expect(applies).toEqual([]);
  }),
);

it.effect("marks a fixed grade from the change's own fork family as a self-grade", () =>
  Effect.gen(function* () {
    const parent = liveThreadShell(parentId);
    const siblingId = ThreadId.make("thread:sibling");
    const sibling = { ...liveThreadShell(siblingId), lineage: forkOf(parentId) };
    const observe = {
      action: "observe",
      attempt: "A1",
      result: "fixed",
      evidence: "ok",
      source: "user",
    };
    const selfGrade = (lineage: Lineage, authors: ReadonlyArray<string>) =>
      Effect.gen(function* () {
        const { call, writes } = setup({
          shells: [parent, sibling, { ...liveThreadShell(callerId), lineage }],
          authors,
        });
        const result = yield* call("sim_write", observe);
        const request = writes[0]?.request;
        return {
          result,
          reason: request?.action === "observe" ? request.input.selfGradeReason : "not observed",
        };
      });

    const fork = yield* selfGrade(forkOf(parentId), [`t3:${parentId}`]);
    expect(fork.reason).toBe(SimHandlers.SELF_GRADE_REASON);
    expect(fork.result).toMatchObject({
      settled: false,
      unconfirmedReason: SimHandlers.SELF_GRADE_REASON,
    });
    expect(
      (yield* selfGrade(forkOf(parentId, { sideChat: true }), [`t3:${parentId}`])).reason,
    ).toBe(SimHandlers.SELF_GRADE_REASON);
    expect((yield* selfGrade(forkOf(parentId), ["cc:x", `t3:${siblingId}`])).reason).toBe(
      SimHandlers.SELF_GRADE_REASON,
    );

    const delegated = yield* selfGrade(forkOf(parentId, { relationshipToParent: "subagent" }), [
      `t3:${parentId}`,
    ]);
    expect(delegated.reason).toBeUndefined();
    expect(
      (yield* selfGrade(
        { rootThreadId: callerId, parentThreadId: null, relationshipToParent: null },
        [`t3:${parentId}`],
      )).reason,
    ).toBeUndefined();
  }),
);

it.effect(
  "allows dry runs in any mode and live harness edits only in full-access/default mode",
  () =>
    Effect.gen(function* () {
      const params = (dryRun: boolean) => ({
        file: "~/.claude/AGENTS.md",
        oldText: "a",
        newText: "b",
        dryRun,
        attempt: { action: "revise", what: "w", why: "y", files: ["~/.claude/notes/x.md"] },
      });
      const inMode = (modes: Parameters<typeof liveThreadShell>[1]) =>
        setup({ shells: [liveThreadShell(callerId, modes)] });

      const plan = inMode({ interactionMode: "plan" });
      expect(yield* plan.call("sim_apply_harness_change", params(true))).toEqual({
        dryRun: true,
        file: "~/.claude/AGENTS.md",
        text: "preview",
        diffPreview: "+ new rule",
      });
      expect(yield* plan.call("sim_apply_harness_change", params(false))).toMatchObject({
        code: "capability_denied",
      });
      for (const restricted of [
        { runtimeMode: "approval-required" as const },
        { runtimeMode: "auto-accept-edits" as const },
        { runtimeMode: "auto" as const },
      ]) {
        const harness = inMode(restricted);
        expect(yield* harness.call("sim_apply_harness_change", params(true))).toMatchObject({
          dryRun: true,
        });
        expect(yield* harness.call("sim_apply_harness_change", params(false))).toMatchObject({
          code: "capability_denied",
        });
        expect(harness.applies).toEqual([{ caller: expect.anything(), dryRun: true }]);
      }
      expect(plan.recent).toEqual([]);

      const live = inMode({ runtimeMode: "full-access", interactionMode: "default" });
      expect(yield* live.call("sim_apply_harness_change", params(false))).toMatchObject({
        dryRun: false,
        attemptId: "A8",
      });
      expect(live.recent).toEqual([
        {
          threadId: callerId,
          runId,
          workspaceRoot: "/work/harness-lab",
          files: ["~/.claude/AGENTS.md", "~/.claude/notes/x.md"],
        },
      ]);
    }),
);

it.effect("returns SimServiceError as OrchestratorMcpFailure codes", () =>
  Effect.gen(function* () {
    const cases = [
      ["forbidden_path", "capability_denied"],
      ["disabled", "capability_denied"],
      ["not_found", "invalid_request"],
      ["validation", "invalid_request"],
      ["seen_required", "invalid_request"],
      ["drift", "invalid_request"],
      ["journal_broken", "orchestration_error"],
      ["io", "orchestration_error"],
    ] as const;
    for (const [simCode, code] of cases) {
      const { call } = setup({
        failWith: new SimServiceError({ code: simCode, problems: [`problem ${simCode}`] }),
      });
      expect(yield* call("sim_read", { action: "index" })).toMatchObject({
        _tag: "OrchestratorMcpFailure",
        code,
        message: `problem ${simCode}`,
      });
    }
  }),
);

it("advertises compact flat schemas without any caller identity field", () => {
  for (const tool of Object.values(SimToolkit.tools)) {
    const schema = advertisedJsonSchema(tool) as {
      type: string;
      properties: Record<string, unknown>;
    };
    expect(schema.type).toBe("object");
    expect(schema.properties).not.toHaveProperty("by");
    expect(schema.properties).not.toHaveProperty("session");
    expect(JSON.stringify(schema)).not.toContain('anyOf":[{"type":"null"');
    expect(JSON.stringify(schema).length).toBeLessThan(3_000);
  }
  expect(
    (advertisedJsonSchema(SimToolkit.tools.sim_apply_harness_change) as { required: unknown })
      .required,
  ).toEqual(["file", "attempt"]);
});
