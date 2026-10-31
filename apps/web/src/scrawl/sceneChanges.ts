// Finds moments the screen changed from small luma thumbnails, so nothing but a 64x36 grid is kept
// per sample. Scrawl's rule: a moving cursor spans at most a few of the 8x6 blocks, so the score is
// the fourth-worst block, and real transitions across at least four blocks still register.

export const THUMB_WIDTH = 64;
export const THUMB_HEIGHT = 36;
const COLUMNS = 8;
const ROWS = 6;
const CHANGE_THRESHOLD = 0.03;

export interface LumaSample {
  readonly t: number;
  readonly luma: Float32Array;
}

function sceneDifference(a: Float32Array, b: Float32Array): number {
  const blockWidth = THUMB_WIDTH / COLUMNS;
  const blockHeight = THUMB_HEIGHT / ROWS;
  let global = 0;
  const blocks: Array<number> = [];
  for (let row = 0; row < ROWS; row++) {
    for (let column = 0; column < COLUMNS; column++) {
      let sum = 0;
      for (let y = row * blockHeight; y < (row + 1) * blockHeight; y++) {
        for (let x = column * blockWidth; x < (column + 1) * blockWidth; x++) {
          const index = y * THUMB_WIDTH + x;
          sum += Math.abs(a[index]! - b[index]!);
        }
      }
      global += sum;
      blocks.push(sum / (blockWidth * blockHeight));
    }
  }
  blocks.sort((x, y) => y - x);
  return Math.max(global / (THUMB_WIDTH * THUMB_HEIGHT), Math.min(1, blocks[3]! * 1.4));
}

// One sample either way: a change is only seen at the next sample after it happened.
const INK_MARGIN_MS = 750;

/** Drawing and fading ink changes the picture without the screen doing anything. */
export function withoutInkChanges(
  changes: ReadonlyArray<number>,
  strokes: ReadonlyArray<{ readonly t0: number; readonly t1: number }>,
  inkHoldMs: number,
): Array<number> {
  return changes.filter(
    (t) =>
      !strokes.some(
        ({ t0, t1 }) =>
          (t >= t0 - INK_MARGIN_MS && t <= t1 + INK_MARGIN_MS) ||
          Math.abs(t - (t1 + inkHoldMs)) <= INK_MARGIN_MS,
      ),
  );
}

export function findSceneChanges(samples: ReadonlyArray<LumaSample>): Array<number> {
  const changes: Array<number> = [];
  for (let index = 1; index < samples.length; index++) {
    const difference = sceneDifference(samples[index - 1]!.luma, samples[index]!.luma);
    if (difference >= CHANGE_THRESHOLD) changes.push(samples[index]!.t);
  }
  return changes;
}
