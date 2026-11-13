import type { EnvironmentId, ModelSelection, ProjectId, ThreadId } from "@t3tools/contracts";
import {
  isOrchestratorThread,
  orchestratorWorkerEffortChoices,
} from "@t3tools/shared/orchestratorMode";
import { NetworkIcon } from "lucide-react";

import { setOrchestratorWorkerEffort } from "../../lib/orchestratorMode";
import { useServerConfigs } from "../../state/entities";
import { useEnvironmentProviders } from "../../state/environments";
import {
  Menu,
  MenuGroup,
  MenuGroupLabel,
  MenuItemDetail,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuTrigger,
} from "../ui/menu";

const DEFAULT_EFFORT = "default";

/** Marks a thread whose agent runs in orchestrator mode, and sets the effort its subagents start on. */
export function OrchestratorBadge(props: {
  environmentId: EnvironmentId;
  threadId: ThreadId;
  projectId: ProjectId | null;
  modelSelection: ModelSelection | undefined;
}) {
  const config = useServerConfigs().get(props.environmentId);
  const providers = useEnvironmentProviders().get(props.environmentId) ?? [];
  if (config === undefined || !isOrchestratorThread(config.settings, props.threadId)) return null;
  const { settings } = config;
  const choices = orchestratorWorkerEffortChoices(settings, providers, {
    projectId: props.projectId,
    ...(props.modelSelection ? { modelSelection: props.modelSelection } : {}),
  });
  const labelOf = (effort: string | null) =>
    choices.find((choice) => choice.id === effort)?.label ?? "Model default";
  const own =
    settings.orchestratorThreadWorkerEfforts.find((entry) => entry.threadId === props.threadId)
      ?.effort ?? null;
  return (
    <Menu>
      <MenuTrigger
        render={
          <button
            type="button"
            aria-label="Orchestrator mode: subagent effort"
            className="me-1 inline-flex shrink-0 cursor-pointer rounded-full p-0.5 text-info-foreground outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset data-popup-open:bg-accent"
          />
        }
      >
        <NetworkIcon className="size-3.5" />
      </MenuTrigger>
      <MenuPopup align="start">
        <MenuGroup>
          <MenuGroupLabel>Subagent effort in this chat</MenuGroupLabel>
          <MenuRadioGroup
            value={own ?? DEFAULT_EFFORT}
            onValueChange={(value: string) =>
              void setOrchestratorWorkerEffort(
                props.environmentId,
                props.threadId,
                value === DEFAULT_EFFORT ? null : value,
              )
            }
          >
            <MenuRadioItem value={DEFAULT_EFFORT} closeOnClick>
              <span className="flex items-center">
                Default
                <MenuItemDetail>{labelOf(settings.orchestratorWorkerEffort)}</MenuItemDetail>
              </span>
            </MenuRadioItem>
            {choices.map((choice) => (
              <MenuRadioItem key={choice.id} value={choice.id} closeOnClick>
                {choice.label}
              </MenuRadioItem>
            ))}
          </MenuRadioGroup>
        </MenuGroup>
      </MenuPopup>
    </Menu>
  );
}
