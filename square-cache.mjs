export function createMetadataCache({ ttlMs = 60000, now = Date.now } = {}) {
  const entries = new Map();
  return async function cached(key, load) {
    const existing = entries.get(key);
    if (existing && existing.expires > now()) return existing.value;
    if (entries.size >= 64) entries.delete(entries.keys().next().value);
    const entry = { expires: now() + ttlMs, value: Promise.resolve().then(load) };
    entries.set(key, entry);
    try { return await entry.value; }
    catch (error) {
      if (entries.get(key) === entry) entries.delete(key);
      throw error;
    }
  };
}
