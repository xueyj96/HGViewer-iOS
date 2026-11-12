export const HISTORY_LIMIT = 80;

/** 观看记录：看到第几集、第几秒（`dur` 用来判断是否已看完） */
export type WatchProgress = { id: number; ep: number; t: number; dur: number; at: number };

/** 旧版本 history 是 number[]，读出来时升级成带进度的结构。 */
export function normalizeHistory(raw: unknown, now: number): WatchProgress[] {
  if (!Array.isArray(raw)) return [];
  const newest = new Map<number, WatchProgress>();
  const nonnegative = (value: unknown) => {
    const number = Number(value);
    return Number.isFinite(number) && number >= 0 ? number : 0;
  };
  raw.forEach((item, index) => {
    const value: Partial<WatchProgress> | null = typeof item === "number" ? { id: item } : item as Partial<WatchProgress> | null;
    if (!value || !Number.isSafeInteger(value.id) || (value.id ?? 0) <= 0) return;
    const id = value.id!;
    const episode = Number(value.ep);
    const timestamp = Number(value.at);
    const entry: WatchProgress = {
      id, ep: Number.isSafeInteger(episode) && episode > 0 ? episode : 1,
      t: nonnegative(value.t), dur: nonnegative(value.dur),
      at: Number.isFinite(timestamp) && timestamp > 0 ? timestamp : now - index,
    };
    const previous = newest.get(id);
    if (!previous || entry.at > previous.at) newest.set(id, entry);
  });
  // Merge old duplicate IDs before applying the per-show limit, retaining the
  // newest progress and the same most-recent-first order as add/restore.
  return [...newest.values()].sort((a, b) => b.at - a.at).slice(0, HISTORY_LIMIT);
}

/** Build the next entry with Store's existing episode and omitted-field rules. */
export function addHistory(
  history: WatchProgress[], id: number, ep: number | undefined, t: number | undefined,
  dur: number | undefined, at: number,
): WatchProgress[] {
  const prev = history.find((entry) => entry.id === id);
  const epChanged = ep !== undefined && prev !== undefined && prev.ep !== ep;
  const entry: WatchProgress = {
    id,
    ep: ep ?? prev?.ep ?? 1,
    t: t ?? (epChanged ? 0 : prev?.t ?? 0),
    dur: dur ?? (epChanged ? 0 : prev?.dur ?? 0),
    at,
  };
  return [entry, ...history.filter((entry) => entry.id !== id)].slice(0, HISTORY_LIMIT);
}

/** Restore an entry only when its show is absent; order by its stored timestamp. */
export function restoreHistory(history: WatchProgress[], entry: WatchProgress): WatchProgress[] {
  if (history.some((item) => item.id === entry.id)) return history;
  return [...history, entry].sort((a, b) => b.at - a.at).slice(0, HISTORY_LIMIT);
}
