import { describe, expect, it } from "vite-plus/test";

import { markDictatedText } from "./dictationMarker.ts";

describe("markDictatedText", () => {
  it("marks the first dictation of a draft", () => {
    expect(markDictatedText("", "hello")).toBe("[STT] hello");
    expect(markDictatedText("/review ", "hello")).toBe("[STT] hello");
  });

  it("leaves later dictations in a marked draft alone", () => {
    expect(markDictatedText("[STT] hello ", "again")).toBe("again");
  });
});
