import React, { act, useLayoutEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { IOSHeaderButton } from "../src/components/IOSHeaderButton";
import { useIOSTopBarMotion } from "../src/components/useIOSTopBarMotion";
import * as Icons from "../src/icons";
import "../src/index.css";
import "../src/ios.css";
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const results: { name: string; passed: boolean; error?: string }[] = [];
const assert = (ok: unknown, message: string) => { if (!ok) throw Error(message); };
const tick = async () => { await act(async () => { await new Promise(resolve => setTimeout(resolve, 25)); }); };
const rootElement = document.querySelector<HTMLElement>("#fixture")!;
let actions: { change: (label: string) => void; remount: () => void; remountButton: () => void };
function Fixture() {
 const [host, setHost] = useState<HTMLDivElement | null>(null);
 const [label, setLabel] = useState("账号"); const [key, setKey] = useState(0);
 const [buttonKey, setButtonKey] = useState(0);
 useIOSTopBarMotion(host);
 useLayoutEffect(() => { actions = { change: setLabel, remount: () => setKey(k => k + 1), remountButton: () => setButtonKey(k => k + 1) }; }, []);
 return <><div ref={setHost} className="hg-ios-top-bar" style={{ position: "relative", width: 360, height: 100 }}>
  <div key={key} className="hg-ios-floating-bar" style={{ top: 0 }}>
   <div className="hg-ios-floating-panel"><h1>固定标题</h1></div>
   <div className="hg-ios-floating-actions hg-ios-floating-actions-end">
    <IOSHeaderButton key={buttonKey} aria-label={label} className="hg-ios-floating-button hg-ios-header-square grid place-items-center">
      {label === "账号" ? <Icons.IUser size={20} /> : label === "信息" ? <Icons.IInfo size={20} /> : label}
    </IOSHeaderButton>
   </div>
  </div>
 </div><div data-icons>{Object.entries(Icons).filter(([name]) => name.startsWith("I")).map(([name, Icon]) => <span key={name}>{React.createElement(Icon as typeof Icons.IUser, { size: 20 })}</span>)}</div></>;
}
document.documentElement.classList.add("plat-ios");
const root = createRoot(rootElement);
const mount = async () => { await act(async () => root.render(<Fixture key={Math.random()} />)); await tick(); };
const live = () => rootElement.querySelector<HTMLElement>('[data-nav-current="true"] .hg-ios-action-content')!;
const test = async (name: string, fn: () => Promise<void>) => { try { await mount(); await fn(); results.push({ name, passed: true }); } catch(error) { results.push({name,passed:false,error:String(error)}); } };
await test("action glyph crossfades for 240ms while hit target and material remain fixed", async () => {
 const button = live().closest("button")!; const before = button.getBoundingClientRect();
 await act(async () => actions.change("信息")); await tick();
 const node = live(), a = node.getAnimations()[0]; assert(a, "no live glyph animation");
 a.pause(); a.currentTime = 120;
 const ghost = rootElement.querySelector<HTMLElement>(".hg-ios-nav-ghost-content")!;
 assert(ghost?.inert && ghost.getAttribute("aria-hidden")==="true", "outgoing copy can interact");
 const g = ghost.getAnimations()[0]; g.pause(); g.currentTime = 120;
 assert(Number(a.effect?.getTiming().duration)===240, "action duration not coordinated");
 assert(Math.abs(Number(getComputedStyle(node).opacity)-.5)<.03, "glyph does not have visible midpoint");
 const next = node.closest("button")!, box=next.getBoundingClientRect();
 assert(getComputedStyle(next).opacity==="1" && next.getAnimations().length===0, "button itself fades");
 assert(getComputedStyle(ghost.querySelector("button")!,"::before").visibility==="hidden", "duplicate material overlays new face");
 assert(Math.abs(before.x-box.x)<.5 && Math.abs(before.width-box.width)<.5, "hit target moved");
});
await test("same content remount continues current opacity on the new node", async () => {
 await act(async () => actions.change("信息")); await tick();
 const old = live(), a=old.getAnimations()[0]; assert(a,"no entrance"); a.pause(); a.currentTime=90;
 const opacity=Number(getComputedStyle(old).opacity);
 await act(async () => actions.remount()); await tick();
 const next=live(), b=next.getAnimations()[0]; assert(next!==old && b,"remounted glyph has no replacement animation");
 b.pause();b.currentTime=0;
 assert(Math.abs(Number(getComputedStyle(next).opacity)-opacity)<.04,"remount jumps opacity");
});
await test("settled identical action does not reanimate between pages", async () => {
 await act(async () => actions.remount()); await tick();
 assert(live().getAnimations().length===0,"stable content unnecessarily fades");
});
await test("keyed button remount continues opacity even when the slot wrapper survives", async () => {
 await act(async () => actions.change("信息")); await tick();
 const old=live(),a=old.getAnimations()[0];assert(a,"no entrance");a.pause();a.currentTime=100;
 const opacity=Number(getComputedStyle(old).opacity), wrapper=old.closest(".hg-ios-floating-actions");
 await act(async () => actions.remountButton());await tick();
 const next=live(),b=next.getAnimations()[0];assert(next!==old && next.closest(".hg-ios-floating-actions")===wrapper && b,"reused slot lost action animation");
 b.pause();b.currentTime=0;assert(Math.abs(Number(getComputedStyle(next).opacity)-opacity)<.04,"keyed button jumps opacity");
});
await test("direct text actions participate in the same content-only transition", async () => {
 await act(async () => actions.change("登录"));await tick();
 const node=live();assert(node.textContent==="登录" && node.getAnimations().length>0,"text bypasses content motion");
});
await test("SVG attribute-only update is observed and crossfades", async () => {
 const svg=live().querySelector("svg")!;svg.setAttribute("stroke-width","1");await tick();
 assert(live().getAnimations().length>0,"stroke update was ignored");
});
await test("all shared outline icons and nested strokes use width 2", async () => {
 const svg=[...rootElement.querySelectorAll<SVGSVGElement>("[data-icons] svg")];assert(svg.length>20,"icon inventory empty");
 for(const icon of svg) {
  assert(icon.getAttribute("stroke-width")==="2", "shared root width drift");
  for(const path of icon.querySelectorAll("[stroke-width]")) assert(path.getAttribute("stroke-width")==="2","nested stroke override");
 }
});
await test("rapid action changes remain bounded and settle without ghosts", async () => {
 for(const label of ["信息","登录","注册","信息","账号"]) {await act(async () => actions.change(label));await tick();}
 assert(rootElement.querySelectorAll(".hg-ios-nav-ghost-content").length<=2,"unbounded snapshots");
 await act(async () => {await new Promise(resolve=>setTimeout(resolve,330));});
 assert(!rootElement.querySelector(".hg-ios-nav-ghost"),"retired ghost retained");assert(getComputedStyle(live()).opacity==="1","live content did not settle");
});
await act(async()=>root.unmount());
document.querySelector("#results")!.textContent=JSON.stringify({passed:results.filter(r=>r.passed).length,failed:results.filter(r=>!r.passed).length,results},null,2);
