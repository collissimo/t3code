import { describe, expect, it } from "vite-plus/test";

import { summaryText } from "./scrawlBundle.ts";

describe("summaryText", () => {
  it("names the app and its window, as the Scrawl app does", () => {
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
          windowTitle: "A window title",
          bundlePath: "C:/captures/scrawl-a.scrawl",
        },
      },
      [],
      null,
    );
    expect(text).toContain("[scrawl 0:25 · Helium “A window title” · C:/captures/scrawl-a.scrawl]");
  });
});
