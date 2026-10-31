import { describe, expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import {
  DictationEngine,
  SAMPLE_RATE,
  decodePcm16,
  keepSpeech,
  keptSpans,
  normalizeLanguage,
  splitAtPauses,
  toRecordingMs,
  type TranscribeModule,
} from "./DictationEngine.ts";
import { dictationBackend } from "./localDictation.ts";
import { findModel, findTimingModel, findVadModel, rankModels } from "./modelFiles.ts";
import { handleDictationWorkerRequest } from "./worker.ts";

const V3 = "C:/models/parakeet-tdt-0.6b-v3-Q8_0.gguf";
const UNIFIED_EN = "C:/models/parakeet-unified-en-0.6b-Q8_0.gguf";
const V2 = "C:/models/parakeet-tdt-0.6b-v2-Q8_0.gguf";
const WHISPER = "C:/models/whisper-large-v3-turbo-Q8_0.gguf";
const WHISPER_EN = "C:/models/whisper-small.en-Q8_0.gguf";
const COHERE = "C:/models/cohere-transcribe-03-2026-Q8_0.gguf";
const CANARY = "C:/models/canary-1b-v2-Q8_0.gguf";
const basename = (path: string) => path.split("/").at(-1)!;

describe("rankModels", () => {
  it("gives German a multilingual model, Parakeet first", () => {
    expect(rankModels([WHISPER, UNIFIED_EN, V2, V3], "de", basename)).toEqual([V3, WHISPER]);
  });
  it("prefers Parakeet Unified English for English", () => {
    expect(rankModels([V3, WHISPER, UNIFIED_EN], "en", basename)).toEqual([
      UNIFIED_EN,
      V3,
      WHISPER,
    ]);
  });
  it("never gives German an English-only model", () => {
    expect(rankModels([UNIFIED_EN, V2, WHISPER_EN], "de", basename)).toEqual([]);
  });
  it("prefers Canary, which stays quiet in pauses, and takes Cohere last", () => {
    const all = [V3, UNIFIED_EN, CANARY, COHERE];
    expect(rankModels(all, "de", basename)).toEqual([CANARY, V3, COHERE]);
    expect(rankModels(all, "en", basename)).toEqual([CANARY, UNIFIED_EN, V3, COHERE]);
    expect(rankModels(all, "sv", basename)).toEqual([CANARY, V3]);
    expect(rankModels(all, "ja", basename)).toEqual([COHERE]);
  });
  it("puts models that detect the language first when none is given", () => {
    expect(rankModels([COHERE, V3], undefined, basename)).toEqual([V3, COHERE]);
  });
});

describe("findModel", () => {
  it.effect("looks in every folder and skips other files", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const hex = yield* fs.makeTempDirectoryScoped();
      const scrawl = yield* fs.makeTempDirectoryScoped();
      for (const [folder, name] of [
        [hex, "parakeet-unified-en-0.6b-Q8_0.gguf"],
        [scrawl, "parakeet-tdt-0.6b-v3-Q8_0.gguf"],
        [scrawl, "parakeet-tdt-0.6b-v3-Q8_0.gguf.verified.json"],
        [scrawl, "parakeet-tdt-0.6b-v3-Q8_0.gguf.partial"],
      ] as const) {
        yield* fs.writeFileString(path.join(folder, name), "");
      }
      const directories = [hex, path.join(hex, "missing"), scrawl];
      expect(yield* findModel({ language: "de", configured: undefined, directories })).toBe(
        path.join(scrawl, "parakeet-tdt-0.6b-v3-Q8_0.gguf"),
      );
      expect(yield* findModel({ language: "en", configured: undefined, directories })).toBe(
        path.join(hex, "parakeet-unified-en-0.6b-Q8_0.gguf"),
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("keeps the voice activity model apart from the speech models", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped();
      const silero = path.join(directory, "silero-vad-v6.2-F32.gguf");
      yield* fs.writeFileString(silero, "");
      const error = yield* findModel({
        language: "en",
        configured: undefined,
        directories: [directory],
      }).pipe(Effect.flip);
      expect(error.reason).toContain("No speech model");
      expect(yield* findVadModel([path.join(directory, "missing"), directory])).toBe(silero);
      expect(yield* findVadModel([path.join(directory, "missing")])).toBeUndefined();
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("finds only a Parakeet model that knows the language to time words", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped();
      const directories = [directory];
      yield* fs.writeFileString(path.join(directory, "canary-1b-v2-Q8_0.gguf"), "");
      expect(yield* findTimingModel({ language: "de", directories })).toBeUndefined();
      yield* fs.writeFileString(path.join(directory, "parakeet-unified-en-0.6b-Q8_0.gguf"), "");
      expect(yield* findTimingModel({ language: "de", directories })).toBeUndefined();
      const v3 = path.join(directory, "parakeet-tdt-0.6b-v3-Q8_0.gguf");
      yield* fs.writeFileString(v3, "");
      expect(yield* findTimingModel({ language: "de", directories })).toBe(v3);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("names the folders when nothing is installed", () =>
    Effect.gen(function* () {
      const error = yield* findModel({
        language: "de",
        configured: undefined,
        directories: ["C:/nowhere"],
      }).pipe(Effect.flip);
      expect(error.reason).toContain("C:/nowhere");
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});

describe("audio input", () => {
  it("decodes 16-bit PCM", () => {
    const pcm = Buffer.alloc(4);
    pcm.writeInt16LE(16384, 0);
    pcm.writeInt16LE(-32768, 2);
    expect([...decodePcm16(pcm.toString("base64"))]).toEqual([0.5, -1]);
  });
  it("cuts long audio at the quietest moment, never longer than 35 seconds", () => {
    const audio = speech(100);
    audio.fill(0, 28 * SAMPLE_RATE, 28.5 * SAMPLE_RATE);
    const pieces = splitAtPauses(audio);
    const cut = pieces[0]!.length / SAMPLE_RATE;
    expect(cut).toBeGreaterThan(28);
    expect(cut).toBeLessThan(28.5);
    expect(pieces.every((piece) => piece.length <= 35 * SAMPLE_RATE)).toBe(true);
    expect(pieces.reduce((sum, piece) => sum + piece.length, 0)).toBe(audio.length);
    expect(splitAtPauses(speech(35))).toHaveLength(1);
  });
  it("keeps speech and cuts the pauses between it down to a short gap", () => {
    const audio = new Float32Array(10 * SAMPLE_RATE).fill(0.5);
    const kept = keepSpeech(audio, [
      { startSample: SAMPLE_RATE, endSample: 2 * SAMPLE_RATE },
      { startSample: 2.1 * SAMPLE_RATE, endSample: 3 * SAMPLE_RATE },
      { startSample: 9 * SAMPLE_RATE, endSample: 10 * SAMPLE_RATE },
    ]);
    // 2.9 s of speech, the whole 0.1 s gap, and 0.4 s of the 6 s pause.
    expect(kept.length).toBe(Math.round(3.4 * SAMPLE_RATE));
    expect(keepSpeech(audio, [])).toHaveLength(0);
  });
  it("puts a word back on the recording's clock across a cut pause", () => {
    const spans = keptSpans([
      { startSample: SAMPLE_RATE, endSample: 2 * SAMPLE_RATE },
      { startSample: 9 * SAMPLE_RATE, endSample: 10 * SAMPLE_RATE },
    ]);
    expect(toRecordingMs(500, spans)).toBe(1_500);
    // 1 s of speech and the kept 0.4 s of the pause come before the second stretch.
    expect(toRecordingMs(1_600, spans)).toBe(9_200);
    expect(toRecordingMs(1_600, [])).toBe(1_600);
  });
  it("reads the backend from the environment, auto when unset or unknown", () => {
    expect(dictationBackend(" CPU ")).toBe("cpu");
    expect(dictationBackend("vulkan")).toBe("vulkan");
    expect(dictationBackend("gpu")).toBe("auto");
    expect(dictationBackend(undefined)).toBe("auto");
  });
  it("normalizes language tags", () => {
    expect(normalizeLanguage("de-DE")).toBe("de");
    expect(normalizeLanguage(" EN_us ")).toBe("en");
    expect(normalizeLanguage("")).toBeUndefined();
    expect(normalizeLanguage(undefined)).toBeUndefined();
  });
});

class FakeModel {
  static loads: Array<string> = [];
  static vadSegments: ReadonlyArray<{ startSample: number; endSample: number }> = [];
  static runError: Error | undefined;
  static runLengths: Array<number> = [];
  static vadDisposed = 0;
  static disposedPaths: Array<string> = [];
  static timesNothing = false;
  runs: Array<{ length: number; language: string | undefined }> = [];
  disposed = false;
  readonly backend = "CPU";
  readonly capabilities: { languages: Array<string>; maxTimestampKind: string };
  readonly path: string;
  constructor(path: string) {
    this.path = path;
    this.capabilities = {
      languages: ["de", "en"],
      maxTimestampKind: path.includes("canary") ? "none" : "word",
    };
  }
  static async load(path: string) {
    FakeModel.loads.push(path);
    return new FakeModel(path);
  }
  createSession() {
    return {
      run: async (pcm: Float32Array, opts: { language?: string; timestamps?: string }) => {
        if (this.path.includes("canary")) {
          if (opts.timestamps !== undefined) throw new Error("unsupported timestamp granularity");
          return { text: "Canary Text", aborted: false, words: [] };
        }
        if (FakeModel.timesNothing) return { text: "", aborted: false, words: [] };
        this.runs.push({ length: pcm.length, language: opts.language });
        FakeModel.runLengths.push(pcm.length);
        if (FakeModel.runError !== undefined) throw FakeModel.runError;
        return {
          text: "  Hallo   Welt ",
          aborted: false,
          words: [
            { text: " Hallo", t0Ms: 100, t1Ms: 400 },
            { text: " Welt", t0Ms: 1_600, t1Ms: 1_800 },
          ],
        };
      },
      dispose: () => undefined,
    };
  }
  createVadSession() {
    return {
      run: async () => ({ segments: FakeModel.vadSegments }),
      dispose: () => {
        FakeModel.vadDisposed++;
      },
    };
  }
  dispose() {
    this.disposed = true;
    FakeModel.disposedPaths.push(this.path);
  }
}

class FakeOutputTruncated extends Error {
  partialResult = { text: "Bis hier" };
}

const fakeModule = {
  TranscribeModel: FakeModel,
  InputTooShort: class extends Error {},
  OutputTruncated: FakeOutputTruncated,
};

const makeEngine = (
  resolveModel = async () => "model.gguf",
  resolveVadModel?: () => Promise<string | undefined>,
  resolveTimingModel?: () => Promise<string | undefined>,
) => {
  let now = 0;
  const engine = new DictationEngine({
    loadModule: async () => fakeModule as unknown as TranscribeModule,
    resolveModel,
    ...(resolveVadModel ? { resolveVadModel } : {}),
    ...(resolveTimingModel ? { resolveTimingModel } : {}),
    idleUnloadMs: 60_000,
    now: () => now,
  });
  return { engine, advance: (ms: number) => (now += ms) };
};

// Lets the engine's background model load settle.
const flushMicrotasks = async () => {
  for (let round = 0; round < 10; round++) await Promise.resolve();
};

const speech = (seconds: number) => new Float32Array(seconds * SAMPLE_RATE).fill(0.25);

describe("DictationEngine", () => {
  it("records while the model loads and transcribes the whole recording", async () => {
    FakeModel.loads = [];
    const { engine } = makeEngine();
    engine.append("a", "de-DE", speech(1));
    engine.append("a", "de-DE", speech(2));
    expect(await engine.finish("a")).toEqual({ text: "Hallo Welt" });
    expect(FakeModel.loads).toEqual(["model.gguf"]);
  });

  it("times words on the recording's clock only when asked to", async () => {
    FakeModel.vadSegments = [
      { startSample: SAMPLE_RATE, endSample: 2 * SAMPLE_RATE },
      { startSample: 9 * SAMPLE_RATE, endSample: 10 * SAMPLE_RATE },
    ];
    const { engine } = makeEngine(undefined, async () => "vad.gguf");
    engine.append("a", "de", speech(10));
    expect(await engine.finish("a", { words: true })).toEqual({
      text: "Hallo Welt",
      words: [
        { text: "Hallo", t0: 1_100, t1: 1_400 },
        { text: "Welt", t0: 9_200, t1: 9_400 },
      ],
    });
    engine.append("b", "de", speech(10));
    expect(await engine.finish("b")).toEqual({ text: "Hallo Welt" });
    FakeModel.vadSegments = [];
  });

  describe("when the main model cannot time words", () => {
    const canary = async () => "canary.gguf";
    const parakeet = async () => "parakeet.gguf";

    it("lets the timing model write a capture and lets go of it afterwards", async () => {
      FakeModel.disposedPaths = [];
      const { engine } = makeEngine(canary, undefined, parakeet);
      engine.append("a", "de", speech(3));
      expect(await engine.finish("a", { words: true })).toEqual({
        text: "Hallo Welt",
        words: [
          { text: "Hallo", t0: 100, t1: 400 },
          { text: "Welt", t0: 1_600, t1: 1_800 },
        ],
      });
      expect(FakeModel.disposedPaths).toEqual(["parakeet.gguf"]);
    });

    it("leaves dictation with the main model", async () => {
      FakeModel.loads = [];
      const { engine } = makeEngine(canary, undefined, parakeet);
      engine.append("a", "de", speech(3));
      expect(await engine.finish("a")).toEqual({ text: "Canary Text" });
      expect(FakeModel.loads).toEqual(["canary.gguf"]);
    });

    it("keeps the words untimed when no timing model is installed", async () => {
      const { engine } = makeEngine(canary, undefined, async () => undefined);
      engine.append("a", "de", speech(3));
      expect(await engine.finish("a", { words: true })).toEqual({ text: "Canary Text" });
    });

    it("keeps the words untimed when the timing model hears nothing", async () => {
      FakeModel.timesNothing = true;
      const { engine } = makeEngine(canary, undefined, parakeet);
      engine.append("a", "de", speech(3));
      expect(await engine.finish("a", { words: true })).toEqual({ text: "Canary Text" });
      FakeModel.timesNothing = false;
    });

    it("keeps the words untimed when the timing model cannot load", async () => {
      const { engine } = makeEngine(canary, undefined, async () => {
        throw new Error("broken file");
      });
      engine.append("a", "de", speech(3));
      expect(await engine.finish("a", { words: true })).toEqual({ text: "Canary Text" });
    });
  });

  it("transcribes a long recording in pieces and joins them", async () => {
    const { engine } = makeEngine();
    engine.append("long", "de", speech(40));
    expect(await engine.finish("long")).toEqual({ text: "Hallo Welt Hallo Welt" });
  });

  it("reports silence and too short recordings without asking the model", async () => {
    const { engine } = makeEngine();
    engine.append("quiet", "de", new Float32Array(SAMPLE_RATE));
    expect(await engine.finish("quiet")).toEqual({ text: "", reason: "no-audio" });
    engine.append("short", "de", speech(0.1));
    expect(await engine.finish("short")).toEqual({ text: "", reason: "no-speech" });
    expect(await engine.finish("never-started")).toEqual({ text: "", reason: "no-speech" });
  });

  it("only sends what the voice activity model marks as speech", async () => {
    FakeModel.runLengths = [];
    FakeModel.vadSegments = [{ startSample: 0, endSample: SAMPLE_RATE }];
    const { engine } = makeEngine(undefined, async () => "silero.gguf");
    engine.append("a", "de", speech(30));
    expect(await engine.finish("a")).toEqual({ text: "Hallo Welt" });
    expect(FakeModel.runLengths).toEqual([SAMPLE_RATE]);
  });

  it("does not ask the model when nothing was said", async () => {
    FakeModel.runLengths = [];
    FakeModel.vadSegments = [];
    const { engine } = makeEngine(undefined, async () => "silero.gguf");
    engine.append("a", "de", speech(30));
    expect(await engine.finish("a")).toEqual({ text: "", reason: "no-speech" });
    expect(FakeModel.runLengths).toEqual([]);
  });

  it("keeps the audio as it is without a voice activity model", async () => {
    FakeModel.runLengths = [];
    const { engine } = makeEngine(undefined, async () => undefined);
    engine.append("a", "de", speech(3));
    await engine.finish("a");
    expect(FakeModel.runLengths).toEqual([3 * SAMPLE_RATE]);
  });

  it("keeps the rest of the recording when a piece stops on repeated text", async () => {
    FakeModel.runError = new FakeOutputTruncated();
    try {
      const { engine } = makeEngine();
      engine.append("long", "de", speech(40));
      expect(await engine.finish("long")).toEqual({ text: "Bis hier Bis hier" });
    } finally {
      FakeModel.runError = undefined;
    }
  });

  it("looks for the voice activity model again after letting go of the models", async () => {
    FakeModel.vadDisposed = 0;
    FakeModel.vadSegments = [{ startSample: 0, endSample: SAMPLE_RATE }];
    let resolved = 0;
    const { engine } = makeEngine(undefined, async () => {
      resolved++;
      return "silero.gguf";
    });
    engine.append("a", "de", speech(1));
    await engine.finish("a");
    await engine.dispose();
    expect(FakeModel.vadDisposed).toBe(1);
    engine.append("b", "de", speech(1));
    await engine.finish("b");
    expect(resolved).toBe(2);
  });

  it("fails the next append when no model can be loaded, and tries again on a new recording", async () => {
    let attempts = 0;
    const { engine } = makeEngine(async () => {
      attempts++;
      throw new Error("No Parakeet model found.");
    });
    engine.append("a", "de", speech(1));
    await flushMicrotasks();
    expect(() => engine.append("a", "de", speech(1))).toThrow("No Parakeet model found.");
    // A new recording starts over: the model may have been installed meanwhile.
    expect(engine.append("b", "de", speech(1))).toBe("");
    await flushMicrotasks();
    expect(attempts).toBe(2);
    expect(() => engine.append("b", "de", speech(1))).toThrow("No Parakeet model found.");
  });

  it("lets go of the model after the idle time, never during a recording", async () => {
    const { engine, advance } = makeEngine();
    engine.append("a", "de", speech(1));
    await engine.finish("a");
    expect(engine.modelLoaded).toBe(true);
    engine.append("b", "de", speech(1));
    advance(61_000);
    engine.housekeeping();
    expect(engine.modelLoaded).toBe(true);
    await engine.finish("b");
    advance(61_000);
    engine.housekeeping();
    await flushMicrotasks();
    expect(engine.modelLoaded).toBe(false);
  });
});

describe("dictation worker", () => {
  const pcm = (seconds: number) => {
    const bytes = Buffer.alloc(seconds * SAMPLE_RATE * 2);
    for (let offset = 0; offset < bytes.length; offset += 2) bytes.writeInt16LE(8192, offset);
    return bytes.toString("base64");
  };

  it("answers each request by id with a cleaned transcript", async () => {
    const { engine } = makeEngine();
    const appended = await handleDictationWorkerRequest(engine, {
      id: 1,
      method: "append",
      sessionId: "a",
      language: "de",
      pcm: pcm(1),
    });
    expect(appended).toEqual({ id: 1, ok: true, value: { preview: "" } });
    expect(
      await handleDictationWorkerRequest(engine, { id: 2, method: "finish", sessionId: "a" }),
    ).toEqual({ id: 2, ok: true, value: { text: "Hallo Welt", structureRequested: false } });
  });

  it("turns an engine failure into a reason instead of crashing", async () => {
    const { engine } = makeEngine(async () => {
      throw new Error("No Parakeet model found.");
    });
    const request = {
      id: 3,
      method: "append",
      sessionId: "a",
      language: "de",
      pcm: pcm(1),
    } as const;
    await handleDictationWorkerRequest(engine, request);
    await flushMicrotasks();
    expect(await handleDictationWorkerRequest(engine, { ...request, id: 4 })).toEqual({
      id: 4,
      ok: false,
      reason: "No Parakeet model found.",
    });
  });
});
