import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { api } from "../api";
import { appendUniqueById } from "../collections";
import type { VideoCard } from "../types";

export type ChannelOrder = "new" | "popular";
type PageState = { items: VideoCard[]; page: number; pages: number; loading: boolean; error: string | null };
const empty = (): PageState => ({ items: [], page: 0, pages: 1, loading: false, error: null });
const initial = (): Record<ChannelOrder, PageState> => ({ new: empty(), popular: empty() });

/** Each server order owns its pagination. Appending never reorders the already visible prefix. */
export function useChannelPages(cate: string, selected: ChannelOrder, active: boolean) {
  const [snapshots, setSnapshots] = useState(initial);
  const latest = useRef(snapshots);
  const generation = useRef(0);
  const owner = useRef({ cate, selected, active });
  owner.current = { cate, selected, active };

  useLayoutEffect(() => {
    ++generation.current;
    const value = initial();
    latest.current = value; setSnapshots(value);
    return () => { ++generation.current; };
  }, [cate]);

  const load = useCallback(async (order: ChannelOrder) => {
    const before = latest.current[order];
    if (!owner.current.active || owner.current.cate !== cate || owner.current.selected !== order
      || before.loading || before.page >= before.pages) return;
    const revision = generation.current;
    const update = (next: PageState) => {
      if (revision !== generation.current) return;
      const value = { ...latest.current, [order]: next };
      latest.current = value; setSnapshots(value);
    };
    update({ ...before, loading: true, error: null });
    try {
      const page = before.page + 1;
      const result = await api.category(cate, page, 20, order);
      update({ items: appendUniqueById(before.items, result.items), page, pages: result.pagination.pages,
        loading: false, error: null });
    } catch (error) {
      update({ ...before, loading: false, error: (error as Error).message || "频道加载失败" });
    }
  }, [cate]);

  useEffect(() => {
    if (active && latest.current[selected].page === 0 && !latest.current[selected].error) void load(selected);
  }, [active, selected, load]);

  return { snapshots, load };
}
