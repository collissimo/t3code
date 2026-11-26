// Fork: a new worktree thread waits for its AI branch name only briefly (see FORK.md, "Branch name
// without waiting"). This file holds the name used when the AI name is not back in time.
import type { BranchNamingOptions } from "@t3tools/contracts";
import { formatGeneratedBranchName } from "@t3tools/shared/git";

/**
 * How long after the worktree exists the agent may wait for the AI branch name. A blocking setup
 * script that runs longer extends the wait to its end, since the agent cannot start before then.
 */
export const AI_BRANCH_NAME_GRACE = "2 seconds";

/** Words of the prompt that make up the branch name. */
const PROMPT_WORDS = 6;

// The fork's dictation marker (`DICTATION_MARKER` in client-runtime) says nothing about the task.
const LEADING_DICTATION_MARKER = /^\s*\[STT\]\s*/;

/** A branch name from the first words of the prompt, made without the AI. */
export function instantBranchName(text: string, naming: BranchNamingOptions): string {
  const words = text
    .replace(LEADING_DICTATION_MARKER, "")
    // A slash in the prompt would nest the branch name.
    .replaceAll("/", " ")
    .split(/\s+/)
    .filter((word) => word.length > 0)
    .slice(0, PROMPT_WORDS);
  // A custom name is the AI following the user's instructions; without the AI, use the prefix.
  return formatGeneratedBranchName(
    words.join(" "),
    naming.mode === "custom" ? { ...naming, mode: "static" } : naming,
  );
}
