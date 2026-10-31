// What gets drawn on a keyframe: a subtle ring where the click landed, and the keyframe's number.
// Sizes and rules are Scrawl's (src/render.rs). Blind reading tests there found a 20 px chip failed
// on a sheet shown at half size, a bare digit read as screen text, and `#6` read as `8`.

import type { NarrationLine } from "./narration";

const CLICK_NEAR_MS = 600;
// A double click is one place.
const SAME_PLACE = 0.01;

type Point = readonly [x: number, y: number];

const nearSamePlace = (a: Point, b: Point) => Math.hypot(a[0] - b[0], a[1] - b[1]) < SAME_PLACE;

/**
 * The click the frame shows, nearest its moment. Bursts the screen did not answer are a hand pointing
 * at things on this very screen, so all of those stay, back to the last time the screen changed.
 */
export function clicksToRing(
  line: Pick<NarrationLine, "frameT" | "actions">,
  clicks: ReadonlyArray<{ readonly t: number; readonly x: number; readonly y: number }>,
): Array<Point> {
  let nearest: { readonly delta: number; readonly point: Point } | null = null;
  for (const click of clicks) {
    const delta = Math.abs(click.t - line.frameT);
    if (delta <= CLICK_NEAR_MS && (nearest === null || delta < nearest.delta)) {
      nearest = { delta, point: [click.x, click.y] };
    }
  }
  const changedAt = line.actions.reduce((latest, action) => {
    const changed =
      action.kind === "scene" || (action.kind === "clicks" && action.changed === true);
    return changed && action.t0 <= line.frameT ? Math.max(latest, action.t0) : latest;
  }, -Infinity);
  const points: Array<Point> = nearest === null ? [] : [nearest.point];
  for (const action of line.actions) {
    if (action.kind !== "clicks" || action.changed !== false) continue;
    if (action.t0 < changedAt || action.t0 > line.frameT) continue;
    for (const point of action.points) {
      if (!points.some((seen) => nearSamePlace(seen, point))) points.push(point);
    }
  }
  return points;
}

const TOP_EDGE = 0.18;
const LEFT_EDGE = 0.3;
const RIGHT_EDGE = 0.7;

/** Whether the number moves to the top right: ink, a click or the cursor sits under top left. */
export function chipDodgesRight(busy: ReadonlyArray<Point>, focus: ReadonlyArray<Point>): boolean {
  const inTopLeft = ([x, y]: Point) => x >= 0 && x < LEFT_EDGE && y >= 0 && y < TOP_EDGE;
  const inTopRight = ([x, y]: Point) => x > RIGHT_EDGE && x <= 1 && y >= 0 && y < TOP_EDGE;
  return (busy.some(inTopLeft) || focus.some(inTopLeft)) && !focus.some(inTopRight);
}

/** The scale of a chip on a keyframe file. On a sheet every tile uses `SHEET_CHIP_SCALE`. */
export const frameChipScale = (width: number, height: number) =>
  Math.max(Math.min(height / 480, width / 280), 0.45);
export const SHEET_CHIP_SCALE = 0.9;

const annotationScale = (width: number, height: number) =>
  Math.min(2, Math.max(1, Math.min(width, height) / 800, Math.max(width, height) / 1280));

const CLICK_BLUE = "0, 136, 255";
const WHITE = "255, 255, 255";

/** A thin ring and small dot, no fill, so the clicked thing stays readable; never red like ink. */
export function drawClickRing(
  context: CanvasRenderingContext2D,
  [x, y]: Point,
  width: number,
  height: number,
) {
  const k = annotationScale(width, height);
  const ring = (radius: number, thickness: number, color: string) => {
    context.lineWidth = thickness;
    context.strokeStyle = color;
    context.beginPath();
    context.arc(x * width, y * height, radius, 0, Math.PI * 2);
    context.stroke();
  };
  const dot = (radius: number, color: string) => {
    context.fillStyle = color;
    context.beginPath();
    context.arc(x * width, y * height, radius, 0, Math.PI * 2);
    context.fill();
  };
  const radius = 9 * k;
  ring(radius + 1.1 * k, 0.9 * k, `rgba(${WHITE}, 0.4)`);
  ring(radius, 1.3 * k, `rgba(${CLICK_BLUE}, 0.8)`);
  dot(2 * k, `rgba(${WHITE}, 0.5)`);
  dot(1.3 * k, `rgba(${CLICK_BLUE}, 0.9)`);
}

/** The number alone, bold on a small white square with a thin dark ring, inset from a top corner. */
export function drawChip(
  context: CanvasRenderingContext2D,
  label: string,
  cell: {
    readonly x: number;
    readonly y: number;
    readonly width: number;
  },
  scale: number,
  dodgeRight: boolean,
) {
  const size = 16 * scale;
  context.font = `700 ${size}px Arial, system-ui, sans-serif`;
  const textWidth = context.measureText(label).width;
  const height = size * 1.5;
  const width = Math.max(textWidth + size * 0.62, height);
  const inset = 5 * scale;
  const ring = Math.max(1.4 * scale, 1);
  const radius = size * 0.3;
  const x = dodgeRight
    ? Math.max(cell.x + cell.width - width - inset, cell.x + inset)
    : cell.x + inset;
  const y = cell.y + inset;
  context.fillStyle = "rgba(16, 17, 20, 0.9)";
  context.beginPath();
  context.roundRect(x - ring, y - ring, width + 2 * ring, height + 2 * ring, radius + ring);
  context.fill();
  context.fillStyle = "#fafafc";
  context.beginPath();
  context.roundRect(x, y, width, height, radius);
  context.fill();
  context.fillStyle = "#101114";
  context.textAlign = "center";
  context.textBaseline = "middle";
  context.fillText(label, x + width / 2, y + height / 2 + scale * 0.5);
}
