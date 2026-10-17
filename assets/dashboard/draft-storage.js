/* global localStorage, setTimeout, clearTimeout */

const stores = new Set();

// Called before a restart; failed writes stay in memory and block that restart.
export function flushDrafts() {
  let unsaved = false;
  for (const store of stores)
    if (!store.flush() && store.hasRecords()) unsaved = true;
  if (unsaved)
    throw new Error(
      'Unsaved drafts could not be stored for restart. Keep this window open and save or shorten the affected draft.',
    );
}

// Keep recovery records bounded without evicting another unsaved document.
export function createDraftStore(
  key,
  {validate, onError, maxLength = 2_200_000, debounceMs = 0},
) {
  const records = new Map();
  let serialized;
  let flushTimer;
  try {
    const stored = localStorage.getItem(key);
    if (stored) {
      if (stored.length > maxLength)
        throw new Error('Draft recovery data exceeds the storage limit.');
      const entries = JSON.parse(stored);
      if (!Array.isArray(entries) || entries.length > 50)
        throw new Error('Draft recovery data could not be read.');
      for (const entry of entries) {
        if (
          !Array.isArray(entry) ||
          entry.length !== 2 ||
          !validate(entry[0], entry[1])
        )
          throw new Error('Draft recovery data could not be read.');
        records.set(entry[0], entry[1]);
      }
      serialized = stored;
    }
  } catch (cause) {
    onError(cause);
  }
  function flush() {
    if (flushTimer !== undefined) clearTimeout(flushTimer);
    flushTimer = undefined;
    try {
      if ([...records].some(([id, value]) => !validate(id, value)))
        throw new Error('This draft exceeds the recovery storage limit.');
      const content = JSON.stringify([...records]);
      if (records.size > 50 || content.length > maxLength)
        throw new Error('Draft recovery storage is full.');
      if (content !== serialized) {
        if (records.size) localStorage.setItem(key, content);
        else localStorage.removeItem(key);
        serialized = content;
      }
      return true;
    } catch (cause) {
      onError(cause);
      return false;
    }
  }
  const store = {
    hasRecords: () => records.size > 0,
    entries: () => records.entries(),
    get: id => records.get(id),
    save(id, value) {
      if (value === undefined) records.delete(id);
      else records.set(id, value);
      if (!debounceMs) return flush();
      flushTimer ??= setTimeout(flush, debounceMs);
      return true;
    },
    flush,
  };
  stores.add(store);
  return store;
}
