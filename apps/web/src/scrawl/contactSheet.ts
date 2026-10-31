// Lays keyframes of any shape into justified rows in time order, so a tall crop and a wide one both
// stay readable. The cost terms are Scrawl's (src/render.rs), tuned with blind reading tests.

const SHEET_PAD = 6;
const SHEET_GAP = 6;
const MAX_EDGE = 1600;
// Past about this, a vision model's API scales the image down again.
const MAX_PIXELS = 1_560_000;
const MAX_ROW = 6;
// Every split of up to 12 frames is a few thousand candidates; more would never finish.
const MAX_SEARCHED = 12;
const WIDE_FRAME = 1.85;

type Rows = ReadonlyArray<readonly [start: number, end: number]>;

const sumOf = (values: ReadonlyArray<number>) => values.reduce((sum, value) => sum + value, 0);

function costOf(rows: Rows, aspects: ReadonlyArray<number>, targetSheet: number) {
  const count = aspects.length;
  const average = sumOf(aspects) / count;
  const targetRow = Math.max(Math.sqrt(sumOf(aspects) * targetSheet), average);
  const rowAspects = rows.map(([start, end]) => sumOf(aspects.slice(start, end)));
  const sheetAspect = 1 / sumOf(rowAspects.map((aspect) => 1 / aspect));

  // Relative displayed area of a frame in a row is its aspect over the row's squared.
  const areas = rows.flatMap(([start, end], row) =>
    aspects.slice(start, end).map((aspect) => aspect / rowAspects[row]! ** 2),
  );
  const logAreas = areas.map(Math.log);
  const meanLogArea = sumOf(logAreas) / count;
  const areaVariance = sumOf(logAreas.map((value) => (value - meanLogArea) ** 2)) / count;
  const sorted = areas.toSorted((a, b) => a - b);
  const medianArea =
    Math.max(sorted[Math.trunc((count - 1) / 2)]! + sorted[Math.trunc(count / 2)]!, 1e-6) * 0.5;
  let cost = Math.log(sheetAspect / targetSheet) ** 2 * 1.8 + areaVariance * 8;
  for (const area of areas) {
    const ratio = area / medianArea;
    if (ratio < 0.58) cost += ((0.58 - ratio) / 0.58) ** 2 * 18;
    if (ratio > 2.3) cost += ((ratio - 2.3) / 2.3) ** 2 * 4;
  }

  const meanLogRow = sumOf(rowAspects.map(Math.log)) / rows.length;
  let rowVariance = 0;
  let rowOff = 0;
  if (rows.length > 4) cost += (rows.length - 4) * 2.5;
  rows.forEach(([start, end], row) => {
    const aspect = rowAspects[row]!;
    rowVariance += (Math.log(aspect) - meanLogRow) ** 2;
    rowOff += Math.log(aspect / targetRow) ** 2;
    for (const frame of aspects.slice(start, end)) {
      const share = (frame / aspect) * Math.min(sheetAspect, 1);
      if (share < 0.16) cost += ((0.16 - share) / 0.16) ** 2 * 8;
    }
    const columns = end - start;
    if (columns > 4 && average > 0.75) cost += (columns - 4) * 2;
    if (columns > 3 && average > 1.15) cost += (columns - 3) * 2;
    cost += row * 1e-4 * columns;
  });
  return cost + (rowVariance / rows.length) * 0.6 + (rowOff / rows.length) * 0.4;
}

/** Splits frames of these aspect ratios, in time order, into rows of one to six. */
export function planSheetRows(aspects: ReadonlyArray<number>): Rows {
  const count = aspects.length;
  if (count === 0) return [];
  if (count === 1) return [[0, 1]];
  if (count === 2) {
    return aspects[0]! + aspects[1]! > 3.6
      ? [
          [0, 1],
          [1, 2],
        ]
      : [[0, 2]];
  }
  if (count > MAX_SEARCHED) {
    const columns = Math.ceil(Math.sqrt(count));
    return Array.from(
      { length: Math.ceil(count / columns) },
      (_, row) => [row * columns, Math.min((row + 1) * columns, count)] as const,
    );
  }
  const targetSheet = sumOf(aspects) / count < 0.7 ? 1.05 : 1.25;
  let best: Rows = [[0, count]];
  let bestCost = Infinity;
  const current: Array<readonly [number, number]> = [];
  const search = (start: number) => {
    if (start === count) {
      const cost = costOf(current, aspects, targetSheet);
      if (cost < bestCost) {
        bestCost = cost;
        best = [...current];
      }
      return;
    }
    for (let size = 1; size <= Math.min(MAX_ROW, count - start); size++) {
      // A frame gets a row of its own only when it is wide enough to use it.
      if (size === 1 && aspects[start]! < WIDE_FRAME) continue;
      current.push([start, start + size]);
      search(start + size);
      current.pop();
    }
  };
  search(0);
  return best;
}

export interface SheetCell {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface SheetLayout {
  readonly width: number;
  readonly height: number;
  readonly cells: ReadonlyArray<SheetCell>;
}

/** Whole-pixel places for frames of these sizes, within the sheet's size caps. */
export function layoutSheet(
  frames: ReadonlyArray<{ readonly width: number; readonly height: number }>,
): SheetLayout {
  const aspects = frames.map(({ width, height }) =>
    Math.min(4.5, Math.max(0.25, Math.max(width, 1) / Math.max(height, 1))),
  );
  const rows = planSheetRows(aspects);
  const rowAspects = rows.map(([start, end]) => Math.max(sumOf(aspects.slice(start, end)), 0.1));
  const sheetAspect = 1 / Math.max(sumOf(rowAspects.map((aspect) => 1 / aspect)), 0.01);
  const nativeRow = rows.reduce((widest, [start, end]) => {
    const width = sumOf(frames.slice(start, end).map((frame) => frame.width));
    return Math.max(widest, width + SHEET_GAP * (end - start - 1));
  }, 0);
  const desired = Math.max(nativeRow, frames.length === 1 ? 640 : 960);
  const edge = MAX_EDGE - 2 * SHEET_PAD;
  let inner = sheetAspect >= 1 ? Math.min(edge, desired) : Math.min(edge * sheetAspect, desired);
  const innerHeight =
    sumOf(
      rows.map(([start, end], row) => {
        const available = Math.max(inner - SHEET_GAP * (end - start - 1), 32);
        return available / rowAspects[row]!;
      }),
    ) +
    SHEET_GAP * Math.max(0, rows.length - 1);
  const totalWidth = inner + 2 * SHEET_PAD;
  const totalHeight = innerHeight + 2 * SHEET_PAD;
  const scale = Math.min(
    1,
    MAX_EDGE / Math.max(totalWidth, totalHeight),
    Math.sqrt(MAX_PIXELS / (totalWidth * totalHeight)),
  );
  if (scale < 1) inner = Math.max(totalWidth * scale - 2 * SHEET_PAD, 64);
  const innerWidth = Math.max(Math.round(inner + 2 * SHEET_PAD), 64) - 2 * SHEET_PAD;

  const cells: Array<SheetCell> = [];
  let y = SHEET_PAD;
  rows.forEach(([start, end], row) => {
    const available = Math.max(innerWidth - SHEET_GAP * (end - start - 1), 1);
    const rowAspect = rowAspects[row]!;
    const height = Math.max(Math.round(available / rowAspect), 1);
    let along = 0;
    for (let index = start; index < end; index++) {
      const left = Math.round(available * (along / rowAspect));
      along += aspects[index]!;
      const right = index + 1 === end ? available : Math.round(available * (along / rowAspect));
      cells.push({
        x: SHEET_PAD + left + (index - start) * SHEET_GAP,
        y,
        width: Math.max(right - left, 1),
        height,
      });
    }
    y += height + SHEET_GAP;
  });
  return { width: innerWidth + 2 * SHEET_PAD, height: y - SHEET_GAP + SHEET_PAD, cells };
}
