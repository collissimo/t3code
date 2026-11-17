import { describe, expect, it } from "@effect/vitest";

import { DEFAULT_STRUCTURE_CODEWORDS, splitCodeword } from "./transcriptText.ts";

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
