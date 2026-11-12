import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  threadRuntimeIsActive,
  type EnvironmentProject,
  type EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/shell";
import {
  DEFAULT_SERVER_SETTINGS,
  type EnvironmentId,
  type ModelSelection,
  type ServerProvider,
} from "@t3tools/contracts";
import {
  orchestratorModelSelection,
  orchestratorThreadsPatch,
  projectOrchestratorThread,
} from "@t3tools/shared/orchestratorMode";
import { useNavigate } from "@tanstack/react-router";
import { EllipsisIcon } from "lucide-react";

import { useComposerDraftStore } from "../../composerDraftStore";
import { isElectron } from "../../env";
import { useNewThreadHandler } from "../../hooks/useHandleNewThread";
import { useUpdateEnvironmentSettings } from "../../hooks/useSettings";
import { workspaceAreaProps } from "../../lib/workspaceFocus";
import { useProjects, useQuietThreadShells, useServerConfigs } from "../../state/entities";
import {
  useEnvironmentIdentities,
  useEnvironmentProviders,
  usePrimaryEnvironmentId,
} from "../../state/environments";
import { buildThreadRouteParams } from "../../threadRoutes";
import { getTriggerDisplayModelName } from "../chat/providerIconUtils";
import { ProjectFavicon } from "../ProjectFavicon";
import { sortScopedProjectsForSidebar } from "../Sidebar.logic";
import { ThreadRowLeadingStatus } from "../ThreadStatusIndicators";
import { Button } from "../ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "../ui/empty";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { SidebarInset } from "../ui/sidebar";
import { WorkspaceBreadcrumb, WorkspaceBreadcrumbItem } from "../WorkspaceBreadcrumb";
import { WorkspacePageContainer } from "../WorkspacePageContainer";
import { WorkspacePageHeader } from "../WorkspacePageHeader";

const NO_PROVIDERS: ReadonlyArray<ServerProvider> = [];

function modelLabel(
  providers: ReadonlyArray<ServerProvider>,
  selection: ModelSelection | null,
): string | null {
  if (selection === null) return null;
  const provider = providers.find((candidate) => candidate.instanceId === selection.instanceId);
  const model = provider?.models.find((candidate) => candidate.slug === selection.model);
  return model ? getTriggerDisplayModelName(model, provider?.driver) : selection.model;
}

function OrchestratorModels({ environmentId }: { environmentId: EnvironmentId | null }) {
  const serverConfigs = useServerConfigs();
  const providersByEnvironment = useEnvironmentProviders();
  const settings =
    (environmentId === null ? undefined : serverConfigs.get(environmentId)?.settings) ??
    DEFAULT_SERVER_SETTINGS;
  const providers =
    (environmentId === null ? undefined : providersByEnvironment.get(environmentId)) ??
    NO_PROVIDERS;
  const orchestrator = modelLabel(providers, orchestratorModelSelection(providers));
  const worker = modelLabel(providers, settings.defaultModelSelection);
  return (
    <dl className="flex flex-wrap gap-x-8 gap-y-1 text-sm">
      <div className="flex gap-2">
        <dt className="text-muted-foreground">Orchestrator</dt>
        <dd>{orchestrator ?? "The new thread's model"}</dd>
      </div>
      <div className="flex gap-2">
        <dt className="text-muted-foreground">Workers</dt>
        <dd>{worker ?? "The orchestrator's model"}</dd>
      </div>
    </dl>
  );
}

function OrchestratorProjectRow({
  project,
  environmentLabel,
  orchestrator,
  runningWorkers,
}: {
  project: EnvironmentProject;
  environmentLabel: string | null;
  orchestrator: EnvironmentThreadShell | null;
  runningWorkers: number;
}) {
  const navigate = useNavigate();
  const handleNewThread = useNewThreadHandler();
  const serverConfigs = useServerConfigs();
  const providersByEnvironment = useEnvironmentProviders();
  const updateSettings = useUpdateEnvironmentSettings(project.environmentId);
  const orchestratorThreads =
    serverConfigs.get(project.environmentId)?.settings.orchestratorThreads ?? [];

  const start = async () => {
    const opened = await handleNewThread(scopeProjectRef(project.environmentId, project.id));
    if (opened === null) return;
    const selection = orchestratorModelSelection(
      providersByEnvironment.get(project.environmentId) ?? NO_PROVIDERS,
    );
    if (selection !== null) {
      useComposerDraftStore
        .getState()
        .setModelSelection(opened.draftId, selection, { replaceOptions: true });
    }
    // The thread id is listed before the first message, so its first turn already orchestrates.
    const patch = orchestratorThreadsPatch(orchestratorThreads, opened.threadId, true);
    if (patch !== null) updateSettings(patch);
  };
  const open = () => {
    if (orchestrator === null) {
      void start();
      return;
    }
    void navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(scopeThreadRef(project.environmentId, orchestrator.id)),
    });
  };
  const leave = () => {
    if (orchestrator === null) return;
    const patch = orchestratorThreadsPatch(orchestratorThreads, orchestrator.id, false);
    if (patch !== null) updateSettings(patch);
  };

  return (
    <li className="flex items-center gap-1 border-b border-border/60 last:border-b-0">
      <button
        type="button"
        onClick={open}
        className="flex min-w-0 flex-1 cursor-pointer items-center gap-3 px-2 py-3 text-left outline-hidden hover:bg-accent/50 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
      >
        <ProjectFavicon project={project} className="size-5 shrink-0" />
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="flex min-w-0 items-baseline gap-2">
            <span className="truncate text-sm font-medium">{project.title}</span>
            {environmentLabel === null ? null : (
              <span className="shrink-0 text-xs text-muted-foreground">{environmentLabel}</span>
            )}
          </span>
          <span className="truncate text-xs text-muted-foreground">
            {orchestrator === null ? "No orchestrator yet" : orchestrator.title}
          </span>
        </span>
        {orchestrator === null ? (
          <span className="shrink-0 text-xs font-medium text-foreground">Start</span>
        ) : (
          <span className="flex shrink-0 items-center gap-3 text-xs text-muted-foreground">
            {runningWorkers > 0 ? (
              <span>
                {runningWorkers} {runningWorkers === 1 ? "worker" : "workers"} running
              </span>
            ) : null}
            <ThreadRowLeadingStatus thread={orchestrator} />
          </span>
        )}
      </button>
      {orchestrator === null ? null : (
        <Menu>
          <MenuTrigger
            render={
              <Button
                aria-label={`Orchestrator options for ${project.title}`}
                size="icon-xs"
                variant="ghost-muted"
              />
            }
          >
            <EllipsisIcon />
          </MenuTrigger>
          <MenuPopup align="end">
            <MenuItem onClick={() => void start()}>Start a new orchestrator</MenuItem>
            <MenuItem onClick={leave}>Turn off orchestrator mode</MenuItem>
          </MenuPopup>
        </Menu>
      )}
    </li>
  );
}

export function OrchestratorPage() {
  const projects = useProjects();
  const threads = useQuietThreadShells();
  const serverConfigs = useServerConfigs();
  const environments = useEnvironmentIdentities();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const contentArea = workspaceAreaProps("orchestrator", 1, "Orchestrator");

  const listedProjects = sortScopedProjectsForSidebar(
    projects.filter((project) => project.archivedAt == null && project.isScratch !== true),
    threads,
    "updated_at",
  );
  const spansEnvironments =
    new Set(listedProjects.map((project) => project.environmentId)).size > 1;
  const environmentLabels = new Map(
    environments.map((environment) => [environment.environmentId, environment.label] as const),
  );
  const threadsByEnvironment = new Map<EnvironmentId, Array<EnvironmentThreadShell>>();
  for (const thread of threads) {
    const environmentThreads = threadsByEnvironment.get(thread.environmentId);
    if (environmentThreads === undefined) threadsByEnvironment.set(thread.environmentId, [thread]);
    else environmentThreads.push(thread);
  }

  return (
    <SidebarInset
      {...contentArea}
      role="main"
      className="h-dvh min-h-0 overflow-hidden overscroll-y-none"
    >
      <WorkspacePageHeader electron={isElectron} className="bg-background">
        <WorkspaceBreadcrumb ariaLabel="Orchestrator breadcrumb">
          <WorkspaceBreadcrumbItem current>
            <h1 className="truncate">Orchestrator</h1>
          </WorkspaceBreadcrumbItem>
        </WorkspaceBreadcrumb>
      </WorkspacePageHeader>
      {listedProjects.length === 0 ? (
        <Empty className="flex-1">
          <EmptyHeader className="max-w-md">
            <EmptyTitle>No projects yet</EmptyTitle>
            <EmptyDescription>
              Add a project in the sidebar to start its orchestrator
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <div className="topbar-scroll-fade scrollbar-gutter-both min-h-0 flex-1 overflow-y-auto">
          <WorkspacePageContainer>
            <div className="flex flex-col gap-3">
              <p className="max-w-prose text-sm text-muted-foreground">
                A project's orchestrator plans the work, hands it to workers and checks what comes
                back before it reports to you.
              </p>
              <OrchestratorModels
                environmentId={primaryEnvironmentId ?? listedProjects[0]?.environmentId ?? null}
              />
            </div>
            <ul className="flex flex-col border-y border-border/60">
              {listedProjects.map((project) => {
                const settings = serverConfigs.get(project.environmentId)?.settings;
                const environmentThreads = threadsByEnvironment.get(project.environmentId) ?? [];
                const orchestrator =
                  settings === undefined
                    ? null
                    : projectOrchestratorThread(settings, project.id, environmentThreads);
                const runningWorkers =
                  orchestrator === null
                    ? 0
                    : environmentThreads.filter(
                        (thread) =>
                          thread.lineage.parentThreadId === orchestrator.id &&
                          threadRuntimeIsActive(thread.runtime),
                      ).length;
                return (
                  <OrchestratorProjectRow
                    key={`${project.environmentId}:${project.id}`}
                    project={project}
                    environmentLabel={
                      spansEnvironments
                        ? (environmentLabels.get(project.environmentId) ?? null)
                        : null
                    }
                    orchestrator={orchestrator}
                    runningWorkers={runningWorkers}
                  />
                );
              })}
            </ul>
          </WorkspacePageContainer>
        </div>
      )}
    </SidebarInset>
  );
}
