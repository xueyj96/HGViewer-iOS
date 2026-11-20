import { useCallback, useState, type SetStateAction } from "react";

const EMPTY = Object.freeze({});

/** Records belong to a monotonically increasing data revision, not the view's lifetime.
 * A changed revision is empty immediately; late writers cannot replace a newer revision.
 * Selection, scroll position and playback intent remain with the feature that uses it.
 */
export function useRevisionRecord<T>(revision: number) {
  const [record, setRecord] = useState<{ revision: number; values: Record<string, T> }>(() => ({ revision, values: {} }));
  const values: Record<string, T> = record.revision === revision ? record.values : EMPTY;
  const update = useCallback((action: SetStateAction<Record<string, T>>) => {
    setRecord((previous) => {
      if (previous.revision > revision) return previous;
      const current = previous.revision === revision ? previous.values : EMPTY;
      const next = typeof action === "function" ? action(current) : action;
      return previous.revision === revision && next === previous.values ? previous : { revision, values: next };
    });
  }, [revision]);
  return [values, update] as const;
}
