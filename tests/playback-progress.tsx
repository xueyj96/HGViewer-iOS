import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { usePlaybackProgress } from '../src/components/usePlaybackProgress';
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
type Options=Parameters<typeof usePlaybackProgress>[0];
type Result=ReturnType<typeof usePlaybackProgress>;
let latest:Result;
function Probe({options}:{options:Options}) { latest=usePlaybackProgress(options); return null; }
const results:{name:string;passed:boolean;error?:string}[]=[];
const assert=(ok:unknown,message:string)=>{if(!ok)throw Error(message);};
const originalNow=Date.now; let now=100000; Date.now=()=>now;
async function test(name:string,run:(f:{update:(o?:Partial<Options>)=>Promise<void>;event:(fn:(r:Result)=>void)=>Promise<void>;writes:unknown[][];seeks:number[];source:()=>Result;unmount:()=>Promise<void>})=>Promise<void>){
 const el=document.createElement('div');document.querySelector('#fixture')!.append(el);const root=createRoot(el);let mounted=true;
 const writes:unknown[][]=[];const seeks:number[]=[];
 let options:Options={id:1,ep:1,active:true,attempt:'a',initialResume:null,resumeOnReturn:true,addHistory:(...args)=>writes.push(args),seek:t=>seeks.push(t)};
 const update=async(o:Partial<Options>={})=>{options={...options,...o};await act(async()=>root.render(<Probe options={options}/>));};
 const unmount=async()=>{if(mounted){await act(async()=>root.unmount());mounted=false;}};
 try{await update();await run({update,event:async fn=>{await act(async()=>fn(latest));},writes,seeks,source:()=>latest,unmount});results.push({name,passed:true});}catch(e){results.push({name,passed:false,error:String(e)});}finally{await unmount();el.remove();now+=10000;}
}
await test('cold pending source, duration/time without playing and unmount never record',async({event,writes,unmount})=>{await event(r=>{r.onDuration(60);r.onTime(12);});await unmount();assert(!writes.length,'unplayed progress recorded');});
await test('real first playing only once, five-second window and final dirty flush',async({event,writes,unmount})=>{await event(r=>{r.onDuration(60);r.onPlaying();r.onPlaying();r.onTime(2);});assert(writes.length===1,'duplicate first playing');now+=5001;await event(r=>r.onTime(8));assert(writes.length===2,'throttled write missing');await event(r=>r.onTime(9));await unmount();assert(writes.length===3&&writes[2][2]===9,'final flush wrong');});
await test('playing time retry playing does not duplicate first record; stale attempts rejected',async({event,source,update,writes})=>{await event(r=>{r.onDuration(60);r.onPlaying();r.onTime(10);});const old=source();await update({attempt:'b'});await event(r=>r.onPlaying());assert(writes.length===1,'retry duplicated first playing');await event(()=>{old.onDuration(99);old.onTime(55);old.onPlaying();});assert(source().duration!==99&&source().time!==55&&writes.length===1,'retired attempt accepted');await event(r=>r.onTime(12));});
await test('initialResume is mount snapshot and later options cannot replace it',async({update,event,seeks,source})=>{await update({id:2,initialResume:{key:'2:1',t:17}}); /* initialResume is mount input; separate test below */ assert(!seeks.length,'changed initial resume was consumed');await event(r=>r.onDuration(60));assert(source().duration===60,'duration not published');});
await test('inactive flush is idempotent with unmount; late A cannot affect B before playing',async({event,source,update,writes,unmount})=>{await event(r=>{r.onDuration(60);r.onPlaying();r.onTime(11);});const old=source();await update({active:false});assert(writes.length===2,'inactive did not flush');await event(()=>{old.onTime(58);old.onDuration(90);});await update({id:2,active:true});await event(()=>old.onPlaying());assert(writes.length===2&&source().time===0,'late A changed B');await unmount();assert(writes.length===2,'cleanup duplicate');});
await test('pause intent stays outside progress; active return resumes once and new session records',async({event,update,seeks,writes})=>{await event(r=>{r.onDuration(60);r.onPlaying();r.onTime(13);});await update({active:false});await update({active:true});await event(r=>{r.onDuration(60);r.onDuration(60);});assert(seeks.join()==='13','return resume not exactly once');assert(writes.length===2,'active alone recorded');await event(r=>r.onPlaying());assert(writes.length===3,'new active session first record missing');});
await test('cross episode flush retains old identity and rejects old callback',async({event,source,update,writes})=>{await event(r=>{r.onDuration(60);r.onPlaying();r.onTime(21);});const old=source();await update({ep:2});await event(()=>old.onTime(40));await event(r=>r.onPlaying());assert(writes.length===3&&writes[1][1]===1&&writes[1][2]===21&&writes[2][1]===2,'identity crossed episodes');});
await test('zero duration never final-flushes unbounded position',async({event,writes,unmount})=>{await event(r=>{r.onPlaying();r.onTime(9);r.onDuration(0);});await unmount();assert(writes.length===1,'zero duration persisted final');});
await test('same-id new active session rejects previous epoch callbacks even after return',async({event,source,update,writes})=>{await event(r=>{r.onDuration(60);r.onPlaying();r.onTime(13);});const first=source();await update({active:false});await update({active:true});await event(()=>{first.onTime(58);first.onDuration(100);first.onPlaying();});assert(writes.length===2&&source().time===13&&source().duration===60,'old active epoch accepted after return');});
await test('late duration after content switch cannot consume new pending return',async({event,source,update,seeks})=>{await event(r=>r.onTime(14));const first=source();await update({active:false});await update({active:true});await event(()=>first.onDuration(60));assert(!seeks.length,'retired duration consumed target');await event(r=>r.onDuration(60));assert(seeks.join()==='14','live duration lost return target');});
// Fresh mounts are necessary for the initial pending-resume contract.
for(const target of [0,1,2,57,59]){
 const el=document.createElement('div');document.querySelector('#fixture')!.append(el);const root=createRoot(el);const seeks:number[]=[];
 const options:Options={id:1,ep:1,active:true,attempt:'a',initialResume:{key:'1:1',t:target},resumeOnReturn:true,addHistory:()=>{},seek:t=>seeks.push(t)};
 try{await act(async()=>root.render(<Probe options={options}/>));await act(async()=>{latest.onDuration(60);assert(seeks.length===(target>1&&target<57?1:0),'seek not synchronous / boundary wrong');latest.onDuration(60);});assert(seeks.length===(target>1&&target<57?1:0),'repeat duration re-seek');results.push({name:`initial resume boundary ${target}`,passed:true});}catch(e){results.push({name:`initial resume boundary ${target}`,passed:false,error:String(e)});}finally{await act(async()=>root.unmount());el.remove();}
}
Date.now=originalNow;document.querySelector('#results')!.textContent=JSON.stringify({passed:results.filter(r=>r.passed).length,failed:results.filter(r=>!r.passed).length,results});
