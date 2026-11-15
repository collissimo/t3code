import {
  deriveTaskGraph,
  type TaskGraphNode,
  type TaskGraphStatus,
} from "@t3tools/client-runtime/state/task-graph";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { CheckIcon, XIcon } from "lucide-react";

import { cn } from "../../lib/utils";
import { useQuietThreadProjection } from "../../state/entities";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { ThreadDetailsSection } from "./ThreadDetailsSection";

const SLOT = 26;
const NODE = 14;
const LEVEL = 32;
const PILL_GAP = 14;

const STATUS_LABEL: Record<TaskGraphStatus, string> = {
  pending: "Not started",
  running: "Working",
  completed: "Done",
  failed: "Failed",
  stopped: "Stopped",
};

const KIND_LABEL: Record<TaskGraphNode["kind"], string> = {
  prompt: "Prompt",
  step: "Step",
  agent: "Agent",
  phase: "Phase",
};

interface PlacedNode {
  readonly node: TaskGraphNode;
  readonly x: number;
  readonly y: number;
  readonly children: ReadonlyArray<PlacedNode>;
}

function slotCount(node: TaskGraphNode): number {
  return node.children.length === 0
    ? 1
    : node.children.reduce((sum, child) => sum + slotCount(child), 0);
}

/** Each leaf takes one slot; a parent sits centered over its children. */
function place(nodes: ReadonlyArray<TaskGraphNode>, depth: number, start: number): PlacedNode[] {
  let cursor = start;
  return nodes.map((node) => {
    const children = place(node.children, depth + 1, cursor);
    const x = children.length === 0 ? cursor + SLOT / 2 : (children[0]!.x + children.at(-1)!.x) / 2;
    cursor += slotCount(node) * SLOT;
    return { node, x, y: depth * LEVEL + NODE / 2, children };
  });
}

function flatten(nodes: ReadonlyArray<PlacedNode>): PlacedNode[] {
  return nodes.flatMap((placed) => [placed, ...flatten(placed.children)]);
}

/** Elbow connectors: down from the parent, across the children, down to each child. */
function connectorPath(parentX: number, parentBottom: number, children: ReadonlyArray<PlacedNode>) {
  if (children.length === 0) return "";
  const childTop = children[0]!.y - NODE / 2;
  const bus = (parentBottom + childTop) / 2;
  const left = Math.min(children[0]!.x, parentX);
  const right = Math.max(children.at(-1)!.x, parentX);
  return [
    `M${parentX} ${parentBottom}V${bus}`,
    `M${left} ${bus}H${right}`,
    ...children.map((child) => `M${child.x} ${bus}V${childTop}`),
  ].join("");
}

/** The current turn as a top-down tree: the prompt, its to-do steps, and the agents it started. */
export function ThreadTaskGraph({
  environmentId,
  threadId,
}: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}) {
  const structure = useQuietThreadProjection({ environmentId, threadId });
  const graph = structure === null ? null : deriveTaskGraph(structure.projection);
  if (graph === null) return null;

  const { root } = graph;
  const placed = place(root.children, 0, 0);
  const all = flatten(placed);
  const width = slotCount(root) * SLOT;
  const height = Math.max(...all.map((entry) => entry.y)) + NODE / 2;
  // The first connector starts at the prompt pill, which sits above the canvas.
  const path = [
    connectorPath(width / 2, -PILL_GAP, placed),
    ...all.map((entry) => connectorPath(entry.x, entry.y + NODE / 2, entry.children)),
  ].join("");
  const [current, ...others] = graph.running;

  return (
    <ThreadDetailsSection
      headingId="thread-details-task-graph-heading"
      title="Task progress"
      showHeading={false}
    >
      <div className="flex flex-col px-2.5 text-xs">
        <div className="flex h-6 min-w-0 items-center gap-2 rounded-full border border-border/65 px-2">
          <StatusDot node={root} />
          <span className="min-w-0 truncate text-foreground">{root.label}</span>
        </div>
        <div className="overflow-x-auto pb-1" style={{ paddingTop: PILL_GAP }}>
          <div className="relative mx-auto" style={{ width, height }}>
            <svg
              aria-hidden
              className="absolute inset-0 overflow-visible text-border"
              width={width}
              height={height}
            >
              <path d={path} fill="none" stroke="currentColor" strokeWidth={1} />
            </svg>
            {all.map((entry) => (
              <GraphNode key={entry.node.id} entry={entry} />
            ))}
          </div>
        </div>
        <div className="flex h-6 min-w-0 items-center gap-3">
          <span className="min-w-0 flex-1 truncate text-muted-foreground">
            {current !== undefined ? (
              <>
                Working on <span className="text-foreground">{current.label}</span>
                {others.length > 0 ? ` and ${others.length} more` : null}
              </>
            ) : (
              STATUS_LABEL[root.status]
            )}
          </span>
          <span
            className="shrink-0 font-medium text-muted-foreground tabular-nums"
            aria-label={`${graph.completedLeafCount} of ${graph.leafCount} done`}
          >
            {graph.completedLeafCount}/{graph.leafCount}
          </span>
        </div>
      </div>
    </ThreadDetailsSection>
  );
}

function GraphNode({ entry }: { readonly entry: PlacedNode }) {
  const { node } = entry;
  const leaves = node.children.length > 0 ? slotCount(node) : 0;
  const status =
    leaves > 0
      ? `${STATUS_LABEL[node.status]}, ${Math.round(node.progress * leaves)} of ${leaves} done`
      : STATUS_LABEL[node.status];
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            aria-label={`${KIND_LABEL[node.kind]}: ${node.label}, ${status}`}
            className="absolute flex size-6 -translate-x-1/2 -translate-y-1/2 cursor-default items-center justify-center rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
            style={{ left: entry.x, top: entry.y }}
          />
        }
      >
        <StatusDot node={node} />
      </TooltipTrigger>
      <TooltipPopup side="bottom">
        <div className="flex max-w-64 flex-col gap-0.5 text-xs">
          <span className="line-clamp-3 text-foreground">{node.label}</span>
          <span className="text-muted-foreground">{status}</span>
        </div>
      </TooltipPopup>
    </Tooltip>
  );
}

function StatusDot({ node }: { readonly node: TaskGraphNode }) {
  // A parent still working fills with the share of its leaves that are done.
  const partial = node.status === "running" && node.progress > 0;
  return (
    <span
      aria-hidden
      className={cn(
        "flex size-3.5 shrink-0 items-center justify-center rounded-full",
        node.status === "completed" && "bg-success text-background",
        node.status === "running" && "bg-warning/20 ring-2 ring-warning ring-inset",
        node.status === "pending" && "border border-dashed border-muted-foreground/70",
        node.status === "failed" && "bg-destructive text-background",
        node.status === "stopped" && "bg-muted-foreground/45",
      )}
      style={
        partial
          ? {
              backgroundImage: `conic-gradient(var(--success) ${node.progress * 360}deg, transparent 0)`,
            }
          : undefined
      }
    >
      {node.status === "completed" ? <CheckIcon className="size-2" strokeWidth={4} /> : null}
      {node.status === "failed" ? <XIcon className="size-2" strokeWidth={4} /> : null}
      {node.status === "running" && !partial ? (
        <span className="size-1 rounded-full bg-warning" />
      ) : null}
    </span>
  );
}
