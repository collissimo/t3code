import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

const SCRIPT_MAX_TOOL_CALLS = 1_000;
export const SCRIPT_MAX_CONCURRENT_TOOL_CALLS = 16;
export const SCRIPT_MAX_OUTPUT_CHARS = 30_000;
const SCRIPT_DEADLINE = Duration.minutes(5);
const SANDBOX_HEAP_MB = 512;

const WorkerMessage = Schema.Union([
  Schema.Struct({ type: Schema.Literal("text"), value: Schema.String }),
  Schema.Struct({
    type: Schema.Literal("call"),
    id: Schema.Number,
    tool: Schema.String,
    input: Schema.String,
  }),
  Schema.Struct({ type: Schema.Literal("done"), error: Schema.optional(Schema.String) }),
]);
const decodeWorkerMessage = Schema.decodeUnknownOption(Schema.fromJsonString(WorkerMessage));
const decodeToolInput = Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown));

export interface ScriptRunResult {
  readonly status: "completed" | "failed" | "timed_out";
  readonly output: string;
  readonly outputTruncated: boolean;
  readonly error?: string;
  readonly toolCalls: number;
  readonly failedToolCalls: number;
  readonly elapsedMs: number;
}

/** A nested call fails with the message the program's `await` rejects with. */
export type ScriptToolCall = (tool: string, input: unknown) => Effect.Effect<unknown, string>;

export class ScriptRunner extends Context.Service<
  ScriptRunner,
  {
    readonly run: (input: {
      readonly code: string;
      readonly call: ScriptToolCall;
      readonly deadline?: Duration.Input;
    }) => Effect.Effect<ScriptRunResult>;
  }
>()("t3/script/ScriptRunner") {}

const sandboxEnvironment = () => ({
  ELECTRON_RUN_AS_NODE: "1",
  NODE_OPTIONS: `--max-old-space-size=${SANDBOX_HEAP_MB}`,
  // Windows cannot initialize Node's crypto and networking without it.
  ...(process.env.SystemRoot === undefined ? {} : { SystemRoot: process.env.SystemRoot }),
});

const make = Effect.gen(function* () {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const path = yield* Path.Path;
  const isExecutable = yield* HostProcess.IsExecutable;
  const executablePath = yield* HostProcess.ExecutablePath;

  const workerArguments = isExecutable
    ? ["__script-sandbox"]
    : yield* Effect.gen(function* () {
        const fromSource = import.meta.url.endsWith(".ts");
        const worker = yield* path.fromFileUrl(
          new URL(
            fromSource ? "../script-sandbox-worker.ts" : "./script-sandbox-worker.mjs",
            import.meta.url,
          ),
        );
        return [...(fromSource ? ["--experimental-strip-types"] : []), worker];
      }).pipe(Effect.orDie);

  const run = Effect.fn("ScriptRunner.run")(
    function* (input: {
      readonly code: string;
      readonly call: ScriptToolCall;
      readonly deadline?: Duration.Input;
    }) {
      const startedAt = yield* Clock.currentTimeMillis;
      let output = "";
      let outputTruncated = false;
      let toolCalls = 0;
      let failedToolCalls = 0;
      const appendOutput = (value: string) => {
        const next = output.length === 0 ? value : `${output}\n${value}`;
        outputTruncated ||= next.length > SCRIPT_MAX_OUTPUT_CHARS;
        output = next.slice(0, SCRIPT_MAX_OUTPUT_CHARS);
      };
      const result = (status: ScriptRunResult["status"], error?: string) =>
        Clock.currentTimeMillis.pipe(
          Effect.map((now): ScriptRunResult => ({
            status,
            output,
            outputTruncated,
            ...(error === undefined ? {} : { error }),
            toolCalls,
            failedToolCalls,
            elapsedMs: now - startedAt,
          })),
        );

      const handle = yield* spawner.spawn(
        ChildProcess.make(executablePath, workerArguments, {
          env: sandboxEnvironment(),
          extendEnv: false,
          forceKillAfter: Duration.seconds(1),
        }),
      );
      const toWorker = yield* Queue.unbounded<string>();
      const send = (message: unknown) => Queue.offer(toWorker, `${JSON.stringify(message)}\n`);
      yield* Stream.fromQueue(toWorker).pipe(
        Stream.encodeText,
        Stream.run(handle.stdin),
        Effect.ignore,
        Effect.forkScoped,
      );
      yield* send({ type: "start", code: input.code });

      const slots = yield* Semaphore.make(SCRIPT_MAX_CONCURRENT_TOOL_CALLS);
      const done = yield* Deferred.make<string | undefined>();
      const runCall = (call: {
        readonly id: number;
        readonly tool: string;
        readonly input: string;
      }) =>
        decodeToolInput(call.input).pipe(
          Effect.mapError(() => "The tool input was not valid JSON."),
          Effect.flatMap((parsed) => input.call(call.tool, parsed)),
          Effect.matchEffect({
            onFailure: (error) => {
              failedToolCalls += 1;
              return send({ type: "result", id: call.id, error });
            },
            onSuccess: (value) =>
              send({ type: "result", id: call.id, value: JSON.stringify(value ?? null) }),
          }),
          slots.withPermit,
        );

      const reader = handle.stdout.pipe(
        Stream.decodeText,
        Stream.splitLines,
        Stream.runForEach((line) => {
          const decoded = decodeWorkerMessage(line);
          if (Option.isNone(decoded)) return Effect.void;
          const message = decoded.value;
          switch (message.type) {
            case "text":
              return Effect.sync(() => appendOutput(message.value));
            case "done":
              return Deferred.succeed(done, message.error).pipe(Effect.asVoid);
            case "call": {
              toolCalls += 1;
              const call = message;
              if (toolCalls > SCRIPT_MAX_TOOL_CALLS) {
                failedToolCalls += 1;
                return send({
                  type: "result",
                  id: call.id,
                  error: `A script can make at most ${SCRIPT_MAX_TOOL_CALLS} tool calls.`,
                });
              }
              return runCall(call).pipe(Effect.forkScoped, Effect.asVoid);
            }
          }
        }),
        Effect.ignore,
      );
      yield* reader.pipe(
        // Output ended without "done": the sandbox died, usually out of memory.
        Effect.andThen(
          handle.exitCode.pipe(
            Effect.map((code) => `The script process exited with code ${code} before finishing.`),
            Effect.orElseSucceed(() => "The script process stopped before finishing."),
          ),
        ),
        Effect.flatMap((error) => Deferred.succeed(done, error)),
        Effect.forkScoped,
      );

      const outcome = yield* Deferred.await(done).pipe(
        Effect.timeoutOption(input.deadline ?? SCRIPT_DEADLINE),
      );
      if (Option.isNone(outcome)) {
        return yield* result(
          "timed_out",
          `The script ran past its deadline of ${Duration.format(Duration.fromInputUnsafe(input.deadline ?? SCRIPT_DEADLINE))} and was stopped. Output so far is included.`,
        );
      }
      return yield* outcome.value === undefined
        ? result("completed")
        : result("failed", outcome.value);
    },
    Effect.scoped,
    (effect) =>
      effect.pipe(
        Effect.catch((cause: unknown) =>
          Effect.succeed<ScriptRunResult>({
            status: "failed",
            output: "",
            outputTruncated: false,
            error: `The script process could not start: ${String(cause)}`,
            toolCalls: 0,
            failedToolCalls: 0,
            elapsedMs: 0,
          }),
        ),
      ),
  );

  return ScriptRunner.of({ run });
});

export const layer = Layer.effect(ScriptRunner, make);
