// @effect-diagnostics nodeBuiltinImport:off -- Bundles are plain folders read outside any Effect service.
// What is in the captures folder: which capture still owes a build, and what retention will remove
// and when. The list a user reads and the pass that deletes run on the same dates, so what the list
// promises is what happens.

import {
  ScrawlUnfinished,
  type ScrawlCaptureStatus,
  type ScrawlCaptureSummary,
  type ScrawlRetention,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

/** Written at the start of a capture and removed once `scrawl.json` is there. */
export const UNFINISHED_FILE = "unfinished.json";
/** One rebuild try, so a rebuild that crashes the app cannot repeat at every launch. */
export const REBUILT_ONCE_FILE = ".recovering";
/** The same marker the Scrawl app uses to keep a bundle forever. */
export const PINNED_FILE = ".pinned";
const MANIFEST_FILE = "scrawl.json";
const VIDEO_FILES = ["recording.mp4", "recording.webm"];
// Only a build needs these: what the renderer journals next to the video while it records.
const JOURNAL_FILES = [UNFINISHED_FILE, REBUILT_ONCE_FILE, "timing.json", "audio.pcm"];
// Frames, text and contact sheet stay; these are nearly all of a bundle's size.
const MEDIA_ITEMS = [
  ...VIDEO_FILES,
  "audio.wav",
  "audio.pcm",
  "frames-full",
  "contact-sheet-full.png",
  "zoom",
];
const DAY_MS = 24 * 60 * 60 * 1000;
const CAPTURE_FOLDER = /^(scrawl-[a-z0-9-]{1,64})\.scrawl$/;
// Ids carry their start in base 36. A Scrawl app bundle copied here counts in base 10 instead.
const MIN_ID_TIME_MS = Date.UTC(2020, 0, 1);
const MAX_ID_TIME_MS = Date.UTC(2100, 0, 1);

const RETENTION_DAYS: Record<
  ScrawlRetention,
  { readonly media: number | null; readonly bundle: number | null }
> = {
  week: { media: 7, bundle: 30 },
  month: { media: 30, bundle: 90 },
  forever: { media: null, bundle: null },
};

export interface CaptureFolder {
  readonly id: string;
  readonly folder: string;
  readonly built: boolean;
  readonly videoBytes: number;
  readonly tried: boolean;
  readonly pinned: boolean;
  readonly journaled: boolean;
  readonly journal: ScrawlUnfinished | null;
  readonly createdAtMs: number;
  /** When an entry of the folder was last added, removed or renamed. */
  readonly changedAtMs: number;
  readonly durationMs: number;
  readonly app: string;
  readonly windowTitle: string;
  readonly sizeBytes: number;
  readonly mediaBytes: number;
  readonly mediaItems: ReadonlyArray<string>;
}

const sizeOf = async (path: string): Promise<number> => {
  const stat = await NodeFSP.lstat(path).catch(() => null);
  if (stat === null) return 0;
  if (!stat.isDirectory()) return stat.size;
  const entries = await NodeFSP.readdir(path).catch(() => [] as Array<string>);
  const sizes = await Promise.all(entries.map((entry) => sizeOf(NodePath.join(path, entry))));
  return sizes.reduce((sum, size) => sum + size, 0);
};

const exists = (path: string) =>
  NodeFSP.access(path).then(
    () => true,
    () => false,
  );

const readJson = async (path: string): Promise<unknown> => {
  const text = await NodeFSP.readFile(path, "utf8").catch(() => null);
  if (text === null) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};

const decodeJournal = Schema.decodeUnknownSync(ScrawlUnfinished);
const readJournal = async (folder: string): Promise<ScrawlUnfinished | null> => {
  const value = await readJson(NodePath.join(folder, UNFINISHED_FILE));
  if (value === null) return null;
  try {
    return decodeJournal(value);
  } catch {
    return null;
  }
};

export const idTimeMs = (id: string): number | null => {
  const time = Number.parseInt(id.split("-")[1] ?? "", 36);
  return time >= MIN_ID_TIME_MS && time < MAX_ID_TIME_MS ? time : null;
};

const asString = (value: unknown) => (typeof value === "string" ? value : "");
const asNumber = (value: unknown) => (typeof value === "number" ? value : null);
const asRecord = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};

export const readCaptureFolder = async (folder: string): Promise<CaptureFolder | null> => {
  const id = CAPTURE_FOLDER.exec(NodePath.basename(folder))?.[1];
  if (id === undefined) return null;
  const stat = await NodeFSP.stat(folder).catch(() => null);
  if (stat === null || !stat.isDirectory()) return null;
  const manifest = await readJson(NodePath.join(folder, MANIFEST_FILE));
  const facts = asRecord(manifest);
  const target = asRecord(facts.target);
  const journal = await readJournal(folder);
  const mediaSizes = await Promise.all(
    MEDIA_ITEMS.map(async (item) => {
      const path = NodePath.join(folder, item);
      return (await exists(path)) ? { item, bytes: await sizeOf(path) } : null;
    }),
  );
  const media = mediaSizes.filter((entry) => entry !== null);
  return {
    id,
    folder,
    built: manifest !== null,
    videoBytes: media.reduce(
      (sum, { item, bytes }) => (VIDEO_FILES.includes(item) ? sum + bytes : sum),
      0,
    ),
    tried: await exists(NodePath.join(folder, REBUILT_ONCE_FILE)),
    pinned: await exists(NodePath.join(folder, PINNED_FILE)),
    journaled: await exists(NodePath.join(folder, UNFINISHED_FILE)),
    journal,
    // The id before the manifest: a rebuild writes the time of the rebuild there.
    createdAtMs: idTimeMs(id) ?? asNumber(facts.createdAtMs) ?? stat.birthtimeMs,
    changedAtMs: Math.max(stat.mtimeMs, stat.ctimeMs),
    durationMs: asNumber(facts.durationMs) ?? 0,
    app: asString(target.app) || (journal?.session.app ?? ""),
    windowTitle: asString(target.windowTitle) || (journal?.session.windowTitle ?? ""),
    sizeBytes: await sizeOf(folder),
    mediaBytes: media.reduce((sum, { bytes }) => sum + bytes, 0),
    mediaItems: media.map(({ item }) => item),
  };
};

export const readCaptureFolders = async (capturesDir: string) => {
  const entries = await NodeFSP.readdir(capturesDir).catch(() => [] as Array<string>);
  const folders = await Promise.all(
    entries.map((entry) => readCaptureFolder(NodePath.join(capturesDir, entry))),
  );
  return folders.filter((folder) => folder !== null);
};

const captureStatus = (capture: CaptureFolder, recordingId: string | null): ScrawlCaptureStatus => {
  if (capture.id === recordingId) return "recording";
  if (capture.built) return "built";
  return capture.tried || capture.videoBytes === 0 ? "failed" : "unfinished";
};

export const planRebuilds = (
  captures: ReadonlyArray<CaptureFolder>,
  recordingId: string | null,
): {
  readonly owed: ReadonlyArray<CaptureFolder>;
  /** Journal but not one byte of video: the app went down in a capture's first seconds. */
  readonly empty: ReadonlyArray<CaptureFolder>;
} => ({
  owed: captures.filter((capture) => captureStatus(capture, recordingId) === "unfinished"),
  empty: captures.filter(
    (capture) =>
      capture.id !== recordingId &&
      !capture.built &&
      capture.journaled &&
      capture.videoBytes === 0 &&
      !capture.pinned,
  ),
});

/** What a build needs; a capture from before the journal has its video and nothing else. */
export const unfinishedOf = (capture: CaptureFolder): ScrawlUnfinished =>
  capture.journal ?? {
    session: {
      id: capture.id,
      sourceId: "",
      width: 0,
      height: 0,
      startedAtMs: capture.createdAtMs,
      app: "",
      windowTitle: "",
      bundlePath: capture.folder,
    },
    input: { events: [], strokes: [], cursor: [], windows: [], flags: [] },
  };

export const retentionDates = (
  capture: CaptureFolder,
  retention: ScrawlRetention,
  recordingId: string | null,
): { readonly mediaAtMs: number | null; readonly bundleAtMs: number | null } => {
  const status = captureStatus(capture, recordingId);
  if (capture.pinned || status === "recording" || status === "unfinished") {
    return { mediaAtMs: null, bundleAtMs: null };
  }
  const due = (days: number | null) =>
    // A bundle changed within the last day (copied here, unpinned just now) waits a day.
    days === null
      ? null
      : Math.max(capture.createdAtMs + days * DAY_MS, capture.changedAtMs + DAY_MS);
  const { media, bundle } = RETENTION_DAYS[retention];
  return {
    mediaAtMs: capture.mediaItems.length === 0 ? null : due(media),
    bundleAtMs: due(bundle),
  };
};

export type RetentionAction =
  | { readonly kind: "bundle"; readonly folder: string }
  | { readonly kind: "media"; readonly paths: ReadonlyArray<string> };

export const planRetention = (
  captures: ReadonlyArray<CaptureFolder>,
  retention: ScrawlRetention,
  recordingId: string | null,
  now: number,
): ReadonlyArray<RetentionAction> =>
  captures.flatMap((capture): ReadonlyArray<RetentionAction> => {
    const { mediaAtMs, bundleAtMs } = retentionDates(capture, retention, recordingId);
    if (bundleAtMs !== null && now >= bundleAtMs) {
      return [{ kind: "bundle", folder: capture.folder }];
    }
    if (mediaAtMs !== null && now >= mediaAtMs) {
      return [
        {
          kind: "media",
          paths: capture.mediaItems.map((item) => NodePath.join(capture.folder, item)),
        },
      ];
    }
    return [];
  });

export const summarize = (
  capture: CaptureFolder,
  retention: ScrawlRetention,
  recordingId: string | null,
): ScrawlCaptureSummary => {
  const { mediaAtMs, bundleAtMs } = retentionDates(capture, retention, recordingId);
  return {
    id: capture.id,
    bundlePath: capture.folder,
    status: captureStatus(capture, recordingId),
    createdAtMs: capture.createdAtMs,
    durationMs: capture.durationMs,
    app: capture.app,
    windowTitle: capture.windowTitle,
    sizeBytes: capture.sizeBytes,
    mediaBytes: capture.mediaBytes,
    pinned: capture.pinned,
    mediaRemovedAtMs: mediaAtMs,
    bundleRemovedAtMs: bundleAtMs,
  };
};

/** Never half a journal: a crash during this write keeps the previous one. */
export const writeJournal = async (folder: string, journal: ScrawlUnfinished) => {
  const target = NodePath.join(folder, UNFINISHED_FILE);
  const temporary = `${target}.tmp`;
  await NodeFSP.writeFile(temporary, JSON.stringify(journal));
  await NodeFSP.rename(temporary, target);
};

export const removeJournal = async (folder: string) => {
  await Promise.all(
    JOURNAL_FILES.map((file) => NodeFSP.rm(NodePath.join(folder, file), { force: true })),
  );
};
