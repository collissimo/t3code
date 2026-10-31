// Scrawl's rules for which windows the log keeps and how an app switch is told from the shell
// passing through.

import type { ScrawlWindowEntry } from "@t3tools/contracts";

export interface PixelRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface RawWindow {
  readonly id: number;
  readonly processId: number;
  readonly app: string;
  readonly bundleId: string;
  readonly title: string;
  readonly className: string;
  readonly rect: PixelRect;
  readonly exStyle: number;
  readonly owned: boolean;
  readonly minimized: boolean;
  readonly cloaked: boolean;
}

const WS_EX_TOPMOST = 0x8;
const WS_EX_TRANSPARENT = 0x20;
const WS_EX_TOOLWINDOW = 0x80;
const WS_EX_APPWINDOW = 0x40000;
const WS_EX_NOACTIVATE = 0x8000000;

const SHELL_CLASSES = new Set(["Progman", "WorkerW", "Shell_TrayWnd", "Shell_SecondaryTrayWnd"]);
const TASKBAR_CLASSES = new Set(["Shell_TrayWnd", "Shell_SecondaryTrayWnd"]);

const isAppWindow = (window: RawWindow) => {
  const tool = (window.exStyle & WS_EX_TOOLWINDOW) !== 0;
  const app = (window.exStyle & WS_EX_APPWINDOW) !== 0;
  const passThrough = (window.exStyle & (WS_EX_TRANSPARENT | WS_EX_NOACTIVATE)) !== 0;
  return (app || (!tool && !window.owned)) && !passThrough && !SHELL_CLASSES.has(window.className);
};

const overlaps = (a: PixelRect, b: PixelRect) =>
  a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;

/** The strip the taskbar reserves on a display: the part of it outside the work area. */
export function taskbarStrip(display: PixelRect, workArea: PixelRect): PixelRect | null {
  const left = workArea.x - display.x;
  const top = workArea.y - display.y;
  const right = display.x + display.width - (workArea.x + workArea.width);
  const bottom = display.y + display.height - (workArea.y + workArea.height);
  const MIN = 8;
  if (bottom >= MIN) return { ...display, y: workArea.y + workArea.height, height: bottom };
  if (top >= MIN) return { ...display, height: top };
  if (left >= MIN) return { ...display, width: left };
  if (right >= MIN) return { ...display, x: workArea.x + workArea.width, width: right };
  return null;
}

/** `windows` runs front to back. Bounds come out relative to the captured display. */
export function filterWindows(
  windows: ReadonlyArray<RawWindow>,
  frame: PixelRect,
  dock: PixelRect | null,
  frontProcessId: number | null,
  ignoredIds: ReadonlySet<number>,
): Array<ScrawlWindowEntry> {
  const regularProcesses = new Set(windows.filter(isAppWindow).map((w) => w.processId));
  const entries: Array<ScrawlWindowEntry> = [];
  let frontMarked = false;
  for (const window of windows) {
    if (ignoredIds.has(window.id) || window.minimized || window.cloaked) continue;
    const taskbar = TASKBAR_CLASSES.has(window.className);
    if (taskbar ? dock === null : SHELL_CLASSES.has(window.className)) continue;
    const rect = taskbar ? dock! : window.rect;
    if (rect.width < 24 || rect.height < 16 || !overlaps(rect, frame)) continue;
    const layer = taskbar
      ? 20
      : isAppWindow(window) && (window.exStyle & WS_EX_TOPMOST) === 0
        ? 0
        : 3;
    const regular = regularProcesses.has(window.processId);
    if (layer === 3 && !regular) continue;
    const frontmost: boolean = !frontMarked && layer === 0 && window.processId === frontProcessId;
    frontMarked ||= frontmost;
    entries.push({
      id: window.id,
      app: taskbar ? "Dock" : window.app,
      ...(window.bundleId === "" ? {} : { bundleId: window.bundleId }),
      ...(regular || taskbar ? {} : { regular: false }),
      ...(window.title === "" ? {} : { title: window.title }),
      bounds: [
        Math.round(rect.x - frame.x),
        Math.round(rect.y - frame.y),
        Math.round(rect.width),
        Math.round(rect.height),
      ],
      layer,
      ...(frontmost ? { frontmost: true } : {}),
    });
  }
  return entries;
}

// Alt+Tab and the taskbar hold the foreground for a moment; the app that follows is the switch.
const PASSING_CLASSES = new Set([
  "ForegroundStaging",
  "LauncherTipWnd",
  "MultitaskingViewFrame",
  "Shell_SecondaryTrayWnd",
  "Shell_TrayWnd",
  "TaskSwitcherWnd",
  "XamlExplorerHostIslandWindow",
]);
const SETTLE_MS = 200;

/** Reports an app once it has stayed in front, so passing through the shell says nothing. */
export class AppSwitchWatcher {
  #current: string | null = null;
  #pending: { readonly app: string; readonly t: number } | null = null;

  /** Returns the app and when it came to the front, once that is settled. */
  look(
    t: number,
    front: { readonly app: string; readonly className: string } | null,
  ): { readonly app: string; readonly t: number } | null {
    if (front === null || front.app === "" || PASSING_CLASSES.has(front.className)) return null;
    if (this.#current === null) {
      this.#current = front.app;
      return null;
    }
    if (front.app === this.#current) {
      this.#pending = null;
      return null;
    }
    if (this.#pending?.app !== front.app) this.#pending = { app: front.app, t };
    if (t - this.#pending.t < SETTLE_MS) return null;
    const settled = this.#pending;
    this.#current = settled.app;
    this.#pending = null;
    return settled;
  }
}
