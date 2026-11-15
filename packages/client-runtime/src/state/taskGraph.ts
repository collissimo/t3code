import type {
  OrchestrationV2Run,
  OrchestrationV2Subagent,
  OrchestrationV2ThreadProjection,
  OrchestrationV2WorkflowAgent,
} from "@t3tools/contracts";
import { copySorted } from "@t3tools/shared/Array";
import * as DateTime from "effect/DateTime";

import { formatSubagentDisplayTitle } from "./subagentDisplay.ts";
import { promptTitle } from "./subagentRuntime.ts";
import { resolveActiveThreadRun } from "./threadWorkflows.ts";

type Projection = Pick<
  OrchestrationV2ThreadProjection,
  "runs" | "messages" | "plans" | "subagents"
>;

export type TaskGraphStatus = "pending" | "running" | "completed" | "failed" | "stopped";

export interface TaskGraphNode {
  readonly id: string;
  readonly kind: "prompt" | "step" | "agent" | "phase";
  readonly label: string;
  readonly status: TaskGraphStatus;
  readonly children: ReadonlyArray<TaskGraphNode>;
  /** Share of finished leaves below this node, 0 to 1; 1 for a finished leaf. */
  readonly progress: number;
}

export interface TaskGraph {
  readonly root: TaskGraphNode;
  readonly leafCount: number;
  readonly completedLeafCount: number;
  /** The deepest nodes still working, in reading order. */
  readonly running: ReadonlyArray<TaskGraphNode>;
}

const RUN_STATUS: Record<OrchestrationV2Run["status"], TaskGraphStatus> = {
  preparing: "running",
  queued: "pending",
  starting: "running",
  running: "running",
  waiting: "running",
  completed: "completed",
  interrupted: "stopped",
  failed: "failed",
  cancelled: "stopped",
  rolled_back: "stopped",
};

const SUBAGENT_STATUS: Record<OrchestrationV2Subagent["status"], TaskGraphStatus> = {
  pending: "pending",
  running: "running",
  waiting: "running",
  // An idle agent finished its turn and only waits to be addressed again.
  idle: "completed",
  completed: "completed",
  failed: "failed",
  cancelled: "stopped",
  interrupted: "stopped",
};

const WORKFLOW_AGENT_STATUS: Record<OrchestrationV2WorkflowAgent["state"], TaskGraphStatus> = {
  queued: "pending",
  running: "running",
  completed: "completed",
  failed: "failed",
};

function node(
  input: Omit<TaskGraphNode, "progress" | "status"> & { readonly status?: TaskGraphStatus },
): TaskGraphNode {
  const leaves = input.children.length === 0 ? null : collectLeaves(input.children);
  const status = input.status ?? statusFromChildren(input.children);
  const progress =
    leaves === null
      ? status === "completed"
        ? 1
        : 0
      : leaves.filter((leaf) => leaf.status === "completed").length / leaves.length;
  return { ...input, status, progress };
}

/** A grouping node without a status of its own reads as its children's state. */
function statusFromChildren(children: ReadonlyArray<TaskGraphNode>): TaskGraphStatus {
  if (children.some((child) => child.status === "running")) return "running";
  if (children.every((child) => child.status === "completed")) return "completed";
  if (children.some((child) => child.status === "failed")) return "failed";
  if (children.every((child) => child.status === "pending")) return "pending";
  if (children.some((child) => child.status === "pending")) return "running";
  return "stopped";
}

function collectLeaves(nodes: ReadonlyArray<TaskGraphNode>): TaskGraphNode[] {
  return nodes.flatMap((child) =>
    child.children.length === 0 ? [child] : collectLeaves(child.children),
  );
}

/** A working agent whose own agents are all settled still counts as working itself. */
function activeWork(nodes: ReadonlyArray<TaskGraphNode>): TaskGraphNode[] {
  return nodes.flatMap((child) => {
    if (child.status !== "running") return [];
    const deeper = activeWork(child.children);
    return deeper.length > 0 ? deeper : [child];
  });
}

function firstLine(text: string): string {
  return (
    text
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line.length > 0) ?? ""
  );
}

function workflowChildren(subagent: OrchestrationV2Subagent): TaskGraphNode[] {
  const workflow = subagent.workflow;
  if (workflow === undefined) return [];
  const agentNode = (agent: OrchestrationV2WorkflowAgent) =>
    node({
      id: `${subagent.id}:agent:${agent.index}`,
      kind: "agent",
      label: agent.label,
      status: WORKFLOW_AGENT_STATUS[agent.state],
      children: [],
    });
  const agents = copySorted(workflow.agents, (a, b) => a.index - b.index);
  if (workflow.phases.length === 0) return agents.map(agentNode);
  const phased = copySorted(workflow.phases, (a, b) => a.index - b.index).flatMap((phase) => {
    const members = agents.filter((agent) => agent.phaseIndex === phase.index);
    return members.length === 0
      ? []
      : [
          node({
            id: `${subagent.id}:phase:${phase.index}`,
            kind: "phase",
            label: phase.title,
            children: members.map(agentNode),
          }),
        ];
  });
  const phaseIndexes = new Set(workflow.phases.map((phase) => phase.index));
  const unphased = agents.filter(
    (agent) => agent.phaseIndex === undefined || !phaseIndexes.has(agent.phaseIndex),
  );
  return [...phased, ...unphased.map(agentNode)];
}

function startOrder(subagent: OrchestrationV2Subagent): number {
  return DateTime.toEpochMillis(subagent.startedAt ?? subagent.updatedAt);
}

/**
 * The newest turn as a tree: the prompt, the agent's to-do steps, and the agents it started.
 * Agents nest under the agent that started them, and a workflow under its phases.
 * Null while the turn has neither steps nor agents to show.
 */
export function deriveTaskGraph(projection: Projection): TaskGraph | null {
  const run =
    resolveActiveThreadRun(projection) ??
    projection.runs.reduce<OrchestrationV2Run | null>(
      (latest, candidate) =>
        candidate.startedAt !== null &&
        candidate.status !== "rolled_back" &&
        (latest === null || candidate.ordinal > latest.ordinal)
          ? candidate
          : latest,
      null,
    );
  if (run === null) return null;

  const runStatus = RUN_STATUS[run.status];
  const runEnded = runStatus !== "running" && runStatus !== "pending";
  const todo = projection.plans.findLast(
    (plan) => plan.runId === run.id && plan.kind === "todo_list" && plan.status !== "superseded",
  );
  const steps =
    todo?.kind === "todo_list"
      ? todo.steps.map((step) =>
          node({
            id: `step:${step.id}`,
            kind: "step",
            label: step.text,
            // Providers leave the last step running when a turn is stopped.
            status: runEnded && step.status === "running" ? runStatus : step.status,
            children: [],
          }),
        )
      : [];

  const subagents = copySorted(
    projection.subagents.filter((subagent) => subagent.runId === run.id),
    (a, b) => startOrder(a) - startOrder(b) || a.id.localeCompare(b.id),
  );
  const subagentIds = new Set<string>(subagents.map((subagent) => subagent.id));
  const agentNode = (subagent: OrchestrationV2Subagent): TaskGraphNode =>
    node({
      id: subagent.id,
      kind: "agent",
      label: formatSubagentDisplayTitle(subagent.title ?? promptTitle(firstLine(subagent.prompt))),
      status: SUBAGENT_STATUS[subagent.status],
      children: [
        ...workflowChildren(subagent),
        ...subagents.filter((child) => child.parentNodeId === subagent.id).map(agentNode),
      ],
    });
  const agents = subagents
    .filter((subagent) => !subagentIds.has(subagent.parentNodeId))
    .map(agentNode);

  const children = [...steps, ...agents];
  if (children.length === 0) return null;

  const message = projection.messages.find((candidate) => candidate.id === run.userMessageId);
  const root = node({
    id: run.id,
    kind: "prompt",
    label:
      message === undefined || message.workflowScript
        ? "Prompt"
        : promptTitle(firstLine(message.text)) || "Prompt",
    status: runStatus,
    children,
  });
  const leaves = collectLeaves(children);
  return {
    root,
    leafCount: leaves.length,
    completedLeafCount: leaves.filter((leaf) => leaf.status === "completed").length,
    running: activeWork(children),
  };
}
