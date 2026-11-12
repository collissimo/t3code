import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { isOrchestratorThread } from "@t3tools/shared/orchestratorMode";

import { useServerConfigs } from "../../state/entities";
import { Badge } from "../ui/badge";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

/** Marks a thread whose agent runs in orchestrator mode. */
export function OrchestratorBadge(props: { environmentId: EnvironmentId; threadId: ThreadId }) {
  const settings = useServerConfigs().get(props.environmentId)?.settings;
  if (settings === undefined || !isOrchestratorThread(settings, props.threadId)) return null;
  return (
    <Tooltip>
      <TooltipTrigger render={<Badge variant="info" size="sm" />}>Orchestrator</TooltipTrigger>
      <TooltipPopup side="top">
        Plans the work and hands it to workers. Manage it on the Orchestrator page.
      </TooltipPopup>
    </Tooltip>
  );
}
