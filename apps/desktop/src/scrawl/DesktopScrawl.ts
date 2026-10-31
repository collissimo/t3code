// @effect-diagnostics globalTimers:off -- The cursor poll and pill clock run at native callback boundaries outside Effect fibers.
// @effect-diagnostics globalTimersInEffect:off -- They are started here and owned by the capture, not a fiber.
// @effect-diagnostics globalDate:off -- Input times share the wall clock with the renderer's recorder.
// @effect-diagnostics globalDateInEffect:off -- Same clock as above.
// @effect-diagnostics nodeBuiltinImport:off -- Bundles are plain files written outside any Effect service.
// The desktop half of a Scrawl capture: the global shortcut, the mouse and Shift watcher, the ink
// and the recording pill, and the bundle on disk. The renderer records and builds the bundle.

import {
  SCRAWL_INK_HOLD_MS,
  SCRAWL_TOGGLE_ACTION,
  type ScrawlAppendVideoInput,
  type ScrawlCaptureRef,
  type ScrawlStartResult,
  type ScrawlStopResult,
  type ScrawlWriteFileInput,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Electron from "electron";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import { loadWindowsForegroundApi } from "../electron/WindowsForeground.ts";
import { activeWindow } from "../snapShot/ActiveWindow.ts";
import * as DesktopWindow from "../window/DesktopWindow.ts";
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

const DEFAULT_SHORTCUT = "Alt+Shift+S";
// Another program (the Scrawl app uses the same keys) may hold the shortcut and let go of it later.
const SHORTCUT_RETRY_MS = 15_000;
// Short presses must not fall between two looks. Polling needs no hook, no message pump and no
// permission, and costs two native calls per look, only while a capture runs.
const INPUT_POLL_MS = 10;
const VK_LBUTTON = 0x01;
const VK_SHIFT = 0x10;
const FLAG_SHORTCUT = "Alt+Shift+F";
const LOOKUP_DRAIN_MS = 400;
// Like Scrawl: frames, text and contact sheet stay, the heavy media goes.
const MEDIA_KEPT_MS = 7 * 24 * 60 * 60 * 1000;
const MEDIA_FILES = ["recording.mp4", "recording.webm", "audio.wav"];
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

const dropOldMedia = async (capturesDir: string, now: number) => {
  const bundles = await NodeFSP.readdir(capturesDir).catch(() => [] as Array<string>);
  for (const bundle of bundles) {
    if (!bundle.endsWith(".scrawl")) continue;
    const folder = NodePath.join(capturesDir, bundle);
    const stat = await NodeFSP.stat(folder).catch(() => null);
    if (stat === null || now - stat.mtimeMs < MEDIA_KEPT_MS) continue;
    await Promise.all(
      MEDIA_FILES.map((file) => NodeFSP.rm(NodePath.join(folder, file), { force: true })),
    ).catch(() => undefined);
  }
};

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
  inkTimer: ReturnType<typeof setTimeout> | null;
  readonly clockTimer: ReturnType<typeof setInterval>;
}

const make = Effect.gen(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const desktopWindow = yield* DesktopWindow.DesktopWindow;
  const services = yield* Effect.context<never>();
  const capturesDir = NodePath.join(environment.baseDir, "scrawl", "captures");
  let running: RunningCapture | null = null;
  // Finished captures keep writing their frames and summary after the watcher stopped.
  const bundles = new Map<string, string>();
  let nextIndex = 0;

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
    void dropOldMedia(capturesDir, Date.now());
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
              ignoredWindowIds: [nativeId(inkWindow), nativeId(pill)],
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
      // Asking about our own window would turn on this renderer's accessibility tree.
      const window = windowAtPoint(point.x, point.y);
      if (window === 0n || keys.getWindowThreadAndProcessId(window).processId === process.pid) {
        return;
      }
      current.lookups?.look(key, point.x, point.y);
    };

    const capture: RunningCapture = {
      id,
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
    bundles.set(id, bundlePath);
    const scale = display.scaleFactor;
    return {
      id,
      sourceId: source.id,
      width: Math.round(display.bounds.width * scale),
      height: Math.round(display.bounds.height * scale),
      startedAtMs,
      app: front?.owner.name.replace(/\.exe$/i, "") ?? "",
      windowTitle: front?.title ?? "",
      bundlePath,
    } satisfies ScrawlStartResult;
  });

  const tearDown = (capture: RunningCapture, keepHelpers = false) => {
    if (!keepHelpers) {
      capture.watcher?.kill();
      void capture.lookups?.finish(0);
    }
    if (capture.flagShortcut) Electron.globalShortcut.unregister(FLAG_SHORTCUT);
    clearInterval(capture.inputTimer);
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
    return mergeCaptureInput(capture.tracker.result(), capture.context.result(), hits, [
      capture.windowTitle,
    ]);
  });

  const cancel = Effect.fn("DesktopScrawl.cancel")(function* (input: ScrawlCaptureRef) {
    if (running?.id === input.id) tearDown(running);
    const bundlePath = bundles.get(input.id);
    bundles.delete(input.id);
    if (bundlePath !== undefined) {
      yield* Effect.promise(() =>
        NodeFSP.rm(bundlePath, { recursive: true, force: true }).catch(() => undefined),
      );
    }
  });

  const appendVideo = Effect.fn("DesktopScrawl.appendVideo")(function* (
    input: ScrawlAppendVideoInput,
  ) {
    const bundlePath = bundles.get(input.id);
    if (bundlePath === undefined) {
      return yield* new DesktopScrawlError({ reason: "Unknown capture." });
    }
    yield* Effect.tryPromise({
      try: () => NodeFSP.appendFile(NodePath.join(bundlePath, input.name), input.bytes),
      catch: toError,
    });
  });

  const writeFile = Effect.fn("DesktopScrawl.writeFile")(function* (input: ScrawlWriteFileInput) {
    const bundlePath = bundles.get(input.id);
    if (bundlePath === undefined) {
      return yield* new DesktopScrawlError({ reason: "Unknown capture." });
    }
    const target = NodePath.join(bundlePath, input.path);
    yield* Effect.tryPromise({
      try: async () => {
        await NodeFSP.mkdir(NodePath.dirname(target), { recursive: true });
        await NodeFSP.writeFile(target, input.bytes);
      },
      catch: toError,
    });
  });

  yield* Effect.acquireRelease(
    Effect.promise(() => {
      const run = Effect.runForkWith(services);
      const register = () =>
        Electron.globalShortcut.register(DEFAULT_SHORTCUT, () => {
          run(
            desktopWindow
              .dispatchMenuAction(SCRAWL_TOGGLE_ACTION, { reveal: false })
              .pipe(Effect.ignore),
          );
        });
      const whenReady = async () => {
        await Electron.app.whenReady();
        if (register()) return null;
        run(Effect.logWarning(`scrawl: ${DEFAULT_SHORTCUT} is taken by another program`));
        const retry = setInterval(() => {
          if (register()) clearInterval(retry);
        }, SHORTCUT_RETRY_MS);
        retry.unref?.();
        return retry;
      };
      return whenReady();
    }),
    (retry) =>
      Effect.promise(async () => {
        const timer = await retry;
        if (timer !== null) clearInterval(timer);
        Electron.globalShortcut.unregister(DEFAULT_SHORTCUT);
        if (running !== null) tearDown(running);
      }),
  );

  return DesktopScrawl.of({ start, stop, cancel, appendVideo, writeFile });
});

export const layer = Layer.effect(DesktopScrawl, make);
