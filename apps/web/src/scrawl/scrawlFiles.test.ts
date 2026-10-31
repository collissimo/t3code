import { describe, expect, it } from "vite-plus/test";

import { readCaptureFile, type ScrawlFileReader } from "./scrawlFiles";

const readerOver = (file: Uint8Array): ScrawlFileReader => {
  return async ({ offset, length }) => file.subarray(offset, offset + length);
};

describe("readCaptureFile", () => {
  it.each([
    ["empty", 0],
    ["within one piece", 1_000],
    ["exactly one piece", 8 * 1024 * 1024],
    ["several pieces", 8 * 1024 * 1024 * 2 + 17],
  ])("returns the whole file in order: %s", async (_name, size) => {
    const file = new Uint8Array(size);
    for (let index = 0; index < size; index += 1) file[index] = index % 251;
    const blob = await readCaptureFile(
      readerOver(file),
      "scrawl-a-0",
      "recording.mp4",
      "video/mp4",
    );
    expect(blob.type).toBe("video/mp4");
    const read = Buffer.from(await blob.arrayBuffer());
    expect(read.equals(file)).toBe(true);
  });
});
