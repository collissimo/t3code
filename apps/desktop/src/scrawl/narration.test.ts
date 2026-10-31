import { describe, expect, it } from "vitest";

import {
  buildNarration,
  foldActions,
  formatNarrationLine,
  splitSentences,
  type TimedWord,
} from "./narration.ts";

const say = (text: string, start = 0, wordMs = 300): Array<TimedWord> =>
  text.split(" ").map((word, index) => ({
    text: word,
    t0: start + index * wordMs,
    t1: start + (index + 1) * wordMs,
  }));

describe("splitSentences", () => {
  it("keeps a thinking pause and a wrong full stop inside the sentence", () => {
    const words = [
      ...say("Ich will hier bitte", 0),
      ...say("eine andere Ansicht. der einzelnen Tage.", 3_000),
      ...say("Neuer Satz.", 6_000),
    ];
    expect(splitSentences(words).map((sentence) => sentence.words.join(" "))).toEqual([
      "Ich will hier bitte eine andere Ansicht. der einzelnen Tage.",
      "Neuer Satz.",
    ]);
  });

  it("gives up on an unfinished sentence after a long silence", () => {
    const words = [...say("Ich will hier", 0), ...say("Neuer Satz.", 10_000)];
    expect(splitSentences(words)).toHaveLength(2);
  });
});

describe("foldActions", () => {
  it("folds click bursts and drops the hand's small drags", () => {
    const actions = foldActions(
      [
        { kind: "click", t: 1_000, x: 0.1, y: 0.1 },
        { kind: "click", t: 1_500, x: 0.2, y: 0.1 },
        { kind: "click", t: 2_900, x: 0.3, y: 0.1 },
        { kind: "click", t: 9_000, x: 0.5, y: 0.5 },
        { kind: "drag", t: 12_000, t1: 12_200, x0: 0.5, y0: 0.5, x1: 0.51, y1: 0.5 },
        { kind: "drag", t: 13_000, t1: 13_400, x0: 0.5, y0: 0.5, x1: 0.1, y1: 0.5 },
      ],
      [],
    );
    expect(actions).toMatchObject([
      { kind: "clicks", count: 3, t0: 1_000, t1: 2_900 },
      { kind: "clicks", count: 1, t0: 9_000 },
      { kind: "drag", direction: "left" },
    ]);
  });
});

describe("buildNarration", () => {
  it("never cuts a sentence at a click, and loses no word, click or mark", () => {
    const words = say("Bitte diese Boxen hier entfernen und den Text darunter auch.", 0);
    const lines = buildNarration({
      words,
      events: [
        { kind: "click", t: 600, x: 0.1, y: 0.1 },
        { kind: "click", t: 2_000, x: 0.4, y: 0.4 },
      ],
      marks: [{ id: "m1", t0: 900, t1: 1_100 }],
      durationMs: 4_000,
    });
    expect(lines.map((line) => line.text)).toEqual([words.map((word) => word.text).join(" ")]);
    expect(lines[0]!.actions.map((action) => action.kind).toSorted()).toEqual(["clicks", "mark"]);
    expect(formatNarrationLine(lines[0]!, 0)).toBe(
      "- #1 (0:01) [marked, clicked ×2] “Bitte diese Boxen hier entfernen und den Text darunter auch.”",
    );
  });

  it("gives a click said over no speech its own line", () => {
    const lines = buildNarration({
      words: say("Hallo Welt.", 0),
      events: [{ kind: "click", t: 20_000, x: 0.5, y: 0.5 }],
      marks: [{ id: "m1", t0: 100, t1: 300 }],
      durationMs: 25_000,
    });
    expect(formatNarrationLine(lines.at(-1)!, 1)).toBe("- #2 (0:20) clicked");
  });

  it("keeps every mark over budget, and speech ahead of the first keyframe with it", () => {
    const marks = Array.from({ length: 9 }, (_, index) => ({
      id: `m${index}`,
      t0: 2_000 + index * 2_000,
      t1: 2_100 + index * 2_000,
    }));
    const words = [
      ...say("Erster Satz ohne Aktion.", 0, 100),
      ...marks.flatMap((mark) => say("Das hier markiert.", mark.t0, 100)),
    ];
    const lines = buildNarration({ words, events: [], marks, durationMs: 22_000 });
    expect(lines).toHaveLength(9);
    expect(lines[0]!.text).toBe("Erster Satz ohne Aktion. Das hier markiert.");
  });
});
