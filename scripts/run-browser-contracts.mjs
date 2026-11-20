import { createRequire } from "node:module";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const fixtures = ["app-state", "offline-design", "route-context", "channel-pages", "channel-order", "author", "author-navigation", "account-session", "header-actions", "toast-feedback", "playback-source", "playback-recovery", "playback-recovery-web", "playback-progress",
  "playback-gestures", "security-settings", "html-security", "topbar-hit-target", "motion-presence"];
const selected = process.argv.slice(2);
if (selected.some((name) => !fixtures.includes(name))) {
  throw new Error(`Choose fixture names from: ${fixtures.join(", ")}`);
}
const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require(process.env.HG_PLAYWRIGHT_MODULE || "playwright")); }
catch { throw new Error("Playwright is required in your test environment; set HG_PLAYWRIGHT_MODULE to its installed module path if needed."); }
const base = new URL(process.env.HG_TEST_URL || "http://127.0.0.1:1420");
const output = process.env.HG_TEST_REPORT_DIR;
if (output) await mkdir(output, { recursive: true });
function validateReport(result) {
  if (!Number.isSafeInteger(result.passed) || result.passed < 0
    || !Number.isSafeInteger(result.failed) || result.failed < 0
    || result.passed + result.failed === 0) throw new Error("Empty or invalid fixture totals");
  if (Array.isArray(result.results)) {
    if (result.results.some((item) => !item || typeof item.passed !== "boolean")
      || result.results.filter((item) => item.passed).length !== result.passed
      || result.results.filter((item) => !item.passed).length !== result.failed) {
      throw new Error("Fixture totals disagree with result rows");
    }
  } else if (Array.isArray(result.checks)) {
    // The legacy security fixture records successful labels and a separate failure/error.
    if (result.checks.length !== result.passed || result.checks.some((item) => typeof item !== "string")) {
      throw new Error("Fixture totals disagree with check labels");
    }
  } else throw new Error("Fixture has no result details");
  if (result.error && !result.failed) throw new Error("Fixture reports an error without a failure");
}
const browser = await chromium.launch({ ...(process.env.HG_CHROME_EXECUTABLE ? { executablePath: process.env.HG_CHROME_EXECUTABLE } : {}) });
let failed = false;
try {
  for (const name of selected.length ? selected : fixtures) {
    for (const reducedMotion of ["motion-presence", "channel-order"].includes(name) ? ["no-preference", "reduce"] : ["no-preference"]) {
      const page = await browser.newPage({
        viewport: name === "topbar-hit-target" ? { width: 400, height: 360 } : { width: 390, height: 844 },
        userAgent: name === "playback-recovery-web" ? "Mozilla/5.0 (Linux; Android 15) AppleWebKit/537.36 Chrome/131.0.0.0 Mobile Safari/537.36" : "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)", hasTouch: true, reducedMotion,
      });
      const pageErrors = [];
      page.on("pageerror", (error) => pageErrors.push(error.message));
      let result;
      try {
        if (name === "author-navigation") {
          await page.exposeFunction("__tapAt", (x, y) => page.touchscreen.tap(x, y));
          await page.exposeFunction("__authorViewport", (width, height) => page.setViewportSize({ width, height }));
        }
        if (name === "topbar-hit-target") {
          const pointer = async (x, y) => { await page.mouse.move(x, y); await page.mouse.down(); await page.mouse.up(); };
          await page.exposeFunction("__clickAt", pointer);
          await page.exposeFunction("__pointerAt", pointer);
          await page.exposeFunction("__press", (key) => page.keyboard.press(key));
        }
        if (name === "channel-order") {
          const cdp = await page.context().newCDPSession(page);
          await page.exposeFunction("__channelTouch", async (type, x, y) => {
            await cdp.send("Input.dispatchTouchEvent", { type, touchPoints: type === "touchEnd" ? [] : [{ x, y }] });
          });
        }
        if (name === "motion-presence") {
          const cdp = await page.context().newCDPSession(page);
          await page.exposeFunction("__dragSheet", async (x, y) => {
            await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
            for (const distance of [25, 60, 120, 220]) {
              await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: x + distance, y }] });
            }
            await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
          });
        }
        await page.goto(new URL(`/tests/${name}.html`, base).href);
        await page.waitForFunction(() => {
          try {
            const value = JSON.parse(document.querySelector("#results")?.textContent);
            return typeof value.passed === "number" && typeof value.failed === "number";
          } catch { return false; }
        }, {}, { timeout: 45000 });
        result = JSON.parse(await page.locator("#results").textContent());
        validateReport(result);
      } catch (error) {
        result = { passed: 0, failed: 1, error: String(error) };
      } finally { await page.close(); }
      const report = { name, reducedMotion, ...result, pageErrors };
      if (output) await writeFile(path.join(output, `${name}${reducedMotion === "reduce" ? "-reduced" : ""}.json`), `${JSON.stringify(report, null, 2)}\n`);
      console.log(JSON.stringify({ name, reducedMotion, passed: result.passed, failed: result.failed, pageErrors,
        ...(result.error ? { error: result.error } : {}),
        ...(result.failed ? { failures: result.results?.filter((item) => !item.passed) } : {}) }));
      if (result.failed || pageErrors.length) failed = true;
    }
  }
} finally { await browser.close(); }
if (failed) process.exitCode = 1;
