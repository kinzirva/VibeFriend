// Windows GitHub-hosted VM only: real WebView2 DOM -> Tauri IPC -> SQLite.
// Remote debugging is enabled only for this CI process, never in release defaults.
import { chromium, expect } from "@playwright/test";

const endpoint = "http://127.0.0.1:9222";
const deadline = Date.now() + 90_000;
let browser;
let lastError;
while (Date.now() < deadline) {
  try {
    browser = await chromium.connectOverCDP(endpoint, { timeout: 5000 });
    break;
  } catch (error) {
    lastError = error;
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
}
if (!browser) throw new Error(`WebView2 CDP unavailable: ${String(lastError)}`);

try {
  let page;
  while (!page && Date.now() < deadline) {
    for (const candidate of browser.contexts().flatMap((context) => context.pages())) {
      try {
        if (await candidate.locator(".shell").count()) {
          page = candidate;
          break;
        }
      } catch { /* WebView2 page may still be loading. */ }
    }
    if (!page) await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  if (!page) throw new Error("ActivityTracker native WebView2 page not found");

  const nativeTracking = () => page.evaluate(async () => {
    if (!window.__TAURI_INTERNALS__?.invoke) throw new Error("Missing real Tauri IPC bridge");
    return window.__TAURI_INTERNALS__.invoke("get_tracking");
  });
  const nativeActivity = () => page.evaluate(() => window.__TAURI_INTERNALS__.invoke("get_activity"));
  const nativeTimeline = () => page.evaluate(() => window.__TAURI_INTERNALS__.invoke("get_timeline"));

  await expect(page.getByRole("button", { name: "Resume", exact: true })).toBeVisible();
  expect(await nativeTracking()).toBe(false);
  expect(await nativeActivity()).toEqual([]);
  expect(await nativeTimeline()).toEqual([]);

  await page.getByRole("button", { name: "Resume", exact: true }).click();
  await expect.poll(nativeTracking).toBe(true);
  await expect(page.getByRole("button", { name: "Pause", exact: true })).toBeVisible();

  await page.getByRole("button", { name: "Pause", exact: true }).click();
  await expect.poll(nativeTracking).toBe(false);
  await expect(page.getByRole("button", { name: "Resume", exact: true })).toBeVisible();

  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Delete local data", exact: true }).click();
  await expect(page.getByText("All local desktop activity records deleted. Tracking paused.")).toBeVisible();
  expect(await nativeTracking()).toBe(false);
  expect(await nativeActivity()).toEqual([]);
  expect(await nativeTimeline()).toEqual([]);
  console.log("PASS: Windows real WebView2 UI -> Tauri IPC opt-in, pause, delete and SQLite state");
} finally {
  await browser.close();
}
