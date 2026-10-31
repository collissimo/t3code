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
  /** The command agents look closer with. Only an installed app writes one. */
  lookCloserCommand: Schema.optional(Schema.String),
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

export const ScrawlReadFileInput = Schema.Struct({
  id: ScrawlCaptureId,
  path: ScrawlWriteFileInput.fields.path,
  offset: Schema.Number,
  length: Schema.Number,
});
export type ScrawlReadFileInput = typeof ScrawlReadFileInput.Type;

export const ScrawlSetPinnedInput = Schema.Struct({
  id: ScrawlCaptureId,
  pinned: Schema.Boolean,
});
export type ScrawlSetPinnedInput = typeof ScrawlSetPinnedInput.Type;

/** A capture whose bundle was never built, and what its build still needs. */
export const ScrawlUnfinished = Schema.Struct({
  session: ScrawlStartResult,
  input: ScrawlStopResult,
});
export type ScrawlUnfinished = typeof ScrawlUnfinished.Type;

/** `failed` was tried once and is only rebuilt when asked, so a crash cannot repeat each launch. */
export const ScrawlCaptureStatus = Schema.Literals(["built", "recording", "unfinished", "failed"]);
export type ScrawlCaptureStatus = typeof ScrawlCaptureStatus.Type;

export const ScrawlCaptureSummary = Schema.Struct({
  id: ScrawlCaptureId,
  bundlePath: Schema.String,
  status: ScrawlCaptureStatus,
  createdAtMs: Schema.Number,
  durationMs: Schema.Number,
  app: Schema.String,
  windowTitle: Schema.String,
  sizeBytes: Schema.Number,
  mediaBytes: Schema.Number,
  pinned: Schema.Boolean,
  /** When retention removes the video and audio; null when it never will or they are gone. */
  mediaRemovedAtMs: Schema.NullOr(Schema.Number),
  /** When retention moves the whole capture to the bin; null when it never will. */
  bundleRemovedAtMs: Schema.NullOr(Schema.Number),
});
export type ScrawlCaptureSummary = typeof ScrawlCaptureSummary.Type;

export const ScrawlShortcutState = Schema.Struct({
  accelerator: Schema.String,
  /** False while another program holds the keys; T3 Code keeps trying to take them. */
  registered: Schema.Boolean,
});
export type ScrawlShortcutState = typeof ScrawlShortcutState.Type;

export const ScrawlShortcutAvailability = Schema.Struct({
  available: Schema.Boolean,
  message: Schema.NullOr(Schema.String),
});
export type ScrawlShortcutAvailability = typeof ScrawlShortcutAvailability.Type;

/** How long ink stays after Shift is let go. Its fading is not the screen answering a click. */
export const SCRAWL_INK_HOLD_MS = 5_000;

/** The menu action the global shortcut sends to the renderer. */
export const SCRAWL_TOGGLE_ACTION = "scrawl-toggle";

/** Tells the renderer the shortcut was taken or lost, so Settings never shows a stale answer. */
export const SCRAWL_SHORTCUT_STATE_ACTION = "scrawl-shortcut-state";
