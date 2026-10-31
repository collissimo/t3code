// What the command side hands the hidden page: everything decided, only pixels left.

export const SCRAWL_RENDER_PROGRESS_CHANNEL = "scrawl-render-progress";

export type RenderRect = readonly [number, number, number, number];

export interface Annotations {
  readonly strokes: ReadonlyArray<{
    readonly fromMs: number;
    readonly untilMs: number;
    /** Drawn entire from `fromMs`, instead of growing along its own time. */
    readonly whole: boolean;
    /** Flat x, y, dt triples with positions in 0..=10000. */
    readonly points: ReadonlyArray<number>;
  }>;
  readonly clicks: ReadonlyArray<{
    readonly t: number;
    readonly x: number;
    readonly y: number;
  }>;
}

export interface SheetJob {
  readonly kind: "sheet";
  readonly video: string;
  readonly videoOffsetMs: number;
  readonly out: string;
  readonly annotations: Annotations;
  readonly cells: ReadonlyArray<{
    readonly t: number;
    readonly label: string;
    readonly view: RenderRect;
  }>;
}

export interface FramesJob {
  readonly kind: "frames";
  readonly video: string;
  readonly videoOffsetMs: number;
  readonly frames: ReadonlyArray<{ readonly t: number; readonly out: string }>;
}

export interface ExportJob {
  readonly kind: "export";
  readonly video: string;
  readonly videoOffsetMs: number;
  readonly audio: string | null;
  readonly out: string;
  /** Written here and renamed on success, so a failed run never leaves a broken mp4 behind. */
  readonly partial: string;
  readonly crop: RenderRect;
  readonly width: number;
  readonly height: number;
  readonly fps: number;
  readonly frameCount: number;
  readonly annotations: Annotations;
  /** A view per output frame when the camera moves. */
  readonly views: ReadonlyArray<RenderRect> | null;
}

export interface ProbeJob {
  readonly kind: "probe";
  readonly video: string;
}

export interface ProbeResult {
  readonly width: number;
  readonly height: number;
  readonly seconds: number;
  readonly packetRate: number;
}

export type RenderJob = ProbeJob | SheetJob | FramesJob | ExportJob;

export interface ExportResult {
  readonly frames: number;
  readonly seconds: number;
  readonly audio: "aac" | "opus" | null;
  readonly bytes: number;
}
