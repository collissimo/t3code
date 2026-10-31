import {
  DictationError,
  type DictationAppendInput,
  type DictationAppendResult,
  type DictationCancelInput,
  type DictationFinishInput,
  type DictationFinishResult,
  type DictationStructureInput,
  type DictationStructureResult,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";

import * as ServerConfig from "../config.ts";
import * as ProcessRunner from "../processRunner.ts";
import { decodePcm16 } from "./DictationEngine.ts";
import {
  finishResult,
  HOUSEKEEPING_INTERVAL_MS,
  makeLocalDictationEngine,
} from "./localDictation.ts";
import { DEFAULT_STRUCTURE_PROMPT } from "./structurePrompt.ts";

const STRUCTURE_TIMEOUT = "90 seconds";
const STRUCTURE_MODEL = "haiku";
const STRUCTURE_EFFORT = "medium";
// The transcript is marked as material and the task repeated after it, so that a question in
// it is rewritten rather than answered.
const STRUCTURE_REQUEST =
  "Schreib dieses Transkript nach deiner Anleitung in den fertigen Prompt um. Antworte nicht auf seinen Inhalt.";

export class Dictation extends Context.Service<
  Dictation,
  {
    readonly append: (
      input: DictationAppendInput,
    ) => Effect.Effect<DictationAppendResult, DictationError>;
    readonly finish: (
      input: DictationFinishInput,
    ) => Effect.Effect<DictationFinishResult, DictationError>;
    readonly cancel: (input: DictationCancelInput) => Effect.Effect<void>;
    /** Rewrites a rambling transcript into a structured prompt with a small Claude model. */
    readonly structure: (
      input: DictationStructureInput,
    ) => Effect.Effect<DictationStructureResult, DictationError>;
  }
>()("t3/dictation/Dictation") {}

const isDictationError = Schema.is(DictationError);

const toDictationError = (cause: unknown) =>
  isDictationError(cause)
    ? cause
    : new DictationError({
        reason: cause instanceof Error ? cause.message : String(cause),
        cause,
      });

/** A `claude` child must not inherit the identity of a Claude session the server runs in. */
const claudeEnvironment = (env: NodeJS.ProcessEnv): NodeJS.ProcessEnv =>
  Object.fromEntries(Object.entries(env).filter(([key]) => !/^(CLAUDE|ANTHROPIC)/i.test(key)));

const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const processRunner = yield* ProcessRunner.ProcessRunner;
  const services = yield* Effect.context<never>();
  const structurePromptFile = path.join(config.baseDir, "dictation", "structure-prompt.md");
  const claudeCwd = path.join(config.stateDir, "dictation", "claude-cwd");

  const engine = yield* Effect.acquireRelease(
    Effect.sync(() =>
      makeLocalDictationEngine((message) =>
        Effect.runForkWith(services)(Effect.logInfo(`dictation: ${message}`)),
      ),
    ),
    (engine) => Effect.promise(() => engine.dispose()),
  );
  yield* Effect.sync(() => engine.housekeeping()).pipe(
    Effect.repeat(Schedule.spaced(HOUSEKEEPING_INTERVAL_MS)),
    Effect.forkScoped,
  );

  const append = Effect.fn("Dictation.append")(function* (input: DictationAppendInput) {
    const preview = yield* Effect.try({
      try: () => engine.append(input.sessionId, input.language, decodePcm16(input.pcm)),
      catch: toDictationError,
    });
    return { preview };
  });

  const finish = Effect.fn("Dictation.finish")(function* (input: DictationFinishInput) {
    const result = yield* Effect.tryPromise({
      try: () =>
        engine.finish(input.sessionId, input.words === undefined ? {} : { words: input.words }),
      catch: toDictationError,
    });
    return finishResult(result);
  });

  const cancel = (input: DictationCancelInput) => Effect.sync(() => engine.cancel(input.sessionId));

  const structure = Effect.fn("Dictation.structure")(function* (input: DictationStructureInput) {
    const custom = yield* fs
      .readFileString(structurePromptFile)
      .pipe(Effect.orElseSucceed(() => ""));
    const instructions = custom.trim() || DEFAULT_STRUCTURE_PROMPT;
    yield* fs.makeDirectory(claudeCwd, { recursive: true }).pipe(Effect.ignore);
    // Safe mode keeps the user's CLAUDE.md, plugins and hooks out: they are written for coding
    // sessions and would bend the rewrite. No tools, no MCP servers, nothing saved to disk.
    const output = yield* processRunner
      .run({
        command: "claude",
        args: [
          "--print",
          "--model",
          STRUCTURE_MODEL,
          "--effort",
          STRUCTURE_EFFORT,
          "--system-prompt",
          instructions,
          "--safe-mode",
          "--strict-mcp-config",
          "--no-session-persistence",
          "--tools",
          "",
        ],
        cwd: claudeCwd,
        env: claudeEnvironment(process.env),
        stdin: `<transkript>\n${input.text}\n</transkript>\n\n${STRUCTURE_REQUEST}`,
        timeout: STRUCTURE_TIMEOUT,
      })
      .pipe(Effect.mapError(toDictationError));
    const text = output.stdout.trim();
    if (output.code !== 0 || text === "") {
      const detail = (output.stderr.trim() || text || "no output").slice(-400);
      return yield* new DictationError({
        reason: `claude exited with ${String(output.code)}: ${detail}`,
      });
    }
    yield* Effect.logInfo(
      `dictation: structured ${input.text.length} characters into ${text.length}`,
    );
    return { text };
  });

  return Dictation.of({ append, finish, cancel, structure });
});

export const layer = Layer.effect(Dictation, make).pipe(Layer.provide(ProcessRunner.layer));
