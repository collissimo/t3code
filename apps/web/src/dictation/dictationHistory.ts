// Dictated text kept on this client. IndexedDB rather than localStorage: reads are paged and
// asynchronous, so a long history costs nothing until it is opened.

const DATABASE_NAME = "t3code:dictation-history";
const STORE_NAME = "entries";
// About 10 to 20 MB at this size: a typical dictation is one or two KB of text.
const MAX_ENTRIES = 10_000;

export interface DictationHistoryEntry {
  readonly id: number;
  readonly text: string;
  readonly createdAt: number;
  /** The rewritten prompt; its plain transcript is the entry before it. */
  readonly structured: boolean;
}

let database: Promise<IDBDatabase> | undefined;

function openDatabase() {
  return (database ??= new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, 1);
    request.addEventListener("upgradeneeded", () => {
      request.result.createObjectStore(STORE_NAME, { keyPath: "id", autoIncrement: true });
    });
    request.addEventListener("success", () => resolve(request.result));
    request.addEventListener("error", () => reject(request.error));
    request.addEventListener("blocked", () => reject(new Error("Dictation history is blocked.")));
  }));
}

async function runTransaction(mode: IDBTransactionMode, use: (store: IDBObjectStore) => void) {
  const transaction = (await openDatabase()).transaction(STORE_NAME, mode);
  use(transaction.objectStore(STORE_NAME));
  await new Promise<void>((resolve, reject) => {
    transaction.addEventListener("complete", () => resolve());
    transaction.addEventListener("abort", () => reject(transaction.error));
    transaction.addEventListener("error", () => reject(transaction.error));
  });
}

/** Adds an entry and drops the oldest ones beyond `maxEntries`. */
export function addDictationHistoryEntry(
  entry: Omit<DictationHistoryEntry, "id">,
  maxEntries = MAX_ENTRIES,
): Promise<void> {
  return runTransaction("readwrite", (store) => {
    store.add(entry);
    const count = store.count();
    count.addEventListener("success", () => {
      let excess = count.result - maxEntries;
      if (excess <= 0) return;
      const cursor = store.openCursor();
      cursor.addEventListener("success", () => {
        if (cursor.result === null || excess <= 0) return;
        cursor.result.delete();
        excess--;
        cursor.result.continue();
      });
    });
  });
}

/** Up to `limit` entries older than the entry `before`, newest first. */
export async function listDictationHistory(input: {
  readonly before: number | null;
  readonly limit: number;
}): Promise<ReadonlyArray<DictationHistoryEntry>> {
  const entries: Array<DictationHistoryEntry> = [];
  await runTransaction("readonly", (store) => {
    const range = input.before === null ? null : IDBKeyRange.upperBound(input.before, true);
    const cursor = store.openCursor(range, "prev");
    cursor.addEventListener("success", () => {
      if (cursor.result === null) return;
      entries.push(cursor.result.value as DictationHistoryEntry);
      if (entries.length < input.limit) cursor.result.continue();
    });
  });
  return entries;
}

export function deleteDictationHistoryEntry(id: number): Promise<void> {
  return runTransaction("readwrite", (store) => {
    store.delete(id);
  });
}

export function clearDictationHistory(): Promise<void> {
  return runTransaction("readwrite", (store) => {
    store.clear();
  });
}
