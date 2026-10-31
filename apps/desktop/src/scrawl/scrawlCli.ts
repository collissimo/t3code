// @effect-diagnostics nodeBuiltinImport:off -- A one-shot command before and outside the app's Effect runtime.
// @effect-diagnostics globalDate:off -- Only ages leftover temp profiles.
// `t3-scrawl`: look closer at a capture and export it. boot.ts lands here for `--scrawl`, ahead of
// the app's main, because a video can only be decoded inside Chromium: no single-instance lock, no
// server, no window on screen, so it runs beside an open app or with none open at all.

import * as Electron from "electron";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";

import {
  FULL_RECT,
  type BundleManifest,
  type MarkEntry,
  type Rect,
  cameraPath,
  cropAt,
  cropOfKeyframe,
  findMark,
  markEntries,
  markJson,
  markLine,
  markWindow,
  momentWindow,
  outputSize,
  parseClockMs,
  preciseClock,
  rangeTimes,
  resolveCrop,
  resolveMoment,
  saidBetween,
  sampleTimes,
  shortClock,
} from "./scrawlLookCloser.ts";
import {
  SCRAWL_RENDER_PROGRESS_CHANNEL,
  type Annotations,
  type ExportResult,
  type ProbeResult,
  type RenderJob,
} from "./scrawlRenderJob.ts";
import { SCRAWL_CLI_FLAG } from "./scrawlShim.ts";

const INK_HOLD_MS = 5_000;
const MAX_RANGE_FRAMES = 2_000;
const DEFAULT_EXPORT_LONG_EDGE = 1920;
const STALE_PROFILE_MS = 60 * 60 * 1000;
const PROFILE_PREFIX = "t3-scrawl-";

const USAGE = `t3-scrawl: look closer at a Scrawl capture and export it. <bundle> is a .scrawl folder, or latest.

  t3-scrawl zoom <bundle> --at 0:21            a PNG sheet of frames around a time
  t3-scrawl zoom <bundle> --at "a phrase"      or around something they said
  t3-scrawl zoom <bundle> --mark 2 [--frame N] or around one mark, with only its ink
      [--span 2] seconds covered   [--frames 12] cells   [--full] the whole screen, not the crop
  t3-scrawl frames <bundle> --from 0:04 --to 0:06 [--fps 4]   plain PNGs of a range
  t3-scrawl inspect <bundle> [--json | --marks [--json]]      the text, the manifest, the marks
  t3-scrawl export <bundle> [--out demo.mp4] [--zoom] [--crop auto|full|x,y,w,h] [--size 1920]
      [--fps N] [--no-clicks] [--no-ink]                      one mp4 with the audio in sync

zoom and frames write into <bundle>/zoom/ and print the paths: open the PNGs and look at them.
Video and audio are deleted 7 days after a capture; frames/, the contact sheet and scrawl.json stay.`;

class UsageError extends Error {}

const capturesDir = () => {
  const home = process.env.T3CODE_HOME?.trim() || NodePath.join(NodeOS.homedir(), ".t3");
  return NodePath.join(home, "scrawl", "captures");
};

const latestBundle = () => {
  const dir = capturesDir();
  const newest = (NodeFS.existsSync(dir) ? NodeFS.readdirSync(dir) : [])
    .filter((name) => name.endsWith(".scrawl"))
    .map((name) => NodePath.join(dir, name))
    .filter((path) => NodeFS.existsSync(NodePath.join(path, "scrawl.json")))
    .map((path) => ({ path, at: NodeFS.statSync(NodePath.join(path, "scrawl.json")).mtimeMs }))
    .toSorted((left, right) => right.at - left.at)[0];
  if (newest === undefined) throw new Error(`No captures in ${dir}`);
  return newest.path;
};

const loadBundle = (arg: string | undefined) => {
  const named = arg === undefined || arg === "latest" ? latestBundle() : NodePath.resolve(arg);
  const dir = NodePath.basename(named) === "scrawl.json" ? NodePath.dirname(named) : named;
  const manifestPath = NodePath.join(dir, "scrawl.json");
  if (!NodeFS.existsSync(manifestPath)) throw new Error(`No capture at ${dir}`);
  const manifest = JSON.parse(NodeFS.readFileSync(manifestPath, "utf8")) as BundleManifest;
  return { dir, manifest };
};

const videoOf = (dir: string, manifest: BundleManifest) => {
  const path = manifest.video ? NodePath.join(dir, manifest.video) : null;
  if (path !== null && NodeFS.existsSync(path)) return path;
  throw new Error(
    manifest.video
      ? "The capture's video is gone: video and audio are deleted 7 days after a capture. frames/, contact-sheet.png and scrawl.json remain."
      : "The capture has no video.",
  );
};

const annotationsFor = (
  manifest: BundleManifest,
  options: { readonly ink: boolean; readonly clicks: boolean },
): Annotations => ({
  strokes:
    options.ink && manifest.inkInVideo !== true
      ? (manifest.strokes ?? []).map((stroke) => ({
          fromMs: stroke.t0,
          untilMs: stroke.t1 + INK_HOLD_MS,
          whole: false,
          points: stroke.pts,
        }))
      : [],
  clicks: options.clicks
    ? (manifest.events ?? []).flatMap((event) =>
        event.kind === "click" && "x" in event ? [{ t: event.t, x: event.x, y: event.y }] : [],
      )
    : [],
});

/** Only this mark's ink, whole from the moment it starts, also where the video holds every mark. */
const markAnnotations = (manifest: BundleManifest, entry: MarkEntry): Annotations => ({
  strokes: entry.mark.strokes.flatMap((index) => {
    const stroke = manifest.strokes?.[index];
    return stroke === undefined
      ? []
      : [
          {
            fromMs: entry.mark.t0,
            untilMs: Number.MAX_SAFE_INTEGER,
            whole: true,
            points: stroke.pts,
          },
        ];
  }),
  clicks: annotationsFor(manifest, { ink: false, clicks: true }).clicks,
});

const makeProfile = () => {
  const tmp = NodeOS.tmpdir();
  for (const name of NodeFS.readdirSync(tmp)) {
    if (!name.startsWith(PROFILE_PREFIX)) continue;
    const path = NodePath.join(tmp, name);
    try {
      if (Date.now() - NodeFS.statSync(path).mtimeMs > STALE_PROFILE_MS) {
        NodeFS.rmSync(path, { recursive: true, force: true });
      }
    } catch {
      // Another run may be using it or removing it.
    }
  }
  return NodeFS.mkdtempSync(NodePath.join(tmp, PROFILE_PREFIX));
};

const openRenderer = async (profile: string) => {
  await Electron.app.whenReady();
  const page = NodePath.join(profile, "render.html");
  NodeFS.writeFileSync(page, "<!doctype html>");
  const window = new Electron.BrowserWindow({
    show: false,
    webPreferences: {
      // Only this file's own script runs here, on local files. WebCodecs needs a secure context,
      // so a file: page and not about:blank or data:.
      nodeIntegration: true,
      contextIsolation: false,
      sandbox: false,
      backgroundThrottling: false,
    },
  });
  await window.loadFile(page);
  const pageScript = NodePath.join(__dirname, "scrawlRenderPage.cjs");
  return <Result>(job: RenderJob) =>
    new Promise<Result>((resolve, reject) => {
      window.webContents.once("render-process-gone", (_event, details) =>
        reject(new Error(`The renderer stopped: ${details.reason}`)),
      );
      window.webContents
        .executeJavaScript(`require(${JSON.stringify(pageScript)}).run(${JSON.stringify(job)})`)
        .then(resolve, reject);
    });
};

type Render = Awaited<ReturnType<typeof openRenderer>>;

const runZoom = async (render: Render, args: ReadonlyArray<string>) => {
  const { values, positionals } = NodeUtil.parseArgs({
    args: [...args],
    allowPositionals: true,
    options: {
      at: { type: "string" },
      mark: { type: "string" },
      frame: { type: "string" },
      span: { type: "string", default: "2" },
      frames: { type: "string", default: "12" },
      full: { type: "boolean", default: false },
    },
  });
  if ((values.at === undefined) === (values.mark === undefined)) {
    throw new UsageError("Pass one of --at or --mark");
  }
  const span = Number(values.span);
  const count = Number(values.frames);
  if (!Number.isFinite(span) || span <= 0) throw new UsageError("--span must be positive");
  if (!Number.isInteger(count) || count < 1) throw new UsageError("--frames must be 1 or more");
  const { dir, manifest } = loadBundle(positionals[0]);
  const video = videoOf(dir, manifest);
  const spanMs = Math.round(span * 1000);
  const lines: Array<string> = [];
  let window: readonly [number, number];
  let mark: MarkEntry | null = null;
  if (values.mark !== undefined) {
    const keyframe = values.frame === undefined ? undefined : Number(values.frame);
    mark = findMark(manifest, values.mark, keyframe);
    lines.push(markLine(mark));
    window = markWindow(mark.mark.t0, mark.mark.t1, spanMs, manifest.durationMs);
  } else {
    const at = resolveMoment(manifest, values.at!);
    if (at > manifest.durationMs) {
      throw new Error(`${preciseClock(at)} is past the end (${preciseClock(manifest.durationMs)})`);
    }
    window = momentWindow(at, spanMs, manifest.durationMs);
  }
  const [from, to] = window;
  const times = sampleTimes(from, to, count);
  const markCrop =
    mark !== null && mark.keyframe !== null ? cropOfKeyframe(manifest, mark.keyframe) : null;
  const viewAt = (t: number): Rect =>
    values.full ? FULL_RECT : ((mark !== null ? markCrop : cropAt(manifest, t)) ?? FULL_RECT);
  const out = NodePath.join(dir, "zoom", `zoom-${from}-${to}.png`);
  NodeFS.mkdirSync(NodePath.dirname(out), { recursive: true });
  await render({
    kind: "sheet",
    video,
    videoOffsetMs: manifest.videoOffsetMs ?? 0,
    out,
    annotations:
      mark !== null
        ? markAnnotations(manifest, mark)
        : annotationsFor(manifest, { ink: true, clicks: true }),
    cells: times.map((t) => ({ t, label: preciseClock(t), view: viewAt(t) })),
  });
  lines.push(out);
  lines.push(
    `${preciseClock(from)} → ${preciseClock(to)}, ${times.length} frames: ${times
      .map((t, index) => `#${index + 1} ${preciseClock(t)}`)
      .join(", ")}`,
  );
  const said = saidBetween(manifest, from, to);
  if (said !== "") lines.push(`Said: “${said}”`);
  return lines.join("\n");
};

const GENERATED_FRAME = /^frame-\d+\.png$/;

const runFrames = async (render: Render, args: ReadonlyArray<string>) => {
  const { values, positionals } = NodeUtil.parseArgs({
    args: [...args],
    allowPositionals: true,
    options: {
      from: { type: "string" },
      to: { type: "string" },
      fps: { type: "string", default: "4" },
    },
  });
  if (values.from === undefined || values.to === undefined) {
    throw new UsageError("Pass --from and --to");
  }
  const from = parseClockMs(values.from);
  const to = parseClockMs(values.to);
  const fps = Number(values.fps);
  if (from === null) throw new UsageError(`invalid --from time: ${values.from}`);
  if (to === null) throw new UsageError(`invalid --to time: ${values.to}`);
  if (from > to) throw new UsageError("The range ends before it starts");
  if (!Number.isFinite(fps) || fps <= 0 || fps > 240) {
    throw new UsageError("--fps must be between 1 and 240");
  }
  const { dir, manifest } = loadBundle(positionals[0]);
  if (
    manifest.video === undefined ||
    !NodeFS.existsSync(NodePath.join(dir, manifest.video ?? ""))
  ) {
    // The keyframes outlive the video, and may already answer the question.
    const kept = (manifest.keyframes ?? [])
      .filter((keyframe) => keyframe.t >= from && keyframe.t <= to)
      .map((keyframe) => NodePath.join(dir, keyframe.file))
      .filter((path) => NodeFS.existsSync(path));
    if (kept.length === 0) videoOf(dir, manifest);
    return kept.join("\n");
  }
  const times = rangeTimes(from, to, fps);
  if (times.length > MAX_RANGE_FRAMES) {
    throw new UsageError(`That is ${times.length} frames; use a shorter range or a lower --fps`);
  }
  const outDir = NodePath.join(dir, "zoom", `range-${from}-${to}`);
  NodeFS.mkdirSync(outDir, { recursive: true });
  // Repeating at a lower fps must not return leftovers from the last run.
  for (const name of NodeFS.readdirSync(outDir)) {
    if (GENERATED_FRAME.test(name)) NodeFS.rmSync(NodePath.join(outDir, name));
  }
  const frames = times.map((t, index) => ({
    t,
    out: NodePath.join(outDir, `frame-${String(index + 1).padStart(3, "0")}.png`),
  }));
  await render({
    kind: "frames",
    video: videoOf(dir, manifest),
    videoOffsetMs: manifest.videoOffsetMs ?? 0,
    frames,
  });
  return frames.map((frame) => frame.out).join("\n");
};

const runInspect = (args: ReadonlyArray<string>) => {
  const { values, positionals } = NodeUtil.parseArgs({
    args: [...args],
    allowPositionals: true,
    options: {
      json: { type: "boolean", default: false },
      marks: { type: "boolean", default: false },
    },
  });
  const { dir, manifest } = loadBundle(positionals[0]);
  if (values.marks) {
    const entries = markEntries(manifest);
    if (values.json) return JSON.stringify(entries.map(markJson), null, 2);
    return entries.length === 0 ? "No marks" : entries.map(markLine).join("\n");
  }
  if (values.json) return JSON.stringify(manifest, null, 2);
  const summary = NodePath.join(dir, "summary.md");
  if (!NodeFS.existsSync(summary)) throw new Error(`No summary.md in ${dir}`);
  return NodeFS.readFileSync(summary, "utf8").trimEnd();
};

const runExport = async (render: Render, args: ReadonlyArray<string>) => {
  const { values, positionals } = NodeUtil.parseArgs({
    args: [...args],
    allowPositionals: true,
    options: {
      out: { type: "string" },
      crop: { type: "string", default: "auto" },
      size: { type: "string", default: String(DEFAULT_EXPORT_LONG_EDGE) },
      zoom: { type: "boolean", default: false },
      fps: { type: "string" },
      "no-clicks": { type: "boolean", default: false },
      "no-ink": { type: "boolean", default: false },
    },
  });
  const { dir, manifest } = loadBundle(positionals[0]);
  const video = videoOf(dir, manifest);
  const offset = manifest.videoOffsetMs ?? 0;
  const probe = await render<ProbeResult>({ kind: "probe", video });
  const crop = resolveCrop(values.crop, manifest, probe.width, probe.height);
  const size = Number(values.size);
  if (!Number.isFinite(size)) throw new UsageError("--size must be a number");
  const { width, height } = outputSize(
    (crop[2] - crop[0]) * probe.width,
    (crop[3] - crop[1]) * probe.height,
    size,
  );
  const fps = values.fps === undefined ? (probe.packetRate >= 45 ? 60 : 30) : Number(values.fps);
  if (!Number.isInteger(fps) || fps < 1 || fps > 120) {
    throw new UsageError("--fps must be between 1 and 120");
  }
  const frameCount = Math.max(1, Math.ceil(probe.seconds * fps));
  const out = NodePath.resolve(
    values.out ??
      NodePath.join(
        Electron.app.getPath("videos"),
        "Scrawl",
        `${NodePath.basename(dir, ".scrawl")}.mp4`,
      ),
  );
  NodeFS.mkdirSync(NodePath.dirname(out), { recursive: true });
  const audio = manifest.audio ? NodePath.join(dir, manifest.audio) : null;
  const result = await render<ExportResult>({
    kind: "export",
    video,
    videoOffsetMs: offset,
    audio: audio !== null && NodeFS.existsSync(audio) ? audio : null,
    out,
    partial: `${out}.${process.pid}.partial`,
    crop,
    width,
    height,
    fps,
    frameCount,
    annotations: annotationsFor(manifest, {
      ink: !values["no-ink"],
      clicks: !values["no-clicks"],
    }),
    views: values.zoom ? cameraPath(manifest, crop, offset, frameCount, fps) : null,
  });
  return [
    out,
    `${width}×${height} @ ${fps} fps`,
    shortClock(result.seconds * 1000),
    `${(result.bytes / 1_048_576).toFixed(1)} MB`,
    result.audio === null ? "no audio" : `${result.audio} audio`,
    ...(values.zoom ? ["auto-zoom"] : []),
  ].join(" · ");
};

const finish = (text: string, code: number) => {
  (code === 0 ? process.stdout : process.stderr).write(`${text}\n`, () => Electron.app.exit(code));
};

const main = async () => {
  const args = process.argv.slice(process.argv.indexOf(SCRAWL_CLI_FLAG) + 1);
  const [command, ...rest] = args;
  if (command === undefined || command === "help" || args.includes("--help")) {
    return USAGE;
  }
  if (command === "inspect") return runInspect(rest);
  if (command !== "zoom" && command !== "frames" && command !== "export") {
    throw new UsageError(`Unknown command “${command}”.`);
  }
  // Chromium writes its own logs to the same stderr an agent reads the error from.
  Electron.app.commandLine.appendSwitch("log-level", "3");
  Electron.app.commandLine.appendSwitch("disk-cache-size", "1");
  // The running app holds its own profile, and two agents may run this at once.
  const profile = makeProfile();
  Electron.app.setPath("userData", profile);
  Electron.ipcMain.on(SCRAWL_RENDER_PROGRESS_CHANNEL, (_event, percent: number) => {
    process.stderr.write(`Exporting ${percent}%\n`);
  });
  const render = await openRenderer(profile);
  if (command === "zoom") return runZoom(render, rest);
  return command === "frames" ? runFrames(render, rest) : runExport(render, rest);
};

// A hidden window keeps the app alive, so nothing may leave this with the process still running.
process.on("uncaughtException", (cause) => finish(cause.stack ?? String(cause), 1));
process.on("unhandledRejection", (cause) => finish(String(cause), 1));
main().then(
  (text) => finish(text, 0),
  (cause: unknown) => {
    if (
      cause instanceof UsageError ||
      (cause as { code?: string }).code?.startsWith("ERR_PARSE_ARGS")
    ) {
      finish(`${(cause as Error).message}\n\n${USAGE}`, 2);
    } else {
      finish(cause instanceof Error ? cause.message : String(cause), 1);
    }
  },
);
