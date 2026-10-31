// @effect-diagnostics nodeBuiltinImport:off -- Real folders on disk are what these tests are about.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";

import {
  PINNED_FILE,
  REBUILT_ONCE_FILE,
  UNFINISHED_FILE,
  idTimeMs,
  planRebuilds,
  planRetention,
  readCaptureFolder,
  readCaptureFolders,
  removeJournal,
  retentionDates,
  type CaptureFolder,
} from "./captureStore.ts";

const DAY_MS = 24 * 60 * 60 * 1000;
const CREATED_AT = Date.UTC(2026, 0, 1);

const capture = (overrides: Partial<CaptureFolder> = {}): CaptureFolder => ({
  id: "scrawl-a-0",
  folder: "/captures/scrawl-a-0.scrawl",
  built: true,
  videoBytes: 100,
  tried: false,
  pinned: false,
  journaled: false,
  journal: null,
  createdAtMs: CREATED_AT,
  changedAtMs: CREATED_AT,
  durationMs: 1_000,
  app: "",
  windowTitle: "",
  sizeBytes: 200,
  mediaBytes: 100,
  mediaItems: ["recording.mp4", "audio.wav"],
  ...overrides,
});

const temporaryFolders: Array<string> = [];
const makeCapturesDir = async () => {
  const dir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "scrawl-store-"));
  temporaryFolders.push(dir);
  return dir;
};
const makeBundle = async (dir: string, id: string, files: Record<string, string>) => {
  const folder = NodePath.join(dir, `${id}.scrawl`);
  await NodeFSP.mkdir(folder);
  for (const [name, text] of Object.entries(files)) {
    await NodeFSP.writeFile(NodePath.join(folder, name), text);
  }
  return folder;
};

afterEach(async () => {
  await Promise.all(
    temporaryFolders.splice(0).map((dir) => NodeFSP.rm(dir, { recursive: true, force: true })),
  );
});

describe("planRebuilds", () => {
  it("rebuilds a capture without a manifest once, and never the one recording", async () => {
    const dir = await makeCapturesDir();
    const journal = JSON.stringify({
      session: {
        id: "scrawl-crashed-0",
        sourceId: "screen:0",
        width: 100,
        height: 100,
        startedAtMs: CREATED_AT,
        app: "Figma",
        windowTitle: "Board",
        bundlePath: "x",
      },
      input: {
        events: [{ kind: "click", t: 5, x: 0.1, y: 0.2 }],
        strokes: [],
        cursor: [],
        windows: [],
        flags: [],
      },
    });
    await makeBundle(dir, "scrawl-crashed-0", {
      [UNFINISHED_FILE]: journal,
      "recording.mp4": "video",
    });
    await makeBundle(dir, "scrawl-old-0", { "recording.webm": "video" });
    await makeBundle(dir, "scrawl-live-0", {
      [UNFINISHED_FILE]: journal,
      "recording.mp4": "video",
    });
    await makeBundle(dir, "scrawl-built-0", {
      "scrawl.json": "{}",
      [UNFINISHED_FILE]: journal,
      "recording.mp4": "video",
    });
    await makeBundle(dir, "scrawl-tried-0", {
      [REBUILT_ONCE_FILE]: "",
      [UNFINISHED_FILE]: journal,
      "recording.mp4": "video",
    });
    await makeBundle(dir, "scrawl-empty-0", { [UNFINISHED_FILE]: journal });
    await makeBundle(dir, "not-a-capture", { "recording.mp4": "video" });

    const { owed, empty } = planRebuilds(await readCaptureFolders(dir), "scrawl-live-0");

    expect(owed.map((entry) => entry.id).toSorted()).toEqual(["scrawl-crashed-0", "scrawl-old-0"]);
    expect(owed.find((entry) => entry.id === "scrawl-crashed-0")?.journal?.input.events).toEqual([
      { kind: "click", t: 5, x: 0.1, y: 0.2 },
    ]);
    expect(empty.map((entry) => entry.id)).toEqual(["scrawl-empty-0"]);
  });

  it("treats half a journal as no journal, so the video is still rebuilt", async () => {
    const dir = await makeCapturesDir();
    const folder = await makeBundle(dir, "scrawl-torn-0", {
      [UNFINISHED_FILE]: '{"session":{"id"',
      "recording.mp4": "video",
    });
    const read = await readCaptureFolder(folder);
    expect(read?.journal).toBeNull();
    expect(planRebuilds(read === null ? [] : [read], null).owed).toHaveLength(1);
  });

  it("a finished build clears the journal and stays built", async () => {
    const dir = await makeCapturesDir();
    const folder = await makeBundle(dir, "scrawl-done-0", {
      "scrawl.json": "{}",
      [UNFINISHED_FILE]: "{}",
      [REBUILT_ONCE_FILE]: "",
      "timing.json": "{}",
      "audio.pcm": "pcm",
      "recording.mp4": "video",
    });
    await removeJournal(folder);
    expect((await NodeFSP.readdir(folder)).toSorted()).toEqual(["recording.mp4", "scrawl.json"]);
  });
});

describe("planRetention", () => {
  const media = { kind: "media", paths: ["recording.mp4", "audio.wav"] };
  const bundle = { kind: "bundle", folder: capture().folder };
  const withJoinedPaths = (actions: ReturnType<typeof planRetention>) =>
    actions.map((action) =>
      action.kind === "media"
        ? { kind: "media", paths: action.paths.map((path) => NodePath.basename(path)) }
        : action,
    );

  it.each([
    ["young", capture(), "week", 6, []],
    ["media due", capture(), "week", 7, [media]],
    ["bundle due", capture(), "week", 30, [bundle]],
    ["longer preset", capture(), "month", 29, []],
    ["longer preset, media due", capture(), "month", 30, [media]],
    ["kept forever", capture(), "forever", 3_650, []],
    ["pinned", capture({ pinned: true }), "week", 365, []],
    ["owes a build", capture({ built: false }), "week", 365, []],
    ["media already gone", capture({ mediaItems: [] }), "week", 7, []],
    ["changed just now", capture({ changedAtMs: CREATED_AT + 7 * DAY_MS }), "week", 7, []],
    ["rebuild failed", capture({ built: false, tried: true }), "week", 7, [media]],
  ] as const)("%s", (_name, entry, retention, ageDays, expected) => {
    const actions = planRetention([entry], retention, null, CREATED_AT + ageDays * DAY_MS);
    expect(withJoinedPaths(actions)).toEqual(expected);
  });

  it("leaves the capture being recorded alone", () => {
    const entry = capture();
    expect(planRetention([entry], "week", entry.id, CREATED_AT + 365 * DAY_MS)).toEqual([]);
  });

  it("removes on exactly the dates the list shows", () => {
    const entry = capture();
    const { mediaAtMs, bundleAtMs } = retentionDates(entry, "week", null);
    expect(planRetention([entry], "week", null, mediaAtMs! - 1)).toEqual([]);
    expect(planRetention([entry], "week", null, mediaAtMs!)[0]?.kind).toBe("media");
    expect(planRetention([entry], "week", null, bundleAtMs! - 1)[0]?.kind).toBe("media");
    expect(planRetention([entry], "week", null, bundleAtMs!)[0]?.kind).toBe("bundle");
  });
});

describe("readCaptureFolder", () => {
  it("dates a capture by its id, not by the rebuild that wrote its manifest", async () => {
    const dir = await makeCapturesDir();
    const id = `scrawl-${CREATED_AT.toString(36)}-0`;
    const folder = await makeBundle(dir, id, {
      "scrawl.json": JSON.stringify({ createdAtMs: CREATED_AT + 9 * DAY_MS, durationMs: 42 }),
      [PINNED_FILE]: "",
    });
    const read = await readCaptureFolder(folder);
    expect(read).toMatchObject({ createdAtMs: CREATED_AT, durationMs: 42, pinned: true });
    expect(idTimeMs("scrawl-1730000000000-0")).toBeNull();
  });
});
