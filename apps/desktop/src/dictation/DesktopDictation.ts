// @effect-diagnostics nodeBuiltinImport:off -- The worker talks over a Node IPC channel, which only `fork` sets up.
// Dictation on this computer without a T3 server here: the app runs `t3 dictation-worker` from
// the server package it ships (which carries transcribe.cpp and its native libraries) and asks
// it to transcribe. The worker only gets audio and reads the speech model; it has no access to
// projects, terminals or agents, so it fits installs that keep the local environment off.

import type {
  DesktopDictationOutcome,
  DictationAppendInput,
  DictationAppendResult,
  DictationCancelInput,
  DictationFinishInput,
  DictationFinishResult,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as NodeChildProcess from "node:child_process";

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";

type WorkerRequest =
  | ({ readonly method: "append" } & DictationAppendInput)
  | ({ readonly method: "finish" } & DictationFinishInput)
  | ({ readonly method: "cancel" } & DictationCancelInput);

type WorkerResponse = { readonly id: number } & DesktopDictationOutcome<unknown>;

export class DesktopDictation extends Context.Service<
  DesktopDictation,
  {
    readonly append: (
      input: DictationAppendInput,
    ) => Effect.Effect<DesktopDictationOutcome<DictationAppendResult>>;
    readonly finish: (
      input: DictationFinishInput,
    ) => Effect.Effect<DesktopDictationOutcome<DictationFinishResult>>;
    readonly cancel: (input: DictationCancelInput) => Effect.Effect<void>;
  }
>()("@t3tools/desktop/dictation/DesktopDictation") {}

const make = Effect.gen(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  let worker: NodeChildProcess.ChildProcess | undefined;
  let nextId = 0;
  const pending = new Map<number, (response: DesktopDictationOutcome<unknown>) => void>();

  const failAll = (reason: string) => {
    for (const resolve of pending.values()) resolve({ ok: false, reason });
    pending.clear();
  };

  // Started on the first recording and kept, so later recordings find the model loaded; the
  // worker lets go of the model itself after a while without recordings.
  const ensureWorker = (): NodeChildProcess.ChildProcess => {
    if (worker !== undefined && worker.connected) return worker;
    const child = NodeChildProcess.fork(environment.backendEntryPath, ["dictation-worker"], {
      execPath: process.execPath,
      execArgv: environment.isPackaged ? ["--require", environment.compileCachePath] : [],
      cwd: environment.backendCwd,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
      stdio: ["ignore", "ignore", "pipe", "ipc"],
    });
    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr = (stderr + chunk.toString()).slice(-2000);
    });
    child.on("message", (response: WorkerResponse) => {
      const resolve = pending.get(response.id);
      pending.delete(response.id);
      resolve?.(response);
    });
    child.on("exit", (code, signal) => {
      if (worker === child) worker = undefined;
      const detail = stderr.trim().split("\n").at(-1);
      failAll(
        `The dictation worker stopped (${signal ?? `exit code ${String(code)}`})` +
          (detail ? `: ${detail}` : "."),
      );
    });
    child.on("error", (error) => failAll(`The dictation worker failed: ${error.message}`));
    worker = child;
    return child;
  };

  // The worker answers each request with the outcome its method promises.
  const request = <Value>(body: WorkerRequest) =>
    Effect.promise(
      () =>
        new Promise<DesktopDictationOutcome<Value>>((resolve) => {
          const id = ++nextId;
          pending.set(id, resolve as (response: DesktopDictationOutcome<unknown>) => void);
          try {
            ensureWorker().send({ id, ...body });
          } catch (error) {
            pending.delete(id);
            resolve({ ok: false, reason: error instanceof Error ? error.message : String(error) });
          }
        }),
    );

  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      // Closing the channel makes the worker unload the model and exit.
      if (worker?.connected) worker.disconnect();
    }),
  );

  return DesktopDictation.of({
    append: (input) => request<DictationAppendResult>({ method: "append", ...input }),
    finish: (input) => request<DictationFinishResult>({ method: "finish", ...input }),
    cancel: (input) =>
      // Nothing to cancel when no recording ever started the worker.
      worker === undefined ? Effect.void : Effect.asVoid(request({ method: "cancel", ...input })),
  });
});

export const layer = Layer.effect(DesktopDictation, make);
