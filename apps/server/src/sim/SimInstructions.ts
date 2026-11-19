// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import type { ProjectId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import type { ProjectStoreV2 } from "../orchestration-v2/ProjectStore.ts";
import {
  canonicalHarnessFile,
  classifyHarnessPath,
  expandHarnessFile,
  expandHomeString,
  type SimAttempt,
  type SimResolvedPaths,
  type SimService,
  type SimSettingsConfig,
  type SimState,
} from "./SimContracts.ts";

/** Margin below Codex's 4,000-byte per-entry truncation (`CODEX_ADDITIONAL_CONTEXT_VALUE_MAX_BYTES`). */
export const SIM_SECTION_MAX_UTF8_BYTES = 3_800;
export const SIM_MAX_INJECTED_SECTIONS = 6;
const SIM_INSTRUCTION_CACHE_MAX_ENTRIES = 512;

// Claude Code loads ~/.claude/AGENTS.md itself; injecting it again would double every rule.
const CLAUDE_DRIVER = "claudeAgent";
const TRUNCATION_POINTER = "… (use sim_read for full details)";
// Shorter anchors match too many unrelated lines to drop a rule on.
const MIN_ANCHOR_LENGTH = 8;

export interface SimInjectionTarget {
  readonly settings: SimSettingsConfig;
  readonly providerInstanceId: string;
  readonly driver: string;
}

export interface SimThreadInstructionsInput extends SimInjectionTarget {
  readonly paths: SimResolvedPaths;
  readonly threadId?: ThreadId | undefined;
  readonly contextEpoch?: number | undefined;
  readonly model: string;
  readonly projectName?: string | undefined;
  readonly simState?: SimState | null | undefined;
}

function resolveSimInjectionEnabled(input: SimInjectionTarget): boolean {
  const { settings } = input;
  if (!settings.enabled || !settings.injectRules) return false;
  if (input.driver === CLAUDE_DRIVER || input.providerInstanceId === CLAUDE_DRIVER) return false;
  return (
    settings.providerOverrides[input.providerInstanceId] ??
    settings.providerOverrides[input.driver] ??
    true
  );
}

const utf8Bytes = (text: string) => Buffer.byteLength(text, "utf8");

/** Cuts at a code point boundary, so a surrogate pair is never split. */
function truncateUtf8(text: string, maxBytes: number): string {
  if (utf8Bytes(text) <= maxBytes) return text;
  const budget = maxBytes - utf8Bytes(TRUNCATION_POINTER);
  let used = 0;
  let head = "";
  for (const char of text) {
    const size = utf8Bytes(char);
    if (used + size > budget) break;
    used += size;
    head += char;
  }
  return `${head.trimEnd()}${TRUNCATION_POINTER}`;
}

const normalizeText = (text: string) => text.replace(/\s+/g, " ").trim();
const sameName = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

// ── Rule file parsing ────────────────────────────────────────────────

interface HeadingBlock {
  readonly kind: "heading";
  readonly level: number;
  readonly text: string;
}

interface RuleBlock {
  readonly kind: "rule";
  readonly indent: number;
  readonly bullet: boolean;
  readonly gapBefore: boolean;
  readonly lines: Array<string>;
}

type Block = HeadingBlock | RuleBlock;

const HEADING = /^(#{1,6})\s+\S/;
const BULLET = /^(\s*)(?:[-*+]|\d+[.)])\s+/;
const FENCE = /^\s*(`{3,}|~{3,})/;
const indentOf = (line: string) => line.length - line.trimStart().length;

/** Splits markdown into headings and rules: a bullet or paragraph with its continuation lines. */
function parseRuleFile(text: string): Array<Block> {
  const blocks: Array<Block> = [];
  let current: RuleBlock | undefined;
  let lastBullet: RuleBlock | undefined;
  let fence: string | undefined;
  let gap = false;
  for (const line of text.replace(/\r\n?/g, "\n").split("\n")) {
    if (fence !== undefined && current !== undefined) {
      current.lines.push(line);
      if (line.trimStart().startsWith(fence)) fence = undefined;
      continue;
    }
    if (line.trim() === "") {
      gap = true;
      current = undefined;
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading) {
      blocks.push({ kind: "heading", level: heading[1]!.length, text: line.trim() });
      current = undefined;
      lastBullet = undefined;
      gap = false;
      continue;
    }
    const bullet = BULLET.exec(line);
    const fenceOpen = FENCE.exec(line)?.[1];
    if (bullet) {
      current = {
        kind: "rule",
        indent: bullet[1]!.length,
        bullet: true,
        gapBefore: gap,
        lines: [line],
      };
      blocks.push(current);
      lastBullet = current;
    } else if (current !== undefined) {
      current.lines.push(line);
    } else if (lastBullet !== undefined && indentOf(line) > lastBullet.indent) {
      lastBullet.lines.push("", line);
      current = lastBullet;
    } else {
      current = { kind: "rule", indent: 0, bullet: false, gapBefore: gap, lines: [line] };
      blocks.push(current);
      lastBullet = undefined;
    }
    if (fenceOpen !== undefined) fence = fenceOpen.slice(0, 3);
    gap = false;
  }
  return blocks;
}

// ── SIM-driven filtering ─────────────────────────────────────────────

interface AttemptRef {
  readonly attempt: SimAttempt;
  readonly order: number;
  readonly anchor: string;
}

function attemptOrder(id: string, fallback: number): number {
  const parsed = Number.parseInt(id.replace(/^\D+/, ""), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function indexAttemptsByFile(
  simState: SimState | null | undefined,
  paths: SimResolvedPaths,
): Map<string, Array<AttemptRef>> {
  const byFile = new Map<string, Array<AttemptRef>>();
  const byId = new Map<
    string,
    { readonly anchor: string; readonly files: ReadonlyArray<string> }
  >();
  for (const problem of simState?.problems ?? []) {
    for (const attempt of problem.attempts) {
      const anchor = normalizeText(attempt.anchor ?? "");
      if (anchor.length >= MIN_ANCHOR_LENGTH) {
        byId.set(attempt.id, {
          anchor,
          files: attempt.files.map((f) => canonicalHarnessFile(f, paths)),
        });
      }
    }
  }
  let fallback = 0;
  for (const problem of simState?.problems ?? []) {
    for (const attempt of problem.attempts) {
      fallback += 1;
      const order = attemptOrder(attempt.id, fallback);
      const ownAnchor = normalizeText(attempt.anchor ?? "");
      const anchors = new Set<string>();
      const files = new Set(attempt.files.map((f) => canonicalHarnessFile(f, paths)));
      if (ownAnchor.length >= MIN_ANCHOR_LENGTH) anchors.add(ownAnchor);
      if (attempt.action === "remove") {
        // Removal attempts store anchor: null; resolve the removed rule's anchor via supersedes.
        for (const supersededId of attempt.supersedes) {
          const target = byId.get(supersededId);
          if (!target) continue;
          anchors.add(target.anchor);
          for (const file of target.files) files.add(file);
        }
      }
      for (const anchor of anchors) {
        const ref = { attempt, order, anchor };
        for (const file of files) {
          const refs = byFile.get(file) ?? [];
          refs.push(ref);
          byFile.set(file, refs);
        }
      }
    }
  }
  return byFile;
}

interface RuleContext {
  readonly providerInstanceId: string;
  readonly driver: string;
  readonly model: string;
  readonly projectName?: string | undefined;
}

const harnessApplies = (harness: string | undefined, context: RuleContext) =>
  harness === undefined ||
  sameName(harness, context.driver) ||
  sameName(harness, context.providerInstanceId);

const domainApplies = (domain: string, context: RuleContext) =>
  context.projectName === undefined ||
  sameName(domain, "global") ||
  sameName(domain, "unknown") ||
  sameName(domain, context.projectName);

/** The latest standing outcome under this model and harness decides; a later fix clears a misfire. */
function misfiredHere(attempt: SimAttempt, context: RuleContext): boolean {
  const latest = attempt.observations
    .filter(
      (obs) =>
        obs.retracted === undefined &&
        sameName(obs.policy, context.model) &&
        harnessApplies(obs.harness, context),
    )
    .at(-1);
  return latest?.result === "misfired";
}

function removedHere(attempt: SimAttempt, context: RuleContext): boolean {
  return (
    attempt.action === "remove" &&
    attempt.accepted &&
    attempt.retracted === undefined &&
    harnessApplies(attempt.harness, context) &&
    domainApplies(attempt.domain, context) &&
    (!attempt.depends_on.includes("model") || sameName(attempt.policy, context.model))
  );
}

/** Rules without a SIM entry always stay: SIM may only narrow what the user wrote. */
function keepRule(text: string, refs: ReadonlyArray<AttemptRef>, context: RuleContext): boolean {
  const normalized = normalizeText(text);
  const matches = refs.filter((ref) => normalized.includes(ref.anchor));
  if (matches.length === 0) return true;
  const live = matches.filter((ref) => ref.attempt.live);
  if (live.length > 0) {
    const inDomain = live.filter((ref) => domainApplies(ref.attempt.domain, context));
    const newest = inDomain.reduce<AttemptRef | undefined>(
      (best, ref) => (best === undefined || ref.order > best.order ? ref : best),
      undefined,
    );
    return newest !== undefined && !misfiredHere(newest.attempt, context);
  }
  return !matches.some((ref) => removedHere(ref.attempt, context));
}

function filterBlocks(
  blocks: ReadonlyArray<Block>,
  refs: ReadonlyArray<AttemptRef>,
  context: RuleContext,
): Array<Block> {
  const kept: Array<Block> = [];
  let droppedIndent: number | undefined;
  for (const block of blocks) {
    if (block.kind === "heading") {
      droppedIndent = undefined;
      kept.push(block);
      continue;
    }
    if (droppedIndent !== undefined && block.bullet && block.indent > droppedIndent) continue;
    droppedIndent = undefined;
    if (keepRule(block.lines.join("\n"), refs, context)) {
      kept.push(block);
    } else if (block.bullet) {
      droppedIndent = block.indent;
    }
  }
  return kept.filter((block, index) => {
    if (block.kind !== "heading") return true;
    for (const next of kept.slice(index + 1)) {
      if (next.kind === "rule") return true;
      if (next.level <= block.level) return false;
    }
    return false;
  });
}

// ── Packing into Codex-sized sections ────────────────────────────────

interface RuleFile {
  readonly label: string;
  readonly blocks: ReadonlyArray<Block>;
}

const RULES_INTRO =
  "These are the user's own harness rules. T3 Code injects them because this harness does not load them itself; follow them like your own instructions.";

function packRuleSections(
  files: ReadonlyArray<RuleFile>,
  maxSections: number,
): { readonly sections: Array<string>; readonly omitted: Array<string> } {
  const sections: Array<string> = [];
  const omitted: Array<string> = [];
  let body: Array<string> = [];
  let bytes = 0;
  let full = false;
  let endsWithHeading = false;
  let hasRules = false;

  const flush = () => {
    // A trailing heading's rules moved on; continued sections repeat it in their heading chain.
    if (endsWithHeading) body.pop();
    if (hasRules) sections.push(body.join(""));
    body = [];
    bytes = 0;
    endsWithHeading = false;
    hasRules = false;
  };
  const append = (text: string) => {
    body.push(text);
    bytes += utf8Bytes(text);
  };
  const remaining = () => SIM_SECTION_MAX_UTF8_BYTES - bytes;

  for (const file of files) {
    if (full) {
      omitted.push(file.label);
      continue;
    }
    const fileHeader = `# Harness rules from \`${file.label}\``;
    const headings: Array<HeadingBlock> = [];
    const startSection = (continued: boolean) => {
      flush();
      append(continued ? `${fileHeader} (continued)` : fileHeader);
      if (sections.length === 0) append(`\n\n${RULES_INTRO}`);
      const chain = headings.map((heading) => heading.text).join("\n\n");
      if (continued && chain && utf8Bytes(chain) < SIM_SECTION_MAX_UTF8_BYTES / 4) {
        append(`\n\n${chain}`);
      }
    };
    if (body.length === 0 || utf8Bytes(`\n\n${fileHeader}`) + 200 > remaining()) {
      if (sections.length + (body.length > 0 ? 1 : 0) >= maxSections) {
        omitted.push(file.label);
        full = true;
        continue;
      }
      startSection(false);
    } else {
      append(`\n\n${fileHeader}`);
      endsWithHeading = true;
    }
    for (const block of file.blocks) {
      const text = block.kind === "heading" ? block.text : block.lines.join("\n");
      const separator = block.kind === "heading" || block.gapBefore ? "\n\n" : "\n";
      if (block.kind === "heading") {
        while (headings.length > 0 && headings.at(-1)!.level >= block.level) headings.pop();
      }
      const size = utf8Bytes(separator + text);
      // A rule too long for any section is cut down where it is, not moved.
      const truncatedAnyway = size > SIM_SECTION_MAX_UTF8_BYTES / 2;
      if (
        size > remaining() &&
        (!truncatedAnyway || remaining() < SIM_SECTION_MAX_UTF8_BYTES / 4)
      ) {
        if (sections.length + 1 >= maxSections) {
          omitted.push(file.label);
          full = true;
          break;
        }
        startSection(true);
      }
      append(separator + truncateUtf8(text, remaining() - utf8Bytes(separator)));
      endsWithHeading = block.kind === "heading";
      if (block.kind === "heading") headings.push(block);
      else hasRules = true;
    }
  }
  flush();
  return { sections, omitted };
}

// ── SIM tool guide ───────────────────────────────────────────────────

function simGuideSection(settings: SimSettingsConfig, omitted: ReadonlyArray<string>): string {
  const advisor = settings.advisorModelSelection;
  const lines = [
    "## Self-Improvement Memory (SIM)",
    "",
    "SIM records every change to the agent harness across providers and models. Use its T3 tools `sim_read`, `sim_write` and `sim_apply_harness_change`.",
    "- Before you edit a harness file (`AGENTS.md`, `CLAUDE.md`, harness notes or hooks), call `sim_read`: `index` or `by_file` first, then `show` on the relevant P-ids, or `brief_all` before you open a new root cause.",
    "- Make the edit with `sim_apply_harness_change`, which edits and records in one step (live edits require full-access/default mode; pass `dryRun: true` in narrower modes or when the user must approve first). Never edit `sim.json`, `sim.jsonl` or `sim.lock` directly.",
    "- Never grade your own change `fixed` from this thread. A later session or an independent `delegate_task` grader records the outcome with `sim_write` (`observe`).",
    ...(advisor === null
      ? []
      : [
          `- Only for a truly tricky harness case (recurring failed attempts, a rule conflict across models or harnesses, an architectural cleanup), you may ask for a second opinion with \`delegate_task\` (\`role: "design"\`, \`target: { providerInstanceId: "${advisor.instanceId}", model: "${advisor.model}" }\`); never for routine edits.`,
        ]),
    ...(omitted.length === 0
      ? []
      : [
          `- Not every harness rule fit here. Read ${omitted.map((file) => `\`${file}\``).join(", ")} for the rest.`,
        ]),
  ];
  return truncateUtf8(lines.join("\n"), SIM_SECTION_MAX_UTF8_BYTES);
}

// ── Entry points ─────────────────────────────────────────────────────

function isFile(path: string): boolean {
  try {
    return NodeFS.statSync(path).isFile();
  } catch {
    return false;
  }
}

function resolveRuleFilePaths(settings: SimSettingsConfig, paths: SimResolvedPaths): Array<string> {
  const candidates = [
    NodePath.join(paths.harnessDir, "AGENTS.md"),
    ...settings.ruleFiles.map((file) =>
      NodePath.resolve(
        paths.harnessDir,
        expandHomeString(expandHarnessFile(file, paths), paths.homeDir),
      ),
    ),
  ];
  const seen = new Set<string>();
  const resolved: Array<string> = [];
  for (const candidate of candidates) {
    if (!isFile(candidate) || classifyHarnessPath(candidate, paths) === "record") continue;
    let real = candidate;
    try {
      real = NodeFS.realpathSync(candidate);
    } catch {
      // Keep the resolved path.
    }
    if (seen.has(real)) continue;
    seen.add(real);
    resolved.push(candidate);
  }
  return resolved;
}

function readRuleFile(path: string): string | undefined {
  try {
    return NodeFS.readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

/** Every returned section stays at or under `SIM_SECTION_MAX_UTF8_BYTES` UTF-8 bytes. */
export function buildSimThreadInstructions(
  input: SimThreadInstructionsInput,
): ReadonlyArray<string> {
  if (!resolveSimInjectionEnabled(input)) return [];
  const { paths, settings } = input;
  const ruleFilePaths = resolveRuleFilePaths(settings, paths);
  if (ruleFilePaths.length === 0 && !isFile(paths.journalPath)) return [];

  const attemptsByFile = indexAttemptsByFile(input.simState, paths);
  const files: Array<RuleFile> = [];
  for (const path of ruleFilePaths) {
    const text = readRuleFile(path);
    if (text === undefined) continue;
    const label = canonicalHarnessFile(path, paths);
    const blocks = filterBlocks(parseRuleFile(text), attemptsByFile.get(label) ?? [], input);
    if (blocks.length > 0) files.push({ label, blocks });
  }
  const { sections, omitted } = packRuleSections(files, SIM_MAX_INJECTED_SECTIONS - 1);
  return [...sections, simGuideSection(settings, omitted)];
}

function simInstructionCacheKey(input: {
  readonly threadId?: ThreadId | undefined;
  readonly contextEpoch?: number | undefined;
  readonly providerInstanceId: string;
  readonly driver: string;
  readonly model: string;
  readonly projectName?: string | undefined;
}): string {
  return [
    input.threadId,
    input.contextEpoch ?? 0,
    input.providerInstanceId,
    input.driver,
    input.model,
    input.projectName ?? "",
  ].join(":");
}

export interface SimInstructionCache {
  /** Same `(thread, epoch, provider, model, project)` returns the first snapshot, keeping prompt caches warm. */
  readonly resolve: (input: SimThreadInstructionsInput) => ReadonlyArray<string>;
  readonly get: (key: string) => ReadonlyArray<string> | undefined;
  readonly set: (key: string, value: ReadonlyArray<string>) => void;
}

export function createSimInstructionCache(
  maxEntries: number = SIM_INSTRUCTION_CACHE_MAX_ENTRIES,
): SimInstructionCache {
  const entries = new Map<string, ReadonlyArray<string>>();
  const get = (key: string): ReadonlyArray<string> | undefined => {
    const cached = entries.get(key);
    if (cached !== undefined) {
      entries.delete(key);
      entries.set(key, cached);
    }
    return cached;
  };
  const set = (key: string, value: ReadonlyArray<string>): void => {
    entries.delete(key);
    entries.set(key, value);
    if (entries.size > maxEntries) {
      const oldest = entries.keys().next();
      if (!oldest.done) entries.delete(oldest.value);
    }
  };
  return {
    get,
    set,
    resolve: (input) => {
      // Checked outside the snapshot so turning injection off applies on the next turn.
      if (!resolveSimInjectionEnabled(input)) return [];
      if (input.threadId === undefined) return buildSimThreadInstructions(input);
      const key = simInstructionCacheKey(input);
      const cached = get(key);
      if (cached !== undefined) return cached;
      const built = buildSimThreadInstructions(input);
      set(key, built);
      return built;
    },
  };
}

/**
 * Resolve SIM thread instructions for a turn. Checks eligibility and cache before touching the
 * journal so disabled threads, Claude turns, and cached turns never replay `sim.jsonl`.
 */
export const resolveSimThreadInstructions = (input: {
  readonly cache: SimInstructionCache;
  readonly simService: Option.Option<SimService["Service"]>;
  readonly projectStore: Option.Option<ProjectStoreV2["Service"]>;
  readonly settings: SimSettingsConfig;
  readonly threadId: ThreadId;
  readonly projectId: ProjectId;
  readonly providerInstanceId: string;
  readonly driver: string;
  readonly model: string;
}): Effect.Effect<ReadonlyArray<string>> => {
  if (Option.isNone(input.simService)) return Effect.succeed([]);
  if (
    !resolveSimInjectionEnabled({
      settings: input.settings,
      providerInstanceId: input.providerInstanceId,
      driver: input.driver,
    })
  ) {
    return Effect.succeed([]);
  }
  const sim = input.simService.value;
  return Effect.gen(function* () {
    const epoch = yield* sim.getThreadSeenEpoch(input.threadId);
    const project = Option.isNone(input.projectStore)
      ? undefined
      : Option.getOrUndefined(
          yield* input.projectStore.value
            .getShell(input.projectId)
            .pipe(Effect.orElseSucceed(() => Option.none())),
        );
    const projectName = project?.title;
    const key = simInstructionCacheKey({
      threadId: input.threadId,
      contextEpoch: epoch,
      providerInstanceId: input.providerInstanceId,
      driver: input.driver,
      model: input.model,
      projectName,
    });
    const cached = input.cache.get(key);
    if (cached !== undefined) return cached;
    const snapshot = yield* sim.getStateSnapshot();
    const paths = snapshot?.paths ?? (yield* sim.resolvePaths());
    const built = buildSimThreadInstructions({
      settings: input.settings,
      paths,
      threadId: input.threadId,
      contextEpoch: epoch,
      providerInstanceId: input.providerInstanceId,
      driver: input.driver,
      model: input.model,
      projectName,
      simState: snapshot?.state ?? null,
    });
    input.cache.set(key, built);
    return built;
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning("Failed to build SIM thread instructions.", { cause }).pipe(
        Effect.as([] as ReadonlyArray<string>),
      ),
    ),
  );
};
