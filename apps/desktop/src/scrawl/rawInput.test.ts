import { describe, expect, it } from "vite-plus/test";

import { chordLabel, parseRawInput } from "./rawInput.ts";

const block = (type: number, device: bigint, fill: (body: Buffer) => void, bodyBytes: number) => {
  const buffer = Buffer.alloc(24 + bodyBytes);
  buffer.writeUInt32LE(type, 0);
  buffer.writeUInt32LE(buffer.length, 4);
  buffer.writeBigUInt64LE(device, 8);
  fill(buffer.subarray(24));
  return buffer;
};
const mouse = (flags: number, data: number) =>
  block(
    0,
    1n,
    (body) => {
      body.writeUInt16LE(flags, 4);
      body.writeInt16LE(data, 6);
    },
    24,
  );
const key = (virtualKey: number, flags: number, device = 1n) =>
  block(
    1,
    device,
    (body) => {
      body.writeUInt16LE(flags, 2);
      body.writeUInt16LE(virtualKey, 6);
    },
    16,
  );
// Blocks start on 8-byte boundaries; a real keyboard block is exactly 40 bytes, a mouse one 48.
const unaligned = (...blocks: Array<Buffer>) =>
  Buffer.concat(
    blocks.flatMap((part) => [part, Buffer.alloc(((part.length + 7) & ~7) - part.length)]),
  );

describe("parseRawInput", () => {
  it("keeps the wheel and keys, in order, and drops moves and injected keys", () => {
    const buffer = unaligned(
      mouse(0, 0),
      mouse(0x0400, 120),
      mouse(0x0400, -240),
      mouse(0x0800, 120),
      key(0x43, 0),
      key(0x43, 1),
      key(0x56, 0, 0n),
    );
    expect(parseRawInput(buffer, 7)).toEqual([
      { kind: "wheel", dx: 0, dy: 1 },
      { kind: "wheel", dx: 0, dy: -2 },
      { kind: "wheel", dx: 1, dy: 0 },
      { kind: "key", virtualKey: 0x43, down: true },
      { kind: "key", virtualKey: 0x43, down: false },
    ]);
  });

  it("stops at a block it cannot read instead of walking on through garbage", () => {
    expect(parseRawInput(Buffer.alloc(96), 3)).toEqual([]);
  });
});

describe("chordLabel", () => {
  const held = { ctrl: false, win: false, alt: false, shift: false, rightAlt: false };

  it.each([
    ["typing", 0x41, held, null],
    ["a capital", 0x41, { ...held, shift: true }, null],
    ["Alt alone", 0x46, { ...held, alt: true }, null],
    [
      "AltGr, typing @ on a German keyboard",
      0x51,
      { ...held, ctrl: true, alt: true, rightAlt: true },
      null,
    ],
    ["a key not worth logging", 0xbe, { ...held, ctrl: true }, null],
    ["Ctrl+C", 0x43, { ...held, ctrl: true }, "Ctrl+C"],
    ["Ctrl+Shift+Enter", 0x0d, { ...held, ctrl: true, shift: true }, "Ctrl+Shift+Enter"],
    ["the left Ctrl+Alt", 0x54, { ...held, ctrl: true, alt: true }, "Ctrl+Alt+T"],
    ["Win+F5", 0x74, { ...held, win: true }, "Win+F5"],
  ])("%s", (_name, virtualKey, modifiers, expected) => {
    expect(chordLabel(virtualKey, modifiers)).toBe(expected);
  });
});
