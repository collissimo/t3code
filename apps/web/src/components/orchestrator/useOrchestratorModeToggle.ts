import { isOrchestratorThread } from "@t3tools/shared/orchestratorMode";

import { useHandleNewThread } from "../../hooks/useHandleNewThread";
import { setThreadOrchestratorMode } from "../../lib/orchestratorMode";
import { useServerConfigs } from "../../state/entities";

/** Orchestrator mode of the open chat. Without an open chat, toggling starts a new one in the mode. */
export function useOrchestratorModeToggle() {
  const { activeDraftThread, defaultProjectRef, handleNewThread, routeDraftId, routeThreadRef } =
    useHandleNewThread();
  const serverConfigs = useServerConfigs();
  const target =
    routeThreadRef !== null
      ? { ...routeThreadRef, draftId: null }
      : routeDraftId !== null && activeDraftThread !== null
        ? {
            environmentId: activeDraftThread.environmentId,
            threadId: activeDraftThread.threadId,
            draftId: routeDraftId,
          }
        : null;
  const settings = target === null ? undefined : serverConfigs.get(target.environmentId)?.settings;
  const on =
    target !== null && settings !== undefined && isOrchestratorThread(settings, target.threadId);

  const toggle = async () => {
    if (target !== null) {
      await setThreadOrchestratorMode(target, !on);
      return;
    }
    if (defaultProjectRef === null) return;
    const opened = await handleNewThread(defaultProjectRef);
    if (opened === null) return;
    await setThreadOrchestratorMode(
      { environmentId: defaultProjectRef.environmentId, ...opened },
      true,
    );
  };

  return { on, toggle };
}
