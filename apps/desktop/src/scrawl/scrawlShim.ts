// The command an agent runs. `t3.cmd` cannot serve here: it starts the app as plain Node, which has
// no video decoder. Not called `scrawl`, so the real Scrawl app stays what that name finds on PATH.

export const SCRAWL_CLI_FLAG = "--scrawl";

const MOVED = "T3 Code has moved or been removed. Open the app once to update this command.";
const MARKER = "Written by T3 Code: looks closer at and exports Scrawl captures.";

export const scrawlShimName = (platform: NodeJS.Platform) =>
  platform === "win32" ? "t3-scrawl.cmd" : "t3-scrawl";

const cmdText = (value: string) => value.replaceAll("%", "%%");
const cmdWord = (value: string) => `"${cmdText(value)}"`;
const shellWord = (value: string) => `'${value.replaceAll("'", `'"'"'`)}'`;

export const renderScrawlShim = (input: {
  readonly platform: NodeJS.Platform;
  readonly executable: string;
  readonly t3Home: string;
}) => {
  if (input.platform !== "win32") {
    return [
      "#!/bin/sh",
      `# ${MARKER}`,
      `home=${shellWord(input.t3Home)}`,
      'export T3CODE_HOME="${T3CODE_HOME:-$home}"',
      "unset ELECTRON_RUN_AS_NODE",
      `app=${shellWord(input.executable)}`,
      'if [ ! -x "$app" ]; then',
      `  echo "${MOVED}" >&2`,
      "  exit 127",
      "fi",
      `exec "$app" ${SCRAWL_CLI_FLAG} "$@"`,
      "",
    ].join("\n");
  }
  const utf8 = [input.executable, input.t3Home].some((value) =>
    [...value].some((character) => character.codePointAt(0)! > 0x7f),
  );
  const restore = utf8 ? ["chcp %t3_codepage% >nul"] : [];
  return [
    "@echo off",
    `rem ${MARKER}`,
    "setlocal EnableExtensions DisableDelayedExpansion",
    ...(utf8
      ? [`for /f "tokens=2 delims=:." %%c in ('chcp') do set "t3_codepage=%%c"`, "chcp 65001 >nul"]
      : []),
    `if not defined T3CODE_HOME set "T3CODE_HOME=${cmdText(input.t3Home)}"`,
    // Agents can inherit this from a server the app runs as Node, and it would make this Node too.
    'set "ELECTRON_RUN_AS_NODE="',
    `if exist ${cmdWord(input.executable)} goto run`,
    ...restore,
    `echo ${MOVED} 1>&2`,
    "exit /b 127",
    ":run",
    `${cmdWord(input.executable)} ${SCRAWL_CLI_FLAG} %*`,
    'set "t3_exit=%ERRORLEVEL%"',
    ...restore,
    "exit /b %t3_exit%",
    "",
  ].join("\r\n");
};
