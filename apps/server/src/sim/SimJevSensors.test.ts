// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeHttp from "node:http";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { DEFAULT_SIM_JEV_SETTINGS, type SimJevSettings } from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";

import { resolveSimPaths } from "./SimContracts.ts";
import { callJevSystemOne, readJevDailyUsage, redactForJev } from "./SimJevClient.ts";
import {
  classifyThreeZone,
  evaluateJevCalibration,
  evaluatePostTurnCompliance,
  evaluatePreTurnTriggers,
  evaluateTurnEndingSignal,
  evaluateUserCorrectionSignal,
} from "./SimJevSensors.ts";

function startMockJevServer(
  handler: (
    req: NodeHttp.IncomingMessage,
    body: { model: string; state: unknown; questions: Record<string, { type: string }> },
  ) => { status?: number; json: unknown },
): Promise<{
  readonly url: string;
  readonly close: () => Promise<void>;
  readonly calls: Array<unknown>;
}> {
  return new Promise((resolve) => {
    const calls: Array<unknown> = [];
    const server = NodeHttp.createServer((req, res) => {
      const chunks: Array<Buffer> = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
          model: string;
          state: unknown;
          questions: Record<string, { type: string }>;
        };
        calls.push({ auth: req.headers.authorization, body: parsed });
        const result = handler(req, parsed);
        res.writeHead(result.status ?? 200, { "content-type": "application/json" });
        res.end(JSON.stringify(result.json));
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      resolve({
        url: `http://127.0.0.1:${port}/v1/systemone`,
        calls,
        close: () => new Promise<void>((done) => server.close(() => done())),
      });
    });
  });
}

describe("SimJevClient and SimJevSensors", () => {
  it("redacts secrets, tokens, emails, IPs, and user home directories before sending to Jev", () => {
    const raw =
      "Check /home/alice/repo with Bearer secretTokenValue123456, key sk-abcdefghijklmnop123456, alice@example.com, 192.168.1.42";
    const redacted = redactForJev(raw);
    assert.notInclude(redacted, "alice");
    assert.notInclude(redacted, "secretTokenValue123456");
    assert.notInclude(redacted, "sk-abcdefghijklmnop123456");
    assert.notInclude(redacted, "192.168.1.42");
    assert.include(redacted, "~/repo");
    assert.include(redacted, "[REDACTED_TOKEN]");
    assert.include(redacted, "[REDACTED_EMAIL]");
    assert.include(redacted, "[REDACTED_IP]");
  });

  it("maps 3-zone thresholds and computes holdout calibration precision/recall", () => {
    const thresholds = { passBelow: 0.15, flagAbove: 0.85 };
    assert.equal(classifyThreeZone(0.08, thresholds), "passed");
    assert.equal(classifyThreeZone(0.5, thresholds), "uncertain");
    assert.equal(classifyThreeZone(0.92, thresholds), "violated");

    const report = evaluateJevCalibration(
      [
        { probability: 0.95, actualPositive: true },
        { probability: 0.9, actualPositive: true },
        { probability: 0.05, actualPositive: false },
        { probability: 0.1, actualPositive: false },
        { probability: 0.52, actualPositive: true },
      ],
      thresholds,
    );
    assert.equal(report.truePositives, 2);
    assert.equal(report.trueNegatives, 2);
    assert.equal(report.uncertainCount, 1);
    assert.equal(report.precision, 1);
    assert.equal(report.recall, 1);
    assert.equal(report.autoHandledRate, 0.8);
  });

  it("runs sensors 1, 2, and 3 against a live local HTTP System-1 server and enforces budget & exclusions", async () => {
    const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "sim-jev-e2e-"));
    const paths = resolveSimPaths({ simDir: NodePath.join(root, "sim") }, root);
    const server = await startMockJevServer((_req, body) => {
      const answers: Record<string, { type: "noul"; noul: number }> = {};
      for (const key of Object.keys(body.questions)) {
        if (
          key === "direct_question" ||
          key === "direct_answer_buried" ||
          key === "corrects_agent_mistake" ||
          key === "waiting_for_user_input"
        ) {
          answers[key] = { type: "noul", noul: 0.92 };
        } else if (key === "boilerplate_or_flattery") {
          answers[key] = { type: "noul", noul: 0.04 };
        } else if (key === "manual_terminal_handoff") {
          answers[key] = { type: "noul", noul: 0.45 };
        } else {
          answers[key] = { type: "noul", noul: 0.05 };
        }
      }
      return {
        json: {
          model: body.model,
          answers,
          usage: { input_tokens: 400, output_tokens: 0 },
        },
      };
    });

    try {
      const settings: SimJevSettings = {
        ...DEFAULT_SIM_JEV_SETTINGS,
        enabled: true,
        mode: "shadow",
        endpoint: server.url,
        apiKey: "ts_test_key_fixture",
        dailyTokenBudget: 1_500,
        excludedProjects: ["private-finance"],
      };

      // Excluded project makes zero HTTP calls.
      const skipped = await callJevSystemOne(
        { state: { prompt: "hello" }, questions: {} },
        { settings, paths, projectName: "private-finance" },
      );
      assert.equal(skipped.ok, false);
      if (!skipped.ok) assert.equal(skipped.reason, "project_excluded");
      assert.equal(server.calls.length, 0);

      // Sensor 1: Pre-turn semantic trigger router
      const triggers = await evaluatePreTurnTriggers(
        "Does TypeScript 7 run on Rust? My key sk-secret1234567890123 should be redacted.",
        { settings, paths, projectName: "demo" },
      );
      assert.isNotNull(triggers);
      assert.equal(triggers?.find((t) => t.triggerId === "jev:direct_question")?.active, true);
      // Confirm redaction happened on the wire
      assert.notInclude(JSON.stringify(server.calls[0]), "sk-secret1234567890123");

      // Sensor 2: 3-zone compliance observer
      const metrics = await evaluatePostTurnCompliance(
        {
          ts: "2026-11-19T20:00:00.000Z",
          threadId: "thread-1",
          runId: "run-1",
          providerInstanceId: "claudeAgent",
          model: "claude-opus-5-5",
          userPrompt: "Is this cached?",
          assistantReply: "## Summary\nHere is a table...\nYes.",
          toolSummary: "read_file",
          questionIds: [
            "direct_answer_buried",
            "boilerplate_or_flattery",
            "manual_terminal_handoff",
          ],
        },
        { settings, paths, projectName: "demo" },
      );
      assert.isNotNull(metrics);
      const verdicts = new Map(
        (metrics ?? []).map((m) => [
          m.kind === "observation" ? m.detectorId : "",
          m.kind === "observation" ? m.verdict : "",
        ]),
      );
      assert.equal(verdicts.get("jev:direct_answer_buried"), "violated");
      assert.equal(verdicts.get("jev:boilerplate_or_flattery"), "passed");
      assert.equal(verdicts.get("jev:manual_terminal_handoff"), "uncertain");

      // Sensor 3: Correction & Turn-Ending signals
      const correction = await evaluateUserCorrectionSignal(
        {
          ts: "2026-11-19T20:01:00.000Z",
          threadId: "thread-1",
          providerInstanceId: "claudeAgent",
          model: "claude-opus-5-5",
          previousAssistant: "I edited main.ts.",
          userMessage: "No, that was the wrong file.",
        },
        { settings, paths, projectName: "demo" },
      );
      assert.equal(correction?.flagged, true);

      const ending = await evaluateTurnEndingSignal(
        {
          ts: "2026-11-19T20:02:00.000Z",
          threadId: "thread-1",
          providerInstanceId: "claudeAgent",
          model: "claude-opus-5-5",
          assistantReply: "Should I proceed with option A or B?",
          toolSummary: "",
        },
        { settings, paths, projectName: "demo" },
      );
      assert.equal(ending?.label, "waiting_for_user");

      // Budget now hit (4 * 400 = 1600 >= 1500) -> subsequent call fails open with budget_exceeded
      const usage = readJevDailyUsage(paths.jevUsagePath);
      assert.equal(usage.inputTokens, 1_600);
      assert.equal(usage.calls, 4);
      const overBudget = await callJevSystemOne(
        { state: { prompt: "next" }, questions: {} },
        { settings, paths, projectName: "demo" },
      );
      assert.equal(overBudget.ok, false);
      if (!overBudget.ok) assert.equal(overBudget.reason, "budget_exceeded");
    } finally {
      await server.close();
    }
  });
});
