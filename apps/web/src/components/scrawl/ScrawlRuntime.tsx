import { useAtomValue } from "@effect/atom-react";
import { SCRAWL_TOGGLE_ACTION } from "@t3tools/contracts";
import { useEffect, useSyncExternalStore } from "react";

import { resolveShortcutCommand } from "../../keybindings";
import { getTerminalFocusOwner } from "../../lib/terminalFocus";
import { isScrawlAvailable, toggleScrawl } from "../../scrawl/scrawlCapture";
import {
  getScrawlHistoryState,
  isScrawlHistoryOpen,
  setScrawlHistoryOpen,
  subscribeScrawlHistory,
} from "../../scrawl/scrawlHistory";
import { rebuildUnfinishedCaptures } from "../../scrawl/scrawlRecovery";
import { primaryServerKeybindingsAtom } from "../../state/server";
import { ScrawlHistoryDialog } from "./ScrawlHistoryDialog";

/**
 * Lives as long as the app shell, because captures do: the shortcut works on pages without a
 * composer, and captures the app went down on are rebuilt at launch whatever page opens first.
 */
export function ScrawlRuntime() {
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const { open } = useSyncExternalStore(subscribeScrawlHistory, getScrawlHistoryState);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- subscribes to the global shortcut, which arrives as a desktop menu action
  useEffect(
    () =>
      window.desktopBridge?.onMenuAction((action) => {
        if (action === SCRAWL_TOGGLE_ACTION) toggleScrawl();
      }),
    [],
  );

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- starts the one rebuild pass of this page load, which runs outside React
  useEffect(() => {
    if (!isScrawlAvailable()) return;
    void rebuildUnfinishedCaptures().catch((error: unknown) => {
      console.warn("scrawl: unfinished captures could not be listed", error);
    });
  }, []);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- window keydown listener for the past captures keybinding
  useEffect(() => {
    if (!isScrawlAvailable()) return;
    const handler = (event: KeyboardEvent) => {
      if (event.target instanceof HTMLElement && event.target.closest("[data-keybinding-capture]"))
        return;
      const command = resolveShortcutCommand(event, keybindings, {
        context: { terminalFocus: getTerminalFocusOwner() !== null },
      });
      if (command !== "scrawl.history") return;
      event.preventDefault();
      event.stopPropagation();
      if (!event.repeat) setScrawlHistoryOpen(!isScrawlHistoryOpen());
    };
    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  }, [keybindings]);

  return open ? <ScrawlHistoryDialog /> : null;
}
