import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ScriptRunner from "./ScriptRunner.ts";

const layer = ScriptRunner.layer.pipe(Layer.provide(NodeServices.layer));

const run = (
  code: string,
  options: {
    readonly call?: ScriptRunner.ScriptToolCall;
    readonly deadline?: string;
  } = {},
) =>
  Effect.gen(function* () {
    const runner = yield* ScriptRunner.ScriptRunner;
    return yield* runner.run({
      code,
      call: options.call ?? (() => Effect.succeed(null)),
      ...(options.deadline === undefined
        ? {}
        : { deadline: options.deadline as `${number} seconds` }),
    });
  }).pipe(Effect.provide(layer));

it.live("gives programs no Node, timers, console, network, or eval", () =>
  Effect.gen(function* () {
    const result = yield* run(`
      let evalRefused = false;
      try { new Function("return 1")(); } catch { evalRefused = true; }
      text([typeof process, typeof require, typeof console, typeof fetch, typeof setTimeout, evalRefused].join());
    `);
    expect(result).toMatchObject({
      status: "completed",
      output: "undefined,undefined,undefined,undefined,undefined,true",
    });
  }),
);

it.live("caps concurrent tool calls and passes results and failures back", () =>
  Effect.gen(function* () {
    let running = 0;
    let peak = 0;
    const result = yield* run(
      `
      const settled = await Promise.allSettled(
        Array.from({ length: 40 }, (_, value) => tools.double({ value })),
      );
      text(settled.filter((entry) => entry.status === "fulfilled").map((entry) => entry.value).join());
      text(settled.find((entry) => entry.status === "rejected").reason.message);
    `,
      {
        call: (_tool, input) => {
          const value = (input as { readonly value: number }).value;
          return Effect.gen(function* () {
            running += 1;
            peak = Math.max(peak, running);
            yield* Effect.yieldNow;
            running -= 1;
            return value === 39 ? yield* Effect.fail("boom") : value * 2;
          });
        },
      },
    );
    expect(result.status).toBe("completed");
    expect(result.output.startsWith("0,2,4,")).toBe(true);
    expect(result.output.endsWith("boom")).toBe(true);
    expect(result.toolCalls).toBe(40);
    expect(result.failedToolCalls).toBe(1);
    expect(peak).toBeLessThanOrEqual(ScriptRunner.SCRIPT_MAX_CONCURRENT_TOOL_CALLS);
  }),
);

it.live.each([
  {
    name: "a throw",
    code: `text("before"); throw new Error("nope");`,
    status: "failed",
    error: "nope",
  },
  { name: "a syntax error", code: `this is not javascript`, status: "failed", error: "Unexpected" },
] as const)("reports $name with the output so far", ({ code, status, error }) =>
  Effect.gen(function* () {
    const result = yield* run(code);
    expect(result.status).toBe(status);
    expect(result.error).toContain(error);
  }),
);

it.live("kills a program stuck in a loop at the deadline and keeps its output", () =>
  Effect.gen(function* () {
    const result = yield* run(`text("started"); await tools.yield(); while (true) {}`, {
      deadline: "2 seconds",
    });
    expect(result.status).toBe("timed_out");
    expect(result.output).toBe("started");
  }),
);

it.live("truncates printed output at the cap", () =>
  Effect.gen(function* () {
    const result = yield* run(`for (let i = 0; i < 40; i++) text("x".repeat(1000));`);
    expect(result.outputTruncated).toBe(true);
    expect(result.output.length).toBe(ScriptRunner.SCRIPT_MAX_OUTPUT_CHARS);
  }),
);
