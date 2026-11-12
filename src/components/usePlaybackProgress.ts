import { useLayoutEffect, useMemo, useRef, useState } from "react";

type Resume = { key: string; t: number };
type Options = {
  id: number; ep: number; active: boolean; attempt: string;
  initialResume: Resume | null;
  resumeOnReturn: boolean;
  addHistory: (id: number, ep?: number, t?: number, duration?: number) => void;
  /** Must execute synchronously: the native snapshot reader suppresses its old time after this seek. */
  seek: (target: number) => void;
};

/** One owner for a content session's progress, pending resume and history writes.
 * Attempts may change without starting a second first-playing history record.
 * Callbacks capture their listener identity; retired sessions cannot mutate the next one.
 */
export function usePlaybackProgress({ id, ep, active, attempt, initialResume, resumeOnReturn, addHistory, seek }: Options) {
  const key = `${id}:${ep}`;
  const pending = useRef(initialResume);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const session = useMemo(() => ({ key, id, ep, t: 0, dur: 0, known: false,
    playing: false, dirty: false, lastSave: 0, open: false }), [key]);
  const epoch = useMemo(() => ({}), [session, active]);
  const listener = useMemo(() => ({}), [epoch, attempt]);
  const current = useRef<{ session: typeof session; listener: object } | null>(null);
  const valid = () => active && session.open && current.current?.session === session && current.current.listener === listener;

  useLayoutEffect(() => {
    session.open = active;
    if (!active) {
      if (resumeOnReturn && session.t > 1) pending.current = { key: session.key, t: session.t };
      return;
    }
    return () => {
      if (session.playing && session.dur > 0 && session.dirty) {
        addHistory(session.id, session.ep, session.t, session.dur);
      }
      session.dirty = false;
      session.playing = false;
      session.open = false;
    };
  }, [session, active, addHistory, resumeOnReturn]);

  useLayoutEffect(() => {
    current.current = { session, listener };
    return () => { if (current.current?.listener === listener) current.current = null; };
  }, [session, listener]);

  useLayoutEffect(() => { setTime(0); setDuration(0); }, [key, attempt]);

  return {
    time, duration, setTime,
    onTime(t: number) {
      if (!valid()) return;
      session.t = t; session.known = true; session.dirty = session.playing;
      setTime(t);
      const now = Date.now();
      if (session.playing && session.dur > 0 && now - session.lastSave > 5000) {
        session.lastSave = now;
        addHistory(id, ep, t, session.dur);
        session.dirty = false;
      }
    },
    onDuration(d: number) {
      if (!valid()) return;
      session.dur = d; session.known = true; setDuration(d);
      const resume = pending.current;
      if (resume?.key === key && resume.t > 1 && (!d || resume.t < d - 3)) {
        pending.current = null;
        session.t = resume.t; session.dirty = false;
        seek(resume.t);
        setTime(resume.t);
      }
    },
    onPlaying() {
      if (!valid() || session.playing) return;
      session.playing = true;
      addHistory(id, ep, session.known ? session.t : undefined, session.known ? session.dur : undefined);
      session.lastSave = Date.now(); session.dirty = false;
    },
  };
}
