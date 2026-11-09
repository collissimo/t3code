// @effect-diagnostics globalConsole:off globalTimers:off - A plain Node process outside the server runtime; its stderr is the desktop app's log of it.
// `t3 dictation-worker`: speech to text for the desktop app, without a server. The app starts it
// with an IPC channel and sends append/finish/cancel requests; the worker touches nothing but
// the microphone audio it is sent and the speech model files. The channel, not stdout, carries
// the protocol because the native library may print to stdout.

import type {
  DictationAppendInput,
  DictationAppendResult,
  DictationFinishResult,
} from "@t3tools/contracts";

import {
  type DictationEngines,
  finishResult,
  HOUSEKEEPING_INTERVAL_MS,
  makeDictationEngines,
} from "./localDictation.ts";

export type DictationWorkerRequest =
  | ({
      readonly id: number;
      readonly method: "append";
    } & DictationAppendInput)
  | { readonly id: number; readonly method: "finish"; readonly sessionId: string }
  | { readonly id: number; readonly method: "cancel"; readonly sessionId: string };

export type DictationWorkerResponse =
  | {
      readonly id: number;
      readonly ok: true;
      readonly value: DictationAppendResult | DictationFinishResult | null;
    }
  | { readonly id: number; readonly ok: false; readonly reason: string };

export async function handleDictationWorkerRequest(
  engine: DictationEngines,
  request: DictationWorkerRequest,
): Promise<DictationWorkerResponse> {
  try {
    switch (request.method) {
      case "append":
        return {
          id: request.id,
          ok: true,
          value: { preview: engine.append(request) },
        };
      case "finish":
        return {
          id: request.id,
          ok: true,
          value: finishResult(await engine.finish(request.sessionId)),
        };
      case "cancel":
        engine.cancel(request.sessionId);
        return { id: request.id, ok: true, value: null };
    }
  } catch (error) {
    return {
      id: request.id,
      ok: false,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

export function runDictationWorker(): void {
  const send = process.send?.bind(process);
  if (send === undefined) {
    console.error("dictation-worker needs an IPC channel; the desktop app starts it.");
    process.exit(2);
  }
  const engine = makeDictationEngines((message) => console.error(`dictation: ${message}`));
  const housekeeping = setInterval(() => engine.housekeeping(), HOUSEKEEPING_INTERVAL_MS);
  process.on("message", (message: unknown) => {
    const request = message as DictationWorkerRequest;
    void handleDictationWorkerRequest(engine, request).then((response) => send(response));
  });
  // The app quit or let go of the worker.
  process.on("disconnect", () => {
    clearInterval(housekeeping);
    void engine.dispose().finally(() => process.exit(0));
  });
}
