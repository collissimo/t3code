// Turns button and Shift changes plus cursor positions into clicks, drags and strokes.

import type { ScrawlInputEvent, ScrawlStroke } from "@t3tools/contracts";

export interface DisplayArea {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface CursorPoint {
  readonly x: number;
  readonly y: number;
}

// In screen points: a hand that moves this little while pressing meant a click.
const CLICK_SLOP = 4;
const MIN_STROKE_LENGTH = 6;

const round4 = (value: number) => Math.round(value * 10_000) / 10_000;

export class ScrawlInputTracker {
  readonly #area: DisplayArea;
  readonly #events: Array<ScrawlInputEvent> = [];
  readonly #strokes: Array<ScrawlStroke> = [];
  #press: { readonly t: number; readonly at: CursorPoint } | null = null;
  #stroke: { readonly t0: number; readonly raw: Array<CursorPoint>; t1: number } | null = null;

  constructor(area: DisplayArea) {
    this.#area = area;
  }

  #inside(point: CursorPoint): boolean {
    const { x, y, width, height } = this.#area;
    return point.x >= x && point.y >= y && point.x < x + width && point.y < y + height;
  }

  #normalized(point: CursorPoint): { readonly x: number; readonly y: number } {
    return {
      x: round4((point.x - this.#area.x) / this.#area.width),
      y: round4((point.y - this.#area.y) / this.#area.height),
    };
  }

  leftDown(t: number, at: CursorPoint): void {
    this.#press = this.#inside(at) ? { t, at } : null;
  }

  leftUp(t: number, at: CursorPoint): void {
    const press = this.#press;
    this.#press = null;
    if (press === null) return;
    const start = this.#normalized(press.at);
    if (Math.hypot(at.x - press.at.x, at.y - press.at.y) <= CLICK_SLOP) {
      this.#events.push({ kind: "click", t: press.t, x: start.x, y: start.y });
      return;
    }
    const end = this.#normalized(at);
    this.#events.push({
      kind: "drag",
      t: press.t,
      t1: t,
      x0: start.x,
      y0: start.y,
      x1: end.x,
      y1: end.y,
    });
  }

  shiftDown(t: number, at: CursorPoint): void {
    this.#stroke = { t0: t, t1: t, raw: [at] };
  }

  /** Returns the new position when it extends the stroke being drawn. */
  moved(t: number, at: CursorPoint): CursorPoint | null {
    const stroke = this.#stroke;
    if (stroke === null) return null;
    const last = stroke.raw.at(-1)!;
    if (last.x === at.x && last.y === at.y) return null;
    stroke.raw.push(at);
    stroke.t1 = t;
    return at;
  }

  /** Ends the stroke. A Shift press without movement (typing a capital) leaves nothing behind. */
  shiftUp(): boolean {
    const stroke = this.#stroke;
    this.#stroke = null;
    if (stroke === null) return false;
    let length = 0;
    for (let index = 1; index < stroke.raw.length; index++) {
      const previous = stroke.raw[index - 1]!;
      const point = stroke.raw[index]!;
      length += Math.hypot(point.x - previous.x, point.y - previous.y);
    }
    if (length < MIN_STROKE_LENGTH) return false;
    const inside = stroke.raw.filter((point) => this.#inside(point));
    if (inside.length < 2) return false;
    this.#strokes.push({
      t0: stroke.t0,
      t1: stroke.t1,
      points: inside.flatMap((point) => {
        const { x, y } = this.#normalized(point);
        return [x, y];
      }),
    });
    return true;
  }

  result(): {
    readonly events: ReadonlyArray<ScrawlInputEvent>;
    readonly strokes: ReadonlyArray<ScrawlStroke>;
  } {
    return { events: this.#events, strokes: this.#strokes };
  }
}
