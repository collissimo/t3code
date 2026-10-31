// Speech to text on the server's machine through transcribe.cpp. A client streams microphone audio
// into a recording session. The model loads on the first chunk and is let go after a stretch without
// recordings (it holds 1 to 2.5 GB). The last seconds are transcribed repeatedly for a live preview;
// the final transcript is everything that was spoken, cut at pauses.

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
// One run over minutes of audio drifts (Parakeet) or stops at the token limit (Cohere, Canary), so
// the final transcript runs in pieces cut at the quietest moment between these bounds. In shorter
// pieces a thinking pause fills most of the audio and Cohere invents text for it: on real German
// dictation 8-15 s got 19.6% of the words wrong, 15-25 s 14.5%, 25-35 s 10.8%.
const CHUNK_MIN_SECONDS = 25;
const CHUNK_MAX_SECONDS = 35;
const PAUSE_FRAME = SAMPLE_RATE / 10;
// Speech models invent text for a thinking pause, so they only get what Silero marks as speech. On
// looped room tone from real recordings Cohere wrote up to 57 words, and Parakeet turned a faint
// voice in the background into a paragraph; behind this gate all of them wrote nothing. A short gap
// stays because words run together without one.
const VAD_OPTIONS = { minSilenceMs: 300, speechPadMs: 200, minSpeechMs: 200 };
const KEPT_PAUSE_SAMPLES = 0.4 * SAMPLE_RATE;
const MAX_RECORDING_SECONDS = 15 * 60;
// A client that vanished mid-recording leaves its session behind.
const ABANDONED_SESSION_MS = 2 * 60_000;

export type TranscribeModule = typeof TranscribeCpp;

export interface DictationEngineOptions {
  readonly loadModule: () => Promise<TranscribeModule>;
  /** Path of the model file that suits the language, or a rejection saying why there is none. */
  readonly resolveModel: (language: string | undefined) => Promise<string>;
  /** Path of the Silero model, undefined when none is installed; pauses then reach the model. */
  readonly resolveVadModel?: () => Promise<string | undefined>;
  /** Let go of the model after this long without a recording; 0 keeps it. */
  readonly idleUnloadMs: number;
  /** transcribe.cpp backend; "auto" picks the GPU when there is one. */
  readonly backend?: TranscribeCpp.Backend;
  readonly now?: () => number;
  readonly log?: (message: string) => void;
}

export interface TranscriptWord {
  readonly text: string;
  /** Milliseconds from the start of the recording, pauses included. */
  readonly t0: number;
  readonly t1: number;
}

export type TranscriptResult =
  | {
      readonly text: string;
      readonly reason?: undefined;
      /** Only when asked for and the model can time words. */
      readonly words?: ReadonlyArray<TranscriptWord>;
    }
  | { readonly text: ""; readonly reason: "no-speech" | "no-audio" };

interface LoadedModel {
  readonly path: string;
  readonly model: TranscribeCpp.TranscribeModel;
  readonly session: TranscribeCpp.Session;
  readonly languages: ReadonlyArray<string>;
}

interface LoadedVad {
  readonly model: TranscribeCpp.TranscribeModel;
  readonly session: TranscribeCpp.VadSession;
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
  if (start < audio.length) pieces.push(audio.subarray(start));
  return pieces;
}

/** A stretch of the shortened audio and where it began in the recording, in samples. */
export interface KeptSpan {
  readonly keptStart: number;
  readonly recordingStart: number;
  readonly length: number;
}

export const keptSpans = (segments: ReadonlyArray<TranscribeCpp.VadSegment>): Array<KeptSpan> => {
  const spans: Array<KeptSpan> = [];
  let keptStart = 0;
  let previousEnd: number | undefined;
  const add = (recordingStart: number, end: number) => {
    spans.push({ keptStart, recordingStart, length: end - recordingStart });
    keptStart += end - recordingStart;
  };
  for (const { startSample, endSample } of segments) {
    if (previousEnd !== undefined) {
      add(previousEnd, Math.min(startSample, previousEnd + KEPT_PAUSE_SAMPLES));
    }
    add(startSample, endSample);
    previousEnd = endSample;
  }
  return spans;
};

/** The audio of `segments`, with the pauses between them cut down to a short gap. */
export function keepSpeech(
  audio: Float32Array,
  segments: ReadonlyArray<TranscribeCpp.VadSegment>,
): Float32Array {
  const spans = keptSpans(segments);
  const speech = new Float32Array(spans.reduce((sum, span) => sum + span.length, 0));
  for (const span of spans) {
    speech.set(
      audio.subarray(span.recordingStart, span.recordingStart + span.length),
      span.keptStart,
    );
  }
  return speech;
}

/** Word times come back on the shortened audio; clicks and frames live on the recording's clock. */
export function toRecordingMs(keptMs: number, spans: ReadonlyArray<KeptSpan>): number {
  if (spans.length === 0) return keptMs;
  const sample = (keptMs / 1000) * SAMPLE_RATE;
  const span =
    spans.find((candidate) => sample < candidate.keptStart + candidate.length) ?? spans.at(-1)!;
  return Math.round(((span.recordingStart + (sample - span.keptStart)) / SAMPLE_RATE) * 1000);
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
  #vad: Promise<LoadedVad | undefined> | undefined;
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
  async finish(
    sessionId: string,
    options?: { readonly words?: boolean },
  ): Promise<TranscriptResult> {
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
    const canTimeWords = ["word", "token"].includes(loaded.model.capabilities.maxTimestampKind);
    const wantWords = options?.words === true && canTimeWords;
    const { text, words } = await this.#exclusive(async () => {
      const texts: Array<string> = [];
      const words: Array<TranscriptWord> = [];
      const { speech, spans } = await this.#speechWithSpans(audio);
      let pieceStartMs = 0;
      for (const piece of splitAtPauses(speech)) {
        const collect = (result: TranscribeCpp.Transcript) => {
          texts.push(result.text);
          if (!wantWords) return;
          for (const word of result.words) {
            words.push({
              text: word.text.trim(),
              t0: toRecordingMs(pieceStartMs + word.t0Ms, spans),
              t1: toRecordingMs(pieceStartMs + word.t1Ms, spans),
            });
          }
        };
        try {
          collect(
            await loaded.session.run(piece, {
              ...this.#runOptions(loaded, session.language),
              ...(wantWords ? { timestamps: "word" as const } : {}),
            }),
          );
        } catch (error) {
          const module = await this.#loadModule();
          if (error instanceof module.OutputTruncated && error.partialResult !== undefined) {
            // One piece that ran away must not cost the rest of the recording.
            collect(error.partialResult);
          } else if (!(error instanceof module.InputTooShort)) {
            throw error;
          }
        }
        pieceStartMs += (piece.length / SAMPLE_RATE) * 1000;
      }
      return { text: texts.join(" "), words };
    });
    this.#lastUsedAt = this.#now();
    const cleaned = text.split(/\s+/).filter(Boolean).join(" ");
    this.#options.log?.(
      `transcribed ${(audio.length / SAMPLE_RATE).toFixed(1)}s of audio in ${this.#now() - started}ms`,
    );
    if (!cleaned) return { text: "", reason: "no-speech" };
    return wantWords ? { text: cleaned, words } : { text: cleaned };
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
    const run = this.#exclusive(async () => {
      if (abort.signal.aborted) return undefined;
      const speech = await this.#speechOnly(tail);
      // During a pause the preview keeps the words that were said.
      if (abort.signal.aborted || speech.length === 0) return undefined;
      return loaded.session.run(speech, {
        ...this.#runOptions(loaded, session.language),
        signal: abort.signal,
      });
    })
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

  /** Must run inside #exclusive: a VAD session serves one run at a time. */
  async #speechOnly(audio: Float32Array): Promise<Float32Array> {
    return (await this.#speechWithSpans(audio)).speech;
  }

  async #speechWithSpans(
    audio: Float32Array,
  ): Promise<{ readonly speech: Float32Array; readonly spans: ReadonlyArray<KeptSpan> }> {
    const vad = await this.#loadVad();
    if (vad === undefined) return { speech: audio, spans: [] };
    try {
      const { segments } = await vad.session.run(audio, VAD_OPTIONS);
      return { speech: keepSpeech(audio, segments), spans: keptSpans(segments) };
    } catch (error) {
      this.#options.log?.(`voice activity detection failed, keeping pauses: ${describe(error)}`);
      return { speech: audio, spans: [] };
    }
  }

  #loadVad(): Promise<LoadedVad | undefined> {
    this.#vad ??= (async () => {
      try {
        const path = await this.#options.resolveVadModel?.();
        if (path === undefined) {
          this.#options.log?.("no Silero model installed, pauses reach the speech model");
          return undefined;
        }
        const module = await this.#loadModule();
        const model = await module.TranscribeModel.load(path, { backend: "cpu" });
        this.#options.log?.(`loaded ${path}, pauses stay out of the speech model`);
        return { model, session: model.createVadSession() };
      } catch (error) {
        this.#options.log?.(`Silero cannot be loaded, keeping pauses: ${describe(error)}`);
        return undefined;
      }
    })();
    return this.#vad;
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
    const vad = await this.#vad;
    // Looked up again on the next recording: Silero may have been installed meanwhile.
    this.#vad = undefined;
    vad?.session.dispose();
    vad?.model.dispose();
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
