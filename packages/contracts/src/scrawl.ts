import * as Schema from "effect/Schema";

// Scrawl: a screen capture with voice, clicks and red ink, packed into a bundle for agents. The
// desktop app watches the mouse and draws the ink; the renderer records and builds the bundle.

export const ScrawlCaptureId = Schema.String.check(Schema.isPattern(/^scrawl-[a-z0-9-]{1,64}$/));
export type ScrawlCaptureId = typeof ScrawlCaptureId.Type;

export const ScrawlStartResult = Schema.Struct({
  id: ScrawlCaptureId,
  /** For getUserMedia's chromeMediaSourceId. */
  sourceId: Schema.String,
  width: Schema.Number,
  height: Schema.Number,
  /** Wall clock of the moment event times count from. */
  startedAtMs: Schema.Number,
  app: Schema.String,
  windowTitle: Schema.String,
  bundlePath: Schema.String,
});
export type ScrawlStartResult = typeof ScrawlStartResult.Type;

/** Positions are fractions of the captured display, from its top left. */
export const ScrawlInputEvent = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("click"),
    t: Schema.Number,
    x: Schema.Number,
    y: Schema.Number,
    /** What UI Automation calls the element under the press, such as `button`. */
    role: Schema.optionalKey(Schema.String),
    /** Its name and id, such as `“Area” #area`. Never a value, password or window title. */
    label: Schema.optionalKey(Schema.String),
  }),
  Schema.Struct({
    kind: Schema.Literal("drag"),
    t: Schema.Number,
    t1: Schema.Number,
    x0: Schema.Number,
    y0: Schema.Number,
    x1: Schema.Number,
    y1: Schema.Number,
    label: Schema.optionalKey(Schema.String),
  }),
  /** Wheel notches, positive away from the user and to the right, as Windows counts them. */
  Schema.Struct({
    kind: Schema.Literal("scroll"),
    t: Schema.Number,
    x: Schema.Number,
    y: Schema.Number,
    dx: Schema.Number,
    dy: Schema.Number,
  }),
  /** Only chords with Ctrl or Win: typing never gets here. */
  Schema.Struct({
    kind: Schema.Literal("key"),
    t: Schema.Number,
    shortcut: Schema.String,
  }),
  Schema.Struct({
    kind: Schema.Literal("app_change"),
    t: Schema.Number,
    app: Schema.String,
  }),
]);
export type ScrawlInputEvent = typeof ScrawlInputEvent.Type;

export const ScrawlStroke = Schema.Struct({
  t0: Schema.Number,
  t1: Schema.Number,
  /** x, y, x, y, ... */
  points: Schema.Array(Schema.Number),
  /** What it was drawn on, such as `button “Area”`. */
  on: Schema.optionalKey(Schema.String),
});
export type ScrawlStroke = typeof ScrawlStroke.Type;

/** One on-screen window. Its title stays in scrawl.json and never reaches agent text. */
export const ScrawlWindowEntry = Schema.Struct({
  id: Schema.Number,
  app: Schema.String,
  bundleId: Schema.optionalKey(Schema.String),
  /** Only ever false: a tool or overlay that is rarely what a capture is about. */
  regular: Schema.optionalKey(Schema.Boolean),
  title: Schema.optionalKey(Schema.String),
  /** x, y, width, height in pixels from the captured display's top left. */
  bounds: Schema.Tuple([Schema.Number, Schema.Number, Schema.Number, Schema.Number]),
  /** 0 for ordinary windows, 3 for tool and always-on-top ones, 20 for the taskbar. */
  layer: Schema.Number,
  frontmost: Schema.optionalKey(Schema.Boolean),
});
export type ScrawlWindowEntry = typeof ScrawlWindowEntry.Type;

export const ScrawlWindowSnapshot = Schema.Struct({
  t: Schema.Number,
  windows: Schema.Array(ScrawlWindowEntry),
});
export type ScrawlWindowSnapshot = typeof ScrawlWindowSnapshot.Type;

export const ScrawlStopResult = Schema.Struct({
  events: Schema.Array(ScrawlInputEvent),
  strokes: Schema.Array(ScrawlStroke),
  /** t, x, y with positions as fractions of the display, thinned to real movement. */
  cursor: Schema.Array(Schema.Tuple([Schema.Number, Schema.Number, Schema.Number])),
  windows: Schema.Array(ScrawlWindowSnapshot),
  /** Moments the user flagged on purpose. */
  flags: Schema.Array(Schema.Number),
});
export type ScrawlStopResult = typeof ScrawlStopResult.Type;

export const ScrawlCaptureRef = Schema.Struct({ id: ScrawlCaptureId });
export type ScrawlCaptureRef = typeof ScrawlCaptureRef.Type;

export const ScrawlAppendVideoInput = Schema.Struct({
  id: ScrawlCaptureId,
  name: Schema.String,
  bytes: Schema.Uint8Array,
});
export type ScrawlAppendVideoInput = typeof ScrawlAppendVideoInput.Type;

export const ScrawlWriteFileInput = Schema.Struct({
  id: ScrawlCaptureId,
  /** Relative to the bundle, such as frames/frame-01.png. */
  path: Schema.String.check(Schema.isPattern(/^[\w-]+(?:\/[\w.-]+|\.[\w.-]+)$/)),
  bytes: Schema.Uint8Array,
});
export type ScrawlWriteFileInput = typeof ScrawlWriteFileInput.Type;

/** How long ink stays after Shift is let go. Its fading is not the screen answering a click. */
export const SCRAWL_INK_HOLD_MS = 5_000;

/** The menu action the global shortcut sends to the renderer. */
export const SCRAWL_TOGGLE_ACTION = "scrawl-toggle";
