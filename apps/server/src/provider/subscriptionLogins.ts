import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { resolveClaudeHomePath } from "./Drivers/ClaudeHome.ts";

const ClaudeCredentials = Schema.Struct({
  claudeAiOauth: Schema.optional(
    Schema.Struct({
      accessToken: Schema.optional(Schema.String),
      expiresAt: Schema.optional(Schema.Finite),
    }),
  ),
});
/** Codex writes `tokens` only for ChatGPT sign-ins; API-key sign-ins omit it. */
const CodexAuth = Schema.Struct({
  tokens: Schema.optional(
    Schema.Struct({
      access_token: Schema.optional(Schema.String),
      account_id: Schema.optional(Schema.String),
    }),
  ),
});

export const readJsonFile = Effect.fn("subscriptionLogins.readJsonFile")(function* <
  S extends Schema.Top,
>(schema: S, file: string) {
  const fs = yield* FileSystem.FileSystem;
  return yield* fs.readFileString(file).pipe(
    Effect.catchTags({
      PlatformError: (error) =>
        error.reason._tag === "NotFound" ? Effect.succeed("{}") : Effect.fail(error),
    }),
    Effect.flatMap(Schema.decodeEffect(Schema.fromJsonString(schema))),
  );
});

/** macOS keeps the Claude Code sign-in in the keychain, so there is no file to read there. */
export const readClaudeLogin = Effect.fn("subscriptionLogins.readClaudeLogin")(function* (
  configDir: string,
) {
  if ((yield* HostProcess.Platform) === "darwin") return undefined;
  const path = yield* Path.Path;
  const { claudeAiOauth } = yield* readJsonFile(
    ClaudeCredentials,
    path.join(configDir, ".credentials.json"),
  );
  const accessToken = claudeAiOauth?.accessToken?.trim();
  return accessToken ? { accessToken, expiresAt: claudeAiOauth?.expiresAt } : undefined;
});

export const readCodexChatGptLogin = Effect.fn("subscriptionLogins.readCodexChatGptLogin")(
  function* (codexHome: string) {
    const path = yield* Path.Path;
    const { tokens } = yield* readJsonFile(CodexAuth, path.join(codexHome, "auth.json"));
    const accessToken = tokens?.access_token?.trim();
    const accountId = tokens?.account_id?.trim();
    return accessToken && accountId ? { accessToken, accountId } : undefined;
  },
);

/** The sign-ins a plain `claude` or `codex` in this server's environment would use. */
export const defaultSubscriptionHomes = Effect.fn("subscriptionLogins.defaultHomes")(function* () {
  const path = yield* Path.Path;
  const env = yield* HostProcess.Environment;
  const home = yield* HostProcess.HomeDirectory;
  return {
    claude: yield* resolveClaudeHomePath({ homePath: "" }, env),
    codex: path.resolve(env.CODEX_HOME?.trim() || path.join(home, ".codex")),
  };
});
