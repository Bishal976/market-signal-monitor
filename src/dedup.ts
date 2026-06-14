// Last updated: 2026-06-14 — added markSeenBatch for single-write batch dedup; markIfNew now delegates to it
import fs from "fs";
import path from "path";

const STORE_PATH = path.join(__dirname, "..", "seen_posts.json");

type SeenStore = Record<string, string[]>;

function load(): SeenStore {
  if (!fs.existsSync(STORE_PATH)) return {};
  try {
    return JSON.parse(fs.readFileSync(STORE_PATH, "utf-8"));
  } catch {
    return {};
  }
}

function save(store: SeenStore): void {
  fs.writeFileSync(STORE_PATH, JSON.stringify(store, null, 2));
}

/** Returns true if the id has already been marked as seen, without modifying the store. */
export function isSeen(source: string, id: string): boolean {
  const store = load();
  return (store[source] ?? []).includes(id);
}

/**
 * Marks multiple (source, id) pairs as seen in a single load/save cycle,
 * applying FIFO pruning (drop oldest 200 once a source exceeds 1000 entries).
 */
export function markSeenBatch(items: Array<{ id: string; source: string }>): void {
  if (items.length === 0) return;

  const store = load();

  for (const { source, id } of items) {
    const list = store[source] ?? [];
    if (!list.includes(id)) list.push(id);

    if (list.length > 1000) {
      list.splice(0, 200);
      console.log(`[DEDUP] Pruned 200 old entries for source ${source}`);
    }

    store[source] = list;
  }

  save(store);
}

/** Returns true if the id is new (and marks it as seen). Single-item case, delegates to markSeenBatch. */
export function markIfNew(source: string, id: string): boolean {
  if (isSeen(source, id)) return false;
  markSeenBatch([{ source, id }]);
  return true;
}
