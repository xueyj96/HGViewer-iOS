import { StrictMode, act } from "react";
import { createRoot } from "react-dom/client";
import { api } from "../src/api";
import { AppProvider, useStore } from "../src/store";
import { useToasts } from "../src/toasts";
import LoginModal from "../src/components/LoginModal";
import { IOSNavigation } from "../src/components/IOSNavigation";
import type { User } from "../src/types";
import { isStrictSecurity, setStrictSecurity } from "../src/html";
import "../src/index.css";
import "../src/ios.css";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const original = { boot: api.boot, login: api.login, register: api.register, logout: api.logout };
const previousPersist = localStorage.getItem("hghub_app_v1");
const previousSecurity = isStrictSecurity();
const results: { name: string; passed: boolean; error?: string }[] = [];
const assert = (ok: unknown, message: string) => { if (!ok) throw new Error(message); };
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const user = (id: number): User => ({ id, username: `fixture${id}`, nickname: `fixture${id}`, avatar: "", avatar_color: "" });
const boot = (account: User | null = null, strict = true) => ({ user: account, logged_in: !!account,
  base: "https://fixture.invalid", strict_security: strict, cli_relaxed: false });
type Store = ReturnType<typeof useStore>;
type ToastState = ReturnType<typeof useToasts>;
type Fixture = { mount: (ui?: boolean) => Promise<void>; store: () => Store; toasts: () => ToastState; unmount: () => Promise<void> };
async function test(name: string, run: (fixture: Fixture) => Promise<void>) {
  api.boot = async () => boot(); api.login = async () => ({ user: user(1) });
  api.register = async () => ({ user: user(2) }); api.logout = async () => ({ ok: true });
  localStorage.setItem("hghub_app_v1", "{}");
  let store!: Store, toasts!: ToastState, mounted = false;
  function Probe() { store = useStore(); toasts = useToasts(); return null; }
  const host = document.createElement("div"); document.querySelector("#fixture")!.append(host);
  const root = createRoot(host);
  const mount = async (ui = false) => {
    await act(async () => { root.render(<StrictMode><AppProvider><Probe />{ui &&
      <div className="plat-ios" style={{ position: "relative", width: 390, height: 700 }}>
        <IOSNavigation immersive={false} playbackRoute={false} bottom={null}><LoginModal /></IOSNavigation>
      </div>}</AppProvider></StrictMode>); });
    mounted = true;
  };
  const unmount = async () => { if (mounted) { await act(async () => root.unmount()); mounted = false; } };
  try { await run({ mount, store: () => store, toasts: () => toasts, unmount }); results.push({ name, passed: true }); }
  catch (error) { results.push({ name, passed: false, error: String(error) }); }
  finally { await unmount(); host.remove(); Object.assign(api, original); setStrictSecurity(previousSecurity); }
}
const authenticate = (store: Store) => store.authenticate({ mode: "login", username: "fixture", password: "fixture-password" });

await test("retired startup user cannot replace accepted login; security boot fields still apply", async ({ mount, store }) => {
  const startup = deferred<ReturnType<typeof boot>>(); api.boot = () => startup.promise;
  await mount(); api.login = async () => ({ user: user(22) });
  await act(async () => { await authenticate(store()); });
  await act(async () => { startup.resolve({ ...boot(user(11), false), cli_relaxed: true }); });
  assert(store().user?.id === 22, "old boot replaced newer login");
  assert(store().strictSecurityReady && !store().strictSecurity && store().cliRelaxed, "account invalidation discarded global boot configuration");
});
await test("logout before startup completes retires boot account", async ({ mount, store }) => {
  const startup = deferred<ReturnType<typeof boot>>(); api.boot = () => startup.promise;
  await mount(); await act(async () => { await store().logout(); });
  await act(async () => startup.resolve(boot(user(11))));
  assert(store().user === null && store().strictSecurityReady, "startup resurrected logged-out account");
});
await test("startup never treats a logged-out snapshot's residual user data as authentication", async ({ mount, store }) => {
  api.boot = async () => ({ ...boot(user(11)), logged_in: false });
  await mount();
  assert(store().user === null && store().strictSecurityReady, "residual user data became an authenticated session");
});
await test("latest authentication wins when successful results arrive in reverse order", async ({ mount, store }) => {
  await mount(); const first = deferred<{ user: User }>(), second = deferred<{ user: User }>();
  let count = 0; api.login = () => (++count === 1 ? first.promise : second.promise);
  let a!: ReturnType<Store["authenticate"]>, b!: ReturnType<Store["authenticate"]>;
  await act(async () => { a = authenticate(store()); b = authenticate(store()); });
  await act(async () => { second.resolve({ user: user(22) }); await b; });
  await act(async () => { first.resolve({ user: user(11) }); });
  assert((await a).status === "superseded" && store().user?.id === 22, "old authentication replaced current account");
});
await test("line round trip retires an authentication even if origin later matches again", async ({ mount, store }) => {
  await mount(); const request = deferred<{ user: User }>(); api.login = () => request.promise;
  let pending!: ReturnType<Store["authenticate"]>;
  await act(async () => { pending = authenticate(store()); store().onLineChanged(); store().onLineChanged(); });
  await act(async () => request.resolve({ user: user(11) }));
  assert((await pending).status === "superseded" && store().user === null, "origin round trip accepted retired account");
});
await test("retired authentication errors are cancelled results, not current form failures", async ({ mount, store }) => {
  await mount(); const request = deferred<{ user: User }>(); api.login = () => request.promise;
  let pending!: ReturnType<Store["authenticate"]>;
  await act(async () => { pending = authenticate(store()); store().onLineChanged(); });
  await act(async () => request.reject(new Error("retired failure")));
  assert((await pending).status === "superseded", "retired error escaped to current account");
});
await test("current failed authentication preserves previously accepted account and reports failure", async ({ mount, store }) => {
  await mount(); await act(async () => { await authenticate(store()); });
  api.login = async () => { throw new Error("current failure"); };
  let failed = false;
  await act(async () => { try { await authenticate(store()); } catch { failed = true; } });
  assert(failed && store().user?.id === 1, "failed attempt corrupted accepted account");
});
await test("malformed account identities cannot replace an accepted account", async ({ mount, store }) => {
  await mount(); await act(async () => { await authenticate(store()); });
  for (const id of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    api.login = async () => ({ user: user(id) }); let failed = false;
    await act(async () => { try { await authenticate(store()); } catch { failed = true; } });
    assert(failed && store().user?.id === 1, "invalid identity was accepted");
  }
});
await test("registration uses the same account owner and keeps its request mode", async ({ mount, store }) => {
  await mount(); let registered = 0;
  api.register = async () => { ++registered; return { user: user(2) }; };
  await act(async () => { await store().authenticate({ mode: "register", username: "fixture", password: "fixture-password", email: "fixture@example.invalid" }); });
  assert(registered === 1 && store().user?.id === 2, "registration bypassed account owner");
});
await test("duplicate logout calls share one in-flight operation", async ({ mount, store }) => {
  await mount(); await act(async () => { await authenticate(store()); });
  const request = deferred<{ ok: boolean }>(); let count = 0;
  api.logout = () => { ++count; return request.promise; };
  let a!: Promise<void>, b!: Promise<void>;
  await act(async () => { a = store().logout(); b = store().logout(); });
  assert(a === b && count === 1, "duplicate logout started another mutation");
  await act(async () => { request.resolve({ ok: true }); await a; });
  assert(store().user === null, "confirmed logout did not clear account");
});
await test("old logout completion cannot clear or announce logout for a new account", async ({ mount, store, toasts }) => {
  await mount(); await act(async () => { await authenticate(store()); });
  const request = deferred<{ ok: boolean }>(); api.logout = () => request.promise;
  let pending!: Promise<void>; await act(async () => { pending = store().logout(); });
  api.login = async () => ({ user: user(22) });
  await act(async () => { await authenticate(store()); });
  await act(async () => { request.resolve({ ok: true }); await pending; });
  assert(store().user?.id === 22 && !toasts().toasts.some((item) => item.msg === "已退出登录"), "old logout affected new account");
});
await test("failed authentication replacing logout reconciles the already-revoked native account", async ({ mount, store }) => {
  await mount(); await act(async () => { await authenticate(store()); });
  const request = deferred<{ ok: boolean }>(); api.logout = () => request.promise;
  let pending!: Promise<void>; await act(async () => { pending = store().logout(); });
  api.login = async () => { throw new Error("new authentication failed"); };
  api.boot = async () => boot(); let failed = false;
  await act(async () => { try { await authenticate(store()); } catch { failed = true; } });
  assert(failed && store().user === null, "revoked account remained visible after failed replacement");
  await act(async () => { request.resolve({ ok: true }); await pending; });
  assert(store().user === null, "retired logout changed reconciled state");
});
await test("failed replacement and failed native readback preserve last known account with uncertainty", async ({ mount, store, toasts }) => {
  await mount(); await act(async () => { await authenticate(store()); });
  const logout = deferred<{ ok: boolean }>(); api.logout = () => logout.promise;
  let pendingLogout!: Promise<void>; await act(async () => { pendingLogout = store().logout(); });
  api.login = async () => { throw new Error("new authentication failed"); };
  api.boot = async () => { throw new Error("readback unavailable"); }; let failed = false;
  await act(async () => { try { await authenticate(store()); } catch { failed = true; } });
  assert(failed && store().user?.id === 1 && toasts().toasts.some((item) => item.msg.includes("未确认")),
    "unknown native state was turned into a confirmed guest");
  await act(async () => { logout.reject(new Error("retired IPC failure")); await pendingLogout; });
});
await test("logout effects outlive the released request when several authentications replace it", async ({ mount, store }) => {
  await mount(); await act(async () => { await authenticate(store()); });
  const logout = deferred<{ ok: boolean }>(); api.logout = () => logout.promise;
  let pendingLogout!: Promise<void>; await act(async () => { pendingLogout = store().logout(); });
  const replaced = deferred<{ user: User }>(); api.login = () => replaced.promise;
  let old!: ReturnType<Store["authenticate"]>; await act(async () => { old = authenticate(store()); });
  await act(async () => { logout.resolve({ ok: true }); await pendingLogout; });
  api.login = async () => { throw new Error("latest authentication failed"); };
  let reads = 0; api.boot = async () => { ++reads; return boot(); };
  await act(async () => { try { await authenticate(store()); } catch { /* expected failure */ } });
  await act(async () => { replaced.reject(new Error("retired authentication failed")); });
  assert((await old).status === "superseded" && reads === 1 && store().user === null,
    "releasing the old request lost the logout reconciliation requirement");
});
await test("an unknown logout baseline remains pending until a later successful readback", async ({ mount, store }) => {
  await mount(); await act(async () => { await authenticate(store()); });
  api.logout = async () => { throw new Error("IPC unavailable"); };
  api.boot = async () => { throw new Error("readback unavailable"); };
  await act(async () => { await store().logout(); });
  api.login = async () => { throw new Error("authentication failed"); };
  api.boot = async () => boot();
  await act(async () => { try { await authenticate(store()); } catch { /* expected failure */ } });
  assert(store().user === null, "unknown baseline was forgotten after logout request released");
});
await test("account readback after failed replacement cannot overwrite a later accepted authentication", async ({ mount, store }) => {
  await mount(); await act(async () => { await authenticate(store()); });
  const logout = deferred<{ ok: boolean }>(); api.logout = () => logout.promise;
  let pendingLogout!: Promise<void>; await act(async () => { pendingLogout = store().logout(); });
  const readback = deferred<ReturnType<typeof boot>>(); api.boot = () => readback.promise;
  api.login = async () => { throw new Error("replacement failed"); };
  let pending!: ReturnType<Store["authenticate"]>; await act(async () => { pending = authenticate(store()); });
  api.login = async () => ({ user: user(33) });
  await act(async () => { await authenticate(store()); });
  await act(async () => { readback.resolve(boot()); });
  assert((await pending).status === "superseded" && store().user?.id === 33, "old readback replaced current account");
  await act(async () => { logout.resolve({ ok: true }); await pendingLogout; });
});
await test("IPC logout failure reads back native state before confirming a local logout", async ({ mount, store, toasts }) => {
  await mount(); await act(async () => { await authenticate(store()); });
  api.logout = async () => { throw new Error("IPC unavailable"); }; api.boot = async () => boot();
  await act(async () => { await store().logout(); });
  assert(store().user === null && toasts().toasts.some((item) => item.msg === "已退出登录"), "confirmed native logout was not adopted");
});
await test("unconfirmed logout never reports success or clears a confirmed account", async ({ mount, store, toasts }) => {
  await mount(); await act(async () => { await authenticate(store()); });
  api.logout = async () => { throw new Error("IPC unavailable"); }; api.boot = async () => boot(user(1));
  await act(async () => { await store().logout(); });
  assert(store().user?.id === 1 && toasts().toasts.some((item) => item.msg.includes("未确认")), "unconfirmed logout reported success");
});
await test("failed logout readback preserves uncertainty without an unhandled rejection", async ({ mount, store, toasts }) => {
  await mount(); await act(async () => { await authenticate(store()); });
  api.logout = async () => { throw new Error("IPC unavailable"); }; api.boot = async () => { throw new Error("readback unavailable"); };
  await act(async () => { await store().logout(); });
  assert(store().user?.id === 1 && toasts().toasts.some((item) => item.msg.includes("未确认")), "readback failure fabricated a result");
});
await test("a retired logout failure does not issue a readback for a newer account", async ({ mount, store }) => {
  await mount(); const request = deferred<{ ok: boolean }>(); api.logout = () => request.promise;
  let pending!: Promise<void>; await act(async () => { pending = store().logout(); });
  await act(async () => { await authenticate(store()); });
  let reads = 0; api.boot = async () => { ++reads; return boot(); };
  await act(async () => { request.reject(new Error("retired IPC failure")); await pending; });
  assert(reads === 0 && store().user?.id === 1, "retired logout inspected or modified newer scope");
});
await test("unmount retires account callbacks and later commands", async ({ mount, store, unmount }) => {
  await mount(); const request = deferred<{ user: User }>(); let requests = 0;
  api.login = () => { ++requests; return request.promise; };
  const command = store().authenticate;
  let pending!: ReturnType<Store["authenticate"]>; await act(async () => { pending = authenticate(store()); });
  await unmount(); request.resolve({ user: user(11) });
  assert((await pending).status === "superseded", "unmounted owner accepted callback");
  assert((await command({ mode: "login", username: "fixture", password: "fixture-password" })).status === "superseded" && requests === 1,
    "retired command started a new request");
});

const form = () => document.querySelector<HTMLFormElement>('form.hg-ios-auth-form:not([inert] *)')!;
async function fill(username: string, password: string) {
  await act(async () => {
    for (const [placeholder, value] of [["账号", username], ["密码", password]]) {
      const input = form().querySelector<HTMLInputElement>(`input[placeholder="${placeholder}"]`)!;
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    }
  });
}
const submit = () => act(async () => { form().dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); });
const open = (store: Store, value: boolean) => act(async () => { store.setLoginOpen(value); });
await test("old successful form may authenticate but cannot close or clear a reopened form", async ({ mount, store, toasts }) => {
  await mount(true); const request = deferred<{ user: User }>(); api.login = () => request.promise;
  await open(store(), true); await fill("first", "fixture-first"); await submit();
  await open(store(), false); await open(store(), true); await fill("second", "fixture-second");
  await act(async () => request.resolve({ user: user(11) }));
  assert(store().user?.id === 11 && store().loginOpen, "valid account result closed the newer presentation");
  assert(form().querySelector<HTMLInputElement>('input[placeholder="密码"]')?.value === "fixture-second", "old form cleared new password");
  assert(!toasts().toasts.some((item) => item.msg.includes("欢迎回来")), "old form announced success in new presentation");
});
await test("reopened form can submit while old form waits; old completion cannot release new busy state", async ({ mount, store, toasts }) => {
  await mount(true); const first = deferred<{ user: User }>(), second = deferred<{ user: User }>(); let count = 0;
  api.login = () => (++count === 1 ? first.promise : second.promise);
  await open(store(), true); await fill("first", "fixture-first"); await submit();
  await open(store(), false); await open(store(), true); await fill("second", "fixture-second"); await submit();
  assert(count === 2, "new form inherited old busy state");
  await act(async () => first.resolve({ user: user(11) }));
  const control = document.querySelector<HTMLButtonElement>('button[aria-label="提交登录"]:not([inert] *)');
  assert(store().loginOpen && control?.disabled, "old completion changed new busy state");
  await act(async () => second.resolve({ user: user(22) }));
  assert(!store().loginOpen && store().user?.id === 22 && toasts().toasts.filter((item) => item.msg.includes("欢迎回来")).length === 1,
    "current form did not finish exactly once");
});
await test("retired form error cannot appear in a reopened presentation", async ({ mount, store, toasts }) => {
  await mount(true); const request = deferred<{ user: User }>(); api.login = () => request.promise;
  await open(store(), true); await fill("first", "fixture-first"); await submit();
  await open(store(), false); await open(store(), true);
  await act(async () => request.reject(new Error("retired form error")));
  assert(store().loginOpen && !toasts().toasts.some((item) => item.msg.includes("retired form error")), "retired form error leaked through toast");
});
await test("duplicate synchronous form submissions emit one authentication command", async ({ mount, store }) => {
  await mount(true); const request = deferred<{ user: User }>(); let count = 0;
  api.login = () => { ++count; return request.promise; };
  await open(store(), true); await fill("fixture", "fixture-password");
  await act(async () => { for (let i = 0; i < 2; i++) form().dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); });
  assert(count === 1, "duplicate submit reached native");
  await act(async () => request.resolve({ user: user(1) }));
});

await test("current login validation uses toast without adding inline error content", async ({ mount, store, toasts }) => {
  await mount(true); await open(store(), true); await submit();
  assert(store().loginOpen && toasts().toasts.filter((item) => item.msg === "请输入账号与密码").length === 1,
    "existing validation was lost or duplicated");
  assert(!document.querySelector(".hg-ios-auth-error"), "validation remained inline");
});
await test("current login failure keeps the form and moves its existing error to toast", async ({ mount, store, toasts }) => {
  await mount(true); api.login = async () => { throw new Error("fixture login failed"); };
  await open(store(), true); await fill("fixture", "fixture-password"); await submit();
  assert(store().loginOpen && toasts().toasts.filter((item) => item.msg === "fixture login failed").length === 1,
    "current login failure not shown exactly once");
  assert(!document.querySelector(".hg-ios-auth-error"), "login failure remained inline");
});

Object.assign(api, original);
setStrictSecurity(previousSecurity);
if (previousPersist === null) localStorage.removeItem("hghub_app_v1"); else localStorage.setItem("hghub_app_v1", previousPersist);
document.querySelector("#results")!.textContent = JSON.stringify({ passed: results.filter((item) => item.passed).length,
  failed: results.filter((item) => !item.passed).length, results });
