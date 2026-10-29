import type { ReactNode } from "react";

// Languages the dictation models transcribe, each with the flag of its country. Drawn as SVG because
// Windows renders flag emoji as two letters.
const stripes = (direction: "row" | "column", colors: ReadonlyArray<string>) =>
  colors.map((color, index) => {
    const share = index / colors.length;
    return direction === "row" ? (
      <rect key={color} y={share * 12} width="18" height={12 / colors.length} fill={color} />
    ) : (
      <rect key={color} x={share * 18} width={18 / colors.length} height="12" fill={color} />
    );
  });

export const DICTATION_LANGUAGES: ReadonlyArray<{
  readonly code: string;
  readonly name: string;
  readonly flag: ReactNode;
}> = [
  { code: "de", name: "Deutsch", flag: stripes("row", ["#000", "#dd0000", "#ffce00"]) },
  {
    code: "en",
    name: "English",
    flag: (
      <>
        <rect width="18" height="12" fill="#012169" />
        <path d="M0 0l18 12M18 0L0 12" stroke="#fff" strokeWidth="2.4" />
        <path d="M0 0l18 12M18 0L0 12" stroke="#c8102e" strokeWidth="0.8" />
        <path d="M9 0v12M0 6h18" stroke="#fff" strokeWidth="4" />
        <path d="M9 0v12M0 6h18" stroke="#c8102e" strokeWidth="2.4" />
      </>
    ),
  },
  { code: "fr", name: "Français", flag: stripes("column", ["#002395", "#fff", "#ed2939"]) },
  {
    code: "es",
    name: "Español",
    flag: (
      <>
        <rect width="18" height="12" fill="#aa151b" />
        <rect y="3" width="18" height="6" fill="#f1bf00" />
      </>
    ),
  },
  { code: "it", name: "Italiano", flag: stripes("column", ["#009246", "#fff", "#ce2b37"]) },
  { code: "nl", name: "Nederlands", flag: stripes("row", ["#ae1c28", "#fff", "#21468b"]) },
  { code: "pl", name: "Polski", flag: stripes("row", ["#fff", "#dc143c"]) },
];

/** The listed language of the browser, else German. */
export function defaultDictationLanguage(browserLanguage: string): string {
  const code = browserLanguage.toLowerCase().split(/[-_]/)[0];
  return DICTATION_LANGUAGES.find((language) => language.code === code)?.code ?? "de";
}
