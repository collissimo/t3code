import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { markDictatedText } from "@t3tools/client-runtime/voice-input/dictationMarker";
import type {
  DesktopDictationOutcome,
  DictationAppendInput,
  DictationFinishResult,
  EnvironmentId,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { useEffect, useRef, useState } from "react";

import { useLocalStorage } from "~/hooks/useLocalStorage";
import { randomUUID } from "~/lib/utils";
import { serverEnvironment } from "../state/server";
import { useAtomCommand } from "../state/use-atom-command";
import {
  MicrophoneUnavailableError,
  startMicrophoneCapture,
  type MicrophoneCapture,
} from "./microphoneCapture";
import { defaultDictationLanguage } from "./dictationLanguages";

// Dictation into the composer: the microphone is recorded here and streamed to a local speech
// model, which writes the transcript. On request (the structured shortcut, or "Reinschrift"
// spoken at the end) the thread's server rewrites it into a structured prompt first.

const SEND_INTERVAL_MS = 500;
const LANGUAGE_KEY = "t3code:dictation-language";

export type DictationPhase = "idle" | "starting" | "recording" | "transcribing" | "structuring";

export interface DictationNotice {
  readonly text: string;
  readonly tone: "info" | "warning" | "error" | "success";
}

export interface DictationState {
  readonly phase: DictationPhase;
  /** Live transcript of the last seconds while recording. */
  readonly preview: string;
  /** The running recording will be rewritten into a structured prompt. */
  readonly structured: boolean;
  readonly notice: DictationNotice | null;
}

interface Recording {
  readonly sessionId: string;
  readonly capture: MicrophoneCapture;
  readonly timer: ReturnType<typeof setInterval>;
  /** Appends in flight; the finish waits for the last one. */
  sending: Promise<boolean>;
  failed: string | null;
}

const IDLE: DictationState = { phase: "idle", preview: "", structured: false, notice: null };

const failureText = (result: { readonly _tag: "Failure" }) => {
  const error = squashAtomCommandFailure(result as never) as unknown;
  return error instanceof Error ? error.message : String(error);
};

const outcomeOf = <Value>(
  result: { readonly _tag: "Success"; readonly value: Value } | { readonly _tag: "Failure" },
): DesktopDictationOutcome<Value> =>
  result._tag === "Success"
    ? { ok: true, value: result.value }
    : { ok: false, reason: failureText(result) };

const bridgeFailure = (error: unknown): DesktopDictationOutcome<never> => ({
  ok: false,
  reason: error instanceof Error ? error.message : String(error),
});

export function useDictation(input: {
  /** The thread's environment; its server rewrites a transcript into a structured prompt. */
  readonly environmentId: EnvironmentId | null;
  /** The server that transcribes when the desktop app's own worker is not there (web clients). */
  readonly transcriptionEnvironmentId: EnvironmentId | null;
  /** Puts the text into the composer; false when the composer cannot take it right now. */
  readonly insert: (text: string) => boolean;
}) {
  const append = useAtomCommand(serverEnvironment.dictationAppend, { reportFailure: false });
  const finish = useAtomCommand(serverEnvironment.dictationFinish, { reportFailure: false });
  const cancelSession = useAtomCommand(serverEnvironment.dictationCancel, { reportFailure: false });
  const structure = useAtomCommand(serverEnvironment.dictationStructure, { reportFailure: false });
  const [language, setLanguage] = useLocalStorage(
    LANGUAGE_KEY,
    defaultDictationLanguage(navigator.language),
    Schema.String,
  );
  const [state, setRenderedState] = useState<DictationState>(IDLE);
  // Callbacks read the state they act on from here, not from a render that may be stale.
  const stateRef = useRef(state);
  const setState = (next: DictationState | ((previous: DictationState) => DictationState)) => {
    stateRef.current = typeof next === "function" ? next(stateRef.current) : next;
    setRenderedState(stateRef.current);
  };
  const recordingRef = useRef<Recording | null>(null);
  // Bumped whenever a step is abandoned (Esc), so its late result is ignored.
  const generationRef = useRef(0);
  const noticeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // The plain transcript while it is being rewritten, for Esc to insert instead.
  const unstructuredRef = useRef<string | null>(null);
  const inputRef = useRef(input);
  const languageRef = useRef(language);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- gives the send timer and async steps the latest props
  useEffect(() => {
    inputRef.current = input;
    languageRef.current = language;
  });

  // The desktop app transcribes on this computer in its own worker, whatever environment the
  // thread is on; a browser uses the server it is served from.
  const transcribe = {
    append: async (appendInput: DictationAppendInput) => {
      const bridge = window.desktopBridge?.dictationAppend;
      if (bridge) return bridge(appendInput).catch(bridgeFailure);
      const environmentId = inputRef.current.transcriptionEnvironmentId;
      if (environmentId === null) return bridgeFailure("No environment to dictate with.");
      return outcomeOf(await append({ environmentId, input: appendInput }));
    },
    finish: async (sessionId: string): Promise<DesktopDictationOutcome<DictationFinishResult>> => {
      const bridge = window.desktopBridge?.dictationFinish;
      if (bridge) return bridge({ sessionId }).catch(bridgeFailure);
      const environmentId = inputRef.current.transcriptionEnvironmentId;
      if (environmentId === null) return bridgeFailure("No environment to dictate with.");
      return outcomeOf(await finish({ environmentId, input: { sessionId } }));
    },
    cancel: (sessionId: string) => {
      const bridge = window.desktopBridge?.dictationCancel;
      if (bridge) {
        void bridge({ sessionId }).catch(() => undefined);
        return;
      }
      const environmentId = inputRef.current.transcriptionEnvironmentId;
      if (environmentId !== null) void cancelSession({ environmentId, input: { sessionId } });
    },
  };

  const update = (next: Partial<DictationState>) => {
    setState((previous) => ({ ...previous, ...next }));
  };

  const notify = (notice: DictationNotice, hideAfterMs = 4000) => {
    if (noticeTimerRef.current !== null) clearTimeout(noticeTimerRef.current);
    update({ notice });
    noticeTimerRef.current = setTimeout(() => {
      noticeTimerRef.current = null;
      setState((previous) =>
        previous.notice === notice ? { ...previous, notice: null } : previous,
      );
    }, hideAfterMs);
  };

  const endRecording = (): Recording | null => {
    const recording = recordingRef.current;
    recordingRef.current = null;
    if (recording === null) return null;
    clearInterval(recording.timer);
    return recording;
  };

  const sendPcm = (recording: Recording, pcm: string) => {
    recording.sending = recording.sending.then(async (ok) => {
      if (!ok) return false;
      const result = await transcribe.append({
        sessionId: recording.sessionId,
        language: languageRef.current,
        pcm,
      });
      if (!result.ok) {
        recording.failed = result.reason;
        return false;
      }
      if (recordingRef.current === recording) update({ preview: result.value.preview });
      return true;
    });
    return recording.sending;
  };

  const start = async (structured: boolean) => {
    const environmentId = inputRef.current.environmentId;
    if (environmentId === null) return;
    const generation = ++generationRef.current;
    update({ phase: "starting", preview: "", structured, notice: null });
    let capture: MicrophoneCapture;
    try {
      capture = await startMicrophoneCapture();
    } catch (error) {
      setState(IDLE);
      notify(
        {
          text: error instanceof MicrophoneUnavailableError ? error.message : String(error),
          tone: "error",
        },
        6000,
      );
      return;
    }
    if (generation !== generationRef.current) {
      capture.stop();
      return;
    }
    const recording: Recording = {
      sessionId: randomUUID(),
      capture,
      timer: setInterval(() => {
        void sendPcm(recording, capture.takePcm()).then((ok) => {
          if (!ok && recordingRef.current === recording) {
            endRecording();
            capture.stop();
            setState(IDLE);
            notify({ text: recording.failed ?? "Dictation failed.", tone: "error" }, 8000);
          }
        });
      }, SEND_INTERVAL_MS),
      sending: Promise.resolve(true),
      failed: null,
    };
    recordingRef.current = recording;
    update({ phase: "recording" });
  };

  const stop = async (structuredNow: boolean) => {
    const environmentId = inputRef.current.environmentId;
    const recording = endRecording();
    if (recording === null || environmentId === null) return;
    const generation = generationRef.current;
    const structured = stateRef.current.structured || structuredNow;
    update({ phase: "transcribing", structured });
    const last = recording.capture.takePcm();
    recording.capture.stop();
    const sent = await sendPcm(recording, last);
    if (!sent) {
      setState(IDLE);
      notify({ text: recording.failed ?? "Dictation failed.", tone: "error" }, 8000);
      return;
    }
    const result = await transcribe.finish(recording.sessionId);
    if (generation !== generationRef.current) return;
    if (!result.ok) {
      setState(IDLE);
      notify({ text: result.reason, tone: "error" }, 8000);
      return;
    }
    const { text, reason, structureRequested } = result.value;
    if (text === "") {
      setState(IDLE);
      notify({
        text:
          reason === "no-audio"
            ? "No sound from the microphone. Check the input device."
            : "No speech recognized.",
        tone: "warning",
      });
      return;
    }
    if (!structured && !structureRequested) {
      deliver(text, null);
      return;
    }
    update({ phase: "structuring" });
    unstructuredRef.current = text;
    const rewritten = await structure({ environmentId, input: { text } });
    if (generation !== generationRef.current) return;
    unstructuredRef.current = null;
    if (rewritten._tag === "Failure") {
      console.warn("dictation: structuring failed", failureText(rewritten));
      deliver(text, "Structuring failed · inserted unchanged");
      return;
    }
    deliver(rewritten.value.text, null);
  };

  const deliver = (text: string, warning: string | null) => {
    setState(IDLE);
    if (inputRef.current.insert(text)) {
      notify(
        warning ? { text: warning, tone: "warning" } : { text: "Inserted", tone: "success" },
        1500,
      );
      return;
    }
    void navigator.clipboard?.writeText(markDictatedText("", text));
    notify(
      {
        text: "The composer cannot take text right now · copied to the clipboard",
        tone: "warning",
      },
      6000,
    );
  };

  /** Starts a recording, or stops the running one. `structured` asks for the rewrite. */
  const toggle = (structured = false) => {
    const phase = stateRef.current.phase;
    if (phase === "idle") void start(structured);
    else if (phase === "recording") void stop(structured);
  };

  /**
   * Esc: drops a recording, or skips the rewrite and inserts the plain transcript.
   * Returns whether there was anything to cancel.
   */
  const cancel = (): boolean => {
    const phase = stateRef.current.phase;
    if (phase === "recording" || phase === "starting") {
      generationRef.current++;
      const recording = endRecording();
      if (recording !== null) {
        recording.capture.stop();
        transcribe.cancel(recording.sessionId);
      }
      setState(IDLE);
      notify({ text: "Cancelled", tone: "info" }, 1200);
      return true;
    }
    if (phase === "structuring" && unstructuredRef.current !== null) {
      generationRef.current++;
      const text = unstructuredRef.current;
      unstructuredRef.current = null;
      deliver(text, "Inserted unchanged");
      return true;
    }
    return false;
  };

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- holds the microphone and timers until unmount
  useEffect(
    () => () => {
      // Leaving the composer (another thread, unmount) ends a recording without inserting it.
      generationRef.current++;
      const recording = recordingRef.current;
      recordingRef.current = null;
      if (recording !== null) {
        clearInterval(recording.timer);
        recording.capture.stop();
      }
      if (noticeTimerRef.current !== null) clearTimeout(noticeTimerRef.current);
    },
    [],
  );

  return { state, toggle, cancel, language, setLanguage };
}
