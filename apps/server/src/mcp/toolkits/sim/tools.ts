import { OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { McpSchema, Tool, Toolkit } from "effect/ai";

import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import {
  SIM_ACTIONS,
  SIM_DEPENDS,
  SIM_LINK_KINDS,
  SIM_RESULTS,
  SIM_SOURCES,
  SimAuditService,
  SimService,
} from "../../../sim/SimContracts.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

export const SIM_TOOL_NAMES: ReadonlySet<string> = new Set([
  "sim_read",
  "sim_write",
  "sim_apply_harness_change",
]);

const shared = {
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
    SimService,
    SimAuditService,
  ],
};

const Strings = Schema.Array(Schema.String);
const ChangeAction = Schema.Literals(SIM_ACTIONS);

const attemptFields = {
  problem: Schema.optionalKey(Schema.String),
  new: Schema.optionalKey(Schema.String),
  what: Schema.optionalKey(Schema.String),
  why: Schema.optionalKey(Schema.String),
  files: Schema.optionalKey(Strings),
  anchor: Schema.optionalKey(Schema.String),
  supersedes: Schema.optionalKey(Strings),
  depends_on: Schema.optionalKey(Schema.Array(Schema.Literals(SIM_DEPENDS))),
  predicted: Schema.optionalKey(Strings),
  expect: Schema.optionalKey(Schema.String),
  policy: Schema.optionalKey(Schema.String),
  domain: Schema.optionalKey(Schema.String),
  harness: Schema.optionalKey(Schema.String),
};

const SimReadTool = Tool.make("sim_read", {
  ...shared,
  description:
    "Read the SIM record of harness changes (AGENTS.md, CLAUDE.md, notes, hooks). Actions: index, show (ids, brief), brief_all, find (query), by_file (file), check, review (policy, harness), audit (since|days, limit, includeClaudeLogs), inspect_thread (threadId). Reading records server-side read state that harness edits and SIM writes require.",
  parameters: Schema.Struct({
    action: Schema.Literals([
      "index",
      "show",
      "brief_all",
      "find",
      "by_file",
      "check",
      "review",
      "audit",
      "inspect_thread",
    ]),
    ids: Schema.optionalKey(Strings),
    brief: Schema.optionalKey(Schema.Boolean),
    query: Schema.optionalKey(Schema.String),
    file: Schema.optionalKey(Schema.String),
    policy: Schema.optionalKey(Schema.String),
    harness: Schema.optionalKey(Schema.String),
    page: Schema.optionalKey(Schema.Int),
    since: Schema.optionalKey(Schema.String),
    days: Schema.optionalKey(Schema.Number),
    limit: Schema.optionalKey(Schema.Int),
    includeClaudeLogs: Schema.optionalKey(Schema.Boolean),
    threadId: Schema.optionalKey(Schema.String),
  }),
  success: Schema.Struct({
    action: Schema.String,
    text: Schema.String,
    failed: Schema.optionalKey(Schema.Boolean),
    advisorEscalation: Schema.optionalKey(Schema.Unknown),
    summary: Schema.optionalKey(Schema.Unknown),
  }),
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(McpSchema.EnabledWhen, McpInvocationContext.hiddenWhileSimOff);

const SimWriteTool = Tool.make("sim_write", {
  ...shared,
  description:
    "Record SIM entries. attempt: changeAction, what, why, problem or new (root cause), files, predicted, expect. observe: attempt (A-id), result, evidence, source. amend: amendTarget, field, value, reason. retract: attempt, reason, outcome?, undo?. link: a, kind, b. merge: from, into. carry: from*/to* policy|domain|harness. mark_audit_done. The server sets session identity; a `fixed` you grade on your own thread's or fork's change stays not confirmed.",
  parameters: Schema.Struct({
    action: Schema.Literals([
      "attempt",
      "observe",
      "amend",
      "retract",
      "link",
      "merge",
      "carry",
      "mark_audit_done",
    ]),
    ...attemptFields,
    changeAction: Schema.optionalKey(ChangeAction),
    accepted: Schema.optionalKey(Schema.Boolean),
    rejected_because: Schema.optionalKey(Schema.String),
    unanswered: Schema.optionalKey(Schema.Boolean),
    backfilled: Schema.optionalKey(Schema.Boolean),
    round: Schema.optionalKey(Schema.String),
    sample: Schema.optionalKey(Schema.String),
    attempt: Schema.optionalKey(Schema.String),
    target: Schema.optionalKey(Schema.String),
    result: Schema.optionalKey(Schema.Literals(SIM_RESULTS)),
    evidence: Schema.optionalKey(Schema.String),
    source: Schema.optionalKey(Schema.Literals(SIM_SOURCES)),
    date: Schema.optionalKey(Schema.String),
    amendTarget: Schema.optionalKey(Schema.String),
    field: Schema.optionalKey(Schema.String),
    value: Schema.optionalKey(Schema.Union([Schema.String, Strings])),
    reason: Schema.optionalKey(Schema.String),
    outcome: Schema.optionalKey(Schema.Int),
    undo: Schema.optionalKey(Schema.Boolean),
    a: Schema.optionalKey(Schema.String),
    b: Schema.optionalKey(Schema.String),
    kind: Schema.optionalKey(Schema.Literals(SIM_LINK_KINDS)),
    from: Schema.optionalKey(Schema.String),
    into: Schema.optionalKey(Schema.String),
    fromPolicy: Schema.optionalKey(Schema.String),
    toPolicy: Schema.optionalKey(Schema.String),
    fromDomain: Schema.optionalKey(Schema.String),
    toDomain: Schema.optionalKey(Schema.String),
    fromHarness: Schema.optionalKey(Schema.String),
    toHarness: Schema.optionalKey(Schema.String),
    note: Schema.optionalKey(Schema.String),
  }),
  success: Schema.Struct({
    action: Schema.String,
    text: Schema.String,
    problemId: Schema.optionalKey(Schema.String),
    attemptId: Schema.optionalKey(Schema.String),
    settled: Schema.optionalKey(Schema.Boolean),
    unconfirmedReason: Schema.optionalKey(Schema.String),
  }),
})
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(McpSchema.EnabledWhen, McpInvocationContext.hiddenFromOutsideClientsOrSimOff);

const SimApplyHarnessChangeTool = Tool.make("sim_apply_harness_change", {
  ...shared,
  description:
    "Edit one harness file inside the configured harness directory or workspace (AGENTS.md, CLAUDE.md, notes, hooks, skills, agents, commands, output-styles) and record its SIM attempt in one call. Replace oldText with newText, or write content (append to add it). Needs a prior sim_read of index or by_file (plus relevant entries) in this context; refuses drift and SIM record files. Live edits require full-access/default mode; dryRun previews the diff in any mode.",
  parameters: Schema.Struct({
    file: Schema.String,
    oldText: Schema.optionalKey(Schema.String),
    newText: Schema.optionalKey(Schema.String),
    content: Schema.optionalKey(Schema.String),
    append: Schema.optionalKey(Schema.Boolean),
    dryRun: Schema.optionalKey(Schema.Boolean),
    attempt: Schema.Struct({
      ...attemptFields,
      action: ChangeAction,
      what: Schema.String,
      why: Schema.String,
    }),
  }),
  success: Schema.Struct({
    dryRun: Schema.Boolean,
    file: Schema.String,
    text: Schema.String,
    brief: Schema.optionalKey(Schema.String),
    predictionLine: Schema.optionalKey(Schema.String),
    diffPreview: Schema.optionalKey(Schema.String),
    problemId: Schema.optionalKey(Schema.String),
    attemptId: Schema.optionalKey(Schema.String),
  }),
})
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, true)
  .annotate(McpSchema.EnabledWhen, McpInvocationContext.hiddenFromOutsideClientsOrSimOff);

export const SimToolkit = Toolkit.make(SimReadTool, SimWriteTool, SimApplyHarnessChangeTool);
