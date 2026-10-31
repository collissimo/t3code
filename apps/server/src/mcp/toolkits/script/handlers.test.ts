import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { EnvironmentId, ProviderInstanceId, type RuntimeMode, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { McpSchema, McpServer, Tool, Toolkit } from "effect/ai";

import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../../../project/ProjectService.ts";
import * as ServerSettings from "../../../serverSettings.ts";
import * as McpHttpServer from "../../McpHttpServer.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { liveThreadShell } from "../../McpToolAccess.testkit.ts";
import { ScriptToolkit } from "./tools.ts";

const threadId = ThreadId.make("thread-script-test");
const invocation = (capabilities: ReadonlyArray<McpInvocationContext.McpCapability>) => ({
  environmentId: EnvironmentId.make("environment-script-test"),
  requestNamespace: "script-test",
  thread: {
    threadId,
    providerSessionId: "script-test",
    providerInstanceId: ProviderInstanceId.make("codex"),
  },
  client: undefined,
  capabilities: new Set(capabilities),
  issuedAt: 1,
});
const client = McpSchema.McpServerClient.of({
  clientId: 1,
  clientCapabilities: {},
  clientInfo: { name: "script-test", version: "1.0.0" },
  protocolVersion: "2025-06-18",
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "script-test", version: "1.0.0" },
  },
  getClient: Effect.die("unused"),
});

const PingToolkit = Toolkit.make(
  Tool.make("t3_ping", {
    parameters: Schema.Struct({ value: Schema.String }),
    success: Schema.Struct({ pong: Schema.String }),
  }),
);

const harness = (input: {
  readonly cwd: string;
  readonly enabled: boolean;
  readonly runtimeMode?: RuntimeMode;
}) =>
  Layer.mergeAll(
    McpHttpServer.layerScriptToolkit,
    McpHttpServer.toolkitRegistration(
      PingToolkit,
      McpToolAccess.toLayer(PingToolkit, {
        t3_ping: McpToolAccess.reads(({ value }) => Effect.succeed({ pong: value })),
      }),
    ),
  ).pipe(
    Layer.provideMerge(McpServer.McpServer.layer),
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          getThreadShell: (id) =>
            Effect.succeed({
              ...liveThreadShell(id, { runtimeMode: input.runtimeMode ?? "full-access" }),
              worktreePath: input.cwd,
            }),
        }),
        Layer.mock(ProjectService.ProjectService)({ getById: () => Effect.succeedNone }),
        ServerSettings.layerTest({ scriptToolEnabled: input.enabled }),
      ),
    ),
    Layer.provideMerge(NodeServices.layer),
  );

const runScript = (code: string) =>
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    return yield* server
      .callTool({ name: "script", arguments: { code } })
      .pipe(
        Effect.provideService(McpInvocationContext.McpInvocationContext, invocation(["script"])),
        Effect.provideService(McpSchema.McpServerClient, client),
      );
  });

const inTemp = <A, E, R>(
  run: (cwd: string, path: Path.Path, fs: FileSystem.FileSystem) => Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "t3-script-test-" });
    return yield* run(cwd, path, fs);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));

it.live("runs read, write, exec, grep, and T3 tools, and returns only what it prints", () =>
  inTemp((cwd, path, fs) =>
    Effect.gen(function* () {
      yield* fs.writeFileString(path.join(cwd, "a.txt"), "first\nneedle here\n");
      const result = yield* runScript(`
        await tools.exec("git init -q");
        const read = await tools.read("a.txt");
        await tools.write({ path: "nested/b.txt", content: read.toUpperCase() });
        const echoed = await tools.exec("echo hello");
        const found = await tools.grep("needle");
        const ping = await tools.t3_ping({ value: "x" });
        const failed = await Promise.allSettled([tools.read("missing.txt")]);
        let nested = "none";
        try { await tools.script({ code: "" }); } catch (error) { nested = error.message; }
        text(echoed.stdout.trim(), echoed.exitCode, found.matches, ping.pong, failed[0].status, nested);
      `).pipe(Effect.provide(harness({ cwd, enabled: true })));

      expect(result.isError).toBe(false);
      const body = result.structuredContent as {
        readonly status: string;
        readonly output: string;
        readonly toolCalls: number;
        readonly failedToolCalls: number;
      };
      expect(body.status).toBe("completed");
      expect(body.output).toContain("hello 0");
      expect(body.output).toContain('"path": "a.txt"');
      expect(body.output).toContain('"line": 2');
      expect(body.output).toContain("x rejected A script cannot start another script.");
      expect(body.toolCalls).toBe(8);
      expect(body.failedToolCalls).toBe(2);
      expect(yield* fs.readFileString(path.join(cwd, "nested/b.txt"))).toBe("FIRST\nNEEDLE HERE\n");
    }),
  ),
);

it.live.each([
  { name: "the switch is off", enabled: false, runtimeMode: "full-access", message: "is off" },
  {
    name: "the thread is not full access",
    enabled: true,
    runtimeMode: "approval-required",
    message: "full-access thread",
  },
] as const)("refuses to start while $name", ({ enabled, runtimeMode, message }) =>
  inTemp((cwd, path, fs) =>
    Effect.gen(function* () {
      const result = yield* runScript(`await tools.write({ path: "x.txt", content: "x" });`).pipe(
        Effect.provide(harness({ cwd, enabled, runtimeMode })),
      );
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result.content)).toContain(message);
      expect(yield* fs.exists(path.join(cwd, "x.txt"))).toBe(false);
    }),
  ),
);

it.effect("lists the tool only to credentials holding the script capability", () =>
  Effect.gen(function* () {
    const script = ScriptToolkit.tools.script;
    const enabledWhen = yield* Effect.succeed(
      script.annotations.mapUnsafe.get(McpSchema.EnabledWhen.key) as () => boolean,
    );
    const visibleTo = (capabilities: ReadonlyArray<McpInvocationContext.McpCapability>) =>
      Effect.sync(enabledWhen).pipe(
        Effect.provideService(McpInvocationContext.McpInvocationContext, invocation(capabilities)),
      );
    expect(yield* visibleTo(["script"])).toBe(true);
    expect(yield* visibleTo([])).toBe(false);
  }),
);
