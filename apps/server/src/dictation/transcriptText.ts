// Cleanup of a dictated transcript before it reaches the composer.

// Only sounds that are never words, so removing them cannot change what was said. Words that
// merely pad a sentence ("also", "halt") stay, and so does "um", which is a German word.
const FILLER =
  "(?:" +
  "ä+h*m*" + // ä, äh, ähm
  "|ö+h+m*|ö+m+" + // öh, öhm, öm
  "|e+h+m+|e+rm+" + // ehm, erm
  "|h+m+h*" + // hm, hmm
  "|m+h+m*" + // mh, mhm
  "|mmm+" + // mmm, but not "mm" (millimetres)
  "|u+h+m*|u+mm+" + // uh, uhm, umm
  ")";
const WORD_CHAR = "[\\p{L}\\p{N}_'’\\-]";
// A filler together with the punctuation the transcriber attached to it.
const FILLER_PATTERN = new RegExp(
  `(?<!${WORD_CHAR})${FILLER}(?!${WORD_CHAR})[ \\t]*(\\.\\.\\.|…|[,;:.!?])?`,
  "giu",
);
const SENTENCE_END = ".!?…";
// Private-use characters mark spots for the passes below; transcripts never contain them.
const CAPITALIZE = "";
const SENTENCE_END_MARK = "";

export function removeFillers(text: string): string {
  let cleaned = text.replace(
    FILLER_PATTERN,
    (_match, after: string | undefined, offset: number) => {
      const before = text.slice(0, offset).trimEnd();
      if (before === "" || SENTENCE_END.includes(before.at(-1)!)) {
        // "Okay. Ähm, mir ..." -> "Okay. Mir ...": the next word now opens the sentence.
        return CAPITALIZE;
      }
      if (after !== undefined && SENTENCE_END.includes(after[0]!)) {
        // "..., äh. Und" -> "... . Und": the sentence end wins over the comma before it.
        return SENTENCE_END_MARK + after;
      }
      // A comma after the filler belongs to the filler: transcripts read "Stimme äh, aufzunehmen",
      // and keeping it would leave "Stimme, aufzunehmen".
      return "";
    },
  );
  cleaned = cleaned.replace(/[,;:]?\s*/gu, "");
  cleaned = cleaned.replace(
    /[ \t]*([\p{L}\p{N}_])/gu,
    (_match, first: string) => ` ${first.toUpperCase()}`,
  );
  cleaned = cleaned.replaceAll(CAPITALIZE, "");
  cleaned = cleaned.replace(/[ \t]{2,}/gu, " ");
  cleaned = cleaned.replace(/[ \t]+([,;:.!?…])/gu, "$1");
  cleaned = cleaned.replace(/[ \t]*\n[ \t]*/gu, "\n");
  return cleaned.trim();
}

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
