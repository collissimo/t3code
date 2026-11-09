// @effect-diagnostics globalDate:off globalTimers:off globalFetch:off - Also runs in the desktop dictation worker, which has no Effect runtime.
// Dictation through the Claude Code or Codex sign-in on the transcribing machine, as the CLIs and
// apps themselves dictate. Claude streams while recording, so it gives a live preview like Claude
// Code's /voice; Codex uploads the recording once it stops, like the ChatGPT and Codex apps.

import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";

import {
  defaultSubscriptionHomes,
  readClaudeLogin,
  readCodexChatGptLogin,
} from "../provider/subscriptionLogins.ts";
import { normalizeLanguage, SAMPLE_RATE, type TranscriptResult } from "./DictationEngine.ts";

export type CloudDictationKind = "claude" | "codex";

const CLAUDE_VOICE_STREAM_URL = "wss://api.anthropic.com/api/ws/speech_to_text/voice_stream";
const CHATGPT_TRANSCRIBE_URL = "https://chatgpt.com/backend-api/transcribe";
const FINISH_TIMEOUT_MS = 60_000;
const UPLOAD_TIMEOUT_MS = 120_000;
const MAX_RECORDING_BYTES = 15 * 60 * SAMPLE_RATE * 2;
const ABANDONED_SESSION_MS = 2 * 60_000;

type Logins = {
  readonly claude:
    | { readonly accessToken: string; readonly expiresAt?: number | undefined }
    | undefined;
  readonly codex: { readonly accessToken: string; readonly accountId: string } | undefined;
};

const readLogins = (): Promise<Logins> =>
  Effect.runPromise(
    defaultSubscriptionHomes().pipe(
      Effect.flatMap((homes) =>
        Effect.all({
          claude: readClaudeLogin(homes.claude).pipe(Effect.orElseSucceed(() => undefined)),
          codex: readCodexChatGptLogin(homes.codex).pipe(Effect.orElseSucceed(() => undefined)),
        }),
      ),
      Effect.provide(NodeServices.layer),
    ),
  );

const signInError = (app: string) =>
  new Error(
    `Sign in to ${app} on the transcribing computer to dictate with it. No audio was sent.`,
  );
const expiredError = (app: string) =>
  new Error(`The ${app} sign-in expired. Run ${app} once to refresh it, then dictate again.`);

/** 16 kHz mono 16-bit PCM with a WAVE header. */
function wavFromPcm16(pcm: Uint8Array): Uint8Array<ArrayBuffer> {
  const wav = new Uint8Array(44 + pcm.byteLength);
  const view = new DataView(wav.buffer);
  const tag = (at: number, value: string) => wav.set(new TextEncoder().encode(value), at);
  tag(0, "RIFF");
  view.setUint32(4, wav.byteLength - 8, true);
  tag(8, "WAVE");
  tag(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, SAMPLE_RATE, true);
  view.setUint32(28, SAMPLE_RATE * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  tag(36, "data");
  view.setUint32(40, pcm.byteLength, true);
  wav.set(pcm, 44);
  return wav;
}

interface CloudSession {
  readonly append: (pcm: Uint8Array) => void;
  readonly preview: () => string;
  readonly finish: () => Promise<string>;
  readonly cancel: () => void;
  lastActiveAt: number;
}

type ClaudeFrame = { readonly type?: string; readonly data?: string };

/** Opens the stream at once and sends audio as it arrives; frames wait until it is open. */
function claudeSession(
  logins: () => Promise<Logins>,
  language: string | undefined,
  now: number,
): CloudSession {
  const pending: Array<Uint8Array> = [];
  const utterances: Array<string> = [];
  let current = "";
  let socket: WebSocket | undefined;
  let failure: Error | undefined;
  let opened = false;
  let closing = false;
  let settle: (() => void) | undefined;
  const closed = new Promise<void>((resolve) => {
    settle = resolve;
  });
  const text = () => [...utterances, current].filter(Boolean).join(" ");
  const fail = (error: Error) => {
    failure ??= error;
    socket?.close();
    settle?.();
  };
  const ready = logins().then(({ claude: login }) => {
    if (!login) throw signInError("Claude Code");
    if (login.expiresAt !== undefined && login.expiresAt <= Date.now())
      throw expiredError("Claude Code");
    const params = new URLSearchParams({
      encoding: "linear16",
      sample_rate: String(SAMPLE_RATE),
      channels: "1",
      endpointing_ms: "300",
      utterance_end_ms: "1000",
      // The stream rejects "auto"; without a language it picks its own default.
      ...(language ? { language } : {}),
      use_conversation_engine: "true",
    });
    // Node's WebSocket takes request headers as a non-standard init option.
    const WebSocketWithHeaders = WebSocket as unknown as new (
      url: string,
      init: { readonly headers: Record<string, string> },
    ) => WebSocket;
    const opening = new WebSocketWithHeaders(`${CLAUDE_VOICE_STREAM_URL}?${params}`, {
      headers: { authorization: `Bearer ${login.accessToken}`, "x-app": "cli" },
    });
    socket = opening;
    opening.addEventListener("open", () => {
      opened = true;
      for (const chunk of pending.splice(0)) opening.send(chunk);
      if (closing) opening.send('{"type":"CloseStream"}');
    });
    opening.addEventListener("message", (event) => {
      if (typeof event.data !== "string") return;
      let frame: ClaudeFrame;
      try {
        frame = JSON.parse(event.data) as ClaudeFrame;
      } catch {
        return;
      }
      if (frame.type === "TranscriptText" || frame.type === "TranscriptInterim") {
        if (frame.data) current = frame.data;
      } else if (frame.type === "TranscriptEndpoint") {
        if (current) utterances.push(current);
        current = "";
      } else if (frame.type === "TranscriptError" || frame.type === "error") {
        fail(new Error("Claude couldn’t transcribe this recording. Try again."));
      }
    });
    opening.addEventListener("close", (event) => {
      if (!opened)
        fail(
          new Error(
            "Claude refused the dictation stream. Run Claude Code once to refresh its sign-in, then try again.",
          ),
        );
      else if (event.code !== 1000 && event.code !== 1005)
        fail(new Error(`Claude’s dictation stream closed (${String(event.code)}). Try again.`));
      settle?.();
    });
  });
  ready.catch((error: unknown) => fail(error instanceof Error ? error : new Error(String(error))));
  return {
    lastActiveAt: now,
    append: (pcm) => {
      if (failure) throw failure;
      if (pcm.byteLength === 0) return;
      if (opened && socket) socket.send(pcm);
      else pending.push(pcm);
    },
    preview: text,
    finish: async () => {
      closing = true;
      await ready.catch(() => undefined);
      if (opened && socket) socket.send('{"type":"CloseStream"}');
      const timeout = setTimeout(
        () => fail(new Error("Claude took too long to finish the transcript.")),
        FINISH_TIMEOUT_MS,
      );
      await closed;
      clearTimeout(timeout);
      if (failure) throw failure;
      return text();
    },
    cancel: () => fail(new Error("cancelled")),
  };
}

/** Keeps the recording here and uploads it once, when it stops. */
function codexSession(logins: () => Promise<Logins>, now: number): CloudSession {
  const chunks: Array<Uint8Array> = [];
  let size = 0;
  let controller: AbortController | undefined;
  return {
    lastActiveAt: now,
    append: (pcm) => {
      const room = MAX_RECORDING_BYTES - size;
      if (room <= 0) return;
      const kept = pcm.byteLength > room ? pcm.subarray(0, room) : pcm;
      chunks.push(kept);
      size += kept.byteLength;
    },
    preview: () => "",
    finish: async () => {
      const { codex: login } = await logins();
      if (!login) throw signInError("Codex");
      const pcm = new Uint8Array(size);
      let at = 0;
      for (const chunk of chunks.splice(0)) {
        pcm.set(chunk, at);
        at += chunk.byteLength;
      }
      const form = new FormData();
      form.set("file", new Blob([wavFromPcm16(pcm)], { type: "audio/wav" }), "dictation.wav");
      controller = new AbortController();
      const timeout = setTimeout(() => controller?.abort(), UPLOAD_TIMEOUT_MS);
      const response = await fetch(CHATGPT_TRANSCRIBE_URL, {
        method: "POST",
        body: form,
        redirect: "error",
        signal: controller.signal,
        headers: {
          authorization: `Bearer ${login.accessToken}`,
          "chatgpt-account-id": login.accountId,
        },
      }).finally(() => clearTimeout(timeout));
      if (response.status === 401 || response.status === 403) throw expiredError("Codex");
      if (response.status === 429)
        throw new Error("ChatGPT reached a usage limit for this sign-in. Try again later.");
      if (!response.ok)
        throw new Error(`ChatGPT couldn’t transcribe this recording (${response.status}).`);
      const body = (await response.json()) as { readonly text?: unknown };
      return typeof body.text === "string" ? body.text : "";
    },
    cancel: () => {
      chunks.length = 0;
      controller?.abort();
    },
  };
}

/** Recording sessions transcribed by a cloud sign-in; the same calls as the local engine. */
export class CloudDictation {
  readonly #sessions = new Map<string, CloudSession>();
  readonly #now: () => number;
  readonly #logins: () => Promise<Logins>;

  constructor(
    options: { readonly now?: () => number; readonly logins?: () => Promise<Logins> } = {},
  ) {
    this.#now = options.now ?? Date.now;
    this.#logins = options.logins ?? readLogins;
  }

  has(sessionId: string): boolean {
    return this.#sessions.has(sessionId);
  }

  append(
    sessionId: string,
    kind: CloudDictationKind,
    language: string | undefined,
    pcm: Uint8Array,
  ) {
    let session = this.#sessions.get(sessionId);
    if (session === undefined) {
      session =
        kind === "claude"
          ? claudeSession(this.#logins, normalizeLanguage(language), this.#now())
          : codexSession(this.#logins, this.#now());
      this.#sessions.set(sessionId, session);
    }
    session.lastActiveAt = this.#now();
    try {
      session.append(pcm);
    } catch (error) {
      this.cancel(sessionId);
      throw error;
    }
    return session.preview();
  }

  async finish(sessionId: string): Promise<TranscriptResult> {
    const session = this.#sessions.get(sessionId);
    this.#sessions.delete(sessionId);
    if (session === undefined) return { text: "", reason: "no-speech" };
    const text = (await session.finish()).split(/\s+/).filter(Boolean).join(" ");
    return text ? { text } : { text: "", reason: "no-speech" };
  }

  cancel(sessionId: string): void {
    this.#sessions.get(sessionId)?.cancel();
    this.#sessions.delete(sessionId);
  }

  housekeeping(): void {
    const now = this.#now();
    for (const [id, session] of this.#sessions) {
      if (now - session.lastActiveAt > ABANDONED_SESSION_MS) this.cancel(id);
    }
  }

  dispose(): void {
    for (const id of this.#sessions.keys()) this.cancel(id);
  }
}
