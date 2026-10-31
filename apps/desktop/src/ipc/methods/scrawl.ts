import {
  ScrawlAppendVideoInput,
  ScrawlCaptureRef,
  ScrawlStartResult,
  ScrawlStopResult,
  ScrawlWriteFileInput,
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
