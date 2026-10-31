import { CheckIcon, CopyIcon, CornerDownLeftIcon, Trash2Icon } from "lucide-react";
import { type KeyboardEvent, useEffect, useRef, useState } from "react";

import { markDictatedText } from "@t3tools/client-runtime/voice-input/dictationMarker";

import {
  clearDictationHistory,
  deleteDictationHistoryEntry,
  listDictationHistory,
  type DictationHistoryEntry,
} from "../../dictation/dictationHistory";
import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import { useStableCallback } from "../../hooks/useStableCallback";
import { cn } from "~/lib/utils";
import { Button } from "../ui/button";
import { Dialog, DialogFooter, DialogHeader, DialogPopup, DialogTitle } from "../ui/dialog";
import { ScrollArea } from "../ui/scroll-area";

const PAGE_SIZE = 100;
const LOAD_MORE_WITHIN_PX = 600;

function dayLabel(timestamp: number, now: Date): string {
  const date = new Date(timestamp);
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (date.toDateString() === now.toDateString()) return "Today";
  if (date.toDateString() === yesterday.toDateString()) return "Yesterday";
  return date.toLocaleDateString(undefined, {
    weekday: "long",
    day: "numeric",
    month: "long",
    ...(date.getFullYear() === now.getFullYear() ? {} : { year: "numeric" }),
  });
}

function HistoryRow(props: {
  readonly entry: DictationHistoryEntry;
  readonly heading: string | null;
  readonly onInsert: (text: string) => void;
  readonly onDelete: (id: number) => void;
}) {
  const { entry } = props;
  const [expanded, setExpanded] = useState(false);
  const { copyToClipboard, isCopied } = useCopyToClipboard();
  return (
    <li className="[contain-intrinsic-size:auto_5rem] [content-visibility:auto]">
      {props.heading ? (
        <h3 className="ps-6 pe-4 pt-4 pb-1 font-medium text-muted-foreground text-xs">
          {props.heading}
        </h3>
      ) : null}
      <div className="group flex items-start gap-2 ps-6 pe-4 py-3 hover:bg-accent/50 has-focus-visible:bg-accent/50">
        <button
          type="button"
          data-dictation-history-row
          aria-expanded={expanded}
          className="min-w-0 flex-1 cursor-pointer text-left outline-none"
          onClick={() => setExpanded((previous) => !previous)}
          onKeyDown={(event) => {
            if (event.key !== "Enter") return;
            event.preventDefault();
            props.onInsert(entry.text);
          }}
        >
          <span
            className={cn(
              "block wrap-anywhere whitespace-pre-wrap text-sm",
              !expanded && "line-clamp-3",
            )}
          >
            {entry.text}
          </span>
          <span className="mt-1 flex gap-2 text-muted-foreground text-xs">
            <time dateTime={new Date(entry.createdAt).toISOString()}>
              {new Date(entry.createdAt).toLocaleTimeString(undefined, {
                hour: "2-digit",
                minute: "2-digit",
              })}
            </time>
            {entry.structured ? <span>Structured</span> : null}
          </span>
        </button>
        <div className="flex shrink-0 opacity-0 group-hover:opacity-100 group-has-focus-visible:opacity-100 pointer-coarse:opacity-100">
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label="Insert into composer"
            title="Insert into composer (Enter)"
            onClick={() => props.onInsert(entry.text)}
          >
            <CornerDownLeftIcon />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label="Copy"
            title="Copy"
            onClick={() => copyToClipboard(markDictatedText("", entry.text))}
          >
            {isCopied ? <CheckIcon /> : <CopyIcon />}
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label="Delete"
            title="Delete"
            onClick={() => props.onDelete(entry.id)}
          >
            <Trash2Icon />
          </Button>
        </div>
      </div>
    </li>
  );
}

function HistoryContent(props: {
  readonly dictateShortcutLabel: string | null;
  readonly onInsert: (text: string) => void;
}) {
  const [entries, setEntries] = useState<ReadonlyArray<DictationHistoryEntry>>([]);
  const [status, setStatus] = useState<"loading" | "more" | "complete" | "failed">("loading");
  const [confirmingClear, setConfirmingClear] = useState(false);
  const loadingRef = useRef(false);

  const [now] = useState(() => new Date());

  const loadPage = useStableCallback(async (before: number | null) => {
    if (loadingRef.current) return;
    loadingRef.current = true;
    try {
      const page = await listDictationHistory({ before, limit: PAGE_SIZE });
      setEntries((previous) => [...previous, ...page]);
      setStatus(page.length < PAGE_SIZE ? "complete" : "more");
    } catch (error) {
      console.warn("dictation: history could not be read", error);
      setStatus("failed");
    } finally {
      loadingRef.current = false;
    }
  });

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reads the first page from IndexedDB when the dialog opens
  useEffect(() => {
    void loadPage(null);
  }, [loadPage]);

  const moveFocus = (event: KeyboardEvent) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    const rows = Array.from(
      event.currentTarget.querySelectorAll<HTMLElement>("[data-dictation-history-row]"),
    );
    const current = rows.indexOf(document.activeElement as HTMLElement);
    const next = rows[current + (event.key === "ArrowDown" ? 1 : -1)];
    if (next === undefined) return;
    event.preventDefault();
    next.focus();
    next.scrollIntoView({ block: "nearest" });
  };

  const remove = (id: number) => {
    setEntries((previous) => previous.filter((entry) => entry.id !== id));
    void deleteDictationHistoryEntry(id).catch((error: unknown) => {
      console.warn("dictation: history entry could not be deleted", error);
    });
  };

  const clear = () => {
    setConfirmingClear(false);
    setEntries([]);
    setStatus("complete");
    void clearDictationHistory().catch((error: unknown) => {
      console.warn("dictation: history could not be cleared", error);
    });
  };

  return (
    <>
      <div className="h-[min(70vh,40rem)] min-h-0 border-y">
        <ScrollArea
          onScrollCapture={(event) => {
            const viewport = event.target as HTMLElement;
            const remaining = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight;
            const last = entries.at(-1);
            if (status === "more" && last && remaining < LOAD_MORE_WITHIN_PX) {
              void loadPage(last.id);
            }
          }}
        >
          {entries.length === 0 && status !== "loading" ? (
            <p className="p-6 text-center text-muted-foreground text-sm">
              {status === "failed"
                ? "History could not be loaded. Reopen it to try again"
                : props.dictateShortcutLabel
                  ? `Nothing dictated yet. Press ${props.dictateShortcutLabel} to start`
                  : "Nothing dictated yet"}
            </p>
          ) : (
            <ul
              data-dictation-history-list
              tabIndex={-1}
              aria-label="Dictated prompts"
              className="outline-none"
              onKeyDown={moveFocus}
            >
              {entries.map((entry, index) => {
                const day = dayLabel(entry.createdAt, now);
                const previous = entries[index - 1];
                const heading = previous && dayLabel(previous.createdAt, now) === day ? null : day;
                return (
                  <HistoryRow
                    key={entry.id}
                    entry={entry}
                    heading={heading}
                    onInsert={props.onInsert}
                    onDelete={remove}
                  />
                );
              })}
            </ul>
          )}
        </ScrollArea>
      </div>
      <DialogFooter variant="bare" className="items-center sm:justify-between">
        <span className="text-muted-foreground text-xs">Saved on this device</span>
        {confirmingClear ? (
          <div className="flex gap-2">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => setConfirmingClear(false)}
            >
              Keep history
            </Button>
            <Button type="button" variant="destructive" size="sm" onClick={clear}>
              Delete all
            </Button>
          </div>
        ) : (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={entries.length === 0}
            onClick={() => setConfirmingClear(true)}
          >
            Clear history
          </Button>
        )}
      </DialogFooter>
    </>
  );
}

export function DictationHistoryDialog(props: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly dictateShortcutLabel: string | null;
  readonly onInsert: (text: string) => void;
}) {
  // Inserted once the dialog has closed and let go of focus, so the caret lands in the composer.
  const pendingInsertRef = useRef<string | null>(null);
  return (
    <Dialog
      open={props.open}
      onOpenChange={props.onOpenChange}
      onOpenChangeComplete={(open) => {
        const text = pendingInsertRef.current;
        if (open || text === null) return;
        pendingInsertRef.current = null;
        props.onInsert(text);
      }}
    >
      <DialogPopup
        className="max-w-2xl"
        initialFocus={() => document.querySelector<HTMLElement>("[data-dictation-history-list]")}
      >
        <DialogHeader>
          <DialogTitle>Dictation history</DialogTitle>
        </DialogHeader>
        <HistoryContent
          dictateShortcutLabel={props.dictateShortcutLabel}
          onInsert={(text) => {
            pendingInsertRef.current = text;
            props.onOpenChange(false);
          }}
        />
      </DialogPopup>
    </Dialog>
  );
}
