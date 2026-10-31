import { SCRAWL_TOGGLE_ACTION } from "@t3tools/contracts";
import { LoaderCircleIcon, ScreenShareIcon } from "lucide-react";
import { useEffect, useSyncExternalStore } from "react";

import {
  getScrawlState,
  isScrawlAvailable,
  registerScrawlDelivery,
  subscribeScrawl,
  toggleScrawl,
  type ScrawlDelivery,
} from "../../scrawl/scrawlCapture";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

const NOTICE_TONES = {
  success: "text-success",
  warning: "text-warning",
  error: "text-destructive",
} as const;

const SHORTCUT = "Alt+Shift+S";

/** Records the screen with voice, clicks and ink. Only the desktop app can see the whole screen. */
export function ComposerScrawlButton(props: { readonly delivery: ScrawlDelivery }) {
  const { phase, notice } = useSyncExternalStore(subscribeScrawl, getScrawlState);
  const { delivery } = props;

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- offers this composer to a capture running outside React
  useEffect(() => registerScrawlDelivery(delivery), [delivery]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- subscribes to the global shortcut, which arrives as a desktop menu action
  useEffect(
    () =>
      window.desktopBridge?.onMenuAction((action) => {
        if (action === SCRAWL_TOGGLE_ACTION) toggleScrawl();
      }),
    [],
  );

  if (!isScrawlAvailable()) return null;
  const recording = phase === "recording";
  const busy = phase === "starting" || phase === "building";
  const status =
    phase === "building"
      ? "Building the capture"
      : recording
        ? `Recording this screen · ${SHORTCUT} finishes · Esc discards`
        : null;
  return (
    <>
      {status !== null || notice !== null ? (
        <div
          role="status"
          aria-live="polite"
          className="pointer-events-none absolute start-2 bottom-full z-20 mb-3 w-max max-w-[min(32rem,calc(100%-1rem))] rounded-lg border border-border bg-popover px-3 py-2 text-sm shadow-md"
        >
          {status !== null ? (
            <span className={recording ? "text-destructive" : "text-warning"}>{status}</span>
          ) : notice !== null ? (
            <span className={NOTICE_TONES[notice.tone]}>{notice.text}</span>
          ) : null}
        </div>
      ) : null}
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              type="button"
              variant={recording ? "destructive" : "ghost"}
              size="icon-sm"
              onPointerDown={(event) => event.preventDefault()}
              onClick={toggleScrawl}
              disabled={busy}
              aria-label={recording ? "Finish screen capture" : "Capture the screen"}
              aria-pressed={recording}
            />
          }
        >
          {busy ? <LoaderCircleIcon className="animate-spin" /> : <ScreenShareIcon />}
        </TooltipTrigger>
        <TooltipPopup>
          {recording ? `Finish capture (${SHORTCUT})` : `Capture the screen (${SHORTCUT})`}
        </TooltipPopup>
      </Tooltip>
    </>
  );
}
