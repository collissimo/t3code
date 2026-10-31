// Builds a capture the app went down on: the video and audio are on disk, and the desktop app kept
// the clicks and ink. Scene changes were never journaled, so they come out of the video again.

import type { DesktopBridge, ScrawlUnfinished } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import { toastManager } from "../components/ui/toast";
import { DEFAULT_DICTATION_LANGUAGE } from "../dictation/dictationLanguages";
import { randomUUID } from "../lib/utils";
import { wordsOrWhole, type TimedWord } from "./narration";
import { buildBundle, loadVideo, seekTo } from "./scrawlBundle";
import { readCaptureFile, readOptionalCaptureFile } from "./scrawlFiles";
import {
  claimBuild,
  encodeWav,
  releaseBuild,
  SCRAWL_AUDIO_FILE,
  SCRAWL_TIMING_FILE,
  setScrawlHistoryOpen,
  type ScrawlTiming,
} from "./scrawlHistory";
import {
  findSceneChanges,
  lumaOf,
  THUMB_HEIGHT,
  THUMB_WIDTH,
  type LumaSample,
} from "./sceneChanges";

const PCM_BYTES_PER_MS = 32;
// About half a minute of speech per append, well under what a dictation chunk may carry.
const PCM_PIECE_BYTES = 960_000;
const SAMPLE_INTERVAL_MS = 750;
const MAX_SAMPLES = 600;
// The video starts this much after the audio at most (measured in Scrawl: 50 to 500 ms).
const MAX_ESTIMATED_VIDEO_OFFSET_MS = 1_000;

const decodeTiming = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      micStartedAtMs: Schema.Number,
      videoStartedAtMs: Schema.Number,
      language: Schema.String,
      sessionId: Schema.String,
    }),
  ),
);

const parseTiming = (text: string | null): ScrawlTiming | null => {
  if (text === null) return null;
  try {
    return decodeTiming(text);
  } catch {
    return null;
  }
};

/** All times count from the start of the audio, the clock a live capture would have used. */
export const rebuildClock = (input: {
  readonly startedAtMs: number;
  readonly timing: ScrawlTiming | null;
  readonly pcmBytes: number;
  readonly videoMs: number;
}) => {
  const { startedAtMs, timing, pcmBytes, videoMs } = input;
  const audioMs = pcmBytes / PCM_BYTES_PER_MS;
  const videoOffsetMs =
    timing !== null
      ? timing.videoStartedAtMs - timing.micStartedAtMs
      : Math.min(MAX_ESTIMATED_VIDEO_OFFSET_MS, Math.max(0, audioMs - videoMs));
  return {
    videoOffsetMs,
    inputOffsetMs: timing === null ? 0 : timing.micStartedAtMs - startedAtMs,
    durationMs: Math.max(audioMs, videoOffsetMs + videoMs),
  };
};

const toBase64 = (bytes: Uint8Array) => {
  let binary = "";
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  return btoa(binary);
};

const transcribe = async (bridge: DesktopBridge, pcm: Uint8Array, language: string) => {
  const sessionId = randomUUID();
  for (let offset = 0; offset < pcm.length; offset += PCM_PIECE_BYTES) {
    await bridge.dictationAppend?.({
      sessionId,
      language,
      pcm: toBase64(pcm.subarray(offset, offset + PCM_PIECE_BYTES)),
    });
  }
  return bridge.dictationFinish?.({ sessionId, words: true });
};

const sampleScenes = async (video: HTMLVideoElement, videoOffsetMs: number, videoMs: number) => {
  const canvas = document.createElement("canvas");
  canvas.width = THUMB_WIDTH;
  canvas.height = THUMB_HEIGHT;
  const context = canvas.getContext("2d", { willReadFrequently: true })!;
  const step = Math.max(SAMPLE_INTERVAL_MS, videoMs / MAX_SAMPLES);
  const samples: Array<LumaSample> = [];
  for (let at = 0; at < videoMs; at += step) {
    await seekTo(video, at / 1000);
    context.drawImage(video, 0, 0, THUMB_WIDTH, THUMB_HEIGHT);
    const { data } = context.getImageData(0, 0, THUMB_WIDTH, THUMB_HEIGHT);
    samples.push({ t: at + videoOffsetMs, luma: lumaOf(data) });
  }
  return samples;
};

const readVideo = async (read: NonNullable<DesktopBridge["scrawlReadFile"]>, id: string) => {
  const mp4 = await readOptionalCaptureFile(read, id, "recording.mp4");
  if (mp4 !== null && mp4.size > 0) {
    return { blob: new Blob([mp4], { type: "video/mp4" }), name: "recording.mp4" };
  }
  return {
    blob: await readCaptureFile(read, id, "recording.webm", "video/webm"),
    name: "recording.webm",
  };
};

const rebuild = async (bridge: DesktopBridge, unfinished: ScrawlUnfinished) => {
  const read = bridge.scrawlReadFile!;
  const { session, input } = unfinished;
  const { id } = session;
  const timingFile = await readOptionalCaptureFile(read, id, SCRAWL_TIMING_FILE);
  const timing = parseTiming((await timingFile?.text()) ?? null);
  // The session the lost renderer was feeding has no one left to finish it.
  if (timing !== null) {
    await bridge.dictationCancel?.({ sessionId: timing.sessionId }).catch(() => undefined);
  }
  const pcmFile = await readOptionalCaptureFile(read, id, SCRAWL_AUDIO_FILE);
  const pcm = new Uint8Array((await pcmFile?.arrayBuffer()) ?? new ArrayBuffer(0));
  const video = await readVideo(read, id);

  const loaded = await loadVideo(video.blob);
  let videoMs: number;
  let sceneSamples: Array<LumaSample>;
  let width: number;
  let height: number;
  let clock: ReturnType<typeof rebuildClock>;
  try {
    videoMs = Math.round(loaded.video.duration * 1000);
    clock = rebuildClock({
      startedAtMs: session.startedAtMs,
      timing,
      pcmBytes: pcm.length,
      videoMs,
    });
    sceneSamples = await sampleScenes(loaded.video, clock.videoOffsetMs, videoMs);
    width = session.width || loaded.video.videoWidth;
    height = session.height || loaded.video.videoHeight;
  } finally {
    loaded.dispose();
  }

  const transcript =
    pcm.length === 0
      ? undefined
      : await transcribe(bridge, pcm, timing?.language ?? DEFAULT_DICTATION_LANGUAGE).catch(
          () => undefined,
        );
  const transcriptText = transcript?.ok ? transcript.value.text : "";
  const words: ReadonlyArray<TimedWord> = wordsOrWhole(
    transcript?.ok ? (transcript.value.words ?? []) : [],
    transcriptText,
    clock.durationMs,
  );
  await buildBundle(
    {
      session: { ...session, width, height },
      input,
      words,
      transcriptText,
      model: "parakeet",
      video: video.blob,
      videoName: video.name,
      videoOffsetMs: clock.videoOffsetMs,
      inputOffsetMs: clock.inputOffsetMs,
      durationMs: clock.durationMs,
      sceneChanges: findSceneChanges(sceneSamples),
      wav: encodeWav(pcm),
    },
    (path, bytes) => bridge.scrawlWriteFile!({ id, path, bytes }),
  );
  await bridge.scrawlMarkBuilt?.({ id }).catch(() => undefined);
};

/** One try. Throws when the capture cannot be built, which leaves it marked as failed. */
export const rebuildCapture = async (id: string) => {
  const bridge = window.desktopBridge;
  if (bridge?.scrawlBeginRebuild === undefined) return;
  claimBuild(id);
  try {
    await rebuild(bridge, await bridge.scrawlBeginRebuild({ id }));
  } finally {
    releaseBuild(id);
  }
};

let launchRebuildStarted = false;

/** Once per page load, and the renderer has no capture of its own at that point. */
export const rebuildUnfinishedCaptures = async () => {
  if (launchRebuildStarted) return;
  launchRebuildStarted = true;
  const unfinished = (await window.desktopBridge?.scrawlListUnfinished?.()) ?? [];
  let rebuilt = 0;
  let failed = 0;
  for (const { session } of unfinished) {
    try {
      await rebuildCapture(session.id);
      rebuilt += 1;
    } catch (error) {
      console.warn("scrawl: capture could not be rebuilt", session.id, error);
      failed += 1;
    }
  }
  if (rebuilt + failed === 0) return;
  toastManager.add({
    type: failed === 0 ? "success" : "warning",
    title:
      failed === 0
        ? rebuilt === 1
          ? "An interrupted capture was recovered"
          : `${rebuilt} interrupted captures were recovered`
        : failed === 1
          ? "An interrupted capture could not be recovered"
          : `${failed} interrupted captures could not be recovered`,
    timeout: 0,
    actionProps: {
      children: "Show captures",
      onClick: () => setScrawlHistoryOpen(true),
    },
  });
};
