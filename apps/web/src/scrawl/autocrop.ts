// Crops each keyframe to where its moment happened, from the ink, clicks, what changed on screen
// and, when logged, the cursor and windows. Rules and numbers are Scrawl's (src/autocrop.rs), tuned
// there on a corpus and real captures. Rects are fractions of the capture; sizes are its points.

import { refineCropEdges, type ContentMap } from "./autocropContent";

export type Rect = readonly [number, number, number, number];
export const FULL: Rect = [0, 0, 1, 1];

const SNAP_THRESHOLD = 0.8;
const MAX_WINDOWS = 2;
const MIN_SHARE = 0.1;
// A window bigger than this is no crop; focus on the activity inside it.
const BIG_WINDOW = 0.6;
const CONTEXT = 0.15;
const MIN_SIZE: readonly [number, number] = [320, 200];
const MAX_ZOOM = 4;
// Resting the cursor after drawing must not outvote the drawing.
const PASSIVE_CAP = 0.5;
const MIN_DWELL_S = 0.15;
const HIT_SLOP = 24;
const OUTLIER = 0.12;
const MERGE_IOU = 0.6;
// Crops covering more than this aren't worth it: keep the full frame.
const FULL_ABOVE = 0.85;
const CAUSE_REACH = 40;
const OVERLAY_AREA = 0.85;
const MENU_BAR_LAYER = 24;
const DOCK_LAYER = 20;
const CHROME_MARGIN = 40;

export type ActivityKind = "stroke" | "click" | "drag" | "scroll" | "cursor" | "change";

const WEIGHTS: Record<Exclude<ActivityKind, "cursor" | "change">, number> = {
  stroke: 1,
  click: 0.6,
  drag: 0.6,
  scroll: 0.3,
};
const CURSOR_WEIGHT = 0.15;
const CHANGE_WEIGHT = 0.1;

const isDeliberate = (kind: ActivityKind) => kind !== "cursor" && kind !== "change";

export interface ActivityItem {
  readonly kind: ActivityKind;
  readonly t0: number;
  readonly t1: number;
  readonly points: ReadonlyArray<readonly [x: number, y: number, t: number]>;
  /** Seconds the cursor rested here; for a change, the square root of its area. */
  readonly dwell: number;
  /** Belongs to this keyframe alone, whenever it happened. */
  readonly keyframe?: number;
}

export interface CaptureWindow {
  readonly id: number;
  readonly app: string;
  readonly rect: Rect;
  readonly layer: number;
  readonly regular: boolean;
  readonly frontmost: boolean;
}

export interface WindowSnapshot {
  readonly t: number;
  /** Front to back. */
  readonly windows: ReadonlyArray<CaptureWindow>;
}

export interface AutocropInput {
  /** The capture's size in points. */
  readonly screen: readonly [number, number];
  readonly durationMs: number;
  readonly keyframes: ReadonlyArray<number>;
  readonly items: ReadonlyArray<ActivityItem>;
  readonly snapshots?: ReadonlyArray<WindowSnapshot>;
  /** One per keyframe: where its screen has something on it, for moving crop edges. */
  readonly content?: ReadonlyArray<ContentMap | null>;
}

export type CropKind = "window" | "windows" | "focus" | "activity" | "fallback" | "full";

export interface Crop {
  readonly rect: Rect;
  readonly kind: CropKind;
  /** Why, for people (no window titles). */
  readonly reason: string;
  readonly apps: ReadonlyArray<string>;
  /** The activity itself, which moving an edge must keep. */
  readonly need?: Rect;
  /** The window a focus crop sits in. */
  readonly within?: Rect;
}

const area = (r: Rect) => Math.max(0, r[2] - r[0]) * Math.max(0, r[3] - r[1]);
const union = (a: Rect, b: Rect): Rect => [
  Math.min(a[0], b[0]),
  Math.min(a[1], b[1]),
  Math.max(a[2], b[2]),
  Math.max(a[3], b[3]),
];
const intersect = (a: Rect, b: Rect): Rect => [
  Math.max(a[0], b[0]),
  Math.max(a[1], b[1]),
  Math.min(a[2], b[2]),
  Math.min(a[3], b[3]),
];
const clipToScreen = (r: Rect) => intersect(r, FULL);
const unionWith = (a: Rect | null, b: Rect) => (a === null ? b : union(a, b));
const overlap = (a: Rect, b: Rect) => {
  const shared = area(intersect(a, b));
  const total = area(a) + area(b) - shared;
  return total <= 0 ? 0 : shared / total;
};
const containsRect = (outer: Rect, inner: Rect) =>
  inner[0] >= outer[0] - 1e-4 &&
  inner[1] >= outer[1] - 1e-4 &&
  inner[2] <= outer[2] + 1e-4 &&
  inner[3] <= outer[3] + 1e-4;
const isFull = (r: Rect) => r[0] <= 0 && r[1] <= 0 && r[2] >= 1 && r[3] >= 1;
const boxOf = (points: ReadonlyArray<readonly [number, number]>): Rect | null => {
  let box: Rect | null = null;
  for (const [x, y] of points) box = unionWith(box, [x, y, x, y]);
  return box;
};

const isChrome = (win: CaptureWindow) =>
  (win.layer === MENU_BAR_LAYER && win.app === "Window Server") ||
  (win.layer === DOCK_LAYER && win.app === "Dock");
const chromeLabel = (win: CaptureWindow) => (win.layer === MENU_BAR_LAYER ? "menu bar" : "dock");

/** A snapshot in the shape `scrawl.json` keeps it: bounds are points, `[x, y, width, height]`. */
export interface LoggedWindows {
  readonly t: number;
  readonly windows: ReadonlyArray<{
    readonly id: number;
    readonly app: string;
    readonly bounds: readonly [number, number, number, number];
    readonly layer: number;
    readonly regular?: boolean;
    readonly frontmost?: boolean;
  }>;
}

export const windowSnapshots = (
  logged: ReadonlyArray<LoggedWindows>,
  [width, height]: readonly [number, number],
): Array<WindowSnapshot> =>
  logged.map((snapshot) => ({
    t: snapshot.t,
    windows: snapshot.windows.map((win) => {
      const [x, y, w, h] = win.bounds;
      return {
        id: win.id,
        app: win.app,
        rect: [x / width, y / height, (x + w) / width, (y + h) / height],
        layer: win.layer,
        regular: win.regular ?? true,
        frontmost: win.frontmost ?? false,
      };
    }),
  }));

/** Evenly spaced picks, so a long stroke does not cost more than its shape needs. */
const subsample = <T>(values: ReadonlyArray<T>, max: number): ReadonlyArray<T> => {
  if (values.length <= max || max < 2) return values;
  const spread = values.length - 1;
  return Array.from(
    { length: max },
    (_, i) => values[Math.trunc((i * spread + Math.trunc((max - 1) / 2)) / (max - 1))]!,
  );
};

const weightOf = (item: ActivityItem) => {
  if (item.kind === "cursor") return CURSOR_WEIGHT * item.dwell;
  if (item.kind === "change") {
    return CHANGE_WEIGHT * Math.min(1, Math.max(0.2, item.dwell * 3));
  }
  return WEIGHTS[item.kind];
};

interface WeightedPoint {
  readonly x: number;
  readonly y: number;
  readonly t: number;
  weight: number;
  readonly dwell: number;
  readonly kind: ActivityKind;
  outlier: boolean;
}

function weightedMedian(points: ReadonlyArray<WeightedPoint>, key: "x" | "y") {
  const sorted = points.toSorted((a, b) => a[key] - b[key]);
  const half = sorted.reduce((sum, point) => sum + point.weight, 0) / 2;
  let total = 0;
  for (const point of sorted) {
    total += point.weight;
    if (total >= half) return point[key];
  }
  return sorted.at(-1)?.[key] ?? 0.5;
}

const appsOf = (windows: ReadonlyArray<CaptureWindow>) => [
  ...new Set(windows.map((win) => win.app)),
];

export function computeCrops(input: AutocropInput): Array<Crop> {
  const count = input.keyframes.length;
  if (count === 0) return [];
  const sw = Math.max(1, input.screen[0]);
  const sh = Math.max(1, input.screen[1]);
  const snapshots = input.snapshots ?? [];

  const windowsAt = (t: number): ReadonlyArray<CaptureWindow> => {
    const first = snapshots[0];
    if (first === undefined) return [];
    let snapshot = first;
    for (const candidate of snapshots) {
      if (candidate.t > t) break;
      snapshot = candidate;
    }
    // Agent apps' overlays cover the screen without being what the capture is about.
    return snapshot.windows.filter(
      (win) => win.regular || win.layer !== 0 || area(clipToScreen(win.rect)) <= OVERLAY_AREA,
    );
  };

  const pad = (r: Rect, points: number): Rect => [
    r[0] - points / sw,
    r[1] - points / sh,
    r[2] + points / sw,
    r[3] + points / sh,
  ];
  const withMargin = (core: Rect, within: Rect) =>
    pad(core, CONTEXT * Math.sqrt((within[2] - within[0]) * sw * ((within[3] - within[1]) * sh)));

  /** Minimum size and maximum zoom (only ever growing), kept on screen and, if it fits, in `within`. */
  const shape = (r: Rect, within: Rect = FULL): Rect => {
    let w = Math.max(r[2] - r[0], 1e-4) * sw;
    let h = Math.max(r[3] - r[1], 1e-4) * sh;
    w = Math.max(w, Math.min(MIN_SIZE[0], sw));
    h = Math.max(h, Math.min(MIN_SIZE[1], sh));
    const need = 1 / MAX_ZOOM;
    const cover = Math.max(w / sw, h / sh);
    if (cover < need) {
      w *= need / cover;
      h *= need / cover;
    }
    const width = Math.min(w / sw, 1);
    const height = Math.min(h / sh, 1);
    const keep = (center: number, half: number, low: number, high: number) => {
      const fits = high - low >= 2 * half;
      return Math.min(Math.max(center, (fits ? low : 0) + half), (fits ? high : 1) - half);
    };
    const cx = keep((r[0] + r[2]) / 2, width / 2, Math.max(within[0], 0), Math.min(within[2], 1));
    const cy = keep((r[1] + r[3]) / 2, height / 2, Math.max(within[1], 0), Math.min(within[3], 1));
    return [cx - width / 2, cy - height / 2, cx + width / 2, cy + height / 2];
  };
  const fullIfBig = (r: Rect) => (area(r) >= FULL_ABOVE ? FULL : r);

  const sliceOf = (k: number): readonly [number, number] => {
    const t = input.keyframes[k]!;
    const before = k === 0 ? 0 : (input.keyframes[k - 1]! + t) / 2;
    const after =
      k + 1 === count ? Math.max(input.durationMs, t) : (t + input.keyframes[k + 1]!) / 2;
    return [before, after];
  };

  const cropAround = (k: number): Crop | null => {
    const slice = sliceOf(k);
    const atKeyframe = windowsAt(input.keyframes[k]!);
    const points: Array<WeightedPoint> = [];
    for (const item of input.items) {
      const inSlice = item.t1 >= slice[0] && item.t0 <= slice[1];
      if (item.keyframe === undefined ? !inSlice : item.keyframe !== k) continue;
      const weight = weightOf(item);
      if (weight <= 0 || item.points.length === 0) continue;
      for (const [x, y, t] of item.points) {
        points.push({
          x,
          y,
          t,
          weight: weight / item.points.length,
          dwell: item.dwell,
          kind: item.kind,
          outlier: false,
        });
      }
    }
    const anchors = subsample(
      points.filter((point) => isDeliberate(point.kind)),
      300,
    );
    const diagonal = Math.hypot(sw, sh);
    const distance = (a: { x: number; y: number }, x: number, y: number) =>
      Math.hypot((a.x - x) * sw, (a.y - y) * sh) / diagonal;
    const cursor = points.filter((point) => point.kind === "cursor");
    const middle =
      anchors.length === 0 && cursor.length > 0
        ? { x: weightedMedian(cursor, "x"), y: weightedMedian(cursor, "y") }
        : null;
    for (const point of cursor) {
      const away =
        middle !== null
          ? distance(point, middle.x, middle.y)
          : anchors.reduce((best, a) => Math.min(best, distance(point, a.x, a.y)), Infinity);
      point.outlier = away > OUTLIER;
    }
    const sumOf = (test: (point: WeightedPoint) => boolean) =>
      points.reduce((sum, point) => sum + (test(point) ? point.weight : 0), 0);
    const deliberate = sumOf((point) => isDeliberate(point.kind));
    const passive = sumOf((point) => !isDeliberate(point.kind) && !point.outlier);
    if (deliberate > 0 && passive > PASSIVE_CAP * deliberate) {
      const factor = (PASSIVE_CAP * deliberate) / passive;
      for (const point of points) {
        if (!isDeliberate(point.kind)) point.weight *= factor;
      }
    }

    const slopX = HIT_SLOP / sw;
    const slopY = HIT_SLOP / sh;
    const shares = new Map<number, { weight: number; win: CaptureWindow }>();
    const chromeHits = new Map<
      number,
      { win: CaptureWindow; hits: Array<readonly [number, number]> }
    >();
    const addShare = (win: CaptureWindow, weight: number) => {
      const now = atKeyframe.find((other) => other.id === win.id) ?? win;
      const share = shares.get(win.id) ?? { weight: 0, win: now };
      share.weight += weight;
      shares.set(win.id, share);
    };
    const kept: Array<WeightedPoint> = [];
    let panels: Rect | null = null;
    let total = 0;
    for (const point of points) {
      if (point.outlier) continue;
      const windows = windowsAt(point.t);
      const inside = (win: CaptureWindow, mx: number, my: number) =>
        point.x >= win.rect[0] - mx &&
        point.x <= win.rect[2] + mx &&
        point.y >= win.rect[1] - my &&
        point.y <= win.rect[3] + my;
      const hit =
        windows.find((win) => inside(win, 0, 0)) ??
        windows.find((win) => !isChrome(win) && inside(win, slopX, slopY));
      if (hit !== undefined && isChrome(hit)) {
        if (!isDeliberate(point.kind)) continue;
        const entry = chromeHits.get(hit.id) ?? { win: hit, hits: [] };
        entry.hits.push([point.x, point.y]);
        chromeHits.set(hit.id, entry);
        total += point.weight;
        // The menu bar is the frontmost app's: it counts for that app's window.
        const front = windows.find((win) => win.frontmost && !isChrome(win));
        if (hit.layer === MENU_BAR_LAYER && front !== undefined) addShare(front, point.weight);
        continue;
      }
      total += point.weight;
      kept.push(point);
      if (hit === undefined) continue;
      // A menu or panel belongs to its app's window, and the crop grows to show it.
      const owner =
        hit.layer !== 0 ? windows.find((win) => win.layer === 0 && win.app === hit.app) : undefined;
      if (owner !== undefined && (isDeliberate(point.kind) || point.dwell >= MIN_DWELL_S)) {
        panels = unionWith(panels, clipToScreen(hit.rect));
      }
      addShare(owner ?? hit, point.weight);
    }
    if (total <= 0) return null;

    const ranked = [...shares.values()].toSorted(
      (a, b) => b.weight - a.weight || a.win.id - b.win.id,
    );
    const positions = (test: (point: WeightedPoint) => boolean) =>
      kept.filter(test).map((point) => [point.x, point.y] as const);
    // Deliberate input and where the cursor rested; what changed only when there is nothing else.
    const ink = boxOf(positions((point) => isDeliberate(point.kind)));
    const rested = boxOf(
      positions(
        (point) =>
          isDeliberate(point.kind) || (point.kind === "cursor" && point.dwell >= MIN_DWELL_S),
      ),
    );
    // Changes near a click, drag or scroll are what it did: the scrolled page, a popover.
    const pokes = points.filter(
      (point) => point.kind === "click" || point.kind === "drag" || point.kind === "scroll",
    );
    const reachX = CAUSE_REACH / sw;
    const reachY = CAUSE_REACH / sh;
    let caused: Rect | null = null;
    for (const item of input.items) {
      if (item.kind !== "change" || item.keyframe !== k) continue;
      const box = boxOf(item.points.map(([x, y]) => [x, y] as const))!;
      const near = pokes.some(
        ({ x, y }) =>
          x >= box[0] - reachX &&
          x <= box[2] + reachX &&
          y >= box[1] - reachY &&
          y <= box[3] + reachY,
      );
      if (near) caused = unionWith(caused, box);
    }
    const activity =
      (rested !== null && caused !== null ? union(rested, caused) : (rested ?? caused)) ??
      boxOf(positions(() => true));

    let snapped: ReadonlyArray<CaptureWindow> = [];
    let held = 0;
    for (const [index, { weight }] of ranked.slice(0, MAX_WINDOWS).entries()) {
      if (index > 0 && weight / total < MIN_SHARE) break;
      held += weight / total;
      if (held >= SNAP_THRESHOLD) {
        snapped = ranked.slice(0, index + 1).map(({ win }) => win);
        break;
      }
    }
    const percent = Math.round(held * 100);
    let within = FULL;
    let rect: Rect;
    let kind: CropKind;
    let reason: string;
    let apps: ReadonlyArray<string>;
    if (snapped.length > 0) {
      const box = snapped.reduce<Rect | null>(
        (r, win) => unionWith(r, clipToScreen(win.rect)),
        null,
      )!;
      apps = appsOf(snapped);
      if (area(box) <= BIG_WINDOW) {
        rect = box;
        kind = snapped.length === 1 ? "window" : "windows";
        reason =
          snapped.length === 1
            ? `${snapped[0]!.app} (${percent}% of the activity)`
            : `${snapped.length} windows: ${apps.join(" + ")} (${percent}% of the activity)`;
      } else {
        rect = intersect(withMargin(activity ?? box, box), box);
        within = box;
        kind = "focus";
        reason = `around the activity in ${apps.join(" + ")}`;
      }
    } else {
      rect = withMargin(activity ?? ink ?? FULL, FULL);
      kind = "activity";
      reason = "around the activity";
      apps = appsOf(ranked.slice(0, 2).map(({ win }) => win));
    }
    if (ink !== null && !containsRect(rect, ink)) {
      rect = union(rect, ink);
      reason += " + input outside it";
    }
    if (panels !== null && !containsRect(rect, panels)) {
      rect = union(rect, panels);
      reason += " + its menu";
    }
    for (const { win, hits } of chromeHits.values()) {
      const r = clipToScreen(win.rect);
      const box = boxOf(hits)!;
      const horizontal = (r[2] - r[0]) * sw >= (r[3] - r[1]) * sh;
      rect = union(
        rect,
        horizontal
          ? [box[0] - CHROME_MARGIN / sw, r[1], box[2] + CHROME_MARGIN / sw, r[3]]
          : [r[0], box[1] - CHROME_MARGIN / sh, r[2], box[3] + CHROME_MARGIN / sh],
      );
      reason += ` + ${chromeLabel(win)}`;
    }
    rect = fullIfBig(shape(rect, within));
    return {
      rect,
      kind: isFull(rect) ? "full" : kind,
      reason,
      apps,
      ...(activity === null ? {} : { need: activity }),
      ...(kind === "focus" ? { within } : {}),
    };
  };

  const frontmostWindow = (t: number) => {
    const normal = windowsAt(t).filter((win) => !isChrome(win));
    return normal.find((win) => win.frontmost) ?? normal.find((win) => win.regular);
  };

  // Nothing happened in this keyframe's slice: the nearest crop, else the frontmost window.
  const fallback = (k: number, nearest: Crop | undefined): Crop => {
    if (nearest !== undefined) {
      return {
        rect: nearest.rect,
        kind: isFull(nearest.rect) ? "full" : "fallback",
        reason: "talk only: the previous crop",
        apps: nearest.apps,
      };
    }
    const front = frontmostWindow(input.keyframes[k]!);
    if (front !== undefined) {
      const rect = fullIfBig(shape(clipToScreen(front.rect)));
      if (!isFull(rect) && area(clipToScreen(front.rect)) <= BIG_WINDOW) {
        return {
          rect,
          kind: "fallback",
          reason: `talk only: the frontmost window (${front.app})`,
          apps: [front.app],
        };
      }
    }
    return { rect: FULL, kind: "full", reason: "talk only: the whole screen", apps: [] };
  };

  const raw = input.keyframes.map((_t, k) => cropAround(k));
  const crops = raw.map(
    (crop, k): Crop =>
      crop ??
      fallback(
        k,
        raw.slice(0, k).findLast((other) => other !== null) ??
          raw.slice(k + 1).find((other) => other !== null) ??
          undefined,
      ),
  );

  // Neighbours looking at the same place share one crop, so the images do not jump around.
  let start = 0;
  for (let k = 1; k <= count; k++) {
    const merged = crops.slice(start, k).reduce<Rect | null>((r, c) => unionWith(r, c.rect), null)!;
    if (k < count && overlap(merged, crops[k]!.rect) >= MERGE_IOU) continue;
    if (k - start > 1) {
      const rect = fullIfBig(shape(merged));
      for (let at = start; at < k; at++) crops[at] = { ...crops[at]!, rect };
    }
    start = k;
  }

  return crops.map((crop, k) => {
    const content = input.content?.[k];
    let rect = crop.rect;
    if ((crop.kind === "focus" || crop.kind === "activity") && !isFull(rect) && content) {
      const middle = [(rect[0] + rect[2]) / 2, (rect[1] + rect[3]) / 2] as const;
      const keep =
        crop.need === undefined
          ? ([middle[0], middle[1], middle[0], middle[1]] as const)
          : intersect(crop.need, rect);
      rect = fullIfBig(
        refineCropEdges(
          { content, screen: [sw, sh], minSize: MIN_SIZE, maxZoom: MAX_ZOOM },
          rect,
          keep,
          crop.within ?? FULL,
        ),
      );
    }
    return { ...crop, rect, kind: isFull(rect) ? "full" : crop.kind };
  });
}

/** The summary's name for what the capture was cropped to (no window titles); null if it wasn't. */
export function cropLabel(crops: ReadonlyArray<Crop>): string | null {
  const cropped = crops.filter((crop) => crop.kind !== "full");
  if (cropped.length === 0) return null;
  const apps = [...new Set(cropped.flatMap((crop) => crop.apps))];
  if (apps.length === 0) return "the activity";
  const onlyFocus = cropped.every((crop) => crop.kind === "focus" || crop.kind === "activity");
  return onlyFocus ? `the activity in ${apps.join(" + ")}` : apps.join(" + ");
}

/** The pixel box `[x, y, width, height]` of `r` in a frame, at least one pixel on each side. */
export function pixelRect(r: Rect, width: number, height: number) {
  // A hair of tolerance so 0.6 × 100 = 60.000004 doesn't take an extra column.
  const hair = 1e-3;
  const x0 = Math.min(Math.max(Math.floor(r[0] * width + hair), 0), width - 1);
  const y0 = Math.min(Math.max(Math.floor(r[1] * height + hair), 0), height - 1);
  const x1 = Math.min(Math.max(Math.ceil(r[2] * width - hair), x0 + 1), width);
  const y1 = Math.min(Math.max(Math.ceil(r[3] * height - hair), y0 + 1), height);
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

const MAX_STROKE_POINTS = 48;
const CURSOR_REST_CAP_MS = 4_000;

export type CursorSample = readonly [t: number, x: number, y: number];

export interface ActivitySource {
  readonly durationMs: number;
  readonly keyframes: ReadonlyArray<number>;
  /** Each stroke's points are x, y, x, y, ... */
  readonly strokes: ReadonlyArray<{
    readonly t0: number;
    readonly t1: number;
    readonly points: ReadonlyArray<number>;
  }>;
  readonly events: ReadonlyArray<
    | { readonly kind: "click"; readonly t: number; readonly x: number; readonly y: number }
    | {
        readonly kind: "drag";
        readonly t: number;
        readonly t1: number;
        readonly x0: number;
        readonly y0: number;
        readonly x1: number;
        readonly y1: number;
      }
    | { readonly kind: "scroll"; readonly t: number; readonly x?: number; readonly y?: number }
  >;
  readonly cursor?: ReadonlyArray<CursorSample>;
  /** `changes[k]` are the regions keyframe `k` changed since keyframe `k - 1`. */
  readonly changes?: ReadonlyArray<ReadonlyArray<Rect>>;
  /** Strokes (by index) whose ink a keyframe draws, however long before it they were made. */
  readonly inkOwners?: ReadonlyMap<number, number>;
  /** The keyframe whose text names the input at this moment: its crop has to show it. */
  readonly inputOwner?: (t: number) => number | undefined;
}

export function activityItems(source: ActivitySource): Array<ActivityItem> {
  const items: Array<ActivityItem> = [];
  source.strokes.forEach((stroke, index) => {
    const count = Math.trunc(stroke.points.length / 2);
    if (count === 0) return;
    const span = stroke.t1 - stroke.t0;
    const owner = source.inkOwners?.get(index);
    items.push({
      kind: "stroke",
      t0: stroke.t0,
      t1: stroke.t1,
      dwell: 0,
      points: subsample(
        Array.from({ length: count }, (_, at) => {
          const t = stroke.t0 + (count > 1 ? (span * at) / (count - 1) : 0);
          return [stroke.points[at * 2]!, stroke.points[at * 2 + 1]!, t] as const;
        }),
        MAX_STROKE_POINTS,
      ),
      ...(owner === undefined ? {} : { keyframe: owner }),
    });
  });
  for (const event of source.events) {
    const owner = source.inputOwner?.(event.t);
    const owned = owner === undefined ? {} : { keyframe: owner };
    if (event.kind === "click") {
      const { t, x, y } = event;
      items.push({ kind: "click", t0: t, t1: t, dwell: 0, points: [[x, y, t]], ...owned });
    } else if (event.kind === "drag") {
      items.push({
        ...owned,
        kind: "drag",
        t0: event.t,
        t1: event.t1,
        dwell: 0,
        points: [
          [event.x0, event.y0, event.t],
          [event.x1, event.y1, event.t1],
        ],
      });
    } else if (event.x !== undefined && event.y !== undefined) {
      const { t, x, y } = event;
      items.push({ kind: "scroll", t0: t, t1: t, dwell: 0, points: [[x, y, t]], ...owned });
    }
  }
  const cursor = source.cursor ?? [];
  cursor.forEach(([t, x, y], index) => {
    const next = cursor[index + 1]?.[0] ?? Math.max(source.durationMs, t);
    items.push({
      kind: "cursor",
      t0: t,
      t1: next,
      dwell: Math.min(next - t, CURSOR_REST_CAP_MS) / 1000,
      points: [[x, y, t]],
    });
  });
  source.changes?.forEach((regions, keyframe) => {
    const t = source.keyframes[keyframe];
    if (t === undefined) return;
    for (const [x0, y0, x1, y1] of regions) {
      items.push({
        kind: "change",
        t0: t,
        t1: t,
        keyframe,
        dwell: Math.sqrt(area([x0, y0, x1, y1])),
        points: [
          [x0, y0, t],
          [x1, y0, t],
          [x0, y1, t],
          [x1, y1, t],
          [(x0 + x1) / 2, (y0 + y1) / 2, t],
        ],
      });
    }
  });
  return items;
}
