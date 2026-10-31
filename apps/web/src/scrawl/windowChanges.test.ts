import { describe, expect, it } from "vite-plus/test";

import { windowChanges } from "./windowChanges.ts";

const window = (id: number, app: string, over: { layer?: number; regular?: boolean } = {}) => ({
  id,
  app,
  title: "A private title",
  bounds: [0, 0, 100, 100] as const,
  layer: 0,
  ...over,
});

describe("windowChanges", () => {
  it("names apps, never titles, and only ordinary windows", () => {
    const changes = windowChanges([
      { t: 0, windows: [window(1, "Helium"), window(2, "Code"), window(9, "Tool", { layer: 3 })] },
      {
        t: 500,
        windows: [
          window(1, "Helium"),
          window(3, "Notepad"),
          window(8, "Popup", { regular: false }),
        ],
      },
    ]);
    expect(changes).toEqual([
      { kind: "window", t: 500, text: "Code window closed" },
      { kind: "window", t: 500, text: "Notepad window opened" },
    ]);
  });

  it("makes one line of a virtual desktop switch", () => {
    const changes = windowChanges([
      { t: 0, windows: [1, 2, 3].map((id) => window(id, "A")) },
      { t: 500, windows: [4, 5, 6].map((id) => window(id, "B")) },
    ]);
    expect(changes).toEqual([
      { kind: "window", t: 500, text: "on-screen windows changed (3 opened, 3 closed)" },
    ]);
  });
});
