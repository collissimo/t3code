import type { DictationEngineKind } from "@t3tools/contracts";

// Languages the dictation models transcribe.
export const DICTATION_LANGUAGES: ReadonlyArray<{
  readonly code: string;
  readonly name: string;
}> = [
  { code: "de", name: "Deutsch" },
  { code: "en", name: "English" },
  { code: "fr", name: "Français" },
  { code: "es", name: "Español" },
  { code: "it", name: "Italiano" },
  { code: "nl", name: "Nederlands" },
  { code: "pl", name: "Polski" },
];

export const DEFAULT_DICTATION_LANGUAGE = "de";

/** Who transcribes; only the chosen one ever receives a recording. */
export const DICTATION_ENGINES: ReadonlyArray<{
  readonly kind: DictationEngineKind;
  readonly name: string;
}> = [
  { kind: "local", name: "Local model" },
  { kind: "claude", name: "Claude Code" },
  { kind: "codex", name: "Codex" },
];
