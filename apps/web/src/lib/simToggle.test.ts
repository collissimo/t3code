import { DEFAULT_SERVER_SETTINGS, EnvironmentId, type ServerSettings } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  updateSettings: Symbol("server-update-settings"),
  runAtomCommand: vi.fn(),
  addToast: vi.fn(),
  readEnvironmentScope: vi.fn(),
  serverConfigs: new Map<
    EnvironmentId,
    {
      readonly environment: { readonly label: string };
      readonly settings: ServerSettings;
      readonly managedPolicy?: {
        readonly organization: string;
        readonly lockedSettings: ReadonlyArray<string>;
      };
    }
  >(),
}));

vi.mock("@t3tools/client-runtime/state/runtime", () => ({
  isAtomCommandInterrupted: (result: { readonly interrupted?: boolean }) =>
    result.interrupted === true,
  runAtomCommand: mocks.runAtomCommand,
  squashAtomCommandFailure: (result: { readonly error: unknown }) => result.error,
}));
vi.mock("../components/ui/toast", () => ({ toastManager: { add: mocks.addToast } }));
vi.mock("../rpc/atomRegistry", () => ({
  appAtomRegistry: {
    get: () => mocks.serverConfigs,
  },
}));
vi.mock("../state/entities", () => ({
  useServerConfigs: () => mocks.serverConfigs,
}));
vi.mock("../state/server", () => ({
  environmentServerConfigsAtom: Symbol("environment-server-configs"),
  serverEnvironment: { updateSettings: mocks.updateSettings },
}));
vi.mock("../state/session", () => ({
  readEnvironmentScope: mocks.readEnvironmentScope,
}));

import { setSimEnabled } from "./simToggle";

const ENV_ID = EnvironmentId.make("env-1");

function setup(options?: {
  readonly connected?: boolean;
  readonly canWrite?: boolean;
  readonly lockedSettings?: ReadonlyArray<string>;
  readonly simEnabled?: boolean;
}) {
  mocks.runAtomCommand.mockReset();
  mocks.addToast.mockReset();
  mocks.readEnvironmentScope.mockReset().mockReturnValue(options?.canWrite ?? true);
  mocks.serverConfigs.clear();
  if (options?.connected !== false) {
    mocks.serverConfigs.set(ENV_ID, {
      environment: { label: "Workstation" },
      settings: {
        ...DEFAULT_SERVER_SETTINGS,
        sim: { ...DEFAULT_SERVER_SETTINGS.sim, enabled: options?.simEnabled ?? true },
      },
      ...(options?.lockedSettings
        ? { managedPolicy: { organization: "Acme", lockedSettings: options.lockedSettings } }
        : {}),
    });
  }
}

describe("setSimEnabled", () => {
  it("warns and aborts when disconnected, managed, or lacking settings write scope", async () => {
    setup({ connected: false });
    expect(await setSimEnabled(ENV_ID, false)).toBe(false);
    expect(mocks.runAtomCommand).not.toHaveBeenCalled();
    expect(mocks.addToast).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "warning",
        description: "This environment is not connected.",
      }),
    );

    setup({ lockedSettings: ["sim"] });
    expect(await setSimEnabled(ENV_ID, false)).toBe(false);
    expect(mocks.runAtomCommand).not.toHaveBeenCalled();
    expect(mocks.addToast).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "warning",
        description: "Managed by Acme.",
      }),
    );

    setup({ canWrite: false });
    expect(await setSimEnabled(ENV_ID, false)).toBe(false);
    expect(mocks.runAtomCommand).not.toHaveBeenCalled();
    expect(mocks.addToast).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "warning",
        description: "This connection lacks permission to change settings on Workstation.",
      }),
    );
  });

  it("saves the patch and confirms turning SIM off and back on", async () => {
    setup({ simEnabled: true });
    mocks.runAtomCommand.mockResolvedValueOnce({
      _tag: "Success",
      value: {
        ...DEFAULT_SERVER_SETTINGS,
        sim: { ...DEFAULT_SERVER_SETTINGS.sim, enabled: false },
      },
    });
    expect(await setSimEnabled(ENV_ID, false)).toBe(true);
    expect(mocks.runAtomCommand).toHaveBeenCalledWith(
      expect.anything(),
      mocks.updateSettings,
      { environmentId: ENV_ID, input: { patch: { sim: { enabled: false } } } },
      { label: "sim toggle update", reportFailure: false },
    );
    expect(mocks.addToast).toHaveBeenCalledWith({
      type: "success",
      title: "Self-Improvement Memory turned off",
    });

    setup({ simEnabled: false });
    mocks.runAtomCommand.mockResolvedValueOnce({
      _tag: "Success",
      value: {
        ...DEFAULT_SERVER_SETTINGS,
        sim: { ...DEFAULT_SERVER_SETTINGS.sim, enabled: true },
      },
    });
    expect(await setSimEnabled(ENV_ID, true)).toBe(true);
    expect(mocks.addToast).toHaveBeenCalledWith({
      type: "success",
      title: "Self-Improvement Memory turned on",
    });
  });

  it("warns when an older server drops sim or when the RPC fails", async () => {
    setup({ simEnabled: true });
    mocks.runAtomCommand.mockResolvedValueOnce({
      _tag: "Success",
      value: {
        ...DEFAULT_SERVER_SETTINGS,
        sim: { ...DEFAULT_SERVER_SETTINGS.sim, enabled: true },
      },
    });
    expect(await setSimEnabled(ENV_ID, false)).toBe(false);
    expect(mocks.addToast).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "warning",
        description:
          "This environment does not support this setting. Update T3 Code on Workstation.",
      }),
    );

    setup({ simEnabled: true });
    mocks.runAtomCommand.mockResolvedValueOnce({
      _tag: "Failure",
      error: new Error("socket closed"),
    });
    expect(await setSimEnabled(ENV_ID, false)).toBe(false);
    expect(mocks.addToast).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "warning",
        description: "socket closed",
      }),
    );
  });
});
