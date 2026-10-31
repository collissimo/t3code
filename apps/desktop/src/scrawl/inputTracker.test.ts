import { describe, expect, it } from "vite-plus/test";

import { ScrawlInputTracker } from "./inputTracker.ts";

const secondDisplay = { x: 1920, y: 0, width: 1000, height: 500 };

describe("ScrawlInputTracker", () => {
  it("tells clicks from drags, on the captured display only", () => {
    const tracker = new ScrawlInputTracker(secondDisplay);
    tracker.leftDown(100, { x: 2420, y: 250 });
    tracker.leftUp(150, { x: 2422, y: 251 });
    tracker.leftDown(200, { x: 2020, y: 100 });
    tracker.leftUp(600, { x: 2420, y: 100 });
    tracker.leftDown(700, { x: 100, y: 100 });
    tracker.leftUp(750, { x: 100, y: 100 });
    expect(tracker.result().events).toEqual([
      { kind: "click", t: 100, x: 0.5, y: 0.5 },
      { kind: "drag", t: 200, t1: 600, x0: 0.1, y0: 0.2, x1: 0.5, y1: 0.2 },
    ]);
  });

  it("keeps a stroke drawn with Shift, and no stroke for a typed capital", () => {
    const tracker = new ScrawlInputTracker(secondDisplay);
    tracker.shiftDown(0, { x: 2000, y: 100 });
    expect(tracker.shiftUp()).toBe(false);
    tracker.shiftDown(100, { x: 2000, y: 100 });
    expect(tracker.moved(110, { x: 2000, y: 100 })).toBeNull();
    tracker.moved(120, { x: 2100, y: 100 });
    expect(tracker.shiftUp()).toBe(true);
    expect(tracker.result().strokes).toEqual([
      { t0: 100, t1: 120, points: [0.08, 0.2, 0.18, 0.2] },
    ]);
  });
});
