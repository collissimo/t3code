import { ChevronDownIcon, LoaderCircleIcon, MicIcon, SparklesIcon } from "lucide-react";

import { DICTATION_LANGUAGES } from "../../dictation/dictationLanguages";
import type { DictationState } from "../../dictation/useDictation";
import { cn } from "~/lib/utils";
import { Button } from "../ui/button";
import { Menu, MenuPopup, MenuRadioGroup, MenuRadioItem, MenuTrigger } from "../ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { useComposerMenuProps } from "./composerEventScope";

const NOTICE_TONES = {
  info: "text-muted-foreground",
  success: "text-success",
  warning: "text-warning",
  error: "text-destructive",
} as const;

/**
 * Mic button in the composer footer, with the live transcript and status floating above it and
 * the menu of spoken languages behind the arrow beside it.
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
  const composerMenuProps = useComposerMenuProps();
  const languageName =
    DICTATION_LANGUAGES.find((entry) => entry.code === props.language)?.name ?? props.language;
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
    <div className="flex items-center">
      {status !== null || notice !== null ? (
        // Positioned against the composer footer, so it stays inside the composer at any width.
        <div
          role="status"
          aria-live="polite"
          className="pointer-events-none absolute start-2 bottom-full z-20 mb-3 w-max max-w-[min(32rem,calc(100%-1rem))] rounded-lg border border-border bg-popover px-3 py-2 text-sm shadow-md"
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
      <Menu>
        <Tooltip>
          <TooltipTrigger
            render={
              <MenuTrigger
                render={
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-micro"
                    disabled={phase !== "idle"}
                    aria-label={`Dictation language: ${languageName}`}
                  />
                }
              />
            }
          >
            <ChevronDownIcon />
          </TooltipTrigger>
          <TooltipPopup>{`Dictation language: ${languageName}`}</TooltipPopup>
        </Tooltip>
        <MenuPopup side="top" align="start" {...composerMenuProps}>
          <MenuRadioGroup value={props.language} onValueChange={props.onLanguageChange}>
            {DICTATION_LANGUAGES.map((entry) => (
              <MenuRadioItem key={entry.code} value={entry.code}>
                {entry.name}
              </MenuRadioItem>
            ))}
          </MenuRadioGroup>
        </MenuPopup>
      </Menu>
    </div>
  );
}
