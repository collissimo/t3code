import { OrchestratorMcpFailure, type ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import { McpSchema } from "effect/ai";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import { collectUint8StreamText } from "@t3tools/provider-core/server/collectStreamText";
// @effect-diagnostics-next-line nodeBuiltinImport:off - effect/Path has no glob matching.
import * as NodePath from "node:path";

import { threadWorkspaceRoot } from "../../../project/threadWorkspaceRoot.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../../../project/ProjectService.ts";
import * as ScriptRunner from "../../../script/ScriptRunner.ts";
import * as ServerSettings from "../../../serverSettings.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { assertFullAccess, assertLiveCaller, loadCaller } from "../../threadAccess.ts";
import { SCRIPT_TOOL_NAME, ScriptToolkit } from "./tools.ts";

const MAX_READ_BYTES = 10 * 1024 * 1024;
const MAX_EXEC_OUTPUT_BYTES = 2 * 1024 * 1024;
const DEFAULT_EXEC_TIMEOUT_MS = 120_000;
const MAX_GREP_MATCHES = 2_000;
const MAX_GREP_LINE_CHARS = 500;

const FULL_ACCESS_REQUIRED =
  "script needs a full-access thread, because its calls skip the provider's permission prompts.";

const refuse = (message: string) =>
  new OrchestratorMcpFailure({ code: "capability_denied", message });

const errorText = (error: unknown) =>
  error instanceof Error ? error.message : typeof error === "string" ? error : String(error);

const fieldsOf = (input: unknown, primary: string): Readonly<Record<string, unknown>> =>
  typeof input === "string"
    ? { [primary]: input }
    : typeof input === "object" && input !== null
      ? (input as Readonly<Record<string, unknown>>)
      : {};

const stringField = (fields: Readonly<Record<string, unknown>>, name: string, tool: string) =>
  typeof fields[name] === "string"
    ? Effect.succeed(fields[name])
    : Effect.fail(`tools.${tool} needs a string \`${name}\`.`);

const childFailure = (tool: string) => (error: unknown) => `tools.${tool}: ${errorText(error)}`;

/** Calls a T3 tool as the script's caller. McpHttpServer owns the MCP server, so it provides this. */
export class ScriptT3Tools extends Context.Service<
  ScriptT3Tools,
  {
    readonly call: (request: {
      readonly name: string;
      readonly arguments: object;
    }) => Effect.Effect<
      McpSchema.CallToolResult,
      McpSchema.InternalError | McpSchema.InvalidParams,
      McpSchema.McpServerClient
    >;
  }
>()("t3/mcp/toolkits/script/handlers/ScriptT3Tools") {}

export const layer = McpToolAccess.toLayer(
  ScriptToolkit,
  Effect.gen(function* () {
    const t3Tools = yield* ScriptT3Tools;
    const runner = yield* ScriptRunner.ScriptRunner;
    const settings = yield* ServerSettings.ServerSettingsService;
    const projects = yield* ProjectService.ProjectService;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

    const exec = Effect.fn("ScriptToolkit.exec")(
      function* (cwd: string, input: unknown) {
        const fields = fieldsOf(input, "command");
        const command = yield* stringField(fields, "command", "exec");
        const timeoutMs =
          typeof fields.timeoutMs === "number" && fields.timeoutMs > 0
            ? fields.timeoutMs
            : DEFAULT_EXEC_TIMEOUT_MS;
        const handle = yield* spawner.spawn(
          ChildProcess.make(command, [], {
            cwd,
            shell: true,
            forceKillAfter: Duration.seconds(1),
          }),
        );
        const collect = <E>(stream: Stream.Stream<Uint8Array, E>) =>
          collectUint8StreamText({
            stream,
            maxBytes: MAX_EXEC_OUTPUT_BYTES,
            truncatedMarker: "\n[output truncated]",
          });
        const finished = yield* Effect.all(
          [collect(handle.stdout), collect(handle.stderr), handle.exitCode],
          { concurrency: "unbounded" },
        ).pipe(Effect.timeoutOption(Duration.millis(timeoutMs)));
        if (Option.isNone(finished)) {
          return { stdout: "", stderr: "", exitCode: null, timedOut: true };
        }
        const [stdout, stderr, exitCode] = finished.value;
        return { stdout: stdout.text, stderr: stderr.text, exitCode, timedOut: false };
      },
      Effect.scoped,
      Effect.mapError(childFailure("exec")),
    );

    const read = Effect.fn("ScriptToolkit.read")(
      function* (cwd: string, input: unknown) {
        const target = path.resolve(
          cwd,
          yield* stringField(fieldsOf(input, "path"), "path", "read"),
        );
        const info = yield* fs.stat(target);
        if (info.size > MAX_READ_BYTES) {
          return yield* Effect.fail(`${target} is larger than ${MAX_READ_BYTES} bytes.`);
        }
        return yield* fs.readFileString(target);
      },
      Effect.mapError(childFailure("read")),
    );

    const write = Effect.fn("ScriptToolkit.write")(
      function* (cwd: string, input: unknown) {
        const fields = fieldsOf(input, "path");
        const target = path.resolve(cwd, yield* stringField(fields, "path", "write"));
        const content = yield* stringField(fields, "content", "write");
        yield* fs.makeDirectory(path.dirname(target), { recursive: true });
        yield* fs.writeFileString(target, content);
        return { path: target, bytes: Buffer.byteLength(content) };
      },
      Effect.mapError(childFailure("write")),
    );

    const grep = Effect.fn("ScriptToolkit.grep")(
      function* (cwd: string, input: unknown) {
        const fields = fieldsOf(input, "pattern");
        const pattern = yield* stringField(fields, "pattern", "grep");
        const regex = yield* Effect.try({
          try: () => new RegExp(pattern, fields.ignoreCase === true ? "i" : ""),
          catch: () => `\`${pattern}\` is not a valid regular expression.`,
        });
        const scope = typeof fields.path === "string" ? fields.path : ".";
        const glob = typeof fields.glob === "string" ? fields.glob : undefined;
        const listed = yield* exec(
          cwd,
          `git ls-files -co --exclude-standard -- "${scope.replaceAll('"', "")}"`,
        );
        if (listed.exitCode !== 0) {
          return yield* Effect.fail(`git could not list files here: ${listed.stderr.trim()}`);
        }
        const matches: Array<{ path: string; line: number; text: string }> = [];
        for (const file of listed.stdout.split(/\r?\n/)) {
          if (file.length === 0) continue;
          if (glob !== undefined && !NodePath.matchesGlob(file, glob)) continue;
          const target = path.resolve(cwd, file);
          const text = yield* fs.stat(target).pipe(
            Effect.flatMap((info) =>
              info.type === "File" && info.size <= MAX_READ_BYTES
                ? fs.readFileString(target)
                : Effect.succeed(""),
            ),
            // Binary, deleted, or unreadable files just don't match.
            Effect.orElseSucceed(() => ""),
          );
          for (const [index, line] of text.split(/\r?\n/).entries()) {
            if (!regex.test(line)) continue;
            if (matches.length === MAX_GREP_MATCHES) return { matches, truncated: true };
            matches.push({
              path: file,
              line: index + 1,
              text: line.slice(0, MAX_GREP_LINE_CHARS),
            });
          }
        }
        return { matches, truncated: false };
      },
      Effect.mapError(childFailure("grep")),
    );

    const t3Tool = Effect.fn("ScriptToolkit.t3Tool")(
      function* (name: string, input: unknown) {
        const client = yield* Effect.serviceOption(McpSchema.McpServerClient);
        if (Option.isNone(client)) return yield* Effect.fail("No MCP client for this call.");
        const result = yield* t3Tools
          .call({
            name,
            arguments: typeof input === "object" && input !== null ? input : {},
          })
          .pipe(Effect.provideService(McpSchema.McpServerClient, client.value));
        const text = result.content
          .flatMap((part) => (part.type === "text" ? [part.text] : []))
          .join("\n");
        if (result.isError === true) return yield* Effect.fail(text || `${name} failed.`);
        return result.structuredContent ?? text;
      },
      (effect, name) => effect.pipe(Effect.mapError(childFailure(name))),
    );

    return {
      [SCRIPT_TOOL_NAME]: McpToolAccess.actsAsCaller((input: { readonly code: string }) =>
        Effect.gen(function* () {
          const scope = yield* McpInvocationContext.McpInvocationContext;
          const { thread } = yield* McpInvocationContext.requireThreadScope(
            scope,
            SCRIPT_TOOL_NAME,
          );
          const stillAllowed = Effect.gen(function* () {
            const enabled = yield* settings.getSettings.pipe(
              Effect.map((current) => current.scriptToolEnabled),
              Effect.orElseSucceed(() => false),
            );
            if (!enabled) {
              return yield* refuse("The script tool is off. Turn it on in Settings → Labs.");
            }
            const caller = yield* loadCaller();
            yield* assertLiveCaller(caller);
            yield* assertFullAccess(caller, FULL_ACCESS_REQUIRED);
          });
          yield* stillAllowed;
          const cwd = yield* threadWorkspaceRoot(thread.threadId as ThreadId).pipe(
            Effect.provideService(ProjectService.ProjectService, projects),
          );
          if (cwd === undefined) {
            return yield* new OrchestratorMcpFailure({
              code: "invalid_request",
              message: "This thread has no workspace to run a script in.",
            });
          }
          const context = yield* Effect.context<
            | McpInvocationContext.McpInvocationContext
            | ThreadManagementService.ThreadManagementService
          >();
          const call: ScriptRunner.ScriptToolCall = (tool, toolInput) =>
            // A script outlives the checks above: the thread can stop or leave full access mid-run.
            stillAllowed.pipe(
              Effect.mapError((failure) => failure.message),
              Effect.andThen(
                tool === "read"
                  ? read(cwd, toolInput)
                  : tool === "write"
                    ? write(cwd, toolInput)
                    : tool === "exec"
                      ? exec(cwd, toolInput)
                      : tool === "grep"
                        ? grep(cwd, toolInput)
                        : tool === SCRIPT_TOOL_NAME
                          ? Effect.fail("A script cannot start another script.")
                          : t3Tool(tool, toolInput),
              ),
              Effect.provideContext(context),
            );
          return yield* runner.run({ code: input.code, call });
        }),
      ),
    };
  }),
);
