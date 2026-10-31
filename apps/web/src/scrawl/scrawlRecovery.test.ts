import { describe, expect, it } from "vite-plus/test";

import { rebuildClock } from "./scrawlRecovery";

describe("rebuildClock", () => {
  const timing = {
    micStartedAtMs: 1_200,
    videoStartedAtMs: 1_500,
    language: "en",
    sessionId: "session",
  };

  it("uses the journaled start of each clock", () => {
    expect(rebuildClock({ startedAtMs: 1_000, timing, pcmBytes: 32_000, videoMs: 900 })).toEqual({
      videoOffsetMs: 300,
      inputOffsetMs: 200,
      durationMs: 1_200,
    });
  });

  it("estimates the offset without a journal, and never by more than a second", () => {
    expect(
      rebuildClock({ startedAtMs: 1_000, timing: null, pcmBytes: 99_200, videoMs: 3_000 }),
    ).toEqual({ videoOffsetMs: 100, inputOffsetMs: 0, durationMs: 3_100 });
    expect(
      rebuildClock({ startedAtMs: 1_000, timing: null, pcmBytes: 320_000, videoMs: 3_000 }),
    ).toMatchObject({ videoOffsetMs: 1_000, durationMs: 10_000 });
  });

  it("takes its length from the video when the app died before any audio reached the disk", () => {
    expect(rebuildClock({ startedAtMs: 1_000, timing, pcmBytes: 0, videoMs: 4_000 })).toMatchObject(
      { durationMs: 4_300 },
    );
  });
});
