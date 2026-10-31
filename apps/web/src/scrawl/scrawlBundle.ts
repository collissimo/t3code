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
  budgetFor,
  buildNarration,
  formatNarrationLine,
  type NarrationLine,
  type TimedWord,
} from "./narration";
import { withoutInkChanges } from "./sceneChanges";

const SHEET_LONG_EDGE = 1600;
const SHEET_GUTTER = 6;
const CROP_PADDING = 0.08;
// Cropping to most of the screen only loses context.
const MAX_CROP_AREA = 0.7;
const MIN_CROP_SIDE = 0.35;

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

/** Everything the hand touched, padded, or null when that is most of the screen anyway. */
function activityBox(recording: Pick<CaptureRecording, "input">): {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
} | null {
  const xs: Array<number> = [];
  const ys: Array<number> = [];
  for (const event of recording.input.events) {
    if (event.kind === "click") {
      xs.push(event.x);
      ys.push(event.y);
    } else {
      xs.push(event.x0, event.x1);
      ys.push(event.y0, event.y1);
    }
  }
  for (const stroke of recording.input.strokes) {
    stroke.points.forEach((value, index) => (index % 2 === 0 ? xs : ys).push(value));
  }
  if (xs.length === 0) return null;
  const widen = (low: number, high: number) => {
    let start = low - CROP_PADDING;
    let end = high + CROP_PADDING;
    if (end - start < MIN_CROP_SIDE) {
      const middle = (start + end) / 2;
      start = middle - MIN_CROP_SIDE / 2;
      end = middle + MIN_CROP_SIDE / 2;
    }
    start = Math.max(0, start);
    end = Math.min(1, end);
    return [start, end - start] as const;
  };
  const [x, width] = widen(Math.min(...xs), Math.max(...xs));
  const [y, height] = widen(Math.min(...ys), Math.max(...ys));
  return width * height > MAX_CROP_AREA ? null : { x, y, width, height };
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

const drawClickRings = (
  context: CanvasRenderingContext2D,
  line: NarrationLine,
  width: number,
  height: number,
) => {
  context.lineWidth = Math.max(2, width / 700);
  context.strokeStyle = "rgba(239, 68, 68, 0.85)";
  for (const action of line.actions) {
    if (action.kind !== "clicks") continue;
    for (const [x, y] of action.points) {
      context.beginPath();
      context.arc(x * width, y * height, Math.max(10, width / 90), 0, Math.PI * 2);
      context.stroke();
    }
  }
};

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

const drawChip = (context: CanvasRenderingContext2D, label: string, height: number) => {
  // Blind reading tests in Scrawl: the number needs its own white square to be read as a number.
  const size = Math.max(24, height / 18);
  context.fillStyle = "#ffffff";
  context.strokeStyle = "#111111";
  context.lineWidth = 2;
  context.beginPath();
  context.roundRect(5, 5, size, size, 4);
  context.fill();
  context.stroke();
  context.fillStyle = "#000000";
  context.font = `700 ${Math.round(size * 0.68)}px system-ui`;
  context.textAlign = "center";
  context.textBaseline = "middle";
  context.fillText(label, 5 + size / 2, 5 + size / 2 + 1);
};

/** Frames in time order in justified rows, each with its number. */
const drawContactSheet = (frames: ReadonlyArray<HTMLCanvasElement>) => {
  const columns = Math.max(1, Math.ceil(Math.sqrt(frames.length)));
  const rows = Math.ceil(frames.length / columns);
  const first = frames[0]!;
  const aspect = first.width / first.height;
  const landscape = aspect >= 1;
  const cellWidth = landscape
    ? Math.floor((SHEET_LONG_EDGE - SHEET_GUTTER * (columns + 1)) / columns)
    : Math.floor((SHEET_LONG_EDGE / aspect - SHEET_GUTTER * (columns + 1)) / columns);
  const cellHeight = Math.round(cellWidth / aspect);
  const sheet = document.createElement("canvas");
  sheet.width = columns * cellWidth + (columns + 1) * SHEET_GUTTER;
  sheet.height = rows * cellHeight + (rows + 1) * SHEET_GUTTER;
  const context = sheet.getContext("2d")!;
  context.fillStyle = "#101014";
  context.fillRect(0, 0, sheet.width, sheet.height);
  frames.forEach((frame, index) => {
    const x = SHEET_GUTTER + (index % columns) * (cellWidth + SHEET_GUTTER);
    const y = SHEET_GUTTER + Math.floor(index / columns) * (cellHeight + SHEET_GUTTER);
    context.save();
    context.translate(x, y);
    context.drawImage(frame, 0, 0, cellWidth, cellHeight);
    drawChip(context, String(index + 1), cellHeight);
    context.restore();
  });
  return sheet;
};

const formatDuration = (ms: number) => {
  const seconds = Math.round(ms / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
};

const summaryText = (
  recording: Pick<CaptureRecording, "session" | "durationMs">,
  lines: ReadonlyArray<NarrationLine>,
  cropped: boolean,
) => {
  const { app, windowTitle, bundlePath } = recording.session;
  const source = [app, windowTitle ? `“${windowTitle}”` : ""].filter(Boolean).join(" ") || "Screen";
  return [
    `[scrawl ${formatDuration(recording.durationMs)} · ${source} · ${bundlePath}]`,
    "Open contact-sheet.png and frames/ in that folder before changing anything: the marks and words only make sense on the images, which can show more than the text does.",
    ...(cropped ? ["Cropped to: the activity (full frames in frames-full/)"] : []),
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
  const box = activityBox({ input: { events, strokes } });

  const { video, dispose } = await loadVideo(recording.video);
  const frames: Array<HTMLCanvasElement> = [];
  const fullFrames: Array<HTMLCanvasElement> = [];
  const bytesOf = async (blob: Blob) => new Uint8Array(await blob.arrayBuffer());
  try {
    for (const [index, line] of lines.entries()) {
      const seconds = Math.max(0, (line.frameT - recording.videoOffsetMs) / 1000);
      await seekTo(video, Math.min(seconds, Math.max(0, video.duration - 0.05)));
      const full = document.createElement("canvas");
      full.width = video.videoWidth;
      full.height = video.videoHeight;
      const context = full.getContext("2d")!;
      context.drawImage(video, 0, 0);
      drawClickRings(context, line, full.width, full.height);
      drawMarkInk(context, line, marks, strokes, full.width, full.height);
      const name = `frame-${String(index + 1).padStart(2, "0")}.png`;
      if (box === null) {
        await write(`frames/${name}`, await bytesOf(await toBlob(full)));
        frames.push(full);
        continue;
      }
      await write(`frames-full/${name}`, await bytesOf(await toBlob(full)));
      fullFrames.push(full);
      const cropped = document.createElement("canvas");
      cropped.width = Math.round(box.width * full.width);
      cropped.height = Math.round(box.height * full.height);
      cropped
        .getContext("2d")!
        .drawImage(full, -Math.round(box.x * full.width), -Math.round(box.y * full.height));
      await write(`frames/${name}`, await bytesOf(await toBlob(cropped)));
      frames.push(cropped);
    }
  } finally {
    dispose();
  }

  const sheet = drawContactSheet(frames);
  const contactSheet = await toBlob(sheet);
  await write("contact-sheet.png", await bytesOf(contactSheet));
  if (fullFrames.length > 0) {
    await write(
      "contact-sheet-full.png",
      await bytesOf(await toBlob(drawContactSheet(fullFrames))),
    );
  }
  await write("audio.wav", recording.wav);

  const text = summaryText(recording, lines, box !== null);
  const encoder = new TextEncoder();
  await write("summary.md", encoder.encode(`${text}\n`));
  const { width, height } = recording.session;
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
    windows: [],
    cursor: [],
    ...(box === null
      ? {}
      : {
          autocrop: {
            label: "the activity",
            fullFrames: "frames-full",
            fullContactSheet: "contact-sheet-full.png",
            crops: lines.map((_line, index) => ({
              index: index + 1,
              x: Math.round(box.x * width),
              y: Math.round(box.y * height),
              width: Math.round(box.width * width),
              height: Math.round(box.height * height),
              kind: "focus",
              reason: "around the activity",
              apps: [recording.session.app],
            })),
          },
        }),
  };
  await write("scrawl.json", encoder.encode(JSON.stringify(manifest)));
  return { text, contactSheet, lines };
}
