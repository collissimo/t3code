import type { ScheduledTask, ScheduledTaskId, ServerSettingsPatch } from "@t3tools/contracts";
import { scheduledTaskThreadMode } from "@t3tools/contracts";

/** Only tasks that start a new thread per run can archive it; a bound thread must stay open. */
export function canArchiveScheduledTaskRuns(task: Pick<ScheduledTask, "threadId" | "threadMode">) {
  return scheduledTaskThreadMode(task) === "new_thread";
}

/** The settings patch that turns run archiving on or off for a task, or null when nothing changes. */
export function scheduledTaskRunArchivePatch(
  current: ReadonlyArray<ScheduledTaskId>,
  taskId: ScheduledTaskId,
  archive: boolean,
): ServerSettingsPatch | null {
  if (current.includes(taskId) === archive) return null;
  return {
    archiveScheduledTaskRuns: archive
      ? [...current, taskId]
      : current.filter((id) => id !== taskId),
  };
}
