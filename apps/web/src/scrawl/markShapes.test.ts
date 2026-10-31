import { describe, expect, it } from "vite-plus/test";

import { marksOf, type InkMark, type InkStroke, type Point } from "./markShapes.ts";

const stroke = (points: ReadonlyArray<Point>, t0 = 0, t1 = t0 + 100): InkStroke => ({
  t0,
  t1,
  points: points.flatMap(([x, y]) => [x, y]),
});
const shapeOf = (points: ReadonlyArray<Point>, width = 1000, height = 1000) =>
  marksOf([stroke(points)], width, height)[0]!.shape;

/** Corners joined by points every 4 px on the 1000 px test frame, as a mouse samples them. */
const polyline = (corners: ReadonlyArray<Point>): Array<Point> => {
  const points: Array<Point> = [];
  for (let index = 1; index < corners.length; index++) {
    const a = corners[index - 1]!;
    const b = corners[index]!;
    const count = Math.max(1, Math.floor(Math.hypot(b[0] - a[0], b[1] - a[1]) / 0.004));
    for (let k = 0; k < count; k++) {
      points.push([a[0] + ((b[0] - a[0]) * k) / count, a[1] + ((b[1] - a[1]) * k) / count]);
    }
  }
  points.push(corners.at(-1)!);
  return points;
};

const ellipse = (c: Point, r: Point, from: number, to: number): Array<Point> =>
  Array.from({ length: 61 }, (_, k) => {
    const a = from + ((to - from) * k) / 60;
    return [c[0] + r[0] * Math.cos(a), c[1] + r[1] * Math.sin(a)];
  });

const turnsOf = (c: Point, r: Point, turns: number): Array<Point> => {
  const count = Math.floor(120 * turns);
  return Array.from({ length: count + 1 }, (_, k) => {
    const a = (2 * Math.PI * turns * k) / count;
    return [c[0] + r[0] * Math.cos(a), c[1] + r[1] * Math.sin(a)];
  });
};

const scribble = (count: number): Array<Point> =>
  Array.from({ length: count }, (_, i) => [
    0.2 + 0.1 * Math.sin(0.9 * i),
    0.2 + 0.022 * Math.sin(0.37 * i),
  ]);

// Real strokes kept in Scrawl's own tests (flat x, y, dt in 0..10000): a flat loop round a table
// cell, an arrow drawn in one go, and two underlines whose end hooks back like a lone barb.
const REAL_LOOP = [
  3617, 3170, 0, 3611, 3184, 48, 3595, 3194, 76, 3582, 3200, 96, 3560, 3210, 106, 3529, 3217, 126,
  3495, 3225, 146, 3449, 3229, 156, 3399, 3229, 175, 3363, 3229, 195, 3321, 3229, 215, 3276, 3229,
  225, 3249, 3229, 245, 3214, 3225, 263, 3192, 3218, 281, 3153, 3207, 290, 3136, 3199, 310, 3093,
  3172, 330, 3069, 3152, 350, 3051, 3132, 370, 3040, 3117, 388, 3033, 3103, 397, 3026, 3084, 417,
  3024, 3051, 437, 3024, 3030, 447, 3024, 3009, 457, 3024, 2971, 467, 3024, 2928, 487, 3026, 2890,
  505, 3041, 2841, 515, 3073, 2779, 544, 3139, 2696, 562, 3197, 2640, 581, 3228, 2616, 591, 3330,
  2563, 611, 3398, 2544, 631, 3477, 2533, 641, 3550, 2529, 661, 3623, 2529, 681, 3702, 2539, 691,
  3780, 2579, 710, 3852, 2634, 730, 3913, 2676, 747, 3945, 2698, 757, 3983, 2729, 776, 4011, 2746,
  785, 4035, 2767, 804, 4055, 2790, 823, 4078, 2823, 834, 4088, 2848, 853, 4099, 2885, 873, 4103,
  2918, 883, 4103, 2990, 920, 4081, 3027, 938, 4045, 3067, 948, 4002, 3105, 968, 3921, 3159, 987,
  3900, 3171, 997, 3849, 3192, 1017, 3803, 3205, 1027, 3762, 3217, 1052, 3720, 3225, 1062, 3678,
  3225, 1080, 3636, 3225, 1090, 3594, 3225, 1110, 3566, 3225, 1128, 3535, 3225, 1148, 3516, 3222,
  1158, 3502, 3218, 1178,
];
const REAL_ARROW = [
  4057, 2996, 0, 4047, 2996, 68, 4075, 2996, 199, 4130, 3004, 209, 4236, 3044, 229, 4312, 3073, 248,
  4406, 3106, 256, 4490, 3121, 276, 4567, 3131, 296, 4606, 3131, 316, 4633, 3131, 326, 4653, 3131,
  365, 4621, 3111, 431, 4570, 3090, 451, 4507, 3062, 469, 4404, 3018, 488, 4373, 3007, 506, 4345,
  3000, 516, 4331, 3000, 534, 4322, 2997, 573, 4337, 2995, 624, 4376, 2995, 644, 4436, 2999, 664,
  4509, 3023, 674, 4549, 3039, 684, 4607, 3061, 694, 4638, 3076, 713, 4652, 3083, 723, 4663, 3086,
  733, 4674, 3092, 743, 4662, 3107, 830, 4648, 3115, 840, 4609, 3147, 850, 4530, 3217, 880, 4512,
  3233, 889, 4494, 3249, 899, 4483, 3259, 907, 4467, 3275, 917, 4458, 3283, 934, 4481, 3284, 1308,
];
const REAL_HOOKED_UNDERLINES = [
  [
    3589, 6331, 0, 3612, 6331, 30, 3665, 6347, 49, 3718, 6356, 68, 3787, 6365, 78, 3817, 6365, 86,
    3856, 6365, 95, 3871, 6365, 105, 3963, 6365, 115, 4001, 6365, 134, 4062, 6365, 143, 4139, 6365,
    153, 4169, 6365, 172, 4214, 6365, 182, 4244, 6377, 199, 4258, 6377, 218, 4272, 6381, 227, 4302,
    6381, 247, 4355, 6390, 266, 4392, 6405, 276, 4407, 6405, 286, 4422, 6411, 295, 4429, 6415, 305,
    4439, 6422, 314, 4445, 6431, 334, 4450, 6442, 353, 4453, 6451, 371, 4455, 6465, 401, 4450, 6476,
    411, 4442, 6491, 430, 4436, 6500, 449, 4426, 6510, 458, 4415, 6519, 477, 4408, 6528, 487, 4394,
    6544, 497, 4372, 6560, 506, 4357, 6567, 516, 4342, 6573, 524, 4305, 6573, 538, 4274, 6573, 548,
    4267, 6573, 558, 4244, 6565, 567, 4223, 6559, 576,
  ],
  [
    7252, 494, 0, 7273, 484, 18, 7288, 477, 28, 7319, 468, 37, 7341, 468, 46, 7356, 461, 56, 7371,
    461, 64, 7409, 461, 81, 7477, 461, 91, 7508, 461, 99, 7530, 469, 109, 7545, 476, 119, 7555, 476,
    129, 7559, 485, 165, 7547, 504, 185, 7536, 524, 195, 7528, 532, 224, 7514, 541, 234, 7460, 567,
    254, 7407, 601, 264,
  ],
];

const fromTriples = (triples: ReadonlyArray<number>): Array<Point> => {
  const points: Array<Point> = [];
  for (let index = 0; index + 2 < triples.length; index += 3) {
    points.push([triples[index]! / 10_000, triples[index + 1]! / 10_000]);
  }
  return points;
};

const expectBox = (mark: InkMark, want: ReadonlyArray<number>) => {
  mark.boxNorm.forEach((value, index) => expect(value).toBeCloseTo(want[index]!, 2));
};

describe("a single stroke's shape", () => {
  it("is measured in pixels", () => {
    expect(
      shapeOf([
        [0.5, 0.5],
        [0.505, 0.505],
      ]),
    ).toBe("tap");
    expect(
      shapeOf([
        [0.1, 0.5],
        [0.8, 0.5],
      ]),
    ).toBe("underline");
    expect(
      shapeOf([
        [0.2, 0.2],
        [0.5, 0.6],
      ]),
    ).toBe("line");
    // Twice as tall as wide in fractions, round on a frame half as high.
    expect(shapeOf(ellipse([0.5, 0.5], [0.1, 0.2], 0, 2 * Math.PI), 1000, 500)).toBe("circle");
  });

  it.each([
    ["round", ellipse([0.3, 0.3], [0.1, 0.1], 0, 2 * Math.PI)],
    ["flat", ellipse([0.3, 0.3], [0.1, 0.05], 0, 2 * Math.PI)],
    ["open by 30°", ellipse([0.3, 0.3], [0.115, 0.05], Math.PI / 2, Math.PI * 2.5 - 0.55)],
    ["open along the other axis", ellipse([0.3, 0.3], [0.05, 0.1], 0.2, 2 * Math.PI - 0.2)],
    ["twice round", turnsOf([0.3, 0.3], [0.1, 0.08], 2)],
    ["five times round", turnsOf([0.3, 0.3], [0.1, 0.1], 5)],
    ["flat, three times round", turnsOf([0.3, 0.3], [0.12, 0.03], 3)],
  ])("calls a %s loop a circle", (_name, points) => {
    expect(shapeOf(points)).toBe("circle");
  });

  it.each<readonly [string, ReadonlyArray<Point>]>([
    [
      "check mark",
      polyline([
        [0.1, 0.2],
        [0.13, 0.24],
        [0.22, 0.12],
      ]),
    ],
    [
      "V",
      polyline([
        [0.1, 0.1],
        [0.15, 0.25],
        [0.2, 0.1],
      ]),
    ],
    [
      "zigzag",
      polyline([
        [0.1, 0.2],
        [0.13, 0.16],
        [0.16, 0.2],
        [0.19, 0.16],
        [0.22, 0.2],
      ]),
    ],
    [
      "back and forth",
      polyline([
        [0.1, 0.2],
        [0.3, 0.21],
        [0.11, 0.225],
        [0.3, 0.24],
        [0.11, 0.255],
      ]),
    ],
    ["scribble", scribble(60)],
    ["long scribble", scribble(600)],
    [
      "hooked underline",
      polyline([
        [0.1, 0.3],
        [0.4, 0.3],
        [0.405, 0.27],
      ]),
    ],
    [
      "one-sided barb",
      polyline([
        [0.1, 0.3],
        [0.3, 0.25],
        [0.26, 0.24],
      ]),
    ],
    ["C", ellipse([0.3, 0.3], [0.1, 0.1], Math.PI / 4, 1.75 * Math.PI)],
    ["flat C", ellipse([0.3, 0.3], [0.1, 0.025], 0.8, 2 * Math.PI - 0.8)],
    ["flat loop four times round", turnsOf([0.3, 0.3], [0.12, 0.03], 4)],
  ])("does not call a %s an arrow or a circle", (_name, points) => {
    expect(["arrow", "circle"]).not.toContain(shapeOf(points));
  });

  it("does not call a real underline with a hooked end an arrow", () => {
    for (const pts of REAL_HOOKED_UNDERLINES) {
      expect(shapeOf(fromTriples(pts), 2560, 1440)).not.toBe("arrow");
    }
  });

  it("takes what a tailed loop circled from the loop alone", () => {
    const flat = [0.2, 0.25, 0.4, 0.35];
    const tailed = [
      ...ellipse([0.3, 0.3], [0.1, 0.05], 0, 2 * Math.PI),
      ...polyline([
        [0.4, 0.3],
        [0.52, 0.38],
      ]),
    ];
    const overshoot = ellipse([0.3, 0.3], [0.1, 0.05], 0, 2.6 * Math.PI);
    const leadIn = [
      ...polyline([
        [0.18, 0.2],
        [0.3, 0.25],
      ]),
      ...ellipse([0.3, 0.3], [0.1, 0.05], -Math.PI / 2, 1.6 * Math.PI),
    ];
    for (const points of [tailed, overshoot, leadIn]) {
      const mark = marksOf([stroke(points)], 1000, 1000)[0]!;
      expect(mark.shape).toBe("circle");
      expectBox(mark, flat);
    }
  });

  it("recognises the real loop and the real one-stroke arrow, tip included", () => {
    const [loop, arrow] = marksOf(
      [
        stroke(fromTriples(REAL_LOOP), 6_208, 7_386),
        stroke(fromTriples(REAL_ARROW), 10_283, 11_591),
      ],
      1728,
      1117,
    );
    expect(loop).toMatchObject({
      shape: "circle",
      description: "circled region x 0.30–0.41, y 0.25–0.32",
    });
    expect(arrow).toMatchObject({
      shape: "arrow",
      from: [0.4057, 0.2996],
      to: [0.4653, 0.3131],
      description: "drew an arrow from x 0.41, y 0.30 pointing to x 0.47, y 0.31",
    });
  });

  it("is not hidden by sampling a long stroke, nor slowed by one", () => {
    const zigzag: Array<Point> = [];
    for (let index = 0; index < 400; index++) {
      const a = (2 * Math.PI * index) / 400;
      const p: Point = [0.3 + 0.12 * Math.cos(a), 0.3 + 0.03 * Math.sin(a)];
      zigzag.push(p, [p[0] + 0.004, p[1] + 0.008], [p[0] - 0.004, p[1] - 0.008]);
    }
    zigzag.push(zigzag[0]!);
    expect(shapeOf(zigzag)).toBe("mark");
    expect(shapeOf(turnsOf([0.3, 0.3], [0.12, 0.03], 100))).toBe("mark");

    const long: Array<Point> = Array.from({ length: 3_000 }, (_, k) => {
      const a = (2 * Math.PI * k) / 2_500;
      return [0.3 + 0.1 * Math.cos(a), 0.3 + 0.05 * Math.sin(a)];
    });
    const mark = marksOf([stroke(long)], 10_000, 10_000)[0]!;
    expect(mark.shape).toBe("circle");
    expectBox(mark, [0.2, 0.25, 0.4, 0.35]);
  });
});

describe("marksOf", () => {
  it("points a two-stroke arrow toward its head in either drawing direction", () => {
    const head: ReadonlyArray<Point> = [
      [0.42, 0.5],
      [0.5, 0.5],
      [0.5, 0.58],
    ];
    const shafts: ReadonlyArray<ReadonlyArray<Point>> = [
      [
        [0.2, 0.8],
        [0.5, 0.5],
      ],
      [
        [0.5, 0.5],
        [0.2, 0.8],
      ],
    ];
    for (const shaft of shafts) {
      const marks = marksOf([stroke(shaft, 0, 100), stroke(head, 200, 300)], 1000, 1000);
      expect(marks).toHaveLength(1);
      expect(marks[0]).toMatchObject({ shape: "arrow", from: [0.2, 0.8], to: [0.5, 0.5] });
    }
  });

  it("starts a new mark after a pause and after six strokes, keeping every stroke", () => {
    const dot: ReadonlyArray<Point> = [
      [0.5, 0.5],
      [0.6, 0.5],
    ];
    const close = Array.from({ length: 8 }, (_, index) => stroke(dot, index * 200, index * 200));
    const marks = marksOf([...close, stroke(dot, 5_000, 5_100)], 1000, 1000);
    expect(marks.map((mark) => mark.strokes)).toEqual([[0, 1, 2, 3, 4, 5], [6, 7], [8]]);
    expect(marks.map((mark) => mark.id)).toEqual(["m1", "m2", "m3"]);
    expect(marks[0]).toMatchObject({ shape: "underline", t0: 0, t1: 1_000 });
  });

  it("keeps a group of differing strokes a plain mark, with its stroke count", () => {
    const line: ReadonlyArray<Point> = [
      [0.2, 0.2],
      [0.5, 0.6],
    ];
    const marks = marksOf(
      [stroke(line), stroke(ellipse([0.8, 0.8], [0.05, 0.05], 0, 2 * Math.PI), 200, 300)],
      1000,
      1000,
    );
    expect(marks[0]!.shape).toBe("mark");
    expect(marks[0]!.description).toContain("(2 strokes)");
  });
});
