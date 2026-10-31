import { CircleStopIcon, HistoryIcon, ScreenShareIcon, Trash2Icon } from "lucide-react";

import {
  cancelScrawl,
  getScrawlState,
  isScrawlAvailable,
  toggleScrawl,
} from "../../scrawl/scrawlCapture";
import { setScrawlHistoryOpen } from "../../scrawl/scrawlHistory";
import { ITEM_ICON_CLASS, type CommandPaletteActionItem } from "../CommandPalette.logic";

export function scrawlPaletteItems(): ReadonlyArray<CommandPaletteActionItem> {
  if (!isScrawlAvailable()) return [];
  const { phase } = getScrawlState();
  const past: CommandPaletteActionItem = {
    kind: "action",
    value: "action:scrawl-history",
    searchTerms: ["past screen captures", "scrawl history", "recordings", "reopen capture"],
    title: "Past screen captures",
    icon: <HistoryIcon className={ITEM_ICON_CLASS} />,
    shortcutCommand: "scrawl.history",
    run: async () => setScrawlHistoryOpen(true),
  };
  if (phase === "recording") {
    return [
      {
        kind: "action",
        value: "action:scrawl-finish",
        searchTerms: ["finish screen capture", "stop recording", "scrawl"],
        title: "Finish screen capture",
        icon: <CircleStopIcon className={ITEM_ICON_CLASS} />,
        run: async () => toggleScrawl(),
      },
      {
        kind: "action",
        value: "action:scrawl-discard",
        searchTerms: ["discard screen capture", "cancel recording", "scrawl"],
        title: "Discard screen capture",
        icon: <Trash2Icon className={ITEM_ICON_CLASS} />,
        run: async () => {
          cancelScrawl();
        },
      },
      past,
    ];
  }
  if (phase !== "idle") return [past];
  return [
    {
      kind: "action",
      value: "action:scrawl-start",
      searchTerms: ["capture the screen", "screen recording", "record screen", "scrawl"],
      title: "Capture the screen",
      icon: <ScreenShareIcon className={ITEM_ICON_CLASS} />,
      run: async () => toggleScrawl(),
    },
    past,
  ];
}
