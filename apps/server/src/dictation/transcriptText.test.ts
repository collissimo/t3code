import { describe, expect, it } from "@effect/vitest";

import { DEFAULT_STRUCTURE_CODEWORDS, removeFillers, splitCodeword } from "./transcriptText.ts";

describe("removeFillers", () => {
  it.each([
    ["Okay. Ähm, mir ist gerade etwas aufgefallen.", "Okay. Mir ist gerade etwas aufgefallen."],
    ["dass es keinen Modus gibt, ähm, der mir hilft", "dass es keinen Modus gibt, der mir hilft"],
    ["und äh das war es", "und das war es"],
    ["und äh, das war es", "und das war es"],
    ["Das ist gut äh, aber teuer", "Das ist gut aber teuer"],
    [
      "mit meiner Stimme äh, aufzunehmen. Die äh, ist besser.",
      "mit meiner Stimme aufzunehmen. Die ist besser.",
    ],
    ["Das passt. Ähm... Du kannst das Repo ziehen.", "Das passt. Du kannst das Repo ziehen."],
    ["Ähm, genau, und es soll passen", "Genau, und es soll passen"],
    ["Das Fenster, äh. Und dann", "Das Fenster. Und dann"],
    ["Das war's äh.", "Das war's."],
    ["Hm, mh, also ich denke mhm ja", "Also ich denke ja"],
    ["um das zu testen, ähm, um zu sehen", "um das zu testen, um zu sehen"],
    ["Das ist ähnlich wie bei Ämtern und Öhmd", "Das ist ähnlich wie bei Ämtern und Öhmd"],
    ["5 mm Abstand und um 9 Uhr", "5 mm Abstand und um 9 Uhr"],
    ["uh, please refactor this, uhm, function", "Please refactor this, function"],
    ["Erste Zeile ähm\nzweite Zeile", "Erste Zeile\nzweite Zeile"],
    ["Ähm.", ""],
    ["Kein Füllwort hier.", "Kein Füllwort hier."],
    ["weil, äh, ich das hm brauche", "weil, ich das brauche"],
  ])("%j", (spoken, expected) => {
    expect(removeFillers(spoken)).toBe(expected);
  });
});

describe("splitCodeword", () => {
  const codewords = ["Reinschrift", "Prompt aufräumen"];

  it.each([
    ["Bau das bitte ein. Reinschrift.", "Bau das bitte ein.", true],
    ["Bau das bitte ein, Reinschrift", "Bau das bitte ein", true],
    ["Bau das bitte ein reinschrift!", "Bau das bitte ein", true],
    ["Bau das bitte ein.\nReinschrift. ", "Bau das bitte ein.", true],
    ["Bau das ein. Prompt  aufräumen.", "Bau das ein.", true],
    ["Reinschrift.", "", true],
    // Only the end counts: the word stays usable inside a sentence.
    ["Die Reinschrift soll in die Datei.", "Die Reinschrift soll in die Datei.", false],
    ["Das heißt jetzt Vorreinschrift", "Das heißt jetzt Vorreinschrift", false],
    ["Kein Codewort hier.", "Kein Codewort hier.", false],
  ] as const)("%j", (spoken, text, found) => {
    expect(splitCodeword(spoken, codewords)).toEqual({ text, found });
  });

  it("does nothing without codewords", () => {
    expect(splitCodeword("Bau das ein. Reinschrift.", [])).toEqual({
      text: "Bau das ein. Reinschrift.",
      found: false,
    });
    expect(splitCodeword("Bau das ein.", [" "])).toEqual({ text: "Bau das ein.", found: false });
  });

  it("accepts how the transcriber misspells the default codeword", () => {
    for (const word of ["Reinschrift", "Reihenschrift"]) {
      expect(splitCodeword(`Bau das ein. ${word}.`, DEFAULT_STRUCTURE_CODEWORDS)).toEqual({
        text: "Bau das ein.",
        found: true,
      });
    }
  });
});
