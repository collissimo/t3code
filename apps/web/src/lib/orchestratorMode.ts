import {
  isAtomCommandInterrupted,
  runAtomCommand,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  requiredScopesForServerSettingsPatch,
  type EnvironmentId,
  type ServerSettings,
  type ServerSettingsPatch,
  type ThreadId,
} from "@t3tools/contracts";
import {
  isOrchestratorThread,
  orchestratorModelSelection,
  orchestratorThreadsPatch,
  orchestratorThreadWorkerEffortPatch,
} from "@t3tools/shared/orchestratorMode";

import { toastManager } from "../components/ui/toast";
import {
  composerDraftHasUserContent,
  type DraftId,
  useComposerDraftStore,
} from "../composerDraftStore";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { environmentServerConfigsAtom, serverEnvironment } from "../state/server";
import { readEnvironmentScope } from "../state/session";

interface OrchestratorModeChange {
  readonly threadId: ThreadId;
  readonly on: boolean;
}

const readServerConfig = (environmentId: EnvironmentId) =>
  appAtomRegistry.get(environmentServerConfigsAtom).get(environmentId);

/** Saves orchestrator settings of one environment, with a toast titled `failure` when it cannot. */
async function saveOrchestratorSettings(
  environmentId: EnvironmentId,
  failure: string,
  makePatch: (settings: ServerSettings) => ServerSettingsPatch | null,
): Promise<boolean> {
  const warnNotSaved = (description: string) =>
    toastManager.add({ type: "warning", title: failure, description });
  const config = readServerConfig(environmentId);
  if (config === undefined) {
    warnNotSaved("This environment is not connected");
    return false;
  }
  // A server without the mode drops the setting silently and never orchestrates.
  if (config.environment.capabilities.orchestratorMode !== true) {
    warnNotSaved(
      `Update the server on ${config.environment.label} to a build with orchestrator mode`,
    );
    return false;
  }
  const patch = makePatch(config.settings);
  if (patch === null) return true;
  if (
    !requiredScopesForServerSettingsPatch(patch).every((scope) =>
      readEnvironmentScope(environmentId, scope),
    )
  ) {
    warnNotSaved(
      `This connection lacks permission to change settings on ${config.environment.label}`,
    );
    return false;
  }
  const result = await runAtomCommand(
    appAtomRegistry,
    serverEnvironment.updateSettings,
    { environmentId, input: { patch } },
    { label: "orchestrator mode update", reportFailure: false },
  );
  if (result._tag !== "Failure") return true;
  if (!isAtomCommandInterrupted(result)) {
    const error = squashAtomCommandFailure(result);
    warnNotSaved(error instanceof Error ? error.message : "The save failed. Try again");
  }
  return false;
}

/** Turns orchestrator mode on or off for threads of one environment. False when nothing was saved. */
const setOrchestratorMode = (
  environmentId: EnvironmentId,
  changes: ReadonlyArray<OrchestratorModeChange>,
): Promise<boolean> =>
  saveOrchestratorSettings(environmentId, "Orchestrator mode not changed", (settings) => {
    let patch: ServerSettingsPatch | null = null;
    let threads = settings.orchestratorThreads;
    for (const change of changes) {
      const next = orchestratorThreadsPatch(threads, change.threadId, change.on);
      if (next?.orchestratorThreads === undefined) continue;
      patch = next;
      threads = next.orchestratorThreads;
    }
    return patch;
  });

/** Sets the effort this orchestrator's subagents start on; null follows the default. */
export const setOrchestratorWorkerEffort = (
  environmentId: EnvironmentId,
  threadId: ThreadId,
  effort: string | null,
): Promise<boolean> =>
  saveOrchestratorSettings(environmentId, "Subagent effort not changed", (settings) =>
    orchestratorThreadWorkerEffortPatch(settings.orchestratorThreadWorkerEfforts, threadId, effort),
  );

/** A new orchestrator starts on the orchestrator model when a provider offers it. */
function applyOrchestratorModel(environmentId: EnvironmentId, draftId: DraftId) {
  const config = readServerConfig(environmentId);
  if (config === undefined) return;
  const selection = orchestratorModelSelection(config.providers, config.settings);
  if (selection === null) return;
  useComposerDraftStore.getState().setModelSelection(draftId, selection, { replaceOptions: true });
}

export async function setThreadOrchestratorMode(
  target: {
    readonly environmentId: EnvironmentId;
    readonly threadId: ThreadId;
    /** Set for a thread that was never sent: turning the mode on also picks its model. */
    readonly draftId: DraftId | null;
  },
  on: boolean,
): Promise<void> {
  const saved = await setOrchestratorMode(target.environmentId, [
    { threadId: target.threadId, on },
  ]);
  if (saved && on && target.draftId !== null) {
    applyOrchestratorModel(target.environmentId, target.draftId);
  }
}

/**
 * Picking another project on an unsent orchestrator opens that project's draft, a different
 * thread. Returns how to move the mode there, or null when the draft is no empty orchestrator.
 */
export function orchestratorDraftMove(sourceDraftId: DraftId) {
  const { getDraftSession, getComposerDraft } = useComposerDraftStore.getState();
  const source = getDraftSession(sourceDraftId);
  const settings = source === null ? undefined : readServerConfig(source.environmentId)?.settings;
  if (
    source === null ||
    settings === undefined ||
    !isOrchestratorThread(settings, source.threadId) ||
    composerDraftHasUserContent(getComposerDraft(sourceDraftId))
  ) {
    return null;
  }
  return async (
    environmentId: EnvironmentId,
    opened: { readonly draftId: DraftId; readonly threadId: ThreadId },
  ) => {
    if (opened.threadId === source.threadId) return;
    const leave = { threadId: source.threadId, on: false };
    const enter = { threadId: opened.threadId, on: true };
    const saved =
      environmentId === source.environmentId
        ? await setOrchestratorMode(environmentId, [leave, enter])
        : (await setOrchestratorMode(environmentId, [enter])) &&
          (await setOrchestratorMode(source.environmentId, [leave]));
    if (saved) applyOrchestratorModel(environmentId, opened.draftId);
  };
}
