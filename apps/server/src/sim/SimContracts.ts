// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import type {
  ModelSelection,
  ProjectId,
  ProviderInstanceId,
  RunId,
  ServerSettings,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

export const SIM_ACTIONS = ["add", "revise", "replace", "remove"] as const;
export type SimAction = (typeof SIM_ACTIONS)[number];

export const SIM_DEPENDS = ["model", "environment", "project", "user"] as const;
export type SimDepend = (typeof SIM_DEPENDS)[number];

export const SIM_RESULTS = [
  "fixed",
  "missed",
  "regressed",
  "misfired",
  "inconclusive",
  "kept",
] as const;
export type SimResult = (typeof SIM_RESULTS)[number];

export const SIM_SOURCES = ["user", "log", "test", "self"] as const;
export type SimSource = (typeof SIM_SOURCES)[number];

export const SIM_LINK_KINDS = ["refines", "refined-by", "related", "conflicts"] as const;
export type SimLinkKind = (typeof SIM_LINK_KINDS)[number];

export const SIM_LINK_INVERSE: Readonly<Record<SimLinkKind, SimLinkKind>> = {
  refines: "refined-by",
  "refined-by": "refines",
  related: "related",
  conflicts: "conflicts",
};

/** Journal event format version. Stays 2 for full replay compatibility with standalone sim.mjs. */
export const SIM_FORMAT = 2;
/** sim.json schema version, matching standalone sim.mjs byte-for-byte. */
export const SIM_SCHEMA = 3;
export const SIM_GENESIS = "genesis";
export const SIM_UNKNOWN = "unknown";
export const SIM_TEXT_LIMIT = 1000;
export const SIM_NAME_LIMIT = 300;
export const SIM_DEFAULT_PAGE_CHARS = 20_000;
export const SIM_INDEX_BUDGET = 6_000;
export const SIM_FULL_BUDGET = 40_000;

export type SimSettingsConfig = ServerSettings["sim"];

export interface SimAmendmentRecord {
  readonly seq: number;
  readonly field: string;
  readonly reason: string;
  readonly was: unknown;
}

export interface SimRetractionRecord {
  readonly seq: number;
  readonly reason: string;
}

export interface SimRestorationRecord {
  readonly seq: number;
  readonly reason: string;
  readonly retracted_because: string;
}

export interface SimObservation {
  date: string;
  result: SimResult;
  evidence: string;
  source: SimSource;
  policy: string;
  domain: string;
  harness?: string;
  sample: string;
  by: string;
  also?: string;
  target?: string;
  retracted?: SimRetractionRecord;
  restored?: SimRestorationRecord;
}

export interface SimAttempt {
  id: string;
  round: string;
  sample: string;
  by: string;
  also?: string;
  accepted: boolean;
  backfilled: boolean;
  action: SimAction;
  what: string;
  why: string;
  files: Array<string>;
  anchor: string | null;
  supersedes: Array<string>;
  depends_on: Array<SimDepend>;
  predicted: Array<string>;
  expect: string | null;
  policy: string;
  domain: string;
  harness?: string;
  considered: Array<string>;
  observations: Array<SimObservation>;
  recorded?: { by: string; day: string };
  unanswered?: boolean;
  rejected_because?: string;
  retracted?: SimRetractionRecord;
  restored?: SimRestorationRecord;
  amended?: Array<SimAmendmentRecord>;
  missed: Array<string>;
  fixed: Array<string>;
  pending: Array<string>;
  passed: number;
  total: number;
  superseded_by: string | null;
  live: boolean;
}

export interface SimProblemLink {
  id: string;
  kind: SimLinkKind;
}

export interface SimProblem {
  id: string;
  name: string;
  opened_round: string;
  former_names: Array<string>;
  related: Array<SimProblemLink>;
  attempts: Array<SimAttempt>;
  amended?: Array<SimAmendmentRecord>;
}

export interface SimCarrySide {
  policy?: string;
  domain?: string;
  harness?: string;
}

export interface SimCarryEntry {
  date: string;
  from: SimCarrySide;
  into: SimCarrySide;
  note?: string;
}

export interface SimState {
  schema: number;
  next_id: number;
  next_attempt: number;
  events: number;
  head: string;
  carried_from: Array<SimCarryEntry>;
  aliases: Record<string, string>;
  problems: Array<SimProblem>;
}

export type SimJournalOp = "attempt" | "observe" | "merge" | "link" | "carry" | "amend" | "retract";

/**
 * Journal line envelope. `harness` lives on the top-level envelope (never in `data` for
 * attempt/observe) so unmodified standalone `sim.mjs` (format v2) replays every T3 event
 * cleanly without tripping `unknownFields` on `event.data`.
 */
export interface SimJournalEvent {
  readonly seq: number;
  readonly ts: string;
  readonly day: string;
  readonly by: string;
  readonly also?: string;
  readonly harness?: string;
  readonly v: number;
  readonly op: SimJournalOp;
  readonly data: Record<string, unknown>;
  readonly prev: string;
}

export type SimErrorCode =
  | "validation"
  | "seen_required"
  | "journal_broken"
  | "forbidden_path"
  | "drift"
  | "not_found"
  | "io"
  | "disabled";

export class SimServiceError extends Schema.TaggedError<SimServiceError>()("SimServiceError", {
  code: Schema.Literals([
    "validation",
    "seen_required",
    "journal_broken",
    "forbidden_path",
    "drift",
    "not_found",
    "io",
    "disabled",
  ]),
  problems: Schema.Array(Schema.String),
}) {
  override get message(): string {
    return this.problems.join("\n");
  }
}

export interface SimResolvedPaths {
  readonly homeDir: string;
  readonly harnessDir: string;
  readonly simDir: string;
  readonly backupsDir: string;
  readonly journalPath: string;
  readonly recordPath: string;
  readonly lockPath: string;
  readonly seenDir: string;
  readonly epochsPath: string;
  readonly telemetryPath: string;
  readonly metricsPath: string;
  readonly jevUsagePath: string;
  readonly auditStatePath: string;
}

export function expandHomeString(rawPath: string, homeDir: string = NodeOS.homedir()): string {
  return String(rawPath ?? "")
    .trim()
    .replace(/^~(?=\/|$)/, homeDir)
    .replace(/^\$(?:HOME|\{HOME\})(?=\/|$)/, homeDir);
}

export function resolveSimPaths(
  settings?: Partial<Pick<SimSettingsConfig, "simDir" | "harnessDir">>,
  homeDir: string = NodeOS.homedir(),
): SimResolvedPaths {
  const configuredSim = settings?.simDir?.trim() ?? "";
  const configuredHarness = settings?.harnessDir?.trim() ?? "";
  const simDir = configuredSim
    ? NodePath.resolve(expandHomeString(configuredSim, homeDir))
    : configuredHarness
      ? NodePath.join(NodePath.resolve(expandHomeString(configuredHarness, homeDir)), "sim")
      : NodePath.join(homeDir, ".claude", "sim");
  const harnessDir = configuredHarness
    ? NodePath.resolve(expandHomeString(configuredHarness, homeDir))
    : configuredSim
      ? NodePath.dirname(simDir)
      : NodePath.join(homeDir, ".claude");
  return {
    homeDir,
    harnessDir,
    simDir,
    backupsDir: NodePath.join(harnessDir, "backups", "sim"),
    journalPath: NodePath.join(simDir, "sim.jsonl"),
    recordPath: NodePath.join(simDir, "sim.json"),
    lockPath: NodePath.join(simDir, "sim.lock"),
    seenDir: NodePath.join(simDir, "seen"),
    epochsPath: NodePath.join(simDir, "t3-epochs.json"),
    telemetryPath: NodePath.join(simDir, "telemetry.jsonl"),
    metricsPath: NodePath.join(simDir, "metrics.jsonl"),
    jevUsagePath: NodePath.join(simDir, "jev-usage.json"),
    auditStatePath: NodePath.join(harnessDir, "state", "sim-audit-state.json"),
  };
}

/** Store harness paths in one canonical spelling matching standalone sim.mjs. */
export function canonicalHarnessFile(
  file: string,
  paths: Pick<SimResolvedPaths, "homeDir" | "harnessDir">,
): string {
  let value = String(file)
    .trim()
    .replace(/^\$(?:HOME|\{HOME\})\//, "~/");
  const harnessPrefix = `${paths.harnessDir}/`;
  const homePrefix = `${paths.homeDir}/`;
  if (value.startsWith(harnessPrefix)) {
    return `~/.claude/${value.slice(harnessPrefix.length)}`;
  }
  if (value.startsWith(homePrefix)) {
    value = `~/${value.slice(homePrefix.length)}`;
  }
  return value;
}

export function expandHarnessFile(
  file: string,
  paths: Pick<SimResolvedPaths, "homeDir" | "harnessDir">,
): string {
  const trimmed = String(file).trim();
  if (trimmed.startsWith("~/.claude/")) {
    return NodePath.join(paths.harnessDir, trimmed.slice("~/.claude/".length));
  }
  if (trimmed.startsWith("~/")) {
    return NodePath.join(paths.homeDir, trimmed.slice(2));
  }
  return trimmed;
}

function canonicalRealPath(rawPath: string, cwd: string | undefined, homeDir: string): string {
  const expanded = expandHomeString(rawPath, homeDir);
  let current = NodePath.resolve(cwd || "/", expanded);
  const tail: Array<string> = [];
  while (!NodeFS.existsSync(current)) {
    const parent = NodePath.dirname(current);
    if (parent === current) break;
    tail.unshift(NodePath.basename(current));
    current = parent;
  }
  try {
    current = NodeFS.realpathSync(current);
  } catch {
    // Keep resolved path when realpath is unavailable.
  }
  return tail.length ? NodePath.join(current, ...tail) : current;
}

function isUnderDir(target: string, dir: string): boolean {
  const rel = NodePath.relative(dir, target);
  return (
    rel !== "" &&
    !rel.startsWith("..") &&
    !rel.startsWith(NodePath.sep) &&
    !NodePath.isAbsolute(rel)
  );
}

const HARNESS_TOP_FILES = new Set([
  "AGENTS.md",
  "CLAUDE.md",
  "settings.json",
  "settings.local.json",
]);
const HARNESS_DIRS = new Set(["notes", "hooks", "skills", "agents", "commands", "output-styles"]);
const PROJECT_CLAUDE_DIRS = new Set(["hooks", "skills", "agents", "commands", "output-styles"]);
const RECORD_FILES = new Set([
  "sim.json",
  "sim.jsonl",
  "sim.lock",
  "telemetry.jsonl",
  "metrics.jsonl",
  "jev-usage.json",
  "t3-epochs.json",
]);

export function isPathWithinRoot(
  rawPath: string,
  rootDir: string,
  cwd: string | undefined,
  homeDir: string = NodeOS.homedir(),
): boolean {
  if (!rawPath.trim() || !rootDir.trim()) return false;
  const target = canonicalRealPath(rawPath, cwd, homeDir);
  const root = canonicalRealPath(rootDir, "/", homeDir);
  return target === root || isUnderDir(target, root);
}

/**
 * Classify a file path as a protected SIM record file ("record"), an agent harness file ("harness"),
 * or an ordinary workspace file (null). Matches `sim-gate.mjs` semantics.
 */
export function classifyHarnessPath(
  rawPath: string,
  paths: Pick<SimResolvedPaths, "homeDir" | "harnessDir" | "simDir">,
  cwd?: string,
  options?: { readonly allowTmp?: boolean },
): "record" | "harness" | null {
  if (!rawPath || !rawPath.trim()) return null;
  const target = canonicalRealPath(rawPath, cwd, paths.homeDir);
  const harness = canonicalRealPath(paths.harnessDir, "/", paths.homeDir);
  const simDir = canonicalRealPath(paths.simDir, "/", paths.homeDir);

  if (target === simDir) return "record";
  if (isUnderDir(target, simDir)) {
    const rel = NodePath.relative(simDir, target);
    const parts = rel.split(NodePath.sep);
    if (parts[0] === "seen" || RECORD_FILES.has(rel)) {
      return "record";
    }
    if ((rel.endsWith(".mjs") || rel.endsWith(".sh")) && !rel.endsWith(".test.mjs")) {
      return "harness";
    }
    return null;
  }
  if (isUnderDir(target, harness)) {
    const rel = NodePath.relative(harness, target);
    const parts = rel.split(NodePath.sep);
    const top = parts[0] ?? "";
    if (top === "backups" || top === "projects" || top === "state") return null;
    if (HARNESS_TOP_FILES.has(rel)) return "harness";
    if (HARNESS_DIRS.has(top) && parts.length > 1) return "harness";
    return null;
  }
  if (options?.allowTmp !== true) {
    const tmpDirs = [
      canonicalRealPath(NodeOS.tmpdir(), "/", paths.homeDir),
      canonicalRealPath("/tmp", "/", paths.homeDir),
      canonicalRealPath("/var/tmp", "/", paths.homeDir),
    ];
    if (tmpDirs.some((tmp) => target === tmp || isUnderDir(target, tmp))) return null;
  }
  const base = NodePath.basename(target);
  if (base === "AGENTS.md" || base === "CLAUDE.md") return "harness";
  if (
    (base === "settings.json" || base === "settings.local.json") &&
    NodePath.basename(NodePath.dirname(target)) === ".claude"
  ) {
    return "harness";
  }
  const segs = target.split(NodePath.sep);
  for (let i = 0; i < segs.length - 1; i += 1) {
    const next = segs[i + 1];
    if (segs[i] === ".claude" && next !== undefined && PROJECT_CLAUDE_DIRS.has(next)) {
      if (i + 2 < segs.length) return "harness";
    }
  }
  return null;
}

/**
 * Authenticated caller identity derived server-side from McpInvocationContext + ProjectionStore.
 * Never populated from caller-supplied tool arguments.
 */
export interface SimCallerContext {
  readonly sessionId: string;
  readonly alsoSessionId?: string | undefined;
  /** True when the caller is in the same fork/side-chat family as an attempt's author. */
  readonly forkFamilySessionIds?: ReadonlyArray<string> | undefined;
  readonly threadId?: ThreadId | undefined;
  readonly activeRunId?: RunId | undefined;
  readonly providerInstanceId?: ProviderInstanceId | undefined;
  readonly driver?: string | undefined;
  readonly model?: string | undefined;
  readonly projectId?: ProjectId | undefined;
  readonly projectName?: string | undefined;
  readonly workspaceRoot?: string | undefined;
  readonly subagent?: boolean | undefined;
}

export interface SimAdvisorEscalationCandidate {
  readonly kind:
    | "recurring_failures"
    | "cross_harness_conflict"
    | "new_model_generation"
    | "repeated_drift";
  readonly id?: string | undefined;
  readonly summary: string;
}

export interface SimAdvisorEscalation {
  readonly modelSelection: ModelSelection;
  readonly candidates: ReadonlyArray<SimAdvisorEscalationCandidate>;
  readonly guidance: string;
}

export type SimTelemetryEvent =
  | {
      readonly ts: string;
      readonly kind: "unrecorded_harness_edit";
      readonly threadId: string;
      readonly runId?: string | undefined;
      readonly providerInstanceId?: string | undefined;
      readonly model?: string | undefined;
      readonly files: ReadonlyArray<string>;
      readonly verifiedByHash?: boolean | undefined;
    }
  | {
      readonly ts: string;
      readonly kind: "direct_sim_record_edit";
      readonly threadId: string;
      readonly runId?: string | undefined;
      readonly providerInstanceId?: string | undefined;
      readonly model?: string | undefined;
      readonly files: ReadonlyArray<string>;
    }
  | {
      readonly ts: string;
      readonly kind: "checkpoint_rollback";
      readonly threadId: string;
      readonly runId?: string | undefined;
      readonly checkpointId?: string | undefined;
      readonly providerInstanceId?: string | undefined;
      readonly model?: string | undefined;
    }
  | {
      readonly ts: string;
      readonly kind: "mid_thread_model_switch";
      readonly threadId: string;
      readonly fromProvider?: string | undefined;
      readonly fromModel?: string | undefined;
      readonly toProvider?: string | undefined;
      readonly toModel?: string | undefined;
    }
  | {
      readonly ts: string;
      readonly kind: "interrupted_with_steer";
      readonly threadId: string;
      readonly interruptedRunId?: string | undefined;
      readonly followupRunId?: string | undefined;
      readonly providerInstanceId?: string | undefined;
      readonly model?: string | undefined;
      readonly reason?: string | undefined;
    }
  | {
      readonly ts: string;
      readonly kind: "new_model_observed";
      readonly threadId?: string | undefined;
      readonly providerInstanceId: string;
      readonly model: string;
    }
  | {
      readonly ts: string;
      readonly kind: "delegated_review_completed";
      readonly threadId: string;
      readonly childThreadId?: string | undefined;
      readonly providerInstanceId?: string | undefined;
      readonly model?: string | undefined;
      readonly title?: string | undefined;
      readonly excerpt?: string | undefined;
    }
  | {
      readonly ts: string;
      readonly kind: "detector_evaluated";
      readonly threadId: string;
      readonly runId?: string | undefined;
      readonly providerInstanceId?: string | undefined;
      readonly model?: string | undefined;
      readonly project?: string | undefined;
      readonly detectorId: string;
      readonly problemId?: string | undefined;
      readonly attemptId?: string | undefined;
      readonly verdict: "passed" | "violated" | "uncertain" | "misfired";
      readonly source: "deterministic" | "jev" | "replay";
      readonly confidence?: number | undefined;
      readonly evidence?: string | undefined;
    }
  | {
      readonly ts: string;
      readonly kind: "jev_correction_signal";
      readonly threadId: string;
      readonly runId?: string | undefined;
      readonly providerInstanceId?: string | undefined;
      readonly model?: string | undefined;
      readonly project?: string | undefined;
      readonly scores: Readonly<Record<string, number>>;
      readonly flagged: boolean;
      readonly excerpt?: string | undefined;
    }
  | {
      readonly ts: string;
      readonly kind: "turn_ending_classified";
      readonly threadId: string;
      readonly runId?: string | undefined;
      readonly providerInstanceId?: string | undefined;
      readonly model?: string | undefined;
      readonly project?: string | undefined;
      readonly waitingForUser: number;
      readonly manualHandoff: number;
      readonly unverifiedDoneClaim: number;
      readonly label: "finished" | "waiting_for_user" | "manual_handoff" | "unverified_done";
    };

export type SimMetricEvent =
  | {
      readonly ts: string;
      readonly kind: "observation";
      readonly detectorId: string;
      readonly ruleKey: string;
      readonly problemId?: string | undefined;
      readonly attemptId?: string | undefined;
      readonly verdict: "passed" | "violated" | "uncertain" | "misfired";
      readonly source: "deterministic" | "jev" | "replay";
      readonly confidence?: number | undefined;
      readonly providerInstanceId: string;
      readonly model: string;
      readonly project?: string | undefined;
      readonly threadId?: string | undefined;
      readonly runId?: string | undefined;
      readonly evidence?: string | undefined;
    }
  | {
      readonly ts: string;
      readonly kind: "injection";
      readonly ruleKey: string;
      readonly problemId?: string | undefined;
      readonly attemptId?: string | undefined;
      readonly delivery: "base" | "jit" | "candidate";
      readonly bytes: number;
      readonly estimatedTokens: number;
      readonly providerInstanceId: string;
      readonly model: string;
      readonly project?: string | undefined;
      readonly threadId?: string | undefined;
    };

export interface SimReadRequest {
  readonly action:
    | "index"
    | "show"
    | "brief_all"
    | "brief"
    | "find"
    | "by_file"
    | "check"
    | "review"
    | "metrics"
    | "roi";
  readonly ids?: ReadonlyArray<string> | undefined;
  readonly brief?: boolean | undefined;
  readonly query?: string | undefined;
  readonly file?: string | undefined;
  readonly policy?: string | undefined;
  readonly harness?: string | undefined;
  readonly page?: number | undefined;
  readonly days?: number | undefined;
  readonly maxTokens?: number | undefined;
}

export interface SimReadResult {
  readonly text: string;
  readonly failed?: boolean | undefined;
  readonly advisorEscalation?: SimAdvisorEscalation | undefined;
}

export interface SimAttemptInput {
  readonly problem?: string | undefined;
  readonly new?: string | undefined;
  readonly action: SimAction;
  readonly what: string;
  readonly why: string;
  readonly files?: ReadonlyArray<string> | undefined;
  readonly anchor?: string | undefined;
  readonly supersedes?: ReadonlyArray<string> | undefined;
  readonly depends_on?: ReadonlyArray<SimDepend> | undefined;
  readonly predicted?: ReadonlyArray<string> | undefined;
  readonly expect?: string | undefined;
  readonly policy?: string | undefined;
  readonly domain?: string | undefined;
  readonly harness?: string | undefined;
  readonly accepted?: boolean | undefined;
  readonly rejected_because?: string | undefined;
  readonly unanswered?: boolean | undefined;
  readonly backfilled?: boolean | undefined;
  readonly round?: string | undefined;
  readonly sample?: string | undefined;
}

export interface SimObserveInput {
  readonly attempt: string;
  readonly target?: string | undefined;
  readonly result: SimResult;
  readonly evidence: string;
  readonly source: SimSource;
  readonly policy?: string | undefined;
  readonly domain?: string | undefined;
  readonly harness?: string | undefined;
  readonly date?: string | undefined;
  /** Set server-side when the caller shares fork/side-chat lineage with the attempt author. */
  readonly selfGradeReason?: string | undefined;
}

export type SimWriteRequest =
  | { readonly action: "attempt"; readonly input: SimAttemptInput }
  | { readonly action: "observe"; readonly input: SimObserveInput }
  | {
      readonly action: "amend";
      readonly target: string;
      readonly field: string;
      readonly value: string | ReadonlyArray<string>;
      readonly reason: string;
    }
  | {
      readonly action: "retract";
      readonly attempt: string;
      readonly outcome?: number | undefined;
      readonly reason: string;
      readonly undo?: boolean | undefined;
    }
  | { readonly action: "link"; readonly a: string; readonly kind: SimLinkKind; readonly b: string }
  | { readonly action: "merge"; readonly from: string; readonly into: string }
  | {
      readonly action: "carry";
      readonly fromPolicy?: string | undefined;
      readonly toPolicy?: string | undefined;
      readonly fromDomain?: string | undefined;
      readonly toDomain?: string | undefined;
      readonly fromHarness?: string | undefined;
      readonly toHarness?: string | undefined;
      readonly date?: string | undefined;
      readonly note?: string | undefined;
    };

export interface SimWriteResult {
  readonly text: string;
  readonly problemId?: string | undefined;
  readonly attemptId?: string | undefined;
  readonly settled?: boolean | undefined;
  readonly unconfirmedReason?: string | undefined;
}

export interface SimApplyHarnessChangeRequest {
  readonly file: string;
  readonly oldText?: string | undefined;
  readonly newText?: string | undefined;
  readonly content?: string | undefined;
  readonly append?: boolean | undefined;
  readonly dryRun?: boolean | undefined;
  readonly attempt: SimAttemptInput;
}

export interface SimApplyHarnessChangeResult {
  readonly dryRun: boolean;
  readonly file: string;
  readonly text: string;
  readonly brief?: string | undefined;
  readonly predictionLine?: string | undefined;
  readonly diffPreview?: string | undefined;
  readonly problemId?: string | undefined;
  readonly attemptId?: string | undefined;
}

export interface SimAuditOptions {
  readonly since?: string | undefined;
  readonly days?: number | undefined;
  readonly limit?: number | undefined;
  readonly includeClaudeLogs?: boolean | undefined;
}

export interface SimAuditReport {
  readonly text: string;
  readonly window: { readonly since: string; readonly source: string };
  readonly threadsScanned: number;
  readonly claudeSessionsScanned: number;
  readonly sim: {
    readonly journalBroken: string | null;
    readonly driftCount: number;
    readonly uncoveredCount: number;
    readonly liveRules: number;
    readonly openPredictions: number;
    readonly missedLiveRules: number;
  };
  readonly signals: {
    readonly verbalCorrections: number;
    readonly unrecordedHarnessEdits: number;
    readonly checkpointRollbacks: number;
    readonly midThreadModelSwitches: number;
    readonly interruptedWithSteer: number;
    readonly delegatedReviews: number;
    readonly newlyObservedModels: ReadonlyArray<{
      readonly providerInstanceId: string;
      readonly model: string;
    }>;
  };
  readonly advisorEscalation?: SimAdvisorEscalation | undefined;
}

export interface SimThreadInspectionResult {
  readonly threadId: string;
  readonly text: string;
}

export interface SimStateSnapshot {
  readonly state: SimState;
  readonly broken: string | null;
  readonly paths: SimResolvedPaths;
}

export class SimService extends Context.Service<
  SimService,
  {
    readonly read: (
      caller: SimCallerContext,
      request: SimReadRequest,
    ) => Effect.Effect<SimReadResult, SimServiceError>;
    readonly write: (
      caller: SimCallerContext,
      request: SimWriteRequest,
    ) => Effect.Effect<SimWriteResult, SimServiceError>;
    readonly applyHarnessChange: (
      caller: SimCallerContext,
      request: SimApplyHarnessChangeRequest,
    ) => Effect.Effect<SimApplyHarnessChangeResult, SimServiceError>;
    readonly resetThreadSeenEpoch: (
      threadId: ThreadId,
      extraSessionIds?: ReadonlyArray<string>,
    ) => Effect.Effect<number>;
    readonly trackProviderThread: (input: {
      readonly threadId: ThreadId;
      readonly providerThreadId: string;
      readonly extraSessionIds?: ReadonlyArray<string> | undefined;
    }) => Effect.Effect<boolean>;
    readonly getThreadSeenEpoch: (threadId: ThreadId) => Effect.Effect<number>;
    readonly recordTelemetry: (event: SimTelemetryEvent) => Effect.Effect<void>;
    readonly readTelemetry: (sinceMs?: number) => Effect.Effect<ReadonlyArray<SimTelemetryEvent>>;
    readonly recordMetrics: (events: ReadonlyArray<SimMetricEvent>) => Effect.Effect<void>;
    readonly readMetrics: (sinceMs?: number) => Effect.Effect<ReadonlyArray<SimMetricEvent>>;
    readonly recordRecentAttemptInTurn: (input: {
      readonly threadId: ThreadId;
      readonly runId?: RunId | undefined;
      readonly workspaceRoot?: string | undefined;
      readonly files: ReadonlyArray<string>;
    }) => Effect.Effect<void>;
    readonly hasRecentAttemptForFile: (input: {
      readonly threadId: ThreadId;
      readonly runId?: RunId | undefined;
      readonly workspaceRoot?: string | undefined;
      readonly file: string;
    }) => Effect.Effect<boolean>;
    readonly getStateSnapshot: () => Effect.Effect<SimStateSnapshot | null>;
    readonly getObservedModels: () => Effect.Effect<ReadonlySet<string>>;
    readonly resolvePaths: () => Effect.Effect<SimResolvedPaths>;
    readonly findAttemptAuthorSessions: (attemptId: string) => Effect.Effect<ReadonlyArray<string>>;
  }
>()("t3/sim/SimContracts/SimService") {}

export class SimAuditService extends Context.Service<
  SimAuditService,
  {
    readonly audit: (
      caller: SimCallerContext,
      options?: SimAuditOptions,
    ) => Effect.Effect<SimAuditReport, SimServiceError>;
    readonly inspectThread: (
      caller: SimCallerContext,
      threadIdPrefix: string,
    ) => Effect.Effect<SimThreadInspectionResult, SimServiceError>;
    readonly markAuditDone: (
      caller: SimCallerContext,
    ) => Effect.Effect<
      { readonly lastAuditAt: string; readonly statePath: string; readonly text: string },
      SimServiceError
    >;
  }
>()("t3/sim/SimContracts/SimAuditService") {}
