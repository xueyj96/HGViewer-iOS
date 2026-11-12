import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { useIOSTopBarMotion } from '../src/components/useIOSTopBarMotion';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
type Outcome = { name: string; passed: boolean; details?: unknown; error?: string };
const results: Outcome[] = [];
const assert = (ok: unknown, message: string) => { if (!ok) throw Error(message); };
const wait = async (ms = 25) => { await act(async () => { await new Promise(resolve => setTimeout(resolve, ms)); }); };
function Fixture({ setApi }: { setApi: (api: { morph: () => void; host: () => HTMLElement | null }) => void }) {
  const [host, setHost] = React.useState<HTMLDivElement | null>(null);
  const [segments, setSegments] = React.useState(false);
  useIOSTopBarMotion(host);
  React.useLayoutEffect(() => { setApi({ morph: () => setSegments(true), host: () => host }); }, [host]);
  return <>
    <div ref={setHost} className="hg-ios-top-bar" data-test-host>
      <div className="hg-ios-floating-bar" data-nav-priority="2">
        <div className="hg-ios-floating-actions-start" />
        <div className="hg-ios-floating-panel" data-panel>
          {segments ? <div className="hg-ios-segments" role="group" aria-label="详情与选集">
            <button type="button" aria-pressed="false" onClick={() => window.__clicks.push('详情')}>详情</button>
            <button type="button" aria-pressed="false" onClick={() => window.__clicks.push('选集')}>选集</button>
          </div> : <div className="old-title">页面标题</div>}
        </div>
        <div className="hg-ios-floating-actions-end" />
      </div>
      <div className="viewport" data-hg-tab-viewport>内容区域</div>
    </div>
    <button data-morph onClick={() => setSegments(true)}>开始形变</button>
  </>;
}
import React from 'react';
declare global { interface Window { __clicks: string[]; __events: { type: string; target: string }[]; __clickAt: (x:number,y:number)=>Promise<void>; __press: (key:string)=>Promise<void>; __pointerAt: (x:number,y:number)=>Promise<void> } }
window.__clicks = []; window.__events = [];
const label = (node: EventTarget | null) => node instanceof Element
  ? node.closest('button')?.textContent?.trim() || (node.closest('.hg-ios-segments') ? 'group' : node.tagName.toLowerCase()) : String(node);
for (const type of ['pointerdown', 'pointerup', 'click']) document.addEventListener(type, event => window.__events.push({ type, target: label(event.target) }), true);
const css = document.createElement('style');
css.textContent = `
  * { box-sizing: border-box; }
  body { margin: 0; font: 16px sans-serif; }
  .hg-ios-top-bar { position: relative; width: 320px; height: 260px; margin: 20px; }
  .hg-ios-floating-bar { position: absolute; left: 0; top: 0; display: flex; align-items: center; width: 320px; height: 64px; }
  .hg-ios-floating-panel { display: flex; align-items: center; justify-content: center; width: 120px; height: 44px; flex: none; border-radius: 14px; }
  .old-title { display: flex; align-items: center; justify-content: center; width: 100%; height: 100%; }
  .hg-ios-segments { position: relative; z-index: 1; display: flex; align-items: center; gap: 20px; width: 220px; height: 44px; padding: 4px 10px; }
  .hg-ios-segments button { width: 90px; height: 36px; flex: none; border-width: 0; background: #ddd; }
  .viewport { position: absolute; top: 100px; left: 0; width: 320px; height: 100px; background: #eee; }
`;
document.head.append(css);
let mounted: { morph: () => void; host: () => HTMLElement | null } | undefined;
const hostRoot = document.querySelector<HTMLElement>('#fixture')!;
const root = createRoot(hostRoot);
let mountKey = 0;
const mountFresh = async () => { await act(async () => { root.render(<Fixture key={++mountKey} setApi={api => { mounted = api; }} />); }); };
await mountFresh();
const startMorph = async () => { await act(async () => mounted!.morph()); await wait(40); };
const animationFor = () => hostRoot.querySelector<HTMLElement>('.hg-ios-segments button:last-child')?.getAnimations()[0];
const freezeMidMorph = () => {
  const animations = hostRoot.querySelectorAll<HTMLElement>('.hg-ios-segments button');
  for (const button of animations) for (const animation of button.getAnimations()) {
    const timing = animation.effect?.getTiming();
    animation.pause(); animation.currentTime = Number(timing?.delay || 0) + Number(timing?.duration || 200) / 6;
  }
  return animationFor();
};
const eventTargetCapture = (reset = true) => { if (reset) window.__events = []; return window.__events; };

try {
  await startMorph();
  const animation = freezeMidMorph();
  const timingProgress = animation?.effect?.getComputedTiming().progress;
  assert(animation && typeof timingProgress === 'number' && timingProgress > 0 && timingProgress < 1, `real WAAPI transition did not reach a controlled active frame: ${JSON.stringify({ exists: !!animation, duration: animation?.effect?.getTiming().duration, currentTime: animation?.currentTime, progress: timingProgress, playState: animation?.playState, transforms: [...hostRoot.querySelectorAll('.hg-ios-segments button')].map(b => getComputedStyle(b).transform) })}`);
  const second = hostRoot.querySelector<HTMLButtonElement>('.hg-ios-segments button:last-child')!;
  const box = second.getBoundingClientRect();
  const buttons = [...hostRoot.querySelectorAll<HTMLButtonElement>('.hg-ios-segments button')];
  const neutralRect = (button: HTMLButtonElement) => {
    const rect = button.getBoundingClientRect(), matrix = new DOMMatrixReadOnly(getComputedStyle(button).transform);
    return { left: rect.left - matrix.m41, right: rect.right - matrix.m41 };
  };
  const gapLeft = neutralRect(buttons[0]).right, gapRight = neutralRect(buttons[1]).left;
  const x = (gapLeft + gapRight) / 2, y = box.top + box.height / 2;
  const beforeTarget = document.elementFromPoint(x, y);
  assert(x >= box.left && x <= box.right && beforeTarget === second, `mid-morph gap point did not hit intended button; got ${label(beforeTarget)} (x=${x}, target=${box.left}-${box.right}, neutralGap=${gapLeft}-${gapRight})`);
  eventTargetCapture();
  assert(window.__clickAt, 'Playwright pointer bridge unavailable');
  await window.__clickAt(x, y);
  const events = eventTargetCapture(false);
  const down = events.find(e => e.type === 'pointerdown')?.target;
  const up = events.find(e => e.type === 'pointerup')?.target;
  const click = events.find(e => e.type === 'click')?.target;
  assert(down === '选集', `pointerdown hit ${down}, expected 选集`);
  assert(up === '选集', `pointerup retargeted to ${up}, expected original segment button 选集`);
  assert(click === '选集' && window.__clicks.filter(x => x === '选集').length === 1, `morph click did not invoke selected action exactly once; click=${click}, callbacks=${window.__clicks}`);
  results.push({ name: 'pointerdown/up at fixed point preserves selected segment target through morph', passed: true, details: { x, y, down, up, click, callbackCount: 1 } });
} catch (error) { results.push({ name: 'pointerdown/up at fixed point preserves selected segment target through morph', passed: false, error: String(error), details: { events: window.__events, callbacks: window.__clicks } }); }

try {
  await mountFresh(); await startMorph(); freezeMidMorph();
  assert(animationFor(), 'keyboard case did not start a real morph animation');
  const button = hostRoot.querySelector<HTMLButtonElement>('.hg-ios-segments button:last-child')!;
  button.focus();
  // Browser runner bridges a trusted key event through this focus target.
  await window.__press('ArrowRight');
  assert(!animationFor(), 'ArrowRight did not settle the active morph');
  results.push({ name: 'keyboard navigation settles active morph', passed: true });
} catch (error) { results.push({ name: 'keyboard navigation settles active morph', passed: false, error: String(error) }); }

try {
  await mountFresh(); await startMorph(); freezeMidMorph();
  assert(animationFor(), 'viewport case did not start a real morph animation');
  const viewport = hostRoot.querySelector<HTMLElement>('[data-hg-tab-viewport]')!.getBoundingClientRect();
  await window.__pointerAt(viewport.left + 20, viewport.top + 20);
  assert(!animationFor(), 'viewport pointerdown did not settle the active morph');
  results.push({ name: 'tab viewport pointerdown settles active morph', passed: true });
} catch (error) { results.push({ name: 'tab viewport pointerdown settles active morph', passed: false, error: String(error) }); }

try {
  const adds: string[] = [], removes: string[] = [];
  const add = document.addEventListener, remove = document.removeEventListener;
  document.addEventListener = function(type: string, listener: EventListenerOrEventListenerObject | null, options?: boolean | AddEventListenerOptions) {
    if (['pointerdown', 'keydown', 'click'].includes(type) && options === true) adds.push(type);
    if (listener) return add.call(this, type, listener, options);
    return;
  };
  document.removeEventListener = function(type: string, listener: EventListenerOrEventListenerObject | null, options?: boolean | EventListenerOptions) {
    if (['pointerdown', 'keydown', 'click'].includes(type) && options === true) removes.push(type);
    if (listener) return remove.call(this, type, listener, options);
    return;
  };
  await mountFresh(); await startMorph(); freezeMidMorph();
  const target = animationFor(); assert(target, 'unmount case did not start a real morph animation');
  await act(async () => root.unmount());
  document.addEventListener = add; document.removeEventListener = remove;
  assert(['pointerdown', 'keydown', 'click'].every(type => adds.includes(type) && removes.includes(type)), `document gesture listeners were not removed at unmount: adds=${adds}, removes=${removes}`);
  assert(!hostRoot.querySelector('.hg-ios-top-bar'), 'unmount retained top bar host');
  results.push({ name: 'unmount removes global gesture listeners and navigation host', passed: true, details: { adds, removes } });
} catch (error) { results.push({ name: 'unmount removes global gesture listeners and navigation host', passed: false, error: String(error) }); }

document.querySelector('#results')!.textContent = JSON.stringify({ passed: results.filter(r => r.passed).length, failed: results.filter(r => !r.passed).length, results }, null, 2);
