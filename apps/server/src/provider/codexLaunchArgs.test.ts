import * as NodeAssert from "node:assert/strict";

import { describe, it } from "vite-plus/test";

import { codexAppServerArgs, codexExecLaunchArgs } from "./codexLaunchArgs.ts";

describe("codexAppServerArgs", () => {
  it("preserves escaped TOML quotes in config values", () => {
    NodeAssert.deepStrictEqual(
      codexAppServerArgs(String.raw`--config model=\"gpt-6.1-sol\" --strict-config`),
      ["app-server", "--config", 'model="gpt-6.1-sol"', "--strict-config"],
    );
  });
});

describe("codexAppServerArgs code mode", () => {
  it("enables code mode before launch args, so a user's --disable still wins", () => {
    NodeAssert.deepStrictEqual(codexAppServerArgs("--disable code_mode", { codeMode: true }), [
      "app-server",
      "--enable",
      "code_mode",
      "-c",
      "suppress_unstable_features_warning=true",
      "--disable",
      "code_mode",
    ]);
    NodeAssert.deepStrictEqual(codexAppServerArgs("", { codeMode: false }), ["app-server"]);
  });
});

describe("codexExecLaunchArgs", () => {
  it("keeps shared codex flags and omits app-server-only flags", () => {
    NodeAssert.deepStrictEqual(
      codexExecLaunchArgs('--strict-config --enable foo --listen off --config model="gpt 5"'),
      ["--strict-config", "--enable", "foo", "--config", "model=gpt 5"],
    );
  });

  it("does not pair value-taking flags with adjacent flags", () => {
    NodeAssert.deepStrictEqual(codexExecLaunchArgs("--config --strict-config --enable --disable"), [
      "--strict-config",
    ]);
  });
});
