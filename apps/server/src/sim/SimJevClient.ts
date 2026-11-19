// @effect-diagnostics nodeBuiltinImport:off globalDate:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import {
  DEFAULT_SIM_JEV_ENDPOINT,
  DEFAULT_SIM_JEV_MODEL,
  type SimJevSettings,
} from "@t3tools/contracts";

import type { SimResolvedPaths } from "./SimContracts.ts";

export interface JevNoulQuestion {
  readonly type: "noul";
  readonly instructions: string;
  readonly criteria: { readonly true: string; readonly false: string };
}

export interface JevChoiceQuestion {
  readonly type: "choice";
  readonly instructions: string;
  readonly criteria: Readonly<Record<string, string>>;
}

export type JevQuestion = JevNoulQuestion | JevChoiceQuestion;

export interface JevNoulAnswer {
  readonly type: "noul";
  readonly noul: number;
}

export interface JevChoiceAnswer {
  readonly type: "choice";
  readonly choice: string;
  readonly confidence: number;
  readonly probabilities: Readonly<Record<string, number>>;
}

export type JevAnswer = JevNoulAnswer | JevChoiceAnswer;

export interface JevSystemOneRequest {
  readonly model: string;
  readonly state: unknown;
  readonly questions: Readonly<Record<string, JevQuestion>>;
}

export interface JevSystemOneResponse {
  readonly model: string;
  readonly answers: Readonly<Record<string, JevAnswer>>;
  readonly usage: {
    readonly input_tokens: number;
    readonly output_tokens: number;
  };
}

export interface JevDailyUsage {
  readonly day: string;
  readonly inputTokens: number;
  readonly calls: number;
}

export interface JevCallOptions {
  readonly settings: SimJevSettings;
  readonly resolvedApiKey?: string | undefined;
  readonly paths?: Pick<SimResolvedPaths, "jevUsagePath"> | undefined;
  readonly projectName?: string | undefined;
  readonly fetchImpl?: typeof fetch | undefined;
  readonly now?: () => Date;
}

export type JevCallResult =
  | { readonly ok: true; readonly response: JevSystemOneResponse }
  | {
      readonly ok: false;
      readonly reason:
        | "disabled"
        | "missing_key"
        | "project_excluded"
        | "budget_exceeded"
        | "http_error"
        | "invalid_response"
        | "network_error";
      readonly detail: string;
    };

const SECRET_REDACTION_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  [
    /-----BEGIN [A-Z0-9 ]+ PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]+ PRIVATE KEY-----/g,
    "[REDACTED_PRIVATE_KEY]",
  ],
  [
    /\b(?:sk|pk|rk|ak|ghp|gho|ghu|ghs|ghr|github_pat|xox[baprs]|AIza|ts_[a-zA-Z0-9]+)[-_A-Za-z0-9]{12,}\b/g,
    "[REDACTED_TOKEN]",
  ],
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/gi, "Bearer [REDACTED_TOKEN]"],
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, "[REDACTED_JWT]"],
  [/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, "[REDACTED_EMAIL]"],
  [/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, "[REDACTED_IP]"],
  [/\/(?:home|Users)\/[A-Za-z0-9._-]+\//g, "~/"],
  [/[A-Za-z]:\\Users\\[A-Za-z0-9._-]+\\/g, "~\\"],
];

/** Strip tokens, private keys, emails, IPs, and user home directory names before sending text to Jev. */
export function redactForJev(text: string, maxChars = 4_000): string {
  let clean = text;
  for (const [pattern, replacement] of SECRET_REDACTION_PATTERNS) {
    clean = clean.replace(pattern, replacement);
  }
  clean = clean.replace(/\s+/g, " ").trim();
  return clean.length > maxChars ? `${clean.slice(0, maxChars - 1)}…` : clean;
}

function isProjectExcludedFromJev(
  settings: Pick<SimJevSettings, "excludedProjects">,
  projectName?: string,
): boolean {
  if (!projectName?.trim() || settings.excludedProjects.length === 0) return false;
  const target = projectName.trim().toLowerCase();
  return settings.excludedProjects.some((entry) => entry.trim().toLowerCase() === target);
}

const utcDay = (now: Date) => now.toISOString().slice(0, 10);

export function readJevDailyUsage(usagePath: string, now: Date = new Date()): JevDailyUsage {
  const day = utcDay(now);
  try {
    const parsed = JSON.parse(NodeFS.readFileSync(usagePath, "utf8")) as Partial<JevDailyUsage>;
    if (
      parsed.day === day &&
      typeof parsed.inputTokens === "number" &&
      typeof parsed.calls === "number"
    ) {
      return {
        day,
        inputTokens: Math.max(0, parsed.inputTokens),
        calls: Math.max(0, parsed.calls),
      };
    }
  } catch {
    // Missing or corrupt usage file starts fresh for the day.
  }
  return { day, inputTokens: 0, calls: 0 };
}

function recordJevDailyUsage(
  usagePath: string,
  inputTokens: number,
  now: Date = new Date(),
): JevDailyUsage {
  const current = readJevDailyUsage(usagePath, now);
  const next: JevDailyUsage = {
    day: current.day,
    inputTokens: current.inputTokens + Math.max(0, Math.trunc(inputTokens)),
    calls: current.calls + 1,
  };
  try {
    NodeFS.mkdirSync(NodePath.dirname(usagePath), { recursive: true });
    const tmp = `${usagePath}.tmp.${process.pid}`;
    NodeFS.writeFileSync(tmp, `${JSON.stringify(next)}\n`, "utf8");
    NodeFS.renameSync(tmp, usagePath);
  } catch {
    // Non-fatal: budget tracking never breaks callers.
  }
  return next;
}

function sumTolerance(values: ReadonlyArray<number>): number {
  const rounded = values.every((v) => Math.abs(v * 100 - Math.round(v * 100)) < 1e-9);
  return rounded ? values.length * 0.005 + 1e-9 : 1e-4;
}

function validateJevResponse(
  raw: unknown,
  expectedModel: string,
  questions: Readonly<Record<string, JevQuestion>>,
): JevSystemOneResponse | string {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return "Response is not a JSON object";
  }
  const obj = raw as Record<string, unknown>;
  if (typeof obj.model !== "string" || obj.model.trim() === "") {
    return "Missing model in response";
  }
  if (obj.model !== expectedModel) {
    return `Unexpected Jev model: ${obj.model} (expected ${expectedModel})`;
  }
  const usage = obj.usage as Record<string, unknown> | undefined;
  if (
    !usage ||
    typeof usage !== "object" ||
    typeof usage.input_tokens !== "number" ||
    !Number.isInteger(usage.input_tokens) ||
    usage.input_tokens < 0 ||
    typeof usage.output_tokens !== "number" ||
    !Number.isInteger(usage.output_tokens) ||
    usage.output_tokens < 0
  ) {
    return "Invalid usage block in Jev response";
  }
  const rawAnswers = obj.answers as Record<string, unknown> | undefined;
  if (!rawAnswers || typeof rawAnswers !== "object" || Array.isArray(rawAnswers)) {
    return "Missing answers object in Jev response";
  }
  const answers: Record<string, JevAnswer> = {};
  for (const [key, spec] of Object.entries(questions)) {
    const candidate = rawAnswers[key] as Record<string, unknown> | undefined;
    if (!candidate || typeof candidate !== "object") {
      return `Missing answer for question "${key}"`;
    }
    if (spec.type === "noul") {
      if (
        candidate.type !== "noul" ||
        typeof candidate.noul !== "number" ||
        !Number.isFinite(candidate.noul) ||
        candidate.noul < 0 ||
        candidate.noul > 1
      ) {
        return `Invalid noul answer for question "${key}"`;
      }
      answers[key] = { type: "noul", noul: candidate.noul };
    } else {
      const options = Object.keys(spec.criteria);
      const probs = candidate.probabilities as Record<string, unknown> | undefined;
      if (
        candidate.type !== "choice" ||
        typeof candidate.choice !== "string" ||
        !options.includes(candidate.choice) ||
        typeof candidate.confidence !== "number" ||
        !Number.isFinite(candidate.confidence) ||
        candidate.confidence < 0 ||
        candidate.confidence > 1 ||
        !probs ||
        typeof probs !== "object"
      ) {
        return `Invalid choice answer for question "${key}"`;
      }
      const parsedProbs: Record<string, number> = {};
      for (const option of options) {
        const value = probs[option];
        if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
          return `Invalid probability for "${key}.${option}"`;
        }
        parsedProbs[option] = value;
      }
      const values = Object.values(parsedProbs);
      const sum = values.reduce((acc, v) => acc + v, 0);
      if (Math.abs(sum - 1) > sumTolerance(values)) {
        return `Choice probabilities for "${key}" do not sum to 1 (${sum.toFixed(4)})`;
      }
      answers[key] = {
        type: "choice",
        choice: candidate.choice,
        confidence: candidate.confidence,
        probabilities: parsedProbs,
      };
    }
  }
  return {
    model: obj.model,
    answers,
    usage: {
      input_tokens: usage.input_tokens,
      output_tokens: usage.output_tokens,
    },
  };
}

function resolveJevApiKey(
  settings: Pick<SimJevSettings, "apiKey">,
  explicitResolvedKey?: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  if (explicitResolvedKey?.trim()) return explicitResolvedKey.trim();
  if (typeof settings.apiKey === "string" && settings.apiKey.trim()) {
    return settings.apiKey.trim();
  }
  return env.TYPESAFE_API_KEY?.trim() ?? "";
}

/**
 * Call TypeSafe Jev `/v1/systemone` with strict schema checks, fail-open timeouts, project
 * exclusion, and UTC daily input-token budget enforcement.
 */
export async function callJevSystemOne(
  request: {
    readonly state: unknown;
    readonly questions: Readonly<Record<string, JevQuestion>>;
  },
  options: JevCallOptions,
): Promise<JevCallResult> {
  const { settings } = options;
  if (!settings.enabled) {
    return { ok: false, reason: "disabled", detail: "SIM Jev is disabled in settings" };
  }
  if (isProjectExcludedFromJev(settings, options.projectName)) {
    return {
      ok: false,
      reason: "project_excluded",
      detail: `Project "${options.projectName}" is excluded from SIM Jev`,
    };
  }
  const apiKey = resolveJevApiKey(settings, options.resolvedApiKey);
  if (!apiKey) {
    return { ok: false, reason: "missing_key", detail: "No TypeSafe Jev API key configured" };
  }
  const now = options.now?.() ?? new Date();
  if (options.paths && settings.dailyTokenBudget > 0) {
    const usage = readJevDailyUsage(options.paths.jevUsagePath, now);
    if (usage.inputTokens >= settings.dailyTokenBudget) {
      return {
        ok: false,
        reason: "budget_exceeded",
        detail: `Daily Jev token budget reached (${usage.inputTokens}/${settings.dailyTokenBudget})`,
      };
    }
  }

  const model = settings.model.trim() || DEFAULT_SIM_JEV_MODEL;
  const endpoint = settings.endpoint.trim() || DEFAULT_SIM_JEV_ENDPOINT;
  const payload: JevSystemOneRequest = {
    model,
    state: request.state,
    questions: request.questions,
  };
  const fetcher = options.fetchImpl ?? globalThis.fetch;

  let response: Response;
  try {
    response = await fetcher(endpoint, {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(settings.timeoutMs),
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(payload),
    });
  } catch (error) {
    return {
      ok: false,
      reason: "network_error",
      detail: error instanceof Error ? error.message : String(error),
    };
  }

  if (!response.ok) {
    return {
      ok: false,
      reason: "http_error",
      detail: `TypeSafe Jev HTTP ${response.status}`,
    };
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch (error) {
    return {
      ok: false,
      reason: "invalid_response",
      detail: `Failed to parse JSON: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  const validated = validateJevResponse(body, model, request.questions);
  if (typeof validated === "string") {
    return { ok: false, reason: "invalid_response", detail: validated };
  }
  if (options.paths) {
    recordJevDailyUsage(options.paths.jevUsagePath, validated.usage.input_tokens, now);
  }
  return { ok: true, response: validated };
}
