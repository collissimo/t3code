import type {
  ModelSelection,
  ProjectId,
  ServerProvider,
  ServerSettings,
  ServerSettingsPatch,
  ThreadId,
} from "@t3tools/contracts";

import { resolveProjectSettings } from "./projectSettings.ts";

/** The model a new orchestrator starts on when a provider offers it. */
const ORCHESTRATOR_MODEL = "claude-fable-5-2";

/** Ids of never-sent drafts stay listed, so the list keeps only the newest. */
const MAX_ORCHESTRATOR_THREADS = 200;

export function isOrchestratorThread(
  settings: Pick<ServerSettings, "orchestratorThreads">,
  threadId: ThreadId,
): boolean {
  return settings.orchestratorThreads.includes(threadId);
}

/**
 * The model an orchestrator's workers start on: the project's default model. Undefined when the
 * thread is no orchestrator or no default is set, so a worker inherits its parent's model.
 */
export function orchestratorWorkerModelSelection(
  settings: ServerSettings,
  thread: { readonly id: ThreadId; readonly projectId: ProjectId | null } | undefined,
): ModelSelection | undefined {
  if (thread === undefined || !isOrchestratorThread(settings, thread.id)) return undefined;
  return (
    resolveProjectSettings(settings, thread.projectId).settings.defaultModelSelection ?? undefined
  );
}

/** The selection a new orchestrator starts on, or null to keep the new thread's usual model. */
export function orchestratorModelSelection(
  providers: ReadonlyArray<Pick<ServerProvider, "instanceId" | "enabled" | "installed" | "models">>,
): ModelSelection | null {
  const provider = providers.find(
    (candidate) =>
      candidate.enabled &&
      candidate.installed &&
      candidate.models.some((model) => model.slug === ORCHESTRATOR_MODEL),
  );
  return provider ? { instanceId: provider.instanceId, model: ORCHESTRATOR_MODEL } : null;
}

/** The settings patch that turns orchestrator mode on or off for a thread, or null when nothing changes. */
export function orchestratorThreadsPatch(
  current: ReadonlyArray<ThreadId>,
  threadId: ThreadId,
  orchestrator: boolean,
): ServerSettingsPatch | null {
  if (current.includes(threadId) === orchestrator) return null;
  return {
    orchestratorThreads: orchestrator
      ? [...current, threadId].slice(-MAX_ORCHESTRATOR_THREADS)
      : current.filter((id) => id !== threadId),
  };
}
