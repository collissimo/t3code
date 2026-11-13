// @effect-diagnostics nodeBuiltinImport:off - The library path is set before any Effect runtime exists in the worker.
// What the server's Dictation service and the desktop app's dictation worker share: loading
// transcribe.cpp, the engine with its model lookup, and turning a transcript into a result.

import type { DictationAppendInput, DictationFinishResult } from "@t3tools/contracts";
import type * as TranscribeCpp from "transcribe-cpp";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
import * as NodeModule from "node:module";
import * as NodePath from "node:path";

import { CloudDictation } from "./cloudDictation.ts";
import {
  decodePcm16,
  DictationEngine,
  type TranscribeModule,
  type TranscriptResult,
} from "./DictationEngine.ts";
import { findModel, findVadModel, modelDirectories } from "./modelFiles.ts";
import { DEFAULT_STRUCTURE_CODEWORDS, removeFillers, splitCodeword } from "./transcriptText.ts";

const IDLE_UNLOAD_MS = 15 * 60_000;
export const HOUSEKEEPING_INTERVAL_MS = 30_000;
// oxlint-disable-next-line t3code/no-global-process-runtime -- Also runs in the desktop worker, which has no Effect runtime.
const PLATFORM = process.platform;
const NATIVE_LIBRARY_NAME =
  PLATFORM === "win32"
    ? "transcribe.dll"
    : PLATFORM === "darwin"
      ? "libtranscribe.dylib"
      : "libtranscribe.so";

const BACKENDS = ["auto", "cpu", "cpu_accel", "cuda", "rocm", "vulkan", "metal"] as const;

/** T3CODE_DICTATION_BACKEND, e.g. "cpu" when the GPU is busy or misbehaves; "auto" by default. */
export function dictationBackend(value: string | undefined): TranscribeCpp.Backend {
  const wanted = value?.trim().toLowerCase();
  return BACKENDS.find((backend) => backend === wanted) ?? "auto";
}

// ggml-vulkan's cooperative-matrix path returns empty transcripts on AMD RDNA4 (RX 9070 XT);
// without it the GPU is still about five times faster than the CPU. ggml reads the switch with
// getenv when the backend starts. On Windows that is the C runtime's copy of the environment,
// which `process.env` does not update, so it is set through the C runtime itself.
const disableVulkanCoopmat = async (): Promise<void> => {
  const name = "GGML_VK_DISABLE_COOPMAT";
  if (process.env[name] !== undefined) return;
  if (PLATFORM === "win32") {
    const koffi = NodeModule.createRequire(import.meta.url)("koffi") as typeof import("koffi");
    koffi.load("ucrtbase.dll").func("int _putenv_s(str, str)")(name, "1");
  }
  process.env[name] = "1";
};

// transcribe-cpp dlopens a native library; it is only loaded once someone dictates. Its export is
// import-only and a single-executable server resolves packages on disk only through `require`.
const loadTranscribeCpp = async (): Promise<TranscribeModule> => {
  await disableVulkanCoopmat();
  const packagePath = NodeModule.findPackageJSON("transcribe-cpp", import.meta.url);
  if (!packagePath) throw new Error("The native speech package is unavailable.");
  const module = NodeModule.createRequire(packagePath)(
    NodePath.join(NodePath.dirname(packagePath), "dist/index.js"),
  ) as TranscribeModule;
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
function makeLocalDictationEngine(log: (message: string) => void): DictationEngine {
  const configured = process.env.T3CODE_DICTATION_MODEL?.trim() || undefined;
  const resolveModel = Effect.fn("dictation.resolveModel")(function* (
    language: string | undefined,
  ) {
    const directories = modelDirectories(process.env, yield* Path.Path);
    return yield* findModel({ language, configured, directories });
  });
  const resolveVadModel = Effect.fn("dictation.resolveVadModel")(function* () {
    return yield* findVadModel(modelDirectories(process.env, yield* Path.Path));
  });
  return new DictationEngine({
    loadModule: loadTranscribeCpp,
    resolveModel: (language) =>
      Effect.runPromise(resolveModel(language).pipe(Effect.provide(NodeServices.layer))),
    resolveVadModel: () =>
      Effect.runPromise(resolveVadModel().pipe(Effect.provide(NodeServices.layer))),
    idleUnloadMs: IDLE_UNLOAD_MS,
    backend: dictationBackend(process.env.T3CODE_DICTATION_BACKEND),
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

export interface DictationEngines {
  readonly append: (input: DictationAppendInput) => string;
  readonly finish: (sessionId: string) => Promise<TranscriptResult>;
  readonly cancel: (sessionId: string) => void;
  readonly housekeeping: () => void;
  readonly dispose: () => Promise<void>;
}

/**
 * Routes each recording to the one engine it chose. A cloud recording never reaches the local
 * model, which is let go when one starts; a local recording never leaves this machine.
 */
export function makeDictationEngines(
  log: (message: string) => void,
  local: Pick<
    DictationEngine,
    "append" | "finish" | "cancel" | "housekeeping" | "dispose" | "releaseModel"
  > = makeLocalDictationEngine(log),
  cloud: CloudDictation = new CloudDictation(),
): DictationEngines {
  return {
    append: ({ sessionId, engine = "local", language, pcm }) => {
      if (engine === "local") return local.append(sessionId, language, decodePcm16(pcm));
      if (!cloud.has(sessionId)) {
        local.releaseModel();
        log(`dictating with the ${engine} sign-in`);
      }
      return cloud.append(sessionId, engine, language, Buffer.from(pcm, "base64"));
    },
    finish: (sessionId) =>
      cloud.has(sessionId) ? cloud.finish(sessionId) : local.finish(sessionId),
    cancel: (sessionId) => {
      cloud.cancel(sessionId);
      local.cancel(sessionId);
    },
    housekeeping: () => {
      cloud.housekeeping();
      local.housekeeping();
    },
    dispose: async () => {
      cloud.dispose();
      await local.dispose();
    },
  };
}
