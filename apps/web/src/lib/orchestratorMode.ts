import {
  isAtomCommandInterrupted,
  runAtomCommand,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  requiredScopesForServerSettingsPatch,
  type EnvironmentId,
  type ServerSettingsPatch,
  type ThreadId,
} from "@t3tools/contracts";
import {
  isOrchestratorThread,
  orchestratorModelSelection,
  orchestratorThreadsPatch,
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

const warnNotSaved = (description: string) =>
  toastManager.add({ type: "warning", title: "Orchestrator mode not changed", description });

/** Turns orchestrator mode on or off for threads of one environment. False when nothing was saved. */
async function setOrchestratorMode(
  environmentId: EnvironmentId,
  changes: ReadonlyArray<OrchestratorModeChange>,
): Promise<boolean> {
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
  let patch: ServerSettingsPatch | null = null;
  let threads = config.settings.orchestratorThreads;
  for (const change of changes) {
    const next = orchestratorThreadsPatch(threads, change.threadId, change.on);
    if (next?.orchestratorThreads === undefined) continue;
    patch = next;
    threads = next.orchestratorThreads;
  }
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

/** A new orchestrator starts on the orchestrator model when a provider offers it. */
function applyOrchestratorModel(environmentId: EnvironmentId, draftId: DraftId) {
  const selection = orchestratorModelSelection(readServerConfig(environmentId)?.providers ?? []);
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
