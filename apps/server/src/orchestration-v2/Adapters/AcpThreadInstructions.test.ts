import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ThreadId,
} from "@t3tools/contracts";
import * as AcpSessionRuntime from "@t3tools/provider-acp/server/AcpSessionRuntime";
import { AcpProviderCapabilitiesV2, makeAcpAdapterV2 } from "@t3tools/provider-acp/server/adapter";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as TestProviderHost from "@t3tools/provider-testing/TestProviderHost";
import { resolveSelfInvocation } from "@t3tools/shared/nodeRuntime";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as DocumentText from "../../provider/DocumentText.ts";
import { makeTurnInput } from "./AcpAdapterV2.testkit.ts";

const platform = Layer.mergeAll(NodeServices.layer, NodeCrypto.layer);
const layerTest = Layer.mergeAll(
  DocumentText.layer.pipe(Layer.provide(platform)),
  platform,
  IdAllocator.layer,
  McpProviderSessions.layer,
  TestProviderHost.layer().pipe(Layer.provide(platform)),
);

it.live("ACP delivers thread instructions on the first turn and again only when they change", () =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const mockAgentPath = yield* path.fromFileUrl(
      new URL("../../../scripts/acp-mock-agent.ts", import.meta.url),
    );
    const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const promptTexts: Array<string> = [];
    const instanceId = ProviderInstanceId.make("acp-test-thread-instructions");
    const threadId = ThreadId.make("thread-acp-thread-instructions");
    const adapter = yield* makeAcpAdapterV2({
      instanceId,
      selfInvocation: yield* resolveSelfInvocation(),
      flavor: {
        driver: ProviderDriverKind.make("acp-test"),
        capabilities: AcpProviderCapabilitiesV2,
        makeRuntime: (runtimeInput) =>
          Effect.gen(function* () {
            const context = yield* Layer.build(
              AcpSessionRuntime.layer({
                ...runtimeInput,
                spawn: {
                  command: process.execPath,
                  args: [mockAgentPath],
                  cwd: runtimeInput.cwd,
                },
                authMethodId: "test",
              }).pipe(
                Layer.provide(
                  Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, childProcessSpawner),
                ),
              ),
            );
            const runtime = yield* Effect.service(AcpSessionRuntime.AcpSessionRuntime).pipe(
              Effect.provide(context),
            );
            return {
              ...runtime,
              prompt: (payload) =>
                Effect.sync(() => {
                  promptTexts.push(
                    payload.prompt
                      .flatMap((block) => (block.type === "text" ? [block.text] : []))
                      .join("\n"),
                  );
                  return { stopReason: "end_turn" as const };
                }),
            };
          }),
      },
    });
    const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
      runtimeMode: "full-access",
      interactionMode: "default",
      cwd: process.cwd(),
    });
    const modelSelection = { instanceId, model: "default" } as const;
    const runtime = yield* adapter.openSession({
      threadId,
      providerSessionId: ProviderSessionId.make("provider-session-acp-thread-instructions"),
      modelSelection,
      runtimePolicy,
    });
    const providerThread = yield* runtime.ensureThread({ threadId, modelSelection, runtimePolicy });
    const runTurn = (ordinal: number, threadInstructions: ReadonlyArray<string>) =>
      Effect.gen(function* () {
        yield* runtime.startTurn({
          ...makeTurnInput({
            threadId,
            providerThread,
            instanceId,
            runtimePolicy,
            now: yield* DateTime.now,
            ordinal,
          }),
          threadInstructions,
        });
        yield* runtime.events.pipe(
          Stream.takeUntil((event) => event.type === "turn.terminal"),
          Stream.runDrain,
        );
        return promptTexts.at(-1) ?? "";
      });

    const rules = ["## Rules A\n\nFirst rule.", "## Rules B\n\nSecond rule."];
    const first = yield* runTurn(1, rules);
    assert.include(first, "## Rules A\n\nFirst rule.\n\n## Rules B\n\nSecond rule.");

    const second = yield* runTurn(2, rules);
    assert.notInclude(second, "<t3_code_instructions>");
    assert.notInclude(second, "First rule.");

    const third = yield* runTurn(3, ["## Rules A\n\nChanged rule."]);
    assert.include(
      third,
      "The following T3 thread instructions replace earlier T3 thread instructions:\n## Rules A\n\nChanged rule.",
    );
  }).pipe(Effect.provide(layerTest)),
);
