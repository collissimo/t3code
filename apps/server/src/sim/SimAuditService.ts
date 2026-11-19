// @effect-diagnostics nodeBuiltinImport:off globalDate:off - reads Claude Code transcripts and gate logs like sim-audit.mjs, whose timestamps are plain ISO strings.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import * as ServerSettings from "../serverSettings.ts";
import {
  SimAuditService,
  SimService,
  SimServiceError,
  classifyHarnessPath,
  type SimAuditOptions,
  type SimAuditReport,
  type SimCallerContext,
  type SimResolvedPaths,
  type SimState,
  type SimTelemetryEvent,
} from "./SimContracts.ts";
import { detectShellWriteTargets } from "./SimObserverReactor.ts";
import * as SimStore from "./SimStore.ts";

const isSimServiceError = Schema.is(SimServiceError);

const DEFAULT_DAYS = 7;
const DEFAULT_LIMIT = 25;
const THREAD_LIMIT = 2_000;
const CHUNK = 400;
const INSPECT_LINES = 200;
const MAX_FORK_HOPS = 16;
const AUDIT_MARKER = "[SIM-AUDIT]";

const SKIP_USER_PREFIXES = [
  "<task-notification>",
  "<command-name>",
  "<local-command-stdout>",
  "<system-reminder>",
  "This session is being continued from a previous conversation",
  "Continue where you left off",
  "Delegated task node:",
  "Context handoff (",
  "Note: the T3 server restarted",
];

// Bilingual cues for follow-up corrections (turn >= 2): a pre-filter; the audit agent reads context.
const FOLLOWUP_CORRECTION_RE =
  /\b(nein|falsch|nicht so|stimmt nicht|das ist nicht|das war nicht|vergessen|vergiss|stattdessen|ich meinte|warum hast du|wieso hast du|hör auf|bitte nicht|schon wieder|immer noch|nochmal|rückgängig|mach das nicht|lass das|wrong|instead|i meant|why did you|you forgot|don't do|do not do|stop doing|not what i|this is not|that is not|that's not|rollback|revert|still broken|again you)\b/i;
// Stronger cues that indicate a recurring failure even on turn 1.
const FIRST_TURN_FRICTION_RE =
  /\b(schon wieder|wieder kaputt|wieder falsch|hat wieder nicht|warum hast du vorhin|wieso hast du vorhin|failed again|broke again)\b/i;
const BASH_WRITE_OP_RE =
  /(?:(?<![<>])>{1,2}\|?|\btee\b|\bsed\b[^|\n]*(?:-i|--in-place)|\bperl\b[^|\n]*-[a-zA-Z]*i|\b(?:cp|mv|ln|install|rsync)\b|(?:writeFile|appendFile|write_text|open\s*\([^)]*['"][wax+]))/;
const REVIEW_RE =
  /\b(review|reviewer|re-check|recheck|audit|verify|verification|prüf\w*|gegenprüf\w*)\b/i;

const MODEL_EVENT_TYPES = ["thread.model-selection-updated", "thread.provider-switched"];
const AUDIT_EVENT_TYPES = ["checkpoint.rollback-requested", ...MODEL_EVENT_TYPES];

type Data = Record<string, unknown>;

function parseJson(text: unknown): Data {
  if (typeof text !== "string") return {};
  try {
    const parsed = JSON.parse(text) as unknown;
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Data)
      : {};
  } catch {
    return {};
  }
}

const str = (value: unknown): string | undefined =>
  typeof value === "string" && value ? value : undefined;
const record = (value: unknown): Data =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Data) : {};

function squashText(text: unknown, max = 240) {
  const flat = String(text ?? "")
    .replace(/\s+/g, " ")
    .trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** The user's own words: mechanical wrappers stripped, as sim-audit.mjs does. */
function extractUserText(content: unknown): string {
  let raw = "";
  if (typeof content === "string") raw = content;
  else if (Array.isArray(content)) {
    raw = content
      .map(record)
      .filter((part) => part.type === "text" && typeof part.text === "string")
      .map((part) => String(part.text))
      .join("\n");
  }
  let text = raw.trim();
  if (!text) return "";
  text = text
    .replace(/<t3_code_instructions>[\s\S]*?<\/t3_code_instructions>/g, "")
    .replace(/<assistant_citations>[\s\S]*?<\/assistant_citations>/g, "")
    .replace(/<system_context>[\s\S]*?<\/system_context>/g, "")
    .replace(/<runtime_info>[\s\S]*?<\/runtime_info>/g, "")
    .trim();
  const userRequest = text.match(/<user_request>([\s\S]*?)<\/user_request>/);
  if (userRequest) text = (userRequest[1] ?? "").trim();
  text = text.replace(/^(?:\[assistant-quote-\d+\]\s*)+/g, "").trim();
  if (!text || SKIP_USER_PREFIXES.some((prefix) => text.startsWith(prefix))) return "";
  return text;
}

interface Flag {
  readonly turn: number;
  readonly kind: "followup-correction" | "turn1-friction";
  readonly excerpt: string;
}

function flagMessage(turn: number, text: string): Flag | null {
  if (turn >= 2 && FOLLOWUP_CORRECTION_RE.test(text)) {
    return { turn, kind: "followup-correction", excerpt: squashText(text) };
  }
  if (turn === 1 && FIRST_TURN_FRICTION_RE.test(text))
    return { turn, kind: "turn1-friction", excerpt: squashText(text) };
  return null;
}

/** Path-like tokens a shell command writes to; the caller decides which are harness files. */
function bashWriteTargets(command: string): Array<string> {
  const found = new Set<string>(detectShellWriteTargets(command));
  if (!BASH_WRITE_OP_RE.test(command)) return [...found];
  if (
    /^\s*(?:[A-Z_]+=\S+\s+)*node\s+[^\n|;&>]*\bsim(?:-audit)?\.mjs\b/.test(command) &&
    !/(?<![<>])>{1,2}/.test(command)
  ) {
    return [...found];
  }
  const noHeredoc = command.replace(
    /(<<-?\s*['"]?([A-Za-z_]\w*)['"]?[^\n]*\n)[\s\S]*?(?:\n[ \t]*\2(?=\n|$)|$)/g,
    "$1",
  );
  for (const match of noHeredoc.matchAll(/(?:"([^"\n]+)"|'([^'\n]+)'|([^\s"'|;&<>()]+))/g)) {
    const token = (match[1] ?? match[2] ?? match[3] ?? "").trim();
    if (!token || /[$*{]/.test(token) || token.includes("/backups/") || /\.bak(?:-|$)/.test(token))
      continue;
    if (!/^(?:\/|~\/|\.claude\/|(?:AGENTS|CLAUDE)\.md$)/.test(token)) continue;
    found.add(token);
  }
  return [...found];
}

function inferProject(cwd: string | null, dirName: string) {
  if (cwd) {
    const clean = cwd.replace(/\/+$/, "");
    if (clean.includes("/.t3/scratch")) return "scratch";
    const worktree = clean.match(/\/\.t3\/worktrees\/([^/]+)/);
    if (worktree?.[1]) return worktree[1];
    return NodePath.basename(clean) || clean;
  }
  return dirName.replace(/^-+/, "").split("-").slice(-2).join("-") || dirName;
}

interface HarnessEdit {
  readonly source: "t3" | "claude" | "telemetry";
  readonly session: string;
  readonly date: string;
  readonly provider: string;
  readonly model: string;
  readonly files: ReadonlyArray<string>;
  readonly record: boolean;
  readonly recorded: boolean;
}

interface FlaggedSession {
  readonly source: "t3" | "claude";
  readonly session: string;
  readonly date: string;
  readonly project: string;
  readonly provider: string;
  readonly model: string;
  readonly userTurns: number;
  readonly flags: ReadonlyArray<Flag>;
}

interface ClaudeTranscript {
  readonly sessionId: string;
  readonly project: string;
  readonly model: string;
  readonly lastTs: string | null;
  readonly userTurns: number;
  readonly isAuditSelf: boolean;
  readonly harnessEdits: ReadonlyArray<string>;
  readonly flags: ReadonlyArray<Flag>;
}

function claudeRoots(paths: SimResolvedPaths): Array<string> {
  const roots = [NodePath.join(paths.harnessDir, "projects")];
  if (paths.harnessDir === NodePath.join(paths.homeDir, ".claude")) {
    try {
      for (const name of NodeFS.readdirSync(paths.homeDir)) {
        if (/^\.claude-/.test(name)) roots.push(NodePath.join(paths.homeDir, name, "projects"));
      }
    } catch {
      // an unreadable home adds no roots
    }
  }
  return roots.filter((dir) => NodeFS.existsSync(dir));
}

function parseTranscript(
  filePath: string,
  dirName: string,
  sinceMs: number,
  isHarness: (file: string, cwd: string | null) => boolean,
): ClaudeTranscript | null {
  let raw: string;
  try {
    raw = NodeFS.readFileSync(filePath, "utf8");
  } catch {
    return null;
  }
  const users: Array<{ turn: number; ts: string | null; text: string }> = [];
  const edits = new Set<string>();
  const models = new Map<string, number>();
  let cwd: string | null = null;
  let lastTs: string | null = null;
  let isAuditSelf = false;
  const inWindow = (ts: unknown) => {
    if (typeof ts !== "string") return true;
    const ms = Date.parse(ts);
    return !Number.isFinite(ms) || ms >= sinceMs;
  };
  for (const line of raw.split("\n")) {
    if (!line) continue;
    const row = parseJson(line);
    if (!Object.keys(row).length) continue;
    if (!cwd && str(row.cwd)) cwd = str(row.cwd) ?? null;
    const ts = str(row.timestamp);
    if (ts && (!lastTs || ts > lastTs)) lastTs = ts;
    const message = record(row.message);
    if (row.type === "user" && !row.isMeta && !row.isSidechain) {
      const text = extractUserText(message.content);
      if (text) {
        if (users.length === 0 && text.includes(AUDIT_MARKER)) isAuditSelf = true;
        users.push({ turn: users.length + 1, ts: ts ?? null, text });
      }
    } else if (row.type === "assistant" && !row.isSidechain) {
      const model = str(message.model) ?? str(row.requestedModel);
      if (model) models.set(model, (models.get(model) ?? 0) + 1);
      if (Array.isArray(message.content) && inWindow(ts)) {
        for (const block of message.content.map(record)) {
          if (block.type !== "tool_use") continue;
          const input = record(block.input);
          if (["Write", "Edit", "MultiEdit"].includes(String(block.name))) {
            const file = str(input.file_path);
            if (file && isHarness(file, cwd)) edits.add(file);
          } else if (block.name === "Bash") {
            for (const file of bashWriteTargets(String(input.command ?? "")))
              if (isHarness(file, cwd)) edits.add(file);
          }
        }
      }
    }
  }
  let model = "unknown";
  let best = 0;
  for (const [name, hits] of models) {
    if (hits > best) {
      best = hits;
      model = name;
    }
  }
  const flags = users
    .filter((msg) => inWindow(msg.ts))
    .flatMap((msg) => flagMessage(msg.turn, msg.text) ?? []);
  return {
    sessionId: NodePath.basename(filePath, ".jsonl"),
    project: inferProject(cwd, dirName),
    model,
    lastTs,
    userTurns: users.length,
    isAuditSelf,
    harnessEdits: [...edits],
    flags,
  };
}

interface GateLog {
  readonly present: boolean;
  readonly total: number;
  readonly counts: Record<string, number>;
  readonly notable: ReadonlyArray<{
    time: string;
    outcome: string;
    session: string;
    target: string;
  }>;
}

function readGateLog(filePath: string, sinceMs: number): GateLog {
  const counts: Record<string, number> = {};
  const notable: Array<{ time: string; outcome: string; session: string; target: string }> = [];
  let lines: Array<string>;
  try {
    lines = NodeFS.readFileSync(filePath, "utf8").split("\n").filter(Boolean);
  } catch {
    return { present: false, total: 0, counts, notable };
  }
  let total = 0;
  for (const line of lines) {
    const entry = parseJson(line);
    if (!Object.keys(entry).length) continue;
    const ts = Date.parse(String(entry.time ?? ""));
    if (Number.isFinite(ts) && ts < sinceMs) continue;
    total += 1;
    const outcome = String(entry.outcome ?? "unknown");
    counts[outcome] = (counts[outcome] ?? 0) + 1;
    if (!["allowed", "stamped"].includes(outcome)) {
      notable.push({
        time: String(entry.time ?? ""),
        outcome,
        session: String(entry.session ?? "none").slice(0, 12),
        target: String(entry.file ?? entry.repo ?? ""),
      });
    }
  }
  return { present: true, total, counts, notable };
}

function scanClaudeLogs(
  paths: SimResolvedPaths,
  sinceMs: number,
  excludeSessions: ReadonlySet<string>,
  isHarness: (file: string, cwd: string | null) => boolean,
) {
  const transcripts: Array<ClaudeTranscript> = [];
  let excludedSelf = 0;
  for (const root of claudeRoots(paths)) {
    for (const dir of NodeFS.readdirSync(root)) {
      if (dir.startsWith("-tmp-")) continue;
      const fullDir = NodePath.join(root, dir);
      let files: Array<string>;
      try {
        files = NodeFS.statSync(fullDir).isDirectory() ? NodeFS.readdirSync(fullDir) : [];
      } catch {
        continue;
      }
      for (const file of files) {
        if (!file.endsWith(".jsonl")) continue;
        const filePath = NodePath.join(fullDir, file);
        try {
          if (NodeFS.statSync(filePath).mtimeMs < sinceMs) continue;
        } catch {
          continue;
        }
        if (excludeSessions.has(file.slice(0, -".jsonl".length))) {
          excludedSelf += 1;
          continue;
        }
        const parsed = parseTranscript(filePath, dir, sinceMs, isHarness);
        if (!parsed || parsed.userTurns === 0) continue;
        if (parsed.isAuditSelf) {
          excludedSelf += 1;
          continue;
        }
        transcripts.push(parsed);
      }
    }
  }
  return { transcripts, excludedSelf };
}

function readWatermark(paths: SimResolvedPaths): string | null {
  const saved = parseJson(
    NodeFS.existsSync(paths.auditStatePath)
      ? NodeFS.readFileSync(paths.auditStatePath, "utf8")
      : "",
  );
  const at = str(saved.last_audit_at);
  return at && Number.isFinite(Date.parse(at)) ? at : null;
}

function writeWatermark(paths: SimResolvedPaths, nowMs: number, by: string): string {
  const now = new Date(nowMs).toISOString();
  NodeFS.mkdirSync(NodePath.dirname(paths.auditStatePath), { recursive: true });
  NodeFS.writeFileSync(
    paths.auditStatePath,
    `${JSON.stringify({ last_audit_at: now, by }, null, 2)}\n`,
  );
  return now;
}

function resolveSince(options: SimAuditOptions, paths: SimResolvedPaths, nowMs: number) {
  const window = resolveWindow(options, paths, nowMs);
  return { ...window, sinceIso: new Date(window.sinceMs).toISOString() };
}

function resolveWindow(options: SimAuditOptions, paths: SimResolvedPaths, nowMs: number) {
  if (options.since !== undefined) {
    const ms = Date.parse(
      options.since.length === 10 ? `${options.since}T00:00:00Z` : options.since,
    );
    if (!Number.isFinite(ms)) {
      throw new SimServiceError({
        code: "validation",
        problems: [`invalid since value: ${options.since}`],
      });
    }
    return { sinceMs: ms, source: `since ${options.since}` };
  }
  if (options.days !== undefined) {
    if (!Number.isFinite(options.days) || options.days <= 0) {
      throw new SimServiceError({
        code: "validation",
        problems: [`invalid days value: ${options.days}`],
      });
    }
    return { sinceMs: nowMs - options.days * 86_400_000, source: `last ${options.days}d` };
  }
  const watermark = readWatermark(paths);
  if (watermark) return { sinceMs: Date.parse(watermark), source: `watermark (${watermark})` };
  return { sinceMs: nowMs - DEFAULT_DAYS * 86_400_000, source: `default last ${DEFAULT_DAYS}d` };
}

/** Every session id the SIM record names as a writer, without its `cc:`/`t3:` kind. */
function simWriters(state: SimState): Set<string> {
  const out = new Set<string>();
  const add = (id: string | undefined) => {
    if (id && id !== "unknown") out.add(SimStore.bare(id));
  };
  for (const attempt of SimStore.allAttempts(state)) {
    add(attempt.by);
    add(attempt.also);
    add(attempt.sample);
    for (const obs of attempt.observations) {
      add(obs.by);
      add(obs.also);
      add(obs.sample);
    }
  }
  return out;
}

interface ThreadRow {
  readonly thread_id: string;
  readonly project_id: string;
  readonly title: string;
  readonly default_provider: string;
  readonly updated_at: string;
  readonly payload_json: string;
}
interface RunRow {
  readonly run_id: string;
  readonly thread_id: string;
  readonly ordinal: number;
  readonly provider: string;
  readonly status: string;
  readonly requested_at: string;
  readonly completed_at: string | null;
  readonly payload_json: string;
}
interface MessageRow {
  readonly message_id: string;
  readonly thread_id: string;
  readonly run_id: string | null;
  readonly role: string;
  readonly created_at: string;
  readonly payload_json: string;
}
interface TurnItemRow {
  readonly thread_id: string;
  readonly run_id: string | null;
  readonly type: string;
  readonly updated_at: string;
  readonly ordinal: number;
  readonly payload_json: string;
}
interface EventRow {
  readonly thread_id: string;
  readonly run_id: string | null;
  readonly event_type: string;
  readonly occurred_at: string;
  readonly payload_json: string;
}
interface ProjectRow {
  readonly project_id: string;
  readonly title: string;
  readonly workspace_root: string;
}
interface ProviderThreadRow {
  readonly thread_id: string;
  readonly provider: string;
  readonly payload_json: string;
}

interface RunInfo {
  readonly runId: string;
  readonly ordinal: number;
  readonly status: string;
  readonly requestedAt: string;
  readonly provider: string;
  readonly model: string;
  readonly userMessageId: string | undefined;
}

const runInfo = (row: RunRow): RunInfo => {
  const payload = parseJson(row.payload_json);
  const selection = record(payload.modelSelection);
  return {
    runId: row.run_id,
    ordinal: row.ordinal,
    status: row.status,
    requestedAt: row.requested_at,
    provider: str(payload.providerInstanceId) ?? str(selection.instanceId) ?? row.provider,
    model: str(selection.model) ?? "unknown",
    userMessageId: str(payload.userMessageId),
  };
};

const chunks = <A>(items: ReadonlyArray<A>) => {
  const out: Array<ReadonlyArray<A>> = [];
  for (let i = 0; i < items.length; i += CHUNK) out.push(items.slice(i, i + CHUNK));
  return out;
};

const groupBy = <A extends { readonly thread_id: string }>(rows: ReadonlyArray<A>) => {
  const map = new Map<string, Array<A>>();
  for (const row of rows) map.set(row.thread_id, [...(map.get(row.thread_id) ?? []), row]);
  return map;
};

function candidateFixedT3Threads(state: SimState): Array<string> {
  const ids = new Set<string>();
  const add = (value: string | undefined) => {
    if (value?.startsWith("t3:")) ids.add(value.slice(3));
  };
  for (const attempt of SimStore.allAttempts(state)) {
    if (attempt.retracted) continue;
    const fixes = attempt.observations.filter(
      (obs) => !obs.retracted && obs.result === "fixed" && obs.source !== "self",
    );
    if (fixes.length === 0) continue;
    add(attempt.by);
    add(attempt.also);
    add(attempt.sample);
    for (const obs of fixes) {
      add(obs.by);
      add(obs.also);
    }
  }
  return [...ids];
}

function forkParentFromPayload(payloadJson: string): string | null {
  const lineage = record(parseJson(payloadJson).lineage);
  const parent = str(lineage.parentThreadId);
  if (!parent) return null;
  return lineage.relationshipToParent === "fork" || lineage.sideChat === true ? parent : null;
}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const sim = yield* SimService;
  const serverSettings = yield* ServerSettings.ServerSettingsService;

  const ioError = (cause: unknown) =>
    new SimServiceError({
      code: "io",
      problems: [cause instanceof Error ? cause.message : String(cause)],
    });

  const tableNames = sql<{
    readonly name: string;
  }>`SELECT name FROM sqlite_master WHERE type = 'table'`.pipe(
    Effect.map((rows) => new Set(rows.map((row) => row.name))),
  );

  const byThreads = <A, E>(
    ids: ReadonlyArray<string>,
    query: (chunk: ReadonlyArray<string>) => Effect.Effect<ReadonlyArray<A>, E>,
  ) => Effect.forEach(chunks(ids), query).pipe(Effect.map((parts) => parts.flat()));

  const readDatabase = Effect.fn("SimAuditService.readDatabase")(function* (
    sinceIso: string,
    forkCandidateIds: ReadonlyArray<string>,
  ) {
    const tables = yield* tableNames;
    const has = (name: string) => tables.has(name);
    const threads = has("orchestration_v2_projection_threads")
      ? yield* sql<ThreadRow>`
          SELECT thread_id, project_id, title, default_provider, updated_at, payload_json
          FROM orchestration_v2_projection_threads
          WHERE updated_at >= ${sinceIso} AND deleted_at IS NULL
          ORDER BY updated_at DESC
          LIMIT ${THREAD_LIMIT}`
      : [];
    const ids = threads.map((row) => row.thread_id);
    const runs = has("orchestration_v2_projection_runs")
      ? yield* byThreads(
          ids,
          (chunk) => sql<RunRow>`
          SELECT run_id, thread_id, ordinal, provider, status, requested_at, completed_at, payload_json
          FROM orchestration_v2_projection_runs
          WHERE thread_id IN ${sql.in(chunk)}
          ORDER BY thread_id, ordinal`,
        )
      : [];
    const messages = has("orchestration_v2_projection_messages")
      ? yield* byThreads(
          ids,
          (chunk) => sql<MessageRow>`
          SELECT message_id, thread_id, run_id, role, created_at, payload_json
          FROM orchestration_v2_projection_messages
          WHERE thread_id IN ${sql.in(chunk)} AND role IN ('user', 'assistant') AND streaming = 0
          ORDER BY thread_id, created_at, message_id`,
        )
      : [];
    const items = has("orchestration_v2_projection_turn_items")
      ? yield* byThreads(
          ids,
          (chunk) => sql<TurnItemRow>`
          SELECT thread_id, run_id, type, updated_at, ordinal, payload_json
          FROM orchestration_v2_projection_turn_items
          WHERE thread_id IN ${sql.in(chunk)} AND type IN ('file_change', 'command_execution')
            AND updated_at >= ${sinceIso}
          ORDER BY thread_id, ordinal`,
        )
      : [];
    const events = has("orchestration_v2_events")
      ? yield* byThreads(
          ids,
          (chunk) => sql<EventRow>`
          SELECT thread_id, run_id, event_type, occurred_at, payload_json
          FROM orchestration_v2_events
          WHERE thread_id IN ${sql.in(chunk)} AND event_type IN ${sql.in(AUDIT_EVENT_TYPES)}
            AND occurred_at >= ${sinceIso}
          ORDER BY sequence`,
        )
      : [];
    const projects = has("projection_projects")
      ? yield* sql<ProjectRow>`SELECT project_id, title, workspace_root FROM projection_projects`
      : [];
    const providerThreads = has("orchestration_v2_projection_provider_threads")
      ? yield* byThreads(
          ids,
          (chunk) => sql<ProviderThreadRow>`
          SELECT thread_id, provider, payload_json
          FROM orchestration_v2_projection_provider_threads
          WHERE thread_id IN ${sql.in(chunk)}`,
        )
      : [];
    const forkParents = new Map<string, string | null>();
    if (has("orchestration_v2_projection_threads") && forkCandidateIds.length > 0) {
      let frontier = [...new Set(forkCandidateIds)];
      for (let hop = 0; hop < MAX_FORK_HOPS && frontier.length > 0; hop += 1) {
        const rows = yield* byThreads(
          frontier,
          (chunk) => sql<{ readonly thread_id: string; readonly payload_json: string }>`
            SELECT thread_id, payload_json
            FROM orchestration_v2_projection_threads
            WHERE thread_id IN ${sql.in(chunk)}`,
        );
        const next: Array<string> = [];
        for (const id of frontier) {
          if (!forkParents.has(id)) forkParents.set(id, null);
        }
        for (const row of rows) {
          const parent = forkParentFromPayload(row.payload_json);
          forkParents.set(row.thread_id, parent);
          if (parent && !forkParents.has(parent)) next.push(parent);
        }
        frontier = [...new Set(next)];
      }
    }
    return { threads, runs, messages, items, events, projects, providerThreads, forkParents };
  });

  const requireSimEnabled = serverSettings.getSettings.pipe(
    Effect.mapError(ioError),
    Effect.filterOrFail(
      (settings) => settings.sim.enabled,
      () => new SimServiceError({ code: "disabled", problems: ["SIM is turned off in settings"] }),
    ),
  );

  const audit: SimAuditService["Service"]["audit"] = Effect.fn("SimAuditService.audit")(function* (
    caller: SimCallerContext,
    options: SimAuditOptions = {},
  ) {
    const settings = yield* requireSimEnabled;
    const snapshot = yield* sim.getStateSnapshot();
    if (!snapshot)
      return yield* new SimServiceError({ code: "disabled", problems: ["SIM is not available"] });
    const { state, paths } = snapshot;
    const nowMs = yield* Clock.currentTimeMillis;
    const { sinceMs, sinceIso, source } = yield* Effect.try({
      try: () => resolveSince(options, paths, nowMs),
      catch: (cause) => (isSimServiceError(cause) ? cause : ioError(cause)),
    });
    const limit = Math.max(1, options.limit ?? DEFAULT_LIMIT);
    const db = yield* readDatabase(sinceIso, candidateFixedT3Threads(state)).pipe(
      NodeSqliteClient.readOnly,
      Effect.mapError(ioError),
    );
    const telemetry = (yield* sim.readTelemetry(sinceMs)).filter(
      (event) => !caller.threadId || !("threadId" in event) || event.threadId !== caller.threadId,
    );
    const observed = yield* sim.getObservedModels();
    return yield* Effect.try({
      try: () =>
        buildReport({
          caller,
          options,
          paths,
          state,
          broken: snapshot.broken,
          sinceMs,
          source,
          limit,
          db,
          telemetry,
          observed,
          advisor: settings.sim,
        }),
      catch: ioError,
    });
  });

  const inspectThread: SimAuditService["Service"]["inspectThread"] = Effect.fn(
    "SimAuditService.inspectThread",
  )(function* (_caller, threadIdPrefix) {
    yield* requireSimEnabled;
    const wanted = threadIdPrefix.trim();
    if (!wanted)
      return yield* new SimServiceError({
        code: "validation",
        problems: ["give a thread id or its prefix"],
      });
    const read = Effect.gen(function* () {
      const tables = yield* tableNames;
      if (!tables.has("orchestration_v2_projection_threads")) return null;
      const matches = yield* sql<ThreadRow>`
          SELECT thread_id, project_id, title, default_provider, updated_at, payload_json
          FROM orchestration_v2_projection_threads
          WHERE thread_id = ${wanted} OR substr(thread_id, 1, ${wanted.length}) = ${wanted}
          ORDER BY CASE WHEN thread_id = ${wanted} THEN 0 ELSE 1 END, updated_at DESC
          LIMIT 10`;
      const exact = matches.find((row) => row.thread_id === wanted);
      if (!exact && matches.length !== 1) return { matches, thread: null };
      const thread = exact ?? matches[0]!;
      const id = thread.thread_id;
      const runs = tables.has("orchestration_v2_projection_runs")
        ? yield* sql<RunRow>`
              SELECT run_id, thread_id, ordinal, provider, status, requested_at, completed_at, payload_json
              FROM orchestration_v2_projection_runs WHERE thread_id = ${id} ORDER BY ordinal`
        : [];
      const messages = tables.has("orchestration_v2_projection_messages")
        ? yield* sql<MessageRow>`
              SELECT message_id, thread_id, run_id, role, created_at, payload_json
              FROM orchestration_v2_projection_messages
              WHERE thread_id = ${id} AND role IN ('user', 'assistant') ORDER BY created_at, message_id`
        : [];
      const items = tables.has("orchestration_v2_projection_turn_items")
        ? yield* sql<TurnItemRow>`
              SELECT thread_id, run_id, type, updated_at, ordinal, payload_json
              FROM orchestration_v2_projection_turn_items
              WHERE thread_id = ${id} AND type IN ('file_change', 'command_execution', 'dynamic_tool', 'subagent')
              ORDER BY ordinal`
        : [];
      const events = tables.has("orchestration_v2_events")
        ? yield* sql<EventRow>`
              SELECT thread_id, run_id, event_type, occurred_at, payload_json
              FROM orchestration_v2_events
              WHERE thread_id = ${id} AND event_type IN ${sql.in(AUDIT_EVENT_TYPES)} ORDER BY sequence`
        : [];
      return { matches, thread, runs, messages, items, events };
    });
    const found = yield* read.pipe(NodeSqliteClient.readOnly, Effect.mapError(ioError));
    if (!found || (!found.thread && !found.matches.length)) {
      return yield* new SimServiceError({
        code: "not_found",
        problems: [`no T3 thread matching "${wanted}"`],
      });
    }
    if (!found.thread || !("runs" in found)) {
      return yield* new SimServiceError({
        code: "validation",
        problems: [
          `several threads match "${wanted}": ${found.matches.map((row) => row.thread_id).join(", ")}`,
        ],
      });
    }
    return {
      threadId: found.thread.thread_id,
      text: renderInspection(found.thread, found.runs, found.messages, found.items, found.events),
    };
  });

  const markAuditDone: SimAuditService["Service"]["markAuditDone"] = Effect.fn(
    "SimAuditService.markAuditDone",
  )(function* (caller) {
    yield* requireSimEnabled;
    const paths = yield* sim.resolvePaths();
    const nowMs = yield* Clock.currentTimeMillis;
    const now = yield* Effect.try({
      try: () => writeWatermark(paths, nowMs, caller.sessionId || "unknown"),
      catch: ioError,
    });
    return {
      lastAuditAt: now,
      statePath: paths.auditStatePath,
      text: `marked audit done at ${now} (${paths.auditStatePath})`,
    };
  });

  return SimAuditService.of({ audit, inspectThread, markAuditDone });
});

export const layer = Layer.effect(SimAuditService, make);

interface ReportInput {
  readonly caller: SimCallerContext;
  readonly options: SimAuditOptions;
  readonly paths: SimResolvedPaths;
  readonly state: SimState;
  readonly broken: string | null;
  readonly sinceMs: number;
  readonly source: string;
  readonly limit: number;
  readonly db: {
    readonly threads: ReadonlyArray<ThreadRow>;
    readonly runs: ReadonlyArray<RunRow>;
    readonly messages: ReadonlyArray<MessageRow>;
    readonly items: ReadonlyArray<TurnItemRow>;
    readonly events: ReadonlyArray<EventRow>;
    readonly projects: ReadonlyArray<ProjectRow>;
    readonly providerThreads: ReadonlyArray<ProviderThreadRow>;
    readonly forkParents: ReadonlyMap<string, string | null>;
  };
  readonly telemetry: ReadonlyArray<SimTelemetryEvent>;
  readonly observed: ReadonlySet<string>;
  readonly advisor: Parameters<typeof SimStore.buildAdvisorEscalation>[1];
}

interface Switch {
  readonly threadId: string;
  readonly from: string;
  readonly to: string;
}
interface Interrupt {
  readonly threadId: string;
  readonly interruptedRunId: string;
  readonly followup: string;
  readonly model: string;
}
interface Review {
  readonly threadId: string;
  readonly title: string;
  readonly model: string;
  readonly excerpt: string;
}

function buildReport(input: ReportInput): SimAuditReport {
  const { caller, paths, state, sinceMs, limit, db } = input;
  const allowTmp = SimStore.isTestSimDir(paths);
  const kindOf = (file: string, cwd: string | null) =>
    classifyHarnessPath(file, paths, cwd ?? paths.homeDir, { allowTmp });
  const writers = simWriters(state);
  const projects = new Map(db.projects.map((row) => [row.project_id, row]));
  const runsBy = groupBy(db.runs);
  const messagesBy = groupBy(db.messages);
  const itemsBy = groupBy(db.items);
  const eventsBy = groupBy(db.events);
  const claudeNativeIdsByThread = new Map<string, Set<string>>();
  const allT3ClaudeNativeIds = new Set<string>();
  for (const row of db.providerThreads) {
    const nativeRef = record(parseJson(row.payload_json).nativeThreadRef);
    const nativeId = str(nativeRef.nativeId);
    if (nativeId && (str(nativeRef.driver) === "claudeAgent" || row.provider === "claudeAgent")) {
      const set = claudeNativeIdsByThread.get(row.thread_id) ?? new Set<string>();
      set.add(nativeId);
      claudeNativeIdsByThread.set(row.thread_id, set);
      allT3ClaudeNativeIds.add(nativeId);
    }
  }

  const flagged: Array<FlaggedSession> = [];
  const edits: Array<HarnessEdit> = [];
  const rollbacks = new Map<string, { threadId: string; checkpointId: string; date: string }>();
  const switches = new Map<string, Switch>();
  const interrupts = new Map<string, Interrupt>();
  const reviews = new Map<string, Review>();
  const freshModels = new Map<string, { providerInstanceId: string; model: string }>();
  let threadsScanned = 0;
  let excludedSelf = 0;

  const noteModel = (providerInstanceId: string, model: string) => {
    if (!model || model === "unknown" || input.observed.has(model)) return;
    freshModels.set(`${providerInstanceId}::${model}`, { providerInstanceId, model });
  };

  for (const thread of db.threads) {
    if (caller.threadId && thread.thread_id === caller.threadId) {
      excludedSelf += 1;
      continue;
    }
    const payload = parseJson(thread.payload_json);
    const messages = messagesBy.get(thread.thread_id) ?? [];
    const users = messages
      .filter((row) => row.role === "user")
      .map((row) => ({ row, text: extractUserText(parseJson(row.payload_json).text) }))
      .filter((entry) => entry.text);
    if (thread.title.includes(AUDIT_MARKER) || users[0]?.text.includes(AUDIT_MARKER)) {
      excludedSelf += 1;
      continue;
    }
    threadsScanned += 1;
    const runs = (runsBy.get(thread.thread_id) ?? []).map(runInfo);
    const lastRun = runs[runs.length - 1];
    const provider =
      lastRun?.provider ?? str(payload.providerInstanceId) ?? thread.default_provider;
    const model = lastRun?.model ?? str(record(payload.modelSelection).model) ?? "unknown";
    const project = projects.get(thread.project_id);
    const cwd = str(payload.worktreePath) ?? project?.workspace_root ?? null;
    const date = thread.updated_at.slice(0, 10);

    const flags = users.flatMap((entry, index) =>
      Date.parse(entry.row.created_at) >= sinceMs ? (flagMessage(index + 1, entry.text) ?? []) : [],
    );
    if (flags.length) {
      flagged.push({
        source: "t3",
        session: thread.thread_id,
        date,
        project: project?.title ?? thread.project_id,
        provider,
        model,
        userTurns: users.length,
        flags,
      });
    }

    for (const run of runs)
      if (Date.parse(run.requestedAt) >= sinceMs) noteModel(run.provider, run.model);
    for (let i = 1; i < runs.length; i += 1) {
      const before = runs[i - 1]!;
      const after = runs[i]!;
      if (Date.parse(after.requestedAt) < sinceMs) continue;
      const from = `${before.provider}/${before.model}`;
      const to = `${after.provider}/${after.model}`;
      if (from !== to)
        switches.set(`${thread.thread_id}|${from}|${to}`, { threadId: thread.thread_id, from, to });
      if (before.status === "interrupted") {
        const followup =
          users.find((entry) => entry.row.message_id === after.userMessageId)?.text ?? "";
        interrupts.set(before.runId, {
          threadId: thread.thread_id,
          interruptedRunId: before.runId,
          followup: squashText(followup, 160),
          model: `${before.provider}/${before.model}`,
        });
      }
    }

    for (const event of eventsBy.get(thread.thread_id) ?? []) {
      const eventPayload = parseJson(event.payload_json);
      if (event.event_type === "checkpoint.rollback-requested") {
        const checkpointId = str(eventPayload.checkpointId) ?? event.occurred_at;
        rollbacks.set(`${thread.thread_id}|${checkpointId}`, {
          threadId: thread.thread_id,
          checkpointId,
          date: event.occurred_at.slice(0, 10),
        });
      } else if (MODEL_EVENT_TYPES.includes(event.event_type)) {
        const prior = [...runs].reverse().find((run) => run.requestedAt <= event.occurred_at);
        const selection = record(eventPayload.modelSelection);
        const toProvider = str(eventPayload.providerInstanceId) ?? str(selection.instanceId);
        const toModel = str(selection.model);
        if (!prior || !toModel) continue;
        const from = `${prior.provider}/${prior.model}`;
        const to = `${toProvider ?? prior.provider}/${toModel}`;
        if (from !== to)
          switches.set(`${thread.thread_id}|${from}|${to}`, {
            threadId: thread.thread_id,
            from,
            to,
          });
      }
    }

    const harnessFiles = new Set<string>();
    const recordFiles = new Set<string>();
    for (const item of itemsBy.get(thread.thread_id) ?? []) {
      const itemPayload = parseJson(item.payload_json);
      const changePaths = Array.isArray(itemPayload.changes)
        ? itemPayload.changes.map((entry) => str(record(entry).path))
        : [];
      const targets =
        item.type === "file_change"
          ? [str(itemPayload.fileName), ...changePaths].filter((file): file is string => !!file)
          : bashWriteTargets(String(itemPayload.input ?? ""));
      for (const file of targets) {
        const kind = kindOf(file, cwd);
        const canonical = SimStore.resolveCallerFile(
          file,
          { sessionId: "", ...(cwd ? { workspaceRoot: cwd } : {}) },
          paths,
        );
        if (kind === "harness") harnessFiles.add(canonical);
        else if (kind === "record") recordFiles.add(canonical);
      }
    }
    const nativeIds = claudeNativeIdsByThread.get(thread.thread_id);
    const recorded =
      writers.has(thread.thread_id) ||
      (nativeIds !== undefined && [...nativeIds].some((id) => writers.has(id)));
    if (harnessFiles.size) {
      edits.push({
        source: "t3",
        session: thread.thread_id,
        date,
        provider,
        model,
        files: [...harnessFiles],
        record: false,
        recorded,
      });
    }
    if (recordFiles.size) {
      edits.push({
        source: "t3",
        session: thread.thread_id,
        date,
        provider,
        model,
        files: [...recordFiles],
        record: true,
        recorded: false,
      });
    }

    const lineage = record(payload.lineage);
    const delegated =
      !!str(lineage.parentThreadId) || thread.thread_id.startsWith("thread:delegated-task:");
    if (delegated && (REVIEW_RE.test(thread.title) || REVIEW_RE.test(users[0]?.text ?? ""))) {
      const lastAssistant = [...messages].reverse().find((row) => row.role === "assistant");
      reviews.set(thread.thread_id, {
        threadId: thread.thread_id,
        title: thread.title,
        model: `${provider}/${model}`,
        excerpt: squashText(lastAssistant ? parseJson(lastAssistant.payload_json).text : "", 300),
      });
    }
  }

  for (const event of input.telemetry) {
    switch (event.kind) {
      case "unrecorded_harness_edit":
      case "direct_sim_record_edit": {
        const isRecord = event.kind === "direct_sim_record_edit";
        const known = edits.some(
          (edit) =>
            edit.session === event.threadId &&
            edit.record === isRecord &&
            event.files.every((file) => edit.files.includes(file)),
        );
        if (!known) {
          edits.push({
            source: "telemetry",
            session: event.threadId,
            date: event.ts.slice(0, 10),
            provider: event.providerInstanceId ?? "unknown",
            model: event.model ?? "unknown",
            files: event.files,
            record: isRecord,
            recorded: false,
          });
        }
        break;
      }
      case "checkpoint_rollback": {
        const checkpointId = event.checkpointId ?? event.ts;
        rollbacks.set(`${event.threadId}|${checkpointId}`, {
          threadId: event.threadId,
          checkpointId,
          date: event.ts.slice(0, 10),
        });
        break;
      }
      case "mid_thread_model_switch": {
        const from = `${event.fromProvider ?? "?"}/${event.fromModel ?? "?"}`;
        const to = `${event.toProvider ?? "?"}/${event.toModel ?? "?"}`;
        switches.set(`${event.threadId}|${from}|${to}`, { threadId: event.threadId, from, to });
        break;
      }
      case "interrupted_with_steer": {
        const key = event.interruptedRunId ?? `${event.threadId}|${event.ts}`;
        if (!interrupts.has(key)) {
          interrupts.set(key, {
            threadId: event.threadId,
            interruptedRunId: key,
            followup: squashText(event.reason ?? "", 160),
            model: `${event.providerInstanceId ?? "?"}/${event.model ?? "?"}`,
          });
        }
        break;
      }
      case "new_model_observed":
        noteModel(event.providerInstanceId, event.model);
        break;
      case "delegated_review_completed": {
        const key = event.childThreadId ?? event.threadId;
        if (!reviews.has(key)) {
          reviews.set(key, {
            threadId: key,
            title: event.title ?? "delegated review",
            model: `${event.providerInstanceId ?? "?"}/${event.model ?? "?"}`,
            excerpt: squashText(event.excerpt ?? "", 300),
          });
        }
        break;
      }
    }
  }

  let claudeSessionsScanned = 0;
  let simGateLog: GateLog | null = null;
  if (input.options.includeClaudeLogs !== false) {
    const exclude = new Set([
      ...[caller.sessionId, caller.alsoSessionId]
        .filter((id): id is string => !!id && id.startsWith("cc:"))
        .map(SimStore.bare),
      ...allT3ClaudeNativeIds,
    ]);
    const scan = scanClaudeLogs(paths, sinceMs, exclude, (file, cwd) => kindOf(file, cwd) !== null);
    excludedSelf += scan.excludedSelf;
    claudeSessionsScanned = scan.transcripts.length;
    for (const transcript of scan.transcripts) {
      const date = (transcript.lastTs ?? new Date(sinceMs).toISOString()).slice(0, 10);
      if (transcript.harnessEdits.length) {
        edits.push({
          source: "claude",
          session: transcript.sessionId,
          date,
          provider: "claudeAgent",
          model: transcript.model,
          files: transcript.harnessEdits.map((file) =>
            SimStore.resolveCallerFile(file, { sessionId: "" }, paths),
          ),
          record: false,
          recorded: writers.has(transcript.sessionId),
        });
      }
      if (transcript.flags.length) {
        flagged.push({
          source: "claude",
          session: transcript.sessionId,
          date,
          project: transcript.project,
          provider: "claudeAgent",
          model: transcript.model,
          userTurns: transcript.userTurns,
          flags: transcript.flags,
        });
      }
    }
    simGateLog = readGateLog(NodePath.join(paths.harnessDir, "state", "sim-gate.log"), sinceMs);
  }

  // Detect standing fixed observations recorded by a fork/side-chat via CLI sim.mjs (which lacks lineage awareness).
  const forkRootOf = (threadId: string): string => {
    let current = threadId;
    const visited = new Set<string>([current]);
    for (let hop = 0; hop < MAX_FORK_HOPS; hop += 1) {
      const parent = db.forkParents.get(current);
      if (!parent || visited.has(parent)) break;
      visited.add(parent);
      current = parent;
    }
    return current;
  };
  const forkSelfGrades: Array<{
    attemptId: string;
    problemId: string;
    outcomeIndex: number;
    author: string;
    observer: string;
  }> = [];
  for (const problem of state.problems) {
    for (const attempt of problem.attempts) {
      if (attempt.retracted) continue;
      const authorThreads = [attempt.by, attempt.also, attempt.sample]
        .filter((id): id is string => typeof id === "string" && id.startsWith("t3:"))
        .map((id) => id.slice(3));
      if (authorThreads.length === 0) continue;
      const authorRoots = new Set(authorThreads.map(forkRootOf));
      attempt.observations.forEach((obs, index) => {
        if (obs.retracted || obs.result !== "fixed" || obs.source === "self") return;
        const obsThreads = [obs.by, obs.also]
          .filter((id): id is string => typeof id === "string" && id.startsWith("t3:"))
          .map((id) => id.slice(3));
        if (obsThreads.some((id) => authorThreads.includes(id))) return;
        if (obsThreads.some((id) => authorRoots.has(forkRootOf(id)))) {
          forkSelfGrades.push({
            attemptId: attempt.id,
            problemId: problem.id,
            outcomeIndex: index + 1,
            author: attempt.by,
            observer: obs.by,
          });
        }
      });
    }
  }

  // SIM health
  const health = SimStore.inspectHarness(state, paths);
  const live = SimStore.allAttempts(state).filter((attempt) => attempt.live);
  const open = live.filter((attempt) => attempt.pending.length > 0 || attempt.missed.length > 0);
  const missed = live.filter((attempt) => attempt.missed.length > 0);
  const problemOf = (attemptId: string) =>
    SimStore.findAttempt(state, attemptId)?.problem.id ?? "?";
  const newModels = [...freshModels.values()];
  const escalationTelemetry: Array<SimTelemetryEvent> = [
    ...input.telemetry,
    ...newModels.map((item) => ({
      ts: new Date(sinceMs).toISOString(),
      kind: "new_model_observed" as const,
      providerInstanceId: item.providerInstanceId,
      model: item.model,
    })),
    ...edits
      .filter((edit) => !edit.record && !edit.recorded && edit.source === "t3")
      .map((edit) => ({
        ts: `${edit.date}T00:00:00.000Z`,
        kind: "unrecorded_harness_edit" as const,
        threadId: edit.session,
        files: edit.files,
      })),
  ];
  const advisorEscalation = SimStore.buildAdvisorEscalation(
    state,
    input.advisor,
    health,
    escalationTelemetry,
  );

  const sortedFlagged = flagged.sort(
    (a, b) => b.flags.length - a.flags.length || b.date.localeCompare(a.date),
  );
  const sortedEdits = edits.sort((a, b) => b.date.localeCompare(a.date));
  const out: Array<string> = [];
  const since = new Date(sinceMs).toISOString();
  out.push(`SIM Audit (window: ${input.source}, from ${since.slice(0, 16)}Z)`);
  out.push(
    `Scope: T3 threads of every provider and model${input.options.includeClaudeLogs === false ? "" : ", plus Claude Code transcripts and gate logs"}.`,
  );
  out.push(
    `T3 threads scanned: ${threadsScanned}; Claude Code sessions scanned: ${claudeSessionsScanned} (excluded ${excludedSelf} self/audit runs)`,
  );
  out.push("");
  out.push("== 1. SIM Health ==");
  if (input.broken) out.push(`CRITICAL: journal damaged (${input.broken})`);
  out.push(
    `Live rules: ${live.length} | With open predictions: ${open.length} | Live rules with misses: ${missed.length} | Drift: ${health.drift.length} | Uncovered: ${health.uncovered.length}`,
  );
  for (const item of health.drift) out.push(`  DRIFT ${item.attempt.id}: ${item.reason}`);
  for (const unit of health.uncovered)
    out.push(`  NO RECORD ${unit.file}: ${unit.text ? squashText(unit.text, 80) : "hook"}`);
  for (const attempt of missed) {
    out.push(
      `  MISSED ${attempt.id} (${problemOf(attempt.id)}) ${attempt.files[0] ?? ""}, missed: ${attempt.missed.join(", ")}`,
    );
  }
  for (const item of forkSelfGrades) {
    out.push(
      `  FORK SELF-GRADE ${item.attemptId} (${item.problemId}) outcome ${item.outcomeIndex}: fixed by ${item.observer} (same fork/side-chat family as ${item.author}; retract or verify from an independent session)`,
    );
  }
  out.push("");
  out.push("== 2. T3 Runtime Signals ==");
  out.push(
    `Checkpoint rollbacks: ${rollbacks.size} | Mid-thread model switches: ${switches.size} | Interrupted then steered: ${interrupts.size} | Delegated reviews: ${reviews.size}`,
  );
  for (const item of [...rollbacks.values()].slice(0, limit))
    out.push(`  ROLLBACK ${item.date} ${item.threadId} -> ${item.checkpointId}`);
  for (const item of [...switches.values()].slice(0, limit))
    out.push(`  SWITCH ${item.threadId}: ${item.from} -> ${item.to}`);
  for (const item of [...interrupts.values()].slice(0, limit)) {
    out.push(
      `  INTERRUPTED ${item.threadId} [${item.model}]${item.followup ? `, then: "${item.followup}"` : ""}`,
    );
  }
  for (const item of [...reviews.values()].slice(0, limit)) {
    out.push(
      `  REVIEW ${item.threadId} [${item.model}] ${squashText(item.title, 80)}${item.excerpt ? `: ${item.excerpt}` : ""}`,
    );
  }
  out.push("");
  const harnessEdits = sortedEdits.filter((edit) => !edit.record);
  const recordEdits = sortedEdits.filter((edit) => edit.record);
  out.push(`== 3. Harness Edits (${harnessEdits.length}) ==`);
  if (!harnessEdits.length) out.push("  none");
  for (const edit of harnessEdits) {
    out.push(
      `  ${edit.date} ${edit.source} ${edit.session} [${edit.provider}/${edit.model}] ${edit.recorded ? "recorded" : "UNRECORDED?"}: ${edit.files.join(", ")}`,
    );
  }
  for (const edit of recordEdits) {
    out.push(
      `  DIRECT RECORD EDIT ${edit.date} ${edit.source} ${edit.session} [${edit.provider}/${edit.model}]: ${edit.files.join(", ")}`,
    );
  }
  out.push("");
  out.push(
    `== 4. Candidate Correction / Friction Sessions (${flagged.length} total, showing ${Math.min(limit, flagged.length)}) ==`,
  );
  if (!flagged.length) out.push("  none");
  for (const session of sortedFlagged.slice(0, limit)) {
    const inspect =
      session.source === "t3"
        ? `inspect thread ${session.session}`
        : `sim-audit.mjs --session ${session.session.slice(0, 8)}`;
    out.push(
      `  ${session.date} ${session.source} ${session.session} [${session.project}, ${session.provider}/${session.model}, ${session.userTurns} user turns] -> ${inspect}`,
    );
    for (const flag of session.flags.slice(0, 3))
      out.push(`    U${flag.turn} (${flag.kind}): "${flag.excerpt}"`);
  }
  out.push("");
  out.push(`== 5. Models Not Yet In SIM (${newModels.length}) ==`);
  if (!newModels.length) out.push("  none");
  for (const item of newModels)
    out.push(
      `  ${item.model} (${item.providerInstanceId}): review live rules under it, and carry if it is a new generation`,
    );
  if (simGateLog) {
    out.push("");
    out.push("== 6. Gate Telemetry (in window) ==");
    const counts = Object.entries(simGateLog.counts)
      .map(([key, value]) => `${key}=${value}`)
      .join(", ");
    out.push(
      `sim-gate.log: ${simGateLog.present ? `${simGateLog.total} events (${counts || "none"})` : "not present yet"}`,
    );
    for (const note of simGateLog.notable.slice(-10)) {
      out.push(
        `  [${note.time.slice(0, 16)}] ${note.outcome} session=${note.session} ${note.target}`,
      );
    }
  }
  out.push("");
  out.push("== 7. Recently Changed Live Rules With Open Predictions (last 10) ==");
  for (const attempt of [...open].sort((a, b) => b.round.localeCompare(a.round)).slice(0, 10)) {
    out.push(
      `  ${attempt.id} (${problemOf(attempt.id)}, ${attempt.round}) ${attempt.files[0] ?? ""}, open: ${attempt.pending.join(", ") || "none"}`,
    );
  }
  if (advisorEscalation) {
    out.push("");
    out.push("== 8. Advisor Escalation ==");
    for (const candidate of advisorEscalation.candidates)
      out.push(`  ${candidate.kind}: ${candidate.summary}`);
    out.push(`  ${advisorEscalation.guidance}`);
  }

  return {
    text: out.join("\n"),
    window: { since, source: input.source },
    threadsScanned,
    claudeSessionsScanned,
    sim: {
      journalBroken: input.broken,
      driftCount: health.drift.length,
      uncoveredCount: health.uncovered.length,
      liveRules: live.length,
      openPredictions: open.length,
      missedLiveRules: missed.length,
    },
    signals: {
      verbalCorrections: flagged.reduce((sum, session) => sum + session.flags.length, 0),
      unrecordedHarnessEdits: harnessEdits.filter((edit) => !edit.recorded).length,
      checkpointRollbacks: rollbacks.size,
      midThreadModelSwitches: switches.size,
      interruptedWithSteer: interrupts.size,
      delegatedReviews: reviews.size,
      newlyObservedModels: newModels,
    },
    ...(advisorEscalation ? { advisorEscalation } : {}),
  };
}

function renderInspection(
  thread: ThreadRow,
  runRows: ReadonlyArray<RunRow>,
  messages: ReadonlyArray<MessageRow>,
  items: ReadonlyArray<TurnItemRow>,
  events: ReadonlyArray<EventRow>,
): string {
  const runs = runRows.map(runInfo);
  const entries: Array<{ at: string; order: number; line: string }> = [];
  let userTurn = 0;
  for (const run of runs) {
    entries.push({
      at: run.requestedAt,
      order: 0,
      line: `run ${run.ordinal} [${run.provider}/${run.model}] ${run.status}`,
    });
  }
  for (const row of messages) {
    const text = parseJson(row.payload_json).text;
    if (row.role === "user") {
      const own = extractUserText(text);
      if (!own) continue;
      userTurn += 1;
      entries.push({
        at: row.created_at,
        order: 1,
        line: `U${userTurn} [${row.created_at.slice(0, 19).replace("T", " ")}]: ${squashText(own, 600)}`,
      });
    } else {
      entries.push({ at: row.created_at, order: 3, line: `  assistant: ${squashText(text, 400)}` });
    }
  }
  for (const item of items) {
    const payload = parseJson(item.payload_json);
    const detail =
      item.type === "file_change"
        ? `file_change(${squashText(payload.fileName, 120)})`
        : item.type === "command_execution"
          ? `command(${squashText(payload.input, 120)})`
          : `${item.type}(${squashText(payload.title ?? payload.toolName ?? "", 80)})`;
    entries.push({ at: item.updated_at, order: 2, line: `  tool: ${detail}` });
  }
  for (const event of events) {
    const payload = parseJson(event.payload_json);
    const line =
      event.event_type === "checkpoint.rollback-requested"
        ? `ROLLBACK requested to ${str(payload.checkpointId) ?? "?"}`
        : `MODEL ${event.event_type}: ${str(payload.providerInstanceId) ?? "?"}/${str(record(payload.modelSelection).model) ?? "?"}`;
    entries.push({ at: event.occurred_at, order: 4, line });
  }
  entries.sort((a, b) => a.at.localeCompare(b.at) || a.order - b.order);
  const lines = entries.map((entry) => entry.line);
  const models =
    [...new Set(runs.map((run) => `${run.provider}/${run.model}`))].join(", ") ||
    thread.default_provider;
  const header = `Thread ${thread.thread_id} | ${thread.title} | models: ${models} | runs: ${runs.length} | user turns: ${userTurn}${runs.some((run) => run.status === "interrupted") ? " | has interrupted runs" : ""}`;
  const shown = lines.slice(0, INSPECT_LINES);
  return [
    header,
    ...shown,
    ...(lines.length > shown.length ? [`... (${lines.length - shown.length} more lines)`] : []),
  ].join("\n");
}
