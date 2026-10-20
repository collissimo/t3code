import { DictationError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

// The speech model is never downloaded here. Hex (the Windows build of voice-control) and
// Scrawl install Parakeet as a .gguf file; dictation picks it up from their folders.
export function modelDirectories(env: NodeJS.ProcessEnv, path: Path.Path): ReadonlyArray<string> {
  const dirs: Array<string> = [];
  if (env.APPDATA) dirs.push(path.join(env.APPDATA, "voice-control", "models"));
  if (env.LOCALAPPDATA) dirs.push(path.join(env.LOCALAPPDATA, "Scrawl", "models"));
  return dirs;
}

const nameParts = (name: string) => name.toLowerCase().replace(/[_.]/g, "-").split("-");
const isEnglishOnly = (name: string) => {
  const parts = nameParts(name);
  return parts.includes("en") || parts.includes("v2");
};
const isMultilingual = (name: string) => {
  const lowered = name.toLowerCase();
  return !isEnglishOnly(name) && (lowered.includes("v3") || lowered.includes("whisper"));
};

/**
 * The models that can transcribe `language`, best first. English prefers Parakeet Unified
 * English, then any Parakeet. Every other language needs a model whose name says it is
 * multilingual (Parakeet v3 covers 25 European languages, or Whisper); Parakeet Unified English
 * and Parakeet v2 never get German speech. Without a language, multilingual models come first.
 */
export function rankModels(
  paths: ReadonlyArray<string>,
  language: string | undefined,
  basename: (path: string) => string,
): ReadonlyArray<string> {
  const english = language?.toLowerCase().startsWith("en") ?? false;
  const rank = (path: string): ReadonlyArray<boolean | string> => {
    const name = basename(path).toLowerCase();
    return [
      !name.startsWith("parakeet"),
      !(english && name.includes("unified-en")),
      !(!english && name.includes("v3")),
      name,
    ];
  };
  const compare = (left: string, right: string) => {
    const a = rank(left);
    const b = rank(right);
    for (let index = 0; index < a.length; index++) {
      if (a[index]! < b[index]!) return -1;
      if (a[index]! > b[index]!) return 1;
    }
    return 0;
  };
  return paths.filter((path) => english || isMultilingual(basename(path))).toSorted(compare);
}

/** The model file to load: `configured` when set, else the best one Hex or Scrawl installed. */
export const findModel = Effect.fn("dictation.findModel")(function* (input: {
  readonly language: string | undefined;
  readonly configured: string | undefined;
  readonly directories: ReadonlyArray<string>;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  if (input.configured) {
    const exists = yield* fs.exists(input.configured).pipe(Effect.orElseSucceed(() => false));
    if (!exists) {
      return yield* new DictationError({
        reason: `Speech model not found: ${input.configured}`,
      });
    }
    return input.configured;
  }
  const found: Array<string> = [];
  for (const directory of input.directories) {
    const names = yield* fs.readDirectory(directory).pipe(Effect.orElseSucceed(() => []));
    for (const name of names) {
      if (name.toLowerCase().endsWith(".gguf")) found.push(path.join(directory, name));
    }
  }
  const [best] = rankModels(found, input.language, (file) => path.basename(file));
  if (best === undefined) {
    return yield* new DictationError({
      reason:
        `No Parakeet model${input.language ? ` for "${input.language}"` : ""} found. ` +
        `Install Parakeet v3 with Scrawl or Hex, or set T3CODE_DICTATION_MODEL. Searched: ` +
        (input.directories.join(", ") || "nothing"),
    });
  }
  return best;
});
