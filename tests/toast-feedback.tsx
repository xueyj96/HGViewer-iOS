import React, { act, useLayoutEffect, useRef } from "react";
import { createRoot } from "react-dom/client";
import { ToastProvider, useToastActions, useToasts, type Toast } from "../src/toasts";
import { IOSNavigationScope } from "../src/components/IOSNavigation";
import { ConfirmAction, ErrorStatus, PageStatus, PlaybackError, ToastHost } from "../src/components/ui";
import { useToastFeedback } from "../src/components/useToastFeedback";
import { useOfflineStatus } from "../src/components/useOfflineStatus";
import { CommentsPanel } from "../src/components/Panels";
import { AppProvider } from "../src/store";
import { api, isIos } from "../src/api";
import type { CommentPage } from "../src/types";
import CoverActionMenu from "../src/components/CoverActionMenu";
import { useIOSCoverMenu } from "../src/components/IOSCoverMenu";
import "../src/index.css";
import "../src/ios.css";
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
declare global { interface Window { __captureToast?: (name: string) => Promise<void> } }
const results: {name:string;passed:boolean;error?:string}[]=[];
const assert=(value:unknown,message:string)=>{if(!value)throw Error(message);};
const wait=async(ms=30)=>{await act(async()=>{await new Promise(resolve=>setTimeout(resolve,ms));});};
const container=document.querySelector<HTMLElement>("#fixture")!;
const root=createRoot(container);
document.documentElement.classList.add("plat-ios");
let snapshot:Toast[]=[];
let actions:ReturnType<typeof useToastActions>;
let dismiss:(id:number)=>void;
function Observe(){const state=useToasts();const current=useToastActions();useLayoutEffect(()=>{snapshot=state.toasts;dismiss=state.dismissToast;actions=current;});return null;}
function Feedback({message,active=true,scope}:{message:string;active?:boolean;scope?:string}){useToastFeedback(message,active,scope);return null;}
let offlineActions:ReturnType<typeof useOfflineStatus>;
function OfflineActionFixture({active}:{active:boolean}){offlineActions=useOfflineStatus(active);return null;}
function MenuFixture(){
 const scroll=useRef<HTMLDivElement>(null);const {toast}=useToastActions();
 useIOSCoverMenu(scroll,true,true,()=>toast("已移除观看记录","info",{label:"撤销",run:()=>{}}));
 return <><div ref={scroll}><button data-hg-menu-card="1" style={{width:90,height:120,margin:24}}>历史卡片</button></div><CoverActionMenu/></>;
}
let fixtureKey=0;
async function render(content:React.ReactNode,fresh=false){if(fresh)++fixtureKey;await act(async()=>root.render(<React.StrictMode><ToastProvider key={fixtureKey}><Observe/>{content}<ToastHost/></ToastProvider></React.StrictMode>));await wait();}
async function clear(){await act(async()=>snapshot.forEach(item=>dismiss(item.id)));}
async function test(name:string,fn:()=>Promise<void>){try{await render(null,true);await fn();results.push({name,passed:true});}catch(error){results.push({name,passed:false,error:String(error)});}}
await test("silent mount and ordinary empty content never gain a success toast",async()=>{
 await render(<><Feedback message=""/><PageStatus title="还没有收藏"/></>);
 assert(snapshot.length===0,"silent state created feedback");
});
await test("one existing error is delivered once across StrictMode and progress rerenders",async()=>{
 await render(<><Feedback message="读取失败"/><span>0%</span></>);assert(snapshot.length===1,"missing or StrictMode duplicated feedback");
 for(let i=0;i<3;i++)await render(<><Feedback message="读取失败"/><span>{i}%</span></>);
 assert(snapshot.length===1,"progress repeated error");
});
await test("inactive results are consumed without replay when the page returns",async()=>{
 await render(<Feedback message="过期错误" active={false}/>);
 await render(<Feedback message="过期错误" active/>);assert(snapshot.length===0,"inactive result replayed");
 await render(<Feedback message="" active/>);await render(<Feedback message="过期错误" active/>);
 assert(snapshot.length===1,"new failure interval not reported");
});
await test("inactive navigation scope suppresses a visible child error",async()=>{
 await render(<IOSNavigationScope active={false}><Feedback message="隐藏预览失败"/></IOSNavigationScope>);
 await render(<IOSNavigationScope active><Feedback message="隐藏预览失败"/></IOSNavigationScope>);
 assert(snapshot.length===0,"preview failure escaped its scope");
});
await test("shared read errors do not replay on cache page remount and recover between intervals",async()=>{
 await render(<Feedback key="one" scope="offline-read-test" message="缓存读取失败"/>);assert(snapshot.length===1,"missing read error");
 await render(<Feedback key="two" scope="offline-read-test" message="缓存读取失败"/>);assert(snapshot.length===1,"cache page switch replayed read error");
 await render(<Feedback key="three" scope="offline-read-test" message=""/>);
 await render(<Feedback key="four" scope="offline-read-test" message="缓存读取失败"/>);assert(snapshot.length===2,"read recovery did not rearm");
});
await test("shared job feedback deduplicates by stable task identity without new success messages",async()=>{
 await render(<Feedback key="detail" scope="offline-job:1:2:" message="合成失败"/>);
 await render(<Feedback key="library" scope="offline-job:1:2:" message="合成失败"/>);assert(snapshot.length===1,"same task replayed");
 await render(<Feedback scope="offline-job:2:2:" message="合成失败"/>);assert(snapshot.length===2,"another task was swallowed");
 await render(<Feedback scope="offline-job:2:2:" message=""/>);assert(snapshot.length===2,"silent completion gained a toast");
});
await test("offline action feedback belongs to its original presentation while background work continues",async()=>{
 const browser=window as unknown as {__TAURI_INTERNALS__?:{invoke:(command:string)=>Promise<unknown>}};
 const bridge=browser.__TAURI_INTERNALS__;
 browser.__TAURI_INTERNALS__={invoke:async()=>({items:[],jobs:[],recent:[],shows:{},bytes:0})};
 try{
  await render(<OfflineActionFixture active/>);
  let reject!:(error:Error)=>void;let settled=false;let pending!:Promise<void>;
  await act(async()=>{pending=offlineActions.runAction(()=>new Promise<void>((_,fail)=>{reject=fail;})).then(()=>{settled=true;});});
  await render(<OfflineActionFixture active={false}/>);
  await render(<OfflineActionFixture active/>);
  assert(!settled && offlineActions.busy,"leaving cancelled the background action");
  await act(async()=>{reject(new Error("旧操作失败"));await pending;});
  assert(settled && !offlineActions.busy && snapshot.length===0,"old rejection escaped into the returned presentation");
  await act(async()=>{await offlineActions.runAction(async()=>{throw new Error("当前操作失败");});});
  assert(snapshot.length===1 && snapshot[0].msg==="当前操作失败","current action feedback was lost");
 }finally{await render(null);browser.__TAURI_INTERNALS__=bridge;}
});
if(isIos)await test("comment refresh failure cannot report after leaving and returning to the same panel",async()=>{
 const browser=window as unknown as {__TAURI_INTERNALS__?:{invoke:(command:string)=>Promise<unknown>}};
 const bridge=browser.__TAURI_INTERNALS__,originalComments=api.comments;
 browser.__TAURI_INTERNALS__={invoke:async command=>command==="app_boot"?{user:null,strict_security:true}:null};
 const loaded={ep:1,items:[{id:1,user_id:1,nickname:"fixture",text:"已加载评论",time:"现在",like_count:0,reply_count:0}],pagination:{page:1,pages:1,total:1,size:20}} as CommentPage;
 const panel=(visible:boolean)=><AppProvider><Observe/><CommentsPanel videoId={41} ep={1} total={1} showNavigation={visible} onClose={()=>{}}/></AppProvider>;
 try{
  api.comments=async()=>loaded;await render(panel(true));
  assert(container.textContent?.includes("已加载评论"),"initial comments did not load");
  let reject!:(error:Error)=>void;api.comments=()=>new Promise<CommentPage>((_,fail)=>{reject=fail;});
  await act(async()=>container.querySelector<HTMLButtonElement>('[aria-label="刷新评论"]')!.click());
  await render(panel(false));await render(panel(true));
  await act(async()=>reject(new Error("旧刷新失败")));await wait();
  assert(snapshot.length===0 && container.textContent?.includes("已加载评论"),"old refresh reported or removed existing comments");
  api.comments=async()=>{throw new Error("当前刷新失败");};
  await act(async()=>container.querySelector<HTMLButtonElement>('[aria-label="刷新评论"]')!.click());await wait();
  assert(snapshot.length===1 && snapshot[0].msg==="评论刷新失败，请重试","current refresh lost its existing feedback");
 }finally{await render(null);api.comments=originalComments;browser.__TAURI_INTERNALS__=bridge;}
});
await test("error details move outside content while retry remains usable after dismiss",async()=>{
 let retried=0;await render(<ErrorStatus message="可重试详情" onRetry={()=>{retried++;}}/>);
 assert(snapshot.length===1 && !container.textContent?.includes("可重试详情"),"error remained in page text or failed to notify");
 await clear();const retry=container.querySelector<HTMLButtonElement>("button")!;await act(async()=>retry.click());
 assert(retried===1 && snapshot.length===0,"retry disappeared with toast");
});
await test("playback failure uses the same exit and keeps its retry/loading semantics",async()=>{
 let retried=0;await render(<PlaybackError message="播放源失效" onRetry={()=>{retried++;}}/>);
 assert(snapshot.length===1 && !container.textContent?.includes("播放源失效"),"playback error bypassed common host");
 await act(async()=>container.querySelector<HTMLButtonElement>("button")!.click());assert(retried===1,"playback retry lost");
 await render(<PlaybackError message="播放源失效" onRetry={()=>{retried++;}} retrying/>);
 assert(container.querySelector<HTMLButtonElement>("button")!.disabled,"retrying no longer disables duplicate retry");
});
await test("confirmation failures preserve the original question and use the common toast",async()=>{
 await render(<ConfirmAction open title="清理缓存" message="保留下载，清理临时缓存？" confirm="清理" error="清理失败" onCancel={()=>{}} onConfirm={()=>{}}/>);
 const dialog=document.querySelector<HTMLElement>(".hg-confirm-content")!;
 assert(dialog.textContent?.includes("保留下载，清理临时缓存？") && !dialog.textContent?.includes("清理失败"),"failure replaced confirmation content");
 assert(snapshot.length===1 && snapshot[0].msg==="清理失败","confirmation bypassed toast");
 assert(!document.querySelector<HTMLElement>(".hg-toast-host")!.inert,"modal disabled the global feedback host");
});
await test("menu feedback and undo remain above the cover popover during its exit",async()=>{
 await render(<MenuFixture/>);
 const card=container.querySelector<HTMLElement>("[data-hg-menu-card]")!;
 await act(async()=>card.dispatchEvent(new MouseEvent("contextmenu",{bubbles:true,cancelable:true,clientX:50,clientY:70})));
 await wait(30);
 assert(document.querySelector(".hg-cover-menu-layer:popover-open"),"actual cover popover did not open");
 const remove=[...document.querySelectorAll<HTMLButtonElement>(".hg-cover-action-item")].find(item=>item.textContent?.includes("移除"))!;
 assert(remove,"history remove action missing");await act(async()=>remove.click());await wait(30);
 const undo=document.querySelector<HTMLButtonElement>(".hg-toast-action")!;assert(undo,"menu feedback missing");
 const rect=undo.getBoundingClientRect(),hit=document.elementFromPoint(rect.x+rect.width/2,rect.y+rect.height/2);
 assert(hit===undo || undo.contains(hit),`feedback blocked by ${hit instanceof Element?hit.className:String(hit)}`);
});
await test("one persistent host is attached to body and centered outside transformed page content",async()=>{
 await render(<div style={{transform:"translate(90px, 40px)"}}><span>页面</span></div>);
 await act(async()=>actions.toast("居中提示","info"));await wait(300);
 const hosts=[...document.querySelectorAll<HTMLElement>(".hg-toast-host")];assert(hosts.length===1 && hosts[0].parentElement===document.body,"host is duplicated or belongs to page layer");
 const rect=document.querySelector<HTMLElement>(".hg-toast")!.getBoundingClientRect();
 assert(Math.abs(rect.x+rect.width/2-window.innerWidth/2)<1 && Math.abs(rect.y+rect.height/2-window.innerHeight/2)<1,"toast does not center on screen");
 assert(hosts[0].getAttribute("aria-live")==="polite","feedback lost live announcement");
 await window.__captureToast?.("center");
});
await test("host tracks visible viewport for landscape offsets and keyboard without moving with the page",async()=>{
 const original=window.visualViewport;
 const fake=Object.assign(new EventTarget(),{offsetLeft:0,offsetTop:0,width:390,height:844});
 Object.defineProperty(window,"visualViewport",{configurable:true,value:fake});
 try {
  await render(null,true);await act(async()=>actions.toast("视口提示","info"));await wait(300);
  const host=document.querySelector<HTMLElement>(".hg-toast-host")!;
  for(const viewport of [{offsetLeft:59,offsetTop:0,width:726,height:390},{offsetLeft:0,offsetTop:72,width:390,height:370}]){
   Object.assign(fake,viewport);await act(async()=>fake.dispatchEvent(new Event("resize")));await wait();
   const rect=host.getBoundingClientRect();assert(Math.abs(rect.x-viewport.offsetLeft)<.5 && Math.abs(rect.y-viewport.offsetTop)<.5 && Math.abs(rect.width-viewport.width)<.5 && Math.abs(rect.height-viewport.height)<.5,"visible viewport bounds ignored");
   const card=document.querySelector<HTMLElement>(".hg-toast")!.getBoundingClientRect();assert(Math.abs(card.x+card.width/2-(viewport.offsetLeft+viewport.width/2))<1 && Math.abs(card.y+card.height/2-(viewport.offsetTop+viewport.height/2))<1,"keyboard/landscape center drifted");
  }
 } finally {Object.defineProperty(window,"visualViewport",{configurable:true,value:original});}
});
await test("normal and undo toast lifetimes stay distinct and undo still dismisses once",async()=>{
 let undone=0;await act(async()=>{actions.toast("普通提示","info");actions.toast("已移除","info",{label:"撤销",run:()=>{undone++;}});});
 await wait(2300);assert(snapshot.length===1 && snapshot[0].action?.label==="撤销","toast lifetimes changed");
 const button=document.querySelector<HTMLButtonElement>(".hg-toast-action")!;await act(async()=>button.click());
 assert(undone===1 && snapshot.length===0,"undo action or dismissal changed");
});
await act(async()=>root.unmount());
document.querySelector("#results")!.textContent=JSON.stringify({passed:results.filter(r=>r.passed).length,failed:results.filter(r=>!r.passed).length,results},null,2);
