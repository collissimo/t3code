// Reads what GetRawInputBuffer hands back. Keys are reduced to chords right here, so ordinary typing
// never leaves this file.

const HEADER_BYTES = 24;
const TYPE_MOUSE = 0;
const TYPE_KEYBOARD = 1;
const WHEEL = 0x0400;
const HORIZONTAL_WHEEL = 0x0800;
const WHEEL_NOTCH = 120;
const KEY_BREAK = 1;

export type RawInput =
  | { readonly kind: "wheel"; readonly dx: number; readonly dy: number }
  | { readonly kind: "key"; readonly virtualKey: number; readonly down: boolean };

/** Mouse moves are most of what arrives and are dropped here. Injected keys carry no device. */
export function parseRawInput(buffer: Buffer, count: number): Array<RawInput> {
  const inputs: Array<RawInput> = [];
  let offset = 0;
  for (let index = 0; index < count && offset + HEADER_BYTES <= buffer.length; index++) {
    const type = buffer.readUInt32LE(offset);
    const size = buffer.readUInt32LE(offset + 4);
    if (size < HEADER_BYTES) break;
    const body = offset + HEADER_BYTES;
    if (type === TYPE_MOUSE) {
      const flags = buffer.readUInt16LE(body + 4);
      const delta = buffer.readInt16LE(body + 6) / WHEEL_NOTCH;
      if (flags & WHEEL) inputs.push({ kind: "wheel", dx: 0, dy: delta });
      else if (flags & HORIZONTAL_WHEEL) inputs.push({ kind: "wheel", dx: delta, dy: 0 });
    } else if (type === TYPE_KEYBOARD && buffer.readBigUInt64LE(offset + 8) !== 0n) {
      inputs.push({
        kind: "key",
        virtualKey: buffer.readUInt16LE(body + 6),
        down: (buffer.readUInt16LE(body + 2) & KEY_BREAK) === 0,
      });
    }
    offset += (size + 7) & ~7;
  }
  return inputs;
}

export interface HeldModifiers {
  readonly ctrl: boolean;
  readonly win: boolean;
  readonly alt: boolean;
  readonly shift: boolean;
  /** The right Alt. On many layouts it is AltGr, which Windows reports as Ctrl+Alt. */
  readonly rightAlt: boolean;
}

/** A key's name in a logged chord, for the keys worth logging. */
const chordKeyName = (virtualKey: number): string | null => {
  if ((virtualKey >= 0x30 && virtualKey <= 0x39) || (virtualKey >= 0x41 && virtualKey <= 0x5a)) {
    return String.fromCharCode(virtualKey);
  }
  if (virtualKey >= 0x70 && virtualKey <= 0x87) return `F${virtualKey - 0x6f}`;
  switch (virtualKey) {
    case 0x0d:
      return "Enter";
    case 0x09:
      return "Tab";
    case 0x20:
      return "Space";
    case 0x08:
      return "Backspace";
    case 0x2e:
      return "Delete";
    default:
      return null;
  }
};

/**
 * `Ctrl+Shift+C`, or null for anything that may be typing. AltGr is typing: on a German keyboard
 * AltGr+Q is an @, and logging it as Ctrl+Alt+Q would spell out part of a password.
 */
export function chordLabel(virtualKey: number, held: HeldModifiers): string | null {
  if (!held.ctrl && !held.win) return null;
  if (held.rightAlt && !held.win) return null;
  const key = chordKeyName(virtualKey);
  if (key === null) return null;
  return [
    held.ctrl ? "Ctrl" : null,
    held.win ? "Win" : null,
    held.alt ? "Alt" : null,
    held.shift ? "Shift" : null,
    key,
  ]
    .filter((part) => part !== null)
    .join("+");
}
