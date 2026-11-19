// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  MessageId,
  NodeId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  RunAttemptId,
  RunId,
  ThreadId,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2Run,
  type OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { McpSchema, McpServer } from "effect/ai";

import * as McpHttpServer from "../mcp/McpHttpServer.ts";
import * as McpInvocationContext from "../mcp/McpInvocationContext.ts";
import { liveThreadShell } from "../mcp/McpToolAccess.testkit.ts";
import * as McpAppModelContext from "../mcpApps/McpAppModelContext.ts";
import * as CheckpointService from "../orchestration-v2/CheckpointService.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ProviderEventIngestor from "../orchestration-v2/ProviderEventIngestor.ts";
import * as RunExecutionService from "../orchestration-v2/RunExecutionService.ts";
import * as ThreadCommandExecutor from "../orchestration-v2/ThreadCommandExecutor.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as TurnItemPositionStore from "../orchestration-v2/TurnItemPositionStore.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as PreviewAgentActivity from "../preview/PreviewAgentActivity.ts";
import { CODEX_ADDITIONAL_CONTEXT_VALUE_MAX_BYTES } from "../provider/CodexDeveloperInstructions.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as SimAuditService from "./SimAuditService.ts";
import { SimService } from "./SimContracts.ts";
import * as SimServiceImpl from "./SimService.ts";
import * as SimStore from "./SimStore.ts";

const environmentId = EnvironmentId.make("environment:sim-integration");
const projectId = ProjectId.make("project:sim-integration");

const mcpClient = McpSchema.McpServerClient.of({
  clientId: 1,
  clientCapabilities: {},
  clientInfo: { name: "sim-integration-test", version: "1.0.0" },
  protocolVersion: "2025-06-18",
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "sim-integration-test", version: "1.0.0" },
  },
  getClient: Effect.die("unused"),
});

function makeSandbox() {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-sim-integration-"));
  const harnessDir = NodePath.join(root, "harness");
  const simDir = NodePath.join(harnessDir, "sim");
  NodeFS.mkdirSync(simDir, { recursive: true });
  const agentsPath = NodePath.join(harnessDir, "AGENTS.md");
  NodeFS.writeFileSync(
    agentsPath,
    "# Harness\n\n## Rules\n- Always verify focused tests before pushing.\n",
    "utf8",
  );
  return {
    root,
    harnessDir,
    simDir,
    agentsPath,
    [Symbol.dispose]() {
      NodeFS.rmSync(root, { recursive: true, force: true });
    },
  };
}

function threadScope(
  threadId: ThreadId,
  providerInstanceId: ProviderInstanceId,
  subagent = false,
): McpInvocationContext.McpInvocationScope {
  return {
    environmentId,
    requestNamespace: `provider:${threadId}`,
    thread: {
      threadId,
      providerSessionId: `provider-session:${threadId}`,
      providerInstanceId,
      subagent,
    },
    client: undefined,
    capabilities: new Set(["orchestration" as const]),
    issuedAt: 1,
  };
}

const parseToolJson = (result: McpSchema.CallToolResult): Record<string, unknown> => {
  const first = result.content[0];
  if (first?.type !== "text") {
    throw new Error(`Expected text MCP tool content, got ${JSON.stringify(result)}`);
  }
  return JSON.parse(first.text) as Record<string, unknown>;
};

describe("SIM cross-harness end-to-end integration", () => {
  it.effect(
    "enforces read-before-write, atomic apply, epoch reset, and cross-thread grading through real McpServer + SimService",
    () =>
      Effect.gen(function* () {
        using sandbox = makeSandbox();
        const authorThread = ThreadId.make("thread:author-codex");
        const forkThread = ThreadId.make("thread:fork-child");
        const delegateThread = ThreadId.make("thread:delegated-grader");
        const codexProvider = ProviderInstanceId.make("codex");
        const claudeProvider = ProviderInstanceId.make("claudeAgent");

        const shells = new Map<ThreadId, OrchestrationV2ThreadShell>([
          [
            authorThread,
            {
              ...liveThreadShell(authorThread),
              providerInstanceId: codexProvider,
              projectId,
              modelSelection: { instanceId: codexProvider, model: "gpt-6.2-sol" },
            },
          ],
          [
            forkThread,
            {
              ...liveThreadShell(forkThread),
              providerInstanceId: codexProvider,
              projectId,
              modelSelection: { instanceId: codexProvider, model: "gpt-6.2-sol" },
              lineage: {
                parentThreadId: authorThread,
                relationshipToParent: "fork",
                rootThreadId: authorThread,
              },
            },
          ],
          [
            delegateThread,
            {
              ...liveThreadShell(delegateThread),
              providerInstanceId: claudeProvider,
              projectId,
              modelSelection: { instanceId: claudeProvider, model: "claude-opus-5-5" },
              lineage: {
                parentThreadId: authorThread,
                relationshipToParent: "subagent",
                rootThreadId: authorThread,
              },
            },
          ],
        ]);

        const providerThreadRecords = new Map<
          ThreadId,
          ReadonlyArray<OrchestrationV2ProviderThread>
        >([
          [
            authorThread,
            [
              {
                id: ProviderThreadId.make("pt:author"),
                driver: ProviderDriverKind.make("codex"),
                nativeThreadRef: null,
              } as unknown as OrchestrationV2ProviderThread,
            ],
          ],
          [
            delegateThread,
            [
              {
                id: ProviderThreadId.make("pt:delegate"),
                driver: ProviderDriverKind.make("claudeAgent"),
                nativeThreadRef: {
                  driver: ProviderDriverKind.make("claudeAgent"),
                  nativeId: "claude-native-grader-1",
                  strength: "strong",
                },
              } as unknown as OrchestrationV2ProviderThread,
            ],
          ],
        ]);

        const baseDeps = Layer.mergeAll(
          SqlitePersistence.layerMemory,
          ServerSettings.layerTest({
            sim: {
              enabled: true,
              simDir: sandbox.simDir,
              harnessDir: sandbox.harnessDir,
              injectRules: true,
            },
          }),
          Layer.mock(ThreadManagement.ThreadManagementService)({
            getThreadShell: (id) => Effect.succeed(shells.get(id) ?? null),
          }),
          Layer.mock(ProjectionStore.ProjectionStoreV2)({
            getThreadRecords: (id) =>
              Effect.succeed({
                thread: shells.get(id)!,
                runs: [
                  {
                    id: RunId.make(`run:${id}`),
                    providerThreadId:
                      id === authorThread
                        ? ProviderThreadId.make("pt:author")
                        : id === delegateThread
                          ? ProviderThreadId.make("pt:delegate")
                          : null,
                    modelSelection: shells.get(id)!.modelSelection,
                  } as unknown as OrchestrationV2Run,
                ],
                providerThreads: providerThreadRecords.get(id) ?? [],
              } as never),
          }),
          Layer.mock(ProjectStore.ProjectStoreV2)({
            getShell: () =>
              Effect.succeedSome({
                id: projectId,
                title: "t3code-fork",
                workspaceRoot: sandbox.root,
              } as never),
          }),
          NodeServices.layer,
          NodeCrypto.layer,
        );

        const simLayer = SimServiceImpl.layer.pipe(Layer.provideMerge(baseDeps));
        const auditLayer = SimAuditService.layer.pipe(Layer.provideMerge(simLayer));
        const mcpLayer = McpHttpServer.layerSimToolkit.pipe(
          Layer.provideMerge(McpHttpServer.layerInProcessMcpServer),
          Layer.provideMerge(auditLayer),
        );

        yield* Effect.gen(function* () {
          const mcp = yield* McpServer.McpServer;
          const sim = yield* SimService;

          const call = (
            scope: McpInvocationContext.McpInvocationScope,
            name: string,
            args: Record<string, unknown>,
          ) =>
            mcp
              .callTool({ name, arguments: args })
              .pipe(
                Effect.provideService(McpInvocationContext.McpInvocationContext, scope),
                Effect.provideService(McpSchema.McpServerClient, mcpClient),
              );

          const author = threadScope(authorThread, codexProvider);
          const fork = threadScope(forkThread, codexProvider);
          const grader = threadScope(delegateThread, claudeProvider, true);

          // 1. Direct edits to SIM record files are always blocked.
          const blockedRecord = yield* call(author, "sim_apply_harness_change", {
            file: NodePath.join(sandbox.simDir, "sim.jsonl"),
            append: true,
            content: "{}\n",
            attempt: {
              new: "Agents skip tests before pushing code",
              action: "add",
              what: "Tamper journal",
              why: "Should be rejected",
              anchor: "Tamper journal",
              depends_on: ["model"],
              predicted: ["skipped-tests"],
              expect: "Rejected",
            },
          });
          expect(blockedRecord.isError).toBe(true);
          expect(parseToolJson(blockedRecord).code).toBe("capability_denied");

          // 2. Consulting index is required before dry-run or live apply.
          const beforeText = NodeFS.readFileSync(sandbox.agentsPath, "utf8");
          const unindexed = yield* call(author, "sim_apply_harness_change", {
            file: "~/.claude/AGENTS.md",
            oldText: "- Always verify focused tests before pushing.",
            newText:
              "- Always verify focused tests before pushing.\n- Quote the exact test command output in the final report.",
            dryRun: true,
            attempt: {
              new: "Agents report tests passed without showing command output",
              action: "add",
              what: "Add rule requiring exact test command output in reports",
              why: "Unverified test claims hid broken assertions",
              anchor: "Quote the exact test command output",
              depends_on: ["model"],
              predicted: ["unverified-test-claim"],
              expect: "Fixed when reports include command output; missed if claimed without output",
            },
          });
          expect(unindexed.isError).toBe(true);
          expect(parseToolJson(unindexed).code).toBe("invalid_request");

          const indexed = yield* call(author, "sim_read", { action: "index" });
          expect(indexed.isError).toBe(false);

          const dryRun = yield* call(author, "sim_apply_harness_change", {
            file: "~/.claude/AGENTS.md",
            oldText: "- Always verify focused tests before pushing.",
            newText:
              "- Always verify focused tests before pushing.\n- Quote the exact test command output in the final report.",
            dryRun: true,
            attempt: {
              new: "Agents report tests passed without showing command output",
              action: "add",
              what: "Add rule requiring exact test command output in reports",
              why: "Unverified test claims hid broken assertions",
              anchor: "Quote the exact test command output",
              depends_on: ["model"],
              predicted: ["unverified-test-claim"],
              expect: "Fixed when reports include command output; missed if claimed without output",
            },
          });
          expect(dryRun.isError).toBe(false);
          expect(NodeFS.readFileSync(sandbox.agentsPath, "utf8")).toBe(beforeText);

          // 3. Live apply writes file and records attempt atomically with derived model/harness.
          const applied = yield* call(author, "sim_apply_harness_change", {
            file: "~/.claude/AGENTS.md",
            oldText: "- Always verify focused tests before pushing.",
            newText:
              "- Always verify focused tests before pushing.\n- Quote the exact test command output in the final report.",
            attempt: {
              new: "Agents report tests passed without showing command output",
              action: "add",
              what: "Add rule requiring exact test command output in reports",
              why: "Unverified test claims hid broken assertions",
              anchor: "Quote the exact test command output",
              depends_on: ["model"],
              predicted: ["unverified-test-claim"],
              expect: "Fixed when reports include command output; missed if claimed without output",
            },
          });
          expect(applied.isError).toBe(false);
          const appliedData = parseToolJson(applied);
          expect(appliedData.problemId).toBe("P1");
          expect(appliedData.attemptId).toBe("A1");
          expect(NodeFS.readFileSync(sandbox.agentsPath, "utf8")).toContain(
            "Quote the exact test command output",
          );

          // 4. Verify envelope-only harness & no harness key inside event.data.
          const journalLine = NodeFS.readFileSync(
            NodePath.join(sandbox.simDir, "sim.jsonl"),
            "utf8",
          ).trim();
          const parsedEvent = JSON.parse(journalLine) as {
            harness?: string;
            data: Record<string, unknown>;
          };
          expect(parsedEvent.harness).toBe("codex");
          expect(parsedEvent.data.policy).toBe("gpt-6.2-sol");
          expect("harness" in parsedEvent.data).toBe(false);

          // 5. Add a second problem and reset context epoch; show P1 alone without index/by_file is rejected.
          yield* call(author, "sim_read", { action: "brief_all" });
          yield* call(author, "sim_read", { action: "show", ids: ["P1"] });
          const second = yield* call(author, "sim_apply_harness_change", {
            file: "~/.claude/AGENTS.md",
            append: true,
            content: "- Never force push shared branches.\n",
            attempt: {
              new: "Agents force push shared branches without asking first",
              action: "add",
              what: "Forbid force pushing shared branches",
              why: "Force push overwrote teammate work",
              anchor: "Never force push shared branches.",
              depends_on: ["user"],
              predicted: ["force-push-loss"],
              expect: "No force pushes",
            },
          });
          expect(second.isError).toBe(false);

          yield* sim.resetThreadSeenEpoch(authorThread);
          const blockedAfterCompaction = yield* call(author, "sim_write", {
            action: "attempt",
            problem: "P1",
            changeAction: "revise",
            what: "Tighten output quoting rule",
            why: "Still missed on long runs",
            files: ["~/.claude/AGENTS.md"],
            anchor: "Quote the exact test command output",
            supersedes: ["A1"],
            depends_on: ["model"],
            predicted: ["unverified-test-claim"],
            expect: "Fixed when every run quotes output",
          });
          expect(blockedAfterCompaction.isError).toBe(true);
          expect(String(parseToolJson(blockedAfterCompaction).message)).toContain("P1");

          // Reading only show P1 without index/by_file is still rejected when P2 exists.
          yield* call(author, "sim_read", { action: "show", ids: ["P1"] });
          const blockedWithoutIndex = yield* call(author, "sim_write", {
            action: "attempt",
            problem: "P1",
            changeAction: "revise",
            what: "Tighten output quoting rule",
            why: "Still missed on long runs",
            files: ["~/.claude/AGENTS.md"],
            anchor: "Quote the exact test command output",
            supersedes: ["A1"],
            depends_on: ["model"],
            predicted: ["unverified-test-claim"],
            expect: "Fixed when every run quotes output",
          });
          expect(blockedWithoutIndex.isError).toBe(true);
          expect(String(parseToolJson(blockedWithoutIndex).message)).toMatch(/index.*by_file/);

          // 6. Strict no-self-grading: author thread & fork child both stay unconfirmed;
          //    independent delegate_task child settles the prediction!
          const selfGrade = yield* call(author, "sim_write", {
            action: "observe",
            attempt: "A1",
            target: "unverified-test-claim",
            result: "fixed",
            evidence: "Author claimed it worked in the same session",
            source: "test",
          });
          expect(selfGrade.isError).toBe(false);
          expect(parseToolJson(selfGrade).settled).toBe(false);

          const forkGrade = yield* call(fork, "sim_write", {
            action: "observe",
            attempt: "A1",
            target: "unverified-test-claim",
            result: "fixed",
            evidence: "Forked thread checked the same session output",
            source: "test",
          });
          expect(forkGrade.isError).toBe(false);
          expect(parseToolJson(forkGrade).settled).toBe(false);

          const independentGrade = yield* call(grader, "sim_write", {
            action: "observe",
            attempt: "A1",
            target: "unverified-test-claim",
            result: "fixed",
            evidence: "Independent delegate grader verified exact test output in fresh run",
            source: "test",
          });
          expect(independentGrade.isError).toBe(false);
          expect(parseToolJson(independentGrade).settled).toBe(true);
        }).pipe(Effect.provide(mcpLayer));
      }),
  );

  it.effect(
    "delivers filtered <4KB SIM instructions to Codex via RunExecutionService without double-injecting into Claude",
    () =>
      Effect.gen(function* () {
        using sandbox = makeSandbox();
        const runTurn = (providerId: string, driver: string, model: string, threadId: ThreadId) =>
          Effect.gen(function* () {
            const started = yield* Deferred.make<ProviderAdapter.ProviderAdapterV2TurnInput>();
            const runExecution = yield* RunExecutionService.RunExecutionServiceV2;
            const now = DateTime.nowUnsafe();
            const providerInstanceId = ProviderInstanceId.make(providerId);
            const runId = RunId.make(`run:${threadId}`);
            const attemptId = RunAttemptId.make(`attempt:${threadId}`);
            const rootNodeId = NodeId.make(`node:${threadId}`);
            const providerThreadId = ProviderThreadId.make(`pt:${threadId}`);

            const providerSessionId = ProviderSessionId.make(`ps:${threadId}`);
            yield* runExecution.startRootRun({
              commandId: `cmd:${threadId}` as never,
              providerSessionId,
              attemptId,
              appThread: {
                id: threadId,
                projectId,
                title: "SIM test",
                defaultProvider: providerInstanceId,
                runtimeMode: "full-access",
                interactionMode: "default",
                modelSelection: { instanceId: providerInstanceId, model },
                activeProviderThreadId: providerThreadId,
                latestRunId: runId,
                activeRunId: runId,
                branch: null,
                worktreePath: null,
                lineage: {
                  parentThreadId: null,
                  relationshipToParent: null,
                  rootThreadId: threadId,
                },
                createdAt: now,
                updatedAt: now,
                archivedAt: null,
                deletedAt: null,
              } as never,
              run: {
                id: runId,
                threadId,
                ordinal: 1,
                providerInstanceId,
                providerThreadId,
                status: "running",
                userMessageId: MessageId.make(`msg:${threadId}`),
                modelSelection: { instanceId: providerInstanceId, model },
                requestedAt: now,
                startedAt: now,
                completedAt: null,
              } as never,
              attempt: {
                id: attemptId,
                threadId,
                runId,
                ordinal: 1,
                rootNodeId,
                providerInstanceId,
                providerThreadId,
                providerTurnId: null,
                status: "running",
              } as never,
              rootNode: {
                id: rootNodeId,
                threadId,
                runId,
                rootNodeId,
                parentNodeId: null,
                kind: "root",
                status: "running",
                providerThreadId,
                providerTurnId: null,
              } as never,
              checkpointScope: {
                id: `scope:${threadId}` as never,
                threadId,
                runId,
                nodeId: rootNodeId,
                parentScopeId: null,
                providerThreadId,
                kind: "root",
                cwd: sandbox.root,
                ordinalWithinParent: 0,
                advancesAppRunCount: true,
                createdAt: now,
              } as never,
              providerThread: {
                id: providerThreadId,
                threadId,
                providerInstanceId,
                driver: ProviderDriverKind.make(driver),
                providerSessionId: ProviderSessionId.make(`ps:${threadId}`),
                status: "ready",
                nativeThreadRef: null,
              } as never,
              providerTurnOrdinal: 1,
              session: {
                driver: ProviderDriverKind.make(driver),
                events: Stream.never,
                startTurn: (input: ProviderAdapter.ProviderAdapterV2TurnInput) =>
                  Deferred.succeed(started, input).pipe(Effect.asVoid),
              } as never,
              message: {
                messageId: MessageId.make(`msg:${threadId}`),
                text: "Hello",
                attachments: [],
                createdBy: "user",
                creationSource: "web",
              },
              modelSelection: { instanceId: providerInstanceId, model },
              runtimePolicy: {
                runtimeMode: "full-access",
                interactionMode: "default",
                cwd: sandbox.root,
              },
            });
            return yield* Deferred.await(started);
          });

        const settingsLayer = ServerSettings.layerTest({
          sim: {
            enabled: true,
            simDir: sandbox.simDir,
            harnessDir: sandbox.harnessDir,
            injectRules: true,
          },
        });
        const simLayer = SimServiceImpl.layer.pipe(Layer.provideMerge(settingsLayer));
        const turnPositionsLayer = Layer.mock(TurnItemPositionStore.TurnItemPositionStoreV2)({
          allocate: () => Effect.succeed(0),
          normalize: (item) => Effect.succeed(item),
        });
        const layerTest = RunExecutionService.layer.pipe(
          Layer.provide(
            Layer.mergeAll(
              McpAppModelContext.layerEmpty,
              PreviewAgentActivity.layer,
              Layer.mock(CheckpointService.CheckpointServiceV2)({
                captureBaseline: () => Effect.void,
              }),
              turnPositionsLayer,
              Layer.mock(EventSink.EventSinkV2)({
                write: () => Effect.succeed({ committed: true, storedEvents: [] } as never),
                writeIfRunCurrent: () =>
                  Effect.succeed({ committed: true, storedEvents: [] } as never),
              }),
              IdAllocator.layer,
              ThreadCommandExecutor.layer,
              Layer.mock(ProviderEventIngestor.ProviderEventIngestorV2)({
                ingestNormalized: () => Effect.succeed([]),
              }),
              simLayer,
            ),
          ),
        );

        const codexTurn = yield* runTurn(
          "codex",
          "codex",
          "gpt-6.2-sol",
          ThreadId.make("thread:run-exec-codex"),
        ).pipe(Effect.provide(layerTest));
        assert.isDefined(codexTurn.threadInstructions);
        assert.isAbove(codexTurn.threadInstructions!.length, 0);
        assert.include(
          codexTurn.threadInstructions!.join("\n\n"),
          "Always verify focused tests before pushing.",
        );
        assert.include(
          codexTurn.threadInstructions!.join("\n\n"),
          "## Self-Improvement Memory (SIM)",
        );
        for (const section of codexTurn.threadInstructions!) {
          assert.isAtMost(
            Buffer.byteLength(section, "utf8"),
            CODEX_ADDITIONAL_CONTEXT_VALUE_MAX_BYTES,
          );
        }

        const claudeTurn = yield* runTurn(
          "claudeAgent",
          "claudeAgent",
          "claude-opus-5-5",
          ThreadId.make("thread:run-exec-claude"),
        ).pipe(Effect.provide(layerTest));
        assert.isUndefined(claudeTurn.threadInstructions);
      }),
  );

  it.effect(
    "preserves format-v2 journal and schema-3 sim.json compatibility across mixed CLI and T3 writes",
    () =>
      Effect.gen(function* () {
        using sandbox = makeSandbox();
        const simLayer = SimServiceImpl.layer.pipe(
          Layer.provide(
            ServerSettings.layerTest({
              sim: { enabled: true, simDir: sandbox.simDir, harnessDir: sandbox.harnessDir },
            }),
          ),
        );

        // Seed a synthetic format-v2 CLI journal line (without top-level harness, matching standalone sim.mjs).
        const cliEvent = {
          seq: 1,
          ts: "2026-11-10T10:00:00.000Z",
          day: "2026-11-10",
          by: "cc:cli-session-1",
          v: 2,
          op: "attempt",
          data: {
            new: "Agents push changes without running focused tests first",
            action: "add",
            what: "Require focused test run before push",
            why: "Unverified pushes broke the branch",
            files: ["~/.claude/AGENTS.md"],
            anchor: "verify focused tests before pushing",
            depends_on: ["model"],
            predicted: ["untested-push"],
            expect: "Fixed when every push includes test results",
            policy: "claude-opus-5-5",
            domain: "global",
            considered: [],
          },
          prev: "genesis",
        };
        NodeFS.writeFileSync(
          NodePath.join(sandbox.simDir, "sim.jsonl"),
          `${JSON.stringify(cliEvent)}\n`,
          "utf8",
        );

        yield* Effect.gen(function* () {
          const sim = yield* SimService;
          const snapshot = yield* sim.getStateSnapshot();
          assert.isNotNull(snapshot);
          assert.isNull(snapshot!.broken);
          expect(snapshot!.state.events).toBe(1);
          // Read-only snapshot never creates or rewrites sim.json.
          expect(NodeFS.existsSync(NodePath.join(sandbox.simDir, "sim.json"))).toBe(false);

          // Append a cross-harness observation from Codex (envelope harness: "codex").
          const observed = yield* sim.write(
            {
              sessionId: "t3:compat-codex-thread",
              providerInstanceId: ProviderInstanceId.make("codex"),
              driver: "codex",
              model: "gpt-6.2-sol",
            },
            {
              action: "observe",
              input: {
                attempt: "A1",
                target: "untested-push",
                result: "fixed",
                evidence: "Codex thread ran focused tests before pushing",
                source: "test",
                policy: "gpt-6.2-sol",
                domain: "global",
                harness: "codex",
              },
            },
          );
          expect(observed.settled).toBe(true);

          // Verify journal envelope & schema-3 sim.json (no harness key on disk).
          const lines = NodeFS.readFileSync(NodePath.join(sandbox.simDir, "sim.jsonl"), "utf8")
            .trim()
            .split("\n");
          expect(lines).toHaveLength(2);
          const secondEvent = JSON.parse(lines[1]!) as {
            prev: string;
            harness?: string;
            data: { observation: Record<string, unknown> };
          };
          expect(secondEvent.prev).toBe(SimStore.sha(lines[0]!));
          expect(secondEvent.harness).toBe("codex");
          expect("harness" in secondEvent.data.observation).toBe(false);

          const onDisk = JSON.parse(
            NodeFS.readFileSync(NodePath.join(sandbox.simDir, "sim.json"), "utf8"),
          ) as {
            schema: number;
            events: number;
            problems: Array<{
              attempts: Array<{
                harness?: string;
                fixed: Array<string>;
                observations: Array<Record<string, unknown>>;
              }>;
            }>;
          };
          expect(onDisk.schema).toBe(3);
          expect(onDisk.events).toBe(2);
          expect(onDisk.problems[0]!.attempts[0]!.fixed).toEqual(["untested-push"]);
          expect("harness" in onDisk.problems[0]!.attempts[0]!).toBe(false);
          expect("harness" in onDisk.problems[0]!.attempts[0]!.observations[0]!).toBe(false);
        }).pipe(Effect.provide(simLayer));
      }),
  );
});
