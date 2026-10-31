import { describe, expect, it } from "vite-plus/test";

import { elementHit, elementOn, ElementLookups, namesWindowTitle } from "./elementLookup.ts";

const BUTTON = 50000;
const EDIT = 50004;
const TEXT = 50020;
const DOCUMENT = 50030;
const WINDOW = 50032;
const PANE = 50033;

describe("elementHit", () => {
  it.each([
    [
      "a button",
      { type: BUTTON, role: "button", name: "Area", automationId: "area" },
      { role: "button", label: "“Area” #area" },
    ],
    [
      "a numbered Win32 id",
      { type: BUTTON, role: "button", name: "OK", automationId: "1001" },
      { role: "button", label: "“OK”" },
    ],
    [
      "help text when there is no name",
      { type: BUTTON, role: "button", help: "Saves" },
      { role: "button", label: "“Saves”" },
    ],
    [
      "a field keeps its role, not its name",
      { type: EDIT, role: "edit", name: "whatever it says" },
      { role: "edit" },
    ],
    ["a password field the helper read nothing of", { type: EDIT, role: "edit" }, { role: "edit" }],
    ["a page, named after its title", { type: DOCUMENT, role: "document", name: "My bank" }, null],
    ["a window, named after its title", { type: WINDOW, role: "window", name: "My bank" }, null],
    ["a pane", { type: PANE, role: "pane", name: "My bank" }, null],
    ["text, which may be what was typed", { type: TEXT, role: "text", name: "hunter2" }, null],
    ["a failed lookup", {}, null],
  ])("%s", (_name, answer, expected) => {
    expect(elementHit(answer)).toEqual(expected);
  });

  it("keeps a label to one short line", () => {
    const label = elementHit({
      type: BUTTON,
      role: "button",
      name: `a\n  b ${"c".repeat(90)}`,
    })!.label!;
    expect(label).toMatch(/^“a b c+…”$/u);
    expect([...label].length).toBe(62);
  });
});

describe("elementOn", () => {
  it("needs something more than a role", () => {
    expect(elementOn({ role: "button", label: "“Area”" })).toBe("button “Area”");
    expect(elementOn({ role: "edit" })).toBeUndefined();
    expect(elementOn(undefined)).toBeUndefined();
  });
});

describe("namesWindowTitle", () => {
  const titles = ["Inbox of someone private - Mail", "Save"];

  it("catches a tab named after the page, and leaves ordinary captions alone", () => {
    expect(namesWindowTitle("“Inbox of someone private”", titles)).toBe(true);
    expect(namesWindowTitle("“Inbox of someone…”", titles)).toBe(true);
    expect(namesWindowTitle("“save” #s", titles)).toBe(true);
    expect(namesWindowTitle("“Mail”", titles)).toBe(false);
    expect(namesWindowTitle("#only-an-id", titles)).toBe(false);
  });
});

describe("ElementLookups", () => {
  const setup = () => {
    let now = 0;
    const written: Array<string> = [];
    let closed = 0;
    const lookups = new ElementLookups(
      {
        write: (line) => written.push(line),
        close: () => {
          closed++;
        },
      },
      () => now,
    );
    return {
      lookups,
      written,
      closes: () => closed,
      advance: (ms: number) => {
        now += ms;
      },
    };
  };
  const answer = (id: number) => JSON.stringify({ id, type: BUTTON, role: "button", name: "Area" });

  it("waits for the child, asks one at a time, and skips a click too old to describe", async () => {
    const { lookups, written, advance } = setup();
    lookups.look("old", 1, 1);
    advance(600);
    lookups.look("a", 2, 2);
    lookups.look("b", 3, 3);
    expect(written).toEqual([]);
    lookups.answer("ready");
    expect(written).toEqual(["1 2 2\n"]);
    lookups.answer("not json");
    lookups.answer(answer(9));
    expect(written).toHaveLength(1);
    lookups.answer(answer(1));
    expect(written).toEqual(["1 2 2\n", "2 3 3\n"]);
    lookups.answer(answer(2));
    const hits = await lookups.finish(0);
    expect([...hits.keys()]).toEqual(["a", "b"]);
  });

  it("finishes at once when nothing runs, and ends the child either way", async () => {
    const quiet = setup();
    quiet.lookups.answer("ready");
    expect((await quiet.lookups.finish(10_000)).size).toBe(0);
    expect(quiet.closes()).toBe(1);

    const neverReady = setup();
    neverReady.lookups.look("a", 1, 1);
    expect((await neverReady.lookups.finish(10_000)).size).toBe(0);
    expect(neverReady.closes()).toBe(1);
  });

  it("gives up on a target app that does not answer", async () => {
    const { lookups, closes } = setup();
    lookups.answer("ready");
    lookups.look("hung", 1, 1);
    expect((await lookups.finish(0)).size).toBe(0);
    expect(closes()).toBe(1);
  });
});
