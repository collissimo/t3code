import { describe, expect, it } from "vite-plus/test";

import { findSceneChanges, THUMB_HEIGHT, THUMB_WIDTH, withoutInkChanges } from "./sceneChanges.ts";

const blank = () => new Float32Array(THUMB_WIDTH * THUMB_HEIGHT);

describe("withoutInkChanges", () => {
  it("drops changes from drawing and fading ink, and keeps the rest", () => {
    const strokes = [{ t0: 2_000, t1: 3_000 }];
    expect(withoutInkChanges([1_000, 2_500, 3_500, 6_000, 8_000, 9_000], strokes, 5_000)).toEqual([
      1_000, 6_000, 9_000,
    ]);
  });
});

describe("findSceneChanges", () => {
  it("ignores a moving cursor and finds a real transition", () => {
    const cursor = blank();
    cursor.fill(1, 10, 14);
    const page = blank().fill(0.6);
    expect(
      findSceneChanges([
        { t: 0, luma: blank() },
        { t: 750, luma: cursor },
        { t: 1_500, luma: page },
      ]),
    ).toEqual([1_500]);
  });
});
