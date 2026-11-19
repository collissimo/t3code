import {
  type OrchestrationV2ThreadShell,
  OrchestratorMcpFailure,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type { Tool } from "effect/ai";

import { ProjectionStoreV2 } from "../../../orchestration-v2/ProjectionStore.ts";
import { ProjectStoreV2 } from "../../../orchestration-v2/ProjectStore.ts";
import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import {
  type SimCallerContext,
  type SimErrorCode,
  SimAuditService,
  SimService,
  type SimServiceError,
  type SimWriteRequest,
} from "../../../sim/SimContracts.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { assertFullAccess, loadCaller } from "../../threadAccess.ts";
import { SimToolkit } from "./tools.ts";

type WriteParams = Tool.Parameters<typeof SimToolkit.tools.sim_write>;
type ApplyParams = Tool.Parameters<typeof SimToolkit.tools.sim_apply_harness_change>;
type Threads = ThreadManagement.ThreadManagementService["Service"];

const CLAUDE_DRIVER = "claudeAgent";
const MAX_FORK_HOPS = 16;
export const SELF_GRADE_REASON = "same fork or side-chat lineage as the change";

const isThreadId = Schema.is(ThreadId);

const SIM_FAILURE_CODES: Record<SimErrorCode, OrchestratorMcpFailure["code"]> = {
  forbidden_path: "capability_denied",
  disabled: "capability_denied",
  not_found: "invalid_request",
  validation: "invalid_request",
  seen_required: "invalid_request",
  drift: "invalid_request",
  journal_broken: "orchestration_error",
  io: "orchestration_error",
};

const simFailure = (error: SimServiceError) =>
  new OrchestratorMcpFailure({
    code: SIM_FAILURE_CODES[error.code],
    message: error.message || `SIM request failed (${error.code}).`,
  });

const invalid = (message: string) =>
  new OrchestratorMcpFailure({ code: "invalid_request", message });

const requireFields = <P extends object, K extends keyof P>(
  action: string,
  params: P,
  keys: ReadonlyArray<K>,
): Effect.Effect<
  P & { readonly [Key in K]-?: Exclude<P[Key], undefined> },
  OrchestratorMcpFailure
> => {
  const absent = keys.filter((key) => params[key] === undefined);
  return absent.length === 0
    ? Effect.succeed(params as P & { readonly [Key in K]-?: Exclude<P[Key], undefined> })
    : Effect.fail(invalid(`${action} needs ${absent.map(String).join(", ")}.`));
};

const shellOf = (threads: Threads, threadId: ThreadId) =>
  threads.getThreadShell(threadId).pipe(Effect.orElseSucceed(() => null));

/** The parent a fork or side chat shares its change history with; delegated children have none. */
const forkParent = (shell: OrchestrationV2ThreadShell | null) => {
  const lineage = shell?.lineage;
  return lineage !== undefined &&
    lineage.parentThreadId !== null &&
    (lineage.relationshipToParent === "fork" || lineage.sideChat === true)
    ? lineage.parentThreadId
    : null;
};

/** `threadId` followed by its fork and side-chat ancestors, nearest first. */
const forkChain = Effect.fn("SimHandlers.forkChain")(function* (
  threads: Threads,
  threadId: ThreadId,
  shell: OrchestrationV2ThreadShell | null,
) {
  const chain = [threadId];
  let parent = forkParent(shell);
  while (parent !== null && chain.length <= MAX_FORK_HOPS && !chain.includes(parent)) {
    chain.push(parent);
    parent = forkParent(yield* shellOf(threads, parent));
  }
  return chain;
});

/**
 * Whether an attempt author shares a fork or side-chat family with the caller. The caller's own
 * thread is left to `SimService`, which compares sessions itself.
 */
const sharesForkFamily = Effect.fn("SimHandlers.sharesForkFamily")(function* (
  threads: Threads,
  callerChain: ReadonlyArray<ThreadId>,
  authorSessions: ReadonlyArray<string>,
) {
  for (const session of authorSessions) {
    const authorId = session.startsWith("t3:") ? session.slice(3) : "";
    if (!isThreadId(authorId) || authorId === callerChain[0]) continue;
    if (callerChain.includes(authorId)) return true;
    const authorChain = yield* forkChain(threads, authorId, yield* shellOf(threads, authorId));
    if (authorChain.some((id) => callerChain.includes(id))) return true;
  }
  return false;
});

interface ResolvedCaller {
  readonly context: SimCallerContext;
  readonly shell: OrchestrationV2ThreadShell | null;
  readonly forkChain: ReadonlyArray<ThreadId>;
}

interface OptionalStores {
  readonly projections: Option.Option<ProjectionStoreV2["Service"]>;
  readonly projectStore: Option.Option<ProjectStoreV2["Service"]>;
}

/** Identity comes only from the authenticated invocation and server state, never from arguments. */
const resolveCaller = Effect.fn("SimHandlers.resolveCaller")(function* (stores?: OptionalStores) {
  const scope = yield* McpInvocationContext.McpInvocationContext;
  if (scope.thread === undefined) {
    return {
      context: {
        sessionId: scope.client === undefined ? "unknown" : `client:${scope.client.sessionId}`,
      },
      shell: null,
      forkChain: [],
    } satisfies ResolvedCaller;
  }
  const { threadId, providerInstanceId, subagent } = scope.thread;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const shell = yield* shellOf(threads, threadId);
  const chain = yield* forkChain(threads, threadId, shell);

  const projections =
    stores !== undefined && Option.isSome(stores.projections)
      ? stores.projections
      : yield* Effect.serviceOption(ProjectionStoreV2);
  const records = Option.isNone(projections)
    ? null
    : yield* projections.value
        .getThreadRecords(threadId, ["runs", "providerThreads"])
        .pipe(Effect.orElseSucceed(() => null));
  const activeRunId = shell?.activeRunId ?? undefined;
  const run =
    records?.runs.find((candidate) => candidate.id === activeRunId) ??
    records?.runs.findLast((candidate) => candidate.id === shell?.latestRunId) ??
    records?.runs.at(-1);
  const providerThreadId = shell?.activeProviderThreadId ?? run?.providerThreadId ?? null;
  const providerThread =
    providerThreadId === null
      ? undefined
      : records?.providerThreads.find((candidate) => candidate.id === providerThreadId);
  const nativeRef = providerThread?.nativeThreadRef;
  const alsoSessionId =
    nativeRef?.driver === CLAUDE_DRIVER && nativeRef.nativeId
      ? `cc:${nativeRef.nativeId}`
      : undefined;

  const projectId = shell?.projectId;
  const projectStore =
    stores !== undefined && Option.isSome(stores.projectStore)
      ? stores.projectStore
      : yield* Effect.serviceOption(ProjectStoreV2);
  const project =
    projectId === undefined || Option.isNone(projectStore)
      ? undefined
      : Option.getOrUndefined(
          yield* projectStore.value
            .getShell(projectId)
            .pipe(Effect.orElseSucceed(() => Option.none())),
        );

  return {
    context: {
      sessionId: `t3:${threadId}`,
      alsoSessionId,
      forkFamilySessionIds: chain.slice(1).map((id) => `t3:${id}`),
      threadId,
      activeRunId,
      providerInstanceId,
      driver: providerThread?.driver,
      model: run?.modelSelection.model ?? shell?.modelSelection.model,
      projectId,
      projectName: project?.title,
      workspaceRoot: shell?.worktreePath ?? project?.workspaceRoot ?? undefined,
      subagent,
    },
    shell,
    forkChain: chain,
  } satisfies ResolvedCaller;
});

const recordRecentAttempt = (
  { threadId, activeRunId, workspaceRoot }: SimCallerContext,
  files: ReadonlyArray<string>,
) =>
  threadId === undefined
    ? Effect.void
    : SimService.use((sim) =>
        sim.recordRecentAttemptInTurn({ threadId, runId: activeRunId, workspaceRoot, files }),
      ).pipe(Effect.ignore);

const attemptInput = (params: WriteParams) =>
  requireFields("attempt", params, ["changeAction", "what", "why"]).pipe(
    Effect.map((p): SimWriteRequest => ({
      action: "attempt",
      input: {
        problem: p.problem,
        new: p.new,
        action: p.changeAction,
        what: p.what,
        why: p.why,
        files: p.files,
        anchor: p.anchor,
        supersedes: p.supersedes,
        depends_on: p.depends_on,
        predicted: p.predicted,
        expect: p.expect,
        policy: p.policy,
        domain: p.domain,
        harness: p.harness,
        accepted: p.accepted,
        rejected_because: p.rejected_because,
        unanswered: p.unanswered,
        backfilled: p.backfilled,
        round: p.round,
        sample: p.sample,
      },
    })),
  );

const observeInput = Effect.fn("SimHandlers.observeInput")(function* (
  params: WriteParams,
  caller: ResolvedCaller,
) {
  const p = yield* requireFields("observe", params, ["attempt", "result", "evidence", "source"]);
  let selfGradeReason: string | undefined;
  if (p.result === "fixed" && caller.forkChain.length > 0) {
    const sim = yield* SimService;
    const threads = yield* ThreadManagement.ThreadManagementService;
    const authors = yield* sim.findAttemptAuthorSessions(p.attempt);
    if (yield* sharesForkFamily(threads, caller.forkChain, authors)) {
      selfGradeReason = SELF_GRADE_REASON;
    }
  }
  return {
    action: "observe",
    input: {
      attempt: p.attempt,
      target: p.target,
      result: p.result,
      evidence: p.evidence,
      source: p.source,
      policy: p.policy,
      domain: p.domain,
      harness: p.harness,
      date: p.date,
      selfGradeReason,
    },
  } satisfies SimWriteRequest;
});

const writeRequest = (
  action: Exclude<WriteParams["action"], "mark_audit_done">,
  params: WriteParams,
  caller: ResolvedCaller,
): Effect.Effect<
  SimWriteRequest,
  OrchestratorMcpFailure,
  SimService | ThreadManagement.ThreadManagementService
> => {
  switch (action) {
    case "attempt":
      return attemptInput(params);
    case "observe":
      return observeInput(params, caller);
    case "amend":
      return requireFields("amend", params, ["amendTarget", "field", "value", "reason"]).pipe(
        Effect.map((p) => ({
          action: "amend" as const,
          target: p.amendTarget,
          field: p.field,
          value: p.value,
          reason: p.reason,
        })),
      );
    case "retract":
      return requireFields("retract", params, ["attempt", "reason"]).pipe(
        Effect.map((p) => ({
          action: "retract" as const,
          attempt: p.attempt,
          outcome: p.outcome,
          reason: p.reason,
          undo: p.undo,
        })),
      );
    case "link":
      return requireFields("link", params, ["a", "kind", "b"]).pipe(
        Effect.map((p) => ({ action: "link" as const, a: p.a, kind: p.kind, b: p.b })),
      );
    case "merge":
      return requireFields("merge", params, ["from", "into"]).pipe(
        Effect.map((p) => ({ action: "merge" as const, from: p.from, into: p.into })),
      );
    case "carry":
      return Effect.succeed({
        action: "carry",
        fromPolicy: params.fromPolicy,
        toPolicy: params.toPolicy,
        fromDomain: params.fromDomain,
        toDomain: params.toDomain,
        fromHarness: params.fromHarness,
        toHarness: params.toHarness,
        date: params.date,
        note: params.note,
      });
  }
};

const definedOnly = <T extends object>(value: T) =>
  Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as {
    [K in keyof T]: Exclude<T[K], undefined>;
  };

const makeApplyHarnessChange = (stores: OptionalStores) =>
  Effect.fn("SimHandlers.applyHarnessChange")(function* (params: ApplyParams) {
    if (params.dryRun !== true) {
      const access = yield* loadCaller();
      yield* assertFullAccess(
        access,
        `Live sim_apply_harness_change requires full-access/default mode (this caller is limited to ${access.limits.runtimeMode}/${access.limits.interactionMode}), because it writes harness files directly on disk. Call sim_apply_harness_change with dryRun: true to propose the change instead.`,
      );
    }
    const caller = yield* resolveCaller(stores);
    const sim = yield* SimService;
    const result = yield* sim
      .applyHarnessChange(caller.context, params)
      .pipe(Effect.mapError(simFailure));
    if (!result.dryRun) {
      yield* recordRecentAttempt(caller.context, [
        ...new Set([result.file, ...(params.attempt.files ?? [])]),
      ]);
    }
    return definedOnly(result);
  });

export const layer = McpToolAccess.toLayer(
  SimToolkit,
  Effect.gen(function* () {
    // Capture optional stores at registration time so McpHttpServer's per-request service
    // scoping still gives handlers access to ProjectionStoreV2 and ProjectStoreV2.
    const stores: OptionalStores = {
      projections: yield* Effect.serviceOption(ProjectionStoreV2),
      projectStore: yield* Effect.serviceOption(ProjectStoreV2),
    };
    const applyHarnessChange = makeApplyHarnessChange(stores);
    return {
      sim_read: McpToolAccess.reads((params) =>
        Effect.gen(function* () {
          const { context } = yield* resolveCaller(stores);
          if (params.action === "audit") {
            const audit = yield* SimAuditService;
            const report = yield* audit
              .audit(context, {
                since: params.since,
                days: params.days,
                limit: params.limit,
                includeClaudeLogs: params.includeClaudeLogs,
              })
              .pipe(Effect.mapError(simFailure));
            return definedOnly({
              action: params.action,
              text: report.text,
              advisorEscalation: report.advisorEscalation,
              summary: {
                window: report.window,
                threadsScanned: report.threadsScanned,
                claudeSessionsScanned: report.claudeSessionsScanned,
                sim: report.sim,
                signals: report.signals,
              },
            });
          }
          if (params.action === "inspect_thread") {
            if (params.threadId === undefined || params.threadId.trim() === "") {
              return yield* invalid("inspect_thread needs threadId.");
            }
            const audit = yield* SimAuditService;
            const inspection = yield* audit
              .inspectThread(context, params.threadId.trim())
              .pipe(Effect.mapError(simFailure));
            return { action: params.action, text: inspection.text };
          }
          const sim = yield* SimService;
          const result = yield* sim
            .read(context, {
              action: params.action,
              ids: params.ids,
              brief: params.brief,
              query: params.query,
              file: params.file,
              policy: params.policy,
              harness: params.harness,
              page: params.page,
              days: params.days,
              maxTokens: params.maxTokens,
            })
            .pipe(Effect.mapError(simFailure));
          return definedOnly({
            action: params.action,
            text: result.text,
            failed: result.failed,
            advisorEscalation: result.advisorEscalation,
          });
        }),
      ),
      sim_write: McpToolAccess.actsAsCaller((params) =>
        Effect.gen(function* () {
          const caller = yield* resolveCaller(stores);
          if (params.action === "mark_audit_done") {
            const audit = yield* SimAuditService;
            const done = yield* audit
              .markAuditDone(caller.context)
              .pipe(Effect.mapError(simFailure));
            return { action: params.action, text: done.text };
          }
          const request = yield* writeRequest(params.action, params, caller);
          const sim = yield* SimService;
          const result = yield* sim
            .write(caller.context, request)
            .pipe(Effect.mapError(simFailure));
          if (params.action === "attempt") {
            yield* recordRecentAttempt(caller.context, params.files ?? []);
          }
          return definedOnly({ action: params.action, ...result });
        }),
      ),
      sim_apply_harness_change: McpToolAccess.either(
        (params) => params.dryRun === true,
        McpToolAccess.readsAsCaller(applyHarnessChange),
        McpToolAccess.actsAsCaller(applyHarnessChange),
      ),
    };
  }),
);
