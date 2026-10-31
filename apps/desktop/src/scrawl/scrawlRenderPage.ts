// @effect-diagnostics nodeBuiltinImport:off -- Runs in a hidden Chromium page with direct file access, outside any Effect runtime.
// The one place that touches pixels for `t3-scrawl`. Chromium is the only codec in the app, so this
// runs in a hidden page: mediabunny drives WebCodecs for decoding, encoding and the mp4 container.

import { ipcRenderer } from "electron";
import {
  ALL_FORMATS,
  AudioBufferSource,
  CanvasSource,
  CustomSource,
  Input,
  Mp4OutputFormat,
  Output,
  QUALITY_HIGH,
  StreamTarget,
  VideoSampleSink,
  canEncodeAudio,
  canEncodeVideo,
  type InputVideoTrack,
} from "mediabunny";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";

import {
  SCRAWL_RENDER_PROGRESS_CHANNEL,
  type Annotations,
  type ExportJob,
  type ExportResult,
  type FramesJob,
  type ProbeJob,
  type ProbeResult,
  type RenderJob,
  type RenderRect,
  type SheetJob,
} from "./scrawlRenderJob.ts";

const SHEET_PAD = 12;
const SHEET_GAP = 10;
const LANDSCAPE_CELL = 480;
const LANDSCAPE_COLUMNS = 3;
const PORTRAIT_CELL = 300;
const PORTRAIT_COLUMNS = 4;
const INK_COLOR = "#ff2d2d";
const RING_COLOR = "rgba(239, 68, 68, 0.85)";
const CLICK_RING_MS = 600;
const AUDIO_RATE = 48_000;
const AUDIO_CHUNK_SECONDS = 1;

const openVideo = async (path: string) => {
  const file = await NodeFSP.open(path, "r");
  const { size } = await file.stat();
  const input = new Input({
    formats: ALL_FORMATS,
    source: new CustomSource({
      getSize: () => size,
      read: async (start, end) => {
        const bytes = new Uint8Array(end - start);
        await file.read(bytes, 0, bytes.length, start);
        return bytes;
      },
      prefetchProfile: "fileSystem",
    }),
  });
  const close = async () => {
    input.dispose();
    await file.close();
  };
  try {
    const track = await input.getPrimaryVideoTrack();
    if (track === null) throw new Error("The recording has no video track");
    if (!(await track.canDecode())) {
      throw new Error(`This app cannot decode the recording's ${track.codec ?? "unknown"} video`);
    }
    return { input, track, close };
  } catch (cause) {
    await close();
    throw cause;
  }
};

/** Times on the video's clock; a sink returns nothing for a time before the first frame. */
const videoSeconds = async (track: InputVideoTrack, bundleMs: number, offsetMs: number) =>
  Math.max(await track.getFirstTimestamp(), (bundleMs - offsetMs) / 1000);

const writePng = async (canvas: HTMLCanvasElement, path: string) => {
  const blob = await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (result) => (result ? resolve(result) : reject(new Error("A frame cannot be encoded."))),
      "image/png",
    );
  });
  await NodeFSP.writeFile(path, new Uint8Array(await blob.arrayBuffer()));
};

const makeCanvas = (width: number, height: number) => {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d", { alpha: false, willReadFrequently: true });
  if (context === null) throw new Error("No canvas to draw on.");
  context.imageSmoothingQuality = "high";
  return { canvas, context };
};

/** Paints what the video does not hold, under a transform from capture fractions to the canvas. */
const drawAnnotations = (
  context: CanvasRenderingContext2D,
  annotations: Annotations,
  bundleMs: number,
  view: RenderRect,
  target: {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
  },
) => {
  const scaleX = target.width / (view[2] - view[0]);
  const scaleY = target.height / (view[3] - view[1]);
  const toX = (x: number) => target.x + (x - view[0]) * scaleX;
  const toY = (y: number) => target.y + (y - view[1]) * scaleY;
  context.save();
  context.beginPath();
  context.rect(target.x, target.y, target.width, target.height);
  context.clip();
  context.lineCap = "round";
  context.lineJoin = "round";
  const unit = Math.max(1.5, target.width / 480);
  context.strokeStyle = INK_COLOR;
  context.lineWidth = unit * 2;
  for (const stroke of annotations.strokes) {
    if (bundleMs < stroke.fromMs || bundleMs > stroke.untilMs) continue;
    context.beginPath();
    for (let index = 0; index + 2 < stroke.points.length; index += 3) {
      if (!stroke.whole && stroke.fromMs + stroke.points[index + 2]! > bundleMs) break;
      const x = toX(stroke.points[index]! / 10_000);
      const y = toY(stroke.points[index + 1]! / 10_000);
      if (index === 0) context.moveTo(x, y);
      else context.lineTo(x, y);
    }
    context.stroke();
  }
  context.strokeStyle = RING_COLOR;
  context.lineWidth = unit;
  for (const click of annotations.clicks) {
    const age = bundleMs - click.t;
    if (age < 0 || age > CLICK_RING_MS) continue;
    context.beginPath();
    context.arc(toX(click.x), toY(click.y), unit * (4 + (age / CLICK_RING_MS) * 5), 0, Math.PI * 2);
    context.stroke();
  }
  context.restore();
};

const drawCellLabels = (
  context: CanvasRenderingContext2D,
  label: string,
  number: number,
  cell: { readonly x: number; readonly y: number; readonly height: number },
) => {
  context.save();
  context.font = "600 13px system-ui";
  context.textBaseline = "middle";
  const pillWidth = context.measureText(label).width + 14;
  const pillY = cell.y + cell.height - 28;
  context.fillStyle = "rgba(18, 18, 20, 0.85)";
  context.beginPath();
  context.roundRect(cell.x + 6, pillY, pillWidth, 22, 11);
  context.fill();
  context.fillStyle = "#ffffff";
  context.textAlign = "left";
  context.fillText(label, cell.x + 13, pillY + 12);
  // The white square keeps a number readable as a number, as on the contact sheet.
  context.strokeStyle = "#111111";
  context.lineWidth = 2;
  context.beginPath();
  context.roundRect(cell.x + 5, cell.y + 5, 24, 24, 4);
  context.fill();
  context.stroke();
  context.fillStyle = "#000000";
  context.font = "700 15px system-ui";
  context.textAlign = "center";
  context.fillText(String(number), cell.x + 17, cell.y + 18);
  context.restore();
};

const renderSheet = async (job: SheetJob) => {
  const video = await openVideo(job.video);
  try {
    const sourceWidth = video.track.displayWidth;
    const sourceHeight = video.track.displayHeight;
    const aspects = job.cells.map(({ view }) => {
      const width = (view[2] - view[0]) * sourceWidth;
      const height = (view[3] - view[1]) * sourceHeight;
      return { width, height };
    });
    const portrait = aspects.every(({ width, height }) => height > width);
    const cellWidth = portrait ? PORTRAIT_CELL : LANDSCAPE_CELL;
    const columns = Math.min(job.cells.length, portrait ? PORTRAIT_COLUMNS : LANDSCAPE_COLUMNS);
    const heights = aspects.map(({ width, height }) => (cellWidth * height) / width);
    const rows: Array<number> = [];
    for (let index = 0; index < heights.length; index += columns) {
      rows.push(Math.max(...heights.slice(index, index + columns)));
    }
    const { canvas, context } = makeCanvas(
      Math.ceil(SHEET_PAD * 2 + cellWidth * columns + SHEET_GAP * (columns - 1)),
      Math.ceil(
        SHEET_PAD * 2 +
          rows.reduce((total, row) => total + row, 0) +
          SHEET_GAP * Math.max(rows.length - 1, 0),
      ),
    );
    context.fillStyle = "#141414";
    context.fillRect(0, 0, canvas.width, canvas.height);
    const sink = new VideoSampleSink(video.track);
    const times = await Promise.all(
      job.cells.map(({ t }) => videoSeconds(video.track, t, job.videoOffsetMs)),
    );
    let index = 0;
    for await (const sample of sink.samplesAtTimestamps(times)) {
      const cell = job.cells[index]!;
      const column = index % columns;
      const row = Math.floor(index / columns);
      const x = SHEET_PAD + column * (cellWidth + SHEET_GAP);
      const y =
        SHEET_PAD + rows.slice(0, row).reduce((total, height) => total + height + SHEET_GAP, 0);
      const height = heights[index]!;
      if (sample !== null) {
        sample.draw(
          context,
          cell.view[0] * sourceWidth,
          cell.view[1] * sourceHeight,
          aspects[index]!.width,
          aspects[index]!.height,
          x,
          y,
          cellWidth,
          height,
        );
        sample.close();
      }
      drawAnnotations(context, job.annotations, cell.t, cell.view, {
        x,
        y,
        width: cellWidth,
        height,
      });
      drawCellLabels(context, cell.label, index + 1, { x, y, height });
      index++;
    }
    await writePng(canvas, job.out);
  } finally {
    await video.close();
  }
};

const renderFrames = async (job: FramesJob) => {
  const video = await openVideo(job.video);
  try {
    const { canvas, context } = makeCanvas(video.track.displayWidth, video.track.displayHeight);
    const sink = new VideoSampleSink(video.track);
    const times = await Promise.all(
      job.frames.map(({ t }) => videoSeconds(video.track, t, job.videoOffsetMs)),
    );
    let index = 0;
    for await (const sample of sink.samplesAtTimestamps(times)) {
      if (sample !== null) {
        sample.draw(context, 0, 0, canvas.width, canvas.height);
        sample.close();
        await writePng(canvas, job.frames[index]!.out);
      }
      index++;
    }
  } finally {
    await video.close();
  }
};

const probe = async (job: ProbeJob): Promise<ProbeResult> => {
  const video = await openVideo(job.video);
  try {
    const first = await video.track.getFirstTimestamp();
    const stats = await video.track.computePacketStats(100);
    return {
      width: video.track.displayWidth,
      height: video.track.displayHeight,
      seconds: (await video.track.computeDuration()) - first,
      packetRate: stats.averagePacketRate,
    };
  } finally {
    await video.close();
  }
};

/** Resampled to what AAC encoders take: the recording's audio is 16 kHz for the dictation model. */
const readAudio = async (path: string, skipSeconds: number, seconds: number) => {
  const decoder = new OfflineAudioContext(1, AUDIO_RATE, AUDIO_RATE);
  const wav = await NodeFSP.readFile(path);
  // A silent capture has a WAV with nothing in it, which is no reason to fail the video.
  const decoded = await decoder
    .decodeAudioData(
      wav.buffer.slice(wav.byteOffset, wav.byteOffset + wav.byteLength) as ArrayBuffer,
    )
    .catch(() => null);
  if (decoded === null) return null;
  const samples = decoded.getChannelData(0);
  const first = Math.round(skipSeconds * decoded.sampleRate);
  const count = Math.min(samples.length - first, Math.ceil(seconds * decoded.sampleRate));
  return count > 0 ? samples.subarray(first, first + count) : null;
};

const audioCodecFor = async () => {
  const options = { numberOfChannels: 1, sampleRate: AUDIO_RATE, bitrate: QUALITY_HIGH };
  if (await canEncodeAudio("aac", options)) return "aac" as const;
  return (await canEncodeAudio("opus", options)) ? ("opus" as const) : null;
};

const renderExport = async (job: ExportJob): Promise<ExportResult> => {
  const video = await openVideo(job.video);
  const out = await NodeFSP.open(job.partial, "w");
  try {
    if (!(await canEncodeVideo("avc", { width: job.width, height: job.height }))) {
      throw new Error("This app has no H.264 encoder on this machine.");
    }
    const first = await video.track.getFirstTimestamp();
    const { frameCount } = job;
    const views = job.views ?? [job.crop];
    const output = new Output({
      format: new Mp4OutputFormat(),
      target: new StreamTarget(
        new WritableStream({
          write: async (chunk: { data: Uint8Array; position: number }) => {
            await out.write(chunk.data, 0, chunk.data.length, chunk.position);
          },
        }),
      ),
    });
    const { canvas, context } = makeCanvas(job.width, job.height);
    const videoSource = new CanvasSource(canvas, {
      codec: "avc",
      bitrate: QUALITY_HIGH,
      keyFrameInterval: 2,
    });
    output.addVideoTrack(videoSource, { frameRate: job.fps });

    const pcm =
      job.audio === null
        ? null
        : await readAudio(job.audio, job.videoOffsetMs / 1000, frameCount / job.fps);
    const audioCodec = pcm === null ? null : await audioCodecFor();
    const audioSource =
      audioCodec === null ? null : new AudioBufferSource({ codec: audioCodec, bitrate: 128_000 });
    if (audioSource !== null) output.addAudioTrack(audioSource);
    await output.start();

    let audioAt = 0;
    const addAudioUntil = async (seconds: number) => {
      if (pcm === null || audioSource === null) return;
      const until = Math.min(pcm.length, Math.ceil(seconds * AUDIO_RATE));
      if (until <= audioAt) return;
      const chunk = new AudioBuffer({
        length: until - audioAt,
        numberOfChannels: 1,
        sampleRate: AUDIO_RATE,
      });
      chunk.copyToChannel(pcm.subarray(audioAt, until) as Float32Array<ArrayBuffer>, 0);
      audioAt = until;
      await audioSource.add(chunk);
    };

    const sink = new VideoSampleSink(video.track);
    const times = Array.from({ length: frameCount }, (_unused, index) => first + index / job.fps);
    const sourceWidth = video.track.displayWidth;
    const sourceHeight = video.track.displayHeight;
    let index = 0;
    let lastProgress = 0;
    for await (const sample of sink.samplesAtTimestamps(times)) {
      const view = views[Math.min(index, views.length - 1)]!;
      const seconds = index / job.fps;
      if (sample !== null) {
        sample.draw(
          context,
          view[0] * sourceWidth,
          view[1] * sourceHeight,
          (view[2] - view[0]) * sourceWidth,
          (view[3] - view[1]) * sourceHeight,
          0,
          0,
          job.width,
          job.height,
        );
        sample.close();
      }
      drawAnnotations(context, job.annotations, job.videoOffsetMs + seconds * 1000, view, {
        x: 0,
        y: 0,
        width: job.width,
        height: job.height,
      });
      await addAudioUntil(seconds + AUDIO_CHUNK_SECONDS);
      await videoSource.add(seconds, 1 / job.fps);
      index++;
      const progress = Math.floor((index / frameCount) * 10);
      if (progress > lastProgress) {
        lastProgress = progress;
        ipcRenderer.send(SCRAWL_RENDER_PROGRESS_CHANNEL, progress * 10);
      }
    }
    await addAudioUntil(Number.POSITIVE_INFINITY);
    await output.finalize();
    await out.close();
    await NodeFSP.rename(job.partial, job.out);
    return {
      frames: index,
      seconds: frameCount / job.fps,
      audio: audioCodec,
      bytes: NodeFS.statSync(job.out).size,
    };
  } catch (cause) {
    await out.close().catch(() => undefined);
    await NodeFSP.rm(job.partial, { force: true }).catch(() => undefined);
    throw cause;
  } finally {
    await video.close();
  }
};

/** @public Called by name from the hidden page. */
export const run = async (job: RenderJob): Promise<ProbeResult | ExportResult | null> => {
  if (job.kind === "probe") return probe(job);
  if (job.kind === "sheet") {
    await renderSheet(job);
    return null;
  }
  if (job.kind === "frames") {
    await renderFrames(job);
    return null;
  }
  return renderExport(job);
};
