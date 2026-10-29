// Speech to text on the server's machine: Parakeet through transcribe.cpp.
//
// A client streams microphone audio into a recording session. The model loads on the first
// chunk, while the user is already speaking, and is let go after a stretch without
// recordings (it holds 1 to 2.5 GB). While recording, the last seconds are transcribed again
// and again for a live preview; the final transcript is the whole recording, cut at pauses.

import type * as TranscribeCpp from "transcribe-cpp";

export const SAMPLE_RATE = 16_000;
// Below this the model refuses the input anyway.
const MIN_SECONDS = 0.3;
// Peak level under which the microphone delivered nothing usable.
const SILENT_PEAK = 0.002;
// The preview transcribes only the tail of the recording, so its cost does not grow with the
// length. The client shows the last few hundred characters, which hides the clipped first word.
const PREVIEW_WINDOW_SECONDS = 20;
const PREVIEW_PAUSE_MS = 800;
// One run over minutes of audio goes wrong: Parakeet drifts into gibberish, and encoder-decoder
// models (Cohere, Canary) stop at their token limit. The final transcript is run in pieces cut at
// the quietest moment between these bounds.
const CHUNK_MIN_SECONDS = 15;
const CHUNK_MAX_SECONDS = 25;
const PAUSE_FRAME = SAMPLE_RATE / 10;
const MAX_RECORDING_SECONDS = 15 * 60;
// A client that vanished mid-recording leaves its session behind.
const ABANDONED_SESSION_MS = 2 * 60_000;

export type TranscribeModule = typeof TranscribeCpp;

export interface DictationEngineOptions {
  readonly loadModule: () => Promise<TranscribeModule>;
  /** Path of the model file that suits the language, or a rejection saying why there is none. */
  readonly resolveModel: (language: string | undefined) => Promise<string>;
  /** Let go of the model after this long without a recording; 0 keeps it. */
  readonly idleUnloadMs: number;
  /** transcribe.cpp backend; "auto" picks the GPU when there is one. */
  readonly backend?: TranscribeCpp.Backend;
  readonly now?: () => number;
  readonly log?: (message: string) => void;
}

export type TranscriptResult =
  | { readonly text: string; readonly reason?: undefined }
  | { readonly text: ""; readonly reason: "no-speech" | "no-audio" };

interface LoadedModel {
  readonly path: string;
  readonly model: TranscribeCpp.TranscribeModel;
  readonly session: TranscribeCpp.Session;
  readonly languages: ReadonlyArray<string>;
}

interface RecordingSession {
  samples: Float32Array;
  length: number;
  readonly language: string | undefined;
  preview: string;
  lastActiveAt: number;
  lastPreviewAt: number;
}

/** "de-DE" -> "de"; the model knows languages by their two-letter code. */
export function normalizeLanguage(language: string | undefined): string | undefined {
  const code = language?.trim().toLowerCase().split(/[-_]/)[0];
  return code ? code : undefined;
}

/** Cuts audio into pieces of at most CHUNK_MAX_SECONDS, each ending in its quietest stretch. */
export function splitAtPauses(audio: Float32Array): ReadonlyArray<Float32Array> {
  const min = CHUNK_MIN_SECONDS * SAMPLE_RATE;
  const max = CHUNK_MAX_SECONDS * SAMPLE_RATE;
  const pieces: Array<Float32Array> = [];
  let start = 0;
  while (audio.length - start > max) {
    let cut = start + max;
    let quietest = Infinity;
    for (let frame = start + min; frame + PAUSE_FRAME <= start + max; frame += PAUSE_FRAME / 2) {
      let energy = 0;
      for (let index = frame; index < frame + PAUSE_FRAME; index++) {
        energy += audio[index]! * audio[index]!;
      }
      if (energy < quietest) {
        quietest = energy;
        cut = frame + PAUSE_FRAME / 2;
      }
    }
    pieces.push(audio.subarray(start, cut));
    start = cut;
  }
  pieces.push(audio.subarray(start));
  return pieces;
}

export function decodePcm16(base64: string): Float32Array {
  const bytes = Buffer.from(base64, "base64");
  const count = Math.floor(bytes.length / 2);
  const samples = new Float32Array(count);
  for (let index = 0; index < count; index++) {
    samples[index] = bytes.readInt16LE(index * 2) / 32768;
  }
  return samples;
}

export class DictationEngine {
  readonly #options: DictationEngineOptions;
  readonly #now: () => number;
  readonly #sessions = new Map<string, RecordingSession>();
  #module: Promise<TranscribeModule> | undefined;
  #loaded: LoadedModel | undefined;
  #loading: Promise<LoadedModel> | undefined;
  #loadFailure: Error | undefined;
  // One native session serves every run, one at a time.
  #busy: Promise<unknown> = Promise.resolve();
  #previewAbort: AbortController | undefined;
  #previewRun: Promise<unknown> | undefined;
  #lastUsedAt: number;

  constructor(options: DictationEngineOptions) {
    this.#options = options;
    this.#now = options.now ?? Date.now;
    this.#lastUsedAt = this.#now();
  }

  /** Adds recorded audio to a session, opening it on the first call. Returns the live preview. */
  append(sessionId: string, language: string | undefined, samples: Float32Array): string {
    let session = this.#sessions.get(sessionId);
    if (session === undefined) {
      if (
        this.#loadFailure !== undefined &&
        this.#loaded === undefined &&
        this.#loading === undefined
      ) {
        // A new recording tries again: the model may have been installed meanwhile.
        this.#loadFailure = undefined;
      }
      session = {
        samples: new Float32Array(SAMPLE_RATE * 10),
        length: 0,
        language: normalizeLanguage(language),
        preview: "",
        lastActiveAt: this.#now(),
        lastPreviewAt: this.#now(),
      };
      this.#sessions.set(sessionId, session);
      void this.#ensureModel(session.language).catch(() => undefined);
    }
    if (this.#loadFailure !== undefined) {
      this.#sessions.delete(sessionId);
      throw this.#loadFailure;
    }
    this.#push(session, samples);
    session.lastActiveAt = this.#now();
    this.#maybePreview(session);
    return session.preview;
  }

  /** Ends a session and transcribes all of it. */
  async finish(sessionId: string): Promise<TranscriptResult> {
    const session = this.#sessions.get(sessionId);
    this.#sessions.delete(sessionId);
    this.#lastUsedAt = this.#now();
    if (session === undefined || session.length < MIN_SECONDS * SAMPLE_RATE) {
      return { text: "", reason: "no-speech" };
    }
    const audio = session.samples.subarray(0, session.length);
    let peak = 0;
    for (const sample of audio) peak = Math.max(peak, Math.abs(sample));
    if (peak < SILENT_PEAK) return { text: "", reason: "no-audio" };
    const loaded = await this.#ensureModel(session.language);
    // A preview run in flight is aborted instead of making the final run wait for it.
    this.#previewAbort?.abort();
    const started = this.#now();
    const text = await this.#exclusive(async () => {
      const texts: Array<string> = [];
      for (const piece of splitAtPauses(audio)) {
        try {
          const result = await loaded.session.run(
            piece,
            this.#runOptions(loaded, session.language),
          );
          texts.push(result.text);
        } catch (error) {
          const module = await this.#loadModule();
          if (!(error instanceof module.InputTooShort)) throw error;
        }
      }
      return texts.join(" ");
    });
    this.#lastUsedAt = this.#now();
    const cleaned = text.split(/\s+/).filter(Boolean).join(" ");
    this.#options.log?.(
      `transcribed ${(audio.length / SAMPLE_RATE).toFixed(1)}s of audio in ${this.#now() - started}ms`,
    );
    return cleaned ? { text: cleaned } : { text: "", reason: "no-speech" };
  }

  cancel(sessionId: string): void {
    this.#sessions.delete(sessionId);
    if (this.#sessions.size === 0) this.#previewAbort?.abort();
  }

  get modelLoaded(): boolean {
    return this.#loaded !== undefined;
  }

  async dispose(): Promise<void> {
    this.#sessions.clear();
    this.#previewAbort?.abort();
    await this.#unload();
  }

  #push(session: RecordingSession, samples: Float32Array): void {
    const room = MAX_RECORDING_SECONDS * SAMPLE_RATE - session.length;
    const incoming = samples.length > room ? samples.subarray(0, Math.max(0, room)) : samples;
    if (session.length + incoming.length > session.samples.length) {
      const grown = new Float32Array(
        Math.max(session.samples.length * 2, session.length + incoming.length),
      );
      grown.set(session.samples.subarray(0, session.length));
      session.samples = grown;
    }
    session.samples.set(incoming, session.length);
    session.length += incoming.length;
  }

  #maybePreview(session: RecordingSession): void {
    const loaded = this.#loaded;
    if (
      loaded === undefined ||
      this.#previewRun !== undefined ||
      session.length < SAMPLE_RATE ||
      this.#now() - session.lastPreviewAt < PREVIEW_PAUSE_MS
    ) {
      return;
    }
    session.lastPreviewAt = this.#now();
    const start = Math.max(0, session.length - PREVIEW_WINDOW_SECONDS * SAMPLE_RATE);
    // A copy: the recording buffer is replaced when it grows, and native code reads this one.
    const tail = session.samples.slice(start, session.length);
    const abort = new AbortController();
    this.#previewAbort = abort;
    const run = this.#exclusive(() =>
      abort.signal.aborted
        ? Promise.resolve(undefined)
        : loaded.session.run(tail, {
            ...this.#runOptions(loaded, session.language),
            signal: abort.signal,
          }),
    )
      .then((result) => {
        if (result !== undefined && !abort.signal.aborted && !result.aborted) {
          session.preview = result.text.split(/\s+/).filter(Boolean).join(" ");
        }
      })
      // Aborted when the recording ends; anything else only costs this preview.
      .catch(() => undefined)
      .finally(() => {
        if (this.#previewRun === run) this.#previewRun = undefined;
        if (this.#previewAbort === abort) this.#previewAbort = undefined;
      });
    this.#previewRun = run;
  }

  #runOptions(loaded: LoadedModel, language: string | undefined): TranscribeCpp.TranscribeOptions {
    // A model that cannot be told the language detects it.
    return language !== undefined && loaded.languages.includes(language) ? { language } : {};
  }

  #exclusive<T>(task: () => Promise<T>): Promise<T> {
    const run = this.#busy.then(task, task);
    this.#busy = run.catch(() => undefined);
    return run;
  }

  #loadModule(): Promise<TranscribeModule> {
    this.#module ??= this.#options.loadModule().catch((error: unknown) => {
      this.#module = undefined;
      throw new Error(`transcribe.cpp cannot be loaded: ${describe(error)}`, { cause: error });
    });
    return this.#module;
  }

  async #ensureModel(language: string | undefined): Promise<LoadedModel> {
    if (this.#loading !== undefined) return this.#loading;
    const loading = (async () => {
      const path = await this.#options.resolveModel(language);
      const current = this.#loaded;
      if (current !== undefined && (current.path === path || this.#sessions.size > 1)) {
        // Another recording may still need the loaded model; it serves any language it can.
        return current;
      }
      await this.#unload();
      const module = await this.#loadModule();
      const started = this.#now();
      const model = await module.TranscribeModel.load(path, {
        backend: this.#options.backend ?? "auto",
      });
      const loaded: LoadedModel = {
        path,
        model,
        session: model.createSession(),
        languages: model.capabilities.languages,
      };
      this.#loaded = loaded;
      this.#lastUsedAt = this.#now();
      this.#options.log?.(`loaded ${path} on ${model.backend} in ${this.#now() - started}ms`);
      return loaded;
    })();
    this.#loading = loading;
    try {
      return await loading;
    } catch (error) {
      this.#loadFailure = error instanceof Error ? error : new Error(describe(error));
      throw this.#loadFailure;
    } finally {
      this.#loading = undefined;
    }
  }

  async #unload(): Promise<void> {
    const loaded = this.#loaded;
    if (loaded === undefined) return;
    this.#loaded = undefined;
    await this.#busy;
    loaded.session.dispose();
    loaded.model.dispose();
  }

  /** Drops abandoned recordings and lets go of an unused model; called every half minute. */
  housekeeping(): void {
    const now = this.#now();
    for (const [id, session] of this.#sessions) {
      if (now - session.lastActiveAt > ABANDONED_SESSION_MS) this.#sessions.delete(id);
    }
    const limit = this.#options.idleUnloadMs;
    if (
      limit > 0 &&
      this.#loaded !== undefined &&
      this.#loading === undefined &&
      this.#sessions.size === 0 &&
      now - this.#lastUsedAt > limit
    ) {
      this.#options.log?.("unused, letting go of the speech model");
      void this.#unload();
    }
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
