import { describe, expect, it } from "vite-plus/test";

import { AppSwitchWatcher, filterWindows, taskbarStrip, type RawWindow } from "./windowList.ts";

const FRAME = { x: 1920, y: 0, width: 2560, height: 1440 };
const raw = (over: Partial<RawWindow> & { readonly id: number }): RawWindow => ({
  processId: 7,
  app: "Helium",
  bundleId: "chrome.exe",
  title: "Some page",
  className: "Chrome_WidgetWin_1",
  rect: { x: 2000, y: 100, width: 800, height: 600 },
  exStyle: 0,
  owned: false,
  minimized: false,
  cloaked: false,
  ...over,
});

describe("filterWindows", () => {
  it("keeps what Scrawl's log keeps, relative to the display, and marks the front window", () => {
    const entries = filterWindows(
      [
        raw({ id: 1, processId: 9, app: "Other", bundleId: "other.exe" }),
        raw({ id: 2 }),
        raw({ id: 3 }),
        raw({ id: 4, rect: { x: 0, y: 0, width: 800, height: 600 } }),
        raw({ id: 5, minimized: true }),
        raw({ id: 6, cloaked: true }),
        raw({ id: 7, rect: { x: 2000, y: 100, width: 20, height: 600 } }),
        raw({ id: 8, className: "Progman" }),
        raw({ id: 9 }),
        raw({ id: 10, processId: 11, app: "Tool", exStyle: 0x80 }),
        raw({ id: 11, exStyle: 0x8 }),
      ],
      FRAME,
      null,
      7,
      new Set([9]),
    );
    expect(entries.map((entry) => [entry.id, entry.layer, entry.frontmost ?? false])).toEqual([
      [1, 0, false],
      [2, 0, true],
      [3, 0, false],
      [11, 3, false],
    ]);
    expect(entries[1]).toMatchObject({ bounds: [80, 100, 800, 600], title: "Some page" });
  });

  it("gives the taskbar the strip it reserves on this display, or drops it", () => {
    const taskbar = raw({
      id: 1,
      app: "Windows Explorer",
      className: "Shell_TrayWnd",
      rect: { ...FRAME },
      exStyle: 0x80,
    });
    const dock = taskbarStrip(FRAME, { x: 1920, y: 0, width: 2560, height: 1400 });
    expect(dock).toEqual({ x: 1920, y: 1400, width: 2560, height: 40 });
    expect(filterWindows([taskbar], FRAME, dock, null, new Set())).toMatchObject([
      { app: "Dock", layer: 20, bounds: [0, 1400, 2560, 40] },
    ]);
    expect(filterWindows([taskbar], FRAME, null, null, new Set())).toEqual([]);
  });
});

describe("AppSwitchWatcher", () => {
  const front = (app: string, className = "Window") => ({ app, className });

  it("reports an app that stayed, when it came, and says nothing of the shell in between", () => {
    const watcher = new AppSwitchWatcher();
    expect(watcher.look(0, front("Helium"))).toBeNull();
    expect(watcher.look(100, front("Explorer", "XamlExplorerHostIslandWindow"))).toBeNull();
    expect(watcher.look(150, null)).toBeNull();
    expect(watcher.look(200, front("Code"))).toBeNull();
    expect(watcher.look(450, front("Code"))).toEqual({ app: "Code", t: 200 });
    expect(watcher.look(500, front("Code"))).toBeNull();
  });

  it("ignores an app that was in front only for a moment", () => {
    const watcher = new AppSwitchWatcher();
    watcher.look(0, front("Helium"));
    expect(watcher.look(100, front("Code"))).toBeNull();
    expect(watcher.look(150, front("Helium"))).toBeNull();
    expect(watcher.look(1_000, front("Helium"))).toBeNull();
  });
});
