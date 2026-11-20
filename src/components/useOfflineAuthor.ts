import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import type { Author } from "../types";
import { useStore } from "../store";

type Identity = Pick<Author, "id" | "name">;

/** Local identity is authoritative offline. Missing legacy metadata may be enriched without blocking playback. */
export function useOfflineAuthor(id: number | undefined, active: boolean, known?: Identity, onRefreshed?: () => Promise<unknown>) {
  const { lineRevision } = useStore();
  const [local, setLocal] = useState<{ videoId: number; author: Identity }>();
  const attempted = useRef(new Map<string, Promise<void>>());
  useEffect(() => {
    if (!active || !id || known?.id) return;
    let alive = true;
    const remember = (author?: Identity) => {
      if (alive && author?.id && author.id > 0 && author.name) setLocal({ videoId: id, author });
    };
    void (async () => {
      const saved = await api.offlineShow(id);
      if (!alive) return;
      if (saved?.author) { remember(saved.author); return; }
      const key = `${lineRevision}:${id}`;
      let update = attempted.current.get(key);
      if (!update) {
        const pending = api.offlineRefreshShow(id).catch(error => {
          // Keep in-flight joins and successful deduplication, but a transient
          // failure must not poison this resource until the route is unmounted.
          if (attempted.current.get(key) === pending) attempted.current.delete(key);
          throw error;
        });
        update = pending;
        attempted.current.set(key, pending);
        if (attempted.current.size > 128) attempted.current.delete(attempted.current.keys().next().value!);
      }
      // A reactivated page joins its earlier request; only the current presentation updates the UI.
      await update;
      if (!alive) return;
      remember((await api.offlineShow(id))?.author);
      if (alive) await onRefreshed?.();
    })().catch(() => {}); // Offline playback and cache management do not depend on a network metadata request.
    return () => { alive = false; };
  }, [id, active, lineRevision, known?.id, known?.name, onRefreshed]);
  return known ?? (local && local.videoId === id ? local.author : undefined);
}
