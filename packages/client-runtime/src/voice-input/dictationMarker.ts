/** Tells whoever reads a prompt, agents included, that it was spoken and may hold transcription errors. */
export const DICTATION_MARKER = "[STT]";

/**
 * Marks only the first dictation of a draft. It stays in front of the spoken text rather than at
 * the start of the draft, because a typed `/command` only works as the draft's first word.
 */
export function markDictatedText(draft: string, text: string): string {
  return draft.includes(DICTATION_MARKER) ? text : `${DICTATION_MARKER} ${text}`;
}
