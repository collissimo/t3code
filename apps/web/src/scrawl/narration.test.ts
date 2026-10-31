import { describe, expect, it } from "vite-plus/test";

import {
  buildNarration,
  foldActions,
  formatNarrationLine,
  splitSentences,
  wordsOrWhole,
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

  it("tells a click the screen answered from a hand that was pointing", () => {
    const lines = buildNarration({
      words: say("Das hier und das hier.", 0),
      events: [
        { kind: "click", t: 100, x: 0.1, y: 0.1 },
        { kind: "click", t: 200, x: 0.2, y: 0.1 },
        { kind: "click", t: 5_000, x: 0.5, y: 0.5 },
      ],
      marks: [],
      durationMs: 7_000,
      sceneChanges: [5_400],
    });
    expect(formatNarrationLine(lines[0]!, 0)).toContain("[pointed ×2]");
    expect(formatNarrationLine(lines[1]!, 1)).toBe("- #2 (0:05) clicked");
  });

  it("says what a keyframe without words or actions shows", () => {
    const lines = buildNarration({
      words: [],
      events: [],
      marks: [],
      durationMs: 3_000,
      sceneChanges: [2_000],
    });
    expect(formatNarrationLine(lines[0]!, 0)).toBe("- #1 (0:02) screen changed");
  });

  it("still has a keyframe when nothing was said or done", () => {
    const lines = buildNarration({ words: [], events: [], marks: [], durationMs: 4_000 });
    expect(lines.map((line) => formatNarrationLine(line, 0))).toEqual([
      "- #1 (0:02) nothing said or done",
    ]);
  });

  it("keeps the speech when the model could not time its words", () => {
    const lines = buildNarration({
      words: wordsOrWhole([], "Das hier bitte weg. Und das auch.", 8_000),
      events: [{ kind: "click", t: 2_000, x: 0.5, y: 0.5 }],
      marks: [],
      durationMs: 8_000,
    });
    expect(lines.map((line) => line.text)).toEqual(["Das hier bitte weg. Und das auch."]);
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

  const actedSentence = (t: number) => say("Hier klicke ich jetzt.", t, 100);

  it.each([39_999, 40_000, 139_999, 600_000])(
    "lets ordinary clicks fill only the base budget in %i ms",
    (durationMs) => {
      const times = Array.from({ length: 12 }, (_, index) => 500 + index * 3_000);
      const lines = buildNarration({
        words: times.flatMap(actedSentence),
        events: times.map((t) => ({ kind: "click" as const, t: t + 100, x: 0.5, y: 0.5 })),
        marks: [],
        durationMs,
      });
      expect(lines).toHaveLength(6);
    },
  );

  it("spends the budget past the base on long stretches that show something", () => {
    const early = Array.from({ length: 6 }, (_, index) => 500 + index * 2_000);
    const late = [50_000, 90_000, 130_000];
    const lines = buildNarration({
      words: [...early, ...late].flatMap(actedSentence),
      events: [...early, ...late].map((t) => ({
        kind: "click" as const,
        t: t + 100,
        x: 0.5,
        y: 0.5,
      })),
      marks: [],
      durationMs: 140_000,
    });
    expect(lines.map((line) => line.t0)).toEqual(expect.arrayContaining(late));
  });

  it("takes no keyframe for long speech over a screen where nothing happens", () => {
    const words = Array.from({ length: 6 }, (_, index) =>
      say("Ich rede hier einfach weiter ohne etwas zu tun.", index * 20_000, 200),
    ).flat();
    const lines = buildNarration({ words, events: [], marks: [], durationMs: 120_000 });
    expect(lines).toHaveLength(1);
    expect(lines[0]!.text.split(" ")).toHaveLength(words.length);
  });
});
