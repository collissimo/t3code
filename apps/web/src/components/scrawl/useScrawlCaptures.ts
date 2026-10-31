import type { ScrawlCaptureSummary } from "@t3tools/contracts";
import { useEffect, useState } from "react";

import { getScrawlHistoryState, subscribeScrawlHistory } from "../../scrawl/scrawlHistory";

/** The captures folder as the desktop app reads it, again whenever something changed it. */
export function useScrawlCaptures() {
  const [captures, setCaptures] = useState<ReadonlyArray<ScrawlCaptureSummary> | null>(null);
  const [failed, setFailed] = useState(false);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reads the folder over the desktop bridge, and follows changes made outside this component
  useEffect(() => {
    let request = 0;
    const load = () => {
      const current = ++request;
      void window.desktopBridge?.scrawlListCaptures?.().then(
        (list) => {
          if (current !== request) return;
          setCaptures(list.filter((capture) => capture.status !== "recording"));
          setFailed(false);
        },
        () => {
          if (current === request) setFailed(true);
        },
      );
    };
    load();
    let revision = getScrawlHistoryState().revision;
    const unsubscribe = subscribeScrawlHistory(() => {
      const next = getScrawlHistoryState().revision;
      if (next === revision) return;
      revision = next;
      load();
    });
    return () => {
      request = -1;
      unsubscribe();
    };
  }, []);

  return { captures, failed };
}
