// @effect-diagnostics globalTimers:off -- A plain Node child; the poll runs outside any Effect fiber.
// @effect-diagnostics globalDate:off -- Times share the wall clock with the capture.
// Watches what the desktop does during a capture, Windows only, in a process of its own: a failed
// native call here cannot take the recording with it, and the app's main thread never does this.
//
// The wheel cannot be polled, and a low-level hook would make every mouse move in every program
// wait on this process. Raw Input delivers to one hidden window and nobody waits for it. Messages
// queue until the timer reads them in one call, however fast the mouse reports.

import { DataType, load, open } from "ffi-rs";

import { chordLabel, parseRawInput } from "./rawInput.ts";
import { AppSwitchWatcher, filterWindows, type PixelRect, type RawWindow } from "./windowList.ts";

export interface ScrawlContextInit {
  readonly frame: PixelRect;
  readonly dock: PixelRect | null;
  /** Ink and pill: they are the capture's own, not something on screen. */
  readonly ignoredWindowIds: ReadonlyArray<number>;
}

export type ScrawlContextRequest =
  | ({ readonly type: "init" } & ScrawlContextInit)
  | { readonly type: "snapshot" }
  | { readonly type: "stop" };

export type ScrawlContextMessage =
  | { readonly type: "ready" }
  | { readonly type: "wheel"; readonly at: number; readonly dx: number; readonly dy: number }
  | { readonly type: "chord"; readonly at: number; readonly shortcut: string }
  | { readonly type: "app"; readonly at: number; readonly app: string }
  | {
      readonly type: "windows";
      readonly at: number;
      readonly windows: ReturnType<typeof filterWindows>;
    }
  | { readonly type: "stopped" };

const READ_MS = 25;
const LOOK_EVERY_READS = 3;
// Scrawl's window log: a look at most this often while the hand moves, and now and then anyway.
const MOVING_SNAPSHOT_MS = 500;
const IDLE_SNAPSHOT_MS = 2_000;
const MAX_WINDOWS = 4_096;

const USER = "scrawl-user32";
const KERNEL = "scrawl-kernel32";
const DWM = "scrawl-dwmapi";
const VERSION = "scrawl-version";

const PER_MONITOR_AWARE_V2 = -4n;
const HWND_MESSAGE = -3n;
const RIDEV_INPUTSINK = 0x100;
const HEADER_BYTES = 24;
const GW_HWNDNEXT = 2;
const GWL_STYLE = -16;
const GWL_EXSTYLE = -20;
const GW_OWNER = 4;
const GA_ROOTOWNER = 3;
const WS_CHILD = 0x40000000;
const DWMWA_EXTENDED_FRAME_BOUNDS = 9;
const DWMWA_CLOAKED = 14;
const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;

const VK_SHIFT = 0x10;
const VK_CONTROL = 0x11;
const VK_MENU = 0x12;
const VK_LWIN = 0x5b;
const VK_RWIN = 0x5c;
const VK_RMENU = 0xa5;

const wide = (text: string) => Buffer.from(`${text}\0`, "utf16le");
const fromWide = (buffer: Buffer, chars: number) =>
  buffer.subarray(0, chars * 2).toString("utf16le");

const user = <T>(
  funcName: string,
  retType: DataType,
  paramsType: Array<DataType>,
  paramsValue: Array<unknown>,
) => load({ library: USER, funcName, retType, paramsType, paramsValue }) as T;

const isDown = (virtualKey: number) =>
  (user<number>("GetAsyncKeyState", DataType.I16, [DataType.I32], [virtualKey]) & 0x8000) !== 0;

const nextWindow = (handle: bigint) =>
  handle === 0n
    ? user<bigint>("GetTopWindow", DataType.BigInt, [DataType.BigInt], [0n])
    : user<bigint>(
        "GetWindow",
        DataType.BigInt,
        [DataType.BigInt, DataType.U32],
        [handle, GW_HWNDNEXT],
      );

const windowLong = (handle: bigint, index: number) =>
  Number(
    user<bigint>(
      "GetWindowLongPtrW",
      DataType.BigInt,
      [DataType.BigInt, DataType.I32],
      [handle, index],
    ) & 0xffff_ffffn,
  );

const processOf = (handle: bigint) => {
  const out = Buffer.alloc(4);
  user<number>(
    "GetWindowThreadProcessId",
    DataType.U32,
    [DataType.BigInt, DataType.U8Array],
    [handle, out],
  );
  return out.readUInt32LE(0);
};

const classOf = (handle: bigint) => {
  const buffer = Buffer.alloc(512);
  const chars = user<number>(
    "GetClassNameW",
    DataType.I32,
    [DataType.BigInt, DataType.U8Array, DataType.I32],
    [handle, buffer, 256],
  );
  return chars > 0 ? fromWide(buffer, chars) : "";
};

const titleOf = (handle: bigint) => {
  const buffer = Buffer.alloc(2048);
  const chars = user<number>(
    "GetWindowTextW",
    DataType.I32,
    [DataType.BigInt, DataType.U8Array, DataType.I32],
    [handle, buffer, 1024],
  );
  return chars > 0 ? fromWide(buffer, chars) : "";
};

const dwmAttribute = (handle: bigint, attribute: number, out: Buffer) =>
  load({
    library: DWM,
    funcName: "DwmGetWindowAttribute",
    retType: DataType.I32,
    paramsType: [DataType.BigInt, DataType.U32, DataType.U8Array, DataType.U32],
    paramsValue: [handle, attribute, out, out.byteLength],
  }) === 0;

const readMemory = (address: bigint, bytes: number) => {
  const out = Buffer.alloc(bytes);
  load({
    library: KERNEL,
    funcName: "RtlMoveMemory",
    retType: DataType.Void,
    paramsType: [DataType.U8Array, DataType.BigInt, DataType.U64],
    paramsValue: [out, address, bytes],
  });
  return out;
};

const processPath = (processId: number) => {
  const handle = load({
    library: KERNEL,
    funcName: "OpenProcess",
    retType: DataType.BigInt,
    paramsType: [DataType.U32, DataType.Boolean, DataType.U32],
    paramsValue: [PROCESS_QUERY_LIMITED_INFORMATION, false, processId],
  }) as bigint;
  if (handle === 0n) return "";
  const buffer = Buffer.alloc(2 * 32_768);
  const size = Buffer.alloc(4);
  size.writeUInt32LE(32_768, 0);
  const ok = load({
    library: KERNEL,
    funcName: "QueryFullProcessImageNameW",
    retType: DataType.Boolean,
    paramsType: [DataType.BigInt, DataType.U32, DataType.U8Array, DataType.U8Array],
    paramsValue: [handle, 0, buffer, size],
  });
  load({
    library: KERNEL,
    funcName: "CloseHandle",
    retType: DataType.Boolean,
    paramsType: [DataType.BigInt],
    paramsValue: [handle],
  });
  return ok ? fromWide(buffer, size.readUInt32LE(0)) : "";
};

/** A pointer into the version block that VerQueryValueW found, with its length in `unit`s. */
const versionValue = (block: Buffer, query: string, unit: number) => {
  const address = Buffer.alloc(8);
  const length = Buffer.alloc(4);
  const found = load({
    library: VERSION,
    funcName: "VerQueryValueW",
    retType: DataType.Boolean,
    paramsType: [DataType.U8Array, DataType.U8Array, DataType.U8Array, DataType.U8Array],
    paramsValue: [block, wide(query), address, length],
  });
  const pointer = address.readBigUInt64LE(0);
  const size = length.readUInt32LE(0);
  return found && pointer !== 0n && size > 0 ? readMemory(pointer, size * unit) : null;
};

/** The name people know an app by: its FileDescription, such as "Visual Studio Code". */
const fileDescription = (path: string) => {
  const name = wide(path);
  const size = load({
    library: VERSION,
    funcName: "GetFileVersionInfoSizeW",
    retType: DataType.U32,
    paramsType: [DataType.U8Array, DataType.BigInt],
    paramsValue: [name, 0n],
  }) as number;
  if (size === 0) return "";
  const block = Buffer.alloc(size);
  const read = load({
    library: VERSION,
    funcName: "GetFileVersionInfoW",
    retType: DataType.Boolean,
    paramsType: [DataType.U8Array, DataType.U32, DataType.U32, DataType.U8Array],
    paramsValue: [name, 0, size, block],
  });
  if (!read) return "";
  const translation = versionValue(block, "\\VarFileInfo\\Translation", 1);
  const language = translation === null ? 0x0409 : translation.readUInt16LE(0);
  const codePage = translation === null ? 0x04b0 : translation.readUInt16LE(2);
  const hex = (value: number) => value.toString(16).padStart(4, "0");
  const value = versionValue(
    block,
    `\\StringFileInfo\\${hex(language)}${hex(codePage)}\\FileDescription`,
    2,
  );
  return value === null ? "" : value.toString("utf16le").replace(/\0.*$/su, "").trim();
};

const identities = new Map<number, { readonly app: string; readonly bundleId: string }>();
const identityOf = (processId: number) => {
  const known = identities.get(processId);
  if (known !== undefined) return known;
  const path = processPath(processId);
  const exe = path.split("\\").at(-1) ?? "";
  const identity = {
    app: (path === "" ? "" : fileDescription(path)) || exe.replace(/\.exe$/iu, ""),
    bundleId: exe.toLowerCase(),
  };
  identities.set(processId, identity);
  return identity;
};

const readWindows = (): Array<RawWindow> => {
  const windows: Array<RawWindow> = [];
  const rect = Buffer.alloc(16);
  const cloaked = Buffer.alloc(4);
  let handle = nextWindow(0n);
  for (let seen = 0; handle !== 0n && seen < MAX_WINDOWS; seen++) {
    const visible = user<boolean>("IsWindowVisible", DataType.Boolean, [DataType.BigInt], [handle]);
    if (visible && (windowLong(handle, GWL_STYLE) & WS_CHILD) === 0) {
      const processId = processOf(handle);
      const framed = dwmAttribute(handle, DWMWA_EXTENDED_FRAME_BOUNDS, rect);
      cloaked.writeUInt32LE(0, 0);
      dwmAttribute(handle, DWMWA_CLOAKED, cloaked);
      const left = rect.readInt32LE(0);
      const top = rect.readInt32LE(4);
      windows.push({
        id: Number(handle & 0xffff_ffffn),
        processId,
        ...identityOf(processId),
        title: titleOf(handle),
        className: classOf(handle),
        rect: framed
          ? {
              x: left,
              y: top,
              width: rect.readInt32LE(8) - left,
              height: rect.readInt32LE(12) - top,
            }
          : { x: 0, y: 0, width: 0, height: 0 },
        exStyle: windowLong(handle, GWL_EXSTYLE),
        owned:
          user<bigint>(
            "GetWindow",
            DataType.BigInt,
            [DataType.BigInt, DataType.U32],
            [handle, GW_OWNER],
          ) !== 0n,
        minimized: user<boolean>("IsIconic", DataType.Boolean, [DataType.BigInt], [handle]),
        cloaked: cloaked.readUInt32LE(0) !== 0,
      });
    }
    handle = nextWindow(handle);
  }
  return windows;
};

const frontWindow = () => {
  const front = user<bigint>("GetForegroundWindow", DataType.BigInt, [], []);
  if (front === 0n) return null;
  const root = user<bigint>(
    "GetAncestor",
    DataType.BigInt,
    [DataType.BigInt, DataType.U32],
    [front, GA_ROOTOWNER],
  );
  const handle = root === 0n ? front : root;
  const processId = processOf(handle);
  return { processId, app: identityOf(processId).app, className: classOf(handle) };
};

const cursorNow = () => {
  const out = Buffer.alloc(8);
  return user<boolean>("GetCursorPos", DataType.Boolean, [DataType.U8Array], [out])
    ? out.readBigInt64LE(0)
    : 0n;
};

const startRawInput = () => {
  const window = user<bigint>(
    "CreateWindowExW",
    DataType.BigInt,
    [
      DataType.U32,
      DataType.U8Array,
      DataType.U8Array,
      DataType.U32,
      DataType.I32,
      DataType.I32,
      DataType.I32,
      DataType.I32,
      DataType.BigInt,
      DataType.BigInt,
      DataType.BigInt,
      DataType.BigInt,
    ],
    [0, wide("Message"), wide(""), 0, 0, 0, 0, 0, HWND_MESSAGE, 0n, 0n, 0n],
  );
  if (window === 0n) throw new Error("No window for raw input.");
  const devices = Buffer.alloc(32);
  // Generic desktop page: usage 2 is the mouse, 6 the keyboard.
  for (const [index, usage] of [2, 6].entries()) {
    devices.writeUInt16LE(1, index * 16);
    devices.writeUInt16LE(usage, index * 16 + 2);
    devices.writeUInt32LE(RIDEV_INPUTSINK, index * 16 + 4);
    devices.writeBigUInt64LE(window, index * 16 + 8);
  }
  const registered = user<boolean>(
    "RegisterRawInputDevices",
    DataType.Boolean,
    [DataType.U8Array, DataType.U32, DataType.U32],
    [devices, 2, 16],
  );
  if (!registered) throw new Error("Raw input was refused.");
};

const send = (message: ScrawlContextMessage) => process.send?.(message);

const run = (init: ScrawlContextInit) => {
  startRawInput();
  const buffer = Buffer.alloc(64 * 1024);
  const size = Buffer.alloc(4);
  const keysDown = new Set<number>();
  const ignored = new Set(init.ignoredWindowIds);
  const switches = new AppSwitchWatcher();
  let reads = 0;
  let wanted = true;
  let lastSnapshot = 0;
  let lastCursor = 0n;
  let cursorAtSnapshot = 0n;
  let lastFrontProcess: number | null = null;

  const readInput = () => {
    size.writeUInt32LE(buffer.byteLength, 0);
    const count = user<number>(
      "GetRawInputBuffer",
      DataType.I32,
      [DataType.U8Array, DataType.U8Array, DataType.U32],
      [buffer, size, HEADER_BYTES],
    );
    if (count <= 0) return;
    const at = Date.now();
    for (const input of parseRawInput(buffer, count)) {
      if (input.kind === "wheel") {
        send({ type: "wheel", at, dx: input.dx, dy: input.dy });
      } else if (!input.down) {
        keysDown.delete(input.virtualKey);
      } else if (!keysDown.has(input.virtualKey)) {
        keysDown.add(input.virtualKey);
        // Asked of Windows, not tracked from the stream: a Ctrl whose release was lost to the lock
        // screen would otherwise turn all later typing into chords.
        const ctrl = isDown(VK_CONTROL);
        const win = isDown(VK_LWIN) || isDown(VK_RWIN);
        if (!ctrl && !win) continue;
        const shortcut = chordLabel(input.virtualKey, {
          ctrl,
          win,
          alt: isDown(VK_MENU),
          shift: isDown(VK_SHIFT),
          rightAlt: isDown(VK_RMENU),
        });
        if (shortcut !== null) {
          send({ type: "chord", at, shortcut });
          wanted = true;
        }
      }
    }
  };

  const look = () => {
    const at = Date.now();
    const front = frontWindow();
    const switched = switches.look(at, front);
    if (switched !== null) send({ type: "app", at: switched.t, app: switched.app });
    lastCursor = cursorNow();
    const since = at - lastSnapshot;
    const due =
      wanted ||
      (front?.processId ?? null) !== lastFrontProcess ||
      (lastCursor !== cursorAtSnapshot && since >= MOVING_SNAPSHOT_MS) ||
      since >= IDLE_SNAPSHOT_MS;
    if (!due) return;
    wanted = false;
    lastSnapshot = at;
    lastFrontProcess = front?.processId ?? null;
    cursorAtSnapshot = lastCursor;
    send({
      type: "windows",
      at,
      windows: filterWindows(
        readWindows(),
        init.frame,
        init.dock,
        front?.processId ?? null,
        ignored,
      ),
    });
  };

  const timer = setInterval(() => {
    readInput();
    if (++reads % LOOK_EVERY_READS === 0) look();
  }, READ_MS);
  look();
  send({ type: "ready" });

  process.on("message", (request: ScrawlContextRequest) => {
    if (request.type === "snapshot") wanted = true;
    if (request.type !== "stop") return;
    clearInterval(timer);
    readInput();
    send({ type: "stopped" });
    setImmediate(() => process.exit(0));
  });
};

const main = () => {
  process.once("disconnect", () => process.exit(0));
  open({ library: USER, path: "user32.dll" });
  open({ library: KERNEL, path: "kernel32.dll" });
  open({ library: DWM, path: "dwmapi.dll" });
  open({ library: VERSION, path: "version.dll" });
  user<boolean>(
    "SetProcessDpiAwarenessContext",
    DataType.Boolean,
    [DataType.BigInt],
    [PER_MONITOR_AWARE_V2],
  );
  process.once("message", (request: ScrawlContextRequest) => {
    if (request.type === "init") run(request);
  });
};

main();
