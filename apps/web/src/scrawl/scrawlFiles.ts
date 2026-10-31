// A capture's files stay on disk. A Blob made of Blobs is handed to the browser's blob store piece
// by piece, which pages to disk when large, so this keeps nothing in this process's heap.

import type { DesktopBridge } from "@t3tools/contracts";

const PIECE_BYTES = 8 * 1024 * 1024;

export type ScrawlFileReader = NonNullable<DesktopBridge["scrawlReadFile"]>;

export const readCaptureFile = async (
  read: ScrawlFileReader,
  id: string,
  path: string,
  type = "",
): Promise<Blob> => {
  const pieces: Array<Blob> = [];
  let offset = 0;
  for (;;) {
    const bytes = await read({ id, path, offset, length: PIECE_BYTES });
    if (bytes.length > 0) pieces.push(new Blob([bytes as Uint8Array<ArrayBuffer>]));
    offset += bytes.length;
    if (bytes.length < PIECE_BYTES) return new Blob(pieces, { type });
  }
};

/** A file the capture may not have got to write, such as audio from a muted recording. */
export const readOptionalCaptureFile = (read: ScrawlFileReader, id: string, path: string) =>
  readCaptureFile(read, id, path).catch(() => null);
