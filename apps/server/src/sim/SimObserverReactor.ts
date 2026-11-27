// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "node:path";

import type {
  OrchestrationV2AppThread,
  OrchestrationV2DomainEvent,
  OrchestrationV2Run,
  OrchestrationV2TurnItem,
  ThreadId,
} from "@t3tools/contracts";
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
const REVIEW_TERM =
  /\b(?:review\w*|re-?check\w*|audit\w*|verif\w*|grad(?:e|ed|es|er|ers|ing)|critics?|critiques?|(?:gegen)?prüf\w*)\b/i;
const CODE_CUE =
  /\b(?:code(?:base)?|diffs?|PRs?|pull requests?|branch(?:es)?|commits?|patch(?:es)?|repo(?:s|sitory|sitories)?|harness|SIM|tests?|adversarial)\b/i;
// Any research prompt asks for "findings" or a "verdict", so these only count in a title.
const VERDICT_CUE = /\b(?:findings|verdict)\b/i;
const REVIEW_ROLE =
  /\b(?:independent grader|round[- ]?\d+ (?:re-?)?review|check(?:ing)? (?:[\w-]+ ){0,3}(?:diffs?|patch(?:es)?|pull request|PR))\b/i;
const REVIEW_PROMPT_OPENING = 600;
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

/** Whether a delegated task asks for a review of code or the harness, by its title and opening. */
export function isCodeReviewTask(title: string, prompt = ""): boolean {
  // Prompts close with boilerplate such as "verify with the tests", so only the opening counts.
  const text = `${title}\n${prompt.slice(0, REVIEW_PROMPT_OPENING)}`;
  if (REVIEW_ROLE.test(text)) return true;
  return REVIEW_TERM.test(text) && (CODE_CUE.test(text) || VERDICT_CUE.test(title));
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
  const source = stripHeredocBodies(raw).replace(/\\\r?\n/g, "");
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

/** Programs and shell keywords that come before the command that does the work. */
const COMMAND_WRAPPERS = new Set(
  "sudo env command builtin nohup time exec if then elif else while until do { !".split(" "),
);
// `node sim.mjs` needs no exemption: a JS runner writes no operand, while `cp x sim.mjs` must count.
const ALL_ARG_WRITERS = new Set(["rm", "unlink", "truncate", "touch", "shred", "tee", "mv"]);
const LAST_ARG_WRITERS = new Set(["cp", "install", "ln", "rsync"]);
const SUFFIX_OPTION = /^(?:-[a-zA-Z]*S|--suffix)$/;
/** Per command, the options whose following word is their argument rather than a file it writes. */
const VALUE_OPTIONS = new Map([
  ["touch", /^(?:-[acfhm]*[drt]|--date|--reference)$/],
  ["cp", SUFFIX_OPTION],
  ["mv", SUFFIX_OPTION],
  ["ln", SUFFIX_OPTION],
  ["install", /^(?:-[a-zA-Z]*[gmoS]|--(?:group|mode|owner|suffix))$/],
  ["rsync", /^(?:-[a-zA-Z]*[ef]|--(?:rsh|filter|exclude|include|exclude-from|include-from))$/],
]);
const TARGET_DIR_OPTION = /^(?:--target-directory(?:=|$)|-(?:(?![gmoSt])[a-zA-Z])*t)(.*)$/;
const DEVICE_TARGET = /^\/dev\/(?:null|stderr|stdout|tty|fd\/\d+)$/;
const BACKUP_TARGET = /(?:^|\/)backups\/|\.bak(?:-|$)/;
const HOME_PREFIX = /^(?:~|\$HOME|\$\{HOME\})(?=\/|$)/;

/** `words` from the command name on, past assignments, `sudo` and the like. */
function commandWords(words: ReadonlyArray<ShellWord>): ReadonlyArray<ShellWord> {
  const start = words.findIndex(
    (word) =>
      !/^[A-Za-z_][A-Za-z0-9_]*=/.test(word.value) &&
      !COMMAND_WRAPPERS.has(NodePath.basename(word.value)),
  );
  return start === -1 ? [] : words.slice(start);
}

/** The DIR of `-t DIR` or `--target-directory=DIR`, which takes the last operand's place. */
function targetDirectory(args: ReadonlyArray<ShellWord>): ShellWord | undefined {
  for (const [index, word] of args.entries()) {
    const match = TARGET_DIR_OPTION.exec(word.value);
    if (match) return match[1] ? { ...word, value: match[1] } : args[index + 1];
  }
  return undefined;
}

function commandWriteTargets(words: ReadonlyArray<ShellWord>): Array<ShellWord> {
  const [command, ...args] = commandWords(words);
  const name = NodePath.basename(command?.value ?? "");
  const valueOption = VALUE_OPTIONS.get(name);
  const operands = args.filter(
    (word, index) =>
      !word.value.startsWith("-") && !valueOption?.test(args[index - 1]?.value ?? ""),
  );
  // rsync's `-t` preserves times; for the others it names the destination.
  const directory =
    name !== "rsync" && (LAST_ARG_WRITERS.has(name) || name === "mv")
      ? targetDirectory(args)
      : undefined;
  if (ALL_ARG_WRITERS.has(name)) return directory ? [...operands, directory] : operands;
  if (LAST_ARG_WRITERS.has(name)) return directory ? [directory] : operands.slice(-1);
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

/**
 * `path` as seen from the shell directory `cwd`, or null when that cannot be known. An empty `cwd`
 * leaves a relative path for the caller to resolve.
 */
function resolveShellPath(cwd: string | null, path: string): string | null {
  if (NodePath.isAbsolute(path) || HOME_PREFIX.test(path)) return path;
  if (cwd === null || path.startsWith("~")) return null;
  if (!cwd) return path;
  if (!HOME_PREFIX.test(cwd)) return NodePath.join(cwd, path);
  const joined = NodePath.posix.join(cwd, path);
  return HOME_PREFIX.test(joined) ? joined : null;
}

/** The shell directory after one command: moved by `cd`, null when its argument is unresolvable. */
function directoryAfter(cwd: string | null, words: ReadonlyArray<ShellWord>): string | null {
  const [command, ...args] = commandWords(words);
  if (command?.value !== "cd") return cwd;
  const directory = args.find((word) => word.value === "-" || !word.value.startsWith("-"));
  if (!directory) return "~";
  if (directory.dynamic || directory.value === "-" || /[*?[]/.test(directory.value)) return null;
  return resolveShellPath(cwd, directory.value);
}

/**
 * Conservative list of paths a Bash command writes, removes, or renames. Relative paths resolve
 * against `initialCwd` and each `cd` since; unresolvable ones, devices, and backups are skipped.
 */
export function detectShellWriteTargets(command: string, initialCwd = ""): Array<string> {
  const targets = new Set<string>();
  const subshells: Array<string | null> = [];
  let cwd: string | null = initialCwd;
  let words: Array<ShellWord> = [];
  let redirected: Array<ShellWord> = [];
  let previousOp = ";";
  const flush = (nextOp: string) => {
    for (const word of [...redirected, ...commandWriteTargets(words)]) {
      const path = word.dynamic ? null : resolveShellPath(cwd, word.value);
      if (path !== null && !DEVICE_TARGET.test(path) && !BACKUP_TARGET.test(path))
        targets.add(path);
    }
    // A `cd` in a pipeline, a background job, or an `||` fallback does not move what follows.
    if (previousOp !== "|" && previousOp !== "||" && nextOp !== "|" && nextOp !== "&")
      cwd = directoryAfter(cwd, words);
    // A newline right after `|` or `||` continues that command line.
    if (nextOp !== "\n" || words.length > 0) previousOp = nextOp;
    words = [];
    redirected = [];
  };
  const tokens = tokenizeShell(command);
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i]!;
    if (token.kind === "op") {
      flush(token.value);
      if (token.value === "(") subshells.push(cwd);
      else if (token.value === ")") {
        const outer = subshells.pop();
        if (outer !== undefined) cwd = outer;
      }
    } else if (token.kind === "redir") {
      const target = tokens[i + 1];
      if (target?.kind !== "word") continue;
      i += 1;
      if (token.value.includes(">") && !token.value.endsWith("&")) redirected.push(target);
    } else {
      words.push(token);
    }
  }
  flush(";");
  return [...targets];
}

/** `~/.claude/` names the configured harness dir, as in the record; other `~/` paths the home dir. */
export function expandWriteTarget(raw: string, paths: SimResolvedPaths): string {
  return raw.trim().startsWith("~/.claude/")
    ? expandHarnessFile(raw, paths)
    : expandHomeString(raw, paths.homeDir);
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

const make = Effect.gen(function* () {
  const engine = yield* Orchestrator.OrchestratorV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const projectStore = yield* Effect.serviceOption(ProjectStoreV2);
  const settingsService = yield* ServerSettings.ServerSettingsService;
  const sim = yield* SimService;

  const handledItems = new Map<string, true>();
  const activeProviderThread = new Map<ThreadId, string>();
  const claudeSession = new Map<ThreadId, string>();
  const threadCwd = new Map<ThreadId, string | undefined>();
  const pendingHarness = new Map<string, Set<string>>();
  const threadSelection = new Map<ThreadId, Selection>();
  const runSelectionById = new Map<string, Selection>();
  const interruptReasons = new Map<string, string>();
  const interrupted = new Map<ThreadId, InterruptedRun>();
  let observedModels: Set<string> | undefined;

  const pendingKey = (threadId: string, runId: string) => `${threadId}\u0000${runId}`;

  const cwdFor = Effect.fnUntraced(function* (threadId: ThreadId) {
    if (threadCwd.has(threadId)) return threadCwd.get(threadId);
    const thread = yield* projections.findThread(threadId);
    let cwd = thread?.worktreePath ?? undefined;
    if (!cwd && thread?.projectId && Option.isSome(projectStore)) {
      const project = yield* projectStore.value
        .getShell(thread.projectId)
        .pipe(Effect.orElseSucceed(() => Option.none()));
      cwd = Option.getOrUndefined(project)?.workspaceRoot;
    }
    remember(threadCwd, threadId, cwd);
    return cwd;
  });

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
      const expanded = expandWriteTarget(raw, paths);
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
  ) {
    const key = pendingKey(event.threadId, run.id);
    const pending = pendingHarness.get(key);
    if (!pending) return;
    pendingHarness.delete(key);
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
    for (const file of pending) {
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
    });
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
    paths: SimResolvedPaths,
  ) {
    const item = event.payload;
    if (item.type === "run_interrupt_request" && item.runId) {
      remember(interruptReasons, item.runId, item.message);
      return;
    }
    if (item.status !== "completed") return;
    if (item.type === "compaction") {
      if (firstSighting(handledItems, `compaction:${item.id}`))
        yield* resetEpoch(event.threadId, []);
    } else if (item.type === "file_change") {
      if (!firstSighting(handledItems, `file:${item.id}`)) return;
      const files = [item.fileName, ...(item.changes ?? []).map((change) => change.path)];
      yield* classifyFiles(event, item, files, paths);
    } else if (item.type === "command_execution") {
      if (!firstSighting(handledItems, `command:${item.id}`)) return;
      const cwd = yield* cwdFor(event.threadId);
      yield* classifyFiles(event, item, detectShellWriteTargets(item.input, cwd), paths);
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
  ) {
    const run = event.payload;
    remember(runSelectionById, run.id, runSelection(run));
    remember(threadSelection, event.threadId, runSelection(run));
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
    if (TERMINAL_RUN_STATUSES.has(run.status)) yield* flushPendingHarness(event, run);
  });

  const handleEvent = Effect.fnUntraced(function* (event: OrchestrationV2DomainEvent) {
    const settings = yield* settingsService.getSettings;
    if (!settings.sim.enabled) return;
    switch (event.type) {
      case "turn-item.updated":
        return yield* handleTurnItem(event, resolveSimPaths(settings.sim));
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
        return yield* handleRunCreated(event);
      case "run.updated":
        return yield* handleRunUpdated(event);
      case "subagent.updated": {
        const subagent = event.payload;
        if (subagent.status !== "completed") return;
        if (
          !isCodeReviewTask(subagent.title ?? "", subagent.prompt) ||
          !firstSighting(handledItems, `subagent:${subagent.id}`)
        )
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

export const layer = Layer.effect(SimObserverReactor, make);
