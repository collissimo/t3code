import * as Schema from "effect/Schema";

import { TrimmedNonEmptyString } from "./baseSchemas.ts";

// Dictation runs on the server: the client streams microphone audio, the server's
// local speech model (Parakeet through transcribe.cpp) turns it into text.

/** Audio the client sends: 16 kHz mono 16-bit little-endian PCM. */
export const DICTATION_SAMPLE_RATE = 16_000;
// About one second of base64 PCM per chunk is ~43 KB; a client sends one every half second.
const DICTATION_MAX_CHUNK_CHARS = 2_000_000;

export const DictationSessionId = TrimmedNonEmptyString.check(Schema.isMaxLength(128));
export type DictationSessionId = typeof DictationSessionId.Type;

export const DictationAppendInput = Schema.Struct({
  sessionId: DictationSessionId,
  /** BCP 47 or ISO 639-1 code of the spoken language; omitted lets the model detect it. */
  language: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(35))),
  /** Base64 of the PCM recorded since the previous append. May be empty. */
  pcm: Schema.String.check(Schema.isMaxLength(DICTATION_MAX_CHUNK_CHARS)),
});
export type DictationAppendInput = typeof DictationAppendInput.Type;

export const DictationAppendResult = Schema.Struct({
  /** Interim transcript of the last seconds of the recording. */
  preview: Schema.String,
});
export type DictationAppendResult = typeof DictationAppendResult.Type;

export const DictationFinishInput = Schema.Struct({
  sessionId: DictationSessionId,
});
export type DictationFinishInput = typeof DictationFinishInput.Type;

export const DictationNoTextReason = Schema.Literals(["no-speech", "no-audio"]);
export type DictationNoTextReason = typeof DictationNoTextReason.Type;

export const DictationFinishResult = Schema.Struct({
  /** Cleaned transcript; empty when nothing was recognized, and `reason` says why. */
  text: Schema.String,
  reason: Schema.optional(DictationNoTextReason),
  /** The speaker ended with the codeword that asks for a structured rewrite (already cut). */
  structureRequested: Schema.Boolean,
});
export type DictationFinishResult = typeof DictationFinishResult.Type;

export const DictationStructureInput = Schema.Struct({
  text: TrimmedNonEmptyString.check(Schema.isMaxLength(200_000)),
});
export type DictationStructureInput = typeof DictationStructureInput.Type;

export const DictationStructureResult = Schema.Struct({
  text: Schema.String,
});
export type DictationStructureResult = typeof DictationStructureResult.Type;

export const DictationCancelInput = Schema.Struct({
  sessionId: DictationSessionId,
});
export type DictationCancelInput = typeof DictationCancelInput.Type;

export class DictationError extends Schema.TaggedError<DictationError>()("DictationError", {
  reason: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message(): string {
    return this.reason;
  }
}
