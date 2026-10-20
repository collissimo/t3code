import { LoaderCircleIcon, MicIcon, SparklesIcon } from "lucide-react";

import type { DictationState } from "../../dictation/useDictation";
import { cn } from "~/lib/utils";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

const NOTICE_TONES = {
  info: "text-muted-foreground",
  success: "text-success",
  warning: "text-warning",
  error: "text-destructive",
} as const;

/** Mic button in the composer footer, with the live transcript and status floating above it. */
export function ComposerDictationButton(props: {
  readonly state: DictationState;
  readonly onToggle: (structured: boolean) => void;
  readonly dictateShortcutLabel: string | null;
  readonly structuredShortcutLabel: string | null;
}) {
  const { phase, preview, structured, notice } = props.state;
  const recording = phase === "recording";
  const busy = phase === "starting" || phase === "transcribing" || phase === "structuring";
  const status = recording
    ? structured
      ? "Recording, will be structured"
      : "Recording"
    : phase === "transcribing"
      ? "Transcribing…"
      : phase === "structuring"
        ? "Structuring… · Esc inserts it unchanged"
        : phase === "starting"
          ? "Opening the microphone…"
          : null;
  const stopHint = [
    props.dictateShortcutLabel ? `${props.dictateShortcutLabel} stops` : null,
    !structured && props.structuredShortcutLabel
      ? `${props.structuredShortcutLabel} stops and structures`
      : null,
    "Esc cancels",
  ]
    .filter(Boolean)
    .join(" · ");
  const label = recording ? "Stop dictation" : "Dictate";
  const tooltip = recording
    ? stopHint
    : [
        props.dictateShortcutLabel ? `Dictate (${props.dictateShortcutLabel})` : "Dictate",
        props.structuredShortcutLabel
          ? `${props.structuredShortcutLabel} or ending with "Reinschrift": structured prompt`
          : null,
      ]
        .filter(Boolean)
        .join(" · ");

  return (
    <div className="relative">
      {status !== null || notice !== null ? (
        <div
          role="status"
          aria-live="polite"
          className="pointer-events-none absolute right-0 bottom-full z-20 mb-3 w-max max-w-[min(32rem,80vw)] rounded-lg border border-border bg-popover px-3 py-2 text-sm shadow-md"
        >
          {status !== null ? (
            <>
              <div
                className={cn(
                  "font-medium",
                  recording ? (structured ? "text-primary" : "text-destructive") : "text-warning",
                )}
              >
                {recording ? "● " : null}
                {status}
                {recording ? (
                  <span className="font-normal text-muted-foreground"> · {stopHint}</span>
                ) : null}
              </div>
              {recording && preview ? (
                <div className="mt-1 text-muted-foreground">{preview.slice(-360)}</div>
              ) : null}
            </>
          ) : notice !== null ? (
            <div className={NOTICE_TONES[notice.tone]}>{notice.text}</div>
          ) : null}
        </div>
      ) : null}
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              type="button"
              // Red while recording, the primary colour while recording for a structured prompt.
              variant={recording ? (structured ? "default" : "destructive") : "ghost"}
              size="icon-sm"
              // Keeps the caret in the editor, so the transcript lands where it was.
              onPointerDown={(event) => event.preventDefault()}
              onClick={(event) => props.onToggle(event.shiftKey)}
              disabled={busy}
              aria-label={label}
              aria-pressed={recording}
            />
          }
        >
          {busy ? (
            <LoaderCircleIcon className="animate-spin" />
          ) : structured && recording ? (
            <SparklesIcon />
          ) : (
            <MicIcon />
          )}
        </TooltipTrigger>
        <TooltipPopup>{tooltip}</TooltipPopup>
      </Tooltip>
    </div>
  );
}
