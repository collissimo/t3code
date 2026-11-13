import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { isOrchestratorThread } from "@t3tools/shared/orchestratorMode";
import { NetworkIcon } from "lucide-react";

import { useServerConfigs } from "../../state/entities";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

/** Marks a thread whose agent runs in orchestrator mode. */
export function OrchestratorBadge(props: { environmentId: EnvironmentId; threadId: ThreadId }) {
  const settings = useServerConfigs().get(props.environmentId)?.settings;
  if (settings === undefined || !isOrchestratorThread(settings, props.threadId)) return null;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            role="img"
            aria-label="Orchestrator mode"
            className="me-1.5 inline-flex shrink-0 text-info-foreground"
          />
        }
      >
        <NetworkIcon className="size-3.5" />
      </TooltipTrigger>
      <TooltipPopup side="top">
        Orchestrator mode: plans the work and hands it to workers
      </TooltipPopup>
    </Tooltip>
  );
}
