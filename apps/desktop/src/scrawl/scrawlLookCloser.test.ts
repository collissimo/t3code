import { describe, expect, it } from "vite-plus/test";

import {
  type BundleManifest,
  type BundleMark,
  autoCrop,
  cameraPath,
  cropAt,
  findMark,
  markEntries,
  markLine,
  markWindow,
  momentWindow,
  outputSize,
  parseClockMs,
  preciseClock,
  rangeTimes,
  resolveCrop,
  resolveMoment,
  sampleTimes,
} from "./scrawlLookCloser.ts";

const mark = (id: string, t0: number, frame?: string): BundleMark => ({
  id,
  t0,
  t1: t0 + 200,
  strokes: [0],
  ...(frame === undefined ? {} : { frame }),
});

const manifest = (overrides: Partial<BundleManifest> = {}): BundleManifest => ({
  durationMs: 25_000,
  target: { frame: { width: 2000, height: 1000 } },
  transcript: {
    words: [
      { t0: 9000, t1: 9200, text: "but," },
      { t0: 9300, t1: 9500, text: "the" },
      { t0: 9500, t1: 9700, text: "Width" },
      { t0: 9800, t1: 10_000, text: "changes." },
    ],
  },
  ...overrides,
});

describe("scrawl look closer", () => {
  // These vectors are the Scrawl CLI's own tests, so both tools pick the same frames.
  it("resolves phrases and times", () => {
    expect(resolveMoment(manifest(), "width changes")).toBe(9500);
    expect(resolveMoment(manifest(), "0:12")).toBe(12_000);
    expect(() => resolveMoment(manifest(), "tabular numbers")).toThrow(/neither a time/);
    expect(parseClockMs("1500ms")).toBe(1500);
    expect(parseClockMs("12.5s")).toBe(12_500);
    expect(parseClockMs("a:b")).toBeNull();
    expect(parseClockMs("")).toBeNull();
  });

  it("leans a window after the moment and stays inside the recording", () => {
    expect(momentWindow(10_000, 2000, 25_000)).toEqual([9500, 11_500]);
    expect(momentWindow(200, 2000, 25_000)).toEqual([0, 2000]);
    expect(momentWindow(24_800, 2000, 25_000)).toEqual([23_000, 25_000]);
    expect(sampleTimes(1000, 2000, 3)).toEqual([1000, 1500, 2000]);
    expect(preciseClock(61_234)).toBe("1:01.234");
    expect(rangeTimes(1000, 2000, 4)).toEqual([1000, 1250, 1500, 1750, 2000]);
  });

  it("centres a mark's window and holds all of it", () => {
    expect(markWindow(9322, 10_908, 2000, 13_400)).toEqual([8822, 11_408]);
    expect(markWindow(6661, 7182, 2000, 13_400)).toEqual([5921, 7921]);
    expect(markWindow(200, 400, 2000, 13_400)).toEqual([0, 2000]);
    expect(markWindow(13_000, 13_300, 2000, 13_400)).toEqual([11_400, 13_400]);
  });

  it("numbers marks the way the text does and finds them by number or id", () => {
    const bundle = manifest({
      marks: [
        mark("m1", 1000, "frames/frame-01.png"),
        mark("m2", 2000, "frames/frame-02.png"),
        mark("m3", 2500, "frames/frame-02.png"),
      ],
      keyframes: [
        { index: 1, t: 1200, file: "frames/frame-01.png" },
        { index: 2, t: 2700, file: "frames/frame-02.png" },
      ],
    });
    expect(markEntries(bundle).map(markLine)).toEqual([
      "#1 ✎ 0:01 marked · m1",
      "#2 ✎① 0:02 marked · m2",
      "#2 ✎② 0:02 marked · m3",
    ]);
    expect(findMark(bundle, "m1", undefined).mark.id).toBe("m1");
    expect(findMark(bundle, "2", undefined).mark.id).toBe("m3");
    expect(findMark(bundle, "②", undefined).mark.id).toBe("m3");
    expect(findMark(bundle, "1", 1).mark.id).toBe("m1");
    expect(findMark(bundle, "1", undefined).mark.id).toBe("m2");
    expect(() => findMark(bundle, "9", undefined)).toThrow(/No mark ⑨/);
    expect(() => findMark(bundle, "nope", undefined)).toThrow(/neither a mark number/);
  });

  it("still tells marks apart when no keyframe names them", () => {
    const bundle = manifest({ marks: [mark("m1", 1000), mark("m2", 2000)], keyframes: [] });
    expect(findMark(bundle, "2", undefined).mark.id).toBe("m2");
  });

  it("reads crops as fractions of the capture", () => {
    const crop = { x: 200, y: 100, width: 1000, height: 500, kind: "focus" };
    const bundle = manifest({
      keyframes: [
        { index: 1, t: 1000, file: "a" },
        { index: 2, t: 9000, file: "b" },
      ],
      autocrop: { crops: [crop, { ...crop, x: 600, kind: "focus" }] },
    });
    expect(cropAt(bundle, 1100)).toEqual([0.1, 0.1, 0.6, 0.6]);
    expect(cropAt(bundle, 8000)).toEqual([0.3, 0.1, 0.8, 0.6]);
    expect(autoCrop(bundle)).toEqual([0.1, 0.1, 0.8, 0.6]);
    expect(autoCrop(manifest({ autocrop: { crops: [{ ...crop, kind: "full" }] } }))).toEqual([
      0, 0, 1, 1,
    ]);
  });

  it("parses --crop as fractions or pixels and refuses what falls outside", () => {
    expect(resolveCrop("full", manifest(), 1000, 500)).toEqual([0, 0, 1, 1]);
    expect(resolveCrop("0.1,0.2,0.5,0.6", manifest(), 1000, 500)).toEqual([
      0.1,
      0.2,
      0.6,
      expect.closeTo(0.8),
    ]);
    expect(resolveCrop("100,100,500,250", manifest(), 1000, 500)).toEqual([0.1, 0.2, 0.6, 0.7]);
    expect(() => resolveCrop("0.5,0.5,0.9,0.9", manifest(), 1000, 500)).toThrow(/past the edge/);
    expect(() => resolveCrop("1,2,3", manifest(), 1000, 500)).toThrow(/four positive/);
    expect(() => resolveCrop("0,0,0.001,0.5", manifest(), 1000, 500)).toThrow(/16 px/);
  });

  it("keeps the crop's aspect on even sides and never scales up", () => {
    expect(outputSize(2560, 1440, 1920)).toEqual({ width: 1920, height: 1080 });
    expect(outputSize(999.4, 500.2, 1920)).toEqual({ width: 1000, height: 500 });
    expect(() => outputSize(100, 100, 10)).toThrow(/at least 64/);
  });

  it("moves the camera to activity and back, on the bundle's clock", () => {
    const bundle = manifest({
      events: [{ kind: "click", t: 3000, x: 0.8, y: 0.25 }],
    });
    const offsetMs = 1000;
    const rects = cameraPath(bundle, [0, 0, 1, 1], offsetMs, 10 * 30, 30);
    expect(rects).toHaveLength(300);
    expect(rects[0]).toEqual([0, 0, 1, 1]);
    // Bundle time 5 s, two after the click: settled on it at 1.8x.
    const zoomed = rects[120]!;
    expect(zoomed[2] - zoomed[0]).toBeCloseTo(1 / 1.8, 2);
    expect((zoomed[0] + zoomed[2]) / 2).toBeCloseTo(0.72, 1);
    for (const rect of rects) {
      expect(rect[0]).toBeGreaterThanOrEqual(-1e-9);
      expect(rect[2]).toBeLessThanOrEqual(1 + 1e-9);
    }
    // The zoom is released 2.5 s after the click: back out by the end.
    expect(rects[299]![2] - rects[299]![0]).toBeCloseTo(1, 1);
  });
});
