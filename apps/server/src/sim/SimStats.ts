import {
  DAY_MS,
  SIM_FAILURE_RESULTS,
  SIM_RESULTS,
  clipText,
  effectiveHarness,
  ownReport,
  pluralize,
  settlesFix,
  standing,
  type SimAttempt,
  type SimObservation,
  type SimProblem,
  type SimResult,
  type SimState,
} from "./SimContracts.ts";

// Pure: derives search hits and scorecard numbers from a SimState. No file I/O.

const DEFAULT_STALE_DAYS = 14;
const MAX_HOTSPOT_ROWS = 20;
const MIN_SUBSTRING_LENGTH = 3;
const UNSPECIFIED = "unspecified";
const FILTER = /^(status|file|model|harness):(.+)$/i;

export const VALID_STATUS_FILTERS: ReadonlyArray<string> = [
  "open",
  "live",
  "nolive",
  "unconfirmed",
  ...SIM_RESULTS,
];
const VALID_STATUS_SET = new Set(VALID_STATUS_FILTERS);

// ── Stemming and tokens ──────────────────────────────────────────────

const VOWEL = /[aeiouy]/;
const DOUBLED_CONSONANT = /([^aeiouslz])\1$/;
const RESTORE_E = /(at|bl|iz)$/;
const ENDS_CVC = /[^aeiou][aeiouy][^aeiouwxy]$/;

/** Porter's measure: the number of vowel-consonant pairs in a stem. */
const measure = (stem: string) =>
  (
    stem
      .replace(/(?<=[^aeiou])y/g, "i")
      .replace(/[^aeiou]+/g, "C")
      .replace(/[aeiou]+/g, "V")
      .match(/VC/g) ?? []
  ).length;

/** Porter steps 1a-1c and 5a so English inflections meet without collapsing CVC roots like file/time/code. */
export function stemSearchToken(token: string): string {
  let word = token.toLowerCase();

  // Step 1a: plurals
  if (word.endsWith("sses")) word = word.slice(0, -2);
  else if (word.length >= 5 && word.endsWith("ies")) word = `${word.slice(0, -3)}i`;
  else if (word.length >= 5 && /(sh|ch|x|z)es$/.test(word)) word = word.slice(0, -2);
  else if (word.length >= 4 && word.endsWith("s") && !word.endsWith("ss") && !word.endsWith("us")) {
    word = word.slice(0, -1);
  }

  // Step 1b: -ing / -ed with silent-e restoration
  let strippedVerb = false;
  if (word.length >= 6 && word.endsWith("ing") && VOWEL.test(word.slice(0, -3))) {
    word = word.slice(0, -3);
    strippedVerb = true;
  } else if (word.length >= 5 && word.endsWith("ed") && VOWEL.test(word.slice(0, -2))) {
    word = word.slice(0, -2);
    strippedVerb = true;
  }
  if (strippedVerb) {
    if (RESTORE_E.test(word)) word = `${word}e`;
    else if (DOUBLED_CONSONANT.test(word)) word = word.slice(0, -1);
    else if (measure(word) === 1 && ENDS_CVC.test(word)) word = `${word}e`;
  }

  // Step 1c: terminal y after a consonant
  if (word.length >= 4 && /[^aeiou]y$/.test(word) && /[aeiou]/.test(word.slice(0, -1))) {
    word = `${word.slice(0, -1)}i`;
  }

  // Step 5a: trailing silent e when not a short CVC root
  if (word.length >= 4 && word.endsWith("e")) {
    const stem = word.slice(0, -1);
    const m = measure(stem);
    if (m > 1 || (m === 1 && !ENDS_CVC.test(stem))) word = stem;
  }

  return word;
}

const tokenize = (text: string) =>
  text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((token) => token.length > 0);

// ── Shared views ─────────────────────────────────────────────────────

interface Pair {
  readonly problem: SimProblem;
  readonly attempt: SimAttempt;
}

const pairsOf = (problem: SimProblem): Array<Pair> =>
  problem.attempts.filter((attempt) => !attempt.retracted).map((attempt) => ({ problem, attempt }));

// ── Search ───────────────────────────────────────────────────────────

export interface SimSearchHit {
  readonly problem: SimProblem;
  readonly score: number;
  readonly matchedBy: "exact" | "stemmed" | "substring" | "filter";
  readonly partial?: boolean;
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
  const words = new Set<string>();
  const filters: Array<SimSearchFilter> = [];
  for (const part of query.trim().split(/\s+/).filter(Boolean)) {
    const match = FILTER.exec(part);
    const key = match?.[1]?.toLowerCase();
    const value = match?.[2]?.toLowerCase();
    if (key && value) filters.push({ key: key as FilterKey, value });
    else for (const token of tokenize(part)) words.add(token);
  }
  return { words: [...words], filters };
}

/** Unrecognized `status:<value>` values in a search query, if any. */
export function invalidSearchStatuses(query: string): Array<string> {
  return parseQuery(query)
    .filters.filter((filter) => filter.key === "status" && !VALID_STATUS_SET.has(filter.value))
    .map((filter) => filter.value);
}

function filterMatches(filter: SimSearchFilter, pairs: ReadonlyArray<Pair>): boolean {
  if (filter.key === "status" && filter.value === "nolive") {
    return !pairs.some(({ attempt }) => attempt.live);
  }
  return pairs.some(({ attempt }) => {
    switch (filter.key) {
      case "status":
        switch (filter.value) {
          case "open":
            return attempt.accepted && attempt.live && attempt.pending.length > 0;
          case "live":
            return attempt.live;
          case "unconfirmed":
            return standing(attempt).some(
              (obs) => obs.result === "fixed" && !settlesFix(attempt, obs),
            );
          default:
            return standing(attempt).some((obs) => obs.result === filter.value);
        }
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
      attempt.rejected_because ?? "",
      ...attempt.predicted,
      ...attempt.files,
      ...standing(attempt).flatMap((obs) => [obs.target ?? "", obs.evidence]),
    ]),
  ].join(" ");
}

/** Match words by exact token, stem, or substring; with `requireAll: false`, require at least one match. */
function scoreWords(
  words: ReadonlyArray<string>,
  problem: SimProblem,
  pairs: ReadonlyArray<Pair>,
  requireAll = true,
): { score: number; matchedBy: "exact" | "stemmed" | "substring" } | undefined {
  const exact = new Set(tokenize(searchableText(problem, pairs)));
  const exactList = [...exact];
  const stems = new Set(exactList.map(stemSearchToken));
  const nameTokens = tokenize([problem.name, ...problem.former_names].join(" "));
  const nameStems = new Set(nameTokens.map(stemSearchToken));
  let score = 0;
  let matchedTerms = 0;
  let tier: "exact" | "stemmed" | "substring" = "exact";
  for (const word of words) {
    const stem = stemSearchToken(word);
    if (exact.has(word)) {
      score += 3;
      matchedTerms += 1;
    } else if (stems.has(stem)) {
      score += 2;
      matchedTerms += 1;
      if (tier === "exact") tier = "stemmed";
    } else if (
      word.length >= MIN_SUBSTRING_LENGTH &&
      exactList.some((token) => token.includes(word))
    ) {
      score += 1;
      matchedTerms += 1;
      tier = "substring";
    } else if (requireAll) {
      return undefined;
    } else {
      continue;
    }
    if (
      nameStems.has(stem) ||
      (word.length >= MIN_SUBSTRING_LENGTH && nameTokens.some((token) => token.includes(word)))
    ) {
      score += 1;
    }
  }
  if (matchedTerms === 0) return undefined;
  return {
    score: matchedTerms * 10 + score,
    matchedBy:
      matchedTerms === words.length ? tier : tier === "substring" ? "substring" : "stemmed",
  };
}

/**
 * Ranks problems for a query. Words match case-insensitively by exact token, stem, or substring,
 * falling back to partial multi-word matching when strict AND matching returns zero entries.
 * `key:value` filters (`status:`, `file:`, `model:`, `harness:`) must all match.
 */
export function searchProblemsRanked(
  state: SimState,
  query: string,
  options: SimSearchOptions = {},
): Array<SimSearchHit> {
  const { words, filters } = parseQuery(query);
  if (words.length === 0 && filters.length === 0) return [];
  const candidates: Array<{ problem: SimProblem; pairs: Array<Pair> }> = [];
  const hits: Array<SimSearchHit> = [];
  for (const problem of state.problems) {
    const pairs = pairsOf(problem);
    if (!filters.every((filter) => filterMatches(filter, pairs))) continue;
    if (words.length === 0) {
      hits.push({ problem, score: 0, matchedBy: "filter" });
      continue;
    }
    candidates.push({ problem, pairs });
    const scored = scoreWords(words, problem, pairs, true);
    if (scored) hits.push({ problem, ...scored });
  }
  if (hits.length === 0 && words.length >= 2) {
    for (const { problem, pairs } of candidates) {
      const partial = scoreWords(words, problem, pairs, false);
      if (partial) hits.push({ problem, ...partial, partial: true });
    }
  }
  const sorted = hits.sort((a, b) => b.score - a.score);
  return options.limit === undefined ? sorted : sorted.slice(0, options.limit);
}

// ── Scorecard ────────────────────────────────────────────────────────

type Outcome = SimResult | "unconfirmed";

type OutcomeCounts = Readonly<Record<Outcome, number>>;

const OUTCOMES: ReadonlyArray<Outcome> = [
  "fixed",
  "unconfirmed",
  ...SIM_RESULTS.filter((result) => result !== "fixed"),
];

function outcomeOf(attempt: SimAttempt, obs: SimObservation): Outcome {
  if (obs.result !== "fixed") return obs.result;
  return ownReport(attempt, obs) === null ? "fixed" : "unconfirmed";
}

function countOutcomes(outcomes: ReadonlyArray<Outcome>): OutcomeCounts {
  const counts = Object.fromEntries(OUTCOMES.map((key) => [key, 0])) as Record<Outcome, number>;
  for (const outcome of outcomes) counts[outcome] += 1;
  return counts;
}

interface SimStatsRow extends OutcomeCounts {
  readonly name: string;
  readonly liveRules: number;
}

interface SimStatsTotals extends OutcomeCounts {
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

interface SimMissedRule {
  readonly problemId: string;
  readonly attemptId: string;
  readonly missed: ReadonlyArray<string>;
}

interface SimRecurringFailure {
  readonly problemId: string;
  readonly name: string;
  readonly attempts: number;
}

interface SimStaleOpen {
  readonly problemId: string;
  readonly attemptId: string;
  readonly round: string;
  readonly pending: number;
}

interface SimUnconfirmedFix {
  readonly problemId: string;
  readonly attemptId: string;
  readonly by: string;
  readonly date: string;
}

interface SimStatsReport {
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

interface SimStatsOptions {
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
  const staleDays = Math.max(1, options.staleDays ?? DEFAULT_STALE_DAYS);
  const cutoff = options.nowMs - staleDays * DAY_MS;
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
        standing(attempt).some((obs) => SIM_FAILURE_RESULTS.has(obs.result)),
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
      .filter(({ attempt }) => attempt.pending.length > 0 && attempt.fixed.length === 0)
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
      .filter(
        (item) =>
          item.outcome === "unconfirmed" &&
          !(item.obs.target && item.attempt.fixed.includes(item.obs.target)),
      )
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

const outcomeText = (row: OutcomeCounts) => OUTCOMES.map((key) => `${key} ${row[key]}`).join(", ");

function renderRows(rows: ReadonlyArray<SimStatsRow>): Array<string> {
  return rows.length === 0
    ? ["- none"]
    : rows.map(
        (row) => `- ${row.name}: ${pluralize(row.liveRules, "live rule")}; ${outcomeText(row)}`,
      );
}

function renderList<T>(items: ReadonlyArray<T>, line: (item: T) => string): Array<string> {
  if (items.length === 0) return ["- none"];
  const lines = items.slice(0, MAX_HOTSPOT_ROWS).map(line);
  if (items.length > MAX_HOTSPOT_ROWS) {
    lines.push(`- … (+${items.length - MAX_HOTSPOT_ROWS} more)`);
  }
  return lines;
}

export function renderSimStats(report: SimStatsReport): string {
  const t = report.totals;
  const lines = [
    "# SIM scorecard",
    "",
    "## Overview",
    `- ${pluralize(t.problems, "problem")}, ${pluralize(t.attempts, "attempt")}: ${t.accepted} accepted, ${t.rejected} rejected, ${t.unanswered} unanswered, ${t.retracted} retracted`,
    `- ${pluralize(t.liveRules, "live rule")}, ${t.openPredictions} open predictions, ${pluralize(t.events, "journal event")}`,
    `- Outcomes: ${t.fixed} fixed, ${t.unconfirmed} unconfirmed fix reports, ${t.missed} missed, ${t.regressed} regressed, ${t.misfired} misfired, ${t.inconclusive} inconclusive, ${t.kept} kept`,
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
      (item) => `- ${item.problemId} ${item.attemptId}: ${clipText(item.missed.join("; "), 120)}`,
    ),
    "",
    "### Recurring failures (two or more attempts with a missed, regressed or misfired outcome)",
    ...renderList(
      report.recurringFailures,
      (item) => `- ${item.problemId} ${item.name}: ${pluralize(item.attempts, "attempt")}`,
    ),
    "",
    "### Stale open (live rules with open predictions, older than the stale window)",
    ...renderList(
      report.staleOpen,
      (item) =>
        `- ${item.problemId} ${item.attemptId} (round ${item.round}): ${pluralize(item.pending, "open prediction")}`,
    ),
    "",
    "### Unconfirmed fixes (reported as fixed without an independent settling session)",
    ...renderList(
      report.unconfirmedFixes,
      (item) => `- ${item.problemId} ${item.attemptId}: by ${item.by} on ${item.date}`,
    ),
  ];
  return lines.join("\n");
}
