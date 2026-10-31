// Which marks share one keyframe: those drawn on the same screen, so one image answers for all their
// ink. Scrawl compares the luma around the ink, in frames that do not show it. Here the video shows
// the ink, so the same question goes to the scene changes that already have the ink filtered out.

import type { NarrationLine } from "./narration";

interface GroupableMark {
  readonly id: string;
  readonly t0: number;
  readonly t1: number;
  readonly strokes: ReadonlyArray<number>;
}

// Past these one frame stops being legible and its words drift from its ink.
const GROUP_MS = 20_000;
const GROUP_STROKES = 12;

export function groupMarks<Mark extends GroupableMark>(
  marks: ReadonlyArray<Mark>,
  input: {
    /** Clicks and drags: what the hand did to the screen between two marks. */
    readonly actionTimes: ReadonlyArray<number>;
    readonly sceneChanges: ReadonlyArray<number>;
    readonly budget: number;
  },
): Array<Array<Mark>> {
  const changesBetween = (from: Mark, to: Mark) =>
    input.sceneChanges.filter((t) => t > from.t1 && t <= to.t1).length;
  const acted = (from: Mark, to: Mark) => input.actionTimes.some((t) => t > from.t1 && t < to.t0);
  const inkOf = (group: ReadonlyArray<Mark>) =>
    group.reduce((sum, mark) => sum + mark.strokes.length, 0);

  const groups: Array<Array<Mark>> = [];
  for (const mark of marks.toSorted((a, b) => a.t1 - b.t1)) {
    const open = groups.at(-1);
    const last = open?.at(-1);
    if (
      open !== undefined &&
      last !== undefined &&
      mark.t1 - open[0]!.t0 <= GROUP_MS &&
      inkOf(open) + mark.strokes.length <= GROUP_STROKES &&
      !acted(last, mark) &&
      changesBetween(last, mark) === 0
    ) {
      open.push(mark);
    } else {
      groups.push([mark]);
    }
  }

  // Over budget: merge neighbours, same-screen pairs with the least ink first, else the most alike.
  while (groups.length > input.budget && groups.length > 1) {
    let best = 1;
    let bestChanges = Infinity;
    let bestInk = Infinity;
    for (let index = 1; index < groups.length; index++) {
      const earlier = groups[index - 1]!;
      const later = groups[index]!;
      const changes = changesBetween(earlier.at(-1)!, later[0]!);
      const ink = inkOf(earlier) + inkOf(later);
      if (changes < bestChanges || (changes === bestChanges && ink < bestInk)) {
        best = index;
        bestChanges = changes;
        bestInk = ink;
      }
    }
    const [later] = groups.splice(best, 1);
    groups[best - 1]!.push(...later!);
  }
  return groups;
}

/** What `scrawl.json` says about a mark once the keyframes are known. */
export function placeMarks<Mark extends { readonly id: string }>(
  marks: ReadonlyArray<Mark>,
  lines: ReadonlyArray<Pick<NarrationLine, "actions">>,
): Array<Mark & { readonly frame?: string; readonly number?: number }> {
  const places = new Map<string, { readonly frame: string; readonly number?: number }>();
  lines.forEach((line, index) => {
    const frame = `frames/frame-${String(index + 1).padStart(2, "0")}.png`;
    for (const action of line.actions) {
      if (action.kind !== "mark") continue;
      places.set(action.id, {
        frame,
        ...(action.number === undefined ? {} : { number: action.number }),
      });
    }
  });
  return marks.map((mark) => ({ ...mark, ...places.get(mark.id) }));
}
