import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { IOS_LAYOUT_CHANGE } from '../src/iosGeometry';
import { usePlaybackGestures } from '../src/components/usePlaybackGestures';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
type Options = Parameters<typeof usePlaybackGestures>[0];
type Result = ReturnType<typeof usePlaybackGestures>;
let latest: Result;
let playState = true;
function Probe({ options }: { options: Options }) {
  latest = usePlaybackGestures(options);
  return <div ref={options.surfaceReady ? options.boxRef : undefined} data-box onPointerDown={e => latest.onDown(e)} onPointerMove={latest.onMove} onPointerUp={latest.onUp} onPointerCancel={latest.onUp} onLostPointerCapture={latest.onLostCapture}>
    <div data-rail onPointerDown={e => { e.stopPropagation(); latest.onDown(e, true); }} onPointerMove={latest.onMove} onPointerUp={latest.onUp} onPointerCancel={latest.onUp} onLostPointerCapture={latest.onLostCapture}/>
    <div data-bar onPointerDown={latest.onBarDown} onPointerMove={latest.onBarMove} onPointerUp={latest.onBarUp} onPointerCancel={latest.onBarUp} onLostPointerCapture={latest.onBarLostCapture}/>
    <output data-state>{JSON.stringify({ holdSpeed: latest.holdSpeed, lockArmed: latest.lockArmed, scrub: latest.scrub, barPct: latest.barPct })}</output>
  </div>;
}
type Log = { name: string; args: unknown[] };
const results: { name: string; passed: boolean; error?: string }[] = [];
const assert = (ok: unknown, message: string) => { if (!ok) throw Error(message); };
const wait = (ms: number) => act(async () => { await new Promise<void>(resolve => window.setTimeout(resolve, ms)); });
const box = () => document.querySelector<HTMLElement>('[data-box]')!;
const state = () => JSON.parse(document.querySelector('[data-state]')!.textContent || '{}');
function pointer(type: string, target: HTMLElement, x: number, y: number, id = 1, button = 0) {
  target.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: id, isPrimary: true, button, clientX: x, clientY: y }));
}
async function emit(type: string, target: HTMLElement, x: number, y: number, id = 1, button = 0) {
  await act(async () => { pointer(type, target, x, y, id, button); });
}
async function test(name: string, run: (f: { update: (o?: Partial<Options>) => Promise<void>; event: typeof emit; logs: Log[]; source: () => Result; unmount: () => Promise<void>; setPlaying: (v: boolean) => void }) => Promise<void>) {
  const host = document.createElement('div'); document.querySelector('#fixture')!.append(host);
  const root = createRoot(host); let mounted = true; const logs: Log[] = [];
  let options: Options;
  const boxRef: Options['boxRef'] = { current: null };
  playState = true;
  const rec = (name: string) => (...args: unknown[]) => { logs.push({ name, args }); if (name === 'pause') playState = false; if (name === 'play') playState = true; if (name === 'seek' && args[1] === true) playState = true; };
  const commands: Options['commands'] = {
    isPlaying: () => playState, pause: rec('pause'), play: rec('play'), toggle: rec('toggle'), seek: rec('seek'),
    pullEdge: rec('pullEdge'), stepEpisode: rec('stepEpisode'), tap: rec('tap'), cancelTap: rec('cancelTap'), lockSpeed: rec('lockSpeed'), showTime: rec('showTime'),
  };
  options = { active: true, resetKey: 'source-A', isDesktop: false, isIos: true, kind: 'video', boxRef,
    rotated: false, surfaceReady: true, time: 20, duration: 100, episodesAvailable: true, hasPrevious: true, hasNext: true, episodeBusy: () => false, commands };
  const update = async (o: Partial<Options> = {}) => { options = { ...options, ...o }; await act(async () => root.render(<Probe options={options}/>)); };
  const unmount = async () => { if (mounted) { await act(async () => root.unmount()); mounted = false; } };
  try {
    await update();
    const surface = box(); const rail = host.querySelector<HTMLElement>('[data-rail]')!; const bar = host.querySelector<HTMLElement>('[data-bar]')!;
    for (const [el,w,h,left,top] of [[surface,400,200,0,0],[rail,400,50,0,0],[bar,400,12,0,0]] as const) {
      Object.defineProperty(el, 'clientWidth', { configurable: true, value: w });
      el.getBoundingClientRect = () => ({ x:left,y:top,left,top,right:left+w,bottom:top+h,width:w,height:h,toJSON(){} });
      (el as HTMLElement & { setPointerCapture: (id:number)=>void; hasPointerCapture:(id:number)=>boolean; releasePointerCapture:(id:number)=>void }).setPointerCapture = function(id:number){ this.dataset.capture=String(id); };
      (el as HTMLElement & { hasPointerCapture: (id:number)=>boolean }).hasPointerCapture = function(id:number){ return this.dataset.capture===String(id); };
      (el as HTMLElement & { releasePointerCapture: (id:number)=>void }).releasePointerCapture = function(){ delete this.dataset.capture; };
    }
    await run({ update, event: emit, logs, source: () => latest, unmount, setPlaying: v => { playState = v; } });
    results.push({ name, passed: true });
  } catch (e) { results.push({ name, passed: false, error: String(e) }); }
  finally { await unmount(); host.remove(); await wait(10); }
}

await test('380ms hold activates speed; upward 64px arms and pointerup locks; cancel does not lock', async ({ event, logs }) => {
  await event('pointerdown', box(), 200, 100); await wait(405); await act(async()=>{});
  assert(state().holdSpeed === true, '380ms pointer hold did not activate holdSpeed');
  await event('pointermove', box(), 200, 35); assert(state().lockArmed === true, '65px upward move did not arm lock');
  await event('pointerup', box(), 200, 35); assert(logs.some(x=>x.name==='lockSpeed'), 'pointerup after arm did not call lockSpeed');
  logs.length=0; await event('pointerdown', box(), 200, 100, 2); await wait(405); await act(async()=>{});
  await event('pointermove', box(), 200, 35, 2); await event('pointercancel', box(), 200, 35, 2);
  assert(!logs.some(x=>x.name==='lockSpeed'), 'pointercancel incorrectly locked speed');
});
await test('14px horizontal move stays tap; over 14px scrubs and resumes prior playing state', async ({ event, logs, setPlaying }) => {
  await event('pointerdown', box(), 200, 100); await event('pointermove', box(), 214, 100); await event('pointerup', box(), 214, 100);
  assert(logs.some(x=>x.name==='tap'), 'exact 14px motion should remain tap');
  logs.length=0; setPlaying(true); await event('pointerdown', box(), 200, 100, 2); await event('pointermove', box(), 215, 100, 2);
  assert(logs.some(x=>x.name==='pause'), '15px horizontal drag did not pause');
  await event('pointerup', box(), 215, 100, 2); const seek=logs.find(x=>x.name==='seek');
  assert(seek && seek.args[1]===true, 'scrub seek did not request resume for initially playing media');
  logs.length=0; setPlaying(false); await event('pointerdown', box(), 200, 100, 3); await event('pointermove', box(), 215, 100, 3); await event('pointerup', box(), 215, 100, 3);
  assert(logs.some(x=>x.name==='seek'&&x.args[1]===false), 'scrub seek did not preserve initially paused media');
});
await test('first/last episode edge pull is damped; next episode threshold controls step', async ({ event, logs, update }) => {
  await update({ hasPrevious: false }); await event('pointerdown', box(), 20, 100); await event('pointermove', box(), 90, 100);
  const before=logs.filter(x=>x.name==='pullEdge').at(-1)?.args[0] as number;
  assert(before > 0 && before < 70, 'first episode outward pull was not damped'); await event('pointerup', box(), 90, 100);
  await update({ hasNext: false }); await event('pointerdown', box(), 380, 100, 2); await event('pointermove', box(), 310, 100, 2);
  const after=logs.filter(x=>x.name==='pullEdge').at(-1)?.args[0] as number;
  assert(after < 0 && Math.abs(after) < 70, 'last episode outward pull was not damped'); await event('pointerup', box(), 310, 100, 2);
  logs.length=0; await update({ hasNext: true }); await event('pointerdown', box(), 380, 100, 3); await event('pointermove', box(), 317, 100, 3); await event('pointerup', box(), 317, 100, 3);
  assert(!logs.some(x=>x.name==='stepEpisode'), '63px swipe stepped below the 64px threshold');
  await event('pointerdown', box(), 380, 100, 4); await event('pointermove', box(), 315, 100, 4); await event('pointerup', box(), 315, 100, 4);
  assert(logs.some(x=>x.name==='stepEpisode'&&x.args[0]===1), '65px right-edge leftward swipe failed episode threshold');
});
await test('rail swipe synthetic click is consumed once; unrelated pointer is rejected', async ({ event, logs, source }) => {
  const rail=document.querySelector<HTMLElement>('[data-rail]')!;
  await event('pointerdown', rail, 380, 100); await event('pointermove', rail, 310, 100); await event('pointerup', rail, 310, 100);
  assert(source().consumeRailSwipe()===true, 'successful rail swipe was not marked for synthetic click suppression');
  assert(source().consumeRailSwipe()===false, 'rail click suppression was not one-shot');
  logs.length=0; await event('pointerdown', box(), 200, 100, 8); await event('pointermove', box(), 220, 100, 9); await event('pointerup', box(), 220, 100, 9);
  assert(!logs.some(x=>x.name==='pause'||x.name==='seek'||x.name==='tap'), 'non-owner pointer changed gesture state');
});
await test('single owner rejects second pointer/bar and retired timer cannot affect next pointer', async ({ event, logs }) => {
  await event('pointerdown', box(), 200, 100, 11); await event('pointerdown', box(), 200, 100, 12); await wait(405);
  assert(state().holdSpeed===true, 'second pointer cancelled the original hold timer');
  await event('pointerup', box(), 200, 100, 12); assert(state().holdSpeed===true, 'non-owner pointer ended active hold');
  await event('pointercancel', box(), 200, 100, 11); assert(state().holdSpeed===false, 'owner pointercancel did not release hold');
  logs.length=0; await event('pointerdown', box(), 200, 100, 13); await wait(405);
  assert(state().holdSpeed===true, 'new owner did not establish its own hold');
  await event('pointerup', box(), 200, 100, 13); assert(!logs.some(x=>x.name==='lockSpeed'), 'retired pointer timer locked the new owner');
  logs.length=0; await event('pointerdown', box(), 200, 100, 14); await event('pointermove', box(), 220, 100, 14);
  const bar=document.querySelector<HTMLElement>('[data-bar]')!; await event('pointerdown', bar, 100, 2, 15); await event('pointermove', bar, 300, 2, 15); await event('pointerup', bar, 300, 2, 15);
  await event('pointerup', box(), 220, 100, 14);
  assert(logs.filter(x=>x.name==='seek').length===1 && logs.some(x=>x.name==='pause') && logs.find(x=>x.name==='seek')?.args[0]===25, `busy bar stole active scrub or caused a second seek: ${JSON.stringify(logs)}`);
});
await test('second surface pointer cannot steal a playing scrub or alter its resume intent', async ({ event, logs }) => {
  await event('pointerdown', box(), 200, 100, 41); await event('pointermove', box(), 230, 100, 41);
  await event('pointerdown', box(), 50, 100, 42); await event('pointermove', box(), 80, 100, 42); await event('pointerup', box(), 80, 100, 42);
  assert(!logs.some(x=>x.name==='play'), 'rejected pointer up restored playback before owner completed');
  await event('pointerup', box(), 230, 100, 41);
  assert(logs.some(x=>x.name==='seek'&&x.args[1]===true), 'owner scrub lost initial playing state after rejected pointer');
});
await test('bar cancel/lostcapture and surface lostcapture clear without stale seek', async ({ event, logs }) => {
  const bar=document.querySelector<HTMLElement>('[data-bar]')!;
  await event('pointerdown', bar, 100, 2, 21); await event('pointercancel', bar, 300, 2, 21);
  assert(!logs.some(x=>x.name==='seek'), 'cancelled progress bar committed a seek');
  await event('pointerdown', bar, 100, 2, 23); await event('lostpointercapture', bar, 100, 2, 23); await event('pointerup', bar, 300, 2, 23);
  assert(!logs.some(x=>x.name==='seek'), 'lost bar capture left a drag that committed');
  await event('pointerdown', box(), 200, 100, 22); await event('lostpointercapture', box(), 200, 100, 22);
  await event('pointerup', box(), 230, 100, 22); assert(!logs.some(x=>x.name==='seek'), 'lost capture left a scrub that committed');
});
await test('active false, attempt change, resize, iOS layout change and unmount clean without playing a new source', async ({ event, logs, update, unmount, setPlaying }) => {
  const begin=async(id:number)=>{setPlaying(false);await event('pointerdown',box(),200,100,id);await event('pointermove',box(),220,100,id);};
  await begin(31); await update({ active:false, resetKey:'source-B' });
  await update({ active:true }); assert(!logs.some(x=>x.name==='play'), 'active transition cleanup played the new source');
  logs.length=0; await begin(32); await update({ resetKey:'attempt-2' }); assert(!logs.some(x=>x.name==='play'), 'attempt cleanup played source');
  logs.length=0; await begin(33); await act(async()=>{Object.defineProperty(window,'innerWidth',{configurable:true,value:window.innerWidth+1});window.dispatchEvent(new Event('resize'));}); assert(!logs.some(x=>x.name==='play'), 'resize cleanup played new source');
  logs.length=0; await begin(34); await act(async()=>{window.dispatchEvent(new Event(IOS_LAYOUT_CHANGE));}); assert(!logs.some(x=>x.name==='play'), 'iOS layout cleanup played new source');
  logs.length=0; await begin(35); await unmount(); assert(!logs.some(x=>x.name==='play'), 'unmount cleanup played new source');
});
await test('desktop pointer events never take playback ownership', async ({ event, logs, update }) => {
  await update({ isDesktop:true }); await event('pointerdown',box(),200,100); await wait(405); await event('pointermove',box(),220,100); await event('pointerup',box(),220,100);
  const bar=document.querySelector<HTMLElement>('[data-bar]')!; await event('pointerdown',bar,100,2,51); await event('pointerup',bar,300,2,51);
  assert(logs.length===0 && state().holdSpeed===false, 'desktop surface or progress bar gesture took playback ownership');
});
await test('initially absent surface attaches the hold touch guard after page mount', async ({ event, update }) => {
  await update({ surfaceReady: false });
  assert((box() as HTMLElement) && !((document.querySelector('[data-box]') as HTMLElement).dataset.capture), 'fixture surface setup failed');
  await update({ surfaceReady: true });
  await event('pointerdown', box(), 200, 100); await wait(405); await act(async()=>{});
  const touch = new Event('touchmove', { bubbles: true, cancelable: true });
  box().dispatchEvent(touch);
  assert(touch.defaultPrevented, 'touchmove on newly attached surface was not prevented during hold');
});

document.querySelector('#results')!.textContent = JSON.stringify({ passed: results.filter(r=>r.passed).length, failed: results.filter(r=>!r.passed).length, results }, null, 2);
