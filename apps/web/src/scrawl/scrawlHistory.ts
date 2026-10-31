// What the history dialog, Settings and the rebuild share: whether the dialog is open, which captures
// are being built right now, and the journal files a capture keeps next to its video.

import type { ScrawlCaptureSummary } from "@t3tools/contracts";

export const SCRAWL_AUDIO_FILE = "audio.pcm";
export const SCRAWL_TIMING_FILE = "timing.json";

export interface ScrawlTiming {
  readonly micStartedAtMs: number;
  readonly videoStartedAtMs: number;
  readonly language: string;
  readonly sessionId: string;
}

interface HistoryState {
  readonly open: boolean;
  /** Bumped when the list on disk changed behind the dialog's back. */
  readonly revision: number;
  readonly building: ReadonlySet<string>;
}

let state: HistoryState = { open: false, revision: 0, building: new Set() };
const listeners = new Set<() => void>();

const setState = (next: HistoryState) => {
  state = next;
  for (const listener of listeners) listener();
};

export const subscribeScrawlHistory = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};
export const getScrawlHistoryState = () => state;
export const isScrawlHistoryOpen = () => state.open;
export const setScrawlHistoryOpen = (open: boolean) => setState({ ...state, open });

export const captureListChanged = () => setState({ ...state, revision: state.revision + 1 });

export const claimBuild = (id: string) =>
  setState({ ...state, building: new Set(state.building).add(id) });
export const releaseBuild = (id: string) => {
  const building = new Set(state.building);
  building.delete(id);
  setState({ ...state, building, revision: state.revision + 1 });
};

/** 16 kHz mono 16-bit, as the dictation pipeline records it. */
export const encodeWav = (pcm: Uint8Array) => {
  const wav = new Uint8Array(44 + pcm.length);
  const view = new DataView(wav.buffer);
  const ascii = (offset: number, text: string) => {
    for (let index = 0; index < text.length; index++) {
      view.setUint8(offset + index, text.charCodeAt(index));
    }
  };
  ascii(0, "RIFF");
  view.setUint32(4, 36 + pcm.length, true);
  ascii(8, "WAVEfmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, 16_000, true);
  view.setUint32(28, 32_000, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  ascii(36, "data");
  view.setUint32(40, pcm.length, true);
  wav.set(pcm, 44);
  return wav;
};

const formatDay = (ms: number, now: number) =>
  new Date(ms).toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
    ...(new Date(ms).getFullYear() === new Date(now).getFullYear() ? {} : { year: "numeric" }),
  });

const SOON_MS = 2 * 24 * 60 * 60 * 1000;

/** What retention will do to a capture, in the words its row shows. */
export const captureFate = (
  capture: Pick<
    ScrawlCaptureSummary,
    "pinned" | "status" | "mediaBytes" | "mediaRemovedAtMs" | "bundleRemovedAtMs"
  >,
  now: number,
): { readonly text: string; readonly soon: boolean } => {
  if (capture.pinned) return { text: "Kept until you delete it", soon: false };
  if (capture.status === "unfinished") return { text: "Kept until it is rebuilt", soon: false };
  const { mediaRemovedAtMs, bundleRemovedAtMs } = capture;
  if (mediaRemovedAtMs !== null && mediaRemovedAtMs !== bundleRemovedAtMs) {
    return {
      text: `Video deleted ${formatDay(Math.max(mediaRemovedAtMs, now), now)}`,
      soon: mediaRemovedAtMs - now < SOON_MS,
    };
  }
  if (bundleRemovedAtMs !== null) {
    return {
      text: `Deleted ${formatDay(Math.max(bundleRemovedAtMs, now), now)}`,
      soon: bundleRemovedAtMs - now < SOON_MS,
    };
  }
  return { text: capture.mediaBytes === 0 ? "Video removed" : "Kept", soon: false };
};

export const captureTitle = (capture: Pick<ScrawlCaptureSummary, "app" | "windowTitle">) =>
  [capture.app, capture.windowTitle].filter(Boolean).join(": ") || "Screen";

export const formatBytes = (bytes: number) =>
  bytes >= 1_000_000_000
    ? `${(bytes / 1_000_000_000).toFixed(1)} GB`
    : `${Math.max(1, Math.round(bytes / 1_000_000))} MB`;

export const formatDuration = (ms: number) => {
  const seconds = Math.round(ms / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
};
