import type {
  ModelSelection,
  ProjectId,
  ProviderOptionChoice,
  ServerProvider,
  ServerSettings,
  SelectProviderOptionDescriptor,
  ServerSettingsPatch,
  ThreadId,
} from "@t3tools/contracts";

import { REASONING_EFFORT_OPTION_IDS, resolveSelectableModel } from "./model.ts";
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

type Providers = ReadonlyArray<
  Pick<ServerProvider, "instanceId" | "driver" | "enabled" | "installed" | "models">
>;

/** The reasoning control of a model, or undefined when the model has none or is unknown. */
function reasoningEffortDescriptor(
  providers: Providers,
  selection: Pick<ModelSelection, "instanceId" | "model">,
): SelectProviderOptionDescriptor | undefined {
  const provider = providers.find((candidate) => candidate.instanceId === selection.instanceId);
  // A stored selection may name the model by alias or display name.
  const slug =
    provider && resolveSelectableModel(provider.driver, selection.model, provider.models);
  const selects = (
    provider?.models.find((model) => model.slug === slug)?.capabilities?.optionDescriptors ?? []
  ).flatMap((descriptor) => (descriptor.type === "select" ? [descriptor] : []));
  return (
    selects.find((descriptor) => descriptor.role === "reasoning") ??
    REASONING_EFFORT_OPTION_IDS.flatMap((id) =>
      selects.filter((descriptor) => descriptor.id === id),
    )[0]
  );
}

/** The efforts a model can be started on; prompt-injected ones such as ultrathink are per message. */
function reasoningEffortChoices(
  providers: Providers,
  selection: Pick<ModelSelection, "instanceId" | "model">,
): ReadonlyArray<ProviderOptionChoice> {
  const descriptor = reasoningEffortDescriptor(providers, selection);
  return (
    descriptor?.options.filter(
      (option) => descriptor.promptInjectedValues?.includes(option.id) !== true,
    ) ?? []
  );
}

/** `selection` on `effort`; unchanged when `effort` is null or its model does not offer it. */
function withReasoningEffort(
  providers: Providers,
  selection: ModelSelection,
  effort: string | null,
): ModelSelection {
  if (effort === null) return selection;
  const descriptor = reasoningEffortDescriptor(providers, selection);
  if (
    descriptor === undefined ||
    !reasoningEffortChoices(providers, selection).some((option) => option.id === effort)
  ) {
    return selection;
  }
  return {
    ...selection,
    options: [
      ...(selection.options ?? []).filter((option) => option.id !== descriptor.id),
      { id: descriptor.id, value: effort },
    ],
  };
}

/** The effort an orchestrator's workers start on: this chat's own, else the default, else null. */
function orchestratorWorkerEffort(
  settings: Pick<ServerSettings, "orchestratorWorkerEffort" | "orchestratorThreadWorkerEfforts">,
  threadId: ThreadId,
): string | null {
  return (
    settings.orchestratorThreadWorkerEfforts.find((entry) => entry.threadId === threadId)?.effort ??
    settings.orchestratorWorkerEffort
  );
}

/**
 * What an orchestrator's workers start on: the project's default model, else the orchestrator's
 * own, on the worker effort when `providers` shows the model offers it. Undefined when the thread
 * is no orchestrator or nothing differs from its own selection, so a worker inherits that.
 */
export function orchestratorWorkerModelSelection(
  settings: ServerSettings,
  thread:
    | {
        readonly id: ThreadId;
        readonly projectId: ProjectId | null;
        readonly modelSelection?: ModelSelection;
      }
    | undefined,
  providers: Providers = [],
): ModelSelection | undefined {
  if (thread === undefined || !isOrchestratorThread(settings, thread.id)) return undefined;
  const projectDefault =
    resolveProjectSettings(settings, thread.projectId).settings.defaultModelSelection ?? undefined;
  const base = projectDefault ?? thread.modelSelection;
  if (base === undefined) return undefined;
  const selection = withReasoningEffort(
    providers,
    base,
    orchestratorWorkerEffort(settings, thread.id),
  );
  return projectDefault === undefined && selection === base ? undefined : selection;
}

/** The selection a new orchestrator starts on, or null to keep the new thread's usual model. */
export function orchestratorModelSelection(
  providers: Providers,
  settings: Pick<ServerSettings, "orchestratorEffort">,
): ModelSelection | null {
  const provider = providers.find(
    (candidate) =>
      candidate.enabled &&
      candidate.installed &&
      candidate.models.some((model) => model.slug === ORCHESTRATOR_MODEL),
  );
  return provider
    ? withReasoningEffort(
        providers,
        { instanceId: provider.instanceId, model: ORCHESTRATOR_MODEL },
        settings.orchestratorEffort,
      )
    : null;
}

/** The efforts a new orchestrator can start on: those of the orchestrator model. */
export function orchestratorEffortChoices(
  providers: Providers,
): ReadonlyArray<ProviderOptionChoice> {
  const selection = orchestratorModelSelection(providers, { orchestratorEffort: null });
  return selection === null ? [] : reasoningEffortChoices(providers, selection);
}

/** The efforts workers can start on: those of the model they start on, else of the orchestrator model. */
export function orchestratorWorkerEffortChoices(
  settings: ServerSettings,
  providers: Providers,
  orchestrator: { readonly projectId: ProjectId | null; readonly modelSelection?: ModelSelection },
): ReadonlyArray<ProviderOptionChoice> {
  const selection =
    resolveProjectSettings(settings, orchestrator.projectId).settings.defaultModelSelection ??
    orchestrator.modelSelection;
  const choices = selection ? reasoningEffortChoices(providers, selection) : [];
  // An unsent draft can still name a model its provider no longer lists.
  return choices.length > 0 ? choices : orchestratorEffortChoices(providers);
}

/** The patch that sets the effort this orchestrator's workers start on; null follows the default. */
export function orchestratorThreadWorkerEffortPatch(
  current: ServerSettings["orchestratorThreadWorkerEfforts"],
  threadId: ThreadId,
  effort: string | null,
): ServerSettingsPatch {
  const others = current.filter((entry) => entry.threadId !== threadId);
  return {
    orchestratorThreadWorkerEfforts: (effort === null
      ? others
      : [...others, { threadId, effort }]
    ).slice(-MAX_ORCHESTRATOR_THREADS),
  };
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
