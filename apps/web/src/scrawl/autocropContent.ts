// What a keyframe's pixels tell the crop: which regions changed since the last keyframe, and where
// the screen is empty, so crop edges land in white space rather than through a line of text. Rules
// and numbers are Scrawl's (src/autocrop.rs). Sizes are in capture points.

import type { Rect } from "./autocrop";

export interface RgbaImage {
  readonly width: number;
  readonly height: number;
  readonly data: Uint8ClampedArray;
}

const clip = (r: Rect): Rect => [
  Math.max(r[0], 0),
  Math.max(r[1], 0),
  Math.min(r[2], 1),
  Math.min(r[3], 1),
];

const CELL_PT = 3;
const EDGE_CONTRAST = 28;

// Which 3 pt cells of a frame have edges in them (text, borders, icons), as an integral image.
export interface ContentMap {
  readonly cols: number;
  readonly rows: number;
  readonly sum: Uint32Array;
}

const lumaAt = (image: RgbaImage, x: number, y: number) => {
  const at = (y * image.width + x) * 4;
  return Math.trunc((image.data[at]! * 3 + image.data[at + 1]! * 6 + image.data[at + 2]!) / 10);
};

export function contentMap(image: RgbaImage, screen: readonly [number, number]): ContentMap {
  const cols = Math.max(1, Math.round(screen[0] / CELL_PT));
  const rows = Math.max(1, Math.round(screen[1] / CELL_PT));
  const sum = new Uint32Array((cols + 1) * (rows + 1));
  const { width, height } = image;
  if (width < 2 || height < 2) return { cols, rows, sum };
  const step = Math.max(1, Math.trunc(Math.trunc(width / cols) / 3));
  for (let row = 0; row < rows; row++) {
    const y0 = Math.trunc((row * height) / rows);
    const y1 = Math.max(y0 + 1, Math.min(Math.trunc(((row + 1) * height) / rows), height - 1));
    let along = 0;
    for (let col = 0; col < cols; col++) {
      const x0 = Math.trunc((col * width) / cols);
      const x1 = Math.max(x0 + 1, Math.min(Math.trunc(((col + 1) * width) / cols), width - 1));
      let busy = false;
      for (let y = y0; y < y1 && !busy; y += step) {
        for (let x = x0; x < x1 && !busy; x += step) {
          const luma = lumaAt(image, x, y);
          busy =
            Math.abs(luma - lumaAt(image, x + 1, y)) >= EDGE_CONTRAST ||
            Math.abs(luma - lumaAt(image, x, y + 1)) >= EDGE_CONTRAST;
        }
      }
      if (busy) along++;
      sum[(row + 1) * (cols + 1) + col + 1] = sum[row * (cols + 1) + col + 1]! + along;
    }
  }
  return { cols, rows, sum };
}

/** Busy cells in columns `c0..c1` and rows `r0..r1`. */
function busyCells(content: ContentMap, c0: number, r0: number, c1: number, r1: number) {
  const right = Math.min(c1, content.cols);
  const bottom = Math.min(r1, content.rows);
  const left = Math.max(c0, 0);
  const top = Math.max(r0, 0);
  if (left >= right || top >= bottom) return 0;
  const at = (c: number, r: number) => content.sum[r * (content.cols + 1) + c]!;
  return at(right, bottom) + at(left, top) - at(left, bottom) - at(right, top);
}

const CHANGE_COLUMNS = 64;
const CHANGE_SAMPLES = 8;
const CHANGE_LUMA = 10;
const MAX_CHANGE_REGIONS = 8;

/** Coarse regions that differ between two frames, largest first. A lone cell is noise. */
export function changeRegions(previous: RgbaImage, current: RgbaImage): Array<Rect> {
  if (
    previous.width < CHANGE_COLUMNS ||
    current.width < CHANGE_COLUMNS ||
    previous.height < 8 ||
    current.height < 8
  ) {
    return [];
  }
  const cell = Math.trunc(current.width / CHANGE_COLUMNS);
  const rows = Math.max(1, Math.trunc(current.height / cell));
  const sample = (image: RgbaImage, nx: number, ny: number) =>
    lumaAt(
      image,
      Math.min(Math.trunc(nx * image.width), image.width - 1),
      Math.min(Math.trunc(ny * image.height), image.height - 1),
    );
  const changed = new Uint8Array(CHANGE_COLUMNS * rows);
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < CHANGE_COLUMNS; col++) {
      let difference = 0;
      for (let sy = 0; sy < CHANGE_SAMPLES; sy++) {
        for (let sx = 0; sx < CHANGE_SAMPLES; sx++) {
          const nx = (col + (sx + 0.5) / CHANGE_SAMPLES) / CHANGE_COLUMNS;
          const ny = (row + (sy + 0.5) / CHANGE_SAMPLES) / rows;
          difference += Math.abs(sample(previous, nx, ny) - sample(current, nx, ny));
        }
      }
      if (difference / (CHANGE_SAMPLES * CHANGE_SAMPLES) >= CHANGE_LUMA) {
        changed[row * CHANGE_COLUMNS + col] = 1;
      }
    }
  }
  const boxes: Array<{ readonly size: number; readonly rect: Rect }> = [];
  for (let start = 0; start < changed.length; start++) {
    if (changed[start] !== 1) continue;
    changed[start] = 2;
    const stack = [start];
    let [c0, r0, c1, r1, count] = [CHANGE_COLUMNS, rows, 0, 0, 0];
    while (stack.length > 0) {
      const at = stack.pop()!;
      const row = Math.trunc(at / CHANGE_COLUMNS);
      const col = at % CHANGE_COLUMNS;
      c0 = Math.min(c0, col);
      r0 = Math.min(r0, row);
      c1 = Math.max(c1, col);
      r1 = Math.max(r1, row);
      count++;
      for (let dr = -1; dr <= 1; dr++) {
        for (let dc = -1; dc <= 1; dc++) {
          const nr = row + dr;
          const nc = col + dc;
          if (nr < 0 || nc < 0 || nr >= rows || nc >= CHANGE_COLUMNS) continue;
          const next = nr * CHANGE_COLUMNS + nc;
          if (changed[next] === 1) {
            changed[next] = 2;
            stack.push(next);
          }
        }
      }
    }
    if (count >= 2) {
      boxes.push({
        size: (c1 - c0 + 1) * (r1 - r0 + 1),
        rect: [c0 / CHANGE_COLUMNS, r0 / rows, (c1 + 1) / CHANGE_COLUMNS, (r1 + 1) / rows],
      });
    }
  }
  return boxes
    .toSorted((a, b) => b.size - a.size)
    .slice(0, MAX_CHANGE_REGIONS)
    .map((box) => box.rect);
}

const SNAP_OUT = 120;
const SNAP_OUT_SHARE = 0.6;
const SNAP_IN = 60;
const COLUMN_GAP = 12;
const TRIM_MARGIN = 24;
const CONTENT_REACH = 360;
const CONTENT_EXTRA = 160;

interface Frame {
  readonly content: ContentMap;
  readonly screen: readonly [number, number];
  readonly minSize: readonly [number, number];
  readonly maxZoom: number;
}

/** Moves each edge to the nearest stretch of empty screen, never into `keep`, then trims margins. */
function snapToEmptySpace({ content, screen, minSize, maxZoom }: Frame, r: Rect, keep: Rect): Rect {
  const { cols, rows } = content;
  const reach = (size: number) => Math.round(Math.max(SNAP_OUT, SNAP_OUT_SHARE * size) / CELL_PT);
  const outX = reach((r[2] - r[0]) * screen[0]);
  const outY = reach((r[3] - r[1]) * screen[1]);
  const inward = Math.round(SNAP_IN / CELL_PT);
  const snapEdge = (
    position: number,
    limit: number,
    count: number,
    gap: number,
    direction: -1 | 1,
    out: number,
    empty: (line: number) => boolean,
  ) => {
    // The `gap` lines just inside a boundary are empty, so nothing straddles it.
    const clean = (boundary: number) => {
      for (let k = 0; k < gap; k++) {
        const line = direction < 0 ? boundary + k : boundary - 1 - k;
        if (line >= 0 && line < count && !empty(line)) return false;
      }
      return true;
    };
    if (clean(position)) return position;
    for (let distance = 1; distance <= Math.max(out, inward); distance++) {
      const outer = position + direction * distance;
      if (distance <= out && outer >= 0 && outer <= count && clean(outer)) return outer;
      const inner = position - direction * distance;
      const insideKeep = direction < 0 ? inner > limit : inner < limit;
      if (distance <= inward && !insideKeep && inner >= 0 && inner <= count && clean(inner)) {
        return inner;
      }
    }
    return position;
  };
  let c0 = Math.floor(r[0] * cols);
  let c1 = Math.ceil(r[2] * cols);
  let r0 = Math.floor(r[1] * rows);
  let r1 = Math.ceil(r[3] * rows);
  const k0 = Math.floor(keep[0] * cols);
  const k1 = Math.floor(keep[1] * rows);
  const k2 = Math.ceil(keep[2] * cols);
  const k3 = Math.ceil(keep[3] * rows);
  // Rules and borders that cross the whole crop don't make a gutter look full.
  const tenth = (span: number) => Math.max(0, Math.trunc(span / 10));
  const columnEmpty = (c: number) => busyCells(content, c, r0, c + 1, r1) <= tenth(r1 - r0);
  const columnGap = Math.round(COLUMN_GAP / CELL_PT);
  c0 = snapEdge(c0, k0, cols, columnGap, -1, outX, columnEmpty);
  c1 = snapEdge(c1, k2, cols, columnGap, 1, outX, columnEmpty);
  const rowEmpty = (row: number) => busyCells(content, c0, row, c1, row + 1) <= tenth(c1 - c0);
  r0 = snapEdge(r0, k1, rows, 1, -1, outY, rowEmpty);
  r1 = snapEdge(r1, k3, rows, 1, 1, outY, rowEmpty);

  const margin = Math.round(TRIM_MARGIN / CELL_PT);
  const few = (span: number) => Math.max(0, Math.trunc(span / 30));
  const blankRun = (
    from: number,
    step: 1 | -1,
    limit: number,
    empty: (line: number) => boolean,
  ) => {
    let run = 0;
    while ((from + step * run - limit) * step < 0 && empty(from + step * run)) run++;
    return run;
  };
  const clamp = (value: number, high: number) => Math.min(Math.max(value, 0), high);
  const minCols = Math.round(Math.max(minSize[0], screen[0] / maxZoom) / CELL_PT);
  const sparseColumn = (c: number) => busyCells(content, c, r0, c + 1, r1) <= few(r1 - r0);
  const spareCols = Math.max(0, c1 - c0 - minCols);
  const cutLeft = clamp(blankRun(c0, 1, k0, sparseColumn) - margin, spareCols);
  const cutRight = clamp(blankRun(c1 - 1, -1, k2 - 1, sparseColumn) - margin, spareCols - cutLeft);
  c0 += cutLeft;
  c1 -= cutRight;
  const minRows = Math.round(minSize[1] / CELL_PT);
  const sparseRow = (row: number) => busyCells(content, c0, row, c1, row + 1) <= few(c1 - c0);
  const spareRows = Math.max(0, r1 - r0 - minRows);
  const cutTop = clamp(blankRun(r0, 1, k1, sparseRow) - margin, spareRows);
  const cutBottom = clamp(blankRun(r1 - 1, -1, k3 - 1, sparseRow) - margin, spareRows - cutTop);
  r0 += cutTop;
  r1 -= cutBottom;
  return clip([c0 / cols, r0 / rows, c1 / cols, r1 / rows]);
}

/** A prompt at the bottom of an empty terminal: when most of the crop is blank, reach for content. */
function reachForContent({ content }: Frame, r: Rect, keep: Rect): Rect | null {
  const { cols, rows } = content;
  const c0 = Math.max(0, Math.floor(r[0] * cols));
  const c1 = Math.ceil(r[2] * cols);
  const r0 = Math.max(0, Math.floor(r[1] * rows));
  const r1 = Math.min(rows, Math.ceil(r[3] * rows));
  const tolerance = Math.trunc(Math.max(0, c1 - c0) / 60);
  const empty = (row: number) => busyCells(content, c0, row, c1, row + 1) <= tolerance;
  let bestStart = 0;
  let bestEnd = 0;
  let run = 0;
  for (let row = r0; row < r1; row++) {
    run = empty(row) ? run + 1 : 0;
    if (run > bestEnd - bestStart) {
      bestStart = row + 1 - run;
      bestEnd = row + 1;
    }
  }
  if ((bestEnd - bestStart) * 2 < Math.max(0, r1 - r0)) return null;
  const reach = Math.trunc(CONTENT_REACH / CELL_PT);
  const extra = CONTENT_EXTRA / CELL_PT;
  const keepTop = Math.trunc(keep[1] * rows);
  const keepBottom = Math.ceil(keep[3] * rows);
  if (bestEnd <= keepTop + 1) {
    for (let row = r0 - 1; row >= Math.max(0, r0 - reach); row--) {
      if (!empty(row)) return [r[0], Math.max(0, row - extra) / rows, r[2], r[3]];
    }
    return null;
  }
  if (bestStart + 1 >= keepBottom) {
    for (let row = r1; row < Math.min(r1 + reach, rows); row++) {
      if (!empty(row)) return [r[0], r[1], r[2], Math.min(rows, row + 1 + extra) / rows];
    }
  }
  return null;
}

/** Follows each line of text that crosses a side edge to its end, so no line is cut mid-word. */
function finishLines({ content, screen }: Frame, r: Rect, within: Rect): Rect {
  const { cols, rows } = content;
  const reach = Math.round(
    Math.max(SNAP_OUT, SNAP_OUT_SHARE * (r[2] - r[0]) * screen[0]) / CELL_PT,
  );
  const gap = Math.round(COLUMN_GAP / CELL_PT);
  if (reach <= 0) return r;
  const busy = (c: number, row: number) =>
    c >= 0 && c < cols && busyCells(content, c, row, c + 1, row + 1) > 0;
  const c0 = Math.floor(r[0] * cols);
  const c1 = Math.ceil(r[2] * cols);
  const r0 = Math.max(0, Math.floor(r[1] * rows));
  const r1 = Math.min(rows, Math.ceil(r[3] * rows));
  const w0 = Math.max(0, Math.floor(Math.max(0, within[0]) * cols));
  const w1 = Math.min(cols, Math.ceil(Math.min(1, within[2]) * cols));
  // Where the line on `row` crossing boundary `edge` ends going `direction`, within `limit`.
  const lineEnd = (row: number, edge: number, direction: 1 | -1, limit: number) => {
    const outside = direction > 0 ? edge : edge - 1;
    const inside = outside - direction;
    const near = (from: number, step: number) => {
      for (let k = 0; k < gap; k++) if (busy(from + step * k, row)) return true;
      return false;
    };
    if (!near(inside, -direction) || !near(outside, direction)) return null;
    let c = outside;
    let last = inside;
    let blank = 0;
    while (blank < gap) {
      if ((c - limit) * direction > 0 || c < 0 || c >= cols) return null;
      if (busy(c, row)) {
        last = c;
        blank = 0;
      } else {
        blank++;
      }
      c += direction;
    }
    // Ending right at the window's edge is a border, not the end of a line.
    return (limit - last) * direction >= 2 * gap ? last : null;
  };
  let right = c1;
  let left = c0;
  for (let row = r0; row < r1; row++) {
    const end = lineEnd(row, c1, 1, Math.min(c1 + reach, w1) - 1);
    if (end !== null) right = Math.max(right, end + 1 + gap);
    const start = lineEnd(row, c0, -1, Math.max(c0 - reach, w0));
    if (start !== null) left = Math.min(left, start - gap);
  }
  return clip([Math.max(left, w0) / cols, r[1], Math.min(right, w1) / cols, r[3]]);
}

/** Edges of a crop around activity, moved off text and UI. `within` caps how far lines may run. */
export function refineCropEdges(frame: Frame, rect: Rect, keep: Rect, within: Rect): Rect {
  let snapped = snapToEmptySpace(frame, rect, keep);
  const grown = reachForContent(frame, snapped, keep);
  if (grown !== null) snapped = snapToEmptySpace(frame, grown, keep);
  return finishLines(frame, snapped, within);
}
