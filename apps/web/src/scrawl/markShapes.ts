// What a hand drew: strokes close in time form a mark, and a mark is recognised by its shape. Scrawl's
// rules (src/sketch.rs), measured in pixels because a circle on a wide screen is flat in fractions.

export type Point = readonly [number, number];
type Box = readonly [number, number, number, number];

export interface InkStroke {
  readonly t0: number;
  readonly t1: number;
  /** x, y, x, y, ... as fractions of the frame. */
  readonly points: ReadonlyArray<number>;
}

/** Scrawl's serialized names: `scrawl.json` has to stay readable by its CLI. */
export type MarkShape = "circle" | "underline" | "line" | "arrow" | "tap" | "mark";

export interface InkMark {
  readonly id: string;
  readonly strokes: ReadonlyArray<number>;
  readonly t0: number;
  readonly t1: number;
  readonly boxNorm: Box;
  readonly shape: MarkShape;
  readonly from?: Point;
  readonly to?: Point;
  readonly description: string;
}

const MARK_GAP_MS = 1_200;
const MAX_MARK_STROKES = 6;
const MAX_LOOP_POINTS = 512;

const pointsOf = (stroke: InkStroke): Array<Point> => {
  const points: Array<Point> = [];
  for (let index = 0; index + 1 < stroke.points.length; index += 2) {
    points.push([stroke.points[index]!, stroke.points[index + 1]!]);
  }
  return points;
};

const boundsOf = (points: ReadonlyArray<Point>): Box => {
  if (points.length === 0) return [0, 0, 0, 0];
  let [x0, y0] = points[0]!;
  let [x1, y1] = points[0]!;
  for (const [x, y] of points) {
    x0 = Math.min(x0, x);
    y0 = Math.min(y0, y);
    x1 = Math.max(x1, x);
    y1 = Math.max(y1, y);
  }
  return [x0, y0, x1, y1];
};

const distance = (a: Point, b: Point) => Math.hypot(a[0] - b[0], a[1] - b[1]);

/** Ramanujan's approximation of the perimeter of the ellipse filling the box. */
const perimeterOf = ([x0, y0, x1, y1]: Box) => {
  const w = x1 - x0;
  const h = y1 - y0;
  return (Math.PI / 2) * (3 * (w + h) - Math.sqrt((3 * w + h) * (w + 3 * h)));
};

/**
 * Whether a path goes round something. Flatter loops, to 5:1 (a wide cell or a line of text gets a
 * flat loop), must also close within their short side, so a flat C doesn't count, and go round at
 * most about three times, so a scribble over text doesn't, though it closes and fills its box too.
 */
const encloses = (gap: number, maxGap: number, length: number, box: Box, area: number) => {
  const w = box[2] - box[0];
  const h = box[3] - box[1];
  const big = Math.max(w, h);
  const small = Math.min(w, h);
  return (
    gap < maxGap * big &&
    length > 2 * big &&
    small >= 18 &&
    area > 0.32 * w * h &&
    (small > 0.42 * big ||
      (small > 0.2 * big && gap < 0.6 * small && length <= 3.5 * perimeterOf(box)))
  );
};

/**
 * The loop inside a stroke that circles something once before or after a lead-in, tail or overshoot,
 * at least 0.6 of the stroke, whose ends meet closest. Every pair of ends is quadratic, so long
 * strokes try every nth point, but judge each stretch by the whole path so sampling can't hide turns.
 */
const loopIn = (points: ReadonlyArray<Point>): readonly [number, number] | null => {
  const count = points.length;
  if (count < 3) return null;
  const run = [0];
  const twiceArea = [0];
  for (let index = 1; index < count; index++) {
    const a = points[index - 1]!;
    const b = points[index]!;
    run.push(run[index - 1]! + distance(a, b));
    twiceArea.push(twiceArea[index - 1]! + a[0] * b[1] - b[0] * a[1]);
  }
  const total = run[count - 1]!;
  const step = Math.ceil(count / MAX_LOOP_POINTS);
  const ends: Array<number> = [];
  for (let index = 0; index < count; index += step) ends.push(index);
  if (ends.at(-1) !== count - 1) ends.push(count - 1);
  let best: { closeness: number; from: number; to: number } | null = null;
  for (let k = 0; k < ends.length; k++) {
    const from = ends[k]!;
    const a = points[from]!;
    let [x0, y0] = a;
    let [x1, y1] = a;
    for (const to of ends.slice(k + 1)) {
      const z = points[to]!;
      x0 = Math.min(x0, z[0]);
      y0 = Math.min(y0, z[1]);
      x1 = Math.max(x1, z[0]);
      y1 = Math.max(y1, z[1]);
      const length = run[to]! - run[from]!;
      if (length < 0.6 * total) continue;
      const gap = distance(a, z);
      const closeness = gap / Math.max(x1 - x0, y1 - y0);
      if (best !== null && closeness >= best.closeness) continue;
      const box: Box = [x0, y0, x1, y1];
      const twice = twiceArea[to]! - twiceArea[from]! + z[0] * a[1] - a[0] * z[1];
      if (
        length <= 1.5 * perimeterOf(box) &&
        encloses(gap, 0.15, length, box, 0.5 * Math.abs(twice))
      ) {
        best = { closeness, from, to };
      }
    }
  }
  return best === null ? null : [best.from, best.to];
};

const offLine = (p: Point, a: Point, b: Point) =>
  Math.abs((b[0] - a[0]) * (a[1] - p[1]) - (a[0] - p[0]) * (b[1] - a[1])) / distance(a, b);

const cosine = (degrees: number) => Math.cos((degrees * Math.PI) / 180);

/**
 * The tip of an arrow drawn in one stroke: a straight shaft, where the stroke turns back into one or
 * two straight barbs, and a head reaching both sides of the shaft. An underline whose end hooks back
 * to one side, ticks, V's and zigzags fail.
 */
const arrowTip = (points: ReadonlyArray<Point>, big: number): number | null => {
  const start = points[0]!;
  let tip = 0;
  let turned = false;
  for (let index = 0; index < points.length; index++) {
    const d = distance(start, points[index]!);
    const far = distance(start, points[tip]!);
    if (d >= far) {
      tip = index;
    } else if (far >= 0.5 * big && d < 0.85 * far) {
      turned = true;
      break;
    }
  }
  const t = points[tip]!;
  const shaft = distance(start, t);
  if (!turned || points.slice(0, tip).some((p) => offLine(p, start, t) > 0.1 * shaft)) return null;

  // The direction the shaft arrives in, over its last 30%.
  let arc = 0;
  for (let index = 0; index < tip; index++) arc += distance(points[index]!, points[index + 1]!);
  let travelled = 0;
  let back = 0;
  for (let index = 0; index < tip; index++) {
    travelled += distance(points[index]!, points[index + 1]!);
    if (travelled >= 0.7 * arc) {
      back = index;
      break;
    }
  }
  const along = distance(points[back]!, t);
  if (along < 1) return null;
  const dir: Point = [(t[0] - points[back]![0]) / along, (t[1] - points[back]![1]) / along];

  // Barbs: runs away from the tip by at least `slack`, each from the nearest point before it.
  const slack = 0.15 * shaft;
  const barbs: Array<readonly [number, number]> = [];
  let out = tip;
  let near = tip;
  let rising = true;
  for (let index = tip + 1; index < points.length; index++) {
    const p = points[index]!;
    if ((p[0] - t[0]) * dir[0] + (p[1] - t[1]) * dir[1] > slack) return null;
    const d = distance(t, p);
    if (rising) {
      const outAt = distance(t, points[out]!);
      if (d >= outAt) {
        out = index;
      } else if (d < outAt - slack) {
        barbs.push([near, out]);
        near = index;
        rising = false;
      }
    } else {
      const nearAt = distance(t, points[near]!);
      if (d <= nearAt) {
        near = index;
      } else if (d > nearAt + slack) {
        out = index;
        rising = true;
      }
    }
  }
  if (rising && distance(t, points[out]!) >= slack) barbs.push([near, out]);

  const measured: Array<{ readonly length: number; readonly cos: number }> = [];
  for (const [from, end] of barbs) {
    const a = points[from]!;
    const z = points[end]!;
    const span = distance(a, z);
    if (points.slice(from, end + 1).some((p) => offLine(p, a, z) > 0.15 * span)) return null;
    const e: Point = [z[0] - t[0], z[1] - t[1]];
    const length = Math.hypot(e[0], e[1]);
    const cos = -(e[0] * dir[0] + e[1] * dir[1]) / length;
    if (length > 0.9 * shaft || cos < cosine(75)) return null;
    measured.push({ length, cos });
  }
  const [one, two] = measured;
  const head =
    one !== undefined && measured.length === 1
      ? one.length <= 0.6 * shaft && one.cos <= cosine(15)
      : one !== undefined && two !== undefined && measured.length === 2
        ? Math.max(one.cos, two.cos) <= cosine(5)
        : false;

  // The head spreads to both sides of the shaft; an underline that hooks back doesn't.
  let left = 0;
  let right = 0;
  for (const p of points.slice(tip)) {
    const side = dir[0] * (p[1] - t[1]) - dir[1] * (p[0] - t[0]);
    left = Math.max(left, side);
    right = Math.max(right, -side);
  }
  return head && Math.min(left, right) > 0.3 * Math.max(left, right) ? tip : null;
};

interface Ink {
  readonly shape: MarkShape;
  /** What the stroke covers: a circle's loop without its lead-in or tail, else the whole stroke. */
  readonly region: Box;
  /** A one-stroke arrow's shaft start and tip. */
  readonly ends?: readonly [Point, Point];
}

const inkOf = (norm: ReadonlyArray<Point>, width: number, height: number): Ink => {
  const region = boundsOf(norm);
  const points = norm.map(([x, y]): Point => [x * width, y * height]);
  const first = points[0];
  if (first === undefined) return { shape: "tap", region };
  const last = points.at(-1)!;
  const box = boundsOf(points);
  const w = box[2] - box[0];
  const h = box[3] - box[1];
  let length = 0;
  let shoelace = last[0] * first[1] - first[0] * last[1];
  for (let index = 1; index < points.length; index++) {
    const a = points[index - 1]!;
    const b = points[index]!;
    length += distance(a, b);
    shoelace += a[0] * b[1] - b[0] * a[1];
  }
  const chord = distance(first, last);
  const loopBox = (): Box | null => {
    const loop = loopIn(points);
    return loop === null ? null : boundsOf(norm.slice(loop[0], loop[1] + 1));
  };
  if (Math.hypot(w, h) < 14) return { shape: "tap", region };
  if (encloses(chord, 0.35, length, box, 0.5 * Math.abs(shoelace))) {
    // A stroke that goes round more than once keeps its whole box.
    const loop = length <= 1.5 * perimeterOf(box) ? loopBox() : null;
    return { shape: "circle", region: loop ?? region };
  }
  if (chord > 0.88 * length) return { shape: w > 2.5 * h ? "underline" : "line", region };
  const loop = loopBox();
  if (loop !== null) return { shape: "circle", region: loop };
  const tip = arrowTip(points, Math.max(w, h));
  if (tip !== null) return { shape: "arrow", region, ends: [norm[0]!, norm[tip]!] };
  return { shape: "mark", region };
};

const at = ([x, y]: Point) => `x ${x.toFixed(2)}, y ${y.toFixed(2)}`;

const describeMark = (
  mark: Pick<InkMark, "shape" | "boxNorm" | "from" | "to">,
  strokeCount: number,
): string => {
  const [x0, y0, x1, y1] = mark.boxNorm;
  const many = strokeCount > 1 ? ` (${strokeCount} strokes)` : "";
  const region = `x ${x0.toFixed(2)}–${x1.toFixed(2)}, y ${y0.toFixed(2)}–${y1.toFixed(2)}`;
  switch (mark.shape) {
    case "circle":
      return `circled region ${region}${many}`;
    case "underline":
      return `underlined x ${x0.toFixed(2)}–${x1.toFixed(2)} at y ${((y0 + y1) / 2).toFixed(2)}${many}`;
    case "line":
      return `drew a line from ${at(mark.from ?? [x0, y0])} to ${at(mark.to ?? [x1, y1])}`;
    case "arrow":
      return `drew an arrow from ${at(mark.from ?? [x0, y0])} pointing to ${at(mark.to ?? [x1, y1])}`;
    case "tap":
      return `tapped ${at([(x0 + x1) / 2, (y0 + y1) / 2])}${many}`;
    case "mark":
      return `marked region ${region}${many}`;
  }
};

/** The shape one group of strokes makes together: `box` is what a circle circled. */
const recognise = (
  group: ReadonlyArray<ReadonlyArray<Point>>,
  width: number,
  height: number,
): Pick<InkMark, "shape" | "from" | "to"> & { readonly box?: Box } => {
  const sized = group
    .map((points) => {
      const box = boundsOf(points);
      return {
        points,
        box,
        ink: inkOf(points, width, height),
        size: (box[2] - box[0]) * width + (box[3] - box[1]) * height,
      };
    })
    .toSorted((a, b) => b.size - a.size);
  const main = sized[0]!;
  const rest = sized.slice(1);
  const shape = main.ink.shape;
  const a = main.points[0] ?? ([0, 0] as const);
  const z = main.points.at(-1) ?? a;

  if ((shape === "line" || shape === "underline") && (rest.length === 1 || rest.length === 2)) {
    const pixels = ([x, y]: Point): Point => [x * width, y * height];
    const shaft = distance(pixels(a), pixels(z));
    const headAt = (end: Point) =>
      rest.every(
        ({ box }) =>
          distance(pixels([(box[0] + box[2]) / 2, (box[1] + box[3]) / 2]), pixels(end)) <
          0.35 * shaft,
      );
    if (headAt(z)) return { shape: "arrow", from: a, to: z };
    if (headAt(a)) return { shape: "arrow", from: z, to: a };
  }
  if (shape === "circle") {
    const allCircles = rest.every(({ ink }) => ink.shape === "circle");
    const box = allCircles
      ? boundsOf(
          sized.flatMap(({ ink: { region } }): Array<Point> => [
            [region[0], region[1]],
            [region[2], region[3]],
          ]),
        )
      : main.ink.region;
    return { shape, box };
  }
  if (!rest.every(({ ink }) => ink.shape === shape)) return { shape: "mark" };
  if (shape === "line") return rest.length === 0 ? { shape, from: a, to: z } : { shape: "mark" };
  if (shape === "arrow") {
    return rest.length === 0 && main.ink.ends !== undefined
      ? { shape, from: main.ink.ends[0], to: main.ink.ends[1] }
      : { shape: "mark" };
  }
  return { shape };
};

/** Strokes are in drawing order, `width` and `height` the frame's size in pixels. */
export function marksOf(
  strokes: ReadonlyArray<InkStroke>,
  width: number,
  height: number,
): Array<InkMark> {
  const groups: Array<Array<number>> = [];
  strokes.forEach((stroke, index) => {
    const group = groups.at(-1);
    if (
      group !== undefined &&
      group.length < MAX_MARK_STROKES &&
      stroke.t0 - strokes[group.at(-1)!]!.t1 <= MARK_GAP_MS
    ) {
      group.push(index);
    } else {
      groups.push([index]);
    }
  });
  return groups.map((group, index) => {
    const points = group.map((strokeIndex) => pointsOf(strokes[strokeIndex]!));
    const { box, ...recognised } = recognise(points, width, height);
    const boxNorm = box ?? boundsOf(points.flat());
    return {
      id: `m${index + 1}`,
      strokes: group,
      t0: strokes[group[0]!]!.t0,
      t1: Math.max(...group.map((strokeIndex) => strokes[strokeIndex]!.t1)),
      boxNorm,
      ...recognised,
      description: describeMark({ ...recognised, boxNorm }, group.length),
    };
  });
}
