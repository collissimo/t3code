import {
  ScrawlAppendVideoInput,
  ScrawlCaptureRef,
  ScrawlCaptureSummary,
  ScrawlReadFileInput,
  ScrawlSetPinnedInput,
  ScrawlShortcutAvailability,
  ScrawlShortcutState,
  ScrawlStartResult,
  ScrawlStopResult,
  ScrawlUnfinished,
  ScrawlWriteFileInput,
  SnapShotKeyChord,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as DesktopScrawl from "../../scrawl/DesktopScrawl.ts";
import * as IpcChannels from "../channels.ts";
import { makeIpcMethod } from "../DesktopIpc.ts";

export const scrawlStart = makeIpcMethod({
  channel: IpcChannels.SCRAWL_START_CHANNEL,
  payload: Schema.Void,
  result: ScrawlStartResult,
  handler: Effect.fn("desktop.ipc.scrawl.start")(function* () {
    return yield* (yield* DesktopScrawl.DesktopScrawl).start();
  }),
});

export const scrawlStop = makeIpcMethod({
  channel: IpcChannels.SCRAWL_STOP_CHANNEL,
  payload: ScrawlCaptureRef,
  result: ScrawlStopResult,
  handler: Effect.fn("desktop.ipc.scrawl.stop")(function* (input) {
    return yield* (yield* DesktopScrawl.DesktopScrawl).stop(input);
  }),
});

export const scrawlCancel = makeIpcMethod({
  channel: IpcChannels.SCRAWL_CANCEL_CHANNEL,
  payload: ScrawlCaptureRef,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.scrawl.cancel")(function* (input) {
    yield* (yield* DesktopScrawl.DesktopScrawl).cancel(input);
  }),
});

export const scrawlAppendVideo = makeIpcMethod({
  channel: IpcChannels.SCRAWL_APPEND_VIDEO_CHANNEL,
  payload: ScrawlAppendVideoInput,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.scrawl.appendVideo")(function* (input) {
    yield* (yield* DesktopScrawl.DesktopScrawl).appendVideo(input);
  }),
});

export const scrawlWriteFile = makeIpcMethod({
  channel: IpcChannels.SCRAWL_WRITE_FILE_CHANNEL,
  payload: ScrawlWriteFileInput,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.scrawl.writeFile")(function* (input) {
    yield* (yield* DesktopScrawl.DesktopScrawl).writeFile(input);
  }),
});

export const scrawlReadFile = makeIpcMethod({
  channel: IpcChannels.SCRAWL_READ_FILE_CHANNEL,
  payload: ScrawlReadFileInput,
  result: Schema.Uint8Array,
  handler: Effect.fn("desktop.ipc.scrawl.readFile")(function* (input) {
    return yield* (yield* DesktopScrawl.DesktopScrawl).readFile(input);
  }),
});

export const scrawlListUnfinished = makeIpcMethod({
  channel: IpcChannels.SCRAWL_LIST_UNFINISHED_CHANNEL,
  payload: Schema.Void,
  result: Schema.Array(ScrawlUnfinished),
  handler: Effect.fn("desktop.ipc.scrawl.listUnfinished")(function* () {
    return yield* (yield* DesktopScrawl.DesktopScrawl).listUnfinished();
  }),
});

export const scrawlBeginRebuild = makeIpcMethod({
  channel: IpcChannels.SCRAWL_BEGIN_REBUILD_CHANNEL,
  payload: ScrawlCaptureRef,
  result: ScrawlUnfinished,
  handler: Effect.fn("desktop.ipc.scrawl.beginRebuild")(function* (input) {
    return yield* (yield* DesktopScrawl.DesktopScrawl).beginRebuild(input);
  }),
});

export const scrawlMarkBuilt = makeIpcMethod({
  channel: IpcChannels.SCRAWL_MARK_BUILT_CHANNEL,
  payload: ScrawlCaptureRef,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.scrawl.markBuilt")(function* (input) {
    yield* (yield* DesktopScrawl.DesktopScrawl).markBuilt(input);
  }),
});

export const scrawlListCaptures = makeIpcMethod({
  channel: IpcChannels.SCRAWL_LIST_CAPTURES_CHANNEL,
  payload: Schema.Void,
  result: Schema.Array(ScrawlCaptureSummary),
  handler: Effect.fn("desktop.ipc.scrawl.listCaptures")(function* () {
    return yield* (yield* DesktopScrawl.DesktopScrawl).listCaptures();
  }),
});

export const scrawlSetPinned = makeIpcMethod({
  channel: IpcChannels.SCRAWL_SET_PINNED_CHANNEL,
  payload: ScrawlSetPinnedInput,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.scrawl.setPinned")(function* (input) {
    yield* (yield* DesktopScrawl.DesktopScrawl).setPinned(input);
  }),
});

export const scrawlTrash = makeIpcMethod({
  channel: IpcChannels.SCRAWL_TRASH_CHANNEL,
  payload: ScrawlCaptureRef,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.scrawl.trash")(function* (input) {
    yield* (yield* DesktopScrawl.DesktopScrawl).trash(input);
  }),
});

export const scrawlReveal = makeIpcMethod({
  channel: IpcChannels.SCRAWL_REVEAL_CHANNEL,
  payload: ScrawlCaptureRef,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.scrawl.reveal")(function* (input) {
    yield* (yield* DesktopScrawl.DesktopScrawl).reveal(input);
  }),
});

export const scrawlGetShortcutState = makeIpcMethod({
  channel: IpcChannels.SCRAWL_GET_SHORTCUT_STATE_CHANNEL,
  payload: Schema.Void,
  result: ScrawlShortcutState,
  handler: Effect.fn("desktop.ipc.scrawl.getShortcutState")(function* () {
    return yield* (yield* DesktopScrawl.DesktopScrawl).shortcutState;
  }),
});

export const scrawlCheckShortcut = makeIpcMethod({
  channel: IpcChannels.SCRAWL_CHECK_SHORTCUT_CHANNEL,
  payload: SnapShotKeyChord,
  result: ScrawlShortcutAvailability,
  handler: Effect.fn("desktop.ipc.scrawl.checkShortcut")(function* (shortcut) {
    return yield* (yield* DesktopScrawl.DesktopScrawl).checkShortcut(shortcut);
  }),
});
