import { describe, expect, it } from "vite-plus/test";

import { chipDodgesRight, clicksToRing, frameChipScale } from "./frameAnnotations.ts";

describe("clicksToRing", () => {
  it("shows the click nearest the frame's moment, and only one within reach", () => {
    expect(
      clicksToRing({ frameT: 1_000, actions: [] }, [
        { t: 500, x: 0.1, y: 0.1 },
        { t: 900, x: 0.2, y: 0.2 },
        { t: 5_000, x: 0.3, y: 0.3 },
      ]),
    ).toEqual([[0.2, 0.2]]);
  });

  it("shows no click from another moment, whose screen may be gone", () => {
    expect(clicksToRing({ frameT: 10_000, actions: [] }, [{ t: 2_000, x: 0.1, y: 0.1 }])).toEqual(
      [],
    );
  });

  it("keeps a hand pointing on this screen, and one ring for a double click", () => {
    const rings = clicksToRing(
      {
        frameT: 5_000,
        actions: [
          {
            kind: "clicks",
            targets: [],
            t0: 1_000,
            t1: 1_200,
            count: 2,
            points: [
              [0.5, 0.5],
              [0.501, 0.5],
            ],
            changed: false,
          },
          {
            kind: "clicks",
            targets: [],
            t0: 3_000,
            t1: 3_000,
            count: 1,
            points: [[0.7, 0.7]],
            changed: false,
          },
        ],
      },
      [],
    );
    expect(rings).toEqual([
      [0.5, 0.5],
      [0.7, 0.7],
    ]);
  });

  it("drops pointing from before the screen changed", () => {
    const rings = clicksToRing(
      {
        frameT: 5_000,
        actions: [
          {
            kind: "clicks",
            targets: [],
            t0: 1_000,
            t1: 1_000,
            count: 1,
            points: [[0.5, 0.5]],
            changed: false,
          },
          { kind: "scene", t0: 2_000, t1: 2_000 },
          {
            kind: "clicks",
            targets: [],
            t0: 3_000,
            t1: 3_000,
            count: 1,
            points: [[0.7, 0.7]],
            changed: false,
          },
        ],
      },
      [],
    );
    expect(rings).toEqual([[0.7, 0.7]]);
  });

  it("leaves clicks the screen answered to their own moment", () => {
    const rings = clicksToRing(
      {
        frameT: 5_000,
        actions: [
          {
            kind: "clicks",
            targets: [],
            t0: 1_000,
            t1: 1_000,
            count: 1,
            points: [[0.5, 0.5]],
            changed: true,
          },
        ],
      },
      [{ t: 1_000, x: 0.5, y: 0.5 }],
    );
    expect(rings).toEqual([]);
  });
});

describe("chipDodgesRight", () => {
  it.each([
    ["clear", [], [], false],
    ["ink under the chip", [[0.1, 0.1]], [], true],
    ["a click under the chip", [], [[0.1, 0.1]], true],
    ["ink elsewhere", [[0.5, 0.5]], [], false],
    ["a click where it would dodge to", [[0.1, 0.1]], [[0.9, 0.1]], false],
    ["ink outside the crop", [[-0.1, 0.1]], [], false],
  ] as const)("%s", (_name, ink, focus, expected) => {
    expect(chipDodgesRight(ink, focus)).toBe(expected);
  });
});

describe("frameChipScale", () => {
  it("grows with the frame and stays readable on a small crop", () => {
    expect(frameChipScale(2560, 1440)).toBe(3);
    expect(frameChipScale(320, 200)).toBe(0.45);
  });
});
