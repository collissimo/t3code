import { describe, expect, it } from "vite-plus/test";

import {
  activityItems,
  computeCrops,
  cropLabel,
  FULL,
  pixelRect,
  windowSnapshots,
  type ActivityItem,
  type AutocropInput,
  type Crop,
  type Rect,
} from "./autocrop.ts";
import { changeRegions, contentMap, type RgbaImage } from "./autocropContent.ts";
import corpusData from "./autocrop-corpus.json";

/** `ideal` and `targets` are `[x, y, width, height]` in points. */
interface CorpusSpan {
  readonly t0: number;
  readonly t1: number;
  readonly subject: string;
  readonly ideal: Rect;
  readonly targets: ReadonlyArray<Rect>;
}

interface CorpusCase {
  readonly name: string;
  readonly pxPerPt: number;
  readonly truth: {
    readonly screen: readonly [number, number];
    readonly spans: ReadonlyArray<CorpusSpan>;
  };
  readonly keyframes: ReadonlyArray<{ readonly t: number; readonly must: ReadonlyArray<Rect> }>;
  readonly input: {
    readonly screen: readonly [number, number];
    readonly duration: number;
    readonly keyframes: ReadonlyArray<number>;
    readonly items: ReadonlyArray<{
      readonly kind: ActivityItem["kind"];
      readonly t0: number;
      readonly t1: number;
      readonly pts: ActivityItem["points"];
      readonly dwell: number;
      readonly keyframe: number | null;
    }>;
    readonly snapshots: ReadonlyArray<
      readonly [
        number,
        ReadonlyArray<{
          readonly id: number;
          readonly app: string;
          readonly rect: Rect;
          readonly layer: number;
          readonly regular: boolean;
          readonly frontmost: boolean;
        }>,
      ]
    >;
  };
}

// Simulated captures with ground truth, from Scrawl (src/autocrop-corpus.json).
const corpus = corpusData as unknown as ReadonlyArray<CorpusCase>;

const inputOf = (
  { input }: CorpusCase,
  { windows = true, cursor = true }: { windows?: boolean; cursor?: boolean } = {},
): AutocropInput => ({
  screen: input.screen,
  durationMs: input.duration,
  keyframes: input.keyframes,
  items: input.items.flatMap((item): Array<ActivityItem> => {
    if (item.kind === "cursor" && !cursor) return [];
    const base = {
      kind: item.kind,
      t0: item.t0,
      t1: item.t1,
      points: item.pts,
      dwell: item.dwell,
    };
    return [item.keyframe === null ? base : { ...base, keyframe: item.keyframe }];
  }),
  snapshots: windows
    ? input.snapshots.map(([t, snapshotWindows]) => ({ t, windows: snapshotWindows }))
    : [],
});

const normalized = (box: Rect, [width, height]: readonly [number, number]): Rect => [
  box[0] / width,
  box[1] / height,
  (box[0] + box[2]) / width,
  (box[1] + box[3]) / height,
];

const areaOf = (r: Rect) => Math.max(0, r[2] - r[0]) * Math.max(0, r[3] - r[1]);
const common = (a: Rect, b: Rect): Rect => [
  Math.max(a[0], b[0]),
  Math.max(a[1], b[1]),
  Math.min(a[2], b[2]),
  Math.min(a[3], b[3]),
];

const overlap = (a: Rect, b: Rect) => {
  const w = Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0]));
  const h = Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]));
  const shared = w * h;
  return shared / ((a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - shared);
};

/** Scrawl's score: the crop keeps what matters, sits close to the ideal, and shows it large. */
const scoreCase = (testCase: CorpusCase, rects: ReadonlyArray<Rect>) => {
  const { screen, spans } = testCase.truth;
  const [sw, sh] = screen;
  const scored = testCase.keyframes.map((keyframe, index) => {
    const span = spans.find(({ t0, t1 }) => t0 <= keyframe.t && keyframe.t < t1) ?? spans.at(-1)!;
    const rect = rects[index]!;
    const ideal = normalized(span.ideal, screen);
    const targets = span.targets.map((target) => normalized(target, screen));
    const holds = (box: Rect) =>
      box[0] >= rect[0] - 2 / sw &&
      box[1] >= rect[1] - 2 / sh &&
      box[2] <= rect[2] + 2 / sw &&
      box[3] <= rect[3] + 2 / sh;
    const covered = [...keyframe.must, ...targets].every(holds);
    const contexts = targets.map((target) => {
      const margin = Math.max(
        0.2 * Math.max((target[2] - target[0]) * sw, (target[3] - target[1]) * sh),
        24,
      );
      const grown = [
        Math.max(target[0] - margin / sw, 0),
        Math.max(target[1] - margin / sh, 0),
        Math.min(target[2] + margin / sw, 1),
        Math.min(target[3] + margin / sh, 1),
      ] as const;
      return areaOf(common(grown, rect)) / Math.max(areaOf(grown), 1e-9);
    });
    const context =
      contexts.length === 0 ? 1 : contexts.reduce((sum, value) => sum + value, 0) / contexts.length;
    const precision = areaOf(common(rect, ideal)) / Math.max(areaOf(rect), 1e-9);
    const w = (rect[2] - rect[0]) * sw * testCase.pxPerPt;
    const h = (rect[3] - rect[1]) * sh * testCase.pxPerPt;
    const scale = Math.min((h > w ? 440 : 640) / w, 960 / h);
    const resolution = Math.min(
      1,
      Math.max(
        0,
        Math.min((Math.min(scale, 1) * testCase.pxPerPt) / 0.8, 1) - 0.5 * Math.max(scale - 1, 0),
      ),
    );
    const score = covered
      ? 0.45 * overlap(rect, ideal) + 0.2 * context + 0.15 * resolution + 0.2 * precision
      : 0;
    return { covered, score, rect, subject: span.subject };
  });
  const pairs = scored.flatMap((entry, index) => {
    const before = scored[index - 1];
    return before?.subject === entry.subject ? [overlap(entry.rect, before.rect)] : [];
  });
  const stability =
    pairs.length === 0 ? 1 : pairs.reduce((sum, value) => sum + value, 0) / pairs.length;
  const mean = scored.reduce((sum, { score }) => sum + score, 0) / scored.length;
  return {
    covered: scored.every(({ covered }) => covered),
    score: 0.85 * mean + 0.15 * stability,
  };
};

const SCREEN = [1000, 1000] as const;

const click = (t: number, x: number, y: number): ActivityItem => ({
  kind: "click",
  t0: t,
  t1: t,
  dwell: 0,
  points: [[x, y, t]],
});

const crops = (keyframes: ReadonlyArray<number>, items: ReadonlyArray<ActivityItem>) =>
  computeCrops({ screen: SCREEN, durationMs: 40_000, keyframes, items });

const inside = (rect: Rect, x: number, y: number) =>
  x >= rect[0] && x <= rect[2] && y >= rect[1] && y <= rect[3];

describe("computeCrops on Scrawl's corpus", () => {
  it("keeps every keyframe's activity and beats the full frame", () => {
    expect(corpus.length).toBeGreaterThanOrEqual(12);
    let total = 0;
    for (const testCase of corpus) {
      const result = scoreCase(
        testCase,
        computeCrops(inputOf(testCase)).map((crop) => crop.rect),
      );
      expect(result.covered, testCase.name).toBe(true);
      const uncropped = scoreCase(
        testCase,
        testCase.keyframes.map(() => FULL),
      );
      expect(result.score, testCase.name).toBeGreaterThan(uncropped.score);
      total += result.score;
    }
    expect(total / corpus.length).toBeGreaterThanOrEqual(0.85);
  });

  it("snaps to the window in use", () => {
    for (const name of ["side-by-side", "overlapping-front", "two-windows", "three-window-hop"]) {
      const testCase = corpus.find((candidate) => candidate.name === name)!;
      const found = computeCrops(inputOf(testCase));
      testCase.keyframes.forEach((keyframe, index) => {
        const span = testCase.truth.spans.find(
          ({ t0, t1 }) => t0 <= keyframe.t && keyframe.t < t1,
        )!;
        const ideal = normalized(span.ideal, testCase.truth.screen);
        expect(overlap(found[index]!.rect, ideal), `${name} #${index + 1}`).toBeGreaterThan(0.9);
      });
    }
  });

  it("keeps all deliberate input with neither a window log nor a cursor log", () => {
    for (const testCase of corpus) {
      const { items, keyframes, duration } = testCase.input;
      const found = computeCrops(inputOf(testCase, { windows: false, cursor: false }));
      found.forEach(({ rect }, index) => {
        const from = index === 0 ? 0 : (keyframes[index - 1]! + keyframes[index]!) / 2;
        const to =
          index + 1 === keyframes.length
            ? Math.max(duration, keyframes[index]!)
            : (keyframes[index]! + keyframes[index + 1]!) / 2;
        for (const item of items) {
          if (item.kind === "cursor" || item.kind === "change") continue;
          if (item.t1 < from || item.t0 > to) continue;
          for (const [x, y] of item.pts) {
            expect(
              x >= rect[0] - 1e-3 &&
                x <= rect[2] + 1e-3 &&
                y >= rect[1] - 1e-3 &&
                y <= rect[3] + 1e-3,
              `${testCase.name} #${index + 1}`,
            ).toBe(true);
          }
        }
      });
    }
  });

  it("does not let a wandering cursor grow the crop", () => {
    const testCase = corpus.find((candidate) => candidate.name === "stray-cursor")!;
    const withCursor = computeCrops(inputOf(testCase));
    const without = computeCrops(inputOf(testCase, { cursor: false }));
    withCursor.forEach((crop, index) => {
      expect(overlap(crop.rect, without[index]!.rect)).toBeGreaterThan(0.6);
    });
  });
});

describe("computeCrops", () => {
  it("gives each keyframe its own crop when the activity moves", () => {
    const [first, second] = crops(
      [5_000, 30_000],
      [click(5_000, 0.1, 0.1), click(30_000, 0.9, 0.9)],
    );
    expect(inside(first!.rect, 0.1, 0.1)).toBe(true);
    expect(inside(first!.rect, 0.9, 0.9)).toBe(false);
    expect(inside(second!.rect, 0.9, 0.9)).toBe(true);
    expect(inside(second!.rect, 0.1, 0.1)).toBe(false);
    expect(first!.kind).toBe("activity");
  });

  it("shares one crop between neighbours looking at the same place", () => {
    const [first, second] = crops(
      [5_000, 30_000],
      [click(5_000, 0.5, 0.5), click(30_000, 0.52, 0.5)],
    );
    expect(first!.rect).toEqual(second!.rect);
  });

  it("keeps the full frame when activity covers most of the screen", () => {
    const [crop] = crops([5_000], [click(4_000, 0.02, 0.02), click(5_000, 0.98, 0.98)]);
    expect(crop!.kind).toBe("full");
    expect(crop!.rect).toEqual(FULL);
  });

  it("gives a keyframe with no activity the nearest crop", () => {
    const [first, second, third] = crops([10_000, 20_000, 30_000], [click(30_000, 0.8, 0.8)]);
    expect(third!.kind).toBe("activity");
    expect(first!.kind).toBe("fallback");
    expect(second!.rect).toEqual(third!.rect);
  });

  it("takes the full frame when nothing happened at all", () => {
    expect(crops([5_000], [])[0]).toMatchObject({ kind: "full", rect: FULL });
  });

  it("gives a keyframe the ink it owns however long ago it was drawn, and no one else", () => {
    const items = activityItems({
      durationMs: 40_000,
      keyframes: [10_000, 30_000],
      strokes: [{ t0: 1_000, t1: 2_000, points: [0.1, 0.1, 0.15, 0.15] }],
      events: [{ kind: "click", t: 10_000, x: 0.8, y: 0.8 }],
      inkOwners: new Map([[0, 1]]),
    });
    const [first, second] = crops([10_000, 30_000], items);
    expect(inside(first!.rect, 0.1, 0.1)).toBe(false);
    expect(inside(second!.rect, 0.1, 0.1)).toBe(true);
  });

  it("keeps a click in the crop of the keyframe whose text names it", () => {
    const events = [
      { kind: "click", t: 2_000, x: 0.1, y: 0.1 },
      { kind: "click", t: 25_000, x: 0.5, y: 0.5 },
      { kind: "click", t: 30_000, x: 0.9, y: 0.9 },
    ] as const;
    const source = { durationMs: 40_000, keyframes: [25_000, 30_000], strokes: [], events };
    const bySlice = crops([25_000, 30_000], activityItems(source));
    expect(inside(bySlice[0]!.rect, 0.1, 0.1)).toBe(true);
    expect(inside(bySlice[1]!.rect, 0.1, 0.1)).toBe(false);
    const owned = crops(
      [25_000, 30_000],
      activityItems({ ...source, inputOwner: (t) => (t === 2_000 ? 1 : undefined) }),
    );
    expect(inside(owned[0]!.rect, 0.1, 0.1)).toBe(false);
    expect(inside(owned[1]!.rect, 0.1, 0.1)).toBe(true);
  });

  it("counts what a click changed nearby as part of the activity, not other changes", () => {
    const items = activityItems({
      durationMs: 40_000,
      keyframes: [5_000],
      strokes: [],
      events: [{ kind: "click", t: 5_000, x: 0.3, y: 0.3 }],
      changes: [
        [
          [0.28, 0.28, 0.55, 0.55],
          [0.9, 0.9, 0.95, 0.95],
        ],
      ],
    });
    const [crop] = crops([5_000], items);
    expect(inside(crop!.rect, 0.55, 0.55)).toBe(true);
    expect(inside(crop!.rect, 0.95, 0.95)).toBe(false);
  });

  it("crops to what changed when nothing was touched", () => {
    const items = activityItems({
      durationMs: 40_000,
      keyframes: [5_000],
      strokes: [],
      events: [],
      changes: [[[0.7, 0.7, 0.8, 0.8]]],
    });
    const [crop] = crops([5_000], items);
    expect(crop!.kind).toBe("activity");
    expect(inside(crop!.rect, 0.75, 0.75)).toBe(true);
    expect(inside(crop!.rect, 0.1, 0.1)).toBe(false);
  });

  it("ignores a scroll with no position, and crops around one with a position", () => {
    const place = (x?: number, y?: number) =>
      activityItems({
        durationMs: 40_000,
        keyframes: [5_000],
        strokes: [],
        events: [
          { kind: "scroll", t: 5_000, ...(x === undefined || y === undefined ? {} : { x, y }) },
        ],
      });
    expect(place()).toEqual([]);
    expect(inside(crops([5_000], place(0.7, 0.7))[0]!.rect, 0.7, 0.7)).toBe(true);
  });

  it("reads the window log in the shape scrawl.json keeps it", () => {
    const snapshots = windowSnapshots(
      [
        {
          t: 100,
          windows: [
            {
              id: 1,
              app: "Notes",
              bounds: [100, 100, 400, 400],
              layer: 0,
              frontmost: true,
            },
          ],
        },
      ],
      SCREEN,
      (t) => t - 100,
    );
    expect(snapshots[0]).toEqual({
      t: 0,
      windows: [
        {
          id: 1,
          app: "Notes",
          rect: [0.1, 0.1, 0.5, 0.5],
          layer: 0,
          regular: true,
          frontmost: true,
        },
      ],
    });
    const [crop] = computeCrops({
      screen: SCREEN,
      durationMs: 10_000,
      keyframes: [5_000],
      items: [click(5_000, 0.3, 0.3)],
      snapshots,
    });
    expect(crop).toMatchObject({ kind: "window", apps: ["Notes"] });
    crop!.rect.forEach((value, index) => {
      expect(value).toBeCloseTo([0.1, 0.1, 0.5, 0.5][index]!);
    });
  });
});

describe("cropLabel", () => {
  const crop = (kind: Crop["kind"], apps: ReadonlyArray<string>): Crop => ({
    rect: FULL,
    kind,
    reason: "",
    apps,
  });

  it.each([
    [[crop("full", [])], null],
    [[crop("activity", [])], "the activity"],
    [[crop("focus", ["Helium"]), crop("full", ["Other"])], "the activity in Helium"],
    [[crop("window", ["Helium"]), crop("focus", ["Code"])], "Helium + Code"],
  ])("names %j", (found, label) => {
    expect(cropLabel(found)).toBe(label);
  });
});

describe("pixelRect", () => {
  it("stays on the frame, takes no extra column, and is never empty", () => {
    expect(pixelRect([0.6, 0, 1, 1], 100, 100)).toEqual({ x: 60, y: 0, width: 40, height: 100 });
    expect(pixelRect([1, 1, 1, 1], 100, 100)).toEqual({ x: 99, y: 99, width: 1, height: 1 });
  });
});

/** A white screen with dark rows of "text": `rows` is [y0, y1, x0, x1] in points. */
const textScreen = (
  size: number,
  rows: ReadonlyArray<readonly [number, number, number, number]>,
): RgbaImage => {
  const data = new Uint8ClampedArray(size * size * 4).fill(255);
  for (const [y0, y1, x0, x1] of rows) {
    for (let y = y0; y < y1; y++) {
      // Alternating columns, so every 3 pt cell holds an edge.
      for (let x = x0; x < x1; x += 2) {
        const at = (y * size + x) * 4;
        data[at] = data[at + 1] = data[at + 2] = 0;
      }
    }
  }
  return { width: size, height: size, data };
};

const refined = (image: RgbaImage, at: readonly [number, number]) =>
  computeCrops({
    screen: [image.width, image.height],
    durationMs: 10_000,
    keyframes: [5_000],
    items: [click(5_000, at[0], at[1])],
    content: [contentMap(image, [image.width, image.height])],
  })[0]!.rect;

describe("moving crop edges off content", () => {
  const SIZE = 1200;
  const blank = computeCrops({
    screen: [SIZE, SIZE],
    durationMs: 10_000,
    keyframes: [5_000],
    items: [click(5_000, 0.5, 0.5)],
  })[0]!.rect;

  it("finishes a line of text the crop would cut", () => {
    const edge = Math.round(blank[2] * SIZE);
    const end = edge + 100;
    const rect = refined(textScreen(SIZE, [[590, 610, 400, end]]), [0.5, 0.5]);
    expect(rect[2] * SIZE).toBeGreaterThanOrEqual(end);
  });

  it("does not cut a block of text across its middle", () => {
    const edge = Math.round(blank[3] * SIZE);
    const rows = Array.from({ length: 12 }, (_, line) => {
      const y = edge - 96 + line * 16;
      return [y, y + 10, 300, 900] as const;
    });
    const rect = refined(textScreen(SIZE, rows), [0.5, 0.5]);
    const bottom = rect[3] * SIZE;
    const cutsRow = rows.some(([y0, y1]) => bottom > y0 + 1 && bottom < y1 - 1);
    expect(cutsRow).toBe(false);
  });

  it("never moves an edge past the activity", () => {
    const rows = Array.from({ length: 60 }, (_, line) => {
      const y = line * 20;
      return [y, y + 18, 0, SIZE] as const;
    });
    const rect = refined(textScreen(SIZE, rows), [0.3, 0.7]);
    expect(inside(rect, 0.3, 0.7)).toBe(true);
  });
});

describe("changeRegions", () => {
  const SIZE = 640;
  const solid = (paint?: (x: number, y: number) => boolean): RgbaImage => {
    const data = new Uint8ClampedArray(SIZE * SIZE * 4).fill(255);
    if (paint !== undefined) {
      for (let y = 0; y < SIZE; y++) {
        for (let x = 0; x < SIZE; x++) {
          if (!paint(x, y)) continue;
          const at = (y * SIZE + x) * 4;
          data[at] = data[at + 1] = data[at + 2] = 0;
        }
      }
    }
    return { width: SIZE, height: SIZE, data };
  };

  it("boxes what changed, largest first, and drops a lone cell", () => {
    const after = solid(
      (x, y) =>
        (x >= 100 && x < 300 && y >= 100 && y < 200) ||
        (x >= 500 && x < 560 && y >= 500 && y < 520) ||
        (x >= 10 && x < 20 && y >= 600 && y < 610),
    );
    const regions = changeRegions(solid(), after);
    expect(regions).toEqual([
      [100 / SIZE, 100 / SIZE, 300 / SIZE, 200 / SIZE],
      [500 / SIZE, 500 / SIZE, 560 / SIZE, 520 / SIZE],
    ]);
  });

  it("finds nothing on an unchanged screen", () => {
    expect(changeRegions(solid(), solid())).toEqual([]);
  });
});
