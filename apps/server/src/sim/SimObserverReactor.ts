// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "node:path";

import type {
  OrchestrationProjectShell,
  OrchestrationV2AppThread,
  OrchestrationV2DomainEvent,
  OrchestrationV2Run,
  OrchestrationV2TurnItem,
  ServerSettings as ServerSettingsConfig,
  ThreadId,
} from "@t3tools/contracts";
import * as SecretResolver from "@t3tools/secret-provider-core/server/SecretResolver";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import { ProjectStoreV2 } from "../orchestration-v2/ProjectStore.ts";
import { USER_STOP_REASON } from "../orchestration-v2/RunExecutionService.ts";
import { requireSettingsSecret } from "../secrets/settingsSecretValue.ts";
import { forkParked } from "../serverActivation.ts";
import * as ServerSettings from "../serverSettings.ts";
import {
  type SimResolvedPaths,
  SimService,
  type SimTelemetryEvent,
  canonicalHarnessFile,
  classifyHarnessPath,
  expandHarnessFile,
  expandHomeString,
  resolveSimPaths,
} from "./SimContracts.ts";
import {
  diffHarnessSnapshots,
  evaluateRunDetectors,
  evaluationsToMetricEvents,
  snapshotRealHarnessFiles,
  type SimHarnessSnapshot,
  type SimTurnToolCall,
} from "./SimDetectors.ts";
import {
  evaluatePostTurnCompliance,
  evaluateTurnEndingSignal,
  evaluateUserCorrectionSignal,
} from "./SimJevSensors.ts";
import * as SimStore from "./SimStore.ts";

/** Watches domain events for SIM context resets, unrecorded harness edits, and RSI signals. */
export class SimObserverReactor extends Context.Service<
  SimObserverReactor,
  {
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
    readonly handle: (event: OrchestrationV2DomainEvent) => Effect.Effect<void>;
  }
>()("t3/sim/SimObserverReactor") {}

const MEMORY_CAP = 512;
const EXCERPT_LIMIT = 300;
const TERMINAL_RUN_STATUSES = new Set(["completed", "interrupted", "failed", "cancelled"]);
const REVIEW_PATTERN = /\b(review|audit|findings|verdict|critic|grade|grader)\b/i;
const CLAUDE_DRIVER = "claudeAgent";

/** Insertion-ordered map that drops its oldest entry past the cap, so a long-lived server never grows it. */
function remember<K, V>(map: Map<K, V>, key: K, value: V): void {
  map.delete(key);
  map.set(key, value);
  if (map.size > MEMORY_CAP) map.delete(map.keys().next().value as K);
}

function firstSighting(seen: Map<string, true>, key: string): boolean {
  if (seen.has(key)) return false;
  remember(seen, key, true);
  return true;
}

/** Calendar day in the server's zone, matching how standalone sim.mjs stamps `day` and `round`. */
const localDay = (at: DateTime.DateTime) =>
  DateTime.formatIsoDate(DateTime.setZone(at, DateTime.zoneMakeLocal()));

interface ShellWord {
  readonly kind: "word";
  readonly value: string;
  /** Contains an expansion this detector cannot resolve ($VAR other than $HOME, backticks). */
  readonly dynamic: boolean;
}
type ShellToken =
  | ShellWord
  | { readonly kind: "op"; readonly value: string }
  | { readonly kind: "redir"; readonly value: string };

const stripHeredocBodies = (command: string) =>
  command.replace(
    /(<<-?\s*['"]?([A-Za-z_][A-Za-z0-9_-]*)['"]?[^\n]*\n)[\s\S]*?(?:\n[ \t]*\2(?=\n|$)|$)/g,
    "$1",
  );

function tokenizeShell(raw: string): Array<ShellToken> {
  const source = stripHeredocBodies(raw);
  const tokens: Array<ShellToken> = [];
  let index = 0;
  while (index < source.length) {
    const ch = source[index]!;
    const next = source[index + 1];
    if (ch === " " || ch === "\t" || ch === "\r") {
      index += 1;
    } else if (ch === "#") {
      while (index < source.length && source[index] !== "\n") index += 1;
    } else if ((ch === "&" && next === "&") || (ch === "|" && next === "|")) {
      tokens.push({ kind: "op", value: ch + next });
      index += 2;
    } else if (ch === "&" && next === ">") {
      const op = source[index + 2] === ">" ? "&>>" : "&>";
      tokens.push({ kind: "redir", value: op });
      index += op.length;
    } else if (ch === "\n" || ch === ";" || ch === "|" || ch === "&" || ch === "(" || ch === ")") {
      tokens.push({ kind: "op", value: ch });
      index += 1;
    } else if (ch === ">" || ch === "<" || (/\d/.test(ch) && (next === ">" || next === "<"))) {
      let op = /\d/.test(ch) ? ch + next : ch;
      index += op.length;
      while (index < source.length && /[<>&|-]/.test(source[index]!) && op.length < 4) {
        op += source[index];
        index += 1;
      }
      tokens.push({ kind: "redir", value: op });
    } else {
      let value = "";
      let dynamic = false;
      while (index < source.length && !/[\s;&|()<>]/.test(source[index]!)) {
        const c = source[index]!;
        if (c === "'") {
          const end = source.indexOf("'", index + 1);
          const stop = end === -1 ? source.length : end;
          value += source.slice(index + 1, stop);
          index = stop + 1;
        } else if (c === '"') {
          index += 1;
          while (index < source.length && source[index] !== '"') {
            if (source[index] === "\\" && index + 1 < source.length) index += 1;
            if (source[index] === "`") dynamic = true;
            value += source[index];
            index += 1;
          }
          index += 1;
        } else if (c === "\\" && index + 1 < source.length) {
          value += source[index + 1];
          index += 2;
        } else {
          if (c === "`") dynamic = true;
          value += c;
          index += 1;
        }
      }
      if (/\$(?!HOME\b|\{HOME\})/.test(value)) dynamic = true;
      tokens.push({ kind: "word", value, dynamic });
    }
  }
  return tokens;
}

const COMMAND_WRAPPERS = new Set(["sudo", "env", "command", "builtin", "nohup", "time", "exec"]);
const ALL_ARG_WRITERS = new Set(["rm", "unlink", "truncate", "touch", "shred", "tee", "mv"]);
const LAST_ARG_WRITERS = new Set(["cp", "install", "ln", "rsync"]);
const SIM_TOOL_SCRIPT = /(?:^|\/)sim(?:-audit)?\.mjs$/;

function commandWriteTargets(words: ReadonlyArray<ShellWord>): Array<ShellWord> {
  let start = 0;
  while (
    start < words.length &&
    (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[start]!.value) ||
      COMMAND_WRAPPERS.has(NodePath.basename(words[start]!.value)))
  ) {
    start += 1;
  }
  const name = NodePath.basename(words[start]?.value ?? "");
  const args = words.slice(start + 1);
  if (args.some((word) => SIM_TOOL_SCRIPT.test(word.value))) return [];
  const operands = args.filter((word) => !word.value.startsWith("-"));
  if (ALL_ARG_WRITERS.has(name)) return operands;
  if (LAST_ARG_WRITERS.has(name)) return operands.slice(-1);
  if (name === "sed" || name === "perl") {
    const inPlace = args.some(
      (word) => /^-[a-zA-Z]*i/.test(word.value) || word.value.startsWith("--in-place"),
    );
    if (!inPlace) return [];
    const files: Array<ShellWord> = [];
    let scriptGiven = false;
    for (let i = 0; i < args.length; i += 1) {
      const word = args[i]!;
      if (/^-[a-zA-Z]*[ef]$/.test(word.value) || word.value === "--expression") {
        scriptGiven = true;
        i += 1;
      } else if (!word.value.startsWith("-")) {
        if (scriptGiven) files.push(word);
        else scriptGiven = true;
      }
    }
    return files;
  }
  return [];
}

/** Conservative list of paths a Bash command writes, removes, or renames. Unresolvable expansions are skipped. */
export function detectShellWriteTargets(command: string): Array<string> {
  const targets: Array<ShellWord> = [];
  let words: Array<ShellWord> = [];
  const flush = () => {
    targets.push(...commandWriteTargets(words));
    words = [];
  };
  const tokens = tokenizeShell(command);
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i]!;
    if (token.kind === "op") {
      flush();
    } else if (token.kind === "redir") {
      const target = tokens[i + 1];
      if (target?.kind !== "word") continue;
      i += 1;
      const writes = token.value.includes(">") && !token.value.endsWith("&");
      if (writes && target.value !== "/dev/null") targets.push(target);
    } else {
      words.push(token);
    }
  }
  flush();
  return [...new Set(targets.filter((word) => !word.dynamic).map((word) => word.value))];
}

interface Selection {
  readonly providerInstanceId: string;
  readonly model: string;
}

interface InterruptedRun extends Selection {
  readonly runId: string;
  readonly reason: string | undefined;
}

const runSelection = (run: OrchestrationV2Run): Selection => ({
  providerInstanceId: run.modelSelection.instanceId ?? run.providerInstanceId,
  model: run.modelSelection.model,
});

interface RunAccumulator {
  userText?: string | undefined;
  assistantText?: string | undefined;
  readonly commands: Array<string>;
  readonly changedFiles: Array<string>;
  readonly toolCalls: Array<SimTurnToolCall>;
  harnessBefore?: SimHarnessSnapshot | undefined;
}

export interface SimObserverReactorOptions {
  readonly fetchImpl?: typeof fetch | undefined;
  /** Awaits async Jev sensor fibers inline instead of detaching them (for deterministic tests). */
  readonly awaitBackground?: boolean | undefined;
}

const safeInputString = (value: unknown): string => {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value ?? "");
  } catch {
    return "";
  }
};

const makeWithOptions = Effect.fn("SimObserverReactor.make")(function* (
  options: SimObserverReactorOptions = {},
) {
  const engine = yield* Orchestrator.OrchestratorV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const projectStore = yield* Effect.serviceOption(ProjectStoreV2);
  const secretResolver = yield* Effect.serviceOption(SecretResolver.SecretResolver);
  const settingsService = yield* ServerSettings.ServerSettingsService;
  const sim = yield* SimService;

  const handledItems = new Map<string, true>();
  const activeProviderThread = new Map<ThreadId, string>();
  const claudeSession = new Map<ThreadId, string>();
  const threadCwd = new Map<ThreadId, string | undefined>();
  const threadProject = new Map<ThreadId, OrchestrationProjectShell | undefined>();
  const threadBranch = new Map<ThreadId, string | undefined>();
  const threadUserTurns = new Map<ThreadId, number>();
  const lastAssistantText = new Map<ThreadId, string>();
  const runAccumulators = new Map<string, RunAccumulator>();
  const pendingHarness = new Map<string, Set<string>>();
  const threadSelection = new Map<ThreadId, Selection>();
  const runSelectionById = new Map<string, Selection>();
  const interruptReasons = new Map<string, string>();
  const interrupted = new Map<ThreadId, InterruptedRun>();
  let observedModels: Set<string> | undefined;

  const pendingKey = (threadId: string, runId: string) => `${threadId}\u0000${runId}`;

  const accumulatorFor = (threadId: string, runId: string): RunAccumulator => {
    const key = pendingKey(threadId, runId);
    let acc = runAccumulators.get(key);
    if (!acc) {
      acc = { commands: [], changedFiles: [], toolCalls: [] };
      remember(runAccumulators, key, acc);
    }
    return acc;
  };

  const projectFor = Effect.fnUntraced(function* (threadId: ThreadId) {
    if (threadProject.has(threadId)) return threadProject.get(threadId);
    const thread = yield* projections.findThread(threadId);
    if (thread?.branch) remember(threadBranch, threadId, thread.branch);
    let project: OrchestrationProjectShell | undefined;
    if (thread?.projectId && Option.isSome(projectStore)) {
      project = Option.getOrUndefined(
        yield* projectStore.value
          .getShell(thread.projectId)
          .pipe(Effect.orElseSucceed(() => Option.none())),
      );
    }
    remember(threadProject, threadId, project);
    return project;
  });

  const cwdFor = Effect.fnUntraced(function* (threadId: ThreadId) {
    if (threadCwd.has(threadId)) return threadCwd.get(threadId);
    const thread = yield* projections.findThread(threadId);
    if (thread?.branch) remember(threadBranch, threadId, thread.branch);
    let cwd = thread?.worktreePath ?? undefined;
    if (!cwd && thread?.projectId && Option.isSome(projectStore)) {
      const project = yield* projectFor(threadId);
      cwd = project?.workspaceRoot;
    }
    remember(threadCwd, threadId, cwd);
    return cwd;
  });

  const resolveJevKey = Effect.fnUntraced(function* (settings: ServerSettingsConfig) {
    const raw = settings.sim.jev.apiKey;
    if (typeof raw === "string") return raw.trim() || undefined;
    if (Option.isNone(secretResolver)) return undefined;
    return yield* requireSettingsSecret(secretResolver.value, raw).pipe(
      Effect.orElseSucceed(() => undefined),
    );
  });

  const runBackground = (effect: Effect.Effect<void>) => {
    const safe = effect.pipe(
      Effect.catchCause((cause) => Effect.logWarning("SIM background sensor failed", { cause })),
    );
    return options.awaitBackground === true ? safe : Effect.forkDetach(safe).pipe(Effect.asVoid);
  };

  const safeRecordMetrics = (events: ReadonlyArray<import("./SimContracts.ts").SimMetricEvent>) =>
    events.length === 0 || typeof sim.recordMetrics !== "function"
      ? Effect.void
      : sim.recordMetrics(events);

  const resetEpoch = Effect.fnUntraced(function* (
    threadId: ThreadId,
    nativeIds: ReadonlyArray<string>,
  ) {
    const known = claudeSession.get(threadId);
    const sessions = [...new Set([...nativeIds, ...(known ? [known] : [])])].map(
      (id) => `cc:${id}`,
    );
    yield* sim.resetThreadSeenEpoch(threadId, sessions);
  });

  const classifyFiles = Effect.fnUntraced(function* (
    event: OrchestrationV2DomainEvent,
    item: OrchestrationV2TurnItem,
    rawPaths: ReadonlyArray<string>,
    paths: SimResolvedPaths,
  ) {
    const unique = [...new Set(rawPaths.filter((value) => value.trim() !== ""))];
    if (unique.length === 0) return;
    const cwd = yield* cwdFor(event.threadId);
    const allowTmp = SimStore.isTestSimDir(paths);
    const records: Array<string> = [];
    const harness: Array<string> = [];
    for (const raw of unique) {
      const expanded = raw.trim().startsWith("~/.claude/")
        ? expandHarnessFile(raw, paths)
        : expandHomeString(raw, paths.homeDir);
      const kind = classifyHarnessPath(expanded, paths, cwd, { allowTmp });
      if (kind === null) continue;
      const absolute = NodePath.resolve(cwd ?? paths.homeDir, expanded);
      (kind === "record" ? records : harness).push(canonicalHarnessFile(absolute, paths));
    }
    const runId = item.runId ?? event.runId;
    const selection = runId ? runSelectionById.get(runId) : undefined;
    if (records.length > 0) {
      yield* sim.recordTelemetry({
        ts: DateTime.formatIso(event.occurredAt),
        kind: "direct_sim_record_edit",
        threadId: event.threadId,
        runId,
        providerInstanceId: selection?.providerInstanceId ?? event.providerInstanceId,
        model: selection?.model,
        files: records,
      });
    }
    if (harness.length > 0 && runId) {
      const key = pendingKey(event.threadId, runId);
      const pending = pendingHarness.get(key) ?? new Set<string>();
      for (const file of harness) pending.add(file);
      remember(pendingHarness, key, pending);
    }
  });

  const flushPendingHarness = Effect.fnUntraced(function* (
    event: OrchestrationV2DomainEvent,
    run: OrchestrationV2Run,
    paths: SimResolvedPaths,
    acc: RunAccumulator | undefined,
  ) {
    const key = pendingKey(event.threadId, run.id);
    const pending = pendingHarness.get(key);
    pendingHarness.delete(key);

    const beforeSnapshot = acc?.harnessBefore;
    const hashVerified = beforeSnapshot !== undefined && beforeSnapshot.size > 0;
    const hashChanged = hashVerified
      ? diffHarnessSnapshots(beforeSnapshot, snapshotRealHarnessFiles(paths))
      : [];
    const hashChangedSet = new Set(hashChanged);

    const candidates = new Set<string>(hashChanged);
    if (pending) {
      for (const file of pending) {
        // When real-file hashes were captured, drop global harness paths whose real digest did not change
        // (eliminating noise from scratch copies, sandboxes, and no-op shell commands).
        if (hashVerified && file.startsWith("~/.claude/") && !hashChangedSet.has(file)) {
          continue;
        }
        candidates.add(file);
      }
    }
    if (candidates.size === 0) return;

    const cwd = yield* cwdFor(event.threadId);
    const snapshot = yield* sim.getStateSnapshot();
    const authors = new Set([`t3:${event.threadId}`]);
    const native = claudeSession.get(event.threadId);
    if (native) authors.add(`cc:${native}`);
    const days = new Set([localDay(run.requestedAt), localDay(event.occurredAt)]);
    const recordedToday = new Set<string>();
    for (const problem of snapshot?.state.problems ?? []) {
      for (const attempt of problem.attempts) {
        const byCaller =
          authors.has(attempt.by) || (attempt.also !== undefined && authors.has(attempt.also));
        if (byCaller && days.has(attempt.recorded?.day ?? attempt.round)) {
          for (const file of attempt.files) recordedToday.add(file);
        }
      }
    }
    const unrecorded: Array<string> = [];
    for (const file of candidates) {
      if (recordedToday.has(file)) continue;
      if (
        yield* sim.hasRecentAttemptForFile({
          threadId: event.threadId,
          runId: run.id,
          workspaceRoot: cwd,
          file,
        })
      )
        continue;
      unrecorded.push(file);
    }
    if (unrecorded.length === 0) return;
    const selection = runSelection(run);
    yield* sim.recordTelemetry({
      ts: DateTime.formatIso(event.occurredAt),
      kind: "unrecorded_harness_edit",
      threadId: event.threadId,
      runId: run.id,
      providerInstanceId: selection.providerInstanceId,
      model: selection.model,
      files: unrecorded,
      ...(hashVerified && unrecorded.some((file) => hashChangedSet.has(file))
        ? { verifiedByHash: true }
        : {}),
    });
  });

  const evaluateCompletedRun = Effect.fnUntraced(function* (
    event: OrchestrationV2DomainEvent,
    run: OrchestrationV2Run,
    settings: ServerSettingsConfig,
    paths: SimResolvedPaths,
    acc: RunAccumulator | undefined,
  ) {
    if (!acc) return;
    const selection = runSelection(run);
    const project = yield* projectFor(event.threadId);
    const projectName = project?.title;
    const repo = project?.repositoryIdentity ?? null;
    const hasRemote = repo !== null;
    const repoOwnership: "mine" | "foreign" | "unknown" =
      repo === null
        ? "unknown"
        : repo.locator.remoteName === "upstream" && !repo.origin
          ? "foreign"
          : "mine";
    const ts = DateTime.formatIso(event.occurredAt);

    const evidence = {
      ts,
      threadId: event.threadId,
      runId: run.id,
      providerInstanceId: selection.providerInstanceId,
      model: selection.model,
      project: projectName,
      userText: acc.userText,
      assistantText: acc.assistantText,
      commands: acc.commands,
      changedFiles: acc.changedFiles,
      toolCalls: acc.toolCalls,
      repoOwnership,
      hasRemote,
      currentBranch: threadBranch.get(event.threadId),
    };

    const evaluations = evaluateRunDetectors(evidence);
    if (evaluations.length > 0) {
      yield* safeRecordMetrics(evaluationsToMetricEvents(evidence, evaluations));
      for (const evaluation of evaluations) {
        if (evaluation.verdict !== "violated") continue;
        yield* sim.recordTelemetry({
          ts,
          kind: "detector_evaluated",
          threadId: event.threadId,
          runId: run.id,
          providerInstanceId: selection.providerInstanceId,
          model: selection.model,
          ...(projectName ? { project: projectName } : {}),
          detectorId: evaluation.detectorId,
          ...(evaluation.problemId ? { problemId: evaluation.problemId } : {}),
          ...(evaluation.attemptId ? { attemptId: evaluation.attemptId } : {}),
          verdict: evaluation.verdict,
          source: "deterministic",
          evidence: evaluation.evidence,
        });
      }
    }

    if (run.status !== "completed" || !settings.sim.jev.enabled || !acc.assistantText?.trim()) {
      return;
    }

    const resolvedApiKey = yield* resolveJevKey(settings);
    const toolSummary = [
      ...acc.toolCalls.map((call) => call.name),
      ...acc.commands.map((cmd) => `cmd:${cmd.slice(0, 60)}`),
      ...acc.changedFiles.map((file) => `file:${file}`),
    ]
      .slice(0, 20)
      .join("; ");

    yield* runBackground(
      Effect.gen(function* () {
        const jevOptions = {
          settings: settings.sim.jev,
          resolvedApiKey,
          paths,
          projectName,
          fetchImpl: options.fetchImpl,
        };
        const [compliance, turnEnding] = yield* Effect.promise(() =>
          Promise.all([
            evaluatePostTurnCompliance(
              {
                ts,
                threadId: event.threadId,
                runId: run.id,
                providerInstanceId: selection.providerInstanceId,
                model: selection.model,
                project: projectName,
                userPrompt: acc.userText ?? "",
                assistantReply: acc.assistantText ?? "",
                toolSummary,
              },
              jevOptions,
            ),
            evaluateTurnEndingSignal(
              {
                ts,
                threadId: event.threadId,
                runId: run.id,
                providerInstanceId: selection.providerInstanceId,
                model: selection.model,
                project: projectName,
                assistantReply: acc.assistantText ?? "",
                toolSummary,
              },
              jevOptions,
            ),
          ]),
        );

        if (compliance && compliance.length > 0) {
          yield* safeRecordMetrics(compliance);
          for (const metric of compliance) {
            if (metric.kind !== "observation" || metric.verdict !== "violated") continue;
            yield* sim.recordTelemetry({
              ts: metric.ts,
              kind: "detector_evaluated",
              threadId: event.threadId,
              runId: run.id,
              providerInstanceId: selection.providerInstanceId,
              model: selection.model,
              ...(projectName ? { project: projectName } : {}),
              detectorId: metric.detectorId,
              ...(metric.problemId ? { problemId: metric.problemId } : {}),
              verdict: metric.verdict,
              source: "jev",
              confidence: metric.confidence,
              evidence: metric.evidence,
            });
          }
        }
        if (turnEnding) {
          yield* sim.recordTelemetry(turnEnding);
        }
      }),
    );
  });

  const observeModel = Effect.fnUntraced(function* (
    event: OrchestrationV2DomainEvent,
    selection: Selection,
  ) {
    observedModels ??= new Set(yield* sim.getObservedModels());
    const key = `${selection.providerInstanceId}:${selection.model}`;
    if (observedModels.has(key) || observedModels.has(selection.model)) return;
    observedModels.add(key);
    yield* sim.recordTelemetry({
      ts: DateTime.formatIso(event.occurredAt),
      kind: "new_model_observed",
      threadId: event.threadId,
      providerInstanceId: selection.providerInstanceId,
      model: selection.model,
    });
  });

  const handleTurnItem = Effect.fnUntraced(function* (
    event: Extract<OrchestrationV2DomainEvent, { type: "turn-item.updated" }>,
    settings: ServerSettingsConfig,
    paths: SimResolvedPaths,
  ) {
    const item = event.payload;
    if (item.type === "run_interrupt_request" && item.runId) {
      remember(interruptReasons, item.runId, item.message);
      return;
    }
    if (item.status !== "completed") return;
    const runId = item.runId ?? event.runId;
    if (item.type === "compaction") {
      if (firstSighting(handledItems, `compaction:${item.id}`))
        yield* resetEpoch(event.threadId, []);
    } else if (item.type === "user_message") {
      if (!firstSighting(handledItems, `user:${item.id}`)) return;
      const text = item.text.trim();
      if (runId && text) {
        accumulatorFor(event.threadId, runId).userText = text;
      }
      const nextTurn = (threadUserTurns.get(event.threadId) ?? 0) + 1;
      remember(threadUserTurns, event.threadId, nextTurn);
      const previousAssistant = lastAssistantText.get(event.threadId);
      if (nextTurn >= 2 && previousAssistant && text && settings.sim.jev.enabled) {
        const selection =
          (runId ? runSelectionById.get(runId) : undefined) ?? threadSelection.get(event.threadId);
        const project = yield* projectFor(event.threadId);
        const resolvedApiKey = yield* resolveJevKey(settings);
        const ts = DateTime.formatIso(event.occurredAt);
        yield* runBackground(
          Effect.gen(function* () {
            const signal = yield* Effect.promise(() =>
              evaluateUserCorrectionSignal(
                {
                  ts,
                  threadId: event.threadId,
                  runId,
                  providerInstanceId:
                    selection?.providerInstanceId ?? event.providerInstanceId ?? "unknown",
                  model: selection?.model ?? "unknown",
                  project: project?.title,
                  previousAssistant,
                  userMessage: text,
                },
                {
                  settings: settings.sim.jev,
                  resolvedApiKey,
                  paths,
                  projectName: project?.title,
                  fetchImpl: options.fetchImpl,
                },
              ),
            );
            if (signal) yield* sim.recordTelemetry(signal);
          }),
        );
      }
    } else if (item.type === "assistant_message") {
      if (!firstSighting(handledItems, `assistant:${item.id}`)) return;
      const text = item.text.trim();
      if (text) {
        remember(lastAssistantText, event.threadId, text);
        if (runId) {
          const acc = accumulatorFor(event.threadId, runId);
          acc.assistantText = acc.assistantText ? `${acc.assistantText}\n\n${text}` : text;
        }
      }
    } else if (item.type === "file_change") {
      if (!firstSighting(handledItems, `file:${item.id}`)) return;
      const files = [item.fileName, ...(item.changes ?? []).map((change) => change.path)];
      if (runId) accumulatorFor(event.threadId, runId).changedFiles.push(...files);
      yield* classifyFiles(event, item, files, paths);
    } else if (item.type === "command_execution") {
      if (!firstSighting(handledItems, `command:${item.id}`)) return;
      if (runId) accumulatorFor(event.threadId, runId).commands.push(item.input);
      yield* classifyFiles(event, item, detectShellWriteTargets(item.input), paths);
    } else if (item.type === "dynamic_tool") {
      if (!firstSighting(handledItems, `tool:${item.id}`)) return;
      if (runId && item.toolName) {
        accumulatorFor(event.threadId, runId).toolCalls.push({
          name: item.toolName,
          input: safeInputString(item.input),
        });
      }
    } else if (item.type === "subagent") {
      if (!firstSighting(handledItems, `subagent-item:${item.id}`)) return;
      if (runId) {
        accumulatorFor(event.threadId, runId).toolCalls.push({
          name: "delegate_task",
          input: item.prompt,
        });
      }
    }
  });

  const handleProviderThread = Effect.fnUntraced(function* (
    event: Extract<OrchestrationV2DomainEvent, { type: "provider-thread.updated" }>,
  ) {
    const providerThread = event.payload;
    const threadId = providerThread.appThreadId ?? event.threadId;
    const previousNative = claudeSession.get(threadId);
    const nativeId =
      providerThread.driver === CLAUDE_DRIVER
        ? providerThread.nativeThreadRef?.nativeId
        : undefined;
    if (nativeId) remember(claudeSession, threadId, nativeId);
    if (
      activeProviderThread.get(threadId) === providerThread.id &&
      (!nativeId || nativeId === previousNative)
    ) {
      return;
    }
    // Native subagents get provider threads too; only the thread's active one is its context.
    const thread = yield* projections.findThread(threadId);
    if (thread?.activeProviderThreadId !== providerThread.id) return;
    remember(activeProviderThread, threadId, providerThread.id);
    const extraSessionIds = [
      ...new Set([previousNative, nativeId].filter((id): id is string => Boolean(id))),
    ].map((id) => `cc:${id}`);
    yield* sim.trackProviderThread({
      threadId,
      providerThreadId: providerThread.id,
      extraSessionIds,
    });
  });

  const handleSelectionChange = Effect.fnUntraced(function* (
    event: OrchestrationV2DomainEvent,
    thread: OrchestrationV2AppThread,
  ) {
    const next: Selection = {
      providerInstanceId: thread.modelSelection.instanceId ?? thread.providerInstanceId,
      model: thread.modelSelection.model,
    };
    let previous = threadSelection.get(event.threadId);
    if (previous?.providerInstanceId === next.providerInstanceId && previous.model === next.model) {
      return;
    }
    remember(threadSelection, event.threadId, next);
    const records = yield* projections.getThreadRecords(event.threadId, ["runs"]);
    // Picking a model before the first turn is setup, not a switch.
    if (records.runs.length === 0) return;
    const latest = records.runs.toSorted((a, b) => b.ordinal - a.ordinal)[0]!;
    previous ??= runSelection(latest);
    if (previous.providerInstanceId === next.providerInstanceId && previous.model === next.model) {
      return;
    }
    yield* sim.recordTelemetry({
      ts: DateTime.formatIso(event.occurredAt),
      kind: "mid_thread_model_switch",
      threadId: event.threadId,
      fromProvider: previous.providerInstanceId,
      fromModel: previous.model,
      toProvider: next.providerInstanceId,
      toModel: next.model,
    });
  });

  const handleRunCreated = Effect.fnUntraced(function* (
    event: Extract<OrchestrationV2DomainEvent, { type: "run.created" }>,
    paths: SimResolvedPaths,
  ) {
    const run = event.payload;
    remember(runSelectionById, run.id, runSelection(run));
    remember(threadSelection, event.threadId, runSelection(run));
    const acc = accumulatorFor(event.threadId, run.id);
    acc.harnessBefore ??= snapshotRealHarnessFiles(paths);
    if (run.restartContinuationOfRunId || run.usageLimitContinuationOfRunId) return;
    const stopped = interrupted.get(event.threadId);
    if (!stopped || stopped.runId === run.id) return;
    interrupted.delete(event.threadId);
    yield* sim.recordTelemetry({
      ts: DateTime.formatIso(event.occurredAt),
      kind: "interrupted_with_steer",
      threadId: event.threadId,
      interruptedRunId: stopped.runId,
      followupRunId: run.id,
      providerInstanceId: stopped.providerInstanceId,
      model: stopped.model,
      reason: stopped.reason,
    });
  });

  const handleRunUpdated = Effect.fnUntraced(function* (
    event: Extract<OrchestrationV2DomainEvent, { type: "run.updated" }>,
    settings: ServerSettingsConfig,
    paths: SimResolvedPaths,
  ) {
    const run = event.payload;
    const selection = runSelection(run);
    remember(runSelectionById, run.id, selection);
    if (run.status === "running" || run.status === "completed")
      yield* observeModel(event, selection);
    if (run.status === "interrupted") {
      const reason = interruptReasons.get(run.id);
      interruptReasons.delete(run.id);
      // An agent or server stop carries its own reason; only a person's stop is a correction.
      if (reason === undefined || reason === USER_STOP_REASON) {
        remember(interrupted, event.threadId, { ...selection, runId: run.id, reason });
      }
    }
    if (TERMINAL_RUN_STATUSES.has(run.status)) {
      const key = pendingKey(event.threadId, run.id);
      const acc = runAccumulators.get(key);
      runAccumulators.delete(key);
      yield* flushPendingHarness(event, run, paths, acc);
      yield* evaluateCompletedRun(event, run, settings, paths, acc);
    }
  });

  const handleEvent = Effect.fnUntraced(function* (event: OrchestrationV2DomainEvent) {
    const settings = yield* settingsService.getSettings;
    if (!settings.sim.enabled) return;
    const paths = resolveSimPaths(settings.sim);
    switch (event.type) {
      case "turn-item.updated":
        return yield* handleTurnItem(event, settings, paths);
      case "context-handoff.updated":
        if (
          event.payload.status === "ready" &&
          firstSighting(handledItems, `handoff:${event.payload.id}`)
        ) {
          yield* resetEpoch(event.threadId, []);
        }
        return;
      case "provider-thread.updated":
        return yield* handleProviderThread(event);
      case "checkpoint.rollback-requested": {
        const selection = threadSelection.get(event.threadId);
        const telemetry: SimTelemetryEvent = {
          ts: DateTime.formatIso(event.occurredAt),
          kind: "checkpoint_rollback",
          threadId: event.threadId,
          runId: event.runId,
          checkpointId: event.payload.checkpointId,
          providerInstanceId: selection?.providerInstanceId ?? event.providerInstanceId,
          model: selection?.model,
        };
        return yield* sim.recordTelemetry(telemetry);
      }
      case "thread.created":
        threadCwd.delete(event.threadId);
        threadProject.delete(event.threadId);
        if (event.payload.branch) remember(threadBranch, event.threadId, event.payload.branch);
        remember(threadSelection, event.threadId, {
          providerInstanceId:
            event.payload.modelSelection.instanceId ?? event.payload.providerInstanceId,
          model: event.payload.modelSelection.model,
        });
        return;
      case "thread.model-selection-updated":
      case "thread.provider-switched":
        threadCwd.delete(event.threadId);
        return yield* handleSelectionChange(event, event.payload);
      case "run.created":
        return yield* handleRunCreated(event, paths);
      case "run.updated":
        return yield* handleRunUpdated(event, settings, paths);
      case "subagent.updated": {
        const subagent = event.payload;
        if (subagent.status !== "completed") return;
        const text = [subagent.title, subagent.prompt, subagent.result].filter(Boolean).join("\n");
        if (!REVIEW_PATTERN.test(text) || !firstSighting(handledItems, `subagent:${subagent.id}`))
          return;
        const excerpt = (subagent.result || subagent.prompt || subagent.title || "").trim();
        return yield* sim.recordTelemetry({
          ts: DateTime.formatIso(event.occurredAt),
          kind: "delegated_review_completed",
          threadId: event.threadId,
          childThreadId: subagent.childThreadId ?? undefined,
          providerInstanceId: subagent.providerInstanceId,
          model: subagent.executedModel ?? subagent.model ?? subagent.modelSelection?.model,
          title: subagent.title ?? undefined,
          excerpt: excerpt.slice(0, EXCERPT_LIMIT) || undefined,
        });
      }
      default:
        return;
    }
  });

  const handle: SimObserverReactor["Service"]["handle"] = (event) =>
    handleEvent(event).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("SIM observer failed to handle an event", {
          threadId: event.threadId,
          type: event.type,
          cause,
        }),
      ),
    );

  const start: SimObserverReactor["Service"]["start"] = () =>
    forkParked(
      Stream.runForEach(engine.streamDomainEvents, handle).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("SIM observer event stream failed", { cause }),
        ),
      ),
    );

  return { start, handle } satisfies SimObserverReactor["Service"];
});

export const layerWithOptions = (options: SimObserverReactorOptions) =>
  Layer.effect(SimObserverReactor, makeWithOptions(options));

export const layer = layerWithOptions({});
