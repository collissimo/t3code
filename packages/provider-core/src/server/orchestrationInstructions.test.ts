import { assert, describe, it } from "@effect/vitest";

import {
  T3_CODE_DEVICE_TOOL_INSTRUCTIONS,
  T3_CODE_DEVICE_TOOL_INSTRUCTIONS_WITH_TOOL_SEARCH,
  T3_CODE_ORCHESTRATION_INSTRUCTIONS,
  t3AcpPromptWithInstructions,
  t3OrchestrationPrompt,
  t3OrchestrationSystemPrompt,
} from "./orchestrationInstructions.ts";

describe("T3 device instructions", () => {
  it("route device work through device_open and give Claude the line that loads the tools", () => {
    for (const intent of ["`device_list`", "`device_open`", "`agent-device`", "ssh", "`hostId`"]) {
      assert.include(T3_CODE_DEVICE_TOOL_INSTRUCTIONS, intent);
    }
    assert.notInclude(T3_CODE_DEVICE_TOOL_INSTRUCTIONS, "ToolSearch");
    const loadLine =
      " Load them with ToolSearch `select:mcp__t3-code__device_list,mcp__t3-code__device_open,mcp__t3-code__device_screenshot,mcp__t3-code__device_close`.";
    assert.include(T3_CODE_DEVICE_TOOL_INSTRUCTIONS_WITH_TOOL_SEARCH, loadLine);
    assert.equal(
      T3_CODE_DEVICE_TOOL_INSTRUCTIONS_WITH_TOOL_SEARCH.replace(loadLine, ""),
      T3_CODE_DEVICE_TOOL_INSTRUCTIONS,
    );
  });

  it("open the app before the returned command's snapshots, screenshots and input", () => {
    assert.include(
      T3_CODE_DEVICE_TOOL_INSTRUCTIONS,
      "its snapshots, screenshots and input need `open <app>` first,",
    );
  });

  it("keep the failure rule from taking over or closing a session another thread holds", () => {
    // agent-device's DEVICE_IN_USE advice is to rerun with the owner's --session or close it first.
    assert.include(
      T3_CODE_DEVICE_TOOL_INSTRUCTIONS,
      "follow its advice once, but never reuse or close another session; if it still fails,",
    );
  });

  it("reach OpenCode and Cursor only when the session holds device access", () => {
    assert.include(t3OrchestrationSystemPrompt(true, true), T3_CODE_DEVICE_TOOL_INSTRUCTIONS);
    assert.notInclude(t3OrchestrationSystemPrompt(true, false), "## T3 Code devices");
    assert.isUndefined(t3OrchestrationSystemPrompt(false, true));

    const firstRun = (hasDeviceTools: boolean) =>
      t3OrchestrationPrompt({
        prompt: "Check the login screen.",
        hasT3Mcp: true,
        hasDeviceTools,
        orchestrationDelivered: false,
        deviceInstructionsDelivered: false,
      });
    assert.include(firstRun(true), T3_CODE_DEVICE_TOOL_INSTRUCTIONS);
    assert.notInclude(firstRun(false), "## T3 Code devices");

    const laterRun = (deviceInstructionsDelivered: boolean) =>
      t3OrchestrationPrompt({
        prompt: "Check the login screen.",
        hasT3Mcp: true,
        hasDeviceTools: true,
        orchestrationDelivered: true,
        deviceInstructionsDelivered,
      });
    assert.include(laterRun(false), T3_CODE_DEVICE_TOOL_INSTRUCTIONS);
    assert.notInclude(laterRun(false), T3_CODE_ORCHESTRATION_INSTRUCTIONS.trim());
    assert.equal(laterRun(true), "Check the login screen.");

    // A provider's own guidance reaches a conversation that already had the rest.
    const providerRun = (providerInstructionsDelivered: boolean) =>
      t3OrchestrationPrompt({
        prompt: "Check the login screen.",
        hasT3Mcp: true,
        hasDeviceTools: false,
        orchestrationDelivered: true,
        deviceInstructionsDelivered: false,
        providerInstructions: "Mark awaited shells.",
        providerInstructionsDelivered,
      });
    assert.include(providerRun(false), "Mark awaited shells.");
    assert.notInclude(providerRun(false), T3_CODE_ORCHESTRATION_INSTRUCTIONS.trim());
    assert.equal(providerRun(true), "Check the login screen.");
  });

  it("reach ACP agents again when device access changes mid-thread", () => {
    const state = { interactionMode: "default", hasT3Mcp: true, hasDeviceTools: false } as const;
    const withDevices = t3AcpPromptWithInstructions({
      prompt: "Check the login screen.",
      state: { ...state, hasDeviceTools: true },
      previousState: state,
    });
    assert.include(withDevices, T3_CODE_DEVICE_TOOL_INSTRUCTIONS);
    assert.equal(
      t3AcpPromptWithInstructions({ prompt: "Again.", state, previousState: state }),
      "Again.",
    );
    assert.notInclude(t3AcpPromptWithInstructions({ prompt: "Hi.", state }), "## T3 Code devices");
  });
});

describe("ACP thread instructions", () => {
  const base = { interactionMode: "default", hasT3Mcp: true, hasDeviceTools: false } as const;
  const rules = "## Thread rules\n\nAlways run the focused tests.";

  it("add nothing to the ACP prompt when a thread has no instructions", () => {
    const plain = t3AcpPromptWithInstructions({ prompt: "Hi.", state: base });
    assert.match(
      plain,
      /"clientRequestId":"\.\.\."\}'`\.\n<\/t3_code_instructions>\n\n<user_request>\nHi\.\n<\/user_request>$/,
    );
    assert.notInclude(plain, "T3 thread instructions");
    for (const threadInstructions of [undefined, ""]) {
      assert.equal(
        t3AcpPromptWithInstructions({ prompt: "Hi.", state: { ...base, threadInstructions } }),
        plain,
      );
      assert.equal(
        t3AcpPromptWithInstructions({
          prompt: "Hi.",
          state: { ...base, threadInstructions },
          previousState: base,
        }),
        "Hi.",
      );
    }
  });

  it("deliver once, then again only when they change or are removed", () => {
    const state = { ...base, threadInstructions: rules };
    const first = t3AcpPromptWithInstructions({ prompt: "Go.", state });
    assert.include(first, `\n\n${rules}\n</t3_code_instructions>`);
    assert.notInclude(first, "replace earlier");

    assert.equal(
      t3AcpPromptWithInstructions({ prompt: "Again.", state, previousState: state }),
      "Again.",
    );

    const changed = t3AcpPromptWithInstructions({
      prompt: "Next.",
      state: { ...base, threadInstructions: "## Thread rules\n\nNew rule." },
      previousState: state,
    });
    assert.include(
      changed,
      "The following T3 thread instructions replace earlier T3 thread instructions:\n## Thread rules\n\nNew rule.\n</t3_code_instructions>",
    );

    const removed = t3AcpPromptWithInstructions({
      prompt: "Done.",
      state: base,
      previousState: state,
    });
    assert.include(
      removed,
      "Earlier T3 thread instructions no longer apply.\n</t3_code_instructions>",
    );
    assert.notInclude(removed, rules);
  });

  it("resend unchanged thread instructions without a replacement notice when the mode changes", () => {
    const state = { ...base, threadInstructions: rules };
    const planned = t3AcpPromptWithInstructions({
      prompt: "Plan.",
      state: { ...state, interactionMode: "plan" },
      previousState: state,
    });
    assert.include(planned, rules);
    assert.notInclude(planned, "replace earlier");
  });
});
