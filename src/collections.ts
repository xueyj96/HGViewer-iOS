export function appendUniqueById<T extends { id: number }>(current: readonly T[], incoming: readonly T[]): T[] {
  const seen = new Set(current.map(({ id }) => id));
  const result = [...current];
  for (const item of incoming) {
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    result.push(item);
  }
  return result;
}

/** Set membership explicitly; React updaters never return a result to an event handler. */
export function setMembership(current: number[], id: number, on: boolean, index = 0): number[] {
  if (current.includes(id) === on) return current;
  return on ? [...current.slice(0, index), id, ...current.slice(index)] : current.filter((item) => item !== id);
}
