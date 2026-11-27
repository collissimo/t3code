import { assert, describe, it } from "@effect/vitest";

import type {
  SimAttempt,
  SimObservation,
  SimProblem,
  SimResult,
  SimState,
} from "./SimContracts.ts";
import {
  buildSimStats,
  renderSimStats,
  searchProblemsRanked,
  stemSearchToken,
} from "./SimStats.ts";

const NOW = Date.parse("2026-11-27T00:00:00Z");

function observation(result: SimResult, overrides: Partial<SimObservation> = {}): SimObservation {
  return {
    date: "2026-11-20",
    result,
    evidence: "synthetic",
    source: "test",
    policy: "gpt-test",
    domain: "global",
    harness: "codex",
    sample: "s",
    by: "reviewer",
    ...overrides,
  };
}

function attempt(id: string, overrides: Partial<SimAttempt> = {}): SimAttempt {
  return {
    id,
    round: "2026-11-20",
    sample: "s",
    by: "author",
    accepted: true,
    backfilled: false,
    action: "add",
    what: "synthetic rule",
    why: "synthetic",
    files: ["~/.claude/AGENTS.md"],
    anchor: null,
    supersedes: [],
    depends_on: [],
    predicted: [],
    expect: null,
    policy: "gpt-test",
    domain: "global",
    harness: "codex",
    considered: [],
    observations: [],
    missed: [],
    fixed: [],
    pending: [],
    passed: 0,
    total: 0,
    superseded_by: null,
    live: true,
    ...overrides,
  };
}

function problem(id: string, name: string, attempts: ReadonlyArray<SimAttempt>): SimProblem {
  return {
    id,
    name,
    opened_round: "2026-11-01",
    former_names: [],
    related: [],
    attempts: [...attempts],
  };
}

function simState(problems: ReadonlyArray<SimProblem>): SimState {
  return {
    schema: 4,
    next_id: problems.length + 1,
    next_attempt: 1,
    events: 0,
    head: "genesis",
    carried_from: [],
    aliases: {},
    problems: [...problems],
  };
}

const RETRACTED = { seq: 9, reason: "synthetic" };

describe("stemSearchToken", () => {
  it("maps inflections the search should treat as one word to the same stem", () => {
    assert.strictEqual(stemSearchToken("hooks"), "hook");
    assert.strictEqual(stemSearchToken("files"), stemSearchToken("file"));
    assert.strictEqual(stemSearchToken("subagents"), "subagent");
    assert.strictEqual(stemSearchToken("running"), "run");
    assert.strictEqual(stemSearchToken("misfired"), "misfir");
    assert.strictEqual(stemSearchToken("misfire"), "misfir");
  });
});

describe("searchProblemsRanked", () => {
  const hooks = problem("H", "Hook timeouts", [
    attempt("A1", { what: "Hooks retry after a timeout" }),
  ]);
  const retry = problem("R", "Retry budget", [attempt("A2")]);
  const formatting = problem("F", "Formatting", [attempt("A3", { what: "Indent shell scripts" })]);
  const search = simState([hooks, retry, formatting]);

  it("requires every word when full matches exist and falls back to partial ranked matches when none match all words", () => {
    const ids = searchProblemsRanked(search, "hook timeout").map((hit) => hit.problem.id);
    assert.deepStrictEqual(ids, ["H"]);
    assert.deepStrictEqual(
      searchProblemsRanked(search, "hook zebra").map((hit) => hit.problem.id),
      ["H"],
    );
    assert.deepStrictEqual(searchProblemsRanked(search, "unknown zebra"), []);
  });

  it("marks a query that matches stems only as stemmed, and exact words as exact", () => {
    assert.strictEqual(searchProblemsRanked(search, "hooking timeout")[0]?.matchedBy, "stemmed");
    assert.strictEqual(searchProblemsRanked(search, "hooks timeout")[0]?.matchedBy, "exact");
  });

  it("ranks a problem whose name matches above one matching only in its attempts", () => {
    const ids = searchProblemsRanked(search, "retry").map((hit) => hit.problem.id);
    assert.deepStrictEqual(ids, ["R", "H"]);
  });

  it("returns nothing for an empty query", () => {
    assert.deepStrictEqual(searchProblemsRanked(search, "   "), []);
  });
});

describe("searchProblemsRanked filters", () => {
  const missing = problem("M", "Missing", [
    attempt("A1", {
      observations: [observation("missed")],
      files: ["~/.claude/AGENTS.md"],
    }),
  ]);
  const open = problem("O", "Open", [
    attempt("A2", { pending: ["p"], files: ["~/.claude/rules/web.md"], policy: "other-model" }),
  ]);
  const search = simState([missing, open]);
  const idsFor = (query: string) =>
    searchProblemsRanked(search, query).map((hit) => hit.problem.id);

  it("filters on status, file and model, and combines them", () => {
    assert.deepStrictEqual(idsFor("status:missed"), ["M"]);
    assert.deepStrictEqual(idsFor("status:open"), ["O"]);
    assert.deepStrictEqual(idsFor("status:live"), ["M", "O"]);
    assert.deepStrictEqual(idsFor("status:nolive"), []);
    assert.deepStrictEqual(idsFor("file:web.md"), ["O"]);
    assert.deepStrictEqual(idsFor("model:other-model"), ["O"]);
    assert.deepStrictEqual(idsFor("status:open model:gpt-test"), []);
  });
});

describe("buildSimStats", () => {
  const reviewed = attempt("A1", {
    observations: [observation("fixed", { by: "reviewer" })],
  });
  const selfGraded = attempt("A2", {
    observations: [
      observation("fixed", { by: "author", source: "self" }),
      observation("missed", { retracted: RETRACTED }),
    ],
  });
  const retractedAttempt = attempt("A3", {
    retracted: RETRACTED,
    observations: [observation("missed", { policy: "retracted-model" })],
  });
  const rejected = attempt("A4", { accepted: false });
  const unanswered = attempt("A5", { accepted: false, unanswered: true });
  const otherModel = attempt("A6", {
    policy: "other-model",
    harness: "opencode",
    missed: ["synthetic gap"],
    observations: [observation("missed", { policy: "other-model", harness: "opencode" })],
  });
  const stats = buildSimStats(
    simState([
      problem("P1", "One", [reviewed, selfGraded, retractedAttempt, rejected, unanswered]),
      problem("P2", "Two", [otherModel]),
    ]),
    { nowMs: NOW },
  );

  it("counts totals from standing observations and leaves retracted attempts out", () => {
    assert.strictEqual(stats.totals.attempts, 6);
    assert.strictEqual(stats.totals.accepted, 3);
    assert.strictEqual(stats.totals.rejected, 1);
    assert.strictEqual(stats.totals.unanswered, 1);
    assert.strictEqual(stats.totals.retracted, 1);
    assert.strictEqual(stats.totals.liveRules, 3);
    assert.strictEqual(stats.totals.fixed, 1);
    assert.strictEqual(stats.totals.missed, 1);
  });

  it("counts a fix reported only by the changing session as unconfirmed", () => {
    assert.strictEqual(stats.totals.unconfirmed, 1);
    assert.deepStrictEqual(
      stats.unconfirmedFixes.map((fix) => fix.attemptId),
      ["A2"],
    );
  });

  it("splits per-model and per-harness rows and drops retracted observations", () => {
    const gpt = stats.byPolicy.find((row) => row.name === "gpt-test");
    assert.strictEqual(gpt?.liveRules, 2);
    assert.strictEqual(gpt?.fixed, 1);
    assert.strictEqual(gpt?.unconfirmed, 1);
    assert.strictEqual(
      stats.byPolicy.find((row) => row.name === "retracted-model"),
      undefined,
    );
    const opencode = stats.byHarness.find((row) => row.name === "opencode");
    assert.strictEqual(opencode?.missed, 1);
    assert.strictEqual(opencode?.liveRules, 1);
  });

  it("lists live rules that still have missed predictions", () => {
    assert.deepStrictEqual(
      stats.missedLive.map((item) => item.attemptId),
      ["A6"],
    );
  });
});

describe("buildSimStats hotspots", () => {
  it("flags a problem only when two of its attempts failed", () => {
    const failed = (id: string, result: SimResult) =>
      attempt(id, { observations: [observation(result)] });
    const stats = buildSimStats(
      simState([
        problem("RECUR", "Recurring", [failed("A1", "missed"), failed("A2", "regressed")]),
        problem("ONCE", "Single", [failed("A3", "misfired")]),
      ]),
      { nowMs: NOW },
    );
    assert.deepStrictEqual(
      stats.recurringFailures.map((item) => [item.problemId, item.attempts]),
      [["RECUR", 2]],
    );
  });

  it("flags open predictions only when the attempt is older than the stale window", () => {
    const open = (id: string, round: string) => attempt(id, { round, pending: ["p"] });
    const stats = buildSimStats(
      simState([
        problem("P", "Open", [
          open("OLD", "2026-11-01"),
          open("EDGE", "2026-11-13"),
          open("NEW", "2026-11-20"),
        ]),
      ]),
      { nowMs: NOW, staleDays: 14 },
    );
    assert.deepStrictEqual(
      stats.staleOpen.map((item) => item.attemptId),
      ["OLD"],
    );
  });

  it("renders an empty state without NaN or undefined", () => {
    const text = renderSimStats(buildSimStats(simState([]), { nowMs: NOW }));
    assert.isFalse(/NaN|undefined/.test(text));
    assert.include(text, "## Hotspots");
    assert.include(text, "- none");
  });
});
