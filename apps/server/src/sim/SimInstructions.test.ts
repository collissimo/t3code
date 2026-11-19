// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { assert, describe, it } from "@effect/vitest";
import { ProjectId, ServerSettings, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { CODEX_ADDITIONAL_CONTEXT_VALUE_MAX_BYTES } from "../provider/CodexDeveloperInstructions.ts";
import {
  resolveSimPaths,
  type SimAttempt,
  type SimObservation,
  type SimService,
  type SimSettingsConfig,
  type SimState,
} from "./SimContracts.ts";
import {
  SIM_MAX_INJECTED_SECTIONS,
  SIM_SECTION_MAX_UTF8_BYTES,
  buildSimThreadInstructions,
  createSimInstructionCache,
  resolveSimThreadInstructions,
  type SimThreadInstructionsInput,
} from "./SimInstructions.ts";

const DEFAULT_SIM = Schema.decodeSync(ServerSettings)({}).sim;
const GUIDE_HEADING = "## Self-Improvement Memory (SIM)";
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

function makeFixture(files: Readonly<Record<string, string>> = {}) {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-sim-instructions-"));
  const homeDir = NodePath.join(root, "home");
  const harnessDir = NodePath.join(homeDir, ".claude");
  NodeFS.mkdirSync(NodePath.join(harnessDir, "sim"), { recursive: true });
  for (const [name, text] of Object.entries(files)) {
    const path = NodePath.join(harnessDir, name);
    NodeFS.mkdirSync(NodePath.dirname(path), { recursive: true });
    NodeFS.writeFileSync(path, text);
  }
  const paths = resolveSimPaths({ harnessDir }, homeDir);
  return {
    paths,
    input: (
      overrides: Partial<SimThreadInstructionsInput> & {
        readonly sim?: Partial<SimSettingsConfig>;
      } = {},
    ): SimThreadInstructionsInput => {
      const { sim, ...rest } = overrides;
      return {
        settings: { ...DEFAULT_SIM, ...sim },
        paths,
        providerInstanceId: "codex",
        driver: "codex",
        model: "gpt-test",
        ...rest,
      };
    },
    [Symbol.dispose]: () => NodeFS.rmSync(root, { recursive: true, force: true }),
  };
}

function observation(result: SimObservation["result"], policy: string, harness?: string) {
  return {
    date: "2026-11-01",
    result,
    evidence: "synthetic",
    source: "test",
    policy,
    domain: "global",
    sample: "s",
    by: "session",
    ...(harness === undefined ? {} : { harness }),
  } satisfies SimObservation;
}

function attempt(id: string, anchor: string, overrides: Partial<SimAttempt> = {}): SimAttempt {
  return {
    id,
    round: "r1",
    sample: "s",
    by: "session",
    accepted: true,
    backfilled: false,
    action: "add",
    what: "synthetic rule",
    why: "synthetic",
    files: ["~/.claude/AGENTS.md"],
    anchor,
    supersedes: [],
    depends_on: [],
    predicted: [],
    expect: null,
    policy: "gpt-test",
    domain: "global",
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

function simState(attempts: ReadonlyArray<SimAttempt>): SimState {
  return {
    schema: 4,
    next_id: 2,
    next_attempt: attempts.length + 1,
    events: attempts.length,
    head: "genesis",
    carried_from: [],
    aliases: {},
    problems: [
      {
        id: "P1",
        name: "synthetic",
        opened_round: "r1",
        former_names: [],
        related: [],
        attempts: [...attempts],
      },
    ],
  };
}

const RULES = `# Agent rules

## Testing
- Run the focused tests before every push to a branch.
  - Name the command you ran in the report.
- Prefer table-driven cases when extending a test file.

## Database
- Use the staging database for integration checks.

## Formatting
- Indent shell scripts with two spaces always.
`;

describe("buildSimThreadInstructions", () => {
  it("never injects rule files into Claude Code, which loads them itself", () => {
    using fixture = makeFixture({ "AGENTS.md": RULES, "sim/sim.jsonl": "" });
    for (const target of [
      { providerInstanceId: "claudeAgent", driver: "claudeAgent" },
      { providerInstanceId: "claudeAgent", driver: "custom" },
      { providerInstanceId: "work-claude", driver: "claudeAgent" },
    ]) {
      assert.deepEqual(
        buildSimThreadInstructions(
          fixture.input({ ...target, sim: { providerOverrides: { claudeAgent: true } } }),
        ),
        [],
      );
    }
  });

  it("injects the rules and the SIM guide into other harnesses", () => {
    using fixture = makeFixture({ "AGENTS.md": RULES });
    for (const driver of ["codex", "antigravity", "opencode"]) {
      const sections = buildSimThreadInstructions(
        fixture.input({ providerInstanceId: driver, driver }),
      );
      assert.lengthOf(sections, 2);
      assert.include(sections[0], "# Harness rules from `~/.claude/AGENTS.md`");
      assert.include(sections[0], "- Use the staging database for integration checks.");
      assert.include(sections[1], GUIDE_HEADING);
      assert.isBelow(Buffer.byteLength(sections[1]!, "utf8"), 1_500);
    }
  });

  it("follows the enable switches and provider overrides", () => {
    using fixture = makeFixture({ "AGENTS.md": RULES });
    const injected = (input: Parameters<typeof fixture.input>[0]) =>
      buildSimThreadInstructions(fixture.input(input)).length > 0;
    assert.isFalse(injected({ sim: { enabled: false } }));
    assert.isFalse(injected({ sim: { injectRules: false } }));
    assert.isFalse(injected({ sim: { providerOverrides: { codex: false } } }));
    assert.isFalse(
      injected({ providerInstanceId: "codex-work", sim: { providerOverrides: { codex: false } } }),
    );
    assert.isTrue(
      injected({
        providerInstanceId: "codex-work",
        sim: { providerOverrides: { "codex-work": true, codex: false } },
      }),
    );
  });

  it("is a no-op on a machine without harness files or a SIM journal", () => {
    using fixture = makeFixture();
    assert.deepEqual(
      buildSimThreadInstructions(fixture.input({ sim: { ruleFiles: ["~/missing.md"] } })),
      [],
    );
    NodeFS.writeFileSync(fixture.paths.journalPath, "");
    const sections = buildSimThreadInstructions(fixture.input());
    assert.lengthOf(sections, 1);
    assert.include(sections[0], GUIDE_HEADING);
  });

  it("reads configured rule files once, however they are spelled", () => {
    using fixture = makeFixture({
      "AGENTS.md": "- Main rule from the harness file.\n",
      "notes/extra.md": "- Extra rule from a configured file.\n",
    });
    const sections = buildSimThreadInstructions(
      fixture.input({
        sim: {
          ruleFiles: ["~/.claude/notes/extra.md", "notes/extra.md", "~/.claude/AGENTS.md"],
        },
      }),
    );
    const text = sections.join("\n");
    assert.equal(text.split("Extra rule from a configured file.").length, 2);
    assert.equal(text.split("Main rule from the harness file.").length, 2);
    assert.include(text, "# Harness rules from `~/.claude/notes/extra.md`");
  });

  it("drops rules SIM shows misfiring here, scoped elsewhere or removed, and keeps the rest", () => {
    using fixture = makeFixture({ "AGENTS.md": RULES });
    const state = simState([
      attempt("A1", "Run the focused tests before every push", {
        observations: [observation("misfired", "gpt-test", "codex")],
      }),
      attempt("A2", "Use the staging database", { domain: "billing" }),
      attempt("A3", "Indent shell scripts with two spaces", { action: "remove", live: false }),
    ]);
    const rules = (input: Partial<SimThreadInstructionsInput>) =>
      buildSimThreadInstructions(fixture.input({ simState: state, projectName: "web", ...input }))
        .slice(0, -1)
        .join("\n");

    const here = rules({});
    assert.notInclude(here, "Run the focused tests");
    assert.notInclude(here, "Name the command you ran", "a dropped rule takes its sub-bullets");
    assert.include(here, "- Prefer table-driven cases");
    assert.notInclude(here, "staging database");
    assert.notInclude(here, "## Database", "a heading without rules goes too");
    assert.notInclude(here, "Indent shell scripts");
    assert.notInclude(here, "## Formatting");

    assert.include(rules({ model: "other-model" }), "Run the focused tests");
    assert.include(
      rules({ providerInstanceId: "opencode", driver: "opencode" }),
      "Run the focused tests",
    );
    assert.include(rules({ projectName: "billing" }), "staging database");
    assert.include(rules({ projectName: undefined }), "staging database");

    // A newer live attempt on the same anchor without a misfire brings the rule back.
    const superseded = simState([
      ...state.problems[0]!.attempts,
      attempt("A4", "Run the focused tests before every push"),
    ]);
    assert.include(rules({ simState: superseded }), "Run the focused tests");

    // An accepted remove attempt stores anchor: null and identifies the dropped rule via supersedes.
    const removedState = simState([
      attempt("A1", "Run the focused tests before every push", {
        live: false,
        superseded_by: "A2",
      }),
      {
        ...attempt("A2", "", {
          action: "remove",
          live: false,
          supersedes: ["A1"],
          policy: "gpt-test",
          depends_on: ["model"],
        }),
        anchor: null,
      },
    ]);
    assert.notInclude(
      rules({ simState: removedState, model: "gpt-test" }),
      "Run the focused tests",
    );
    assert.include(rules({ simState: removedState, model: "gpt-other" }), "Run the focused tests");
  });

  it("keeps every section under Codex's byte limit with multi-byte text", () => {
    const bullets = Array.from(
      { length: 400 },
      (_, index) =>
        `- Regel ${index}: Prüfe Änderungen gründlich, bevor du pushst 🚀🧪 — größer, schöner.`,
    );
    const longLine = `- ${"Über🦀".repeat(800)}`;
    assert.isAbove(Buffer.byteLength(longLine, "utf8"), 6_000);
    using fixture = makeFixture({
      "AGENTS.md": `# Regeln\n\n${longLine}\n\n## Viele Regeln\n${bullets.join("\n")}\n`,
      "notes/late.md": "- A late rule that cannot fit.\n",
    });
    const sections = buildSimThreadInstructions(
      fixture.input({ sim: { ruleFiles: ["~/.claude/notes/late.md"] } }),
    );
    assert.lengthOf(sections, SIM_MAX_INJECTED_SECTIONS);
    for (const section of sections) {
      assert.isAtMost(Buffer.byteLength(section, "utf8"), SIM_SECTION_MAX_UTF8_BYTES);
      assert.isAtMost(Buffer.byteLength(section, "utf8"), CODEX_ADDITIONAL_CONTEXT_VALUE_MAX_BYTES);
      assert.notMatch(section, LONE_SURROGATE);
    }
    assert.isTrue(sections[0]!.endsWith("… (use sim_read for full details)"));
    for (const section of sections.slice(1, -1)) {
      assert.include(
        section,
        "# Harness rules from `~/.claude/AGENTS.md` (continued)\n\n# Regeln\n\n## Viele Regeln\n- Regel",
        "a continued section repeats its heading chain",
      );
    }
    const guide = sections.at(-1)!;
    assert.include(guide, GUIDE_HEADING);
    assert.include(guide, "`~/.claude/AGENTS.md`, `~/.claude/notes/late.md` for the rest");
  });

  it("injects a 20 KB rules file to its last rule", () => {
    const bullets = Array.from(
      { length: 200 },
      (_, index) =>
        `- Rule ${String(index).padStart(3, "0")}: ${"keep this rule in view ".repeat(4)}`,
    );
    const rulesFile = `# Rules\n\n${bullets.join("\n")}\n`;
    assert.isAbove(Buffer.byteLength(rulesFile, "utf8"), 20_000);
    using fixture = makeFixture({ "AGENTS.md": rulesFile });
    const sections = buildSimThreadInstructions(fixture.input());
    assert.include(sections.join("\n"), "- Rule 199:", "the end of the file is not cut off");
    assert.notInclude(sections.at(-1)!, "for the rest");
  });

  it("offers the advisor only when one is configured", () => {
    using fixture = makeFixture({ "AGENTS.md": RULES });
    const guide = (sim: Partial<SimSettingsConfig>) =>
      buildSimThreadInstructions(fixture.input({ sim })).at(-1)!;
    assert.include(guide({}), 'role: "design"');
    assert.include(
      guide({}),
      'target: { providerInstanceId: "claudeAgent", model: "claude-fable-5-2" }',
    );
    assert.notInclude(guide({ advisorModelSelection: null }), "delegate_task` (`role");
  });
});

describe("createSimInstructionCache", () => {
  it("freezes a thread's sections within a context epoch and refreshes on the next", () => {
    using fixture = makeFixture({ "AGENTS.md": RULES });
    const misfiring = attempt("A1", "Run the focused tests before every push");
    const state = simState([misfiring]);
    const cache = createSimInstructionCache();
    const input = fixture.input({ threadId: ThreadId.make("thread-sim"), simState: state });

    const first = cache.resolve({ ...input, contextEpoch: 1 });
    assert.include(first.join("\n"), "Run the focused tests");
    misfiring.observations.push(observation("misfired", "gpt-test"));
    assert.strictEqual(cache.resolve({ ...input, contextEpoch: 1 }), first);

    assert.notInclude(
      cache.resolve({ ...input, contextEpoch: 2 }).join("\n"),
      "Run the focused tests",
    );
    assert.deepEqual(
      cache.resolve({
        ...input,
        contextEpoch: 1,
        settings: { ...input.settings, injectRules: false },
      }),
      [],
    );
  });

  it.effect(
    "resolveSimThreadInstructions skips getStateSnapshot on Claude turns and on cached Codex turns",
    () =>
      Effect.gen(function* () {
        using fixture = makeFixture({ "AGENTS.md": RULES });
        let snapshotReads = 0;
        const simService = {
          getThreadSeenEpoch: () => Effect.succeed(1),
          getStateSnapshot: () =>
            Effect.sync(() => {
              snapshotReads += 1;
              return { state: simState([]), broken: null, paths: fixture.paths };
            }),
          resolvePaths: () => Effect.succeed(fixture.paths),
        } as unknown as SimService["Service"];
        const cache = createSimInstructionCache();
        const base = {
          cache,
          simService: Option.some(simService),
          projectStore: Option.none(),
          settings: DEFAULT_SIM,
          threadId: ThreadId.make("thread-fast-path"),
          projectId: ProjectId.make("project-1"),
        };

        // Claude turn never touches SIM state at all.
        const claude = yield* resolveSimThreadInstructions({
          ...base,
          providerInstanceId: "claudeAgent",
          driver: "claudeAgent",
          model: "claude-opus-5-5",
        });
        assert.deepEqual(claude, []);
        assert.strictEqual(snapshotReads, 0);

        // Codex turn 1 loads once; turn 2 hits cache and does not replay sim.jsonl.
        const first = yield* resolveSimThreadInstructions({
          ...base,
          providerInstanceId: "codex",
          driver: "codex",
          model: "gpt-test",
        });
        assert.isAbove(first.length, 0);
        assert.strictEqual(snapshotReads, 1);

        const second = yield* resolveSimThreadInstructions({
          ...base,
          providerInstanceId: "codex",
          driver: "codex",
          model: "gpt-test",
        });
        assert.strictEqual(second, first);
        assert.strictEqual(snapshotReads, 1);
      }),
  );
});
