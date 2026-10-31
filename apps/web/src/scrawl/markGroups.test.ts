import { describe, expect, it } from "vite-plus/test";

import { groupMarks, placeMarks } from "./markGroups.ts";
import { buildNarration } from "./narration.ts";

const mark = (id: string, t0: number, strokes = 1) => ({
  id,
  t0,
  t1: t0 + 500,
  strokes: Array.from({ length: strokes }, (_, index) => index),
});
const idsOf = (groups: ReadonlyArray<ReadonlyArray<{ readonly id: string }>>) =>
  groups.map((group) => group.map(({ id }) => id));

describe("groupMarks", () => {
  const free = { actionTimes: [], sceneChanges: [], budget: 12 };

  it("shares a keyframe while nothing happened to the screen between the marks", () => {
    const marks = [mark("m1", 1_000), mark("m2", 5_000), mark("m3", 9_000)];
    expect(idsOf(groupMarks(marks, free))).toEqual([["m1", "m2", "m3"]]);
  });

  it.each([
    ["a click", { actionTimes: [3_000] }],
    ["a scene change", { sceneChanges: [3_000] }],
  ])("closes the group at %s", (_name, cause) => {
    const marks = [mark("m1", 1_000), mark("m2", 5_000)];
    expect(idsOf(groupMarks(marks, { ...free, ...cause }))).toEqual([["m1"], ["m2"]]);
  });

  it("ignores a click made while the ink was being drawn", () => {
    const marks = [mark("m1", 1_000), mark("m2", 5_000)];
    expect(idsOf(groupMarks(marks, { ...free, actionTimes: [1_200, 5_200] }))).toEqual([
      ["m1", "m2"],
    ]);
  });

  it("closes the group past 20 s and past 12 strokes", () => {
    const late = [mark("m1", 0), mark("m2", 10_000), mark("m3", 20_000)];
    expect(idsOf(groupMarks(late, free))).toEqual([["m1", "m2"], ["m3"]]);
    const inky = [mark("m1", 0, 6), mark("m2", 2_000, 6), mark("m3", 4_000, 1)];
    expect(idsOf(groupMarks(inky, free))).toEqual([["m1", "m2"], ["m3"]]);
  });

  it("merges over budget, same-screen least ink first, else the most alike, dropping none", () => {
    // Kept apart by clicks, all on one screen: the lightest neighbours go together.
    const clicked = [mark("m1", 0, 5), mark("m2", 2_000), mark("m3", 4_000), mark("m4", 6_000, 5)];
    expect(
      idsOf(
        groupMarks(clicked, {
          actionTimes: [1_000, 3_000, 5_000],
          sceneChanges: [],
          budget: 3,
        }),
      ),
    ).toEqual([["m1"], ["m2", "m3"], ["m4"]]);
    // A busier gap stays a boundary.
    const screens = [mark("m1", 0), mark("m2", 2_000), mark("m3", 4_000)];
    expect(
      idsOf(
        groupMarks(screens, {
          actionTimes: [],
          sceneChanges: [1_000, 1_500, 3_000],
          budget: 2,
        }),
      ),
    ).toEqual([["m1"], ["m2", "m3"]]);
    expect(
      idsOf(groupMarks(screens, { actionTimes: [], sceneChanges: [1_000, 3_000], budget: 1 })),
    ).toEqual([["m1", "m2", "m3"]]);
  });
});

describe("placeMarks", () => {
  it("gives every mark its keyframe, and a number only among several", () => {
    const marks = [mark("m1", 1_000), mark("m2", 3_000), mark("m3", 30_000)];
    const lines = buildNarration({
      words: [],
      events: [],
      marks,
      durationMs: 40_000,
      markGroups: [["m1", "m2"], ["m3"]],
    });
    expect(placeMarks(marks, lines)).toMatchObject([
      { id: "m1", frame: "frames/frame-01.png", number: 1 },
      { id: "m2", frame: "frames/frame-01.png", number: 2 },
      { id: "m3", frame: "frames/frame-02.png" },
    ]);
    expect(placeMarks(marks, lines)[2]).not.toHaveProperty("number");
  });
});
