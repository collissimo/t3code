import {
  ChevronLeftIcon,
  ChevronRightIcon,
  LoaderCircleIcon,
  MicIcon,
  SparklesIcon,
} from "lucide-react";

import { DICTATION_LANGUAGES } from "../../dictation/dictationLanguages";
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

/**
 * Mic button in the composer footer, with the live transcript and status floating above it and
 * the spoken language, switched with the arrows, below it.
 */
export function ComposerDictationButton(props: {
  readonly state: DictationState;
  readonly onToggle: (structured: boolean) => void;
  readonly dictateShortcutLabel: string | null;
  readonly structuredShortcutLabel: string | null;
  readonly language: string;
  readonly onLanguageChange: (language: string) => void;
}) {
  const { phase, preview, structured, notice } = props.state;
  const languageIndex = Math.max(
    0,
    DICTATION_LANGUAGES.findIndex((entry) => entry.code === props.language),
  );
  const language = DICTATION_LANGUAGES[languageIndex]!;
  const switchLanguage = (step: number) => {
    const count = DICTATION_LANGUAGES.length;
    props.onLanguageChange(DICTATION_LANGUAGES[(languageIndex + step + count) % count]!.code);
  };
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
    <div className="relative flex flex-col items-center">
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
      <div className="flex items-center">
        <Button
          type="button"
          variant="ghost"
          size="icon-tiny"
          onPointerDown={(event) => event.preventDefault()}
          onClick={() => switchLanguage(-1)}
          disabled={phase !== "idle"}
          aria-label="Previous dictation language"
        >
          <ChevronLeftIcon />
        </Button>
        <svg viewBox="0 0 18 12" className="h-2.5 w-[15px] rounded-[1px]" role="img">
          <title>{language.name}</title>
          {language.flag}
        </svg>
        <Button
          type="button"
          variant="ghost"
          size="icon-tiny"
          onPointerDown={(event) => event.preventDefault()}
          onClick={() => switchLanguage(1)}
          disabled={phase !== "idle"}
          aria-label="Next dictation language"
        >
          <ChevronRightIcon />
        </Button>
      </div>
    </div>
  );
}
