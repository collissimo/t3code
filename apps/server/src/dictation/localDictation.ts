// @effect-diagnostics nodeBuiltinImport:off - The library path is set before any Effect runtime exists in the worker.
// What the server's Dictation service and the desktop app's dictation worker share: loading
// transcribe.cpp, the engine with its model lookup, and turning a transcript into a result.

import type { DictationFinishResult } from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
import * as NodePath from "node:path";

import {
  DictationEngine,
  type TranscribeModule,
  type TranscriptResult,
} from "./DictationEngine.ts";
import { findModel, modelDirectories } from "./modelFiles.ts";
import { DEFAULT_STRUCTURE_CODEWORDS, removeFillers, splitCodeword } from "./transcriptText.ts";

const IDLE_UNLOAD_MS = 15 * 60_000;
export const HOUSEKEEPING_INTERVAL_MS = 30_000;
const NATIVE_LIBRARY_NAME =
  process.platform === "win32"
    ? "transcribe.dll"
    : process.platform === "darwin"
      ? "libtranscribe.dylib"
      : "libtranscribe.so";

// transcribe-cpp dlopens a native library; it is only loaded once someone dictates.
const loadTranscribeCpp = async (): Promise<TranscribeModule> => {
  const module = (await import("transcribe-cpp")) as TranscribeModule;
  if (!process.env.TRANSCRIBE_LIBRARY) {
    // In the desktop app the package sits in an asar archive, which the OS loader cannot read;
    // its DLLs are unpacked beside the archive.
    const directory = module.artifactDir();
    const unpacked = directory.replace(/\.asar([\\/])/, ".asar.unpacked$1");
    if (unpacked !== directory) {
      process.env.TRANSCRIBE_LIBRARY = NodePath.join(unpacked, NATIVE_LIBRARY_NAME);
    }
  }
  return module;
};

/** The engine over the models installed on this machine (Hex, Scrawl or T3CODE_DICTATION_MODEL). */
export function makeLocalDictationEngine(log: (message: string) => void): DictationEngine {
  const configured = process.env.T3CODE_DICTATION_MODEL?.trim() || undefined;
  const resolveModel = Effect.fn("dictation.resolveModel")(function* (
    language: string | undefined,
  ) {
    const directories = modelDirectories(process.env, yield* Path.Path);
    return yield* findModel({ language, configured, directories });
  });
  return new DictationEngine({
    loadModule: loadTranscribeCpp,
    resolveModel: (language) =>
      Effect.runPromise(resolveModel(language).pipe(Effect.provide(NodeServices.layer))),
    idleUnloadMs: IDLE_UNLOAD_MS,
    log,
  });
}

export function finishResult(result: TranscriptResult): DictationFinishResult {
  if (result.reason !== undefined) {
    return { text: "", reason: result.reason, structureRequested: false };
  }
  const cleaned = splitCodeword(removeFillers(result.text), DEFAULT_STRUCTURE_CODEWORDS);
  if (cleaned.text === "") return { text: "", reason: "no-speech", structureRequested: false };
  return { text: cleaned.text, structureRequested: cleaned.found };
}
