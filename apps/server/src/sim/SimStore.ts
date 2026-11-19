// @effect-diagnostics nodeBuiltinImport:off globalDate:off - a synchronous port of sim.mjs that shares its files and clock-based stamps.
// Port of the standalone ~/.claude/sim/sim.mjs (journal format v2). Both tools share one
// directory, so every journal line written here must replay unchanged in sim.mjs: harness
// lives on the event envelope, never in `data` of attempt/observe. Functions that write the
// journal or sim.json expect the caller to hold sim.lock (see tryLock).
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import type { UsageModelPriceOverride } from "@t3tools/contracts";

import {
  SIM_DEFAULT_PAGE_CHARS,
  SIM_DEPENDS,
  SIM_FORMAT,
  SIM_FULL_BUDGET,
  SIM_GENESIS,
  SIM_INDEX_BUDGET,
  SIM_LINK_INVERSE,
  SIM_NAME_LIMIT,
  SIM_RESULTS,
  SIM_SCHEMA,
  SIM_SOURCES,
  SIM_TEXT_LIMIT,
  SIM_UNKNOWN,
  SIM_ACTIONS,
  SimServiceError,
  canonicalHarnessFile,
  expandHarnessFile,
  expandHomeString,
  isPathWithinRoot,
  type SimAdvisorEscalation,
  type SimAdvisorEscalationCandidate,
  type SimApplyHarnessChangeRequest,
  type SimApplyHarnessChangeResult,
  type SimAttempt,
  type SimAttemptInput,
  type SimCallerContext,
  type SimCarrySide,
  type SimErrorCode,
  type SimJournalEvent,
  type SimJournalOp,
  type SimLinkKind,
  type SimMetricEvent,
  type SimObservation,
  type SimObserveInput,
  type SimProblem,
  type SimReadRequest,
  type SimReadResult,
  type SimResolvedPaths,
  type SimSettingsConfig,
  type SimState,
  type SimTelemetryEvent,
  type SimWriteRequest,
  type SimWriteResult,
} from "./SimContracts.ts";
import {
  renderMetricsMatrixText,
  renderRuleRoiText,
  summarizeMetricsMatrix,
  summarizeRuleRoi,
} from "./SimMetricsStore.ts";

type Data = Record<string, unknown>;

const NEEDS_PREDICTED = ["fixed", "missed"];
const FAILURE_RESULTS = ["missed", "regressed", "misfired"];
const AMENDABLE = {
  problem: ["name"],
  always: ["what", "why", "anchor", "files", "depends_on"],
  beforeOutcome: ["expect", "policy", "domain"],
  backfilledBeforeOutcome: ["round", "sample", "predicted"],
};
const RELATED_LIMIT = 3;
const RELATED_FLOOR = 0.5;
const RELATED_LENGTH = 0.5;
const SEEN_DAYS = 14;
const SITTING_MINUTES = 60;
const KEPT_BACKUPS = 14;
const FAIL_CHARS = 8000;
const BACKUP_NAME = /^sim-\d{4}-\d{2}-\d{2}\.jsonl$/;
const SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const BACKED_UP_TOOLS = ["sim.mjs", "sim.test.mjs", "sim-audit.mjs"];

const SIM_LOCK_STALE_MS = 30_000;
export const SIM_LOCK_WAIT_MS = 15_000;
export const SIM_LOCK_POLL_MS = 40;
const TELEMETRY_MAX_LINES = 2_000;
const TELEMETRY_MAX_BYTES = 512 * 1024;
const TELEMETRY_KEEP_LINES = 1_000;

const fail = (code: SimErrorCode, problems: string | ReadonlyArray<string>) =>
  new SimServiceError({
    code,
    problems: typeof problems === "string" ? [problems] : [...problems],
  });
const invalid = (problems: string | ReadonlyArray<string>) => fail("validation", problems);

export const sha = (text: string | Uint8Array) =>
  NodeCrypto.createHash("sha256").update(text).digest("hex");
const squash = (text: unknown) => String(text).replace(/\s+/g, " ").trim();
const isText = (value: unknown, min = 1): value is string =>
  typeof value === "string" && value.trim().length >= min;
const isList = (value: unknown): value is Array<string> =>
  Array.isArray(value) && value.every((item) => typeof item === "string" && item.trim().length > 0);
const idNumber = (id: string) => Number(String(id).slice(1));
const count = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
const estimateTokens = (text: string) => Math.ceil(text.length / 3.5);
const asData = (value: unknown): Data =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Data) : {};

/** Root causes count as the same text when only case, spacing or a final period differ. */
const sameName = (name: unknown) => squash(name).replace(/[.]+$/, "").toLowerCase();

export function today(): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

function isDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

/** A session id without the kind in front, so that "cc:abc" and "abc" name the same session. */
export const bare = (id: string) => String(id).replace(/^(cc|t3):/, "");

const canonicalFile = (file: unknown, paths: SimResolvedPaths) =>
  canonicalHarnessFile(String(file), paths);

/** A SIM dir under the OS temp dir is a test sandbox: its harness files may live there too. */
export function isTestSimDir(paths: Pick<SimResolvedPaths, "simDir">): boolean {
  const rel = NodePath.relative(NodeOS.tmpdir(), paths.simDir);
  return rel !== "" && !rel.startsWith("..") && !NodePath.isAbsolute(rel);
}

/** The harness a record was made under; Claude Code sessions recorded by sim.mjs carry none. */
const effectiveHarness = (record: {
  readonly harness?: string | undefined;
  readonly by: string;
}): string | undefined =>
  record.harness ?? (record.by.startsWith("cc:") ? "claudeAgent" : undefined);

function emptyState(): SimState {
  return {
    schema: SIM_SCHEMA,
    next_id: 1,
    next_attempt: 1,
    events: 0,
    head: SIM_GENESIS,
    carried_from: [],
    aliases: {},
    problems: [],
  };
}

function resolveId(state: SimState, id: string): string {
  const seen = new Set<string>();
  let current = id;
  while (state.aliases[current]) {
    if (seen.has(current)) throw invalid(`alias loop at ${current}`);
    seen.add(current);
    current = state.aliases[current]!;
  }
  return current;
}

function findProblem(state: SimState, id: unknown): SimProblem | null {
  const resolved = resolveId(state, String(id).trim());
  return state.problems.find((problem) => problem.id === resolved) ?? null;
}

export function findAttempt(
  state: SimState,
  attemptId: unknown,
): { problem: SimProblem; attempt: SimAttempt } | null {
  const wanted = String(attemptId).trim();
  for (const problem of state.problems) {
    const attempt = problem.attempts.find((item) => item.id === wanted);
    if (attempt) return { problem, attempt };
  }
  return null;
}

/** The entry that has this root cause, now or under an earlier wording. */
function problemNamed(
  state: SimState,
  name: unknown,
  except: string | null = null,
): SimProblem | null {
  const wanted = sameName(name);
  return (
    state.problems.find(
      (item) =>
        item.id !== except &&
        (sameName(item.name) === wanted ||
          item.former_names.some((old) => sameName(old) === wanted)),
    ) ?? null
  );
}

export const allAttempts = (state: SimState) =>
  state.problems.flatMap((problem) => problem.attempts);

function supersededBy(state: SimState, attemptId: string): string | null {
  const later = allAttempts(state).find(
    (item) => item.accepted && !item.retracted && item.supersedes.includes(attemptId),
  );
  return later ? later.id : null;
}

const standing = (attempt: SimAttempt) => attempt.observations.filter((obs) => !obs.retracted);

const FORK_FAMILY_REASON =
  "reported from the fork or side-chat family of the session that made the change";

/** True when one of these sessions made or recorded the attempt, compared with and without `cc:`/`t3:`. */
function sharesFamily(
  attempt: Pick<SimAttempt, "by" | "also" | "sample">,
  sessionIds: ReadonlyArray<string>,
): boolean {
  const authors = [attempt.by, attempt.also, attempt.sample].filter(
    (id): id is string => !!id && id !== SIM_UNKNOWN,
  );
  return sessionIds.some((id) =>
    authors.some((author) => id === author || bare(id) === bare(author)),
  );
}

/**
 * Why a reported fix cannot settle the prediction, or null when it can. Matches sim.mjs and also
 * compares session ids without their `cc:`/`t3:` kind, plus the caller's fork/side-chat family.
 */
function ownReport(
  attempt: Pick<SimAttempt, "by" | "also" | "sample" | "backfilled">,
  obs: Pick<SimObservation, "by" | "also" | "source">,
  forkFamilySessionIds?: ReadonlyArray<string>,
): string | null {
  const names = (record: { readonly by: string; readonly also?: string | undefined }) =>
    [record.by, record.also].filter((id): id is string => !!id && id !== SIM_UNKNOWN);
  const same = (a: string, b: string) => a === b || bare(a) === bare(b);
  if (obs.source === "self") return "self-reported";
  if (obs.by === SIM_UNKNOWN) return "the reporting session is unknown";
  const reporters = names(obs);
  if (reporters.some((id) => names(attempt).some((author) => same(id, author)))) {
    return attempt.backfilled
      ? "reported by the session that recorded the change"
      : "same session as the change";
  }
  if (attempt.sample !== SIM_UNKNOWN && reporters.some((id) => same(id, attempt.sample))) {
    return "same session as the change";
  }
  if (forkFamilySessionIds && sharesFamily(attempt, forkFamilySessionIds))
    return FORK_FAMILY_REASON;
  if (attempt.by === SIM_UNKNOWN) return "the session that recorded the change is unknown";
  return null;
}

const settlesFix = (attempt: SimAttempt, obs: SimObservation) =>
  obs.result === "fixed" && !ownReport(attempt, obs);

const ATTEMPT_FIELDS = [
  "problem",
  "new",
  "action",
  "what",
  "why",
  "files",
  "anchor",
  "supersedes",
  "depends_on",
  "predicted",
  "expect",
  "policy",
  "domain",
  "accepted",
  "rejected_because",
  "unanswered",
  "considered",
  "backfilled",
  "round",
  "sample",
  "observations",
];
const OBSERVE_FIELDS = ["target", "result", "evidence", "source", "policy", "domain", "date"];
// Replay tolerates a legacy `harness` key in data; T3 itself only ever writes it on the envelope.
const LEGACY_DATA_FIELDS = ["harness"];

function unknownFields(
  input: Data,
  allowed: ReadonlyArray<string>,
  errors: Array<string>,
  label: string,
) {
  const extra = Object.keys(input).filter(
    (key) => !allowed.includes(key) && !LEGACY_DATA_FIELDS.includes(key),
  );
  if (extra.length) {
    errors.push(
      `${label}: unknown field${extra.length === 1 ? "" : "s"} ${extra.join(", ")} (allowed: ${allowed.join(", ")})`,
    );
  }
}

function tooLong(value: unknown, limit: number, label: string, errors: Array<string>) {
  if (typeof value === "string" && value.trim().length > limit) {
    errors.push(
      `${label} has ${value.trim().length} characters; the limit is ${limit}. Say it shorter: every later session reads it`,
    );
  }
}

interface EventContext {
  readonly seq: number;
  readonly day: string;
  readonly by: string;
  readonly also: string | null;
  readonly harness: string | null;
}

function validateObservation(
  attempt: SimAttempt,
  raw: unknown,
  errors: Array<string>,
  label: string,
  day: string,
  historic: boolean,
) {
  const obs = asData(raw);
  unknownFields(obs, historic ? [...OBSERVE_FIELDS, "sample"] : OBSERVE_FIELDS, errors, label);
  if (!SIM_RESULTS.includes(obs.result as never)) {
    errors.push(`${label}: result must be one of ${SIM_RESULTS.join(", ")}`);
  }
  if (!SIM_SOURCES.includes(obs.source as never)) {
    errors.push(`${label}: source must be one of ${SIM_SOURCES.join(", ")}`);
  }
  if (!isText(obs.evidence, 10))
    errors.push(`${label}: evidence is required (what was seen, and where)`);
  tooLong(obs.evidence, SIM_TEXT_LIMIT, `${label}: evidence`, errors);
  if (!isText(obs.policy))
    errors.push(`${label}: policy is required (the model the outcome was seen under)`);
  if (!isText(obs.domain)) errors.push(`${label}: domain is required (the project, or "global")`);
  if (historic && obs.sample !== undefined && !isText(obs.sample)) {
    errors.push(`${label}: sample must name the session that saw the outcome, or be left out`);
  }
  if (!isDate(obs.date)) errors.push(`${label}: date must be YYYY-MM-DD`);
  else if (isDate(attempt.round) && obs.date < attempt.round) {
    errors.push(`${label}: date ${obs.date} is before the change it judges (${attempt.round})`);
  } else if (historic && obs.date >= day) {
    errors.push(
      `${label}: an outcome inside a backfilled record must lie before today; record a new one with observe`,
    );
  } else if (obs.date > day) {
    errors.push(`${label}: date ${obs.date} is in the future`);
  }
  if (obs.result === "kept") return;
  if (!isText(obs.target) || !SLUG.test(obs.target)) {
    errors.push(`${label}: target must be a kebab-case slug`);
  } else if (
    NEEDS_PREDICTED.includes(String(obs.result)) &&
    !attempt.predicted.includes(obs.target)
  ) {
    errors.push(
      `${label}: "${obs.target}" is not a predicted target of ${attempt.id} (${attempt.predicted.join(", ") || "none"}); use regressed, misfired or inconclusive for an effect that was not predicted`,
    );
  }
}

function cleanObservation(
  raw: Data,
  sample: string,
  ctx: EventContext,
  harness: string | null,
): SimObservation {
  const obs: SimObservation = {
    date: String(raw.date),
    result: raw.result as SimObservation["result"],
    evidence: String(raw.evidence).trim(),
    source: raw.source as SimObservation["source"],
    policy: String(raw.policy).trim(),
    domain: String(raw.domain).trim(),
    sample,
    by: ctx.by,
  };
  if (harness) obs.harness = harness;
  if (ctx.also) obs.also = ctx.also;
  if (raw.result !== "kept") obs.target = String(raw.target);
  return obs;
}

const legacyHarness = (data: Data) => (isText(data.harness) ? data.harness.trim() : null);

function applyAttempt(state: SimState, data: unknown, ctx: EventContext, paths: SimResolvedPaths) {
  const errors: Array<string> = [];
  const input = asData(data);
  unknownFields(input, ATTEMPT_FIELDS, errors, "attempt");
  const accepted = input.accepted !== false;
  const backfilled = input.backfilled === true;
  const hasProblem = isText(input.problem);
  const hasNew = isText(input.new);

  if (hasProblem === hasNew) {
    errors.push('give exactly one of "problem" (an existing P-id) or "new" (a new root cause)');
  }
  let problem: SimProblem | null = null;
  if (isText(input.problem)) {
    problem = findProblem(state, input.problem.trim());
    if (!problem) errors.push(`problem ${input.problem} does not exist`);
  }
  if (hasNew && squash(input.new).split(" ").length < 3) {
    errors.push('"new" must state the root cause as a sentence, not a label');
  }
  if (hasNew) tooLong(input.new, SIM_NAME_LIMIT, "the root cause", errors);
  if (!SIM_ACTIONS.includes(input.action as never)) {
    errors.push(`action must be one of ${SIM_ACTIONS.join(", ")}`);
  }
  if (!isText(input.what)) errors.push("what is required (the change itself)");
  if (!isText(input.why)) errors.push("why is required (the reason for this change)");
  for (const field of ["what", "why", "expect", "rejected_because"]) {
    tooLong(input[field], SIM_TEXT_LIMIT, field, errors);
  }
  if (!isText(input.policy))
    errors.push("policy is required (the model the failure was seen under)");
  if (!isText(input.domain)) errors.push('domain is required (the project, or "global")');

  if (backfilled) {
    if (!isDate(input.round))
      errors.push("round must be YYYY-MM-DD (the day the old change was made)");
    else if (input.round > ctx.day) errors.push(`round ${input.round} is in the future`);
    if (input.sample !== undefined && !isText(input.sample)) {
      errors.push("sample must name the session that made the change, or be left out");
    }
  } else {
    if (input.round !== undefined || input.sample !== undefined) {
      errors.push(
        'round and sample are set by the tool; only the record of an old change ("backfilled": true) names them',
      );
    }
    if (input.observations !== undefined) {
      errors.push(
        "outcomes cannot be recorded together with the change; record them later with observe",
      );
    }
    if (input.considered === undefined) {
      errors.push(
        "considered is required: the entries you read in full before this change ([] when none relates)",
      );
    }
  }
  const considered = input.considered === undefined ? [] : input.considered;
  if (!Array.isArray(considered) || considered.some((id) => !isText(id))) {
    errors.push("considered must be a list of entry ids");
  } else {
    for (const id of considered as Array<string>) {
      if (!findProblem(state, id.trim())) errors.push(`considered: ${id} does not exist`);
    }
  }

  const supersedes = input.supersedes === undefined ? [] : input.supersedes;
  if (!Array.isArray(supersedes) || supersedes.some((id) => !isText(id))) {
    errors.push("supersedes must be a list of attempt ids");
  }
  const predicted = input.predicted === undefined ? [] : input.predicted;
  if (!Array.isArray(predicted) || predicted.some((slug) => !isText(slug) || !SLUG.test(slug))) {
    errors.push("predicted must be a list of kebab-case target slugs");
  }
  const files = input.files === undefined ? [] : input.files;
  if (!Array.isArray(files) || files.some((file) => !isText(file))) {
    errors.push("files must be a list of paths");
  }
  const supersedesList = Array.isArray(supersedes) ? (supersedes as Array<string>) : [];

  const unanswered = input.unanswered === true;
  if (accepted) {
    if (unanswered || input.rejected_because !== undefined) {
      errors.push(
        'rejected_because and unanswered belong to a proposal that was not carried out ("accepted": false)',
      );
    }
    if (!Array.isArray(files) || !files.length)
      errors.push("files is required (where the change lives)");
    if (input.action !== "remove") {
      if (!isText(input.anchor, 6)) {
        errors.push("anchor is required (a phrase that identifies the rule in one of the files)");
      }
      const depends = input.depends_on;
      if (
        !Array.isArray(depends) ||
        !depends.length ||
        depends.some((item) => !SIM_DEPENDS.includes(item as never))
      ) {
        errors.push(`depends_on must list one or more of ${SIM_DEPENDS.join(", ")}`);
      }
      if (Array.isArray(predicted) && !predicted.length) {
        errors.push("predicted is required (the failures this change should stop)");
      }
      if (!backfilled && !isText(input.expect)) {
        errors.push("expect is required (what will count as fixed, and what as missed)");
      }
      if (input.action === "add" && supersedesList.length) {
        errors.push('an "add" supersedes nothing; use revise or replace');
      }
      if ((input.action === "revise" || input.action === "replace") && !supersedesList.length) {
        errors.push(`a ${input.action} must name the attempt it changes in supersedes`);
      }
    }
    for (const id of supersedesList) {
      const hit = findAttempt(state, id);
      if (!hit) errors.push(`supersedes: ${id} does not exist`);
      else if (!hit.attempt.accepted || hit.attempt.retracted || hit.attempt.action === "remove") {
        errors.push(`supersedes: ${id} is not a mechanism`);
      } else if (supersededBy(state, hit.attempt.id)) {
        errors.push(
          `supersedes: ${id} is no longer live (changed by ${supersededBy(state, hit.attempt.id)})`,
        );
      }
    }
  } else if (unanswered === isText(input.rejected_because)) {
    errors.push(
      'a proposal that was not carried out needs exactly one of "rejected_because" (why it was turned down) or "unanswered": true (nobody decided)',
    );
  }
  if (errors.length) throw invalid(errors);

  const harness = ctx.harness ?? legacyHarness(input);
  const attempt = {
    id: `A${state.next_attempt}`,
    round: backfilled ? String(input.round) : ctx.day,
    sample: backfilled ? (isText(input.sample) ? input.sample.trim() : SIM_UNKNOWN) : ctx.by,
    by: ctx.by,
    accepted,
    backfilled,
    action: input.action as SimAttempt["action"],
    what: String(input.what).trim(),
    why: String(input.why).trim(),
    files: (files as Array<string>).map((file) => canonicalFile(file, paths)),
    anchor: accepted && input.action !== "remove" ? String(input.anchor).trim() : null,
    supersedes: supersedesList.map((id) => id.trim()),
    depends_on: Array.isArray(input.depends_on)
      ? [...(input.depends_on as Array<SimAttempt["depends_on"][number]>)]
      : [],
    predicted: [...(predicted as Array<string>)],
    expect: isText(input.expect) ? input.expect.trim() : null,
    policy: String(input.policy).trim(),
    domain: String(input.domain).trim(),
    ...(harness ? { harness } : {}),
    considered: (considered as Array<string>).map((id) => id.trim()),
    observations: [],
  } as unknown as SimAttempt;
  if (ctx.also) attempt.also = ctx.also;
  if (backfilled) attempt.recorded = { by: ctx.by, day: ctx.day };
  if (!accepted && unanswered) attempt.unanswered = true;
  if (!accepted && !unanswered) attempt.rejected_because = String(input.rejected_because).trim();

  if (backfilled && input.observations !== undefined) {
    if (!Array.isArray(input.observations)) throw invalid("observations must be a list");
    if (!accepted) throw invalid("a proposal that was not carried out has no outcomes");
    input.observations.forEach((raw, index) =>
      validateObservation(attempt, raw, errors, `observations[${index}]`, ctx.day, true),
    );
    if (errors.length) throw invalid(errors);
    attempt.observations = input.observations.map((raw) => {
      const obs = asData(raw);
      return cleanObservation(
        obs,
        isText(obs.sample) ? obs.sample.trim() : SIM_UNKNOWN,
        ctx,
        harness,
      );
    });
  }

  let created = false;
  if (!problem) {
    problem = problemNamed(state, input.new);
    if (!problem) {
      problem = {
        id: `P${state.next_id}`,
        name: squash(input.new),
        opened_round: attempt.round,
        former_names: [],
        related: [],
        attempts: [],
      };
      state.next_id += 1;
      state.problems.push(problem);
      created = true;
    }
  }
  state.next_attempt += 1;
  problem.attempts.push(attempt);
  sortAttempts(problem);
  return { problem: problem.id, attempt: attempt.id, created };
}

function sortAttempts(problem: SimProblem) {
  problem.attempts.sort((a, b) =>
    a.round === b.round ? idNumber(a.id) - idNumber(b.id) : a.round < b.round ? -1 : 1,
  );
  problem.opened_round = problem.attempts.reduce(
    (first, item) => (item.round < first ? item.round : first),
    problem.attempts[0]!.round,
  );
}

function applyObserve(state: SimState, data: unknown, ctx: EventContext) {
  const input = asData(data);
  const hit = isText(input.attempt) ? findAttempt(state, input.attempt.trim()) : null;
  if (!hit) throw invalid(`attempt ${String(input.attempt)} does not exist`);
  if (!hit.attempt.accepted) {
    throw invalid(`${hit.attempt.id} was a proposal that was not carried out; it has no outcomes`);
  }
  if (hit.attempt.retracted) throw invalid(`${hit.attempt.id} was retracted; it has no outcomes`);
  const raw: Data = { ...asData(input.observation) };
  const errors: Array<string> = [];
  if (raw.sample !== undefined) {
    errors.push("observation: sample is set by the tool (the session that reports the outcome)");
    delete raw.sample;
  }
  if (raw.date === undefined) raw.date = ctx.day;
  validateObservation(hit.attempt, raw, errors, "observation", ctx.day, false);
  if (errors.length) throw invalid(errors);
  hit.attempt.observations.push(
    cleanObservation(raw, ctx.by, ctx, ctx.harness ?? legacyHarness(raw)),
  );
  return { problem: hit.problem.id, attempt: hit.attempt.id };
}

function mergeProblems(state: SimState, from: SimProblem, into: SimProblem) {
  into.attempts.push(...from.attempts);
  sortAttempts(into);
  if (sameName(from.name) !== sameName(into.name)) into.former_names.push(from.name);
  into.former_names.push(...from.former_names);
  for (const link of from.related) {
    if (
      resolveId(state, link.id) !== into.id &&
      !into.related.some((item) => item.id === link.id && item.kind === link.kind)
    ) {
      into.related.push(link);
    }
  }
  into.related = into.related.filter((link) => link.id !== from.id);
  state.aliases[from.id] = into.id;
  state.problems = state.problems.filter((problem) => problem.id !== from.id);
}

function applyMerge(state: SimState, data: unknown) {
  const input = asData(data);
  const from = isText(input.from) ? findProblem(state, input.from.trim()) : null;
  const into = isText(input.into) ? findProblem(state, input.into.trim()) : null;
  const errors: Array<string> = [];
  if (!from) errors.push(`problem ${String(input.from)} does not exist`);
  if (!into) errors.push(`problem ${String(input.into)} does not exist`);
  if (from && into && from.id === into.id) errors.push("cannot merge an entry into itself");
  if (errors.length || !from || !into) throw invalid(errors);
  mergeProblems(state, from, into);
  return { problem: into.id, merged: from.id };
}

function applyLink(state: SimState, data: unknown) {
  const input = asData(data);
  const a = isText(input.a) ? findProblem(state, input.a.trim()) : null;
  const b = isText(input.b) ? findProblem(state, input.b.trim()) : null;
  const errors: Array<string> = [];
  if (!a) errors.push(`problem ${String(input.a)} does not exist`);
  if (!b) errors.push(`problem ${String(input.b)} does not exist`);
  if (a && b && a.id === b.id) errors.push("cannot link an entry to itself");
  const kind = input.kind as SimLinkKind;
  if (typeof input.kind !== "string" || !Object.hasOwn(SIM_LINK_INVERSE, input.kind)) {
    errors.push(`kind must be one of ${Object.keys(SIM_LINK_INVERSE).join(", ")}`);
  }
  if (errors.length || !a || !b) throw invalid(errors);
  const add = (problem: SimProblem, id: string, linkKind: SimLinkKind) => {
    if (!problem.related.some((item) => item.id === id && item.kind === linkKind)) {
      problem.related.push({ id, kind: linkKind });
    }
  };
  add(a, b.id, kind);
  add(b, a.id, SIM_LINK_INVERSE[kind]);
  return { problem: a.id };
}

function applyCarry(state: SimState, data: unknown) {
  const input = asData(data);
  const errors: Array<string> = [];
  const side = (value: unknown, label: string) => {
    const record = asData(value);
    if (!isText(record.policy) && !isText(record.domain))
      errors.push(`${label} needs a policy or a domain`);
  };
  side(input.from, "from");
  side(input.into, "into");
  if (!isDate(input.date)) errors.push("date must be YYYY-MM-DD");
  tooLong(input.note, SIM_TEXT_LIMIT, "note", errors);
  if (errors.length) throw invalid(errors);
  const pick = (value: unknown): SimCarrySide => {
    const record = asData(value);
    const out: SimCarrySide = {};
    if (isText(record.policy)) out.policy = record.policy.trim();
    if (isText(record.domain)) out.domain = record.domain.trim();
    if (isText(record.harness)) out.harness = record.harness.trim();
    return out;
  };
  const entry: SimState["carried_from"][number] = {
    date: String(input.date),
    from: pick(input.from),
    into: pick(input.into),
  };
  if (isText(input.note)) entry.note = input.note.trim();
  state.carried_from.push(entry);
  return {};
}

function applyAmend(state: SimState, data: unknown, ctx: EventContext, paths: SimResolvedPaths) {
  const input = asData(data);
  if (!isText(input.reason, 5)) throw invalid("reason is required (why the record is corrected)");
  if (!isText(input.target)) throw invalid("target is required (a P-id or an A-id)");
  const target = input.target.trim();
  const reason = input.reason.trim();
  if (reason.length > SIM_TEXT_LIMIT) {
    throw invalid(`reason has ${reason.length} characters; the limit is ${SIM_TEXT_LIMIT}`);
  }
  const field = String(input.field);
  const value = input.value;
  if (target.startsWith("P")) {
    const problem = findProblem(state, target);
    if (!problem) throw invalid(`problem ${target} does not exist`);
    if (!AMENDABLE.problem.includes(field)) throw invalid(`an entry's ${field} cannot be amended`);
    if (!isText(value) || squash(value).split(" ").length < 3) {
      throw invalid("the root cause must be a sentence, not a label");
    }
    if (squash(value).length > SIM_NAME_LIMIT) {
      throw invalid(
        `the root cause has ${squash(value).length} characters; the limit is ${SIM_NAME_LIMIT}`,
      );
    }
    const twin = problemNamed(state, value, problem.id);
    const former = problem.name;
    if (sameName(problem.name) !== sameName(value)) problem.former_names.push(problem.name);
    problem.name = squash(value);
    (problem.amended ??= []).push({ seq: ctx.seq, field: "name", reason, was: former });
    if (twin) {
      const [older, newer] =
        idNumber(twin.id) < idNumber(problem.id) ? [twin, problem] : [problem, twin];
      mergeProblems(state, newer, older);
      return { problem: older.id, merged: newer.id };
    }
    return { problem: problem.id };
  }
  const hit = findAttempt(state, target);
  if (!hit) throw invalid(`attempt ${target} does not exist`);
  const { attempt } = hit;
  const judged = attempt.observations.length > 0;
  const allowed = [...AMENDABLE.always];
  if (!judged) {
    allowed.push(
      ...AMENDABLE.beforeOutcome,
      ...(attempt.backfilled ? AMENDABLE.backfilledBeforeOutcome : []),
    );
  }
  if (!allowed.includes(field)) {
    let extra = "";
    if (field === "harness")
      extra = " (it stands as recorded; retract the attempt and record it again)";
    else if (AMENDABLE.backfilledBeforeOutcome.includes(field) && !attempt.backfilled) {
      extra = " after the fact (a prediction stands as it was made)";
    } else if ([...AMENDABLE.beforeOutcome, ...AMENDABLE.backfilledBeforeOutcome].includes(field)) {
      extra =
        " once it has had an outcome (what was predicted, and where, stands as it was judged)";
    }
    throw invalid(`an attempt's ${field} cannot be amended${extra}`);
  }
  const errors: Array<string> = [];
  if (["what", "why", "expect", "domain", "policy", "sample"].includes(field) && !isText(value)) {
    errors.push(`${field} must be text`);
  }
  if (["what", "why", "expect"].includes(field)) tooLong(value, SIM_TEXT_LIMIT, field, errors);
  if (field === "anchor" && !isText(value, 6)) errors.push("anchor must be a phrase of the rule");
  if (field === "files" && !(isList(value) && value.length))
    errors.push("files must be a list of paths");
  if (
    field === "depends_on" &&
    !(
      Array.isArray(value) &&
      value.length &&
      value.every((item) => SIM_DEPENDS.includes(item as never))
    )
  ) {
    errors.push(`depends_on must list one or more of ${SIM_DEPENDS.join(", ")}`);
  }
  if (field === "round" && !(isDate(value) && value <= ctx.day)) {
    errors.push("round must be YYYY-MM-DD and not in the future");
  }
  if (
    field === "predicted" &&
    !(isList(value) && value.length && value.every((slug) => SLUG.test(slug)))
  ) {
    errors.push("predicted must be a list of kebab-case slugs");
  }
  if (errors.length) throw invalid(errors);
  const record = attempt as unknown as Data;
  const was = record[field];
  if (field === "files")
    attempt.files = (value as Array<string>).map((file) => canonicalFile(file, paths));
  else if (field === "depends_on" || field === "predicted")
    record[field] = [...(value as Array<string>)];
  else record[field] = typeof value === "string" ? value.trim() : value;
  (attempt.amended ??= []).push({
    seq: ctx.seq,
    field,
    reason,
    was: Array.isArray(was) ? [...was] : was,
  });
  if (field === "round") sortAttempts(hit.problem);
  return { problem: hit.problem.id, attempt: attempt.id };
}

function applyRetract(state: SimState, data: unknown, ctx: EventContext) {
  const input = asData(data);
  const hit = isText(input.attempt) ? findAttempt(state, input.attempt.trim()) : null;
  if (!hit) throw invalid(`attempt ${String(input.attempt)} does not exist`);
  if (!isText(input.reason, 5)) throw invalid("reason is required (why the record is wrong)");
  if (input.reason.trim().length > SIM_TEXT_LIMIT) {
    throw invalid(
      `reason has ${input.reason.trim().length} characters; the limit is ${SIM_TEXT_LIMIT}`,
    );
  }
  const whole = input.outcome === undefined || input.outcome === null;
  const record: SimAttempt | SimObservation | undefined = whole
    ? hit.attempt
    : Number.isInteger(input.outcome)
      ? hit.attempt.observations[(input.outcome as number) - 1]
      : undefined;
  const label = whole ? hit.attempt.id : `outcome ${String(input.outcome)} of ${hit.attempt.id}`;
  if (!record) throw invalid(`${hit.attempt.id} has no outcome number ${String(input.outcome)}`);
  if (input.undo === true) {
    if (!record.retracted) throw invalid(`${label} is not retracted`);
    record.restored = {
      seq: ctx.seq,
      reason: input.reason.trim(),
      retracted_because: record.retracted.reason,
    };
    delete record.retracted;
  } else {
    if (record.retracted) throw invalid(`${label} is already retracted`);
    record.retracted = { seq: ctx.seq, reason: input.reason.trim() };
    delete record.restored;
  }
  return { problem: hit.problem.id, attempt: hit.attempt.id };
}

export interface SimEventOutcome {
  readonly problem?: string;
  readonly attempt?: string;
  readonly created?: boolean;
  readonly merged?: string;
}

/** Apply one journal event to a state. Throws and leaves no trace when it is invalid. */
function applyEvent(
  state: SimState,
  event: Pick<SimJournalEvent, "seq" | "day" | "by" | "v" | "op" | "data"> & {
    readonly also?: string | undefined;
    readonly harness?: string | undefined;
  },
  paths: SimResolvedPaths,
): SimEventOutcome {
  const ops: Record<string, true> = {
    attempt: true,
    observe: true,
    merge: true,
    link: true,
    carry: true,
    amend: true,
    retract: true,
  };
  if (!ops[event.op]) throw invalid(`unknown operation ${String(event.op)}`);
  if (event.v !== SIM_FORMAT) {
    throw invalid(`event ${event.seq} has format ${event.v}; this tool reads format ${SIM_FORMAT}`);
  }
  if (!isDate(event.day) || !isText(event.by))
    throw invalid(`event ${event.seq} lacks its day or its session`);
  const ctx: EventContext = {
    seq: event.seq,
    day: event.day,
    by: event.by,
    also: isText(event.also) ? event.also : null,
    harness: isText(event.harness) ? event.harness.trim() : null,
  };
  let outcome: SimEventOutcome;
  switch (event.op) {
    case "attempt":
      outcome = applyAttempt(state, event.data, ctx, paths);
      break;
    case "observe":
      outcome = applyObserve(state, event.data, ctx);
      break;
    case "merge":
      outcome = applyMerge(state, event.data);
      break;
    case "link":
      outcome = applyLink(state, event.data);
      break;
    case "carry":
      outcome = applyCarry(state, event.data);
      break;
    case "amend":
      outcome = applyAmend(state, event.data, ctx, paths);
      break;
    case "retract":
      outcome = applyRetract(state, event.data, ctx);
      break;
  }
  state.events = event.seq;
  return outcome;
}

/** Fill in what follows from the record: outcome tallies and liveness. */
function derive(state: SimState): SimState {
  for (const problem of state.problems) {
    for (const attempt of problem.attempts) {
      const outcomes = standing(attempt);
      const missed = (target: string) =>
        outcomes.some((obs) => obs.target === target && obs.result === "missed");
      const fixed = (target: string) =>
        outcomes.some((obs) => obs.target === target && settlesFix(attempt, obs));
      attempt.missed = attempt.predicted.filter(missed);
      attempt.fixed = attempt.predicted.filter((target) => fixed(target) && !missed(target));
      attempt.pending = attempt.predicted.filter((target) => !fixed(target) && !missed(target));
      attempt.passed = outcomes.filter((obs) => settlesFix(attempt, obs)).length;
      attempt.total = outcomes.filter((obs) => obs.result !== "kept").length;
      attempt.superseded_by = attempt.accepted ? supersededBy(state, attempt.id) : null;
      attempt.live =
        attempt.accepted &&
        !attempt.retracted &&
        attempt.action !== "remove" &&
        !attempt.superseded_by;
    }
  }
  return state;
}

function fold(events: ReadonlyArray<SimJournalEvent>, paths: SimResolvedPaths): SimState {
  const state = emptyState();
  for (const event of events) applyEvent(state, event, paths);
  return derive(state);
}

const journalLines = (file: string) =>
  NodeFS.existsSync(file)
    ? NodeFS.readFileSync(file, "utf8")
        .split("\n")
        .filter((line) => line.length)
    : [];

export interface SimJournal {
  readonly events: Array<SimJournalEvent>;
  readonly head: string;
  broken: string | null;
  readonly lines: Array<string>;
}

/** Read the journal and verify its order and hash chain. */
function readJournal(file: string): SimJournal {
  const lines = journalLines(file);
  const events: Array<SimJournalEvent> = [];
  let head = SIM_GENESIS;
  let broken: string | null = null;
  lines.forEach((line, index) => {
    let event: SimJournalEvent | null = null;
    try {
      event = JSON.parse(line) as SimJournalEvent;
    } catch {
      broken ??= `line ${index + 1} is not valid JSON`;
    }
    if (event) {
      if (event.seq !== index + 1) broken ??= `line ${index + 1} has sequence number ${event.seq}`;
      if (event.prev !== head) broken ??= `line ${index + 1} does not continue the line before it`;
      events.push(event);
    }
    head = sha(line);
  });
  return { events, head, broken, lines };
}

/** One attempt at sim.lock, with sim.mjs's stale-holder recovery. */
export function tryLock(paths: SimResolvedPaths): boolean {
  NodeFS.mkdirSync(paths.simDir, { recursive: true });
  for (let round = 0; round < 2; round += 1) {
    try {
      NodeFS.writeFileSync(paths.lockPath, `${process.pid}`, { flag: "wx" });
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      try {
        if (Date.now() - NodeFS.statSync(paths.lockPath).mtimeMs <= SIM_LOCK_STALE_MS) return false;
        // Only one waiter wins the rename, so only one removes a dead holder's lock.
        const stale = `${paths.lockPath}.${process.pid}`;
        NodeFS.renameSync(paths.lockPath, stale);
        NodeFS.unlinkSync(stale);
      } catch {
        // another waiter removed or replaced it first
      }
    }
  }
  return false;
}

export function unlock(paths: SimResolvedPaths) {
  NodeFS.rmSync(paths.lockPath, { force: true });
}

/**
 * Serialize `sim.json` as schema 3 byte-identical to standalone `sim.mjs` (omitting in-memory
 * `harness` fields that live on the `sim.jsonl` envelope so the two tools never rewrite each
 * other's `sim.json`).
 */
function serializeForDisk(state: SimState): string {
  const strip = <T extends object>(record: T): T => {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(record)) {
      if (key === "harness") continue;
      out[key] = value;
    }
    return out as T;
  };
  const stripAttempt = (attempt: SimAttempt): SimAttempt => {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(attempt)) {
      if (key === "harness") continue;
      out[key] =
        key === "observations"
          ? (value as ReadonlyArray<SimObservation>).map((obs) => strip(obs))
          : value;
    }
    return out as unknown as SimAttempt;
  };
  const diskState: SimState = {
    ...state,
    schema: SIM_SCHEMA,
    carried_from: state.carried_from.map((entry) => ({
      ...entry,
      from: strip(entry.from),
      into: strip(entry.into),
    })),
    problems: state.problems.map((problem) => ({
      ...problem,
      attempts: problem.attempts.map(stripAttempt),
    })),
  };
  return `${JSON.stringify(diskState, null, 1)}\n`;
}

function writeWhole(
  file: string,
  content: string | Uint8Array,
  options?: { readonly mode?: number | undefined },
) {
  const temp = `${file}.${process.pid}.tmp`;
  NodeFS.writeFileSync(
    temp,
    content,
    options?.mode !== undefined ? { mode: options.mode } : undefined,
  );
  if (options?.mode !== undefined) {
    // Re-apply mode after creation so process umask does not strip executable bits (e.g. .sh hooks).
    NodeFS.chmodSync(temp, options.mode);
  }
  NodeFS.renameSync(temp, file);
}

const backupNames = (paths: SimResolvedPaths) =>
  NodeFS.existsSync(paths.backupsDir)
    ? NodeFS.readdirSync(paths.backupsDir)
        .filter((name) => BACKUP_NAME.test(name))
        .sort()
    : [];

function newestBackup(paths: SimResolvedPaths) {
  const names = backupNames(paths);
  const name = names[names.length - 1];
  if (!name) return null;
  return { name, lines: journalLines(NodePath.join(paths.backupsDir, name)) };
}

function departsFromBackup(
  lines: ReadonlyArray<string>,
  kept: { name: string; lines: Array<string> } | null,
): string | null {
  if (!kept || !kept.lines.length) return null;
  const last = kept.lines.length - 1;
  if (lines.length < kept.lines.length || lines[last] !== kept.lines[last]) {
    return `the backup ${kept.name} holds ${count(kept.lines.length, "event")} that the journal does not begin with`;
  }
  return null;
}

function backup(paths: SimResolvedPaths) {
  NodeFS.mkdirSync(paths.backupsDir, { recursive: true });
  writeWhole(
    NodePath.join(paths.backupsDir, `sim-${today()}.jsonl`),
    NodeFS.readFileSync(paths.journalPath),
  );
  const old = backupNames(paths);
  for (const name of old.slice(0, Math.max(0, old.length - KEPT_BACKUPS))) {
    NodeFS.rmSync(NodePath.join(paths.backupsDir, name));
  }
  for (const name of BACKED_UP_TOOLS) {
    const source = NodePath.join(paths.simDir, name);
    if (!NodeFS.existsSync(source)) continue;
    const content = NodeFS.readFileSync(source);
    const target = NodePath.join(paths.backupsDir, name);
    if (!NodeFS.existsSync(target) || !NodeFS.readFileSync(target).equals(content))
      writeWhole(target, content);
  }
}

function recordOnDisk(paths: SimResolvedPaths) {
  if (!NodeFS.existsSync(paths.recordPath))
    return { text: null, events: 0, schema: null as unknown };
  const text = NodeFS.readFileSync(paths.recordPath, "utf8");
  try {
    const parsed = JSON.parse(text) as { events?: unknown; schema?: unknown };
    return {
      text,
      events: Number.isInteger(parsed.events) ? (parsed.events as number) : 0,
      schema: parsed.schema,
    };
  } catch {
    return { text, events: 0, schema: null as unknown };
  }
}

interface Trusted {
  readonly journal: SimJournal;
  state: SimState;
  readonly disk: ReturnType<typeof recordOnDisk>;
}

function readTrusted(paths: SimResolvedPaths): Trusted {
  const kept = newestBackup(paths);
  const disk = recordOnDisk(paths);
  const journal = readJournal(paths.journalPath);
  if (!journal.broken && disk.events > journal.events.length) {
    journal.broken = `sim.json holds ${count(disk.events, "event")}, the journal only ${journal.events.length}`;
  }
  if (!journal.broken) journal.broken = departsFromBackup(journal.lines, kept);
  let state = emptyState();
  if (!journal.broken) {
    try {
      state = fold(journal.events, paths);
      state.head = journal.head;
    } catch (error) {
      journal.broken = `an event no longer applies: ${error instanceof Error ? error.message : String(error)}`;
    }
  }
  return { journal, state, disk };
}

const outOfDate = ({ journal, state, disk }: Trusted) =>
  !journal.broken && journal.events.length > 0 && disk.text !== serializeForDisk(state);

export interface SimLoaded {
  readonly journal: SimJournal;
  readonly state: SimState;
  readonly healed: boolean;
}

function shownFromDisk(seen: Trusted): SimLoaded {
  let shown: SimState | null = null;
  try {
    shown = seen.disk.text === null ? null : (JSON.parse(seen.disk.text) as SimState);
  } catch {
    // nothing readable is left; the caller reports the damage
  }
  if (!shown || !Array.isArray(shown.problems)) shown = emptyState();
  return { journal: seen.journal, state: shown, healed: false };
}

/** Read-only load from the journal without locking or writing sim.json. */
export function loadReadOnly(paths: SimResolvedPaths): SimLoaded {
  const seen = readTrusted(paths);
  if (!seen.journal.broken) return { journal: seen.journal, state: seen.state, healed: false };
  return shownFromDisk(seen);
}

/** Load the record; the caller holds sim.lock. The journal decides: a differing sim.json is rebuilt. */
export function load(paths: SimResolvedPaths): SimLoaded {
  const seen = readTrusted(paths);
  let healed = false;
  if (outOfDate(seen)) {
    writeWhole(paths.recordPath, serializeForDisk(seen.state));
    const otherVersion = typeof seen.disk.schema === "number" && seen.disk.schema !== SIM_SCHEMA;
    healed = seen.disk.text !== null && !otherVersion;
  }
  if (!seen.journal.broken) return { journal: seen.journal, state: seen.state, healed };
  return shownFromDisk(seen);
}

const brokenHelp = (reason: string) =>
  `the journal sim.jsonl is damaged (${reason}): it was changed outside this tool. ` +
  'Nothing is written until it is repaired. Run "sim.mjs restore" to put back the copy from the last write.';

export interface SimEventStamp {
  readonly by: string;
  readonly also?: string | undefined;
  readonly harness?: string | undefined;
}

/** Append one event; the caller holds sim.lock. Validation runs first, so an invalid event changes nothing. */
function append(
  paths: SimResolvedPaths,
  op: SimJournalOp,
  data: Data,
  stamp: SimEventStamp,
): { outcome: SimEventOutcome; state: SimState; event: SimJournalEvent } {
  const { journal, state } = readTrusted(paths);
  if (journal.broken) throw fail("journal_broken", brokenHelp(journal.broken));
  // What a later reader replays is the JSON line, so validate exactly that.
  const cleanData = JSON.parse(JSON.stringify(data)) as Data;
  const event: SimJournalEvent = {
    seq: journal.events.length + 1,
    ts: new Date().toISOString(),
    day: today(),
    by: stamp.by,
    ...(stamp.also ? { also: stamp.also } : {}),
    ...(stamp.harness ? { harness: stamp.harness } : {}),
    v: SIM_FORMAT,
    op,
    data: cleanData,
    prev: journal.head,
  };
  const outcome = applyEvent(state, event, paths);
  const line = JSON.stringify(event);
  NodeFS.mkdirSync(paths.simDir, { recursive: true });
  NodeFS.appendFileSync(paths.journalPath, `${line}\n`);
  const written = fold([...journal.events, event], paths);
  written.head = sha(line);
  writeWhole(paths.recordPath, serializeForDisk(written));
  backup(paths);
  return { outcome, state: written, event };
}

/** Put back the journal as last written; the caller holds sim.lock. */
export function restore(paths: SimResolvedPaths) {
  for (const name of backupNames(paths).reverse()) {
    const kept = readJournal(NodePath.join(paths.backupsDir, name));
    let state: SimState | null = null;
    try {
      if (!kept.broken && kept.events.length) state = fold(kept.events, paths);
    } catch {
      // an unusable copy; fall through
    }
    if (!state) {
      NodeFS.renameSync(
        NodePath.join(paths.backupsDir, name),
        NodePath.join(paths.backupsDir, `${name}.unusable-${Date.now()}`),
      );
      continue;
    }
    let damaged: string | null = null;
    if (NodeFS.existsSync(paths.journalPath)) {
      damaged = `${paths.journalPath}.damaged-${Date.now()}`;
      NodeFS.renameSync(paths.journalPath, damaged);
    }
    NodeFS.copyFileSync(NodePath.join(paths.backupsDir, name), paths.journalPath);
    state.head = kept.head;
    writeWhole(paths.recordPath, serializeForDisk(state));
    return { name, events: kept.events.length, kept: damaged };
  }
  throw fail("io", `no usable backup in ${paths.backupsDir}`);
}

function readHarnessFile(
  file: string,
  paths: SimResolvedPaths,
  overrides?: ReadonlyMap<string, string>,
) {
  const override = overrides?.get(file);
  if (override !== undefined) return override;
  const full = expandHarnessFile(file, paths);
  try {
    return NodeFS.statSync(full).isFile() ? NodeFS.readFileSync(full, "utf8") : null;
  } catch {
    return null;
  }
}

const occurrences = (text: string, phrase: string | null) =>
  squash(text).split(squash(phrase ?? "")).length - 1;

function coverageUnits(paths: SimResolvedPaths) {
  const units: Array<{ file: string; text: string | null }> = [];
  const notes = NodePath.join(paths.harnessDir, "notes");
  const noteFiles = NodeFS.existsSync(notes)
    ? NodeFS.readdirSync(notes)
        .filter((item) => item.endsWith(".md"))
        .sort()
        .map((name) => `~/.claude/notes/${name}`)
    : [];
  for (const file of ["~/.claude/AGENTS.md", ...noteFiles]) {
    const text = readHarnessFile(file, paths);
    if (text === null) continue;
    let inLessons = false;
    for (const line of text.split("\n")) {
      if (line.startsWith("## ")) inLessons = /^## (Scars|Wins)\b/.test(line);
      else if (/^\s*- /.test(line) && (inLessons || /^\s*-\s+(Scar|Win)\b/.test(line))) {
        units.push({ file, text: line });
      }
    }
  }
  const hooks = NodePath.join(paths.harnessDir, "hooks");
  if (NodeFS.existsSync(hooks)) {
    for (const name of NodeFS.readdirSync(hooks)
      .filter((item) => item.endsWith(".mjs"))
      .sort()) {
      units.push({ file: `~/.claude/hooks/${name}`, text: null });
    }
  }
  return units;
}

/** Recent Claude Code writers without a transcript here. T3 stamps `t3:` writers itself, so they are known. */
function strangers(journal: SimJournal, paths: SimResolvedPaths) {
  const roots = [NodePath.join(paths.harnessDir, "projects")];
  if (paths.harnessDir === NodePath.join(paths.homeDir, ".claude")) {
    try {
      for (const name of NodeFS.readdirSync(paths.homeDir)) {
        if (/^\.claude-/.test(name)) roots.push(NodePath.join(paths.homeDir, name, "projects"));
      }
    } catch {
      // an unreadable home lists no extra roots
    }
  }
  const folders = roots
    .filter((root) => NodeFS.existsSync(root))
    .flatMap((root) => NodeFS.readdirSync(root).map((name) => NodePath.join(root, name)));
  const found = new Map<string, Array<number>>();
  if (!folders.length) return found;
  const since = new Date(Date.now() - SEEN_DAYS * 86_400_000).toISOString().slice(0, 10);
  const known = new Map<string, boolean>();
  for (const event of journal.events) {
    if (typeof event.day !== "string" || event.day < since || typeof event.by !== "string")
      continue;
    if (event.by.startsWith("t3:")) continue;
    if (!known.has(event.by)) {
      const id = event.by.startsWith("cc:") ? event.by.slice(3) : null;
      known.set(
        event.by,
        id !== null &&
          folders.some((folder) => NodeFS.existsSync(NodePath.join(folder, `${id}.jsonl`))),
      );
    }
    if (!known.get(event.by)) found.set(event.by, [...(found.get(event.by) ?? []), event.seq]);
  }
  return found;
}

export interface SimHarnessHealth {
  readonly drift: ReadonlyArray<{ readonly attempt: SimAttempt; readonly reason: string }>;
  readonly uncovered: ReadonlyArray<{ readonly file: string; readonly text: string | null }>;
  readonly unchecked: ReadonlyArray<SimAttempt>;
}

/** Compare the record with the harness files: drift, and agent-added rules without a record. */
export function inspectHarness(state: SimState, paths: SimResolvedPaths): SimHarnessHealth {
  const live = allAttempts(state).filter((attempt) => attempt.live);
  const drift: Array<{ attempt: SimAttempt; reason: string }> = [];
  const unchecked: Array<SimAttempt> = [];
  for (const attempt of live) {
    const first = attempt.files[0] ?? "";
    const text = readHarnessFile(first, paths);
    if (text === null) {
      if (first.startsWith("~/.claude/"))
        drift.push({ attempt, reason: `${first} does not exist` });
      else unchecked.push(attempt);
    } else if (!occurrences(text, attempt.anchor)) {
      drift.push({ attempt, reason: `"${attempt.anchor}" is no longer in ${first}` });
    }
  }
  const uncovered = coverageUnits(paths).filter((unit) => {
    const inFile = live.filter((attempt) => attempt.files.includes(unit.file));
    return unit.text === null
      ? !inFile.length
      : !inFile.some((attempt) => occurrences(unit.text!, attempt.anchor));
  });
  return { drift, uncovered, unchecked };
}

const words = (text: string) =>
  new Set(
    squash(text)
      .toLowerCase()
      .split(/[^a-z0-9äöüß]+/)
      .filter((word) => word.length >= 4)
      .map((word) => word.replace(/(ing|ed|es|s)$/, ""))
      .filter((word) => word.length >= 3),
  );

const problemWords = (problem: SimProblem) =>
  words(
    [
      problem.name,
      ...problem.former_names,
      ...problem.attempts.flatMap((attempt) => [
        attempt.what,
        attempt.anchor ?? "",
        ...attempt.predicted,
      ]),
    ].join(" "),
  );

/** The entries closest to a text by shared words (TF-IDF with a length penalty). */
function relatedProblems(
  state: SimState,
  text: string,
  limit = RELATED_LIMIT,
  floor = RELATED_FLOOR,
): Array<string> {
  const docs = state.problems.map((problem) => ({ id: problem.id, words: problemWords(problem) }));
  const spread = new Map<string, number>();
  for (const doc of docs)
    for (const word of doc.words) spread.set(word, (spread.get(word) ?? 0) + 1);
  const average = docs.reduce((sum, doc) => sum + doc.words.size, 0) / (docs.length || 1) || 1;
  const length = (doc: { words: Set<string> }) =>
    1 - RELATED_LENGTH + (RELATED_LENGTH * doc.words.size) / average;
  const query = words(text);
  return docs
    .map((doc) => ({
      id: doc.id,
      score:
        [...query]
          .filter((word) => doc.words.has(word))
          .reduce((sum, word) => sum + 1 / spread.get(word)!, 0) / length(doc),
    }))
    .filter((item) => item.score >= floor)
    .sort((a, b) => b.score - a.score || idNumber(a.id) - idNumber(b.id))
    .slice(0, limit)
    .map((item) => item.id);
}

type Need = Map<string, [level: "full" | "brief", why: string]>;

function mustReadInFull(state: SimState, input: Data) {
  const need: Need = new Map();
  const cited = isText(input.problem)
    ? findProblem(state, input.problem.trim())
    : isText(input.new)
      ? problemNamed(state, input.new)
      : null;
  if (cited) need.set(cited.id, ["full", "you continue it"]);
  for (const id of Array.isArray(input.supersedes) ? input.supersedes : []) {
    const hit = isText(id) ? findAttempt(state, id) : null;
    if (hit && !need.has(hit.problem.id))
      need.set(hit.problem.id, ["full", `it holds ${id}, which you change`]);
  }
  const opensNew = !cited && isText(input.new);
  const text = opensNew
    ? [input.new, input.what, input.anchor, ...(isList(input.predicted) ? input.predicted : [])]
        .filter((item): item is string => isText(item))
        .join(" ")
    : null;
  return { need, text };
}

function demandShown(
  state: SimState,
  shown: ReadonlyMap<string, "full" | "brief">,
  need: Need,
  text: string | null = null,
  hint = "",
) {
  if (text !== null) {
    for (const id of relatedProblems(state, text)) {
      if (!need.has(id)) need.set(id, ["full", "it shares words with your change"]);
    }
  }
  const lacking = [...need].filter(
    ([id, [level]]) => !(shown.get(id) === "full" || (level === "brief" && shown.has(id))),
  );
  const unseen =
    text === null
      ? []
      : state.problems.filter((problem) => !shown.has(problem.id) && !need.has(problem.id));
  if (!lacking.length && !unseen.length) return;
  const lines: Array<string> = [];
  for (const level of ["full", "brief"] as const) {
    const group = lacking.filter(([, [wanted]]) => wanted === level);
    if (!group.length) continue;
    const ids = group.map(([id]) => id).join(" ");
    const which = group.length === 1 ? "this entry" : "these entries";
    lines.push(
      level === "full"
        ? `read ${which} in full first: SIM read action "show" with ids ${ids}`
        : `read ${which} at least in brief first: SIM read action "show" with ids ${ids} and brief: true`,
    );
    lines.push(...group.map(([id, [, why]]) => `${indexLine(findProblem(state, id)!)}  <- ${why}`));
  }
  if (unseen.length) {
    const few = unseen.length < state.problems.length;
    const command = few
      ? `SIM read action "show" with ids ${unseen.map((problem) => problem.id).join(" ")} and brief: true`
      : 'SIM read action "brief_all"';
    lines.push(
      `a new root cause needs the whole record in view first: ${command} (${few ? "" : "every page; "}${unseen.length} of ${state.problems.length} entries not shown to this session as they are now)`,
    );
  }
  lines.push(
    `${hint}Then repeat the write: the server knows what it has shown to this session, and a reading counts until the entry changes or the context is compacted.`,
  );
  throw fail("seen_required", lines);
}

function requireReading(
  state: SimState,
  shown: ReadonlyMap<string, "full" | "brief">,
  input: Data,
) {
  const { need, text } = mustReadInFull(state, input);
  demandShown(
    state,
    shown,
    need,
    text,
    'If one of these entries is the root cause of your change, record under it ("problem"). ',
  );
  return [...need.keys()];
}

const short = (file: string) => file.replace(/^~\/\.claude\//, "");
const briefId = (session: string) => (session.length > 14 ? session.slice(0, 11) : session);

type Tally = Record<
  "fixed" | "unconfirmed" | "missed" | "regressed" | "misfired" | "inconclusive" | "pending",
  number
>;

function tally(attempts: ReadonlyArray<SimAttempt>): Tally {
  const sum: Tally = {
    fixed: 0,
    unconfirmed: 0,
    missed: 0,
    regressed: 0,
    misfired: 0,
    inconclusive: 0,
    pending: 0,
  };
  for (const attempt of attempts.filter((item) => !item.retracted)) {
    for (const obs of standing(attempt)) {
      if (obs.result === "fixed") sum[settlesFix(attempt, obs) ? "fixed" : "unconfirmed"] += 1;
      else if (obs.result in sum) sum[obs.result as keyof Tally] += 1;
    }
    if (attempt.live) sum.pending += attempt.pending.length;
  }
  return sum;
}

function tallyText(sum: Tally) {
  const parts = (
    ["fixed", "unconfirmed", "missed", "regressed", "misfired", "inconclusive"] as const
  )
    .filter((key) => sum[key])
    .map((key) => `${key} ${sum[key]}`);
  if (sum.pending) parts.push(`open ${sum.pending}`);
  return parts.length ? parts.join(" ") : "no outcomes";
}

const INDEX_LEGEND =
  "id | root cause | live rules | attempts | outcomes (fixed = seen by another session; unconfirmed = a fix only the changing session reported; open = predictions of live rules not settled yet)";

function indexLine(problem: SimProblem) {
  const accepted = problem.attempts.filter((attempt) => attempt.accepted);
  const live = accepted.filter((attempt) => attempt.live);
  const proposals = problem.attempts.length - accepted.length;
  const files = [...new Set(live.map((attempt) => short(attempt.files[0] ?? "")))].join(", ");
  const where = live.length ? `${live.length} live: ${files}` : "no live rule";
  const tries = `${count(problem.attempts.length, "attempt")}${proposals ? ` (${proposals} not carried out)` : ""}`;
  return `${problem.id} | ${problem.name} | ${where} | ${tries} | ${tallyText(tally(accepted))}`;
}

function renderIndex(state: SimState) {
  return state.problems.map(indexLine).join("\n");
}

function renderFile(state: SimState, file: string): Array<string> {
  const lines: Array<string> = [];
  for (const problem of state.problems) {
    for (const attempt of problem.attempts) {
      if (attempt.live && attempt.files.includes(file)) {
        lines.push(
          `${problem.id} ${attempt.id} "${attempt.anchor}"${attempt.files[0] === file ? "" : ` (in ${short(attempt.files[0] ?? "")})`}`,
        );
      }
    }
  }
  return lines;
}

const attemptText = (attempt: SimAttempt) =>
  [
    attempt.what,
    attempt.why,
    attempt.anchor,
    attempt.expect,
    attempt.rejected_because,
    ...attempt.predicted,
    ...attempt.observations.map((obs) => `${obs.target} ${obs.evidence}`),
  ]
    .filter(Boolean)
    .join(" ");

function searchProblems(state: SimState, query: string): Array<SimProblem> {
  const wanted = squash(query).toLowerCase().split(" ").filter(Boolean);
  return state.problems.filter((problem) => {
    const text = [problem.name, ...problem.former_names, ...problem.attempts.map(attemptText)]
      .join(" ")
      .toLowerCase();
    return wanted.every((word) => text.includes(word));
  });
}

function attemptState(attempt: SimAttempt) {
  if (attempt.retracted) return `RETRACTED (${attempt.retracted.reason})`;
  if (!attempt.accepted) return attempt.unanswered ? "PROPOSED, no answer" : "REJECTED";
  if (attempt.live) return "LIVE";
  return attempt.action === "remove"
    ? "removal"
    : `no longer live (changed by ${attempt.superseded_by})`;
}

/** `withHarness: false` reproduces sim.mjs byte for byte, so seen stamps agree between the two tools. */
function renderAttempt(attempt: SimAttempt, withHarness: boolean) {
  const head = [
    attempt.id,
    attempt.round,
    attempt.action,
    attemptState(attempt),
    attempt.policy,
    attempt.domain,
  ];
  if (withHarness && attempt.harness) head.push(`harness ${attempt.harness}`);
  if (attempt.backfilled) {
    head.push(
      `backfilled by ${briefId(attempt.by)}${attempt.sample === SIM_UNKNOWN ? "" : `, made by ${briefId(attempt.sample)}`}`,
    );
  } else head.push(`by ${briefId(attempt.by)}`);
  const lines = [`  ${head.join(" · ")}`, `    what: ${attempt.what}`, `    why: ${attempt.why}`];
  if (attempt.rejected_because) lines.push(`    rejected because: ${attempt.rejected_because}`);
  if (attempt.files.length) {
    lines.push(
      `    where: ${attempt.files.join(", ")}${attempt.anchor ? ` "${attempt.anchor}"` : ""}`,
    );
  }
  if (attempt.supersedes.length) {
    lines.push(
      `    ${attempt.accepted ? "changes" : "would change"}: ${attempt.supersedes.join(", ")}`,
    );
  }
  if (attempt.depends_on.length) lines.push(`    depends on: ${attempt.depends_on.join(", ")}`);
  if (attempt.predicted.length) {
    const label = attempt.action === "remove" ? "may bring back" : "predicted to fix";
    lines.push(
      // oxlint-disable-next-line t3code/no-em-dash-copy -- byte-identical to sim.mjs, whose seen stamps hash this text
      `    ${label}: ${attempt.predicted.join(", ")}${attempt.expect ? ` — ${attempt.expect}` : ""}`,
    );
  }
  attempt.observations.forEach((obs, index) => {
    const what = obs.result === "kept" ? "kept after review" : `${obs.target} ${obs.result}`;
    const own = obs.result === "fixed" ? ownReport(attempt, obs) : null;
    const back = obs.restored
      ? `restored after a retraction (${obs.restored.retracted_because}; restored: ${obs.restored.reason}) `
      : "";
    const note = obs.retracted
      ? `RETRACTED (${obs.retracted.reason}) `
      : own
        ? `not confirmed (${own}): `
        : "";
    const seen =
      obs.sample !== obs.by && obs.sample !== SIM_UNKNOWN
        ? `, said to be seen by ${briefId(obs.sample)}`
        : "";
    const harness = withHarness && obs.harness ? `, ${obs.harness}` : "";
    lines.push(
      `    outcome ${index + 1}: ${back}${note}${what} (${obs.date}, ${obs.source}, ${obs.policy}${harness}, ${obs.domain}, by ${briefId(obs.by)}${seen}) ${obs.evidence}`,
    );
  });
  if (attempt.accepted && !attempt.retracted && attempt.pending.length) {
    lines.push(`    still open: ${attempt.pending.join(", ")}`);
  }
  if (attempt.restored) {
    lines.push(
      `    restored after a retraction (${attempt.restored.retracted_because}; restored: ${attempt.restored.reason})`,
    );
  }
  for (const change of attempt.amended ?? []) {
    const was =
      change.was === undefined || change.was === null
        ? "nothing"
        : Array.isArray(change.was)
          ? change.was.join(", ")
          : `"${String(change.was)}"`;
    lines.push(`    amended: ${change.field}, was ${was} (${change.reason})`);
  }
  return lines.join("\n");
}

function problemHead(state: SimState, problem: SimProblem) {
  // oxlint-disable-next-line t3code/no-em-dash-copy -- byte-identical to sim.mjs, whose seen stamps hash this text
  const head = [`${problem.id} — ${problem.name}`, `opened ${problem.opened_round}`];
  const formerIds = Object.keys(state.aliases)
    .filter((id) => resolveId(state, id) === problem.id)
    .sort((a, b) => idNumber(a) - idNumber(b));
  if (formerIds.length) head.push(`merged from ${formerIds.join(", ")}`);
  const links = problem.related
    .map((link) => `${link.kind} ${resolveId(state, link.id)}`)
    .filter((text) => !text.endsWith(` ${problem.id}`));
  if (links.length) head.push([...new Set(links)].join(", "));
  return head.join(" · ");
}

function renderProblemWith(state: SimState, problem: SimProblem, withHarness: boolean) {
  const lines = [problemHead(state, problem)];
  for (const name of problem.former_names) lines.push(`  earlier wording: ${name}`);
  for (const attempt of problem.attempts) lines.push(renderAttempt(attempt, withHarness));
  return lines.join("\n");
}

/** Every attempt of an entry in full, with the harness each was made under. */
const renderProblem = (state: SimState, problem: SimProblem) =>
  renderProblemWith(state, problem, true);

const clip = (text: string, size: number) =>
  text.length <= size ? text : `${text.slice(0, size - 1).trimEnd()}…`;

function renderBrief(state: SimState, problem: SimProblem) {
  const lines = [problemHead(state, problem)];
  for (const attempt of problem.attempts) {
    const sum = tally([attempt]);
    const harness = attempt.harness ? ` [${attempt.harness}]` : "";
    const parts = [
      `${attempt.id} ${attempt.round} ${attempt.action}${harness}, ${attemptState(attempt)}: ${clip(attempt.what, 160)}`,
    ];
    if (attempt.rejected_because) parts.push(`because: ${clip(attempt.rejected_because, 160)}`);
    if (attempt.accepted && !attempt.retracted) parts.push(tallyText(sum));
    lines.push(`  ${parts.join(" | ")}`);
  }
  return lines.join("\n");
}

function renderCarried(state: SimState) {
  const side = (value: SimCarrySide) =>
    [value.policy, value.domain, value.harness].filter(Boolean).join(" / ");
  return state.carried_from
    .map(
      (item) =>
        `carried ${item.date}: ${side(item.from)} -> ${side(item.into)}${item.note ? ` (${item.note})` : ""}`,
    )
    .join("\n");
}

function warnings(state: SimState, journal: SimJournal, health: SimHarnessHealth) {
  const out: Array<string> = [];
  if (journal.broken) out.push(`WARNING: ${brokenHelp(journal.broken)}`);
  const { drift, uncovered } = health;
  if (drift.length || uncovered.length) {
    const parts: Array<string> = [];
    if (drift.length)
      parts.push(`${count(drift.length, "recorded rule")} changed or vanished without a record`);
    if (uncovered.length) {
      parts.push(
        `${count(uncovered.length, "agent-added rule")} (Scar, Win, hook) without a record`,
      );
    }
    out.push(
      `WARNING: ${parts.join("; ")}. Run the SIM "check" read and reconcile before you propose.`,
    );
  }
  return out;
}

const rulesPointer = () =>
  'How to read and write this record: use sim_read ("index", "by_file", "show", "check", "review", "audit"), sim_write, and sim_apply_harness_change.';
const HEALED_NOTE =
  "note: sim.json did not match the journal and was rebuilt. Change the record only through this tool.";

interface PagePart {
  readonly index: number;
  readonly from: number;
  readonly to: number;
  readonly of: number;
}

/** Cut units into pages; a unit longer than a page is cut at line ends and each piece knows its range. */
function pages(units: ReadonlyArray<string>, separator: string, size: number) {
  const pieces: Array<PagePart & { text: string }> = [];
  units.forEach((unit, index) => {
    if (unit.length <= size) {
      pieces.push({ text: unit, index, from: 0, to: unit.length, of: unit.length });
      return;
    }
    const parts: Array<string> = [];
    let chunk: Array<string> = [];
    let used = 0;
    for (const line of unit.split("\n")) {
      if (chunk.length && used + line.length + 1 > size) {
        parts.push(chunk.join("\n"));
        chunk = [];
        used = 0;
      }
      chunk.push(line);
      used += line.length + 1;
    }
    if (chunk.length) parts.push(chunk.join("\n"));
    let from = 0;
    for (const text of parts) {
      pieces.push({
        text,
        index,
        from,
        to: Math.min(unit.length, from + text.length + 1),
        of: unit.length,
      });
      from += text.length + 1;
    }
  });
  const out: Array<{ text: string; parts: Array<PagePart> }> = [];
  let page: typeof pieces = [];
  let used = 0;
  const close = () => {
    out.push({
      text: page.map((piece) => piece.text).join(separator),
      parts: page.map(({ index, from, to, of }) => ({ index, from, to, of })),
    });
    page = [];
    used = 0;
  };
  for (const piece of pieces) {
    if (page.length && used + piece.text.length + separator.length > size) close();
    page.push(piece);
    used += piece.text.length + separator.length;
  }
  if (page.length || !out.length) close();
  return out;
}

function paged(options: {
  readonly command: string;
  readonly page?: number | undefined;
  readonly head?: ReadonlyArray<string>;
  readonly units: ReadonlyArray<string>;
  readonly separator?: string;
  readonly tail?: ReadonlyArray<string>;
  readonly size?: number;
  readonly shown?: ((parts: ReadonlyArray<PagePart>) => void) | null;
}): string {
  const head = options.head ?? [];
  const tail = options.tail ?? [];
  const size = options.size ?? SIM_DEFAULT_PAGE_CHARS;
  const fixed = [...head, ...tail].join("\n").length + 200;
  const list = pages(options.units, options.separator ?? "\n", Math.max(1000, size - fixed));
  const wanted = options.page === undefined ? 1 : Number(options.page);
  if (!Number.isInteger(wanted) || wanted < 1 || wanted > list.length) {
    throw invalid(
      `this output has ${count(list.length, "page")}; page ${String(options.page)} does not exist`,
    );
  }
  const current = list[wanted - 1]!;
  const out = wanted === 1 ? [...head] : [];
  if (current.text) out.push(current.text);
  if (list.length > 1) {
    out.push(
      wanted < list.length
        ? `page ${wanted} of ${list.length}: nothing is left out, read on with: ${options.command} page ${wanted + 1}`
        : `page ${wanted} of ${list.length}, the last one.`,
    );
  }
  if (wanted === list.length) out.push(...tail);
  options.shown?.(current.parts);
  return out.join("\n");
}

interface SeenLog {
  session: string;
  full: Record<string, string>;
  brief: Record<string, string>;
  parts: Record<string, { mark: string; at: number; ranges: Array<[number, number]> }>;
  at: Record<string, number>;
  index_at?: number;
  files_at?: Record<string, number>;
  t3_epoch?: number;
}

interface EpochEntry {
  readonly epoch: number;
  readonly resetAt: number;
  readonly updatedAt?: number | undefined;
  readonly lastProviderThreadId?: string | undefined;
  readonly lastExtraSessionIds?: ReadonlyArray<string> | undefined;
}

/** Which seen logs a caller reads and writes, and the context epoch its readings must belong to. */
export interface SimSeenScope {
  readonly sessions: ReadonlyArray<string>;
  readonly epoch: number;
  readonly resetAt: number;
}

const seenFile = (paths: SimResolvedPaths, session: string) =>
  NodePath.join(paths.seenDir, `${sha(session).slice(0, 16)}.json`);
/** An entry as sim.mjs renders it; a reading counts only while this stamp holds. */
const stamp = (state: SimState, problem: SimProblem) =>
  sha(renderProblemWith(state, problem, false)).slice(0, 16);

const freshLog = (session: string): SeenLog => ({
  session,
  full: {},
  brief: {},
  parts: {},
  at: {},
});

function readSeen(paths: SimResolvedPaths, session: string): SeenLog {
  try {
    const log = JSON.parse(NodeFS.readFileSync(seenFile(paths, session), "utf8")) as SeenLog;
    if (
      log &&
      log.session === session &&
      typeof log.full === "object" &&
      typeof log.brief === "object"
    ) {
      return { ...log, parts: log.parts ?? {}, at: log.at ?? {} };
    }
  } catch {
    // no log yet, or an unreadable one: nothing counts as shown
  }
  return freshLog(session);
}

function joinRanges(ranges: ReadonlyArray<[number, number]>) {
  const out: Array<[number, number]> = [];
  for (const [from, to] of [...ranges].sort((a, b) => a[0] - b[0])) {
    const last = out[out.length - 1];
    if (last && from <= last[1]) last[1] = Math.max(last[1], to);
    else out.push([from, to]);
  }
  return out;
}

function saveSeen(paths: SimResolvedPaths, session: string, log: SeenLog) {
  try {
    NodeFS.mkdirSync(paths.seenDir, { recursive: true });
    writeWhole(seenFile(paths, session), JSON.stringify(log));
  } catch {
    return;
  }
  const limit = Date.now() - SEEN_DAYS * 86_400_000;
  for (const name of NodeFS.readdirSync(paths.seenDir)) {
    try {
      if (NodeFS.statSync(NodePath.join(paths.seenDir, name)).mtimeMs < limit) {
        NodeFS.rmSync(NodePath.join(paths.seenDir, name));
      }
    } catch {
      // another session removed it first
    }
  }
}

function readEpochs(paths: SimResolvedPaths): Record<string, EpochEntry> {
  try {
    const parsed = JSON.parse(NodeFS.readFileSync(paths.epochsPath, "utf8")) as unknown;
    return parsed !== null && typeof parsed === "object"
      ? (parsed as Record<string, EpochEntry>)
      : {};
  } catch {
    return {};
  }
}

export function getThreadSeenEpoch(paths: SimResolvedPaths, threadId: string): number {
  return readEpochs(paths)[threadId]?.epoch ?? 0;
}

const threadSessionId = (threadId: string) => `t3:${threadId}`;

function pruneAndWriteEpochs(
  paths: SimResolvedPaths,
  epochs: Record<string, EpochEntry>,
  now: number,
) {
  // Seen logs expire after SEEN_DAYS; an epoch older than twice that guards nothing.
  for (const [id, entry] of Object.entries(epochs)) {
    const refTime = entry.updatedAt ?? entry.resetAt;
    if (refTime > 0 && now - refTime > 2 * SEEN_DAYS * 86_400_000) delete epochs[id];
  }
  NodeFS.mkdirSync(paths.simDir, { recursive: true });
  writeWhole(paths.epochsPath, `${JSON.stringify(epochs)}\n`);
}

/** After compaction: readings from before no longer count for this thread (or its native session). */
export function resetThreadSeenEpoch(
  paths: SimResolvedPaths,
  threadId: string,
  extraSessionIds: ReadonlyArray<string> = [],
): number {
  const epochs = readEpochs(paths);
  const existing = epochs[threadId];
  const now = Date.now();
  const next = (existing?.epoch ?? 0) + 1;
  const knownExtras = [...new Set([...(existing?.lastExtraSessionIds ?? []), ...extraSessionIds])];
  epochs[threadId] = {
    epoch: next,
    resetAt: now,
    updatedAt: now,
    ...(existing?.lastProviderThreadId
      ? { lastProviderThreadId: existing.lastProviderThreadId }
      : {}),
    ...(knownExtras.length ? { lastExtraSessionIds: knownExtras } : {}),
  };
  pruneAndWriteEpochs(paths, epochs, now);
  for (const session of new Set([threadSessionId(threadId), ...knownExtras])) {
    saveSeen(paths, session, { ...freshLog(session), t3_epoch: next });
  }
  return next;
}

/**
 * Persist the active provider thread for `threadId` in `t3-epochs.json` so a provider-thread
 * switch (/clear, fresh context, provider switch) still bumps the seen epoch after a server
 * restart. Returns true when a switch triggered an epoch reset.
 */
export function trackProviderThread(
  paths: SimResolvedPaths,
  threadId: string,
  providerThreadId: string,
  extraSessionIds: ReadonlyArray<string> = [],
): boolean {
  const epochs = readEpochs(paths);
  const existing = epochs[threadId];
  const now = Date.now();
  const combinedExtras = [
    ...new Set([...(existing?.lastExtraSessionIds ?? []), ...extraSessionIds]),
  ];
  if (existing?.lastProviderThreadId === providerThreadId) {
    if (combinedExtras.length > (existing.lastExtraSessionIds?.length ?? 0)) {
      epochs[threadId] = { ...existing, updatedAt: now, lastExtraSessionIds: combinedExtras };
      pruneAndWriteEpochs(paths, epochs, now);
    }
    return false;
  }
  if (existing?.lastProviderThreadId === undefined) {
    epochs[threadId] = {
      epoch: existing?.epoch ?? 0,
      resetAt: existing?.resetAt ?? 0,
      updatedAt: now,
      lastProviderThreadId: providerThreadId,
      ...(combinedExtras.length ? { lastExtraSessionIds: combinedExtras } : {}),
    };
    pruneAndWriteEpochs(paths, epochs, now);
    return false;
  }
  const next = (existing.epoch ?? 0) + 1;
  epochs[threadId] = {
    epoch: next,
    resetAt: now,
    updatedAt: now,
    lastProviderThreadId: providerThreadId,
    ...(extraSessionIds.length ? { lastExtraSessionIds: [...new Set(extraSessionIds)] } : {}),
  };
  pruneAndWriteEpochs(paths, epochs, now);
  for (const session of new Set([threadSessionId(threadId), ...combinedExtras])) {
    saveSeen(paths, session, { ...freshLog(session), t3_epoch: next });
  }
  return true;
}

function hasConsultedIndexOrFile(
  paths: SimResolvedPaths,
  scope: SimSeenScope,
  files: ReadonlyArray<string>,
): boolean {
  const now = Date.now();
  const canonical = files.map((file) => canonicalFile(file, paths));
  for (const session of scope.sessions) {
    const log = readSeen(paths, session);
    if ((log.t3_epoch ?? 0) < scope.epoch) continue;
    const fresh = (at: unknown): boolean => {
      if (typeof at !== "number" || at <= 0) return false;
      if (at < scope.resetAt) return false;
      if (session === SIM_UNKNOWN && now - at > SITTING_MINUTES * 60_000) return false;
      return true;
    };
    if (fresh(log.index_at)) return true;
    if (canonical.length > 0 && log.files_at) {
      if (canonical.every((file) => fresh(log.files_at?.[file]))) return true;
    }
  }
  return false;
}

function requireIndexConsulted(
  paths: SimResolvedPaths,
  scope: SimSeenScope,
  files: ReadonlyArray<string>,
) {
  if (hasConsultedIndexOrFile(paths, scope, files)) return;
  const target = files[0];
  const hint = target
    ? `call sim_read with action "index" or action "by_file" (file: "${target}") in this context first`
    : 'call sim_read with action "index" in this context first';
  throw fail("seen_required", [
    `read the SIM index or this file's entries before recording or applying a harness change: ${hint}.`,
    "Then repeat the call: the server tracks what it has shown to this session in the current context epoch.",
  ]);
}

export function readAuditWatermarkMs(paths: SimResolvedPaths): number | null {
  try {
    const parsed = JSON.parse(NodeFS.readFileSync(paths.auditStatePath, "utf8")) as {
      last_audit_at?: unknown;
    };
    if (typeof parsed.last_audit_at !== "string") return null;
    const ms = Date.parse(parsed.last_audit_at);
    return Number.isFinite(ms) ? ms : null;
  } catch {
    return null;
  }
}

export function seenScope(paths: SimResolvedPaths, caller: SimCallerContext): SimSeenScope {
  const sessions = [caller.sessionId || SIM_UNKNOWN];
  if (caller.alsoSessionId && caller.alsoSessionId !== sessions[0])
    sessions.push(caller.alsoSessionId);
  const entry = caller.threadId ? readEpochs(paths)[caller.threadId] : undefined;
  return { sessions, epoch: entry?.epoch ?? 0, resetAt: entry?.resetAt ?? 0 };
}

/** A log as it may be extended in this epoch: one from an earlier context starts over. */
function currentLog(paths: SimResolvedPaths, session: string, scope: SimSeenScope): SeenLog {
  const log = readSeen(paths, session);
  const fresh = (log.t3_epoch ?? 0) < scope.epoch ? freshLog(session) : log;
  fresh.t3_epoch = scope.epoch;
  return fresh;
}

function markIndexShown(paths: SimResolvedPaths, scope: SimSeenScope, file: string | null = null) {
  const now = Date.now();
  for (const session of scope.sessions) {
    const log = currentLog(paths, session, scope);
    if (file) log.files_at = { ...log.files_at, [file]: now };
    else log.index_at = now;
    saveSeen(paths, session, log);
  }
}

export function markShown(
  paths: SimResolvedPaths,
  state: SimState,
  items: ReadonlyArray<{ problem: SimProblem; from?: number; to?: number; of?: number }>,
  level: "full" | "brief",
  scope: SimSeenScope,
  keepTime = false,
) {
  if (!items.length) return;
  for (const session of scope.sessions) {
    const log = currentLog(paths, session, scope);
    const now = Date.now();
    const lapsed = (at: number) => session === SIM_UNKNOWN && now - at > SITTING_MINUTES * 60_000;
    for (const { problem, from = 0, to = 1, of = 1 } of items) {
      const mark = stamp(state, problem);
      let at = now;
      if (!(from === 0 && to >= of)) {
        const key = `${problem.id} ${level}`;
        const noted = log.parts[key];
        const had =
          noted && noted.mark === mark && Array.isArray(noted.ranges) && !lapsed(noted.at)
            ? noted
            : null;
        const ranges = joinRanges([...(had ? had.ranges : []), [from, to]]);
        at = had ? had.at : now;
        const first = ranges[0];
        if (!(ranges.length === 1 && first && first[0] === 0 && first[1] >= of)) {
          log.parts[key] = { mark, at, ranges };
          continue;
        }
        delete log.parts[key];
      }
      log.brief[problem.id] = mark;
      if (level === "full") log.full[problem.id] = mark;
      log.at[problem.id] = keepTime && log.at[problem.id] ? log.at[problem.id]! : at;
    }
    if (
      !keepTime &&
      state.problems.length &&
      state.problems.every(
        (problem) =>
          log.brief[problem.id] === stamp(state, problem) && !lapsed(log.at[problem.id] ?? 0),
      )
    ) {
      log.index_at = now;
    }
    saveSeen(paths, session, log);
  }
}

/** What the caller was shown of each entry as it is now, in this context epoch, over both session names. */
export function shownTo(
  paths: SimResolvedPaths,
  state: SimState,
  scope: SimSeenScope,
): Map<string, "full" | "brief"> {
  const levels = new Map<string, "full" | "brief">();
  for (const session of scope.sessions) {
    const log = readSeen(paths, session);
    if ((log.t3_epoch ?? 0) < scope.epoch) continue;
    const lapsed = (id: string) =>
      session === SIM_UNKNOWN && Date.now() - (log.at[id] ?? 0) > SITTING_MINUTES * 60_000;
    for (const problem of state.problems) {
      if (lapsed(problem.id) || (log.at[problem.id] ?? 0) < scope.resetAt) continue;
      const mark = stamp(state, problem);
      if (log.full[problem.id] === mark) levels.set(problem.id, "full");
      else if (log.brief[problem.id] === mark && !levels.has(problem.id))
        levels.set(problem.id, "brief");
    }
  }
  return levels;
}

function keepShown(
  paths: SimResolvedPaths,
  before: ReadonlyMap<string, "full" | "brief">,
  state: SimState,
  scope: SimSeenScope,
  created: string | null = null,
) {
  for (const level of ["full", "brief"] as const) {
    const kept = state.problems.filter(
      (problem) => (problem.id === created ? "full" : before.get(problem.id)) === level,
    );
    markShown(
      paths,
      state,
      kept.map((problem) => ({ problem })),
      level,
      scope,
      true,
    );
  }
}

export function appendTelemetry(paths: SimResolvedPaths, event: SimTelemetryEvent) {
  NodeFS.mkdirSync(paths.simDir, { recursive: true });
  NodeFS.appendFileSync(paths.telemetryPath, `${JSON.stringify(event)}\n`);
  const size = NodeFS.statSync(paths.telemetryPath).size;
  if (size <= TELEMETRY_MAX_BYTES / 2) return;
  const lines = NodeFS.readFileSync(paths.telemetryPath, "utf8").split("\n").filter(Boolean);
  if (lines.length > TELEMETRY_MAX_LINES || size > TELEMETRY_MAX_BYTES) {
    writeWhole(paths.telemetryPath, `${lines.slice(-TELEMETRY_KEEP_LINES).join("\n")}\n`);
  }
}

export function readTelemetry(paths: SimResolvedPaths, sinceMs?: number): Array<SimTelemetryEvent> {
  let raw: string;
  try {
    raw = NodeFS.readFileSync(paths.telemetryPath, "utf8");
  } catch {
    return [];
  }
  const out: Array<SimTelemetryEvent> = [];
  for (const line of raw.split("\n")) {
    if (!line) continue;
    try {
      const event = JSON.parse(line) as SimTelemetryEvent;
      if (typeof event?.kind !== "string" || typeof event.ts !== "string") continue;
      if (sinceMs !== undefined) {
        const ms = Date.parse(event.ts);
        if (Number.isFinite(ms) && ms < sinceMs) continue;
      }
      out.push(event);
    } catch {
      // a torn line from a crash mid-append
    }
  }
  return out;
}

/** Models SIM already knows: every policy an attempt, outcome or carry names, plain and per harness. */
export function observedModels(state: SimState): Set<string> {
  const out = new Set<string>();
  const add = (policy: string | undefined, harness: string | undefined) => {
    if (!policy) return;
    out.add(policy);
    if (harness) out.add(`${harness}::${policy}`);
  };
  for (const attempt of allAttempts(state)) {
    add(attempt.policy, effectiveHarness(attempt));
    for (const obs of attempt.observations) add(obs.policy, effectiveHarness(obs));
  }
  for (const carry of state.carried_from) {
    add(carry.from.policy, carry.from.harness);
    add(carry.into.policy, carry.into.harness);
  }
  return out;
}

function unseenModels(state: SimState, telemetry: ReadonlyArray<SimTelemetryEvent>) {
  const known = observedModels(state);
  const out = new Map<string, { providerInstanceId: string; model: string }>();
  for (const event of telemetry) {
    if (event.kind !== "new_model_observed" || known.has(event.model)) continue;
    out.set(`${event.providerInstanceId}::${event.model}`, {
      providerInstanceId: event.providerInstanceId,
      model: event.model,
    });
  }
  return [...out.values()];
}

/** Live rules to reassess under a model (and optionally one harness): failures first, then the most model-dependent. */
export function renderReview(
  state: SimState,
  options: {
    readonly policy?: string | undefined;
    readonly harness?: string | undefined;
    readonly page?: number | undefined;
    readonly telemetry?: ReadonlyArray<SimTelemetryEvent>;
  },
): string {
  const last = state.carried_from[state.carried_from.length - 1];
  const policy = options.policy ?? last?.into.policy;
  const harness =
    options.harness ?? (options.policy === undefined ? last?.into.harness : undefined);
  if (!policy)
    throw invalid('name the model to review for: SIM read action "review" with policy <model>');
  const rows: Array<{ rank: number; failed: boolean; id: number; text: string }> = [];
  for (const problem of state.problems) {
    for (const attempt of problem.attempts.filter((item) => item.live)) {
      const here = standing(attempt).filter(
        (obs) => obs.policy === policy && (!harness || effectiveHarness(obs) === harness),
      );
      if (here.some((obs) => obs.result === "kept")) continue;
      const failed = here.filter((obs) => FAILURE_RESULTS.includes(obs.result));
      const confirmed = here.filter((obs) => settlesFix(attempt, obs));
      if (!failed.length && confirmed.length) continue;
      const seen = here.length
        ? tallyText(tally([{ ...attempt, observations: here, live: false }]))
        : "no outcome";
      const rank =
        (failed.length ? 0 : 10) +
        (SIM_DEPENDS.findIndex((item) => attempt.depends_on.includes(item)) + 1 || 9);
      const made = effectiveHarness(attempt);
      const origin =
        attempt.policy === policy ? "made under this model" : `made under ${attempt.policy}`;
      rows.push({
        rank,
        failed: failed.length > 0,
        id: idNumber(attempt.id),
        text: `${attempt.id} ${problem.id} [${attempt.depends_on.join(",")}] ${short(attempt.files[0] ?? "")} "${attempt.anchor}" | ${origin}${made ? ` (${made})` : ""} | under ${policy}${harness ? ` on ${harness}` : ""}: ${seen}`,
      });
    }
  }
  rows.sort((a, b) => a.rank - b.rank || a.id - b.id);
  const failures = rows.filter((row) => row.failed).length;
  const where = `${policy}${harness ? ` on ${harness}` : ""}`;
  const head = [
    `Live rules to reassess under ${where}: ${rows.length} (${failures} with a failure under it, ${rows.length - failures} without a confirmed outcome under it). Failures first, then the rules that depend on the model.`,
  ];
  const fresh = unseenModels(state, options.telemetry ?? []);
  if (fresh.length) {
    head.push(
      `Models seen in T3 runs but not yet in SIM (record a carry when one is a new generation): ${fresh.map((item) => `${item.model} (${item.providerInstanceId})`).join(", ")}`,
    );
  }
  const tail = [
    'For each: read the entry in full, then keep it (observe with result "kept" and the reason), or revise, replace or remove it (attempt).',
    "A rule without an outcome is untested: that is neither evidence for it nor against it.",
  ];
  return paged({
    command: `SIM review ${where}`,
    page: options.page,
    head,
    units: rows.map((row) => row.text),
    tail,
  });
}

/** Tricky cases worth a stronger model's second opinion; undefined when there are none or the advisor is off. */
export function buildAdvisorEscalation(
  state: SimState,
  settings: Pick<SimSettingsConfig, "advisorModelSelection">,
  health: Pick<SimHarnessHealth, "drift">,
  telemetry: ReadonlyArray<SimTelemetryEvent>,
): SimAdvisorEscalation | undefined {
  const modelSelection = settings.advisorModelSelection;
  if (modelSelection === null) return undefined;
  const candidates: Array<SimAdvisorEscalationCandidate> = [];
  for (const problem of state.problems) {
    const liveAttempts = problem.attempts.filter((attempt) => attempt.live);
    const hasFailingLive = liveAttempts.some((attempt) =>
      standing(attempt).some((obs) => FAILURE_RESULTS.includes(obs.result)),
    );
    const failedAttempts = problem.attempts.filter(
      (attempt) =>
        !attempt.retracted && standing(attempt).some((obs) => FAILURE_RESULTS.includes(obs.result)),
    );
    if (failedAttempts.length >= 2 && hasFailingLive) {
      candidates.push({
        kind: "recurring_failures",
        id: problem.id,
        summary: `${problem.id} has ${failedAttempts.length} attempts that failed (${failedAttempts.map((a) => a.id).join(", ")}): ${clip(problem.name, 120)}`,
      });
    }
    const conflicting = liveAttempts.filter((attempt) => {
      const outcomes = standing(attempt);
      const setting = (obs: SimObservation) => `${obs.policy}::${effectiveHarness(obs) ?? ""}`;
      const fixedIn = new Set(outcomes.filter((obs) => obs.result === "fixed").map(setting));
      const failedIn = new Set(
        outcomes.filter((obs) => FAILURE_RESULTS.includes(obs.result)).map(setting),
      );
      return [...fixedIn].some((where) => [...failedIn].some((other) => other !== where));
    });
    const conflictLinks =
      liveAttempts.length > 0 ? problem.related.filter((link) => link.kind === "conflicts") : [];
    if (conflicting.length || conflictLinks.length) {
      const parts = [
        ...(conflicting.length
          ? [
              `fixed under one model or harness and failed under another (${conflicting.map((a) => a.id).join(", ")})`,
            ]
          : []),
        ...(conflictLinks.length
          ? [`conflicts with ${conflictLinks.map((link) => link.id).join(", ")}`]
          : []),
      ];
      candidates.push({
        kind: "cross_harness_conflict",
        id: problem.id,
        summary: `${problem.id}: ${parts.join("; ")}`,
      });
    }
  }
  const hasLiveModelRules = allAttempts(state).some(
    (attempt) => attempt.live && attempt.depends_on.includes("model"),
  );
  if (hasLiveModelRules) {
    for (const item of unseenModels(state, telemetry)) {
      candidates.push({
        kind: "new_model_generation",
        summary: `${item.model} (${item.providerInstanceId}) runs in T3 but has no SIM record or carry yet`,
      });
    }
  }
  const unrecorded = telemetry.filter((event) => event.kind === "unrecorded_harness_edit").length;
  if (health.drift.length + unrecorded >= 2) {
    candidates.push({
      kind: "repeated_drift",
      summary: `${count(health.drift.length, "drifted rule")} and ${count(unrecorded, "unrecorded harness edit")}`,
    });
  }
  if (!candidates.length) return undefined;
  const target = {
    providerInstanceId: modelSelection.instanceId,
    model: modelSelection.model,
    ...(modelSelection.options !== undefined ? { options: modelSelection.options } : {}),
  };
  return {
    modelSelection,
    candidates,
    guidance:
      `These SIM cases are tricky enough for a second opinion. Only on demand, never for routine edits: call delegate_task with role "design" and target ${JSON.stringify(target)}, ` +
      "hand it the entries named here (read them in full first), and ask for a diagnosis and a proposed attempt. Record any resulting change yourself through the SIM tools.",
  };
}

export interface SimReadContext {
  readonly paths: SimResolvedPaths;
  readonly loaded: SimLoaded;
  readonly caller: SimCallerContext;
  readonly settings: Pick<SimSettingsConfig, "advisorModelSelection">;
  readonly telemetry: ReadonlyArray<SimTelemetryEvent>;
  readonly metrics?: ReadonlyArray<SimMetricEvent> | undefined;
  readonly priceOverrides?: Readonly<Record<string, UsageModelPriceOverride>> | undefined;
}

function renderCompactProblemBrief(state: SimState, problem: SimProblem): string {
  const lines = [`${problem.id}: ${problem.name}`];
  const liveAttempts = problem.attempts.filter((attempt) => attempt.live);
  const shownAttempts = liveAttempts.length > 0 ? liveAttempts : problem.attempts.slice(-2);
  for (const attempt of shownAttempts) {
    const activeObs = attempt.observations.filter((obs) => !obs.retracted);
    const testObs = activeObs.filter((obs) => obs.source === "test");
    const nonTestObs = activeObs.filter((obs) => obs.source !== "test");
    const testCounts = new Map<string, number>();
    for (const obs of testObs) {
      testCounts.set(obs.result, (testCounts.get(obs.result) ?? 0) + 1);
    }
    const foldedTest =
      testObs.length > 0
        ? `tests(${[...testCounts.entries()].map(([k, v]) => `${k}:${v}`).join(",")})`
        : "";
    const realCounts = new Map<string, number>();
    for (const obs of nonTestObs) {
      realCounts.set(obs.result, (realCounts.get(obs.result) ?? 0) + 1);
    }
    const foldedReal =
      nonTestObs.length > 0
        ? `live(${[...realCounts.entries()].map(([k, v]) => `${k}:${v}`).join(",")})`
        : "";
    const obsSummary = [foldedReal, foldedTest].filter(Boolean).join(" ") || "untested";
    const status = attempt.live ? "LIVE" : attempt.accepted ? "superseded" : "rejected";
    lines.push(
      `  ${attempt.id} [${status}, ${attempt.policy}, ${attempt.files.join(", ") || "no-file"}]: ${squash(attempt.what).slice(0, 180)} | ${obsSummary}${attempt.missed.length ? ` | missed: ${attempt.missed.join(",")}` : ""}${attempt.pending.length ? ` | open: ${attempt.pending.length}` : ""}`,
    );
  }
  const hiddenCount = problem.attempts.length - shownAttempts.length;
  if (hiddenCount > 0) {
    lines.push(
      `  (+${hiddenCount} earlier attempt(s); use action "show" with ids ["${problem.id}"] for full history)`,
    );
  }
  if (problem.related.length > 0) {
    const rel = problem.related
      .map((entry) => `${entry.kind} ${entry.id}${findProblem(state, entry.id) ? "" : "?"}`)
      .join(", ");
    lines.push(`  links: ${rel}`);
  }
  return lines.join("\n");
}

export function runRead(context: SimReadContext, request: SimReadRequest): SimReadResult {
  const { paths, loaded, caller } = context;
  const { journal, state, healed } = loaded;
  const scope = seenScope(paths, caller);
  const health = inspectHarness(state, paths);
  const head: Array<string> = [];
  if (healed) head.push(HEALED_NOTE);
  head.push(...warnings(state, journal, health));
  const escalation = () =>
    buildAdvisorEscalation(state, context.settings, health, context.telemetry);
  const writable = !journal.broken;

  switch (request.action) {
    case "index": {
      if (!state.problems.length) {
        if (writable) markIndexShown(paths, scope);
        return {
          text: [
            ...head,
            journal.broken
              ? "Nothing can be shown until the journal is restored."
              : "The record is empty.",
            rulesPointer(),
          ].join("\n"),
        };
      }
      head.push(`${count(state.problems.length, "root cause")}: ${INDEX_LEGEND}`);
      const tail = [
        'In full: action "show" with ids. Every entry in brief: action "brief_all". Rules of a file: action "by_file". Search: action "find".',
        rulesPointer(),
      ];
      const text = paged({
        command: "SIM index",
        page: request.page,
        head,
        units: state.problems.map(indexLine),
        tail,
        shown: writable ? () => markIndexShown(paths, scope) : null,
      });
      return { text };
    }
    case "by_file": {
      if (!isText(request.file))
        throw invalid('give the harness file: action "by_file" with file <path>');
      const file = resolveCallerFile(request.file, caller, paths);
      if (writable) markIndexShown(paths, scope, file);
      const rules = renderFile(state, file);
      return {
        text: [
          ...head,
          `${file}: ${count(rules.length, "recorded rule")}. Entry, attempt, and the phrase that identifies the rule:`,
          ...rules,
          rulesPointer(),
        ].join("\n"),
      };
    }
    case "find": {
      if (!isText(request.query))
        throw invalid('give the words to search for: action "find" with query');
      const hits = searchProblems(state, request.query);
      if (!hits.length) return { text: `no entry contains: ${request.query}` };
      return {
        text: paged({
          command: `SIM find ${request.query}`,
          page: request.page,
          units: hits.map(indexLine),
        }),
      };
    }
    case "show":
    case "brief_all": {
      const all = request.action === "brief_all" || !request.ids?.length;
      const brief = request.action === "brief_all" || request.brief === true;
      let selected: Array<SimProblem> = state.problems;
      if (!all) {
        selected = [];
        const missing: Array<string> = [];
        for (const raw of request.ids ?? []) {
          const id = raw.trim();
          const problem = id.startsWith("A")
            ? findAttempt(state, id)?.problem
            : findProblem(state, id);
          if (!problem) missing.push(id);
          else if (!selected.includes(problem)) selected.push(problem);
        }
        if (missing.length) throw fail("not_found", `not in the record: ${missing.join(", ")}`);
      }
      if (all && state.carried_from.length) head.push(renderCarried(state));
      const units = selected.map((problem) =>
        brief ? renderBrief(state, problem) : renderProblem(state, problem),
      );
      const command = `SIM show ${all ? "all" : (request.ids ?? []).join(" ")}${brief ? " brief" : ""}`;
      const text = paged({
        command,
        page: request.page,
        head,
        units,
        separator: "\n\n",
        tail: [rulesPointer()],
        shown: writable
          ? (parts) =>
              markShown(
                paths,
                state,
                parts.map(({ index, from, to, of }) => ({
                  problem: selected[index]!,
                  from,
                  to,
                  of,
                })),
                brief ? "brief" : "full",
                scope,
              )
          : null,
      });
      return { text };
    }
    case "brief": {
      const maxTokens = Math.max(250, Math.min(request.maxTokens ?? 2_000, 8_000));
      const maxChars = maxTokens * 4;
      let selected: Array<SimProblem> = state.problems;
      if (request.ids?.length) {
        selected = [];
        for (const raw of request.ids) {
          const id = raw.trim();
          const problem = id.startsWith("A")
            ? findAttempt(state, id)?.problem
            : findProblem(state, id);
          if (problem && !selected.includes(problem)) selected.push(problem);
        }
      } else if (isText(request.file)) {
        const canonical = resolveCallerFile(request.file, caller, paths);
        selected = state.problems.filter((problem) =>
          problem.attempts.some((attempt) => attempt.files.includes(canonical)),
        );
      } else if (isText(request.query)) {
        selected = searchProblems(state, request.query);
      }
      if (selected.length === 0) {
        return { text: "SIM compact brief: no matching entries." };
      }
      const chunks: Array<string> = [
        ...head,
        `SIM Compact Brief (${selected.length} root cause(s), budget <= ${maxTokens} tokens; test observations folded):`,
      ];
      let used = chunks.join("\n").length;
      let omitted = 0;
      for (const problem of selected) {
        const block = renderCompactProblemBrief(state, problem);
        if (used + block.length + 2 > maxChars) {
          omitted += 1;
          continue;
        }
        chunks.push(block);
        used += block.length + 2;
      }
      if (omitted > 0) {
        chunks.push(
          `… (${omitted} more root cause(s) omitted to stay within ${maxTokens}-token budget)`,
        );
      }
      return { text: chunks.join("\n\n") };
    }
    case "metrics": {
      const buckets = summarizeMetricsMatrix(context.metrics ?? []);
      return { text: renderMetricsMatrixText(buckets) };
    }
    case "roi": {
      const summary = summarizeRuleRoi(context.metrics ?? [], {
        priceOverrides: context.priceOverrides,
      });
      return { text: renderRuleRoiText(summary) };
    }
    case "check":
      return renderCheck(paths, loaded, health, request.page);
    case "review":
      return {
        text: renderReview(state, {
          policy: request.policy,
          harness: request.harness,
          page: request.page,
          telemetry: context.telemetry,
        }),
        advisorEscalation: escalation(),
      };
  }
}

function renderCheck(
  paths: SimResolvedPaths,
  loaded: SimLoaded,
  health: SimHarnessHealth,
  page?: number,
) {
  const { journal, state, healed } = loaded;
  const errors: Array<string> = [];
  const notes: Array<string> = [];
  if (journal.broken) errors.push(brokenHelp(journal.broken));
  if (healed) notes.push(HEALED_NOTE);
  const { drift, uncovered, unchecked } = health;
  for (const item of drift) {
    const hit = findAttempt(state, item.attempt.id);
    errors.push(`DRIFT ${item.attempt.id} (${hit?.problem.id ?? "?"}): ${item.reason}`);
  }
  if (drift.length) {
    notes.push(
      "DRIFT: a recorded rule changed without a record. If only the wording moved, amend its anchor; else record an attempt that revises, replaces or removes it.",
    );
  }
  for (const unit of uncovered) {
    errors.push(
      `NO RECORD ${unit.file}: ${unit.text === null ? "hook" : `"${squash(unit.text).slice(0, 90)}"`}`,
    );
  }
  if (uncovered.length) {
    notes.push(
      "NO RECORD: a Scar, Win or hook has no live record. Record it as an attempt (backfilled, with the session that made it if you know it).",
    );
  }
  if (unchecked.length) {
    notes.push(
      `not checked (file not on this machine): ${unchecked.map((attempt) => attempt.id).join(", ")}`,
    );
  }
  for (const [session, events] of journal.broken ? [] : strangers(journal, paths)) {
    const who =
      session === SIM_UNKNOWN
        ? "a session without an id"
        : session.startsWith("cc:")
          ? `${session}, a session without a transcript on this machine`
          : `${session}, a session this tool cannot look up`;
    notes.push(
      `note: ${count(events.length, "journal event")} of the last ${SEEN_DAYS} days (${events[0]} to ${events[events.length - 1]}) came from ${who}. Session ids are taken on trust: check that these events are genuine.`,
    );
  }
  const index = estimateTokens(renderIndex(state));
  const full = estimateTokens(
    state.problems.map((problem) => renderProblem(state, problem)).join("\n\n"),
  );
  notes.push(
    `size: index about ${index} tokens (budget ${SIM_INDEX_BUDGET}), everything about ${full} tokens (budget ${SIM_FULL_BUDGET})`,
  );
  if (index > SIM_INDEX_BUDGET) {
    notes.push(
      `The index is over its budget: every harness change now reads about ${index} tokens. The budget is the user's to raise; entries are never dropped or lumped to meet it.`,
    );
  }
  if (full > SIM_FULL_BUDGET) {
    notes.push(
      "Everything in full is over its budget: at a model change, go entry by entry from review instead of reading every entry in full in a small context.",
    );
  }
  const live = allAttempts(state).filter((attempt) => attempt.live).length;
  notes.push(
    `${count(state.problems.length, "root cause")}, ${count(allAttempts(state).length, "attempt")}, ${live} live, ${count(journal.events.length, "journal event")}`,
  );
  const failed = errors.length > 0;
  const tail = [...notes, failed ? `${count(errors.length, "problem")} found.` : "ok"];
  return {
    text: paged({
      command: "SIM check",
      page,
      units: errors,
      tail,
      size: failed ? FAIL_CHARS : SIM_DEFAULT_PAGE_CHARS,
    }),
    failed,
  };
}

const eventStamp = (caller: SimCallerContext, harness?: string | undefined): SimEventStamp => ({
  by: isText(caller.sessionId) ? caller.sessionId : SIM_UNKNOWN,
  ...(caller.alsoSessionId && caller.alsoSessionId !== caller.sessionId
    ? { also: caller.alsoSessionId }
    : {}),
  ...(harness ? { harness } : {}),
});

const callerHarness = (caller: SimCallerContext) => caller.driver ?? caller.providerInstanceId;

/** Fill what the server knows about the caller into an attempt the caller left open. */
function resolveAttemptDefaults(
  input: SimAttemptInput,
  caller: SimCallerContext,
  paths: SimResolvedPaths,
): SimAttemptInput {
  const files = input.files?.map((file) => resolveCallerFile(file, caller, paths));
  const global = files?.length && files.every((file) => file.startsWith("~/.claude/"));
  const policy = input.policy ?? caller.model;
  const harness = input.harness ?? callerHarness(caller);
  const domain = input.domain ?? (global ? "global" : (caller.projectName ?? "global"));
  return {
    ...input,
    ...(files ? { files } : {}),
    ...(policy ? { policy } : {}),
    ...(harness ? { harness } : {}),
    domain,
  };
}

/** `~/.claude/` names the configured harness dir, as in the record; other `~/` paths the home dir. */
function expandCallerPath(file: string, paths: SimResolvedPaths): string {
  const trimmed = file.trim();
  return trimmed.startsWith("~/.claude/")
    ? expandHarnessFile(trimmed, paths)
    : expandHomeString(trimmed, paths.homeDir);
}

/** A path as the caller wrote it, resolved against its workspace, in the record's spelling. */
export function resolveCallerFile(
  file: string,
  caller: SimCallerContext,
  paths: SimResolvedPaths,
): string {
  const trimmed = file.trim();
  if (
    trimmed.startsWith("~/") ||
    NodePath.isAbsolute(trimmed) ||
    /^\$(?:HOME|\{HOME\})\//.test(trimmed)
  ) {
    return canonicalFile(trimmed, paths);
  }
  return canonicalFile(NodePath.resolve(caller.workspaceRoot ?? paths.homeDir, trimmed), paths);
}

const ATTEMPT_INPUT_KEYS = [
  "problem",
  "new",
  "action",
  "what",
  "why",
  "files",
  "anchor",
  "supersedes",
  "depends_on",
  "predicted",
  "expect",
  "policy",
  "domain",
  "accepted",
  "rejected_because",
  "unanswered",
  "backfilled",
  "round",
  "sample",
] as const;

/** The journal data of an attempt: never `harness`, which travels on the envelope. */
function attemptData(input: SimAttemptInput): Data {
  const data: Data = {};
  for (const key of ATTEMPT_INPUT_KEYS) {
    const value = input[key];
    if (value === undefined) continue;
    data[key] = Array.isArray(value)
      ? value.map((item) => (typeof item === "string" ? item.trim() : item))
      : value;
  }
  if (isText(data.problem)) data.problem = data.problem.trim();
  return data;
}

/**
 * Anchor checks right after the edit: the anchor must identify exactly one place, and the file that
 * holds it moves first. `overrides` stands in for files whose new content is not on disk yet.
 */
function checkAgainstFiles(
  input: Data,
  paths: SimResolvedPaths,
  overrides?: ReadonlyMap<string, string>,
) {
  const findings: Array<string> = [];
  if (
    input.accepted !== false &&
    input.action !== "remove" &&
    isText(input.anchor) &&
    Array.isArray(input.files) &&
    input.files.every((file) => isText(file)) &&
    input.files.length
  ) {
    const anchor = input.anchor;
    const files = (input.files as Array<string>).map((file) => canonicalFile(file, paths));
    const hits = files.map((file) => {
      const text = readHarnessFile(file, paths, overrides);
      return text === null ? 0 : occurrences(text, anchor);
    });
    const holders = files.filter((_, index) => (hits[index] ?? 0) > 0);
    const first = holders[0];
    if (!first) {
      findings.push(
        `the anchor is in none of ${files.join(", ")}; make the change first, and quote a phrase of the rule exactly`,
      );
    } else if (holders.length > 1 || (hits[files.indexOf(first)] ?? 0) > 1) {
      findings.push(
        `the anchor occurs more than once in ${holders.join(", ")}; quote a longer phrase that occurs once`,
      );
    } else {
      input.files = [first, ...files.filter((file) => file !== first)];
    }
  }
  if (findings.length && input.backfilled !== true) throw invalid(findings);
  return findings;
}

interface PreparedAttempt {
  readonly data: Data;
  readonly harness: string | undefined;
  readonly findings: ReadonlyArray<string>;
  readonly target: SimProblem | null;
}

/** Everything sim.mjs checks before it appends an attempt, in its order: fields, today, twin, files, reading. */
function prepareAttempt(
  paths: SimResolvedPaths,
  loaded: SimLoaded,
  caller: SimCallerContext,
  rawInput: SimAttemptInput,
  overrides?: ReadonlyMap<string, string>,
): PreparedAttempt {
  const { state, journal } = loaded;
  if (journal.broken) throw fail("journal_broken", brokenHelp(journal.broken));
  const input = resolveAttemptDefaults(rawInput, caller, paths);
  const data = attemptData(input);
  const stampCtx = eventStamp(caller, input.harness);
  applyEvent(
    structuredClone(state),
    {
      seq: state.events + 1,
      v: SIM_FORMAT,
      day: today(),
      by: stampCtx.by,
      op: "attempt",
      data: { ...data, considered: [] },
    },
    paths,
  );
  const me = [caller.sessionId, caller.alsoSessionId]
    .filter((id): id is string => isText(id))
    .map(bare);
  if (
    data.backfilled === true &&
    data.round === today() &&
    (!isText(data.sample) || me.includes(bare(data.sample.trim())))
  ) {
    throw invalid(
      'a change made today is recorded as it is, not as an old one: leave out "backfilled", "round" and "sample", and give "expect". Only when another session made it and left no record: name that session in "sample".',
    );
  }
  const target = isText(data.problem)
    ? findProblem(state, data.problem)
    : isText(data.new)
      ? problemNamed(state, data.new)
      : null;
  const same = (a: unknown, b: unknown) => squash(a) === squash(b);
  const twin = target?.attempts.find(
    (item) =>
      !item.retracted &&
      item.action === data.action &&
      item.accepted === (data.accepted !== false) &&
      same(item.what, data.what) &&
      same(item.why, data.why),
  );
  if (twin) {
    const outcome = twin.live ? ` An outcome of it goes to: observe ${twin.id}.` : "";
    throw invalid(
      `this change is already in the record as ${twin.id}: same entry, action, "what" and "why".${outcome} A change that is repeated on new evidence names that evidence in "why".`,
    );
  }
  const findings = checkAgainstFiles(data, paths, overrides);
  const scope = seenScope(paths, caller);
  data.considered = requireReading(state, shownTo(paths, state, scope), data);
  if (data.backfilled !== true) {
    requireIndexConsulted(
      paths,
      scope,
      Array.isArray(data.files) ? (data.files as Array<string>) : [],
    );
  }
  return { data, harness: input.harness, findings, target };
}

function appendAttempt(
  paths: SimResolvedPaths,
  caller: SimCallerContext,
  prepared: PreparedAttempt,
  state: SimState,
) {
  const scope = seenScope(paths, caller);
  const before = shownTo(paths, state, scope);
  const done = append(paths, "attempt", prepared.data, eventStamp(caller, prepared.harness));
  keepShown(
    paths,
    before,
    done.state,
    scope,
    done.outcome.created ? (done.outcome.problem ?? null) : null,
  );
  return done;
}

function attemptReply(prepared: PreparedAttempt, done: ReturnType<typeof append>): SimWriteResult {
  const { outcome, state } = done;
  const place = outcome.created ? `new entry ${outcome.problem}` : `entry ${outcome.problem}`;
  const joined =
    !outcome.created && prepared.data.new
      ? " (an entry with this root cause existed; the attempt was added to it)"
      : "";
  const out = [`recorded ${outcome.attempt} in ${place}${joined}.`];
  if (prepared.data.accepted !== false) {
    out.push(`When you see how it performs: observe ${outcome.attempt}`);
    const gone = (findProblem(state, outcome.problem)?.attempts ?? []).filter(
      (item) =>
        item.id !== outcome.attempt &&
        !item.retracted &&
        (!item.accepted || item.action === "remove"),
    );
    if (prepared.data.action !== "remove" && gone.length) {
      out.push(
        `note: this entry holds ${count(gone.length, "change")} that ${gone.length === 1 ? "was" : "were"} removed or not carried out (${gone.map((item) => item.id).join(", ")}). If yours repeats one of them, its "why" must name the new evidence; correct it with amend ${outcome.attempt} why`,
      );
    }
  }
  for (const finding of prepared.findings) {
    out.push(`note: ${finding} (fine if a later change replaced it; record that change next)`);
  }
  return { text: out.join("\n"), problemId: outcome.problem, attemptId: outcome.attempt };
}

/** A statement about entries (merge, link, amend, retract) is taken only from a session shown them. */
function writeShown(
  paths: SimResolvedPaths,
  loaded: SimLoaded,
  caller: SimCallerContext,
  op: SimJournalOp,
  data: Data,
  needOf: (state: SimState) => Array<[SimProblem | null, "full" | "brief", string]>,
  textOf: (state: SimState) => string | null = () => null,
  check: ((state: SimState) => void) | null = null,
) {
  const { state, journal } = loaded;
  if (journal.broken) throw fail("journal_broken", brokenHelp(journal.broken));
  const stampCtx = eventStamp(caller);
  applyEvent(
    structuredClone(state),
    { seq: state.events + 1, v: SIM_FORMAT, day: today(), by: stampCtx.by, op, data },
    paths,
  );
  check?.(state);
  const scope = seenScope(paths, caller);
  const before = shownTo(paths, state, scope);
  const need: Need = new Map();
  for (const [problem, level, why] of needOf(state))
    if (problem) need.set(problem.id, [level, why]);
  demandShown(state, before, need, textOf(state));
  const done = append(paths, op, data, stampCtx);
  keepShown(paths, before, done.state, scope);
  return done;
}

function keepsWords(name: string, wordings: ReadonlyArray<string>) {
  const now = words(name);
  return wordings.every((wording) => {
    const was = [...words(wording)];
    return was.length > 0 && was.filter((word) => now.has(word)).length * 2 >= was.length;
  });
}

function wordingsOf(problem: SimProblem) {
  const chain = [
    ...(problem.amended ?? [])
      .filter((change) => change.field === "name")
      .map((change) => String(change.was)),
    problem.name,
  ];
  let base = 0;
  for (let i = 1; i < chain.length; i += 1)
    if (!keepsWords(chain[i]!, chain.slice(base, i))) base = i;
  return chain.slice(base);
}

const entryOf =
  (attemptId: string) =>
  (state: SimState): Array<[SimProblem | null, "full" | "brief", string]> => [
    [findAttempt(state, attemptId)?.problem ?? null, "full", "it holds the record you correct"],
  ];

/** Run one write; the caller holds sim.lock. */
export function runWrite(
  paths: SimResolvedPaths,
  caller: SimCallerContext,
  request: SimWriteRequest,
): SimWriteResult {
  const loaded = load(paths);
  switch (request.action) {
    case "attempt": {
      const prepared = prepareAttempt(paths, loaded, caller, request.input);
      return attemptReply(prepared, appendAttempt(paths, caller, prepared, loaded.state));
    }
    case "observe":
      return observe(paths, loaded, caller, request.input);
    case "merge": {
      const { from, into } = request;
      const { outcome } = writeShown(paths, loaded, caller, "merge", { from, into }, (state) => [
        [findProblem(state, from), "full", "you merge it away"],
        [findProblem(state, into), "full", "you merge into it"],
      ]);
      return {
        text: `merged ${outcome.merged} into ${outcome.problem}; all attempts are kept, and ${outcome.merged} still resolves.`,
        problemId: outcome.problem,
      };
    }
    case "link": {
      const { a, b, kind } = request;
      writeShown(paths, loaded, caller, "link", { a, b, kind }, (state) =>
        [a, b].map((id) => [findProblem(state, id), "brief", "you link it"]),
      );
      return { text: `linked: ${a} ${kind} ${b}.` };
    }
    case "carry": {
      if (loaded.journal.broken) throw fail("journal_broken", brokenHelp(loaded.journal.broken));
      const side = (policy?: string, domain?: string, harness?: string) => ({
        ...(policy ? { policy } : {}),
        ...(domain ? { domain } : {}),
        ...(harness ? { harness } : {}),
      });
      append(
        paths,
        "carry",
        {
          date: request.date ?? today(),
          from: side(request.fromPolicy, request.fromDomain, request.fromHarness),
          into: side(request.toPolicy, request.toDomain, request.toHarness),
          ...(request.note ? { note: request.note } : {}),
        },
        eventStamp(caller),
      );
      return {
        text: 'recorded the change of setting. List what to reassess with the SIM "review" read.',
      };
    }
    case "retract": {
      const { attempt, outcome, reason, undo } = request;
      writeShown(
        paths,
        loaded,
        caller,
        "retract",
        {
          attempt,
          ...(outcome === undefined ? {} : { outcome }),
          reason,
          ...(undo ? { undo } : {}),
        },
        entryOf(attempt),
      );
      const what = outcome === undefined ? attempt : `outcome ${outcome} of ${attempt}`;
      return {
        text: undo
          ? `${what} counts again.`
          : `retracted ${what}; it stays in the record and no longer counts.`,
        attemptId: attempt,
      };
    }
    case "amend": {
      const { target, field, reason } = request;
      const value: unknown = Array.isArray(request.value) ? [...request.value] : request.value;
      const data: Data = { target, field, value, reason };
      const check = (state: SimState) => {
        const hit = field === "anchor" || field === "files" ? findAttempt(state, target) : null;
        if (!hit?.attempt.live) return;
        const files =
          field === "files" && Array.isArray(value)
            ? value.map((file) => resolveCallerFile(String(file), caller, paths))
            : hit.attempt.files;
        const probe: Data = {
          action: hit.attempt.action,
          anchor: field === "anchor" ? value : hit.attempt.anchor,
          files,
        };
        checkAgainstFiles(probe, paths);
        if (field === "files") data.value = probe.files;
      };
      const renames = isText(target) && target.startsWith("P");
      const twinOf = (state: SimState) =>
        problemNamed(state, value, findProblem(state, target)?.id ?? null);
      const needOf = renames
        ? (state: SimState): Array<[SimProblem | null, "full" | "brief", string]> => [
            [findProblem(state, target), "full", "you rename it"],
            ...(twinOf(state)
              ? [
                  [twinOf(state), "full", "it has this root cause already"] as [
                    SimProblem | null,
                    "full",
                    string,
                  ],
                ]
              : []),
          ]
        : entryOf(target);
      const textOf = (state: SimState) => {
        const problem = findProblem(state, target);
        return !renames ||
          !problem ||
          twinOf(state) ||
          keepsWords(String(value), wordingsOf(problem))
          ? null
          : String(value);
      };
      const { outcome } = writeShown(paths, loaded, caller, "amend", data, needOf, textOf, check);
      return {
        text: outcome.merged
          ? `amended; ${outcome.merged} now has the same root cause as ${outcome.problem} and was merged into it.`
          : `amended ${target}.`,
        ...(outcome.problem ? { problemId: outcome.problem } : {}),
      };
    }
  }
}

function observe(
  paths: SimResolvedPaths,
  loaded: SimLoaded,
  caller: SimCallerContext,
  input: SimObserveInput,
): SimWriteResult {
  const { state, journal } = loaded;
  if (journal.broken) throw fail("journal_broken", brokenHelp(journal.broken));
  const attemptId = input.attempt.trim();
  const hit = findAttempt(state, attemptId);
  // A fork-family "fixed" report is coerced to "self" so that sim.mjs, which knows nothing of forks, refuses it too.
  const selfGradeReason =
    input.result === "fixed"
      ? (input.selfGradeReason ??
        (hit && sharesFamily(hit.attempt, caller.forkFamilySessionIds ?? [])
          ? FORK_FAMILY_REASON
          : undefined))
      : undefined;
  const harness = input.harness ?? callerHarness(caller);
  const policy = input.policy ?? caller.model;
  const domain = input.domain ?? hit?.attempt.domain;
  const observation: Data = {
    ...(input.target !== undefined ? { target: input.target } : {}),
    result: input.result,
    evidence: input.evidence,
    source: selfGradeReason ? "self" : input.source,
    ...(policy !== undefined ? { policy } : {}),
    ...(domain !== undefined ? { domain } : {}),
    ...(input.date !== undefined ? { date: input.date } : {}),
  };
  const scope = seenScope(paths, caller);
  const before = shownTo(paths, state, scope);
  const done = append(
    paths,
    "observe",
    { attempt: attemptId, observation },
    eventStamp(caller, harness),
  );
  keepShown(paths, before, done.state, scope);
  const record = findAttempt(done.state, done.outcome.attempt)!.attempt;
  const last = record.observations[record.observations.length - 1]!;
  const own = last.result === "fixed" ? (selfGradeReason ?? ownReport(record, last)) : null;
  const note = own
    ? `\nnote: this report does not settle the prediction (${own}). A change is not judged by the session that made or recorded it, nor by its forks; an outcome from another session settles it.`
    : "";
  return {
    text: `recorded for ${done.outcome.attempt} in ${done.outcome.problem}: fixed ${record.fixed.length}, missed ${record.missed.length}, open ${record.pending.length}.${note}`,
    ...(done.outcome.problem ? { problemId: done.outcome.problem } : {}),
    attemptId: done.outcome.attempt,
    settled: last.result === "fixed" && !own,
    ...(own ? { unconfirmedReason: own } : {}),
  };
}

function diffPreview(before: string, after: string): string {
  const a = before.split("\n");
  const b = after.split("\n");
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start += 1;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA -= 1;
    endB -= 1;
  }
  return clip(
    [
      `@@ line ${start + 1} @@`,
      ...a.slice(start, endA).map((line) => `-${line}`),
      ...b.slice(start, endB).map((line) => `+${line}`),
    ].join("\n"),
    4000,
  );
}

function proposedContent(request: SimApplyHarnessChangeRequest, current: string | null): string {
  if (request.oldText !== undefined || request.newText !== undefined) {
    if (request.oldText === undefined || request.newText === undefined) {
      throw invalid("give both oldText and newText for a replacement");
    }
    if (current === null) throw invalid("the file does not exist; create it with content instead");
    if (!request.oldText) throw invalid("oldText must not be empty");
    const hits = current.split(request.oldText).length - 1;
    if (hits !== 1) {
      throw invalid(`oldText occurs ${hits} times in the file; it must occur exactly once`);
    }
    return current.replace(request.oldText, () => request.newText!);
  }
  if (request.content === undefined)
    throw invalid("give oldText and newText, or content (with append: true to add)");
  if (request.append === true) {
    const base = current ?? "";
    return base && !base.endsWith("\n")
      ? `${base}\n${request.content}`
      : `${base}${request.content}`;
  }
  return request.content;
}

export interface SimHarnessChangeOutcome {
  readonly result: SimApplyHarnessChangeResult;
  /** Files of the recorded attempt, in the record's spelling; empty for a dry run. */
  readonly recordedFiles: ReadonlyArray<string>;
}

/** Edit a harness file and record the attempt as one step; the caller holds sim.lock for a live apply. */
export function runApplyHarnessChange(
  paths: SimResolvedPaths,
  caller: SimCallerContext,
  request: SimApplyHarnessChangeRequest,
  options: { readonly classify: (absolute: string) => "record" | "harness" | null },
): SimHarnessChangeOutcome {
  const absolute = NodePath.resolve(
    caller.workspaceRoot ?? paths.homeDir,
    expandCallerPath(request.file, paths),
  );
  const kind = options.classify(absolute);
  if (kind === "record") {
    throw fail(
      "forbidden_path",
      `${request.file} is part of the SIM record; it changes only through the SIM tools`,
    );
  }
  if (kind !== "harness") {
    throw fail(
      "forbidden_path",
      `${request.file} is not an agent harness file; edit it with your normal tools`,
    );
  }
  const inHarnessDir =
    isPathWithinRoot(absolute, paths.harnessDir, undefined, paths.homeDir) ||
    (NodeFS.existsSync(absolute) &&
      isPathWithinRoot(NodePath.dirname(absolute), paths.harnessDir, undefined, paths.homeDir));
  const inWorkspace =
    isText(caller.workspaceRoot) &&
    isPathWithinRoot(absolute, caller.workspaceRoot, undefined, paths.homeDir);
  if (!inHarnessDir && !inWorkspace) {
    throw fail(
      "forbidden_path",
      `${request.file} lies outside the configured harness directory and this thread's workspace`,
    );
  }
  const file = canonicalFile(absolute, paths);
  const loaded = request.dryRun === true ? loadReadOnly(paths) : load(paths);
  if (loaded.journal.broken) throw fail("journal_broken", brokenHelp(loaded.journal.broken));
  if (request.attempt.backfilled === true) {
    throw invalid("a change made now is recorded as it is: leave out backfilled, round and sample");
  }
  const health = inspectHarness(loaded.state, paths);
  const supersedes = new Set((request.attempt.supersedes ?? []).map((id) => id.trim()));
  const drifted = health.drift.filter(
    (item) => item.attempt.files[0] === file && !supersedes.has(item.attempt.id),
  );
  if (drifted.length) {
    throw fail("drift", [
      ...drifted.map((item) => `DRIFT ${item.attempt.id}: ${item.reason}`),
      "Reconcile first: amend the anchor if only the wording moved, or name the drifted attempt in supersedes.",
    ]);
  }
  const attemptFiles = (request.attempt.files ?? []).map((item) =>
    resolveCallerFile(item, caller, paths),
  );
  const files = [file, ...attemptFiles.filter((item) => item !== file)];
  let writeTarget = absolute;
  let originalMode: number | undefined;
  let current: string | null = null;
  let existed = false;
  try {
    writeTarget = NodeFS.realpathSync(absolute);
    const stat = NodeFS.statSync(writeTarget);
    originalMode = stat.mode & 0o7777;
    current = NodeFS.readFileSync(writeTarget, "utf8");
    existed = true;
  } catch {
    writeTarget = absolute;
    current = null;
  }
  const next = proposedContent(request, current);
  if (next === current) throw invalid("the change leaves the file as it is");
  const overrides = new Map([[file, next]]);
  const prepared = prepareAttempt(paths, loaded, caller, { ...request.attempt, files }, overrides);
  const target = prepared.target;
  const predicted = Array.isArray(prepared.data.predicted)
    ? (prepared.data.predicted as Array<string>)
    : [];
  const predictionLine = `predicted to fix: ${predicted.join(", ") || "nothing"}${isText(prepared.data.expect) ? `; expect: ${prepared.data.expect}` : ""}`;
  const preview = diffPreview(current ?? "", next);
  if (request.dryRun === true) {
    return {
      result: {
        dryRun: true,
        file,
        ...(target ? { brief: renderBrief(loaded.state, target), problemId: target.id } : {}),
        predictionLine,
        diffPreview: preview,
        text: [
          `dry run: nothing written. ${file} would change and the attempt would be recorded${target ? ` under ${target.id}` : " as a new entry"}.`,
          predictionLine,
          preview,
        ].join("\n"),
      },
      recordedFiles: [],
    };
  }
  const original = existed ? NodeFS.readFileSync(writeTarget) : null;
  NodeFS.mkdirSync(NodePath.dirname(writeTarget), { recursive: true });
  writeWhole(writeTarget, next, { mode: originalMode });
  let done: ReturnType<typeof append>;
  try {
    // On disk now: the anchor must hold there, not only in the proposal.
    checkAgainstFiles(prepared.data, paths);
    done = appendAttempt(paths, caller, prepared, loaded.state);
  } catch (error) {
    // Once the journal holds the attempt, the edit is recorded: keep it even if a later step (sim.json, backup) failed.
    if (readJournal(paths.journalPath).events.length <= loaded.journal.events.length) {
      if (original !== null) writeWhole(writeTarget, original, { mode: originalMode });
      else NodeFS.rmSync(writeTarget, { force: true });
    }
    throw error;
  }
  const reply = attemptReply(prepared, done);
  return {
    result: {
      dryRun: false,
      file,
      text: `${file} changed.\n${reply.text}`,
      predictionLine,
      diffPreview: preview,
      ...(reply.problemId ? { problemId: reply.problemId } : {}),
      ...(reply.attemptId ? { attemptId: reply.attemptId } : {}),
    },
    recordedFiles: Array.isArray(prepared.data.files)
      ? (prepared.data.files as Array<string>)
      : [file],
  };
}

/** Sessions that made or recorded an attempt, as the record names them. */
export function attemptAuthorSessions(state: SimState, attemptId: string): Array<string> {
  const hit = findAttempt(state, attemptId);
  if (!hit) return [];
  return [...new Set([hit.attempt.by, hit.attempt.also, hit.attempt.sample])].filter(
    (id): id is string => !!id && id !== SIM_UNKNOWN,
  );
}
