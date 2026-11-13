import {
  DEFAULT_SERVER_SETTINGS,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  orchestratorModelSelection,
  orchestratorThreadWorkerEffortPatch,
  orchestratorWorkerModelSelection,
} from "./orchestratorMode.ts";
import { applyServerSettingsPatch } from "./serverSettings.ts";

const projectId = ProjectId.make("project-a");

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

  it("starts workers on the worker effort, this chat's own first, when their model offers it", () => {
    const lead = ThreadId.make("lead");
    const effort = (id: string) => ({ id, label: id });
    const providers = [
      {
        instanceId: defaultModelSelection.instanceId,
        driver: ProviderDriverKind.make("claudeAgent"),
        enabled: true,
        installed: true,
        models: ["claude-opus-5-5", "claude-fable-5-2"].map((slug) => ({
          slug,
          name: slug,
          isCustom: false,
          capabilities: {
            optionDescriptors: [
              {
                id: "effort",
                label: "Effort",
                type: "select" as const,
                options: [effort("low"), effort("high")],
              },
            ],
          },
        })),
      },
    ];
    const withDefault = { ...settings, orchestratorWorkerEffort: "low" };
    const worker = (current: typeof settings, thread = { id: lead, projectId }) =>
      orchestratorWorkerModelSelection(current, thread, providers);

    expect(worker(withDefault)).toEqual({
      ...defaultModelSelection,
      options: [{ id: "effort", value: "low" }],
    });
    expect(
      worker({
        ...withDefault,
        ...orchestratorThreadWorkerEffortPatch([], lead, "high"),
      } as typeof settings),
    ).toEqual({ ...defaultModelSelection, options: [{ id: "effort", value: "high" }] });
    // An effort the model does not offer must not reach the provider.
    expect(worker({ ...settings, orchestratorWorkerEffort: "max" })).toEqual(defaultModelSelection);
    // Without a default model the worker keeps the orchestrator's model and only the effort changes.
    const own = {
      instanceId: defaultModelSelection.instanceId,
      model: "claude-fable-5-2",
      options: [{ id: "effort", value: "high" }],
    };
    expect(
      orchestratorWorkerModelSelection(
        { ...withDefault, defaultModelSelection: null },
        { id: lead, projectId, modelSelection: own },
        providers,
      ),
    ).toEqual({ ...own, options: [{ id: "effort", value: "low" }] });
    expect(orchestratorModelSelection(providers, { orchestratorEffort: "low" })).toEqual({
      instanceId: defaultModelSelection.instanceId,
      model: "claude-fable-5-2",
      options: [{ id: "effort", value: "low" }],
    });
  });
});
