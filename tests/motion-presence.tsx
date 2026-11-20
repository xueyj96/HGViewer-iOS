import { act, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { Sheet, Modal } from "../src/components/ui";
import { useMotionPresence } from "../src/components/useMotionPresence";
import "../src/index.css";
import "../src/ios.css";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const results: { name: string; passed: boolean; error?: string; details?: unknown }[] = [];
const assert = (ok: unknown, message: string) => { if (!ok) throw new Error(message); };
declare global {
  interface Window { __dragSheet?: (left: number, top: number) => Promise<void> }
}
async function test(name: string, run: () => Promise<unknown>) {
  try { results.push({ name, passed: true, details: await run() }); }
  catch (error) { results.push({ name, passed: false, error: String(error) }); }
}
function Probe({ open, childMotion = false }: { open: boolean; childMotion?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const present = useMotionPresence(open, ref);
  return present ? <div ref={ref} data-motion-root>{childMotion && <span className="spinner" />}</div> : null;
}
async function probe(run: (fixture: { update: (open: boolean, childMotion?: boolean) => Promise<void>; node: () => HTMLElement | null }) => Promise<void>) {
  const host = document.createElement("div"); document.querySelector("#fixture")!.append(host);
  const root = createRoot(host);
  const update = async (open: boolean, childMotion = false) => { await act(async () => root.render(<Probe open={open} childMotion={childMotion} />)); };
  try { await update(true); await run({ update, node: () => host.querySelector("[data-motion-root]") }); }
  finally { await act(async () => root.unmount()); host.remove(); }
}

await test("closing follows actual root animation, not a fixed 200/230ms timer", async () => {
  await probe(async ({ update, node }) => {
    const animation = node()!.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 1000 });
    animation.pause(); animation.currentTime = 100;
    await update(false);
    await act(async () => { await new Promise((done) => window.setTimeout(done, 260)); });
    assert(node(), "root disappeared before its owned exit animation settled");
    await act(async () => { animation.finish(); await animation.finished; });
    assert(!node(), "finished root retained visual layer");
  });
});
await test("reopening retires the previous cleanup without hiding the new presentation", async () => {
  await probe(async ({ update, node }) => {
    const animation = node()!.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 1000 });
    animation.pause(); animation.currentTime = 100;
    await update(false); await update(true);
    await act(async () => { animation.finish(); await animation.finished; });
    assert(node(), "retired cleanup hid reopened content");
  });
});
await test("cancelled root animation still releases the closing visual layer", async () => {
  await probe(async ({ update, node }) => {
    const animation = node()!.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 1000 });
    animation.pause(); await update(false);
    await act(async () => { animation.cancel(); await Promise.resolve(); });
    assert(!node(), "cancelled animation leaked layer");
  });
});
await test("a descendant spinner never holds its parent presentation open", async () => {
  await probe(async ({ update, node }) => {
    await update(true, true);
    assert(node()!.querySelector(".spinner")!.getAnimations().length > 0, "fixture did not create spinner");
    await update(false, true);
    assert(!node(), "descendant infinite animation blocked cleanup");
  });
});

const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
for (const kind of ["sheet-full-callback", "sheet-full", "sheet-half", "modal"] as const) {
  await test(`${kind}: actual exit, immediate inertness, reopen and focus restoration`, async () => {
    const host = document.createElement("div"); document.querySelector("#fixture")!.append(host);
    const opener = document.createElement("button"); opener.textContent = "fixture opener"; host.append(opener); opener.focus();
    const container = document.createElement("div"); host.append(container); const root = createRoot(container);
    const presence: boolean[] = [];
    const callback = (present: boolean) => { presence.push(present); };
    const update = async (open: boolean) => {
      await act(async () => root.render(<div className="plat-ios" style={{ position: "relative", width: 390, height: 700 }}>
        {kind === "modal" ? <Modal open={open} onClose={() => {}} label="fixture modal" width={320} height={180}>
          <button type="button">fixture action</button>
        </Modal> : <Sheet open={open} onClose={() => {}} label="fixture sheet"
          fullPage={kind === "sheet-half" ? undefined : "fixture sheet"}
          onPresenceChange={kind === "sheet-full-callback" ? callback : undefined}>
          <button type="button">fixture action</button>
        </Sheet>}
      </div>));
    };
    const node = () => container.querySelector<HTMLElement>(kind === "modal" ? ".hg-ios-alert" : ".hg-ios-sheet");
    try {
      await update(true);
      const entering = node()!.getAnimations();
      await act(async () => { await Promise.allSettled(entering.map((animation) => animation.finished)); });
      await update(false);
      assert(!node() || !!node()!.closest("[inert]"), "closing content stayed interactive");
      const exit = node()?.getAnimations() ?? [];
      const exitFinished = exit.map((animation) => animation.finished);
      // Capture now: a cancelled Animation exposes a new pending `finished` promise afterward.
      const exited = Promise.allSettled(exitFinished);
      const durations = exit.map((animation) => Number(animation.effect!.getComputedTiming().duration));
      if (reduced) assert(durations.every((duration) => duration <= 1), "reduced-motion exit kept a long transition");
      await update(true);
      await act(async () => { await exited; });
      assert(node() && !node()!.closest("[inert]"), "old exit removed reopened content");
      await update(false);
      const closing = node()?.getAnimations() ?? [];
      await act(async () => { await Promise.allSettled(closing.map((animation) => animation.finished)); });
      assert(!node(), "completed exit remained mounted");
      assert(document.activeElement === opener, "focus did not return to original opener");
      if (kind === "sheet-full-callback") assert(presence.at(-1) === false, "presence callback did not finish");
      return { reducedMotion: reduced, exitDurations: durations, presence };
    } finally { await act(async () => root.unmount()); host.remove(); }
  });
}

await test("trusted edge drag dismisses once and the same Sheet owner can reopen", async () => {
  const host = document.createElement("div"); document.querySelector("#fixture")!.append(host);
  const opener = document.createElement("button"); opener.textContent = "drag fixture opener"; host.append(opener); opener.focus();
  const container = document.createElement("div"); host.append(container); const root = createRoot(container);
  let reopen!: () => void, closes = 0;
  function StatefulSheet() {
    const [open, setOpen] = useState(true);
    reopen = () => setOpen(true);
    return <div className="plat-ios" style={{ position: "relative", width: 390, height: 700 }}>
      <output data-drag-open>{String(open)}</output>
      <Sheet open={open} label="drag fixture" fullPage="drag fixture" onClose={() => { ++closes; setOpen(false); }}>
        <button type="button">drag fixture action</button>
      </Sheet>
    </div>;
  }
  try {
    await act(async () => root.render(<StatefulSheet />));
    const sheet = container.querySelector<HTMLElement>(".hg-ios-sheet")!;
    await act(async () => { await Promise.allSettled(sheet.getAnimations().map((animation) => animation.finished)); });
    assert(window.__dragSheet, "trusted CDP pointer bridge unavailable");
    const bounds = sheet.getBoundingClientRect();
    await act(async () => {
      await window.__dragSheet!(bounds.left + 2, bounds.top + 100);
      await new Promise((done) => window.setTimeout(done, 250));
    });
    assert(closes === 1 && !container.querySelector(".hg-ios-sheet") && container.isConnected, "drag close or fixture owner lifetime incorrect");
    assert(document.activeElement === opener, "drag close lost opener focus");
    await act(async () => reopen());
    assert(container.querySelector(".hg-ios-sheet") && container.querySelector("[data-drag-open]")?.textContent === "true",
      "drag-dismissed owner could not reopen");
    return { reducedMotion: reduced, closeCount: closes, reopened: true };
  } finally { await act(async () => root.unmount()); host.remove(); }
});

document.querySelector("#results")!.textContent = JSON.stringify({ reducedMotion: reduced,
  passed: results.filter((item) => item.passed).length, failed: results.filter((item) => !item.passed).length, results });
