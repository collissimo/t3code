import {
  MessageId,
  RunId,
  ScheduledTaskId,
  ThreadId,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2Run,
  type OrchestrationV2RunStatus,
} from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as SqlClient from "effect/sql/SqlClient";

import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ScheduledRunArchiveReactor from "./ScheduledRunArchiveReactor.ts";

const THREAD_ID = ThreadId.make("thread-run");
const ARCHIVED_TASK = ScheduledTaskId.make("task-archived");
const BOUND_TASK = ScheduledTaskId.make("task-bound");
const OTHER_TASK = ScheduledTaskId.make("task-other");

function makeRun(id: string, ordinal: number, status: OrchestrationV2RunStatus) {
  return {
    id: RunId.make(id),
    threadId: THREAD_ID,
    ordinal,
    userMessageId: MessageId.make(`message-${id}`),
    status,
  } as OrchestrationV2Run;
}

interface Case {
  readonly name: string;
  readonly status: OrchestrationV2RunStatus;
  readonly taskId: ScheduledTaskId | undefined;
  readonly laterRun?: boolean;
  readonly archives: boolean;
}

const cases: ReadonlyArray<Case> = [
  {
    name: "completed run of a listed task",
    status: "completed",
    taskId: ARCHIVED_TASK,
    archives: true,
  },
  { name: "failed run stays visible", status: "failed", taskId: ARCHIVED_TASK, archives: false },
  { name: "task not listed", status: "completed", taskId: OTHER_TASK, archives: false },
  { name: "user turn without a task", status: "completed", taskId: undefined, archives: false },
  { name: "bound task keeps its thread", status: "completed", taskId: BOUND_TASK, archives: false },
  {
    name: "user follow-up after the run",
    status: "completed",
    taskId: ARCHIVED_TASK,
    laterRun: true,
    archives: false,
  },
];

describe("ScheduledRunArchiveReactor", () => {
  it.effect.each(cases)("$name", (testCase) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      for (const [taskId, mode] of [
        [ARCHIVED_TASK, "new_thread"],
        [BOUND_TASK, "continue"],
        [OTHER_TASK, "new_thread"],
      ] as const) {
        yield* sql`INSERT INTO scheduled_tasks (task_id, title, prompt, enabled, schedule_json,
            project_id, thread_mode, workspace_strategy_json, model_selection_json, runtime_mode,
            interaction_mode, created_by, creation_source, created_at, updated_at, last_run_status,
            run_count)
            VALUES (${taskId}, 't', 'p', 1, '{}', 'project', ${mode}, '{}', '{}', 'full-access',
            'default', 'user', 'web', '', '', 'never', 0)`;
      }

      const run = makeRun("run-1", 1, testCase.status);
      const runs = testCase.laterRun ? [run, makeRun("run-2", 2, "running")] : [run];
      const dispatched = yield* Ref.make<ReadonlyArray<readonly [string, string | null]>>([]);
      const dependencies = Layer.mergeAll(
        Layer.mock(ProjectionStore.ProjectionStoreV2)({
          getThreadRecords: () =>
            Effect.succeed({
              thread: { id: THREAD_ID, archivedAt: null, deletedAt: null },
              runs,
            } as never),
          getMessagesById: (_threadId, ids) =>
            Effect.succeed(
              new Map(
                ids.map((id) => [
                  id,
                  { id, scheduledTaskId: testCase.taskId } as OrchestrationV2ConversationMessage,
                ]),
              ),
            ),
        }),
        Layer.mock(Orchestrator.OrchestratorV2)({
          dispatch: (command) =>
            Ref.update(dispatched, (all) => [
              ...all,
              [command.type, "threadId" in command ? command.threadId : null] as const,
            ]).pipe(Effect.as({} as never)),
        }),
        ServerSettings.layerTest({ archiveScheduledTaskRuns: [ARCHIVED_TASK, BOUND_TASK] }),
        Layer.succeed(SqlClient.SqlClient, sql),
      );
      const reactor = yield* ScheduledRunArchiveReactor.ScheduledRunArchiveReactor.pipe(
        Effect.provide(ScheduledRunArchiveReactor.layer.pipe(Layer.provide(dependencies))),
      );

      yield* reactor.handle({
        type: "run.updated",
        threadId: THREAD_ID,
        runId: run.id,
        payload: run,
      } as OrchestrationV2DomainEvent);

      assert.deepStrictEqual(
        yield* Ref.get(dispatched),
        testCase.archives ? [["thread.archive", THREAD_ID]] : [],
      );
    }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
  );
});
