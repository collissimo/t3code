import { describe, expect, it } from "vite-plus/test";

import {
  addDictationHistoryEntry,
  clearDictationHistory,
  deleteDictationHistoryEntry,
  listDictationHistory,
} from "./dictationHistory";

const add = (text: string, maxEntries?: number) =>
  addDictationHistoryEntry({ text, createdAt: 0, structured: false }, maxEntries);

const texts = async (input: { before: number | null; limit: number }) =>
  (await listDictationHistory(input)).map((entry) => entry.text);

describe("dictationHistory", () => {
  it("pages from newest to oldest and survives a deleted entry", async () => {
    await clearDictationHistory();
    for (const text of ["a", "b", "c", "d"]) await add(text);

    const firstPage = await listDictationHistory({ before: null, limit: 2 });
    expect(firstPage.map((entry) => entry.text)).toEqual(["d", "c"]);

    await deleteDictationHistoryEntry(firstPage[1]!.id);
    expect(await texts({ before: firstPage[1]!.id, limit: 2 })).toEqual(["b", "a"]);
    expect(await texts({ before: null, limit: 10 })).toEqual(["d", "b", "a"]);
  });

  it("drops the oldest entries beyond the limit", async () => {
    await clearDictationHistory();
    for (const text of ["a", "b", "c", "d"]) await add(text, 2);
    expect(await texts({ before: null, limit: 10 })).toEqual(["d", "c"]);
  });
});
