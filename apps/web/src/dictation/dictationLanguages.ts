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
