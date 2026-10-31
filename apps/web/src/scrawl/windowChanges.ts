// Ordinary windows opening and closing between two looks at the screen, by app name. Titles stay in
// scrawl.json: this is what reaches the agent.

import type { ScrawlWindowSnapshot } from "@t3tools/contracts";

import type { CaptureEvent } from "./narration";

// More than this changing at once is a virtual desktop switch, not several things happening.
const WINDOW_BURST = 4;

export function windowChanges(
  snapshots: ReadonlyArray<ScrawlWindowSnapshot>,
): Array<CaptureEvent & { readonly kind: "window" }> {
  const normal = (snapshot: ScrawlWindowSnapshot) =>
    snapshot.windows.filter((window) => window.layer === 0 && window.regular !== false);
  const changes: Array<CaptureEvent & { readonly kind: "window" }> = [];
  for (let index = 1; index < snapshots.length; index++) {
    const before = normal(snapshots[index - 1]!);
    const after = normal(snapshots[index]!);
    const t = snapshots[index]!.t;
    const opened = after.filter((window) => !before.some((other) => other.id === window.id));
    const closed = before.filter((window) => !after.some((other) => other.id === window.id));
    if (opened.length + closed.length > WINDOW_BURST) {
      changes.push({
        kind: "window",
        t,
        text: `on-screen windows changed (${opened.length} opened, ${closed.length} closed)`,
      });
      continue;
    }
    for (const window of closed) {
      changes.push({ kind: "window", t, text: `${window.app} window closed` });
    }
    for (const window of opened) {
      changes.push({ kind: "window", t, text: `${window.app} window opened` });
    }
  }
  return changes;
}
