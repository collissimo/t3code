import { describe, expect, it } from "vite-plus/test";

import {
  mergeCaptureInput,
  pointerLookupKey,
  ScrawlContextLog,
  strokeLookupKey,
  strokeLookupPoint,
} from "./contextLog.ts";

const AREA = { x: 1000, y: 0, width: 1000, height: 1000 };

describe("ScrawlContextLog", () => {
  it("thins the cursor to real movement inside the display", () => {
    const log = new ScrawlContextLog(AREA);
    log.cursor(0, { x: 1500, y: 500 });
    log.cursor(10, { x: 1600, y: 500 });
    log.cursor(100, { x: 1501, y: 500 });
    log.cursor(200, { x: 1600, y: 500 });
    log.cursor(300, { x: 10, y: 10 });
    expect(log.result().cursor).toEqual([
      [0, 0.5, 0.5],
      [200, 0.6, 0.5],
    ]);
  });

  it("drops a scroll off this display and stores a window list only when it changed", () => {
    const log = new ScrawlContextLog(AREA);
    log.scrolled(1, { x: 10, y: 10 }, 0, 1);
    log.scrolled(2, { x: 1500, y: 250 }, 0, -1);
    const windows = [{ id: 1, app: "A", bounds: [0, 0, 9, 9], layer: 0 }] as const;
    log.windows({ t: 1, windows });
    log.windows({ t: 2, windows });
    log.windows({ t: 3, windows: [] });
    const result = log.result();
    expect(result.events).toEqual([{ kind: "scroll", t: 2, x: 0.5, y: 0.25, dx: 0, dy: -1 }]);
    expect(result.windows.map((snapshot) => snapshot.t)).toEqual([1, 3]);
  });
});

describe("mergeCaptureInput", () => {
  const log = () => new ScrawlContextLog(AREA);

  it("names presses and strokes, in time order, and never by a window's title", () => {
    const context = log();
    context.pressed(50, "Ctrl+C");
    context.windows({
      t: 0,
      windows: [
        {
          id: 1,
          app: "Mail",
          title: "Inbox of a private person - Mail",
          bounds: [0, 0, 9, 9],
          layer: 0,
        },
      ],
    });
    const merged = mergeCaptureInput(
      {
        events: [
          { kind: "click", t: 100, x: 0.5, y: 0.5 },
          { kind: "click", t: 10, x: 0.5, y: 0.5 },
          { kind: "drag", t: 200, t1: 300, x0: 0, y0: 0, x1: 1, y1: 1 },
        ],
        strokes: [{ t0: 400, t1: 500, points: [0, 0, 1, 1] }],
      },
      context.result(),
      new Map([
        [pointerLookupKey(100), { role: "button", label: "“Area”" }],
        [pointerLookupKey(10), { role: "tab item", label: "“Inbox of a private person”" }],
        [pointerLookupKey(200), { role: "slider", label: "“Volume”" }],
        [strokeLookupKey(400), { role: "button", label: "“Save” #save" }],
      ]),
      ["Quiet title"],
    );
    expect(merged.events).toMatchObject([
      { kind: "click", t: 10, role: "tab item" },
      { kind: "key", t: 50 },
      { kind: "click", t: 100, role: "button", label: "“Area”" },
      { kind: "drag", t: 200, label: "slider “Volume”" },
    ]);
    expect(merged.events[0]).not.toHaveProperty("label");
    expect(merged.strokes[0]!.on).toBe("button “Save” #save");
  });
});

describe("strokeLookupPoint", () => {
  it("asks about the middle of a stroke, and above a flat one, which underlines the thing", () => {
    expect(strokeLookupPoint({ t0: 0, t1: 1, points: [0.1, 0.1, 0.3, 0.3] }, AREA)).toEqual({
      x: 1200,
      y: 200,
    });
    expect(strokeLookupPoint({ t0: 0, t1: 1, points: [0.1, 0.5, 0.3, 0.505] }, AREA)).toEqual({
      x: 1200,
      y: 492,
    });
  });
});
