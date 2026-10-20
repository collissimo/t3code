// Records the microphone as 16 kHz mono 16-bit PCM for server-side dictation.

export class MicrophoneUnavailableError extends Error {
  constructor(
    message: string,
    readonly kind: "insecure-context" | "denied" | "no-device" | "failed",
  ) {
    super(message);
  }
}

export interface MicrophoneCapture {
  /** PCM recorded since the previous call, as base64 of 16-bit little-endian samples. */
  readonly takePcm: () => string;
  readonly stop: () => void;
}

// From the app root, not the current route: /<thread>/x.js would hit the SPA fallback.
const WORKLET_URL = `${import.meta.env.BASE_URL.replace(/\/$/, "")}/dictation-capture-worklet.js`;

export async function startMicrophoneCapture(): Promise<MicrophoneCapture> {
  if (!navigator.mediaDevices?.getUserMedia) {
    // Browsers hand out the microphone only to https:// and localhost pages.
    throw new MicrophoneUnavailableError(
      "Dictation needs a secure connection (HTTPS or localhost).",
      "insecure-context",
    );
  }
  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });
  } catch (error) {
    const name = error instanceof DOMException ? error.name : "";
    if (name === "NotAllowedError" || name === "SecurityError") {
      throw new MicrophoneUnavailableError("Microphone access was denied.", "denied");
    }
    if (name === "NotFoundError" || name === "OverconstrainedError") {
      throw new MicrophoneUnavailableError("No microphone found.", "no-device");
    }
    throw new MicrophoneUnavailableError(
      `The microphone cannot be opened: ${error instanceof Error ? error.message : String(error)}`,
      "failed",
    );
  }
  const context = new AudioContext();
  const blocks: Array<Float32Array> = [];
  try {
    await context.audioWorklet.addModule(WORKLET_URL);
    const source = context.createMediaStreamSource(stream);
    const node = new AudioWorkletNode(context, "dictation-capture");
    node.port.addEventListener("message", (event: MessageEvent<Float32Array>) => {
      blocks.push(event.data);
    });
    // addEventListener, unlike onmessage, does not start the port by itself.
    node.port.start();
    source.connect(node);
    // Silent output: the graph only runs nodes that lead to the speakers.
    const mute = context.createGain();
    mute.gain.value = 0;
    node.connect(mute).connect(context.destination);
    await context.resume();
  } catch (error) {
    for (const track of stream.getTracks()) track.stop();
    void context.close();
    throw new MicrophoneUnavailableError(
      `Recording cannot start: ${error instanceof Error ? error.message : String(error)}`,
      "failed",
    );
  }

  return {
    takePcm: () => {
      const taken = blocks.splice(0, blocks.length);
      return encodePcm16(taken);
    },
    stop: () => {
      for (const track of stream.getTracks()) track.stop();
      void context.close();
    },
  };
}

export function encodePcm16(blocks: ReadonlyArray<Float32Array>): string {
  let length = 0;
  for (const block of blocks) length += block.length;
  const bytes = new Uint8Array(length * 2);
  const view = new DataView(bytes.buffer);
  let offset = 0;
  for (const block of blocks) {
    for (const sample of block) {
      const clamped = Math.max(-1, Math.min(1, sample));
      view.setInt16(offset, clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff, true);
      offset += 2;
    }
  }
  let binary = "";
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  return btoa(binary);
}
