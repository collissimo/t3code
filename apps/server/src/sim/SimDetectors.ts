// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import {
  canonicalHarnessFile,
  type SimMetricEvent,
  type SimResolvedPaths,
} from "./SimContracts.ts";

export interface SimDeterministicTriggerMatch {
  readonly triggerId: string;
  readonly ruleKey: string;
  readonly problemId?: string | undefined;
  readonly reason: string;
}

export interface SimTurnToolCall {
  readonly name: string;
  readonly input?: string | undefined;
}

export interface SimTurnEvidence {
  readonly ts: string;
  readonly threadId: string;
  readonly runId?: string | undefined;
  readonly providerInstanceId: string;
  readonly model: string;
  readonly project?: string | undefined;
  readonly userText?: string | undefined;
  readonly assistantText?: string | undefined;
  readonly commands: ReadonlyArray<string>;
  readonly changedFiles: ReadonlyArray<string>;
  readonly toolCalls: ReadonlyArray<SimTurnToolCall>;
  readonly repoOwnership?: "mine" | "foreign" | "unknown" | undefined;
  readonly hasRemote?: boolean | undefined;
  readonly defaultBranch?: string | undefined;
  readonly currentBranch?: string | undefined;
}

export interface SimDetectorEvaluation {
  readonly detectorId: string;
  readonly ruleKey: string;
  readonly problemId?: string | undefined;
  readonly attemptId?: string | undefined;
  readonly verdict: "passed" | "violated";
  readonly evidence: string;
}

export type SimHarnessSnapshot = ReadonlyMap<string, string>;

const REAL_HARNESS_TOP_FILES = [
  "AGENTS.md",
  "CLAUDE.md",
  "settings.json",
  "settings.local.json",
] as const;

const REAL_HARNESS_SUBDIRS = [
  "notes",
  "hooks",
  "skills",
  "agents",
  "commands",
  "output-styles",
] as const;

const sha256File = (path: string): string | null => {
  try {
    return NodeCrypto.createHash("sha256").update(NodeFS.readFileSync(path)).digest("hex");
  } catch {
    return null;
  }
};

const safeRealpath = (path: string): string => {
  try {
    return NodeFS.realpathSync(path);
  } catch {
    return NodePath.resolve(path);
  }
};

function collectFilesRecursive(dir: string, out: Array<string>, depth = 0): void {
  if (depth > 3) return;
  let entries: Array<NodeFS.Dirent>;
  try {
    entries = NodeFS.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    const full = NodePath.join(dir, entry.name);
    if (entry.isDirectory()) {
      collectFilesRecursive(full, out, depth + 1);
    } else if (entry.isFile() || entry.isSymbolicLink()) {
      out.push(full);
    }
  }
}

/**
 * Snapshot SHA-256 digests of the real harness files under `paths.harnessDir` and `paths.simDir`.
 * Comparing snapshots across turn boundaries catches genuine harness edits without shell-parsing
 * false positives from scratch copies, sandboxes, or test runners.
 */
export function snapshotRealHarnessFiles(
  paths: Pick<SimResolvedPaths, "homeDir" | "harnessDir" | "simDir">,
): SimHarnessSnapshot {
  const result = new Map<string, string>();
  const seenReal = new Set<string>();
  const recordFile = (fullPath: string) => {
    const real = safeRealpath(fullPath);
    if (seenReal.has(real)) return;
    seenReal.add(real);
    const hash = sha256File(real);
    if (hash !== null) {
      result.set(canonicalHarnessFile(fullPath, paths), hash);
    }
  };

  for (const top of REAL_HARNESS_TOP_FILES) {
    recordFile(NodePath.join(paths.harnessDir, top));
  }
  for (const subdir of REAL_HARNESS_SUBDIRS) {
    const files: Array<string> = [];
    collectFilesRecursive(NodePath.join(paths.harnessDir, subdir), files);
    for (const file of files) recordFile(file);
  }
  try {
    for (const entry of NodeFS.readdirSync(paths.simDir, { withFileTypes: true })) {
      if (!entry.isFile() && !entry.isSymbolicLink()) continue;
      if (
        (entry.name.endsWith(".mjs") || entry.name.endsWith(".sh")) &&
        !entry.name.endsWith(".test.mjs")
      ) {
        recordFile(NodePath.join(paths.simDir, entry.name));
      }
    }
  } catch {
    // Missing simDir produces an empty sim script snapshot.
  }
  return result;
}

/** Canonical harness files added, modified, or removed between two real-file snapshots. */
export function diffHarnessSnapshots(
  before: SimHarnessSnapshot,
  after: SimHarnessSnapshot,
): ReadonlyArray<string> {
  const changed = new Set<string>();
  for (const [file, hash] of after) {
    if (before.get(file) !== hash) changed.add(file);
  }
  for (const file of before.keys()) {
    if (!after.has(file)) changed.add(file);
  }
  return [...changed].toSorted();
}

const STT_MARKER_RE = /(?:^|\s)\[STT\](?:\s|$)/;
const RULE_INQUIRY_RE =
  /\b(agents\.md|claude\.md|harness|sim-?regeln?|scars?|wins?|notes\/\w+\.md|verify-gate|ui-gate|sim-gate)\b[\s\S]{0,120}\b(bleiben|ändern|entfernen|löschen|raus|weg|behalten|keep|remove|change|delete|update|prun\w*|stay|go)\b|\b(bleiben|ändern|entfernen|löschen|keep|remove|change|delete|stay|go)\b[\s\S]{0,120}\b(agents\.md|claude\.md|harness|regel|rule|hook|scar|win)\b/i;
const GIT_WORKFLOW_CUE_RE =
  /\b(git\s+(?:commit|push|merge|rebase|pr)|pull\s+request|open\s+a?\s*pr|merge\s+pr|gh\s+pr|commit(?:ten|s)?|push(?:en)?)\b/i;
const DELEGATION_CUE_RE =
  /\b(subagent|delegate|delegieren|reviewer|grader|parallel\s+agent|fable|opus|sonnet|haiku)\b/i;

/** Fast, zero-cost deterministic triggers evaluated before a turn runs. */
export function evaluatePreTurnDeterministicTriggers(input: {
  readonly userText?: string | undefined;
}): ReadonlyArray<SimDeterministicTriggerMatch> {
  const text = input.userText?.trim() ?? "";
  if (!text) return [];
  const matches: Array<SimDeterministicTriggerMatch> = [];
  if (STT_MARKER_RE.test(text)) {
    matches.push({
      triggerId: "det:stt_dictation",
      ruleKey: "dictation",
      problemId: "P13",
      reason: "Prompt contains [STT] dictation marker",
    });
  }
  if (RULE_INQUIRY_RE.test(text)) {
    matches.push({
      triggerId: "det:harness_rule_inquiry",
      ruleKey: "sim-rule-inquiry",
      problemId: "P48",
      reason: "Prompt asks whether a harness rule should stay, change, or be removed",
    });
  }
  if (GIT_WORKFLOW_CUE_RE.test(text)) {
    matches.push({
      triggerId: "det:git_workflow",
      ruleKey: "verification-and-git",
      problemId: "P44",
      reason: "Prompt involves git commit, push, merge, or pull request workflow",
    });
  }
  if (DELEGATION_CUE_RE.test(text)) {
    matches.push({
      triggerId: "det:delegation",
      ruleKey: "subagents",
      problemId: "P30",
      reason: "Prompt involves subagents, delegation, or review agents",
    });
  }
  return matches;
}

const GIT_COMMIT_RE = /\bgit\b(?:\s+-[Cc]\s+(?:"[^"]*"|'[^']*'|\S+))*\s+commit(?![\w-])/;
const GIT_PUSH_RE = /\bgit\b(?:\s+-[Cc]\s+(?:"[^"]*"|'[^']*'|\S+))*\s+push(?![\w-])([^\n;&|]*)/;
const GIT_MERGE_RE = /\bgit\b(?:\s+-[Cc]\s+(?:"[^"]*"|'[^']*'|\S+))*\s+merge(?![\w-])/;
const GH_PR_CREATE_RE = /\bgh\s+pr\s+create\b/;
const ATTRIBUTION_RE = /\bCo-Authored-By:\s*|Generated with\b/i;
const VERIFIED_TRAILER_RE = /(?:^|["'\s\\n])Verified:\s*\S/m;
const REUSES_COMMIT_MSG_RE = /\s--no-edit\b|\s-[cC]\s+[0-9a-f]{7,}|\s--(?:reuse|reedit)-message\b/;
const PKILL_F_RE = /(?:^|[;&|(\s])pkill\s+(?:-[a-zA-Z]*f|--full)\b/;
const READING_ACK_RE = /\bIch verstehe:\s*[\s\S]{3,}?\bNicht:/i;
const TEST_OR_CHECK_FILE_RE =
  /(?:^|\/)(?:__tests__\/|.*\.test\.[cm]?[jt]sx?$|.*\.spec\.[cm]?[jt]sx?$|\.github\/workflows\/|vitest\.config\.|jest\.config\.|eslint\.|oxlint\.|biome\.|tsconfig\.)/i;
const TEST_EXEC_RE =
  /\b(?:vitest|jest|pytest|cargo\s+test|go\s+test|pnpm\s+test|npm\s+test|vp\s+test|vp\s+run\s+check)\b/;
const EXPENSIVE_PLANNER_RE = /\b(?:fable|mythos)\b/i;

function pushTargetsDefaultBranch(
  command: string,
  defaultBranch?: string,
  currentBranch?: string,
): boolean {
  const match = GIT_PUSH_RE.exec(command);
  if (!match) return false;
  const rest = match[1] ?? "";
  const tokens = rest
    .trim()
    .split(/\s+/)
    .filter((token) => token.length > 0 && !token.startsWith("-"));
  const defaultNames = new Set(
    ["main", "master", defaultBranch].filter((value): value is string => Boolean(value)),
  );
  if (tokens.length === 0) {
    return currentBranch !== undefined && defaultNames.has(currentBranch);
  }
  const refspecs = tokens.slice(1);
  if (refspecs.length === 0) {
    return currentBranch !== undefined && defaultNames.has(currentBranch);
  }
  return refspecs.some((spec) => {
    const dest = spec.includes(":") ? (spec.split(":")[1] ?? "") : spec;
    const bare = dest.replace(/^refs\/heads\//, "");
    return bare === "HEAD"
      ? currentBranch !== undefined && defaultNames.has(currentBranch)
      : defaultNames.has(bare);
  });
}

/**
 * Evaluate all deterministic rule detectors on one completed run.
 * Produces BOTH passed (opportunity fulfilled) and violated outcomes so SIM builds a real
 * denominator per rule, provider, and model.
 */
export function evaluateRunDetectors(
  evidence: SimTurnEvidence,
): ReadonlyArray<SimDetectorEvaluation> {
  const results: Array<SimDetectorEvaluation> = [];
  const commands = evidence.commands;
  const toolNames = new Set(evidence.toolCalls.map((call) => call.name));

  // 1. Foreign-repo attribution check (P22 / A30)
  if (evidence.repoOwnership === "foreign") {
    const foreignCommitOrPr = commands.filter(
      (cmd) => GIT_COMMIT_RE.test(cmd) || GH_PR_CREATE_RE.test(cmd),
    );
    if (foreignCommitOrPr.length > 0) {
      const violated = foreignCommitOrPr.find((cmd) => ATTRIBUTION_RE.test(cmd));
      results.push({
        detectorId: "det:foreign_repo_attribution",
        ruleKey: "foreign-repo-attribution",
        problemId: "P22",
        attemptId: "A30",
        verdict: violated ? "violated" : "passed",
        evidence: violated
          ? `Attribution marker found in foreign-repo command: ${violated.slice(0, 140)}`
          : `Foreign-repo commit/PR command omitted AI attribution (${foreignCommitOrPr.length} command(s))`,
      });
    }
  }

  // 2. Verified commit trailer in owner repo (P44 / A104)
  if (evidence.repoOwnership === "mine") {
    const commitCmds = commands.filter((cmd) => GIT_COMMIT_RE.test(cmd));
    if (commitCmds.length > 0) {
      const missing = commitCmds.find(
        (cmd) => !REUSES_COMMIT_MSG_RE.test(cmd) && !VERIFIED_TRAILER_RE.test(cmd),
      );
      results.push({
        detectorId: "det:verified_commit_trailer",
        ruleKey: "verified-commit-trailer",
        problemId: "P44",
        verdict: missing ? "violated" : "passed",
        evidence: missing
          ? `Owner-repo commit omitted Verified: trailer: ${missing.slice(0, 140)}`
          : `Owner-repo commit included Verified: trailer (${commitCmds.length} commit(s))`,
      });
    }
  }

  // 3. Direct push to default branch (Git hard limit)
  const pushCmds = commands.filter((cmd) => GIT_PUSH_RE.test(cmd));
  if (pushCmds.length > 0) {
    const directPush = pushCmds.find((cmd) =>
      pushTargetsDefaultBranch(cmd, evidence.defaultBranch, evidence.currentBranch),
    );
    results.push({
      detectorId: "det:direct_push_default_branch",
      ruleKey: "no-direct-push-default-branch",
      problemId: "P23",
      verdict: directPush ? "violated" : "passed",
      evidence: directPush
        ? `Push targeted default branch (${evidence.defaultBranch ?? evidence.currentBranch ?? "main"}): ${directPush.slice(0, 140)}`
        : `Push targeted non-default branch (${pushCmds.length} push(es))`,
    });
  }

  // 4. Local merge into default branch when a remote exists (P23)
  if (evidence.hasRemote === true) {
    const mergeCmds = commands.filter((cmd) => GIT_MERGE_RE.test(cmd));
    const defaultNames = new Set(
      ["main", "master", evidence.defaultBranch].filter((value): value is string => Boolean(value)),
    );
    if (mergeCmds.length > 0 && evidence.currentBranch !== undefined) {
      const onDefault = defaultNames.has(evidence.currentBranch);
      results.push({
        detectorId: "det:local_merge_default_branch",
        ruleKey: "no-local-merge-with-remote",
        problemId: "P23",
        verdict: onDefault ? "violated" : "passed",
        evidence: onDefault
          ? `Local git merge executed on default branch ${evidence.currentBranch} with remote configured`
          : `git merge executed on feature branch ${evidence.currentBranch}`,
      });
    }
  }

  // 5. PR opened via CLI must be linked to the thread
  const prCreateCmds = commands.filter((cmd) => GH_PR_CREATE_RE.test(cmd));
  if (prCreateCmds.length > 0) {
    const linked =
      toolNames.has("link_pull_request") ||
      toolNames.has("link_pull_requests") ||
      toolNames.has("mcp__t3-code__link_pull_request") ||
      toolNames.has("mcp__t3-code__link_pull_requests");
    results.push({
      detectorId: "det:pr_linked_after_create",
      ruleKey: "link-created-pr",
      verdict: linked ? "passed" : "violated",
      evidence: linked
        ? "Pull request created via CLI and linked to thread"
        : "Pull request created via `gh pr create` without calling link_pull_request",
    });
  }

  // 6. Dictated prompt ([STT]) reading check (P13 / A91)
  if (evidence.userText && STT_MARKER_RE.test(evidence.userText)) {
    const acknowledged = Boolean(
      evidence.assistantText && READING_ACK_RE.test(evidence.assistantText),
    );
    results.push({
      detectorId: "det:stt_reading_declared",
      ruleKey: "dictation-intent-reading",
      problemId: "P13",
      attemptId: "A91",
      verdict: acknowledged ? "passed" : "violated",
      evidence: acknowledged
        ? "[STT] prompt answered with explicit intent reading ('Ich verstehe: ... Nicht: ...')"
        : "[STT] prompt answered without declaring reading ('Ich verstehe: ... Nicht: ...')",
    });
  }

  // 7. Test/CI config modified without source edits when running checks (P43 / A103)
  if (evidence.changedFiles.length > 0 && commands.some((cmd) => TEST_EXEC_RE.test(cmd))) {
    const testOrCiFiles = evidence.changedFiles.filter((file) => TEST_OR_CHECK_FILE_RE.test(file));
    const implFiles = evidence.changedFiles.filter((file) => !TEST_OR_CHECK_FILE_RE.test(file));
    if (testOrCiFiles.length > 0) {
      const onlyChecksTouched = implFiles.length === 0;
      results.push({
        detectorId: "det:check_modified_instead_of_code",
        ruleKey: "fix-code-not-check",
        problemId: "P43",
        attemptId: "A103",
        verdict: onlyChecksTouched ? "violated" : "passed",
        evidence: onlyChecksTouched
          ? `Only test/CI files modified (${testOrCiFiles.slice(0, 3).join(", ")}) alongside test execution`
          : `Tests updated alongside ${implFiles.length} implementation file(s)`,
      });
    }
  }

  // 8. pkill -f hazard (P18)
  const pkillCmd = commands.find((cmd) => PKILL_F_RE.test(cmd));
  if (pkillCmd) {
    results.push({
      detectorId: "det:pkill_f_hazard",
      ruleKey: "avoid-pkill-f",
      problemId: "P18",
      verdict: "violated",
      evidence: `Shell command invoked pkill -f: ${pkillCmd.slice(0, 140)}`,
    });
  }

  // 9. Harness rule inquiry checked against SIM before answering (P48 / A118)
  if (evidence.userText && RULE_INQUIRY_RE.test(evidence.userText)) {
    const readSim =
      toolNames.has("sim_read") ||
      toolNames.has("mcp__t3-code__sim_read") ||
      commands.some((cmd) => /\bsim\.mjs\s+(?:show|find|index|check|review)\b/.test(cmd));
    results.push({
      detectorId: "det:harness_rule_inquiry_read_sim",
      ruleKey: "read-sim-before-judging-rule",
      problemId: "P48",
      attemptId: "A118",
      verdict: readSim ? "passed" : "violated",
      evidence: readSim
        ? "Consulted SIM record before evaluating a harness rule question"
        : "Answered a harness rule inquiry without calling sim_read or sim.mjs",
    });
  }

  // 10. Expensive planner model delegating to same-tier model unasked (P30)
  if (EXPENSIVE_PLANNER_RE.test(evidence.model)) {
    const delegateCalls = evidence.toolCalls.filter(
      (call) =>
        call.name === "delegate_task" ||
        call.name === "mcp__t3-code__delegate_task" ||
        call.name === "invoke_subagent",
    );
    if (delegateCalls.length > 0) {
      const userNamedPlanner = Boolean(
        evidence.userText && EXPENSIVE_PLANNER_RE.test(evidence.userText),
      );
      const spawnedExpensive = delegateCalls.some(
        (call) => call.input !== undefined && EXPENSIVE_PLANNER_RE.test(call.input),
      );
      results.push({
        detectorId: "det:planner_child_model_tier",
        ruleKey: "delegate-cheaper-model",
        problemId: "P30",
        verdict: spawnedExpensive && !userNamedPlanner ? "violated" : "passed",
        evidence:
          spawnedExpensive && !userNamedPlanner
            ? "Planner model delegated to a same-tier planner model without explicit user request"
            : `Planner delegation respected child model tier (${delegateCalls.length} call(s))`,
      });
    }
  }

  return results;
}

export function evaluationsToMetricEvents(
  evidence: SimTurnEvidence,
  evaluations: ReadonlyArray<SimDetectorEvaluation>,
): ReadonlyArray<SimMetricEvent> {
  return evaluations.map((entry) => ({
    ts: evidence.ts,
    kind: "observation",
    detectorId: entry.detectorId,
    ruleKey: entry.ruleKey,
    ...(entry.problemId ? { problemId: entry.problemId } : {}),
    ...(entry.attemptId ? { attemptId: entry.attemptId } : {}),
    verdict: entry.verdict,
    source: "deterministic",
    providerInstanceId: evidence.providerInstanceId,
    model: evidence.model,
    ...(evidence.project ? { project: evidence.project } : {}),
    threadId: evidence.threadId,
    ...(evidence.runId ? { runId: evidence.runId } : {}),
    evidence: entry.evidence,
  }));
}
