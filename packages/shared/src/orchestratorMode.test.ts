import {
  DEFAULT_SERVER_SETTINGS,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { orchestratorWorkerModelSelection, projectOrchestratorThread } from "./orchestratorMode.ts";
import { applyServerSettingsPatch } from "./serverSettings.ts";

const projectId = ProjectId.make("project-a");
const thread = (id: string, overrides: { projectId?: ProjectId; archivedAt?: string } = {}) => ({
  id: ThreadId.make(id),
  projectId: overrides.projectId ?? projectId,
  archivedAt: overrides.archivedAt ?? null,
  deletedAt: null,
});

describe("projectOrchestratorThread", () => {
  it("picks the project's listed thread that entered orchestrator mode last", () => {
    const threads = [
      thread("first"),
      thread("second"),
      thread("archived", { archivedAt: "2026-01-01T00:00:00Z" }),
      thread("elsewhere", { projectId: ProjectId.make("project-b") }),
      thread("ordinary"),
    ];
    const orchestratorThreads = ["first", "second", "archived", "elsewhere", "never-sent"].map(
      (id) => ThreadId.make(id),
    );
    expect(projectOrchestratorThread({ orchestratorThreads }, projectId, threads)?.id).toBe(
      "second",
    );
    expect(projectOrchestratorThread({ orchestratorThreads: [] }, projectId, threads)).toBeNull();
  });
});

describe("orchestratorWorkerModelSelection", () => {
  const defaultModelSelection = {
    instanceId: ProviderInstanceId.make("claudeAgent"),
    model: "claude-opus-5-5",
  };
  const projectDefault = { ...defaultModelSelection, model: "claude-sonnet-5-5" };
  const settings = applyServerSettingsPatch(DEFAULT_SERVER_SETTINGS, {
    orchestratorThreads: [ThreadId.make("lead")],
    defaultModelSelection,
    projectSettingsOverrides: {
      [ProjectId.make("project-b")]: { defaultModelSelection: projectDefault },
    },
  });

  it("gives an orchestrator's workers the project's default model and leaves other threads alone", () => {
    const lead = ThreadId.make("lead");
    expect(orchestratorWorkerModelSelection(settings, { id: lead, projectId })).toEqual(
      defaultModelSelection,
    );
    expect(
      orchestratorWorkerModelSelection(settings, {
        id: lead,
        projectId: ProjectId.make("project-b"),
      }),
    ).toEqual(projectDefault);
    expect(
      orchestratorWorkerModelSelection(settings, { id: ThreadId.make("ordinary"), projectId }),
    ).toBeUndefined();
    expect(
      orchestratorWorkerModelSelection(
        { ...settings, defaultModelSelection: null },
        { id: lead, projectId },
      ),
    ).toBeUndefined();
  });
});
