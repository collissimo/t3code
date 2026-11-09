import { CommandId, type OrchestrationV2DomainEvent } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import { forkParked } from "../serverActivation.ts";
import * as ServerSettings from "../serverSettings.ts";

/** Archives a scheduled task's run thread once its run completes, for tasks listed in `archiveScheduledTaskRuns`. */
export class ScheduledRunArchiveReactor extends Context.Service<
  ScheduledRunArchiveReactor,
  {
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
    readonly handle: (event: OrchestrationV2DomainEvent) => Effect.Effect<void>;
  }
>()("t3/scheduledTasks/ScheduledRunArchiveReactor") {}

const make = Effect.gen(function* () {
  const engine = yield* Orchestrator.OrchestratorV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const settingsService = yield* ServerSettings.ServerSettingsService;
  const sql = yield* SqlClient.SqlClient;

  const handle: ScheduledRunArchiveReactor["Service"]["handle"] = Effect.fnUntraced(
    function* (event) {
      // Failed or interrupted runs stay visible so a broken task gets noticed.
      if (event.type !== "run.updated" || event.payload.status !== "completed") return;
      const archiving = (yield* settingsService.getSettings).archiveScheduledTaskRuns;
      if (archiving.length === 0) return;
      const records = yield* projections.getThreadRecords(event.threadId, ["runs"]);
      if (records.thread.archivedAt !== null || records.thread.deletedAt !== null) return;
      const latest = records.runs.toSorted((a, b) => b.ordinal - a.ordinal)[0];
      // A follow-up the user queued or sent after the scheduled run keeps the thread open.
      if (latest?.id !== event.payload.id) return;
      const message = (yield* projections.getMessagesById(event.threadId, [
        event.payload.userMessageId,
      ])).get(event.payload.userMessageId);
      const taskId = message?.scheduledTaskId;
      if (taskId === undefined || !archiving.includes(taskId)) return;
      // A task bound to one thread would fail its next run on an archived thread.
      const [task] = yield* sql<{
        readonly thread_mode: string;
      }>`SELECT thread_mode FROM scheduled_tasks WHERE task_id = ${taskId}`;
      if (task?.thread_mode !== "new_thread") return;
      yield* engine.dispatch({
        type: "thread.archive",
        commandId: CommandId.make(`server:scheduled-run-archive:${event.payload.id}`),
        threadId: event.threadId,
      });
    },
    (effect, event) =>
      effect.pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("archiving a scheduled run thread failed", {
            threadId: event.threadId,
            cause,
          }),
        ),
      ),
  );

  const start: ScheduledRunArchiveReactor["Service"]["start"] = () =>
    forkParked(
      Stream.runForEach(engine.streamDomainEvents, handle).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("scheduled run archive event stream failed", { cause }),
        ),
      ),
    );

  return { start, handle } satisfies ScheduledRunArchiveReactor["Service"];
});

export const layer = Layer.effect(ScheduledRunArchiveReactor, make);
