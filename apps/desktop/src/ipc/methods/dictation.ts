import {
  DesktopDictationOutcome,
  DictationAppendInput,
  DictationAppendResult,
  DictationCancelInput,
  DictationFinishInput,
  DictationFinishResult,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as DesktopDictation from "../../dictation/DesktopDictation.ts";
import * as IpcChannels from "../channels.ts";
import { makeIpcMethod } from "../DesktopIpc.ts";

export const dictationAppend = makeIpcMethod({
  channel: IpcChannels.DICTATION_APPEND_CHANNEL,
  payload: DictationAppendInput,
  result: DesktopDictationOutcome(DictationAppendResult),
  handler: Effect.fn("desktop.ipc.dictation.append")(function* (input) {
    return yield* (yield* DesktopDictation.DesktopDictation).append(input);
  }),
});

export const dictationFinish = makeIpcMethod({
  channel: IpcChannels.DICTATION_FINISH_CHANNEL,
  payload: DictationFinishInput,
  result: DesktopDictationOutcome(DictationFinishResult),
  handler: Effect.fn("desktop.ipc.dictation.finish")(function* (input) {
    return yield* (yield* DesktopDictation.DesktopDictation).finish(input);
  }),
});

export const dictationCancel = makeIpcMethod({
  channel: IpcChannels.DICTATION_CANCEL_CHANNEL,
  payload: DictationCancelInput,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.dictation.cancel")(function* (input) {
    yield* (yield* DesktopDictation.DesktopDictation).cancel(input);
  }),
});
