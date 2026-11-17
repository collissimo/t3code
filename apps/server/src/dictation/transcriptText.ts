// Cleanup of a dictated transcript before it reaches the composer.

// "Reihenschrift" is what the transcriber makes of "Reinschrift".
export const DEFAULT_STRUCTURE_CODEWORDS = ["Reinschrift", "Reihenschrift"] as const;
const SEPARATORS = "\\s.,;:!?…";

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Cuts a codeword spoken at the very end of a transcript. Only the end counts, so the word
 * can still be used inside a sentence.
 */
export function splitCodeword(
  text: string,
  codewords: ReadonlyArray<string>,
): { readonly text: string; readonly found: boolean } {
  // The transcriber decides how the words of a phrase are spaced.
  const patterns = codewords
    .filter((word) => word.trim() !== "")
    .map((word) => word.trim().split(/\s+/u).map(escapeRegExp).join("\\s+"));
  if (patterns.length === 0) return { text, found: false };
  const match = new RegExp(
    `(?:^|(?<=[${SEPARATORS}]))(?:${patterns.join("|")})[${SEPARATORS}]*$`,
    "iu",
  ).exec(text);
  if (match === null) return { text, found: false };
  // "…, Codewort." leaves the comma that led up to it.
  return { text: text.slice(0, match.index).replace(/[ \t\n,;:]+$/u, ""), found: true };
}
