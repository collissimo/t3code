import type { ProviderOptionChoice, ServerProvider } from "@t3tools/contracts";
import {
  orchestratorEffortChoices,
  orchestratorWorkerEffortChoices,
} from "@t3tools/shared/orchestratorMode";

import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { SettingsRow, SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import {
  useScopedSettings,
  useScopedSettingsMixed,
  useUpdateScopedSettings,
} from "./useScopedSettings";

const MODEL_DEFAULT = "model-default";

function EffortSelect(props: {
  label: string;
  value: string | null;
  mixed: boolean;
  choices: ReadonlyArray<ProviderOptionChoice>;
  onChange: (effort: string | null) => void;
}) {
  const labelOf = (value: string | null) =>
    value === null
      ? "Mixed"
      : value === MODEL_DEFAULT
        ? "Model default"
        : (props.choices.find((choice) => choice.id === value)?.label ?? value);
  return (
    <Select
      value={props.mixed ? null : (props.value ?? MODEL_DEFAULT)}
      onValueChange={(value) => {
        if (value !== null) props.onChange(value === MODEL_DEFAULT ? null : value);
      }}
    >
      <SelectTrigger size="sm" aria-label={props.label}>
        <SelectValue>{labelOf}</SelectValue>
      </SelectTrigger>
      <SelectPopup align="end" alignItemWithTrigger={false}>
        <SelectItem value={MODEL_DEFAULT}>Model default</SelectItem>
        {props.choices.map((choice) => (
          <SelectItem key={choice.id} value={choice.id}>
            {choice.label}
          </SelectItem>
        ))}
      </SelectPopup>
    </Select>
  );
}

/** The efforts new orchestrators and their subagents start on. */
export function OrchestratorSettings({ providers }: { providers: ReadonlyArray<ServerProvider> }) {
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const mixedEffort = useScopedSettingsMixed(["orchestratorEffort"]);
  const mixedWorkerEffort = useScopedSettingsMixed(["orchestratorWorkerEffort"]);
  return (
    <SettingsSection id="orchestrator" title="Orchestrator">
      <SettingsRow
        serverScoped
        settingKeys={["orchestratorEffort"]}
        mixed={mixedEffort}
        {...searchableSetting("orchestrator-effort")}
        description="New orchestrators start on this effort. Change a running one in its composer."
        control={
          <EffortSelect
            label="Orchestrator effort"
            value={settings.orchestratorEffort}
            mixed={mixedEffort}
            choices={orchestratorEffortChoices(providers)}
            onChange={(effort) => updateSettings({ orchestratorEffort: effort })}
          />
        }
      />
      <SettingsRow
        serverScoped
        settingKeys={["orchestratorWorkerEffort"]}
        mixed={mixedWorkerEffort}
        {...searchableSetting("orchestrator-subagent-effort")}
        description="Subagents an orchestrator starts use this effort when their model offers it. Each orchestrator chat can set its own from the icon beside its title."
        control={
          <EffortSelect
            label="Subagent effort"
            value={settings.orchestratorWorkerEffort}
            mixed={mixedWorkerEffort}
            choices={orchestratorWorkerEffortChoices(settings, providers, { projectId: null })}
            onChange={(effort) => updateSettings({ orchestratorWorkerEffort: effort })}
          />
        }
      />
    </SettingsSection>
  );
}
