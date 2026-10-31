import * as Effect from "effect/Effect";
import { Command } from "effect/cli";

import { runScriptSandboxWorker } from "../script/scriptSandboxWorker.ts";

/** Single-executable builds lack Node, so they use this subcommand instead of script-sandbox-worker.mjs. */
export const scriptSandboxCommand = Command.make("__script-sandbox", {}).pipe(
  Command.unlisted,
  Command.withHandler(() => Effect.promise(() => runScriptSandboxWorker())),
);
