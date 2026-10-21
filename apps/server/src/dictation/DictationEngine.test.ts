import { describe, expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import {
  DictationEngine,
  SAMPLE_RATE,
  decodePcm16,
  normalizeLanguage,
  type TranscribeModule,
} from "./DictationEngine.ts";
import { findModel, rankModels } from "./modelFiles.ts";
import { handleDictationWorkerRequest } from "./worker.ts";

const V3 = "C:/models/parakeet-tdt-0.6b-v3-Q8_0.gguf";
const UNIFIED_EN = "C:/models/parakeet-unified-en-0.6b-Q8_0.gguf";
const V2 = "C:/models/parakeet-tdt-0.6b-v2-Q8_0.gguf";
const WHISPER = "C:/models/whisper-large-v3-turbo-Q8_0.gguf";
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
    expect(rankModels([UNIFIED_EN, V2], "de", basename)).toEqual([]);
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
  it("normalizes language tags", () => {
    expect(normalizeLanguage("de-DE")).toBe("de");
    expect(normalizeLanguage(" EN_us ")).toBe("en");
    expect(normalizeLanguage("")).toBeUndefined();
    expect(normalizeLanguage(undefined)).toBeUndefined();
  });
});

class FakeModel {
  static loads: Array<string> = [];
  runs: Array<{ length: number; language: string | undefined }> = [];
  disposed = false;
  readonly backend = "CPU";
  readonly capabilities = { languages: ["de", "en"] };
  static async load(path: string) {
    FakeModel.loads.push(path);
    return new FakeModel();
  }
  createSession() {
    return {
      run: async (pcm: Float32Array, opts: { language?: string }) => {
        this.runs.push({ length: pcm.length, language: opts.language });
        return { text: "  Hallo   Welt ", aborted: false };
      },
      dispose: () => undefined,
    };
  }
  dispose() {
    this.disposed = true;
  }
}

const fakeModule = { TranscribeModel: FakeModel, InputTooShort: class extends Error {} };

const makeEngine = (resolveModel = async () => "model.gguf") => {
  let now = 0;
  const engine = new DictationEngine({
    loadModule: async () => fakeModule as unknown as TranscribeModule,
    resolveModel,
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

  it("reports silence and too short recordings without asking the model", async () => {
    const { engine } = makeEngine();
    engine.append("quiet", "de", new Float32Array(SAMPLE_RATE));
    expect(await engine.finish("quiet")).toEqual({ text: "", reason: "no-audio" });
    engine.append("short", "de", speech(0.1));
    expect(await engine.finish("short")).toEqual({ text: "", reason: "no-speech" });
    expect(await engine.finish("never-started")).toEqual({ text: "", reason: "no-speech" });
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
