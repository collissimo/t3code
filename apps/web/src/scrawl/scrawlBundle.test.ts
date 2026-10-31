import { describe, expect, it } from "vite-plus/test";

import { summaryText } from "./scrawlBundle.ts";

describe("summaryText", () => {
  it("names the app and keeps the window title out of what an agent reads", () => {
    const text = summaryText(
      {
        durationMs: 25_000,
        session: {
          id: "scrawl-a",
          sourceId: "screen:1",
          width: 100,
          height: 100,
          startedAtMs: 0,
          app: "Helium",
          windowTitle: "A private title",
          bundlePath: "C:/captures/scrawl-a.scrawl",
        },
      },
      [],
      false,
    );
    expect(text).toContain("[scrawl 0:25 · Helium · C:/captures/scrawl-a.scrawl]");
    expect(text).not.toContain("A private title");
  });
});
