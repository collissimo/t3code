// What a capture logs besides clicks and ink: the cursor, the wheel, shortcuts, app switches, the
// windows on screen and flags. All of it is plain data, so it can be tested without a desktop.

import type {
  ScrawlInputEvent,
  ScrawlStopResult,
  ScrawlStroke,
  ScrawlWindowSnapshot,
} from "@t3tools/contracts";

import { elementOn, namesWindowTitle, type ElementHit } from "./elementLookup.ts";
import type { CursorPoint, DisplayArea } from "./inputTracker.ts";

// Scrawl's log: about 15 samples a second at most, and only when the hand really moved.
const CURSOR_TICK_MS = 66;
const CURSOR_MIN_MOVE = 2;

const round4 = (value: number) => Math.round(value * 10_000) / 10_000;

export class ScrawlContextLog {
  readonly #area: DisplayArea;
  readonly #events: Array<ScrawlInputEvent> = [];
  readonly #cursor: Array<readonly [number, number, number]> = [];
  readonly #windows: Array<ScrawlWindowSnapshot> = [];
  readonly #flags: Array<number> = [];
  #lastWindows = "";
  #cursorAt: { readonly t: number; readonly at: CursorPoint } | null = null;

  constructor(area: DisplayArea) {
    this.#area = area;
  }

  #normalized(at: CursorPoint): { readonly x: number; readonly y: number } | null {
    const { x, y, width, height } = this.#area;
    if (at.x < x || at.y < y || at.x >= x + width || at.y >= y + height) return null;
    return { x: round4((at.x - x) / width), y: round4((at.y - y) / height) };
  }

  cursor(t: number, at: CursorPoint): void {
    const last = this.#cursorAt;
    if (last !== null) {
      if (t - last.t < CURSOR_TICK_MS) return;
      if (Math.hypot(at.x - last.at.x, at.y - last.at.y) < CURSOR_MIN_MOVE) return;
    }
    const point = this.#normalized(at);
    if (point === null) return;
    this.#cursorAt = { t, at };
    this.#cursor.push([t, point.x, point.y]);
  }

  scrolled(t: number, at: CursorPoint, dx: number, dy: number): void {
    const point = this.#normalized(at);
    if (point !== null) this.#events.push({ kind: "scroll", t, ...point, dx, dy });
  }

  pressed(t: number, shortcut: string): void {
    this.#events.push({ kind: "key", t, shortcut });
  }

  switchedTo(t: number, app: string): void {
    this.#events.push({ kind: "app_change", t, app });
  }

  flagged(t: number): void {
    this.#flags.push(t);
  }

  /** Stored only when something differs: most looks find the same windows in the same order. */
  windows(snapshot: ScrawlWindowSnapshot): void {
    const key = JSON.stringify(snapshot.windows);
    if (key === this.#lastWindows) return;
    this.#lastWindows = key;
    this.#windows.push(snapshot);
  }

  result() {
    return {
      events: this.#events,
      cursor: this.#cursor,
      windows: this.#windows,
      flags: this.#flags,
    };
  }
}

export const pointerLookupKey = (t: number) => `pointer:${t}`;
export const strokeLookupKey = (t0: number) => `stroke:${t0}`;

/** Where to ask what a stroke marks: its middle, or just above a flat one, which underlines it. */
export function strokeLookupPoint(stroke: ScrawlStroke, area: DisplayArea): CursorPoint {
  const xs = stroke.points.filter((_, index) => index % 2 === 0);
  const ys = stroke.points.filter((_, index) => index % 2 === 1);
  const x0 = Math.min(...xs);
  const x1 = Math.max(...xs);
  const y0 = Math.min(...ys);
  const width = (x1 - x0) * area.width;
  const height = (Math.max(...ys) - y0) * area.height;
  const top = area.y + y0 * area.height;
  return {
    x: area.x + ((x0 + x1) / 2) * area.width,
    y: height < 24 && width > 3 * height ? top - 8 : top + height / 2,
  };
}

/** One capture's whole input, in time order, with what each press and stroke landed on. */
export function mergeCaptureInput(
  tracked: {
    readonly events: ReadonlyArray<ScrawlInputEvent>;
    readonly strokes: ReadonlyArray<ScrawlStroke>;
  },
  log: ReturnType<ScrawlContextLog["result"]>,
  hits: ReadonlyMap<string, ElementHit>,
  knownTitles: ReadonlyArray<string>,
): ScrawlStopResult {
  const titles = [
    ...knownTitles,
    ...log.windows.flatMap((snapshot) => snapshot.windows.map((window) => window.title ?? "")),
  ].filter((title) => title !== "");
  const allowed = (hit: ElementHit | undefined): ElementHit | undefined => {
    if (hit?.label === undefined || !namesWindowTitle(hit.label, titles)) return hit;
    return { role: hit.role };
  };
  const events = [...tracked.events, ...log.events]
    .map((event): ScrawlInputEvent => {
      if (event.kind !== "click" && event.kind !== "drag") return event;
      const hit = allowed(hits.get(pointerLookupKey(event.t)));
      if (hit === undefined) return event;
      if (event.kind === "drag") {
        const on = elementOn(hit);
        return on === undefined ? event : { ...event, label: on };
      }
      return { ...event, role: hit.role, ...(hit.label === undefined ? {} : { label: hit.label }) };
    })
    .toSorted((a, b) => a.t - b.t);
  const strokes = tracked.strokes.map((stroke) => {
    const on = elementOn(allowed(hits.get(strokeLookupKey(stroke.t0))));
    return on === undefined ? stroke : { ...stroke, on };
  });
  return {
    events,
    strokes,
    cursor: [...log.cursor],
    windows: [...log.windows],
    flags: [...log.flags],
  };
}
