import { DictationError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

// The speech model is never downloaded here. Hex (the Windows build of voice-control) and
// Scrawl install Parakeet as a .gguf file; dictation picks it up from their folders. Any other
// model transcribe.cpp runs goes into ~/.t3/dictation/models ($T3CODE_HOME/dictation/models).
export function modelDirectories(env: NodeJS.ProcessEnv, path: Path.Path): ReadonlyArray<string> {
  const dirs: Array<string> = [];
  const home = env.USERPROFILE || env.HOME;
  const t3Home = env.T3CODE_HOME?.trim() || (home ? path.join(home, ".t3") : undefined);
  if (t3Home) dirs.push(path.join(t3Home, "dictation", "models"));
  if (env.APPDATA) dirs.push(path.join(env.APPDATA, "voice-control", "models"));
  if (env.LOCALAPPDATA) dirs.push(path.join(env.LOCALAPPDATA, "Scrawl", "models"));
  return dirs;
}

const EUROPEAN = "bg hr cs da nl en et fi fr de el hu it lv lt mt pl pt ro sk sl es sv ru uk";

const VAD_MODEL = /^silero.*\.gguf$/i;

/**
 * Known models, best first. Behind the Silero gate all three get about 13% of real German dictation
 * wrong, but only Canary 1B v2 writes nothing for room tone without it, so noise that slips through
 * stays harmless; Cohere invents the most. Cohere and Canary cannot detect the language, so the
 * client always sends one.
 */
const KNOWN_MODELS: ReadonlyArray<{
  readonly matches: (name: string) => boolean;
  readonly languages: ReadonlyArray<string> | "any";
}> = [
  { matches: (name) => name.startsWith("canary-1b-v2"), languages: EUROPEAN.split(" ") },
  { matches: (name) => name.startsWith("parakeet-unified-en"), languages: ["en"] },
  {
    matches: (name) => name.startsWith("parakeet") && name.includes("v3"),
    languages: EUROPEAN.split(" "),
  },
  { matches: (name) => name.startsWith("parakeet"), languages: ["en"] },
  {
    matches: (name) => name.startsWith("cohere-transcribe") && !name.includes("arabic"),
    languages: "en fr de es it pt nl pl el ar ja zh vi ko".split(" "),
  },
  { matches: (name) => name.includes("whisper") && /[.-]en[.-]/.test(name), languages: ["en"] },
  { matches: (name) => name.includes("whisper"), languages: "any" },
];

/**
 * The models that can transcribe `language`, best first. A model not in KNOWN_MODELS only gets
 * English. Without a language, models that detect it (Parakeet v3, Whisper) come first.
 */
export function rankModels(
  paths: ReadonlyArray<string>,
  language: string | undefined,
  basename: (path: string) => string,
): ReadonlyArray<string> {
  const code = language?.toLowerCase().split(/[-_]/)[0] || undefined;
  const rank = (path: string): number | undefined => {
    const name = basename(path).toLowerCase();
    const known = KNOWN_MODELS.findIndex((model) => model.matches(name));
    if (known === -1) return code === undefined || code === "en" ? KNOWN_MODELS.length : undefined;
    const { languages } = KNOWN_MODELS[known]!;
    if (code === undefined) {
      const detects = languages === "any" || name.includes("v3");
      return detects ? known : known + KNOWN_MODELS.length;
    }
    return languages === "any" || languages.includes(code) ? known : undefined;
  };
  return paths
    .map((path) => ({ path, rank: rank(path) }))
    .filter((entry): entry is { path: string; rank: number } => entry.rank !== undefined)
    .toSorted((left, right) => left.rank - right.rank || left.path.localeCompare(right.path))
    .map((entry) => entry.path);
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
      if (name.toLowerCase().endsWith(".gguf") && !VAD_MODEL.test(name)) {
        found.push(path.join(directory, name));
      }
    }
  }
  const [best] = rankModels(found, input.language, (file) => path.basename(file));
  if (best === undefined) {
    return yield* new DictationError({
      reason:
        `No speech model${input.language ? ` for "${input.language}"` : ""} found. ` +
        `Install Parakeet v3 with Scrawl or Hex, put a transcribe.cpp .gguf into the first ` +
        `folder below, or set T3CODE_DICTATION_MODEL. Searched: ` +
        (input.directories.join(", ") || "nothing"),
    });
  }
  return best;
});

/** The Silero model in the first folder that has one. */
export const findVadModel = Effect.fn("dictation.findVadModel")(function* (
  directories: ReadonlyArray<string>,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  for (const directory of directories) {
    const names = yield* fs.readDirectory(directory).pipe(Effect.orElseSucceed(() => []));
    const name = names.toSorted().find((candidate) => VAD_MODEL.test(candidate));
    if (name !== undefined) return path.join(directory, name);
  }
  return undefined;
});
