// @effect-diagnostics globalTimers:off -- The cursor poll and pill clock run at native callback boundaries outside Effect fibers.
// @effect-diagnostics globalTimersInEffect:off -- They are started here and owned by the capture, not a fiber.
// @effect-diagnostics globalDate:off -- Input times share the wall clock with the renderer's recorder.
// @effect-diagnostics globalDateInEffect:off -- Same clock as above.
// @effect-diagnostics nodeBuiltinImport:off -- Bundles are plain files written outside any Effect service.
// The desktop half of a Scrawl capture: the global shortcut, the mouse and Shift watcher, the ink
// and the recording pill, and the bundles on disk. The renderer records and builds the bundle.

import {
  DEFAULT_SCRAWL_SHORTCUT,
  SCRAWL_INK_HOLD_MS,
  SCRAWL_SHORTCUT_STATE_ACTION,
  SCRAWL_TOGGLE_ACTION,
  type ClientSettings,
  type ScrawlAppendVideoInput,
  type ScrawlCaptureRef,
  type ScrawlCaptureSummary,
  type ScrawlReadFileInput,
  type ScrawlRetention,
  type ScrawlSetPinnedInput,
  type ScrawlShortcutAvailability,
  type ScrawlShortcutState,
  type ScrawlStartResult,
  type ScrawlStopResult,
  type ScrawlUnfinished,
  type ScrawlWriteFileInput,
  type SnapShotKeyChord,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Electron from "electron";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import { loadWindowsForegroundApi } from "../electron/WindowsForeground.ts";
import * as DesktopClientSettings from "../settings/DesktopClientSettings.ts";
import { activeWindow } from "../snapShot/ActiveWindow.ts";
import { snapShotShortcutSystemConflict, toElectronAccelerator } from "../snapShot/snapShot.ts";
import * as DesktopWindow from "../window/DesktopWindow.ts";
import {
  PINNED_FILE,
  REBUILT_ONCE_FILE,
  planRebuilds,
  planRetention,
  readCaptureFolder,
  readCaptureFolders,
  removeJournal,
  summarize,
  unfinishedOf,
  writeJournal,
} from "./captureStore.ts";
import {
  mergeCaptureInput,
  pointerLookupKey,
  ScrawlContextLog,
  strokeLookupKey,
  strokeLookupPoint,
} from "./contextLog.ts";
import { startElementLookups, type ElementHit, type ElementLookups } from "./elementLookup.ts";
import { ScrawlInputTracker, type CursorPoint } from "./inputTracker.ts";
import { startScrawlContextProcess, type ScrawlContextProcess } from "./scrawlContextProcess.ts";
import { loadWindowAtPoint } from "./windowAtPoint.ts";
import { taskbarStrip } from "./windowList.ts";
import { renderScrawlShim, scrawlShimName } from "./scrawlShim.ts";

// Another program (the Scrawl app uses the same keys) may hold the shortcut and let go of it later.
const SHORTCUT_RETRY_MS = 15_000;
// Short presses must not fall between two looks. Polling needs no hook, no message pump and no
// permission, and costs two native calls per look, only while a capture runs.
const INPUT_POLL_MS = 10;
const VK_LBUTTON = 0x01;
const VK_SHIFT = 0x10;
const FLAG_SHORTCUT = "Alt+Shift+F";
const LOOKUP_DRAIN_MS = 400;
// The input a crash of the whole app can lose. A reload loses none: this process keeps it.
const JOURNAL_INTERVAL_MS = 5_000;
const RETENTION_INTERVAL_MS = 60 * 60 * 1000;
const MAX_READ_BYTES = 32 * 1024 * 1024;
const PILL_WIDTH = 96;
const PILL_HEIGHT = 30;

export class DesktopScrawlError extends Schema.TaggedError<DesktopScrawlError>()(
  "DesktopScrawlError",
  { reason: Schema.String },
) {
  override get message(): string {
    return this.reason;
  }
}

export class DesktopScrawl extends Context.Service<
  DesktopScrawl,
  {
    readonly start: () => Effect.Effect<ScrawlStartResult, DesktopScrawlError>;
    readonly stop: (input: ScrawlCaptureRef) => Effect.Effect<ScrawlStopResult, DesktopScrawlError>;
    readonly cancel: (input: ScrawlCaptureRef) => Effect.Effect<void>;
    readonly appendVideo: (
      input: ScrawlAppendVideoInput,
    ) => Effect.Effect<void, DesktopScrawlError>;
    readonly writeFile: (input: ScrawlWriteFileInput) => Effect.Effect<void, DesktopScrawlError>;
    readonly readFile: (
      input: ScrawlReadFileInput,
    ) => Effect.Effect<Uint8Array, DesktopScrawlError>;
    readonly listUnfinished: () => Effect.Effect<ReadonlyArray<ScrawlUnfinished>>;
    readonly beginRebuild: (
      input: ScrawlCaptureRef,
    ) => Effect.Effect<ScrawlUnfinished, DesktopScrawlError>;
    readonly markBuilt: (input: ScrawlCaptureRef) => Effect.Effect<void>;
    readonly listCaptures: () => Effect.Effect<ReadonlyArray<ScrawlCaptureSummary>>;
    readonly setPinned: (input: ScrawlSetPinnedInput) => Effect.Effect<void, DesktopScrawlError>;
    readonly trash: (input: ScrawlCaptureRef) => Effect.Effect<void, DesktopScrawlError>;
    readonly reveal: (input: ScrawlCaptureRef) => Effect.Effect<void, DesktopScrawlError>;
    readonly configure: (settings: ClientSettings) => Effect.Effect<void>;
    readonly setShortcutSuppressed: (suppressed: boolean) => Effect.Effect<void>;
    readonly shortcutState: Effect.Effect<ScrawlShortcutState>;
    readonly checkShortcut: (
      shortcut: SnapShotKeyChord,
    ) => Effect.Effect<ScrawlShortcutAvailability>;
  }
>()("@t3tools/desktop/scrawl/DesktopScrawl") {}

const INK_PAGE = `<!doctype html><html><body style="margin:0;background:transparent;overflow:hidden">
<canvas id="c" style="position:fixed;inset:0;width:100%;height:100%"></canvas><script>
const c=document.getElementById("c"),g=c.getContext("2d");let last=null;
const fit=()=>{c.width=innerWidth*devicePixelRatio;c.height=innerHeight*devicePixelRatio;g.scale(devicePixelRatio,devicePixelRatio);g.strokeStyle="#ff2d2d";g.lineWidth=4;g.lineCap="round";g.lineJoin="round"};fit();
window.inkMove=(x,y)=>{if(last){g.beginPath();g.moveTo(last[0],last[1]);g.lineTo(x,y);g.stroke()}last=[x,y]};
window.inkLift=()=>{last=null};
window.inkClear=()=>{last=null;g.clearRect(0,0,innerWidth,innerHeight)};
</script></body></html>`;

const PILL_PAGE = `<!doctype html><html><body style="margin:0;background:#18181b;color:#fafafa;font:600 13px system-ui;display:flex;align-items:center;justify-content:center;gap:8px;height:100vh;overflow:hidden;user-select:none">
<span style="width:9px;height:9px;border-radius:50%;background:#ef4444"></span><span id="t">0:00</span>
<script>window.setClock=(v)=>{document.getElementById("t").textContent=v}</script></body></html>`;

const dataUrl = (html: string) => `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;

const overlayOptions = (bounds: Electron.Rectangle): Electron.BrowserWindowConstructorOptions => ({
  ...bounds,
  transparent: true,
  frame: false,
  focusable: false,
  resizable: false,
  movable: false,
  hasShadow: false,
  skipTaskbar: true,
  alwaysOnTop: true,
  show: false,
  webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false },
});

const probeShortcut = (candidate: string): ScrawlShortcutAvailability => {
  try {
    if (!Electron.globalShortcut.register(candidate, () => undefined)) {
      return { available: false, message: "Another program is using this shortcut" };
    }
    Electron.globalShortcut.unregister(candidate);
    return { available: true, message: null };
  } catch {
    return { available: false, message: "The system could not register this shortcut" };
  }
};

const toError = (cause: unknown) =>
  new DesktopScrawlError({ reason: cause instanceof Error ? cause.message : String(cause) });

interface RunningCapture {
  readonly id: string;
  readonly bundlePath: string;
  readonly startedAtMs: number;
  readonly tracker: ScrawlInputTracker;
  readonly context: ScrawlContextLog;
  readonly watcher: ScrawlContextProcess | null;
  readonly lookups: ElementLookups | null;
  readonly flagShortcut: boolean;
  readonly windowTitle: string;
  readonly display: Electron.Display;
  readonly ink: Electron.BrowserWindow;
  readonly pill: Electron.BrowserWindow;
  readonly inputTimer: ReturnType<typeof setInterval>;
  readonly journalTimer: ReturnType<typeof setInterval>;
  readonly session: ScrawlStartResult;
  journalWrites: Promise<void>;
  inkTimer: ReturnType<typeof setTimeout> | null;
  readonly clockTimer: ReturnType<typeof setInterval>;
}

const make = Effect.gen(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const desktopWindow = yield* DesktopWindow.DesktopWindow;
  const clientSettings = yield* DesktopClientSettings.DesktopClientSettings;
  const services = yield* Effect.context<never>();
  const capturesDir = NodePath.join(environment.baseDir, "scrawl", "captures");
  const initialSettings = yield* clientSettings.get.pipe(
    Effect.map(Option.getOrNull),
    Effect.orElseSucceed(() => null),
  );
  let running: RunningCapture | null = null;
  let nextIndex = 0;
  let retention: ScrawlRetention = initialSettings?.scrawlRetention ?? "week";
  let accelerator = toElectronAccelerator(
    initialSettings?.scrawlShortcut ?? DEFAULT_SCRAWL_SHORTCUT,
  );
  let shortcutHeld = false;
  let shortcutSuppressed = false;
  let shortcutRetry: ReturnType<typeof setInterval> | null = null;
  // Ids are checked by the contract, and finished captures keep writing frames and a summary.
  const bundleOf = (id: string) => NodePath.join(capturesDir, `${id}.scrawl`);
  const lookCloserCommand = NodePath.join(
    environment.baseDir,
    "bin",
    scrawlShimName(environment.platform),
  );
  // Written on every start: the executable's path changes when the app moves or the channel does.
  const shimWritten = environment.isPackaged
    ? yield* Effect.promise(async () => {
        await NodeFSP.mkdir(NodePath.dirname(lookCloserCommand), { recursive: true });
        await NodeFSP.writeFile(
          lookCloserCommand,
          renderScrawlShim({
            platform: environment.platform,
            executable: process.execPath,
            t3Home: environment.baseDir,
          }),
          { mode: 0o755 },
        );
        return true;
      }).pipe(Effect.catchDefect(() => Effect.succeed(false)))
    : false;

  const ink = (capture: RunningCapture, script: string) => {
    if (!capture.ink.isDestroyed()) void capture.ink.webContents.executeJavaScript(script, true);
  };

  /** Clicks and strokes need Windows' key state; elsewhere a capture has voice, video and cursor. */
  const startInputPoll = (
    isKeyDown: ((virtualKey: number) => boolean) | null,
    lookAt: (capture: RunningCapture, key: string, at: CursorPoint) => void,
  ) => {
    let left = false;
    let shift = false;
    return setInterval(() => {
      const current = running;
      if (current === null) return;
      const t = Date.now() - current.startedAtMs;
      const at = Electron.screen.getCursorScreenPoint();
      if (isKeyDown !== null) {
        const nextLeft = isKeyDown(VK_LBUTTON);
        const nextShift = isKeyDown(VK_SHIFT);
        if (nextLeft && !left) {
          current.tracker.leftDown(t, at);
          current.watcher?.requestSnapshot();
          lookAt(current, pointerLookupKey(t), at);
        }
        if (!nextLeft && left) current.tracker.leftUp(t, at);
        if (nextShift && !shift) {
          current.tracker.shiftDown(t, at);
          if (current.inkTimer !== null) clearTimeout(current.inkTimer);
          current.inkTimer = null;
        }
        if (!nextShift && shift) {
          if (current.tracker.shiftUp()) {
            const stroke = current.tracker.result().strokes.at(-1)!;
            const point = strokeLookupPoint(stroke, current.display.bounds);
            lookAt(current, strokeLookupKey(stroke.t0), point);
          }
          ink(current, "inkLift()");
          // Fades on a clock, not on the next click, so a click's effect on the screen stays its own.
          current.inkTimer = setTimeout(() => ink(current, "inkClear()"), SCRAWL_INK_HOLD_MS);
        }
        left = nextLeft;
        shift = nextShift;
      }
      current.context.cursor(t, at);
      const point = current.tracker.moved(t, at);
      if (point !== null) {
        ink(
          current,
          `inkMove(${point.x - current.display.bounds.x},${point.y - current.display.bounds.y})`,
        );
      }
    }, INPUT_POLL_MS);
  };

  const start = Effect.fn("DesktopScrawl.start")(function* () {
    // The renderer owns the capture and only starts when it has none, so one left here lost its
    // renderer to a reload. Without this its ink and pill would stay on screen for good.
    if (running !== null) tearDown(running);
    const cursor = Electron.screen.getCursorScreenPoint();
    const display = Electron.screen.getDisplayNearestPoint(cursor);
    const sources = yield* Effect.tryPromise({
      try: () =>
        Electron.desktopCapturer.getSources({
          types: ["screen"],
          thumbnailSize: { width: 0, height: 0 },
        }),
      catch: toError,
    });
    const source = sources.find((entry) => entry.display_id === String(display.id)) ?? sources[0];
    if (source === undefined) {
      return yield* new DesktopScrawlError({ reason: "No screen to record." });
    }
    const front = yield* Effect.tryPromise({
      try: () => activeWindow(environment.platform),
      catch: toError,
    }).pipe(Effect.orElseSucceed(() => undefined));
    const keys =
      environment.platform === "win32"
        ? yield* Effect.tryPromise({ try: () => loadWindowsForegroundApi(), catch: toError })
        : null;
    const startedAtMs = Date.now();
    const id = `scrawl-${startedAtMs.toString(36)}-${(nextIndex++).toString(36)}`;
    const bundlePath = NodePath.join(capturesDir, `${id}.scrawl`);
    yield* Effect.tryPromise({
      try: () => NodeFSP.mkdir(NodePath.join(bundlePath, "frames"), { recursive: true }),
      catch: toError,
    });
    const tracker = new ScrawlInputTracker(display.bounds);
    const context = new ScrawlContextLog(display.bounds);
    const windowAtPoint =
      keys === null
        ? null
        : yield* Effect.tryPromise({ try: () => loadWindowAtPoint(), catch: toError }).pipe(
            Effect.orElseSucceed(() => null),
          );

    const inkWindow = new Electron.BrowserWindow(overlayOptions(display.bounds));
    inkWindow.setIgnoreMouseEvents(true);
    inkWindow.setAlwaysOnTop(true, "screen-saver");
    void inkWindow.loadURL(dataUrl(INK_PAGE));
    inkWindow.showInactive();

    // In the corner, because it shows in the recording: on Windows 10 22H2 neither a transparent nor
    // an opaque window stayed out of it with setContentProtection.
    const pill = new Electron.BrowserWindow({
      ...overlayOptions({
        x: display.workArea.x + display.workArea.width - PILL_WIDTH - 8,
        y: display.workArea.y + display.workArea.height - PILL_HEIGHT - 8,
        width: PILL_WIDTH,
        height: PILL_HEIGHT,
      }),
      transparent: false,
      backgroundColor: "#18181b",
    });
    pill.setIgnoreMouseEvents(true);
    pill.setAlwaysOnTop(true, "screen-saver");
    void pill.loadURL(dataUrl(PILL_PAGE));
    pill.showInactive();

    const nativeId = (window: Electron.BrowserWindow) =>
      Number(window.getNativeWindowHandle().readBigUInt64LE() & 0xffff_ffffn);
    const overlayIds = new Set([nativeId(inkWindow), nativeId(pill)]);
    const relative = (at: number) => at - startedAtMs;
    const watcher =
      keys === null
        ? null
        : startScrawlContextProcess(
            NodePath.join(__dirname, "scrawl", "ScrawlContextWorker.cjs"),
            {
              frame: Electron.screen.dipToScreenRect(null, display.bounds),
              dock: taskbarStrip(
                Electron.screen.dipToScreenRect(null, display.bounds),
                Electron.screen.dipToScreenRect(null, display.workArea),
              ),
              ignoredWindowIds: [...overlayIds],
            },
            (message) => {
              if (message.type === "wheel") {
                const at = Electron.screen.getCursorScreenPoint();
                context.scrolled(relative(message.at), at, message.dx, message.dy);
              } else if (message.type === "chord") {
                context.pressed(relative(message.at), message.shortcut);
              } else if (message.type === "app") {
                context.switchedTo(relative(message.at), message.app);
              } else if (message.type === "windows") {
                context.windows({ t: relative(message.at), windows: message.windows });
              }
            },
          );
    const lookups = keys === null ? null : startElementLookups();
    const flagShortcut = Electron.globalShortcut.register(FLAG_SHORTCUT, () => {
      const current = running;
      if (current === null) return;
      current.context.flagged(Date.now() - current.startedAtMs);
      if (!current.pill.isDestroyed()) {
        void current.pill.webContents.executeJavaScript('setClock("⚑")', true);
      }
    });
    const lookAt = (current: RunningCapture, key: string, at: CursorPoint) => {
      const { x, y, width, height } = current.display.bounds;
      if (at.x < x || at.y < y || at.x >= x + width || at.y >= y + height) return;
      if (keys === null || windowAtPoint === null) return;
      const point = Electron.screen.dipToScreenPoint(at);
      const window = windowAtPoint(point.x, point.y);
      if (window === 0n) return;
      // Asking about our own window would turn on this renderer's accessibility tree. The overlays
      // let clicks through, so what is under them is someone else's.
      const overlay = overlayIds.has(Number(window & 0xffff_ffffn));
      if (!overlay && keys.getWindowThreadAndProcessId(window).processId === process.pid) return;
      current.lookups?.look(key, point.x, point.y);
    };

    const scale = display.scaleFactor;
    const session: ScrawlStartResult = {
      id,
      sourceId: source.id,
      width: Math.round(display.bounds.width * scale),
      height: Math.round(display.bounds.height * scale),
      startedAtMs,
      app: front?.owner.name.replace(/\.exe$/i, "") ?? "",
      windowTitle: front?.title ?? "",
      bundlePath,
      ...(shimWritten ? { lookCloserCommand } : {}),
    };
    const capture: RunningCapture = {
      id,
      session,
      journalWrites: Promise.resolve(),
      journalTimer: setInterval(() => {
        if (running !== null) void saveJournal(running);
      }, JOURNAL_INTERVAL_MS),
      bundlePath,
      startedAtMs,
      tracker,
      context,
      watcher,
      lookups,
      flagShortcut,
      windowTitle: front?.title ?? "",
      display,
      ink: inkWindow,
      pill,
      inputTimer: startInputPoll(keys === null ? null : keys.isKeyDown, lookAt),
      inkTimer: null,
      clockTimer: setInterval(() => {
        const current = running;
        if (current === null || current.pill.isDestroyed()) return;
        const seconds = Math.floor((Date.now() - current.startedAtMs) / 1000);
        const clock = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
        void current.pill.webContents.executeJavaScript(`setClock("${clock}")`, true);
      }, 1000),
    };
    running = capture;
    saveJournal(capture);
    return session;
  });

  const inputOf = (capture: RunningCapture, hits: ReadonlyMap<string, ElementHit> = new Map()) =>
    mergeCaptureInput(capture.tracker.result(), capture.context.result(), hits, [
      capture.windowTitle,
    ]);

  const saveJournal = (capture: RunningCapture, hits?: ReadonlyMap<string, ElementHit>) => {
    const journal = { session: capture.session, input: inputOf(capture, hits) };
    capture.journalWrites = capture.journalWrites
      .then(() => writeJournal(capture.bundlePath, journal))
      // Only a crash reads it, and the next write brings it up to date.
      .catch(() => undefined);
    return capture.journalWrites;
  };

  const tearDown = (capture: RunningCapture, keepHelpers = false) => {
    if (!keepHelpers) {
      capture.watcher?.kill();
      void capture.lookups?.finish(0);
    }
    if (capture.flagShortcut) Electron.globalShortcut.unregister(FLAG_SHORTCUT);
    clearInterval(capture.inputTimer);
    clearInterval(capture.journalTimer);
    if (capture.inkTimer !== null) clearTimeout(capture.inkTimer);
    clearInterval(capture.clockTimer);
    if (!capture.ink.isDestroyed()) capture.ink.destroy();
    if (!capture.pill.isDestroyed()) capture.pill.destroy();
    if (running === capture) running = null;
  };

  const stop = Effect.fn("DesktopScrawl.stop")(function* (input: ScrawlCaptureRef) {
    if (running === null || running.id !== input.id) {
      return yield* new DesktopScrawlError({ reason: "This capture is not running." });
    }
    const capture = running;
    capture.tracker.shiftUp();
    tearDown(capture, true);
    const [hits] = yield* Effect.promise(() =>
      Promise.all([
        capture.lookups?.finish(LOOKUP_DRAIN_MS) ?? new Map<string, ElementHit>(),
        capture.watcher?.stop(),
      ]),
    );
    yield* Effect.promise(() => saveJournal(capture, hits));
    return inputOf(capture, hits);
  });

  const cancel = Effect.fn("DesktopScrawl.cancel")(function* (input: ScrawlCaptureRef) {
    const capture = running?.id === input.id ? running : null;
    if (capture !== null) tearDown(capture);
    yield* Effect.promise(async () => {
      await capture?.journalWrites;
      await NodeFSP.rm(bundleOf(input.id), { recursive: true, force: true }).catch(() => undefined);
    });
  });

  const appendVideo = Effect.fn("DesktopScrawl.appendVideo")(function* (
    input: ScrawlAppendVideoInput,
  ) {
    yield* Effect.tryPromise({
      try: () => NodeFSP.appendFile(NodePath.join(bundleOf(input.id), input.name), input.bytes),
      catch: toError,
    });
  });

  const writeFile = Effect.fn("DesktopScrawl.writeFile")(function* (input: ScrawlWriteFileInput) {
    const target = NodePath.join(bundleOf(input.id), input.path);
    yield* Effect.tryPromise({
      try: async () => {
        await NodeFSP.mkdir(NodePath.dirname(target), { recursive: true });
        await NodeFSP.writeFile(target, input.bytes);
      },
      catch: toError,
    });
  });

  const readFile = Effect.fn("DesktopScrawl.readFile")(function* (input: ScrawlReadFileInput) {
    return yield* Effect.tryPromise({
      try: async () => {
        const file = await NodeFSP.open(NodePath.join(bundleOf(input.id), input.path), "r");
        try {
          const bytes = new Uint8Array(Math.min(input.length, MAX_READ_BYTES));
          const { bytesRead } = await file.read(bytes, 0, bytes.length, input.offset);
          return bytes.subarray(0, bytesRead);
        } finally {
          await file.close();
        }
      },
      catch: toError,
    });
  });

  const listUnfinished = Effect.fn("DesktopScrawl.listUnfinished")(function* () {
    // Only a renderer without a capture of its own asks, so one still here lost its renderer.
    if (running !== null) {
      const orphan = running;
      orphan.tracker.shiftUp();
      tearDown(orphan);
      yield* Effect.promise(() => saveJournal(orphan));
    }
    return yield* Effect.promise(async () => {
      const { owed, empty } = planRebuilds(await readCaptureFolders(capturesDir), null);
      await Promise.all(
        empty.map((capture) =>
          NodeFSP.rm(capture.folder, { recursive: true, force: true }).catch(() => undefined),
        ),
      );
      return owed.map(unfinishedOf);
    });
  });

  const beginRebuild = Effect.fn("DesktopScrawl.beginRebuild")(function* (input: ScrawlCaptureRef) {
    return yield* Effect.tryPromise({
      try: async () => {
        const capture = await readCaptureFolder(bundleOf(input.id));
        if (capture === null) throw new Error("This capture no longer exists.");
        await NodeFSP.writeFile(NodePath.join(capture.folder, REBUILT_ONCE_FILE), "");
        return unfinishedOf(capture);
      },
      catch: toError,
    });
  });

  const markBuilt = Effect.fn("DesktopScrawl.markBuilt")(function* (input: ScrawlCaptureRef) {
    yield* Effect.promise(() => removeJournal(bundleOf(input.id)).catch(() => undefined));
  });

  const listCaptures = Effect.fn("DesktopScrawl.listCaptures")(function* () {
    return yield* Effect.promise(async () => {
      const captures = await readCaptureFolders(capturesDir);
      return captures
        .map((capture) => summarize(capture, retention, running?.id ?? null))
        .toSorted((left, right) => right.createdAtMs - left.createdAtMs);
    });
  });

  const setPinned = Effect.fn("DesktopScrawl.setPinned")(function* (input: ScrawlSetPinnedInput) {
    const marker = NodePath.join(bundleOf(input.id), PINNED_FILE);
    yield* Effect.tryPromise({
      try: () =>
        input.pinned ? NodeFSP.writeFile(marker, "") : NodeFSP.rm(marker, { force: true }),
      catch: toError,
    });
  });

  const trash = Effect.fn("DesktopScrawl.trash")(function* (input: ScrawlCaptureRef) {
    if (running?.id === input.id) {
      return yield* new DesktopScrawlError({ reason: "This capture is still recording." });
    }
    yield* Effect.tryPromise({
      try: () => Electron.shell.trashItem(bundleOf(input.id)),
      catch: toError,
    });
  });

  const reveal = Effect.fn("DesktopScrawl.reveal")(function* (input: ScrawlCaptureRef) {
    yield* Effect.tryPromise({
      try: async () => {
        const failure = await Electron.shell.openPath(bundleOf(input.id));
        if (failure !== "") throw new Error(failure);
      },
      catch: toError,
    });
  });

  const run = Effect.runForkWith(services);

  /** Moves to the bin, like Scrawl: the list named the date, and a wrong one can still be undone. */
  const runRetention = async () => {
    if (running !== null) return;
    const actions = planRetention(
      await readCaptureFolders(capturesDir),
      retention,
      null,
      Date.now(),
    );
    for (const action of actions) {
      const paths = action.kind === "bundle" ? [action.folder] : action.paths;
      for (const path of paths) {
        await Electron.shell.trashItem(path).catch((cause: unknown) => {
          run(Effect.logWarning(`scrawl: could not move ${path} to the bin: ${String(cause)}`));
        });
      }
    }
  };

  const publishShortcutState = () => {
    run(
      desktopWindow
        .dispatchMenuAction(SCRAWL_SHORTCUT_STATE_ACTION, { reveal: false })
        .pipe(Effect.ignore),
    );
  };

  const takeShortcut = () => {
    try {
      shortcutHeld = Electron.globalShortcut.register(accelerator, () => {
        run(
          desktopWindow
            .dispatchMenuAction(SCRAWL_TOGGLE_ACTION, { reveal: false })
            .pipe(Effect.ignore),
        );
      });
    } catch {
      shortcutHeld = false;
    }
    return shortcutHeld;
  };

  const releaseShortcut = () => {
    if (shortcutRetry !== null) clearInterval(shortcutRetry);
    shortcutRetry = null;
    if (shortcutHeld) Electron.globalShortcut.unregister(accelerator);
    shortcutHeld = false;
  };

  const applyShortcut = () => {
    if (shortcutSuppressed || takeShortcut()) return;
    run(Effect.logWarning(`scrawl: ${accelerator} is taken by another program`));
    const retry = setInterval(() => {
      if (!takeShortcut()) return;
      clearInterval(retry);
      if (shortcutRetry === retry) shortcutRetry = null;
      publishShortcutState();
    }, SHORTCUT_RETRY_MS);
    retry.unref?.();
    shortcutRetry = retry;
  };

  const configure = (settings: ClientSettings) =>
    Effect.sync(() => {
      retention = settings.scrawlRetention;
      const next = toElectronAccelerator(settings.scrawlShortcut);
      if (next === accelerator) return;
      releaseShortcut();
      accelerator = next;
      applyShortcut();
      publishShortcutState();
    });

  const setShortcutSuppressed = (suppressed: boolean) =>
    Effect.sync(() => {
      if (suppressed === shortcutSuppressed) return;
      shortcutSuppressed = suppressed;
      releaseShortcut();
      applyShortcut();
      publishShortcutState();
    });

  const shortcutState = Effect.sync((): ScrawlShortcutState => ({
    accelerator,
    // Letting go while the user records a new shortcut is not another program holding it.
    registered: shortcutHeld || shortcutSuppressed,
  }));

  const checkShortcut = (shortcut: SnapShotKeyChord) =>
    Effect.sync((): ScrawlShortcutAvailability => {
      const conflict = snapShotShortcutSystemConflict(shortcut);
      if (conflict !== null) return { available: false, message: conflict };
      const candidate = toElectronAccelerator(shortcut);
      // Electron refuses a second registration of keys this app already holds.
      if (candidate === accelerator && shortcutHeld) return { available: true, message: null };
      return probeShortcut(candidate);
    });

  yield* Effect.acquireRelease(
    Effect.promise(async () => {
      await Electron.app.whenReady();
      applyShortcut();
      void runRetention();
      const retentionTimer = setInterval(() => void runRetention(), RETENTION_INTERVAL_MS);
      retentionTimer.unref?.();
      return retentionTimer;
    }),
    (retentionTimer) =>
      Effect.sync(() => {
        clearInterval(retentionTimer);
        releaseShortcut();
        if (running !== null) tearDown(running);
      }),
  );

  return DesktopScrawl.of({
    start,
    stop,
    cancel,
    appendVideo,
    writeFile,
    readFile,
    listUnfinished,
    beginRebuild,
    markBuilt,
    listCaptures,
    setPinned,
    trash,
    reveal,
    configure,
    setShortcutSuppressed,
    shortcutState,
    checkShortcut,
  });
});

export const layer = Layer.effect(DesktopScrawl, make);
