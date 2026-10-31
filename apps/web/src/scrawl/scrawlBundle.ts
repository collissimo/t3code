// Builds what an agent reads from a finished recording: keyframes taken from the video, the contact
// sheet, the summary text and the manifest. The folder keeps Scrawl's shape, so the Scrawl skill and
// the `scrawl` CLI (zoom, frames, export) read these bundles as well.

import {
  SCRAWL_INK_HOLD_MS,
  type ScrawlStartResult,
  type ScrawlStopResult,
  type ScrawlStroke,
} from "@t3tools/contracts";

import { groupMarks, placeMarks } from "./markGroups";
import { marksOf } from "./markShapes";
import {
  activityItems,
  computeCrops,
  cropLabel,
  FULL,
  pixelRect,
  windowSnapshots,
  type Crop,
  type CursorSample,
  type LoggedWindows,
  type Rect,
} from "./autocrop";
import { changeRegions, contentMap, type ContentMap, type RgbaImage } from "./autocropContent";
import { layoutSheet } from "./contactSheet";
import {
  chipDodgesRight,
  clicksToRing,
  drawChip,
  drawClickRing,
  frameChipScale,
  SHEET_CHIP_SCALE,
} from "./frameAnnotations";
import {
  budgetFor,
  buildNarration,
  formatNarrationLine,
  type NarrationLine,
  type TimedWord,
} from "./narration";
import { withoutInkChanges } from "./sceneChanges";

const SHEET_BACKGROUND = "rgb(28, 29, 34)";

export interface CaptureRecording {
  readonly session: ScrawlStartResult;
  readonly input: ScrawlStopResult;
  readonly words: ReadonlyArray<TimedWord>;
  readonly transcriptText: string;
  readonly model: string;
  readonly video: Blob;
  readonly videoName: string;
  /** Milliseconds between the start of the audio, which all times count from, and of the video. */
  readonly videoOffsetMs: number;
  /** How far the input clock runs ahead of the audio clock. */
  readonly inputOffsetMs: number;
  readonly durationMs: number;
  readonly sceneChanges: ReadonlyArray<number>;
  readonly wav: Uint8Array;
  /** Scrawl's window log and cursor samples, on the clock of `input`. Crops are better with them. */
  readonly windows?: ReadonlyArray<LoggedWindows>;
  readonly cursor?: ReadonlyArray<CursorSample>;
}

// Scrawl stores flat [x, y, dt] triples with positions in 0..=10000.
const STROKE_SCALE = 10_000;
const manifestStroke = (stroke: ScrawlStroke, width: number, height: number) => {
  const count = stroke.points.length / 2;
  const span = stroke.t1 - stroke.t0;
  const pts: Array<number> = [];
  for (let index = 0; index < count; index++) {
    pts.push(
      Math.round(stroke.points[index * 2]! * STROKE_SCALE),
      Math.round(stroke.points[index * 2 + 1]! * STROKE_SCALE),
      count > 1 ? Math.round((span * index) / (count - 1)) : 0,
    );
  }
  return { t0: stroke.t0, t1: stroke.t1, fw: width, fh: height, pts };
};

const KEYFRAME_REASONS: Record<NarrationLine["actions"][number]["kind"], string> = {
  mark: "mark",
  clicks: "click",
  drag: "click",
  scene: "scene_change",
  scroll: "scene_change",
};

export interface BuiltBundle {
  readonly text: string;
  readonly contactSheet: Blob;
  readonly lines: ReadonlyArray<NarrationLine>;
}

const seekTo = (video: HTMLVideoElement, seconds: number) =>
  new Promise<void>((resolve, reject) => {
    const onSeeked = () => {
      video.removeEventListener("seeked", onSeeked);
      video.removeEventListener("error", onError);
      resolve();
    };
    const onError = () => {
      video.removeEventListener("seeked", onSeeked);
      video.removeEventListener("error", onError);
      reject(new Error("The recording cannot be read."));
    };
    video.addEventListener("seeked", onSeeked);
    video.addEventListener("error", onError);
    video.currentTime = seconds;
  });

const loadVideo = async (blob: Blob) => {
  const video = document.createElement("video");
  video.muted = true;
  video.preload = "auto";
  const url = URL.createObjectURL(blob);
  video.src = url;
  await new Promise<void>((resolve, reject) => {
    video.onloadedmetadata = () => resolve();
    video.onerror = () => reject(new Error("The recording cannot be read."));
  });
  // A recorder's file does not state its length until the player has walked to the end.
  if (!Number.isFinite(video.duration)) {
    await seekTo(video, 1e7);
  }
  return { video, dispose: () => URL.revokeObjectURL(url) };
};

const toBlob = (canvas: HTMLCanvasElement) =>
  new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob === null ? reject(new Error("A frame cannot be encoded.")) : resolve(blob)),
      "image/png",
    );
  });

interface KeyframeImage {
  readonly canvas: HTMLCanvasElement;
  readonly dodgeRight: boolean;
}

/** A group's earlier ink has faded from the video by the time its keyframe is taken. */
const drawMarkInk = (
  context: CanvasRenderingContext2D,
  line: NarrationLine,
  marks: ReadonlyArray<{ readonly id: string; readonly strokes: ReadonlyArray<number> }>,
  strokes: ReadonlyArray<ScrawlStroke>,
  width: number,
  height: number,
) => {
  context.strokeStyle = "#ff2d2d";
  context.lineWidth = Math.max(3, width / 640);
  context.lineCap = "round";
  context.lineJoin = "round";
  for (const action of line.actions) {
    if (action.kind !== "mark") continue;
    const mark = marks.find((candidate) => candidate.id === action.id);
    for (const strokeIndex of mark?.strokes ?? []) {
      const { points } = strokes[strokeIndex]!;
      context.beginPath();
      for (let index = 0; index + 1 < points.length; index += 2) {
        context.lineTo(points[index]! * width, points[index + 1]! * height);
      }
      context.stroke();
    }
  }
};

/** Frames in time order in justified rows, each with its number at one size. */
const drawContactSheet = (frames: ReadonlyArray<KeyframeImage>) => {
  const layout = layoutSheet(frames.map(({ canvas }) => canvas));
  const sheet = document.createElement("canvas");
  sheet.width = layout.width;
  sheet.height = layout.height;
  const context = sheet.getContext("2d")!;
  context.fillStyle = SHEET_BACKGROUND;
  context.fillRect(0, 0, sheet.width, sheet.height);
  context.imageSmoothingQuality = "high";
  layout.cells.forEach((cell, index) => {
    const frame = frames[index]!;
    context.drawImage(frame.canvas, cell.x, cell.y, cell.width, cell.height);
    drawChip(context, String(index + 1), cell, SHEET_CHIP_SCALE, frame.dodgeRight);
  });
  return sheet;
};

/** One keyframe cut to `rect`, with its click rings; the number goes on after the sheet is drawn. */
const renderKeyframe = (
  raw: HTMLCanvasElement,
  rect: Rect,
  rings: ReadonlyArray<readonly [number, number]>,
  ink: ReadonlyArray<readonly [number, number]>,
): KeyframeImage => {
  const box = pixelRect(rect, raw.width, raw.height);
  const canvas = document.createElement("canvas");
  canvas.width = box.width;
  canvas.height = box.height;
  const context = canvas.getContext("2d")!;
  context.save();
  context.translate(-box.x, -box.y);
  context.drawImage(raw, 0, 0);
  context.restore();
  const inFrame = ([x, y]: readonly [number, number]) =>
    [(x * raw.width - box.x) / box.width, (y * raw.height - box.y) / box.height] as const;
  const ringsInFrame = rings.map(inFrame);
  for (const ring of ringsInFrame) {
    if (ring[0] >= 0 && ring[0] <= 1 && ring[1] >= 0 && ring[1] <= 1) {
      drawClickRing(context, ring, box.width, box.height);
    }
  }
  return { canvas, dodgeRight: chipDodgesRight(ink.map(inFrame), ringsInFrame) };
};

const stampFrameChip = ({ canvas, dodgeRight }: KeyframeImage, index: number) => {
  const { width, height } = canvas;
  drawChip(
    canvas.getContext("2d")!,
    String(index + 1),
    { x: 0, y: 0, width },
    frameChipScale(width, height),
    dodgeRight,
  );
};

/** A crop bug must never cost the capture: the full frames are always right. */
const cropsOrFull = (compute: () => Array<Crop>, count: number): ReadonlyArray<Crop> => {
  try {
    return compute();
  } catch (error) {
    console.warn("Scrawl auto-crop failed", error);
    return Array.from({ length: count }, () => ({
      rect: FULL,
      kind: "full" as const,
      reason: "not cropped",
      apps: [],
    }));
  }
};

const formatDuration = (ms: number) => {
  const seconds = Math.round(ms / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
};

const summaryText = (
  recording: Pick<CaptureRecording, "session" | "durationMs">,
  lines: ReadonlyArray<NarrationLine>,
  croppedTo: string | null,
) => {
  const { app, windowTitle, bundlePath } = recording.session;
  const source = [app, windowTitle ? `“${windowTitle}”` : ""].filter(Boolean).join(" ") || "Screen";
  return [
    `[scrawl ${formatDuration(recording.durationMs)} · ${source} · ${bundlePath}]`,
    "Open contact-sheet.png and frames/ in that folder before changing anything: the marks and words only make sense on the images, which can show more than the text does.",
    ...(croppedTo === null ? [] : [`Cropped to: ${croppedTo} (full frames in frames-full/)`]),
    ...lines.map(formatNarrationLine),
  ].join("\n");
};

export async function buildBundle(
  recording: CaptureRecording,
  write: (path: string, bytes: Uint8Array) => Promise<void>,
): Promise<BuiltBundle> {
  const shift = (t: number) => Math.max(0, t - recording.inputOffsetMs);
  const events = recording.input.events.map((event) =>
    event.kind === "click"
      ? { ...event, t: shift(event.t) }
      : { ...event, t: shift(event.t), t1: shift(event.t1) },
  );
  const strokes = recording.input.strokes.map((stroke) => ({
    ...stroke,
    t0: shift(stroke.t0),
    t1: shift(stroke.t1),
  }));
  const marks = marksOf(strokes, recording.session.width, recording.session.height);
  const sceneChanges = withoutInkChanges(recording.sceneChanges, strokes, SCRAWL_INK_HOLD_MS);
  const lines = buildNarration({
    words: recording.words,
    events,
    marks,
    durationMs: recording.durationMs,
    sceneChanges,
    markGroups: groupMarks(marks, {
      actionTimes: events.flatMap((event) =>
        event.kind === "click" || event.kind === "drag" ? [event.t] : [],
      ),
      sceneChanges,
      budget: budgetFor(recording.durationMs),
    }).map((group) => group.map((mark) => mark.id)),
  });
  const { width, height } = recording.session;
  const screen = [width, height] as const;
  const windows = (recording.windows ?? []).map((snapshot) => ({
    ...snapshot,
    t: Math.round(shift(snapshot.t)),
  }));
  const cursor = (recording.cursor ?? []).map(([t, x, y]): CursorSample => [
    Math.round(shift(t)),
    x,
    y,
  ]);

  const { video, dispose } = await loadVideo(recording.video);
  const raws: Array<HTMLCanvasElement> = [];
  const contents: Array<ContentMap> = [];
  const changes: Array<ReadonlyArray<Rect>> = [];
  const grabFrame = async (t: number) => {
    const seconds = Math.max(0, (t - recording.videoOffsetMs) / 1000);
    await seekTo(video, Math.min(seconds, Math.max(0, video.duration - 0.05)));
    const canvas = document.createElement("canvas");
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const context = canvas.getContext("2d", { willReadFrequently: true })!;
    context.drawImage(video, 0, 0);
    return { canvas, image: context.getImageData(0, 0, canvas.width, canvas.height) };
  };
  try {
    let previous: RgbaImage | null =
      lines[0]!.frameT > recording.videoOffsetMs ? (await grabFrame(0)).image : null;
    for (const line of lines) {
      const { canvas, image } = await grabFrame(line.frameT);
      raws.push(canvas);
      contents.push(contentMap(image, screen));
      changes.push(previous === null ? [] : changeRegions(previous, image));
      previous = image;
    }
  } finally {
    dispose();
  }

  const keyframeTimes = lines.map((line) => line.frameT);
  const inkOwners = new Map<number, number>();
  lines.forEach((line, index) => {
    for (const action of line.actions) {
      if (action.kind !== "mark") continue;
      const mark = marks.find((candidate) => candidate.id === action.id);
      for (const stroke of mark?.strokes ?? []) inkOwners.set(stroke, index);
    }
  });
  const crops = cropsOrFull(
    () =>
      computeCrops({
        screen,
        durationMs: recording.durationMs,
        keyframes: keyframeTimes,
        items: activityItems({
          durationMs: recording.durationMs,
          keyframes: keyframeTimes,
          strokes,
          events,
          changes,
          inkOwners,
          inputOwner: (t) => {
            const owner = lines.findIndex((line) =>
              line.actions.some(
                (action) => action.kind !== "mark" && t >= action.t0 && t <= action.t1,
              ),
            );
            return owner < 0 ? undefined : owner;
          },
          cursor,
        }),
        snapshots: windowSnapshots(windows, screen),
        content: contents,
      }),
    lines.length,
  );
  const label = cropLabel(crops);

  const clicks = events.filter((event) => event.kind === "click");
  const frames: Array<KeyframeImage> = [];
  const fullFrames: Array<KeyframeImage> = [];
  lines.forEach((line, index) => {
    const raw = raws[index]!;
    drawMarkInk(raw.getContext("2d")!, line, marks, strokes, raw.width, raw.height);
    const rings = clicksToRing(line, clicks);
    const ink = strokes.flatMap((stroke, at) => {
      const shown =
        inkOwners.get(at) === index ||
        (stroke.t0 <= line.frameT && line.frameT <= stroke.t1 + SCRAWL_INK_HOLD_MS);
      if (!shown) return [];
      return Array.from(
        { length: Math.trunc(stroke.points.length / 2) },
        (_, point) => [stroke.points[point * 2]!, stroke.points[point * 2 + 1]!] as const,
      );
    });
    frames.push(renderKeyframe(raw, crops[index]!.rect, rings, ink));
    if (label !== null) fullFrames.push(renderKeyframe(raw, FULL, rings, ink));
    // Twelve full screens add up: each is released as soon as it is cut.
    raw.width = 0;
  });

  const bytesOf = async (blob: Blob) => new Uint8Array(await blob.arrayBuffer());
  const contactSheet = await toBlob(drawContactSheet(frames));
  await write("contact-sheet.png", await bytesOf(contactSheet));
  if (label !== null) {
    await write(
      "contact-sheet-full.png",
      await bytesOf(await toBlob(drawContactSheet(fullFrames))),
    );
  }
  const writeFrames = async (folder: string, images: ReadonlyArray<KeyframeImage>) => {
    for (const [index, image] of images.entries()) {
      stampFrameChip(image, index);
      const name = `frame-${String(index + 1).padStart(2, "0")}.png`;
      await write(`${folder}/${name}`, await bytesOf(await toBlob(image.canvas)));
    }
  };
  await writeFrames("frames", frames);
  await writeFrames("frames-full", fullFrames);
  await write("audio.wav", recording.wav);

  const text = summaryText(recording, lines, label);
  const encoder = new TextEncoder();
  await write("summary.md", encoder.encode(`${text}\n`));
  const manifest = {
    version: 1,
    id: recording.session.id,
    createdAtMs: Date.now(),
    durationMs: recording.durationMs,
    target: {
      mode: "display",
      app: recording.session.app,
      windowTitle: recording.session.windowTitle,
      displayId: 0,
      frame: { x: 0, y: 0, width, height, scale: 1 },
    },
    transcript: {
      source: recording.model,
      model: recording.model,
      text: recording.transcriptText,
      segments: [],
      words: recording.words,
    },
    strokes: strokes.map((stroke) => manifestStroke(stroke, width, height)),
    marks: placeMarks(marks, lines),
    events: events.map((event) => (event.kind === "click" ? { ...event, button: "left" } : event)),
    keyframes: lines.map((line, index) => {
      const drawn = line.actions.filter((action) => action.kind === "mark");
      const main = drawn[0] ?? line.actions.at(-1);
      return {
        index: index + 1,
        t: Math.round(line.frameT),
        reason: main === undefined ? "speech" : KEYFRAME_REASONS[main.kind],
        file: `frames/frame-${String(index + 1).padStart(2, "0")}.png`,
        event:
          drawn.length > 0
            ? drawn.map(({ id }) => marks.find((mark) => mark.id === id)?.description).join("; ")
            : (main?.kind ?? "speech"),
        said: line.text,
        ...(drawn[0] === undefined ? {} : { markId: drawn[0].id }),
      };
    }),
    contactSheet: "contact-sheet.png",
    video: recording.videoName,
    videoOffsetMs: recording.videoOffsetMs,
    audio: "audio.wav",
    windows,
    cursor,
    ...(label === null
      ? {}
      : {
          autocrop: {
            label,
            fullFrames: "frames-full",
            fullContactSheet: "contact-sheet-full.png",
            crops: crops.map(({ rect, kind, reason, apps }, index) => ({
              index: index + 1,
              x: Math.round(rect[0] * width),
              y: Math.round(rect[1] * height),
              width: Math.round((rect[2] - rect[0]) * width),
              height: Math.round((rect[3] - rect[1]) * height),
              kind,
              reason,
              apps,
            })),
            changes,
          },
        }),
  };
  await write("scrawl.json", encoder.encode(JSON.stringify(manifest)));
  return { text, contactSheet, lines };
}
