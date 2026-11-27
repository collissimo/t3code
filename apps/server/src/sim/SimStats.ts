import {
  SIM_UNKNOWN,
  type SimAttempt,
  type SimObservation,
  type SimProblem,
  type SimResult,
  type SimState,
} from "./SimContracts.ts";

// Pure: derives search hits and scorecard numbers from a SimState. No file I/O.

const DAY_MS = 86_400_000;
const DEFAULT_STALE_DAYS = 14;
const DEFAULT_SEARCH_LIMIT = 20;
const UNSPECIFIED = "unspecified";
const FILTER = /^(status|file|model|harness):(.+)$/i;
const FAILED: ReadonlySet<SimResult> = new Set(["missed", "regressed", "misfired"]);

// ── Stemming and tokens ──────────────────────────────────────────────

const VOWEL = /[aeiou]/;
const DOUBLED_CONSONANT = /([^aeiouslz])\1$/;

/** Porter's measure: the number of vowel-consonant pairs in a stem. */
const measure = (stem: string) =>
  (
    stem
      .replace(/[^aeiou]+/g, "C")
      .replace(/[aeiou]+/g, "V")
      .match(/VC/g) ?? []
  ).length;

function stripOnce(word: string): string {
  if (word.length >= 6 && word.endsWith("ing") && VOWEL.test(word.slice(0, -3))) {
    const base = word.slice(0, -3);
    return DOUBLED_CONSONANT.test(base) ? base.slice(0, -1) : base;
  }
  if (word.length >= 5 && word.endsWith("ed") && VOWEL.test(word.slice(0, -2))) {
    return word.slice(0, -2);
  }
  if (word.length >= 4 && word.endsWith("s") && !word.endsWith("ss")) return word.slice(0, -1);
  if (word.length >= 4 && word.endsWith("e") && measure(word.slice(0, -1)) > 1) {
    return word.slice(0, -1);
  }
  return word;
}

/** Strips common English inflections until nothing changes, so "files", "file" and "misfires" meet. */
export function stemSearchToken(token: string): string {
  let word = token.toLowerCase();
  let next = stripOnce(word);
  while (next !== word) {
    word = next;
    next = stripOnce(word);
  }
  return word;
}

const tokenize = (text: string) =>
  text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((token) => token.length > 0);

const bare = (id: string) => id.replace(/^(cc|t3):/, "");
const known = (id: string | undefined): id is string => !!id && id !== SIM_UNKNOWN;
const sameSession = (a: string, b: string) => a === b || bare(a) === bare(b);

/** The harness a record was made under; Claude Code records written by sim.mjs carry none. */
const effectiveHarness = (record: { readonly harness?: string | undefined; readonly by: string }) =>
  record.harness ?? (record.by.startsWith("cc:") ? "claudeAgent" : undefined);

// ── Shared views ─────────────────────────────────────────────────────

interface Pair {
  readonly problem: SimProblem;
  readonly attempt: SimAttempt;
}

const standing = (attempt: SimAttempt) => attempt.observations.filter((obs) => !obs.retracted);

const pairsOf = (problem: SimProblem): Array<Pair> =>
  problem.attempts.filter((attempt) => !attempt.retracted).map((attempt) => ({ problem, attempt }));

/** A fix only counts as settled when someone other than the changing session reported it. */
function selfGraded(attempt: SimAttempt, obs: SimObservation): boolean {
  if (obs.source === "self" || obs.by === SIM_UNKNOWN) return true;
  const reporters = [obs.by, obs.also].filter(known);
  const authors = [attempt.by, attempt.also].filter(known);
  if (reporters.some((r) => authors.some((a) => sameSession(r, a)))) return true;
  if (known(attempt.sample) && reporters.some((r) => sameSession(r, attempt.sample))) return true;
  return attempt.by === SIM_UNKNOWN;
}

// ── Search ───────────────────────────────────────────────────────────

export interface SimSearchHit {
  readonly problem: SimProblem;
  readonly score: number;
  readonly matchedBy: "exact" | "stemmed" | "filter";
}

export interface SimSearchOptions {
  readonly limit?: number;
}

type FilterKey = "status" | "file" | "model" | "harness";

interface SimSearchFilter {
  readonly key: FilterKey;
  readonly value: string;
}

function parseQuery(query: string): { words: Array<string>; filters: Array<SimSearchFilter> } {
  const words: Array<string> = [];
  const filters: Array<SimSearchFilter> = [];
  for (const part of query.trim().split(/\s+/).filter(Boolean)) {
    const match = FILTER.exec(part);
    const key = match?.[1]?.toLowerCase();
    const value = match?.[2]?.toLowerCase();
    if (key && value) filters.push({ key: key as FilterKey, value });
    else words.push(...tokenize(part));
  }
  return { words, filters };
}

function filterMatches(filter: SimSearchFilter, pairs: ReadonlyArray<Pair>): boolean {
  return pairs.some(({ attempt }) => {
    switch (filter.key) {
      case "status":
        return filter.value === "open"
          ? attempt.accepted && attempt.live && attempt.pending.length > 0
          : standing(attempt).some((obs) => obs.result === filter.value);
      case "file":
        return attempt.files.some((file) => file.toLowerCase().includes(filter.value));
      case "model":
        return [attempt.policy, ...standing(attempt).map((obs) => obs.policy)].some(
          (policy) => policy.toLowerCase() === filter.value,
        );
      case "harness":
        return [attempt, ...standing(attempt)].some(
          (record) => effectiveHarness(record)?.toLowerCase() === filter.value,
        );
    }
  });
}

function searchableText(problem: SimProblem, pairs: ReadonlyArray<Pair>): string {
  return [
    problem.name,
    ...problem.former_names,
    ...pairs.flatMap(({ attempt }) => [
      attempt.what,
      attempt.why,
      attempt.anchor ?? "",
      attempt.expect ?? "",
      ...attempt.files,
      ...standing(attempt).map((obs) => obs.evidence),
    ]),
  ].join(" ");
}

/** Every free word must match, exactly or by stem; a name match adds to the score. */
function scoreWords(
  words: ReadonlyArray<string>,
  problem: SimProblem,
  pairs: ReadonlyArray<Pair>,
): { score: number; matchedBy: "exact" | "stemmed" } | undefined {
  const exact = new Set(tokenize(searchableText(problem, pairs)));
  const stems = new Set([...exact].map(stemSearchToken));
  const nameStems = new Set(
    tokenize([problem.name, ...problem.former_names].join(" ")).map(stemSearchToken),
  );
  let score = 0;
  let allExact = true;
  for (const word of words) {
    const stem = stemSearchToken(word);
    if (exact.has(word)) score += 2;
    else if (stems.has(stem)) {
      score += 1;
      allExact = false;
    } else return undefined;
    if (nameStems.has(stem)) score += 1;
  }
  return { score, matchedBy: allExact ? "exact" : "stemmed" };
}

/**
 * Ranks problems for a query. Words match case-insensitively, exactly or by stem. `key:value`
 * filters (`status:missed`, `status:open`, `file:`, `model:`, `harness:`) must all match.
 * An empty query returns nothing.
 */
export function searchProblemsRanked(
  state: SimState,
  query: string,
  options: SimSearchOptions = {},
): Array<SimSearchHit> {
  const { words, filters } = parseQuery(query);
  if (words.length === 0 && filters.length === 0) return [];
  const hits: Array<SimSearchHit> = [];
  for (const problem of state.problems) {
    const pairs = pairsOf(problem);
    if (!filters.every((filter) => filterMatches(filter, pairs))) continue;
    if (words.length === 0) {
      hits.push({ problem, score: 0, matchedBy: "filter" });
      continue;
    }
    const scored = scoreWords(words, problem, pairs);
    if (scored) hits.push({ problem, ...scored });
  }
  return hits.sort((a, b) => b.score - a.score).slice(0, options.limit ?? DEFAULT_SEARCH_LIMIT);
}

// ── Scorecard ────────────────────────────────────────────────────────

type Outcome =
  | "fixed"
  | "unconfirmed"
  | "missed"
  | "regressed"
  | "misfired"
  | "inconclusive"
  | "kept";

interface OutcomeCounts {
  readonly fixed: number;
  readonly unconfirmed: number;
  readonly missed: number;
  readonly regressed: number;
  readonly misfired: number;
  readonly inconclusive: number;
  readonly kept: number;
}

const OUTCOMES: ReadonlyArray<keyof OutcomeCounts> = [
  "fixed",
  "unconfirmed",
  "missed",
  "regressed",
  "misfired",
  "inconclusive",
  "kept",
];

function outcomeOf(attempt: SimAttempt, obs: SimObservation): Outcome {
  if (obs.result !== "fixed") return obs.result;
  return selfGraded(attempt, obs) ? "unconfirmed" : "fixed";
}

function countOutcomes(outcomes: ReadonlyArray<Outcome>): OutcomeCounts {
  const counts = {
    fixed: 0,
    unconfirmed: 0,
    missed: 0,
    regressed: 0,
    misfired: 0,
    inconclusive: 0,
    kept: 0,
  };
  for (const outcome of outcomes) counts[outcome] += 1;
  return counts;
}

export interface SimStatsRow extends OutcomeCounts {
  readonly name: string;
  readonly liveRules: number;
}

export interface SimStatsTotals extends OutcomeCounts {
  readonly problems: number;
  readonly attempts: number;
  readonly accepted: number;
  readonly rejected: number;
  readonly unanswered: number;
  readonly retracted: number;
  readonly liveRules: number;
  readonly openPredictions: number;
  readonly events: number;
}

export interface SimMissedRule {
  readonly problemId: string;
  readonly attemptId: string;
  readonly missed: ReadonlyArray<string>;
}

export interface SimRecurringFailure {
  readonly problemId: string;
  readonly name: string;
  readonly attempts: number;
}

export interface SimStaleOpen {
  readonly problemId: string;
  readonly attemptId: string;
  readonly round: string;
  readonly pending: number;
}

export interface SimUnconfirmedFix {
  readonly problemId: string;
  readonly attemptId: string;
  readonly by: string;
  readonly date: string;
}

export interface SimStatsReport {
  readonly totals: SimStatsTotals;
  readonly byPolicy: ReadonlyArray<SimStatsRow>;
  readonly byHarness: ReadonlyArray<SimStatsRow>;
  readonly missedLive: ReadonlyArray<SimMissedRule>;
  readonly recurringFailures: ReadonlyArray<SimRecurringFailure>;
  readonly staleOpen: ReadonlyArray<SimStaleOpen>;
  readonly unconfirmedFixes: ReadonlyArray<SimUnconfirmedFix>;
  readonly indexTokens?: number;
  readonly fullTokens?: number;
}

export interface SimStatsOptions {
  readonly staleDays?: number;
  readonly nowMs: number;
  readonly indexTokens?: number;
  readonly fullTokens?: number;
}

/** Groups by name, ignoring case; each group's first spelling is the label. */
function groupRows(
  liveNames: ReadonlyArray<string>,
  outcomes: ReadonlyArray<{ readonly name: string; readonly outcome: Outcome }>,
): Array<SimStatsRow> {
  const groups = new Map<string, { name: string; liveRules: number; outcomes: Array<Outcome> }>();
  const group = (raw: string) => {
    const name = raw.trim() || UNSPECIFIED;
    const key = name.toLowerCase();
    const existing = groups.get(key) ?? { name, liveRules: 0, outcomes: [] };
    groups.set(key, existing);
    return existing;
  };
  for (const name of liveNames) group(name).liveRules += 1;
  for (const item of outcomes) group(item.name).outcomes.push(item.outcome);
  const total = (row: OutcomeCounts) => OUTCOMES.reduce((sum, key) => sum + row[key], 0);
  return [...groups.values()]
    .map(({ name, liveRules, outcomes: list }) => ({
      name,
      liveRules,
      ...countOutcomes(list),
    }))
    .sort((a, b) => total(b) - total(a) || a.name.localeCompare(b.name));
}

/** `YYYY-MM-DD` round as UTC midnight; other spellings (test fixtures) have no age. */
function roundMs(round: string): number | undefined {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(round)) return undefined;
  const parsed = Date.parse(`${round}T00:00:00Z`);
  return Number.isNaN(parsed) ? undefined : parsed;
}

export function buildSimStats(state: SimState, options: SimStatsOptions): SimStatsReport {
  const cutoff = options.nowMs - (options.staleDays ?? DEFAULT_STALE_DAYS) * DAY_MS;
  const pairs = state.problems.flatMap(pairsOf);
  const allAttempts = state.problems.flatMap((problem) => problem.attempts);
  const live = pairs.filter(({ attempt }) => attempt.accepted && attempt.live);
  const outcomes = pairs.flatMap(({ problem, attempt }) =>
    standing(attempt).map((obs) => ({ problem, attempt, obs, outcome: outcomeOf(attempt, obs) })),
  );
  const counts = countOutcomes(outcomes.map((item) => item.outcome));
  const countAttempts = (predicate: (attempt: SimAttempt) => boolean) =>
    allAttempts.filter((attempt) => predicate(attempt)).length;
  const retracted = (attempt: SimAttempt) => attempt.retracted !== undefined;

  const recurringFailures = state.problems
    .map((problem) => ({
      problemId: problem.id,
      name: problem.name,
      attempts: pairsOf(problem).filter(({ attempt }) =>
        standing(attempt).some((obs) => FAILED.has(obs.result)),
      ).length,
    }))
    .filter((item) => item.attempts >= 2)
    .sort((a, b) => b.attempts - a.attempts);

  return {
    totals: {
      problems: state.problems.length,
      attempts: allAttempts.length,
      accepted: countAttempts((attempt) => !retracted(attempt) && attempt.accepted),
      rejected: countAttempts(
        (attempt) => !retracted(attempt) && !attempt.accepted && !attempt.unanswered,
      ),
      unanswered: countAttempts(
        (attempt) => !retracted(attempt) && !attempt.accepted && attempt.unanswered === true,
      ),
      retracted: countAttempts(retracted),
      liveRules: live.length,
      openPredictions: live.reduce((sum, { attempt }) => sum + attempt.pending.length, 0),
      events: state.events,
      ...counts,
    },
    byPolicy: groupRows(
      live.map(({ attempt }) => attempt.policy),
      outcomes.map((item) => ({ name: item.obs.policy, outcome: item.outcome })),
    ),
    byHarness: groupRows(
      live.map(({ attempt }) => effectiveHarness(attempt) ?? UNSPECIFIED),
      outcomes.map((item) => ({
        name: effectiveHarness(item.obs) ?? UNSPECIFIED,
        outcome: item.outcome,
      })),
    ),
    missedLive: live
      .filter(({ attempt }) => attempt.missed.length > 0)
      .map(({ problem, attempt }) => ({
        problemId: problem.id,
        attemptId: attempt.id,
        missed: attempt.missed,
      })),
    recurringFailures,
    staleOpen: live
      .filter(({ attempt }) => attempt.pending.length > 0)
      .flatMap(({ problem, attempt }) => {
        const opened = roundMs(attempt.round);
        return opened !== undefined && opened < cutoff
          ? [
              {
                problemId: problem.id,
                attemptId: attempt.id,
                round: attempt.round,
                pending: attempt.pending.length,
              },
            ]
          : [];
      }),
    unconfirmedFixes: outcomes
      .filter((item) => item.outcome === "unconfirmed")
      .map((item) => ({
        problemId: item.problem.id,
        attemptId: item.attempt.id,
        by: item.obs.by,
        date: item.obs.date,
      })),
    ...(options.indexTokens === undefined ? {} : { indexTokens: options.indexTokens }),
    ...(options.fullTokens === undefined ? {} : { fullTokens: options.fullTokens }),
  };
}

// ── Rendering ────────────────────────────────────────────────────────

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;

const outcomeText = (row: OutcomeCounts) => OUTCOMES.map((key) => `${key} ${row[key]}`).join(", ");

const clip = (text: string, max = 120) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

function renderRows(rows: ReadonlyArray<SimStatsRow>): Array<string> {
  return rows.length === 0
    ? ["- none"]
    : rows.map(
        (row) => `- ${row.name}: ${plural(row.liveRules, "live rule")}; ${outcomeText(row)}`,
      );
}

function renderList<T>(items: ReadonlyArray<T>, line: (item: T) => string): Array<string> {
  return items.length === 0 ? ["- none"] : items.map(line);
}

export function renderSimStats(report: SimStatsReport): string {
  const t = report.totals;
  const lines = [
    "# SIM scorecard",
    "",
    "## Overview",
    `- ${plural(t.problems, "problem")}, ${plural(t.attempts, "attempt")}: ${t.accepted} accepted, ${t.rejected} rejected, ${t.unanswered} unanswered, ${t.retracted} retracted`,
    `- ${plural(t.liveRules, "live rule")}, ${t.openPredictions} open predictions, ${plural(t.events, "journal event")}`,
    `- Outcomes: ${t.fixed} fixed, ${t.unconfirmed} unconfirmed self-grades, ${t.missed} missed, ${t.regressed} regressed, ${t.misfired} misfired, ${t.inconclusive} inconclusive, ${t.kept} kept`,
    ...(report.indexTokens === undefined && report.fullTokens === undefined
      ? []
      : [
          `- Token budget: index ${report.indexTokens ?? "n/a"}, full ${report.fullTokens ?? "n/a"}`,
        ]),
    "",
    "## By Model",
    ...renderRows(report.byPolicy),
    "",
    "## By Harness",
    ...renderRows(report.byHarness),
    "",
    "## Hotspots",
    "",
    "### Missed (live rules still missing predictions)",
    ...renderList(
      report.missedLive,
      (item) => `- ${item.problemId} ${item.attemptId}: ${clip(item.missed.join("; "))}`,
    ),
    "",
    "### Recurring failures (two or more attempts with a missed, regressed or misfired outcome)",
    ...renderList(
      report.recurringFailures,
      (item) => `- ${item.problemId} ${item.name}: ${plural(item.attempts, "attempt")}`,
    ),
    "",
    "### Stale open (live rules with open predictions, older than the stale window)",
    ...renderList(
      report.staleOpen,
      (item) =>
        `- ${item.problemId} ${item.attemptId} (round ${item.round}): ${plural(item.pending, "open prediction")}`,
    ),
    "",
    "### Unconfirmed self-grades (fixed, reported only by the session that changed the rule)",
    ...renderList(
      report.unconfirmedFixes,
      (item) => `- ${item.problemId} ${item.attemptId}: by ${item.by} on ${item.date}`,
    ),
  ];
  return lines.join("\n");
}
