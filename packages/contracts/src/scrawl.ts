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
  }),
  Schema.Struct({
    kind: Schema.Literal("drag"),
    t: Schema.Number,
    t1: Schema.Number,
    x0: Schema.Number,
    y0: Schema.Number,
    x1: Schema.Number,
    y1: Schema.Number,
  }),
]);
export type ScrawlInputEvent = typeof ScrawlInputEvent.Type;

export const ScrawlStroke = Schema.Struct({
  t0: Schema.Number,
  t1: Schema.Number,
  /** x, y, x, y, ... */
  points: Schema.Array(Schema.Number),
});
export type ScrawlStroke = typeof ScrawlStroke.Type;

export const ScrawlStopResult = Schema.Struct({
  events: Schema.Array(ScrawlInputEvent),
  strokes: Schema.Array(ScrawlStroke),
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
