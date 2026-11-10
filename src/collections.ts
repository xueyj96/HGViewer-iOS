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
