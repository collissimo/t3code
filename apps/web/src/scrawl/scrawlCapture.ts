// One screen capture at a time, kept outside React: the shortcut works from any other program, and
// switching threads while recording must not end it. Whichever composer is on screen at the end
// receives the result.

import type { DesktopBridge, ScrawlStartResult } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import { startMicrophoneCapture, type MicrophoneCapture } from "../dictation/microphoneCapture";
import { toastManager } from "../components/ui/toast";
import { DEFAULT_DICTATION_LANGUAGE } from "../dictation/dictationLanguages";
import { DICTATION_LANGUAGE_KEY } from "../dictation/useDictation";
import { getLocalStorageItem } from "../hooks/useLocalStorage";
import { randomUUID } from "../lib/utils";
import { wordsOrWhole } from "./narration";
import { buildBundle } from "./scrawlBundle";
import { readCaptureFile, readOptionalCaptureFile } from "./scrawlFiles";
import {
  claimBuild,
  encodeWav,
  releaseBuild,
  SCRAWL_AUDIO_FILE,
  SCRAWL_TIMING_FILE,
  type ScrawlTiming,
} from "./scrawlHistory";
import {
  findSceneChanges,
  lumaOf,
  THUMB_HEIGHT,
  THUMB_WIDTH,
  type LumaSample,
} from "./sceneChanges";

const SEND_INTERVAL_MS = 500;
const SAMPLE_INTERVAL_MS = 750;
const VIDEO_TIMESLICE_MS = 2_000;
// The MP4 muxer hands over nothing until the next keyframe, whatever the timeslice, and left alone
// that took over 11 seconds in Chromium: a crash would leave a header and no video.
const VIDEO_KEYFRAME_INTERVAL_MS = 2_000;
// Keyframes come out of this video, so small text has to survive it.
const VIDEO_BITS_PER_SECOND = 6_000_000;
const MAX_FRAME_RATE = 15;

export type ScrawlPhase = "idle" | "starting" | "recording" | "building";

export interface ScrawlState {
  readonly phase: ScrawlPhase;
  readonly notice: { readonly text: string; readonly tone: "error" | "warning" | "success" } | null;
}

export interface ScrawlDelivery {
  readonly insert: (text: string) => boolean;
  readonly attachImage: (file: File) => Promise<boolean>;
}

interface ImageCaptureLike {
  grabFrame(): Promise<ImageBitmap>;
}
declare const ImageCapture: new (track: MediaStreamTrack) => ImageCaptureLike;

interface Running {
  readonly session: ScrawlStartResult;
  readonly sessionId: string;
  readonly screen: MediaStream;
  readonly mic: MicrophoneCapture;
  readonly recorder: MediaRecorder;
  readonly videoName: string;
  readonly samples: Array<LumaSample>;
  readonly micStartedAt: number;
  readonly language: string;
  readonly pcmTimer: ReturnType<typeof setInterval>;
  readonly sampleTimer: ReturnType<typeof setInterval>;
  videoStartedAt: number;
  writes: Promise<void>;
  sending: Promise<void>;
}

const IDLE: ScrawlState = { phase: "idle", notice: null };

let state: ScrawlState = IDLE;
let running: Running | null = null;
let delivery: ScrawlDelivery | null = null;
let noticeTimer: ReturnType<typeof setTimeout> | null = null;
const listeners = new Set<() => void>();

const setState = (next: ScrawlState) => {
  state = next;
  for (const listener of listeners) listener();
};

const notify = (notice: NonNullable<ScrawlState["notice"]>, phase: ScrawlPhase = "idle") => {
  if (noticeTimer !== null) clearTimeout(noticeTimer);
  setState({ phase, notice });
  // Notices show above the composer; Settings has none, and the word must still reach the user.
  if (delivery === null) toastManager.add({ type: notice.tone, title: notice.text });
  noticeTimer = setTimeout(() => {
    noticeTimer = null;
    if (state.notice === notice) setState({ ...state, notice: null });
  }, 8_000);
};

const describe = (error: unknown) => (error instanceof Error ? error.message : String(error));

export const subscribeScrawl = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};
export const getScrawlState = () => state;

/** The composer on screen takes the result; the latest to mount wins, as the visible one did. */
export const registerScrawlDelivery = (target: ScrawlDelivery) => {
  delivery = target;
  return () => {
    if (delivery === target) delivery = null;
  };
};

const scrawlBridge = (): DesktopBridge | null =>
  window.desktopBridge?.scrawlStart === undefined ? null : window.desktopBridge;

export const isScrawlAvailable = () => scrawlBridge() !== null;

export const hasScrawlComposer = () => delivery !== null;

const openScreen = (sourceId: string) =>
  navigator.mediaDevices.getUserMedia({
    audio: false,
    video: {
      mandatory: {
        chromeMediaSource: "desktop",
        chromeMediaSourceId: sourceId,
        maxFrameRate: MAX_FRAME_RATE,
      },
    },
  } as unknown as MediaStreamConstraints);

const chooseVideoFormat = () =>
  MediaRecorder.isTypeSupported("video/mp4;codecs=avc1.640032")
    ? { mimeType: "video/mp4;codecs=avc1.640032", name: "recording.mp4" }
    : { mimeType: "video/webm;codecs=vp9", name: "recording.webm" };

/** Keeps one small grey thumbnail per sample; nothing at full size stays in memory. */
const startSampling = (track: MediaStreamTrack, startedAt: number, samples: Array<LumaSample>) => {
  const grabber = new ImageCapture(track);
  const canvas = document.createElement("canvas");
  canvas.width = THUMB_WIDTH;
  canvas.height = THUMB_HEIGHT;
  const context = canvas.getContext("2d", { willReadFrequently: true })!;
  let busy = false;
  return setInterval(() => {
    if (busy) return;
    busy = true;
    void grabber
      .grabFrame()
      .then((frame) => {
        const t = Date.now() - startedAt;
        context.drawImage(frame, 0, 0, THUMB_WIDTH, THUMB_HEIGHT);
        frame.close();
        const { data } = context.getImageData(0, 0, THUMB_WIDTH, THUMB_HEIGHT);
        samples.push({ t, luma: lumaOf(data) });
      })
      // A frame missed while the track starts or ends only thins the samples.
      .catch(() => undefined)
      .finally(() => {
        busy = false;
      });
  }, SAMPLE_INTERVAL_MS);
};

const decodeBase64 = (value: string) => {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return bytes;
};

/** Everything recorded goes to disk as it comes: a crash keeps it, and memory stays flat. */
const appendToDisk = (
  bridge: DesktopBridge,
  capture: Running,
  name: string,
  bytes: () => Promise<Uint8Array> | Uint8Array,
) => {
  capture.writes = capture.writes.then(async () => {
    await bridge.scrawlAppendVideo?.({ id: capture.session.id, name, bytes: await bytes() });
  });
};

const sendPcm = (bridge: DesktopBridge, capture: Running, pcm: string) => {
  appendToDisk(bridge, capture, SCRAWL_AUDIO_FILE, () => decodeBase64(pcm));
  capture.sending = capture.sending.then(async () => {
    // The recording goes on without words when the speech model is missing; the end says so.
    await bridge
      .dictationAppend?.({ sessionId: capture.sessionId, language: capture.language, pcm })
      .catch(() => undefined);
  });
};

const start = async (bridge: DesktopBridge) => {
  setState({ phase: "starting", notice: null });
  let session: ScrawlStartResult | null = null;
  let screen: MediaStream | null = null;
  let mic: MicrophoneCapture | null = null;
  try {
    session = await bridge.scrawlStart!();
    screen = await openScreen(session.sourceId);
    mic = await startMicrophoneCapture();
    const micStartedAt = Date.now();
    const format = chooseVideoFormat();
    const recorder = new MediaRecorder(
      new MediaStream([...screen.getVideoTracks(), ...mic.stream.getAudioTracks()]),
      {
        mimeType: format.mimeType,
        videoBitsPerSecond: VIDEO_BITS_PER_SECOND,
        videoKeyFrameIntervalDuration: VIDEO_KEYFRAME_INTERVAL_MS,
      } as MediaRecorderOptions,
    );
    const samples: Array<LumaSample> = [];
    const capture: Running = {
      session,
      sessionId: randomUUID(),
      screen,
      mic,
      recorder,
      videoName: format.name,
      samples,
      micStartedAt,
      language:
        getLocalStorageItem(DICTATION_LANGUAGE_KEY, Schema.String) ?? DEFAULT_DICTATION_LANGUAGE,
      pcmTimer: setInterval(() => {
        if (running !== null) sendPcm(bridge, running, running.mic.takePcm());
      }, SEND_INTERVAL_MS),
      sampleTimer: startSampling(screen.getVideoTracks()[0]!, micStartedAt, samples),
      videoStartedAt: micStartedAt,
      writes: Promise.resolve(),
      sending: Promise.resolve(),
    };
    recorder.onstart = () => {
      capture.videoStartedAt = Date.now();
      const timing: ScrawlTiming = {
        micStartedAtMs: capture.micStartedAt,
        videoStartedAtMs: capture.videoStartedAt,
        language: capture.language,
        sessionId: capture.sessionId,
      };
      void bridge
        .scrawlWriteFile?.({
          id: capture.session.id,
          path: SCRAWL_TIMING_FILE,
          bytes: new TextEncoder().encode(JSON.stringify(timing)),
        })
        // A rebuild without it estimates the offset from the lengths of video and audio.
        .catch(() => undefined);
    };
    recorder.ondataavailable = (event) => {
      if (event.data.size === 0) return;
      appendToDisk(
        bridge,
        capture,
        capture.videoName,
        async () => new Uint8Array(await event.data.arrayBuffer()),
      );
    };
    recorder.start(VIDEO_TIMESLICE_MS);
    running = capture;
    setState({ phase: "recording", notice: null });
  } catch (error) {
    for (const track of screen?.getTracks() ?? []) track.stop();
    mic?.stop();
    if (session !== null) await bridge.scrawlCancel?.({ id: session.id }).catch(() => undefined);
    notify({ text: `Recording cannot start: ${describe(error)}`, tone: "error" });
  }
};

const released = new WeakSet<Running>();
const release = (capture: Running) => {
  if (released.has(capture)) return;
  released.add(capture);
  clearInterval(capture.pcmTimer);
  clearInterval(capture.sampleTimer);
  for (const track of capture.screen.getTracks()) track.stop();
  capture.mic.stop();
};

const stopRecorder = (recorder: MediaRecorder) =>
  new Promise<void>((resolve) => {
    if (recorder.state === "inactive") {
      resolve();
      return;
    }
    recorder.onstop = () => resolve();
    recorder.stop();
  });

const deliver = async (
  text: string,
  contactSheet: Blob,
  bundlePath: string,
  phase: ScrawlPhase = "idle",
) => {
  if (delivery === null || !delivery.insert(`${text}\n`)) {
    // The clipboard refuses a window that is not in front, and this one usually is not.
    const copied = await navigator.clipboard?.writeText(text).then(
      () => true,
      () => false,
    );
    notify(
      {
        text: copied
          ? "No composer can take the capture · its text is on the clipboard"
          : `No composer can take the capture · it is saved in ${bundlePath}`,
        tone: "warning",
      },
      phase,
    );
    return;
  }
  const attached = await delivery.attachImage(
    new File([contactSheet], "contact-sheet.png", { type: "image/png" }),
  );
  notify(
    attached
      ? { text: "Capture added to the composer", tone: "success" }
      : { text: "Capture text added · the contact sheet could not be attached", tone: "warning" },
    phase,
  );
};

/** Puts a past capture into the composer on screen, as if it had just finished. */
export const insertPastCapture = async (id: string, bundlePath: string) => {
  const read = scrawlBridge()?.scrawlReadFile;
  if (read === undefined) return;
  // Never ends a capture in progress: this is not the end of the one being recorded.
  const phase = state.phase;
  try {
    const text = await (await readCaptureFile(read, id, "summary.md")).text();
    const sheet = await readCaptureFile(read, id, "contact-sheet.png", "image/png");
    await deliver(text.trimEnd(), sheet, bundlePath, phase);
  } catch (error) {
    notify({ text: `The capture could not be read: ${describe(error)}`, tone: "error" }, phase);
  }
};

const finish = async (bridge: DesktopBridge, capture: Running) => {
  running = null;
  setState({ phase: "building", notice: null });
  claimBuild(capture.session.id);
  try {
    const input = await bridge.scrawlStop!({ id: capture.session.id });
    const durationMs = Date.now() - capture.micStartedAt;
    await stopRecorder(capture.recorder);
    sendPcm(bridge, capture, capture.mic.takePcm());
    release(capture);
    await capture.sending;
    await capture.writes;
    const read = bridge.scrawlReadFile!;
    const { id } = capture.session;
    const pcm = await readOptionalCaptureFile(read, id, SCRAWL_AUDIO_FILE);
    const transcript = await bridge.dictationFinish?.({
      sessionId: capture.sessionId,
      words: true,
    });
    const transcriptText = transcript?.ok ? transcript.value.text : "";
    const words = wordsOrWhole(
      transcript?.ok ? (transcript.value.words ?? []) : [],
      transcriptText,
      durationMs,
    );
    const built = await buildBundle(
      {
        session: capture.session,
        input,
        words,
        transcriptText,
        model: "parakeet",
        // Only now, for as long as the build runs; nothing of it stayed around during the capture.
        video: await readCaptureFile(read, id, capture.videoName, capture.recorder.mimeType),
        videoName: capture.videoName,
        videoOffsetMs: capture.videoStartedAt - capture.micStartedAt,
        inputOffsetMs: capture.micStartedAt - capture.session.startedAtMs,
        durationMs,
        sceneChanges: findSceneChanges(capture.samples),
        wav: encodeWav(new Uint8Array((await pcm?.arrayBuffer()) ?? new ArrayBuffer(0))),
      },
      (path, bytes) => bridge.scrawlWriteFile!({ id: capture.session.id, path, bytes }),
    );
    await bridge.scrawlMarkBuilt?.({ id: capture.session.id }).catch(() => undefined);
    await deliver(built.text, built.contactSheet, capture.session.bundlePath);
    if (transcript !== undefined && !transcript.ok) {
      notify({ text: `Capture has no transcript: ${transcript.reason}`, tone: "warning" });
    }
  } catch (error) {
    release(capture);
    notify({
      text: `The capture could not be built: ${describe(error)}. Rebuild it from Past captures`,
      tone: "error",
    });
  } finally {
    releaseBuild(capture.session.id);
  }
};

/** Starts a capture, or finishes the running one. */
export const toggleScrawl = () => {
  const bridge = scrawlBridge();
  if (bridge === null) return;
  if (state.phase === "idle") void start(bridge);
  else if (state.phase === "recording" && running !== null) void finish(bridge, running);
};

/** Drops a running capture and its files. Returns whether there was one. */
export const cancelScrawl = (): boolean => {
  const bridge = scrawlBridge();
  const capture = running;
  if (bridge === null || capture === null) return false;
  running = null;
  capture.recorder.ondataavailable = null;
  capture.recorder.stop();
  release(capture);
  void bridge.dictationCancel?.({ sessionId: capture.sessionId }).catch(() => undefined);
  void bridge.scrawlCancel?.({ id: capture.session.id }).catch(() => undefined);
  setState(IDLE);
  return true;
};
