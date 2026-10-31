// What `t3-scrawl` decides before any pixel moves: which moment, mark, crop and camera path. Pure,
// and read against the same scrawl.json as the Scrawl app's own CLI, so numbers and windows agree.

export type Rect = readonly [x0: number, y0: number, x1: number, y1: number];

export const FULL_RECT: Rect = [0, 0, 1, 1];

export interface BundleWord {
  readonly t0: number;
  readonly t1: number;
  readonly text: string;
}

export interface BundleMark {
  readonly id: string;
  readonly strokes: ReadonlyArray<number>;
  readonly t0: number;
  readonly t1: number;
  readonly shape?: string;
  readonly on?: string;
  readonly frame?: string;
  readonly pin?: number;
  readonly boxNorm?: readonly [number, number, number, number];
}

export interface BundleKeyframe {
  readonly index: number;
  readonly t: number;
  readonly file: string;
  readonly markId?: string;
}

export interface BundleStroke {
  readonly t0: number;
  readonly t1: number;
  /** Flat x, y, dt triples with positions in 0..=10000. */
  readonly pts: ReadonlyArray<number>;
}

export type BundleEvent =
  | {
      readonly kind: "click";
      readonly t: number;
      readonly x: number;
      readonly y: number;
    }
  | {
      readonly kind: "drag";
      readonly t: number;
      readonly t1: number;
      readonly x0: number;
      readonly y0: number;
      readonly x1: number;
      readonly y1: number;
    }
  | { readonly kind: string; readonly t?: number };

export interface BundleCrop {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly kind?: string;
}

export interface BundleManifest {
  readonly durationMs: number;
  readonly target: {
    readonly mode?: string;
    readonly frame: { readonly width: number; readonly height: number };
  };
  readonly transcript: {
    readonly words?: ReadonlyArray<BundleWord>;
    readonly segments?: ReadonlyArray<BundleWord>;
  };
  readonly strokes?: ReadonlyArray<BundleStroke>;
  readonly marks?: ReadonlyArray<BundleMark>;
  readonly events?: ReadonlyArray<BundleEvent>;
  readonly keyframes?: ReadonlyArray<BundleKeyframe>;
  readonly video?: string | null;
  readonly videoOffsetMs?: number;
  readonly audio?: string | null;
  /** Native captures record the screen with the ink on it; the Scrawl app's video has none. */
  readonly inkInVideo?: boolean;
  readonly autocrop?: { readonly crops?: ReadonlyArray<BundleCrop> } | null;
}

/** `0:12`, `12.5`, `12s` or `1500ms`; null when it is none of those. */
export const parseClockMs = (input: string): number | null => {
  const text = input.trim();
  const seconds = (value: string) => {
    const parsed = value.trim() === "" ? Number.NaN : Number(value);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
  };
  const colon = text.indexOf(":");
  if (colon >= 0) {
    const minutes = text.slice(0, colon);
    const rest = seconds(text.slice(colon + 1));
    if (!/^\d+$/.test(minutes) || rest === null) return null;
    return Number(minutes) * 60_000 + Math.round(rest * 1000);
  }
  if (text.endsWith("ms")) {
    const ms = text.slice(0, -2).trim();
    return /^\d+$/.test(ms) ? Number(ms) : null;
  }
  const rest = seconds(text.endsWith("s") ? text.slice(0, -1) : text);
  return rest === null ? null : Math.round(rest * 1000);
};

const pad = (value: number, width: number) => String(value).padStart(width, "0");

/** `0:09` */
export const shortClock = (ms: number) =>
  `${Math.floor(ms / 60_000)}:${pad(Math.floor(ms / 1000) % 60, 2)}`;

/** `1:01.234` */
export const preciseClock = (ms: number) => `${shortClock(ms)}.${pad(Math.round(ms) % 1000, 3)}`;

const normalize = (text: string) =>
  text
    .replace(/[^\p{L}\p{N}\s]/gu, "")
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);

const findPhraseMs = (manifest: BundleManifest, phrase: string): number | null => {
  const needle = normalize(phrase);
  if (needle.length === 0) return null;
  const words = manifest.transcript.words ?? [];
  const tokens = words.map((word) => normalize(word.text).join(""));
  const start = tokens.findIndex((_token, index) =>
    needle.every((part, offset) => tokens[index + offset] === part),
  );
  if (start >= 0) return words[start]!.t0;
  const joined = needle.join(" ");
  const segment = (manifest.transcript.segments ?? []).find((entry) =>
    normalize(entry.text).join(" ").includes(joined),
  );
  return segment?.t0 ?? null;
};

/** `--at`: a time or a phrase from the narration. */
export const resolveMoment = (manifest: BundleManifest, at: string): number => {
  const moment = parseClockMs(at) ?? findPhraseMs(manifest, at);
  if (moment === null) throw new Error(`“${at}” is neither a time nor a phrase in the narration`);
  return moment;
};

const clamp = (value: number, low: number, high: number) => Math.min(Math.max(value, low), high);

const fitWindow = (from: number, span: number, durationMs: number): readonly [number, number] => {
  const to = from + span;
  return to > durationMs ? [Math.max(0, durationMs - span), durationMs] : [from, to];
};

/** A quarter before the moment and the rest after: what is said is usually about to happen. */
export const momentWindow = (atMs: number, spanMs: number, durationMs: number) => {
  const span = clamp(spanMs, 200, Math.max(durationMs, 200));
  return fitWindow(Math.max(0, atMs - Math.floor(span / 4)), span, durationMs);
};

/** Centred on a mark, at least `spanMs`, and the whole mark with half a second either side. */
export const markWindow = (t0: number, t1: number, spanMs: number, durationMs: number) => {
  const span = clamp(Math.max(spanMs, t1 - t0 + 1000), 200, Math.max(durationMs, 200));
  const middle = Math.floor((t0 + t1) / 2);
  return fitWindow(Math.max(0, middle - Math.floor(span / 2)), span, durationMs);
};

const MAX_SHEET_FRAMES = 48;

/** Evenly spaced across the window, both ends included. */
export const sampleTimes = (from: number, to: number, count: number): ReadonlyArray<number> => {
  const cells = clamp(Math.trunc(count), 1, MAX_SHEET_FRAMES);
  if (cells === 1 || to <= from) return [from];
  return Array.from(
    { length: cells },
    (_unused, index) => from + Math.floor(((to - from) * index) / (cells - 1)),
  );
};

/** One PNG per `1000 / fps` milliseconds, from the first moment on. */
export const rangeTimes = (from: number, to: number, fps: number): ReadonlyArray<number> => {
  const step = Math.max(1, Math.floor(1000 / fps));
  const times: Array<number> = [];
  for (let t = from; t <= to; t += step) times.push(t);
  return times;
};

export const saidBetween = (manifest: BundleManifest, from: number, to: number) => {
  const overlapping = (entry: BundleWord) => entry.t1 >= from && entry.t0 <= to;
  const words = (manifest.transcript.words ?? []).filter(overlapping);
  const source =
    words.length > 0 ? words : (manifest.transcript.segments ?? []).filter(overlapping);
  return source.map((entry) => entry.text.trim()).join(" ");
};

const CIRCLED = "①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳";
const circled = (number: number) => CIRCLED[number - 1] ?? `(${number})`;

export interface MarkEntry {
  readonly mark: BundleMark;
  readonly keyframe: number | null;
  readonly number: number;
  readonly numbered: boolean;
}

const markOnKeyframe = (mark: BundleMark, keyframe: BundleKeyframe) =>
  keyframe.markId === mark.id || (keyframe.file !== "" && mark.frame === keyframe.file);

/** Every mark in time order, numbered the way the text numbers them. */
export const markEntries = (manifest: BundleManifest): ReadonlyArray<MarkEntry> => {
  const marks = manifest.marks ?? [];
  const keyframes = manifest.keyframes ?? [];
  const entries = marks.map((mark) => {
    const keyframe = keyframes.find((candidate) => markOnKeyframe(mark, candidate));
    const shown = keyframe
      ? marks
          .filter((other) => other.strokes.length > 0 && markOnKeyframe(other, keyframe))
          .toSorted((left, right) => left.t0 - right.t0)
      : [];
    const position = shown.indexOf(mark);
    return {
      mark,
      keyframe: keyframe?.index ?? null,
      number: position >= 0 ? position + 1 : 1,
      numbered: position >= 0 && shown.length >= 2,
    };
  });
  const sorted = entries.toSorted((left, right) => left.mark.t0 - right.mark.t0);
  // With no keyframe naming its marks, one running count is what still tells them apart.
  return sorted.length > 1 && sorted.every((entry) => entry.keyframe === null)
    ? sorted.map((entry, index) => ({ ...entry, number: index + 1, numbered: true }))
    : sorted;
};

const markVerbs: Record<string, string> = {
  circle: "circled",
  underline: "underlined",
  line: "drew a line",
  arrow: "drew an arrow",
  tap: "tapped",
  mark: "marked",
  flag: "flagged this moment",
};

const markText = (mark: BundleMark) => {
  const shape = mark.shape ?? "mark";
  const verb = shape === "pin" ? `pin ${mark.pin ?? 1}` : (markVerbs[shape] ?? "marked");
  const on = mark.on?.trim();
  const joiner =
    shape === "arrow" ? " pointing to " : shape === "pin" || shape === "line" ? " on " : " ";
  const strokes = mark.strokes.length > 1 ? ` (${mark.strokes.length} strokes)` : "";
  return `${verb}${on ? `${joiner}“${on}”` : ""}${strokes}`;
};

/** `#2 ✎② 0:09 marked (2 strokes) · m2` */
export const markLine = (entry: MarkEntry) => {
  const frame = entry.keyframe === null ? "#-" : `#${entry.keyframe}`;
  const number = entry.numbered ? circled(entry.number) : "";
  return `${frame} ✎${number} ${shortClock(entry.mark.t0)} ${markText(entry.mark)} · ${entry.mark.id}`;
};

export const markJson = (entry: MarkEntry) => ({
  keyframe: entry.keyframe,
  number: entry.number,
  numbered: entry.numbered,
  id: entry.mark.id,
  t0: entry.mark.t0,
  t1: entry.mark.t1,
  time: shortClock(entry.mark.t0),
  shape: entry.mark.shape ?? "mark",
  on: entry.mark.on ?? null,
  strokes: entry.mark.strokes.length,
  text: markText(entry.mark),
  frame: entry.mark.frame ?? null,
});

/** The mark `query` names: its id, or its number as the text shows it, on `keyframe` when given. */
export const findMark = (
  manifest: BundleManifest,
  query: string,
  keyframe: number | undefined,
): MarkEntry => {
  const entries = markEntries(manifest);
  const wanted = query.trim();
  const byId = entries.find((entry) => entry.mark.id === wanted);
  if (byId !== undefined) return byId;
  const circledAt = CIRCLED.indexOf(wanted);
  const number = /^\d+$/.test(wanted) ? Number(wanted) : circledAt >= 0 ? circledAt + 1 : null;
  if (number === null) throw new Error(`“${wanted}” is neither a mark number nor a mark id`);
  const onFrame = entries.filter(
    (entry) => entry.number === number && (keyframe === undefined || entry.keyframe === keyframe),
  );
  const shown = onFrame.filter((entry) => entry.numbered);
  const candidates = shown.length > 0 ? shown : onFrame;
  if (candidates.length === 1) return candidates[0]!;
  if (candidates.length === 0) {
    throw new Error(
      keyframe === undefined
        ? `No mark ${circled(number)} in this bundle`
        : `Keyframe #${keyframe} has no mark ${circled(number)}`,
    );
  }
  throw new Error(
    `Mark ${circled(number)} is on several keyframes (${candidates.map(markLine).join("; ")}); add --frame <N> or use the mark id`,
  );
};

const cropRect = (manifest: BundleManifest, crop: BundleCrop | undefined): Rect | null => {
  if (crop === undefined || crop.kind === "full") return null;
  const { width, height } = manifest.target.frame;
  return [
    crop.x / width,
    crop.y / height,
    (crop.x + crop.width) / width,
    (crop.y + crop.height) / height,
  ];
};

/** The auto-crop of the keyframe nearest `t`; keyframe crops meet halfway between keyframes. */
export const cropAt = (manifest: BundleManifest, t: number): Rect | null => {
  const keyframes = manifest.keyframes ?? [];
  let nearest = -1;
  keyframes.forEach((keyframe, index) => {
    if (nearest < 0 || Math.abs(keyframe.t - t) < Math.abs(keyframes[nearest]!.t - t)) {
      nearest = index;
    }
  });
  return cropRect(manifest, manifest.autocrop?.crops?.[nearest]);
};

/** The auto-crop of the keyframe a mark belongs to, whose crop holds its ink. */
export const cropOfKeyframe = (manifest: BundleManifest, keyframeIndex: number): Rect | null => {
  const position = (manifest.keyframes ?? []).findIndex((entry) => entry.index === keyframeIndex);
  return position < 0 ? null : cropRect(manifest, manifest.autocrop?.crops?.[position]);
};

/** `--crop auto`: every keyframe's crop together, or the whole capture without any. */
export const autoCrop = (manifest: BundleManifest): Rect => {
  const crops = (manifest.autocrop?.crops ?? []).map((crop) => cropRect(manifest, crop));
  if (crops.length === 0 || crops.includes(null)) return FULL_RECT;
  const rects = crops as ReadonlyArray<Rect>;
  return [
    clamp(Math.min(...rects.map((rect) => rect[0])), 0, 1),
    clamp(Math.min(...rects.map((rect) => rect[1])), 0, 1),
    clamp(Math.max(...rects.map((rect) => rect[2])), 0, 1),
    clamp(Math.max(...rects.map((rect) => rect[3])), 0, 1),
  ];
};

/** `full`, `auto`, or `x,y,w,h` as fractions of the capture (all ≤ 1) or pixels of the video. */
export const resolveCrop = (
  arg: string,
  manifest: BundleManifest,
  videoWidth: number,
  videoHeight: number,
): Rect => {
  const text = arg.trim();
  if (text === "full") return FULL_RECT;
  if (text === "auto") return autoCrop(manifest);
  const parts = text.split(",").map((part) => (part.trim() === "" ? Number.NaN : Number(part)));
  const [x, y, width, height] = parts;
  if (
    parts.length !== 4 ||
    x === undefined ||
    y === undefined ||
    width === undefined ||
    height === undefined ||
    parts.some((part) => !Number.isFinite(part) || part < 0) ||
    width <= 0 ||
    height <= 0
  ) {
    throw new Error(`A crop is full, auto, or x,y,w,h (four positive numbers); got “${text}”`);
  }
  const inPixels = parts.some((part) => part > 1);
  const rect: Rect = inPixels
    ? [x / videoWidth, y / videoHeight, (x + width) / videoWidth, (y + height) / videoHeight]
    : [x, y, x + width, y + height];
  if (rect[2] > 1.0001 || rect[3] > 1.0001) {
    throw new Error("The crop runs past the edge of the recording");
  }
  const clipped: Rect = [rect[0], rect[1], Math.min(rect[2], 1), Math.min(rect[3], 1)];
  if ((clipped[2] - clipped[0]) * videoWidth < 16 || (clipped[3] - clipped[1]) * videoHeight < 16) {
    throw new Error("The crop is smaller than 16 px");
  }
  return clipped;
};

const even = (value: number) => Math.max(Math.round(value / 2) * 2, 2);

/** The crop's aspect, even sides for H.264, long edge at most `cap`, and never scaled up. */
export const outputSize = (cropWidth: number, cropHeight: number, cap: number) => {
  if (cap < 64) throw new Error("--size must be at least 64");
  const scale = Math.min(cap / Math.max(cropWidth, cropHeight), 1);
  return { width: even(cropWidth * scale), height: even(cropHeight * scale) };
};

const ZOOM_SCALE = 1.8;
const MIN_ZOOM_SCALE = 1.5;
const FIT_FRACTION = 0.7;
const LEAD_MS = 350;
const HOLD_MS = 2500;
const SPRING_OMEGA = (2 * Math.PI) / (1.2 * 0.9);
const CAMERA_STEP_MS = 1000 / 60;

interface Activity {
  readonly t0: number;
  readonly t1: number;
  readonly box: Rect;
}

const activities = (manifest: BundleManifest, crop: Rect): ReadonlyArray<Activity> => {
  const width = crop[2] - crop[0];
  const height = crop[3] - crop[1];
  const toCrop = (x0: number, y0: number, x1: number, y1: number): Rect => [
    clamp((Math.min(x0, x1) - crop[0]) / width, 0, 1),
    clamp((Math.min(y0, y1) - crop[1]) / height, 0, 1),
    clamp((Math.max(x0, x1) - crop[0]) / width, 0, 1),
    clamp((Math.max(y0, y1) - crop[1]) / height, 0, 1),
  ];
  const found: Array<Activity> = [];
  for (const event of manifest.events ?? []) {
    if (event.kind === "click" && "x" in event) {
      found.push({ t0: event.t, t1: event.t, box: toCrop(event.x, event.y, event.x, event.y) });
    } else if (event.kind === "drag" && "x0" in event) {
      found.push({
        t0: event.t,
        t1: event.t1,
        box: toCrop(event.x0, event.y0, event.x1, event.y1),
      });
    }
  }
  for (const mark of manifest.marks ?? []) {
    if (mark.boxNorm === undefined) continue;
    const [x0, y0, x1, y1] = mark.boxNorm;
    found.push({ t0: mark.t0, t1: mark.t1, box: toCrop(x0, y0, x1, y1) });
  }
  return found.toSorted((left, right) => left.t0 - right.t0);
};

interface CameraSegment {
  readonly start: number;
  readonly release: number;
  readonly scale: number;
  readonly center: readonly [number, number];
}

const cameraSegments = (found: ReadonlyArray<Activity>): ReadonlyArray<CameraSegment> => {
  const clusters: Array<{ t0: number; t1: number; box: [number, number, number, number] }> = [];
  for (const activity of found) {
    const open = clusters.at(-1);
    if (open !== undefined && activity.t0 - open.t1 <= HOLD_MS) {
      open.t1 = Math.max(open.t1, activity.t1);
      open.box = [
        Math.min(open.box[0], activity.box[0]),
        Math.min(open.box[1], activity.box[1]),
        Math.max(open.box[2], activity.box[2]),
        Math.max(open.box[3], activity.box[3]),
      ];
    } else {
      clusters.push({ t0: activity.t0, t1: activity.t1, box: [...activity.box] });
    }
  }
  return clusters.map(({ t0, t1, box }) => {
    const span = Math.max(box[2] - box[0], box[3] - box[1]);
    const fitted = span > 0 ? Math.min(ZOOM_SCALE, FIT_FRACTION / span) : ZOOM_SCALE;
    return {
      start: Math.max(0, t0 - LEAD_MS),
      release: t1 + HOLD_MS,
      // Activity wider than this leaves the view as it is: a small zoom only looks like a mistake.
      scale: fitted < MIN_ZOOM_SCALE ? 1 : fitted,
      center: [(box[0] + box[2]) / 2, (box[1] + box[3]) / 2],
    };
  });
};

const spring = (position: number, velocity: number, target: number, dt: number) => {
  const distance = position - target;
  const pull = velocity + SPRING_OMEGA * distance;
  const decay = Math.exp(-SPRING_OMEGA * dt);
  return [
    target + (distance + pull * dt) * decay,
    (velocity - SPRING_OMEGA * pull * dt) * decay,
  ] as const;
};

/**
 * `--zoom`: eases toward clicks, drags and marks, holds while activity stays nearby and eases out.
 * Critically damped springs on the view's scale and offset, so a zoom travels as one move with no
 * bounce. One rectangle of the capture per output frame.
 */
export const cameraPath = (
  manifest: BundleManifest,
  crop: Rect,
  videoOffsetMs: number,
  frameCount: number,
  fps: number,
): ReadonlyArray<Rect> => {
  const segments = cameraSegments(activities(manifest, crop));
  let scale = 1;
  let scaleSpeed = 0;
  let offsetX = 0;
  let offsetXSpeed = 0;
  let offsetY = 0;
  let offsetYSpeed = 0;
  const rects: Array<Rect> = [];
  const width = crop[2] - crop[0];
  const height = crop[3] - crop[1];
  let clockMs = 0;
  const dt = CAMERA_STEP_MS / 1000;
  for (let frame = 0; frame < frameCount; frame++) {
    const untilMs = videoOffsetMs + (frame * 1000) / fps;
    while (clockMs <= untilMs) {
      const active = segments.findLast(
        (segment) => segment.start <= clockMs && clockMs < segment.release && segment.scale > 1,
      );
      const targetScale = active?.scale ?? 1;
      const targetOffset = (focus: number) => clamp(0.5 - targetScale * focus, 1 - targetScale, 0);
      [scale, scaleSpeed] = spring(scale, scaleSpeed, targetScale, dt);
      [offsetX, offsetXSpeed] = spring(
        offsetX,
        offsetXSpeed,
        targetOffset(active?.center[0] ?? 0.5),
        dt,
      );
      [offsetY, offsetYSpeed] = spring(
        offsetY,
        offsetYSpeed,
        targetOffset(active?.center[1] ?? 0.5),
        dt,
      );
      if (scale < 1) {
        scale = 1;
        scaleSpeed = 0;
      }
      offsetX = clamp(offsetX, 1 - scale, 0);
      offsetY = clamp(offsetY, 1 - scale, 0);
      clockMs += CAMERA_STEP_MS;
    }
    const viewX = -offsetX / scale;
    const viewY = -offsetY / scale;
    rects.push([
      crop[0] + viewX * width,
      crop[1] + viewY * height,
      crop[0] + (viewX + 1 / scale) * width,
      crop[1] + (viewY + 1 / scale) * height,
    ]);
  }
  return rects;
};
