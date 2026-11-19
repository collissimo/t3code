import {
  isAtomCommandInterrupted,
  runAtomCommand,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  isManagedSettingPath,
  requiredScopesForServerSettingsPatch,
  type EnvironmentId,
  type ServerSettingsPatch,
} from "@t3tools/contracts";
import { msg } from "gt-react";

import { toastManager } from "../components/ui/toast";
import { m } from "../i18n/messages";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { useServerConfigs } from "../state/entities";
import { environmentServerConfigsAtom, serverEnvironment } from "../state/server";
import { readEnvironmentScope } from "../state/session";

const readServerConfig = (environmentId: EnvironmentId) =>
  appAtomRegistry.get(environmentServerConfigsAtom).get(environmentId);

/** Turns Self-Improvement Memory (SIM) on or off on one environment. False when nothing was saved. */
export async function setSimEnabled(
  environmentId: EnvironmentId,
  enabled: boolean,
): Promise<boolean> {
  const failureTitle = m(msg("Self-Improvement Memory not changed"));
  const warnNotSaved = (description: string) =>
    toastManager.add({ type: "warning", title: failureTitle, description });

  const config = readServerConfig(environmentId);
  if (config === undefined) {
    warnNotSaved(m(msg("This environment is not connected.")));
    return false;
  }
  if (isManagedSettingPath(config.managedPolicy, "sim.enabled")) {
    warnNotSaved(
      m(msg("Managed by {organization}.", { organization: config.managedPolicy?.organization })),
    );
    return false;
  }
  const patch: ServerSettingsPatch = { sim: { enabled } };
  if (
    !requiredScopesForServerSettingsPatch(patch).every((scope) =>
      readEnvironmentScope(environmentId, scope),
    )
  ) {
    warnNotSaved(
      m(
        msg("This connection lacks permission to change settings on {environment}.", {
          environment: config.environment.label,
        }),
      ),
    );
    return false;
  }
  const result = await runAtomCommand(
    appAtomRegistry,
    serverEnvironment.updateSettings,
    { environmentId, input: { patch } },
    { label: "sim toggle update", reportFailure: false },
  );
  if (result._tag === "Failure") {
    if (!isAtomCommandInterrupted(result)) {
      const error = squashAtomCommandFailure(result);
      warnNotSaved(error instanceof Error ? error.message : m(msg("The save failed. Try again.")));
    }
    return false;
  }
  if (result.value.sim.enabled !== enabled) {
    warnNotSaved(
      m(
        msg("This environment does not support this setting. Update T3 Code on {environment}.", {
          environment: config.environment.label,
        }),
      ),
    );
    return false;
  }
  toastManager.add({
    type: "success",
    title: enabled
      ? m(msg("Self-Improvement Memory turned on"))
      : m(msg("Self-Improvement Memory turned off")),
  });
  return true;
}

/** Toggle state and handler for Self-Improvement Memory (SIM) on one environment. */
export function useSimEnabledToggle(environmentId: EnvironmentId | null) {
  const serverConfigs = useServerConfigs();
  const config = environmentId === null ? undefined : serverConfigs.get(environmentId);
  const available = environmentId !== null && config !== undefined;
  const enabled = config?.settings.sim.enabled ?? true;
  const environmentLabel = config?.environment.label ?? null;

  const toggle = async () => {
    if (environmentId === null) return;
    await setSimEnabled(environmentId, !enabled);
  };

  return { available, enabled, environmentLabel, toggle };
}
