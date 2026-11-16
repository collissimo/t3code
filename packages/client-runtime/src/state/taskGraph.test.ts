import { describe, expect, it } from "vite-plus/test";
import {
  MessageId,
  NodeId,
  PlanId,
  RunId,
  type OrchestrationV2PlanStep,
  type OrchestrationV2Subagent,
  type OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import { deriveTaskGraph, type TaskGraphNode } from "./taskGraph.ts";

type Projection = Pick<
  OrchestrationV2ThreadProjection,
  "runs" | "messages" | "plans" | "subagents"
>;

const at = (seconds: number) => DateTime.makeUnsafe(Date.UTC(2026, 5, 20, 0, 0, seconds));

const run = (id: string, ordinal: number, status: string, started = true) =>
  ({
    id: RunId.make(id),
    ordinal,
    status,
    userMessageId: MessageId.make(`message-${id}`),
    startedAt: started ? at(0) : null,
  }) as unknown as Projection["runs"][number];

const message = (runId: string, text: string) =>
  ({ id: MessageId.make(`message-${runId}`), text }) as unknown as Projection["messages"][number];

const todo = (runId: string, steps: ReadonlyArray<Omit<OrchestrationV2PlanStep, "id">>) =>
  ({
    id: PlanId.make(`plan-${runId}`),
    runId: RunId.make(runId),
    kind: "todo_list",
    status: "active",
    steps: steps.map((step, index) => ({ ...step, id: `step-${index}` })),
  }) as unknown as Projection["plans"][number];

const agent = (
  id: string,
  overrides: Partial<OrchestrationV2Subagent> = {},
): OrchestrationV2Subagent =>
  ({
    id: NodeId.make(id),
    runId: RunId.make("run-1"),
    parentNodeId: NodeId.make("root-node"),
    prompt: `Prompt for ${id}`,
    title: id,
    status: "running",
    startedAt: at(1),
    updatedAt: at(1),
    ...overrides,
  }) as OrchestrationV2Subagent;

const shape = (node: TaskGraphNode): unknown =>
  node.children.length === 0
    ? `${node.label}:${node.status}`
    : { [`${node.label}:${node.status}`]: node.children.map(shape) };

describe("deriveTaskGraph", () => {
  it("nests steps, started agents, their agents, and workflow phases under the prompt", () => {
    const graph = deriveTaskGraph({
      runs: [run("run-1", 1, "running")],
      messages: [message("run-1", "\n  Build the graph\nwith details")],
      plans: [
        todo("run-1", [
          { text: "Read code", status: "completed" },
          { text: "Write code", status: "running" },
          { text: "Test", status: "pending" },
        ]),
      ],
      subagents: [
        agent("child", {
          parentNodeId: NodeId.make("lead"),
          status: "completed",
          startedAt: at(3),
        }),
        agent("lead", { startedAt: at(2) }),
        agent("review", {
          startedAt: at(4),
          workflow: {
            phases: [
              { index: 0, title: "Review" },
              { index: 1, title: "Verify" },
            ],
            agents: [
              { index: 1, label: "verify", state: "queued", phaseIndex: 1 },
              { index: 0, label: "bugs", state: "completed", phaseIndex: 0 },
            ],
          },
        }),
        agent("other-turn", { runId: RunId.make("run-0") }),
      ],
    });

    expect(graph && shape(graph.root)).toEqual({
      "Build the graph:running": [
        "Read code:completed",
        "Write code:running",
        "Test:pending",
        { "lead:running": ["child:completed"] },
        {
          "review:running": [
            { "Review:completed": ["bugs:completed"] },
            { "Verify:pending": ["verify:pending"] },
          ],
        },
      ],
    });
    expect(graph?.root.progress).toBeCloseTo(3 / 6);
    expect(graph?.running.map((node) => node.label)).toEqual(["Write code", "lead", "review"]);
  });

  it("follows the newest started turn, stops the step it left running, and keeps a stepless turn", () => {
    const projection: Projection = {
      runs: [
        run("run-2", 2, "interrupted"),
        run("run-1", 1, "completed"),
        run("run-3", 3, "queued", false),
      ],
      messages: [message("run-2", "Second")],
      plans: [
        todo("run-1", [{ text: "Old", status: "completed" }]),
        todo("run-2", [
          { text: "Done", status: "completed" },
          { text: "Half", status: "running" },
          { text: "Later", status: "pending" },
        ]),
      ],
      subagents: [],
    };

    const graph = deriveTaskGraph(projection);
    expect(graph && shape(graph.root)).toEqual({
      "Second:stopped": ["Done:completed", "Half:stopped", "Later:pending"],
    });
    const promptOnly = deriveTaskGraph({ ...projection, plans: [] });
    expect(promptOnly && shape(promptOnly.root)).toBe("Second:stopped");
    expect(promptOnly?.leafCount).toBe(0);
    expect(deriveTaskGraph({ ...projection, runs: [] })).toBeNull();
  });
});
