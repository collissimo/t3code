import type { ScrawlCaptureSummary } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import {
  CheckIcon,
  CopyIcon,
  CornerDownLeftIcon,
  FolderOpenIcon,
  PinIcon,
  PinOffIcon,
  RotateCcwIcon,
  Trash2Icon,
} from "lucide-react";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";

import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import { useClientSettings } from "../../hooks/useSettings";
import { hasScrawlComposer, insertPastCapture } from "../../scrawl/scrawlCapture";
import { readCaptureFile } from "../../scrawl/scrawlFiles";
import {
  captureFate,
  captureListChanged,
  captureTitle,
  formatBytes,
  formatDuration,
  getScrawlHistoryState,
  setScrawlHistoryOpen,
  subscribeScrawlHistory,
} from "../../scrawl/scrawlHistory";
import { rebuildCapture } from "../../scrawl/scrawlRecovery";
import { cn } from "~/lib/utils";
import { Button } from "../ui/button";
import { Dialog, DialogFooter, DialogHeader, DialogPopup, DialogTitle } from "../ui/dialog";
import { ScrollArea } from "../ui/scroll-area";
import { useScrawlCaptures } from "./useScrawlCaptures";

const RETENTION_SUMMARY = {
  week: "Video stays for 7 days, the rest for 30. Pinned captures stay",
  month: "Video stays for 30 days, the rest for 90. Pinned captures stay",
  forever: "Captures stay until you delete them",
} as const;

const dayLabel = (timestamp: number, now: Date) => {
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
};

/** Reads the sheet only once its row scrolls into view; a long history must open at once. */
function useContactSheetUrl(id: string, enabled: boolean) {
  const [url, setUrl] = useState<string | null>(null);
  const [visible, setVisible] = useState(false);
  const targetRef = useRef<HTMLDivElement>(null);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- watches the row's visibility with an IntersectionObserver
  useEffect(() => {
    const target = targetRef.current;
    if (target === null || !enabled) return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) setVisible(true);
    });
    observer.observe(target);
    return () => observer.disconnect();
  }, [enabled]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reads the image from disk over the bridge and owns its object URL
  useEffect(() => {
    const read = window.desktopBridge?.scrawlReadFile;
    if (!visible || read === undefined) return;
    let cancelled = false;
    let created: string | null = null;
    void readCaptureFile(read, id, "contact-sheet.png", "image/png").then(
      (blob) => {
        if (cancelled) return;
        created = URL.createObjectURL(blob);
        setUrl(created);
      },
      // Without a sheet the row just has no picture.
      () => undefined,
    );
    return () => {
      cancelled = true;
      if (created !== null) URL.revokeObjectURL(created);
    };
  }, [id, visible]);

  return { url, targetRef };
}

function CaptureRow(props: {
  readonly capture: ScrawlCaptureSummary;
  readonly heading: string | null;
  readonly building: boolean;
  readonly now: number;
  readonly composerOnScreen: boolean;
  readonly onChanged: () => void;
  readonly onError: (message: string) => void;
  readonly onInsert: (capture: ScrawlCaptureSummary) => void;
}) {
  const { capture, building, onChanged, onError } = props;
  const built = capture.status === "built";
  const { url, targetRef } = useContactSheetUrl(capture.id, built);
  const [expanded, setExpanded] = useState(false);
  const { copyToClipboard, isCopied } = useCopyToClipboard();
  const bridge = window.desktopBridge;
  const fate = captureFate(capture, props.now);
  const title = captureTitle(capture);

  const act = (action: Promise<void> | undefined) => {
    void action?.then(onChanged, (error: unknown) =>
      onError(error instanceof Error ? error.message : String(error)),
    );
  };

  const copyText = () => {
    const read = bridge?.scrawlReadFile;
    if (read === undefined) return;
    void readCaptureFile(read, capture.id, "summary.md")
      .then((blob) => blob.text())
      .then(
        (text) => copyToClipboard(text.trimEnd(), undefined),
        () => onError("This capture has no text to copy"),
      );
  };

  return (
    <li className="[contain-intrinsic-size:auto_5rem] [content-visibility:auto]">
      {props.heading !== null ? (
        <h3 className="ps-6 pe-4 pt-4 pb-1 font-medium text-muted-foreground text-xs">
          {props.heading}
        </h3>
      ) : null}
      <div
        ref={targetRef}
        className="group flex items-start gap-3 ps-6 pe-4 py-3 hover:bg-accent/50 has-focus-visible:bg-accent/50"
      >
        <button
          type="button"
          data-scrawl-history-row
          aria-expanded={expanded}
          disabled={!built}
          className="flex min-w-0 flex-1 cursor-pointer items-start gap-3 text-left outline-none disabled:cursor-default"
          onClick={() => setExpanded((previous) => !previous)}
          onKeyDown={(event) => {
            if (event.key !== "Enter" || !built || !props.composerOnScreen) return;
            event.preventDefault();
            props.onInsert(capture);
          }}
        >
          <span className="block aspect-video w-24 shrink-0 overflow-hidden border border-border bg-muted">
            {url !== null ? <img src={url} alt="" className="size-full object-cover" /> : null}
          </span>
          <span className="block min-w-0 flex-1">
            <span className="block truncate text-sm">{title}</span>
            <span className="mt-1 flex flex-wrap gap-x-3 text-muted-foreground text-xs">
              <time dateTime={new Date(capture.createdAtMs).toISOString()}>
                {new Date(capture.createdAtMs).toLocaleTimeString(undefined, {
                  hour: "2-digit",
                  minute: "2-digit",
                })}
              </time>
              {capture.durationMs > 0 ? <span>{formatDuration(capture.durationMs)}</span> : null}
              <span>{formatBytes(capture.sizeBytes)}</span>
              {building ? (
                <span>Building</span>
              ) : capture.status === "failed" ? (
                <span className="text-destructive">Could not be rebuilt</span>
              ) : capture.status === "unfinished" ? (
                <span className="text-warning">Not built yet</span>
              ) : null}
              <span className={cn(fate.soon && "text-warning")}>{fate.text}</span>
            </span>
          </span>
        </button>
        <div className="flex shrink-0 opacity-0 group-hover:opacity-100 group-has-focus-visible:opacity-100 pointer-coarse:opacity-100">
          {built ? (
            <>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                disabled={!props.composerOnScreen}
                aria-label="Insert into composer"
                title={
                  props.composerOnScreen ? "Insert into composer (Enter)" : "Open a thread first"
                }
                onClick={() => props.onInsert(capture)}
              >
                <CornerDownLeftIcon />
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label="Copy text"
                title="Copy text"
                onClick={copyText}
              >
                {isCopied ? <CheckIcon /> : <CopyIcon />}
              </Button>
            </>
          ) : (
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              disabled={building}
              aria-label="Rebuild capture"
              title="Rebuild capture"
              onClick={() => act(rebuildCapture(capture.id))}
            >
              <RotateCcwIcon />
            </Button>
          )}
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={capture.pinned ? "Unpin capture" : "Pin capture"}
            aria-pressed={capture.pinned}
            title={capture.pinned ? "Unpin, so retention applies again" : "Pin, so it stays"}
            onClick={() =>
              act(bridge?.scrawlSetPinned?.({ id: capture.id, pinned: !capture.pinned }))
            }
          >
            {capture.pinned ? <PinOffIcon /> : <PinIcon />}
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label="Open folder"
            title="Open folder"
            onClick={() => act(bridge?.scrawlReveal?.({ id: capture.id }))}
          >
            <FolderOpenIcon />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            disabled={building}
            aria-label="Move to the bin"
            title="Move to the bin"
            onClick={() => act(bridge?.scrawlTrash?.({ id: capture.id }))}
          >
            <Trash2Icon />
          </Button>
        </div>
      </div>
      {expanded && url !== null ? (
        <img src={url} alt={`Contact sheet of ${title}`} className="w-full px-6 pb-3" />
      ) : null}
    </li>
  );
}

export function ScrawlHistoryDialog() {
  const retention = useClientSettings((settings) => settings.scrawlRetention);
  const navigate = useNavigate();
  const { building } = useSyncExternalStore(subscribeScrawlHistory, getScrawlHistoryState);
  const { captures, failed } = useScrawlCaptures();
  const [actionError, setActionError] = useState<string | null>(null);
  const error = failed ? "Past captures could not be read. Reopen this to try again" : actionError;
  const [nowDate] = useState(() => new Date());
  const pendingInsertRef = useRef<ScrawlCaptureSummary | null>(null);

  const close = () => setScrawlHistoryOpen(false);
  const composerOnScreen = hasScrawlComposer();

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) close();
      }}
      onOpenChangeComplete={(open) => {
        const capture = pendingInsertRef.current;
        if (open || capture === null) return;
        pendingInsertRef.current = null;
        void insertPastCapture(capture.id, capture.bundlePath);
      }}
    >
      <DialogPopup className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>Past screen captures</DialogTitle>
        </DialogHeader>
        <div className="h-[min(70vh,40rem)] min-h-0 border-y">
          <ScrollArea>
            {captures !== null && captures.length === 0 ? (
              <p className="p-6 text-center text-muted-foreground text-sm">No captures yet</p>
            ) : null}
            <ul>
              {(captures ?? []).map((capture, index, all) => {
                const day = dayLabel(capture.createdAtMs, nowDate);
                const previous = all[index - 1];
                const continues =
                  previous !== undefined && dayLabel(previous.createdAtMs, nowDate) === day;
                return (
                  <CaptureRow
                    key={capture.id}
                    capture={capture}
                    heading={continues ? null : day}
                    building={building.has(capture.id)}
                    now={nowDate.getTime()}
                    composerOnScreen={composerOnScreen}
                    onChanged={() => {
                      setActionError(null);
                      captureListChanged();
                    }}
                    onError={setActionError}
                    onInsert={(target) => {
                      pendingInsertRef.current = target;
                      close();
                    }}
                  />
                );
              })}
            </ul>
          </ScrollArea>
        </div>
        <DialogFooter variant="bare">
          <p
            role={error !== null ? "alert" : undefined}
            className={cn(
              "min-w-0 flex-1 self-center text-xs",
              error !== null ? "text-destructive" : "text-muted-foreground",
            )}
          >
            {error ?? RETENTION_SUMMARY[retention]}
          </p>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => {
              close();
              void navigate({ to: "/settings/snap-shot" });
            }}
          >
            Change
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
