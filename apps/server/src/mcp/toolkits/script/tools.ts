import { OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { McpSchema, Tool, Toolkit } from "effect/ai";

import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

export const SCRIPT_TOOL_NAME = "script";

const ScriptTool = Tool.make(SCRIPT_TOOL_NAME, {
  description: `Run one JavaScript program that makes many tool calls. Only what it passes to \`text(...)\` returns to you, so filter and count in the program. Requires a full-access thread. There is no Node, console, timer, file, or network access besides \`tools\`: \`await tools.read(path)\` returns text; \`tools.write({path, content})\`; \`tools.exec(command)\` or \`tools.exec({command, timeoutMs})\` returns \`{stdout, stderr, exitCode, timedOut}\` from cmd.exe on Windows and sh elsewhere; \`tools.grep(pattern)\` or \`tools.grep({pattern, path, glob, ignoreCase})\` searches git-tracked and new files and returns \`{matches: [{path, line, text}], truncated}\`; and any T3 tool by name, such as \`tools.t3_thread_list({})\`. Other MCP servers are not reachable. Relative paths start at the thread's workspace. A failed call rejects, so use \`Promise.allSettled\` to keep a batch going. At most 16 calls run at once, 1,000 per script, and the script stops after 5 minutes.`,
  parameters: Schema.Struct({
    code: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200_000)).annotate({
      description: "Raw JavaScript, run as the body of an async function. Top-level await works.",
    }),
  }),
  success: Schema.Struct({
    status: Schema.Literals(["completed", "failed", "timed_out"]),
    output: Schema.String,
    outputTruncated: Schema.Boolean,
    error: Schema.optional(Schema.String),
    toolCalls: Schema.Int,
    failedToolCalls: Schema.Int,
    elapsedMs: Schema.Int,
  }),
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
  ],
})
  .annotate(Tool.Title, "Run script")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, true)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, true)
  .annotate(McpSchema.EnabledWhen, McpInvocationContext.hiddenWhileScriptToolOff);

export const ScriptToolkit = Toolkit.make(ScriptTool);
