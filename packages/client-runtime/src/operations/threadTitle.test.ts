import { describe, expect, it } from "vite-plus/test";

import { deriveThreadTitleSeed } from "./threadTitle.ts";

describe("deriveThreadTitleSeed", () => {
  it("leaves the dictation marker out of the title", () => {
    expect(deriveThreadTitleSeed({ text: "[STT] Fix the login", attachments: [] })).toBe(
      "Fix the login",
    );
  });
});
