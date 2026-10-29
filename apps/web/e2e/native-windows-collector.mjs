// GitHub-hosted Windows 2025 VM: installed production WebView2 UI -> consent
// -> real Win32 foreground collector -> persistent SQLite -> Tauri IPC -> Pause/Delete.
// This is not a physical-device test. No synthetic SQLite inserts or mocked IPC.
import { chromium, expect } from "@playwright/test";
import { execFileSync } from "node:child_process";

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
if (!browser) throw new Error(`Installed WebView2 CDP unavailable: ${String(lastError)}`);

try {
  let page;
  while (!page && Date.now() < deadline) {
    for (const candidate of browser.contexts().flatMap((context) => context.pages())) {
      try {
        if (await candidate.locator(".shell").count()) {
          page = candidate;
          break;
        }
      } catch { /* Native page may still be loading. */ }
    }
    if (!page) await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  if (!page) throw new Error("Installed ActivityTracker native page not found");

  const invoke = (command) => page.evaluate((name) => {
    if (!window.__TAURI_INTERNALS__?.invoke) throw new Error("Missing production Tauri IPC");
    return window.__TAURI_INTERNALS__.invoke(name);
  }, command);
  const activity = () => invoke("get_activity");
  const timeline = () => invoke("get_timeline");
  const tracking = () => invoke("get_tracking");
  const csv = () => invoke("export_csv");

  // Previous native UI smoke has cleared its database. Prove opt-in on the
  // actual installed app rather than a fake browser bridge.
  expect(await tracking()).toBe(false);
  expect(await activity()).toEqual([]);
  expect(await timeline()).toEqual([]);
  expect(await csv()).toBe("day,app,seconds\n");
  await page.getByRole("button", { name: "Resume", exact: true }).click();
  await expect.poll(tracking).toBe(true);

  // The same interactive Windows runner successfully exercises this fixture
  // in foreground-vm-probe.yml. It is the REAL process detector and collector.
  const activate = [
    "$ErrorActionPreference = 'Stop'",
    "$proc = Start-Process notepad.exe -PassThru",
    "Start-Sleep -Seconds 3",
    "$proc.Refresh()",
    "if ($proc.HasExited) { throw 'Notepad exited' }",
    "if (-not (New-Object -ComObject WScript.Shell).AppActivate($proc.Id)) { throw 'Notepad foreground activation failed' }",
    "Add-Type -AssemblyName System.Windows.Forms",
    "[System.Windows.Forms.SendKeys]::SendWait('{F15}')",
    "Write-Host ('Foreground fixture PID=' + $proc.Id)",
  ].join("; ");
  const output = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", activate], {
    encoding: "utf8", timeout: 20000,
  });
  console.log(output.trim());

  // Resume resets the sampling baseline. Allow several real 5-second ticks,
  // not just a single end-of-interval foreground read.
  await expect.poll(async () => {
    const rows = await activity();
    return rows.filter((row) => row.app.toLowerCase() === "notepad")
      .reduce((sum, row) => sum + row.seconds, 0);
  }, { timeout: 60000, intervals: [3000, 5000] }).toBeGreaterThan(0);

  const sampled = await activity();
  const notepadSeconds = sampled.filter((row) => row.app.toLowerCase() === "notepad")
    .reduce((sum, row) => sum + row.seconds, 0);
  const sampledEvents = await timeline();
  expect(sampledEvents.some((event) => event.app.toLowerCase() === "notepad" && event.seconds > 0)).toBe(true);
  expect((await csv()).toLowerCase()).toContain('"notepad"');

  await page.getByRole("button", { name: "Pause", exact: true }).click();
  await expect.poll(tracking).toBe(false);
  // Capture only after Pause returns: an in-flight pre-pause tick may have
  // committed between the first sample read and the UI click.
  const pausedRows = await activity();
  const pausedEvents = await timeline();
  await new Promise((resolve) => setTimeout(resolve, 12000));
  expect(await activity()).toEqual(pausedRows);
  expect(await timeline()).toEqual(pausedEvents);

  // Deep P0 report check: these are REAL native SQLite rows and foreground
  // events from the installed collector, not seeded browser data or mock IPC.
  const nativeNotepadRows = pausedRows.filter((row) => row.app.toLowerCase() === "notepad");
  const nativeNotepadEvents = pausedEvents.filter((event) => event.app.toLowerCase() === "notepad");
  expect(nativeNotepadRows.length).toBeGreaterThan(0);
  expect(nativeNotepadEvents.length).toBeGreaterThan(0);
  expect(nativeNotepadRows.reduce((sum, row) => sum + row.seconds, 0))
    .toBe(nativeNotepadEvents.reduce((sum, event) => sum + event.seconds, 0));

  // Every persisted daily aggregate must round-trip through the real native
  // export_csv IPC, including the exact date, app label and seconds.
  const exported = await csv();
  for (const row of pausedRows) {
    const safeApp = /^[=+\-@\t\r]/.test(row.app) ? "'" + row.app : row.app;
    const escapedApp = safeApp.replace(/"/g, '""');
    expect(exported).toContain(`${row.day},"${escapedApp}",${row.seconds}\n`);
  }
  expect(exported.trimEnd().split("\n")).toHaveLength(pausedRows.length + 1);

  // Verify that the *installed* WebView2 dashboard renders the same persisted
  // activity in its All-time report and its recent native event timeline.
  await page.getByRole("button", { name: "All time", exact: true }).click();
  const dailyPanel = page.locator(".panel.timeline").first();
  const recentPanel = page.locator(".panel.timeline").last();
  const notepadDaily = dailyPanel.locator(".tableRow").filter({ hasText: /notepad/i });
  const notepadRecent = recentPanel.locator(".tableRow").filter({ hasText: /notepad/i });
  await expect(notepadDaily.first()).toBeVisible({ timeout: 15000 });
  await expect(notepadDaily.first()).toContainText(nativeNotepadRows[0].day);
  // Native WebView2 must display the actual SQLite duration, not 0m for a
  // positive five-second foreground sample. The browser CSV fixture alone
  // cannot prove the installed GUI's production data path.
  const exactDuration = (value) => [
    Math.floor(value / 3600) > 0 ? `${Math.floor(value / 3600)}h` : "",
    Math.floor((value % 3600) / 60) > 0 ? `${Math.floor((value % 3600) / 60)}m` : "",
    value % 60 > 0 ? `${value % 60}s` : "",
  ].filter(Boolean).join(" ") || "0s";
  await expect(notepadDaily.first().locator("span").last())
    .toHaveText(exactDuration(nativeNotepadRows[0].seconds));
  await expect(page.locator(".metrics article").first().locator("strong"))
    .toHaveText(exactDuration(pausedRows.reduce((sum, row) => sum + row.seconds, 0)));
  await expect(notepadRecent.first()).toBeVisible({ timeout: 15000 });
  await expect(page.locator(".metrics article").nth(1).locator("strong"))
    .toHaveText(String(new Set(pausedRows.map((row) => row.app)).size));

  // Today/This week boundaries are covered deterministically in dashboard
  // Playwright; additionally exercise both on the real native sample when its
  // local day matches the current Windows runner calendar day.
  const today = await page.evaluate(() => {
    const d = new Date();
    return [d.getFullYear(), String(d.getMonth() + 1).padStart(2, "0"),
      String(d.getDate()).padStart(2, "0")].join("-");
  });
  if (nativeNotepadRows.some((row) => row.day === today)) {
    for (const label of ["Today", "This week"]) {
      await page.getByRole("button", { name: label, exact: true }).click();
      await expect(notepadDaily.first()).toBeVisible();
    }
  } else {
    console.log("Native Today/This week report assertions skipped at local midnight boundary; All time verified");
  }
  console.log(`PASS: real Windows SQLite daily totals == event seconds == native CSV; installed WebView2 report/timeline UI consistent (${pausedRows.length} daily rows, ${pausedEvents.length} events)`);

  await page.getByRole("button", { name: "Delete local data", exact: true }).click();
  await expect(page.getByRole("alertdialog")).toBeVisible();
  await page.getByRole("button", { name: "Delete all data", exact: true }).click();
  await expect.poll(tracking).toBe(false);
  await expect.poll(activity).toEqual([]);
  await expect.poll(timeline).toEqual([]);
  expect(await csv()).toBe("day,app,seconds\n");

  console.log(`PASS: installed Windows WebView2 Resume -> real Notepad foreground -> SQLite ${notepadSeconds}s -> native CSV -> Pause stable -> Delete both tables`);
} finally {
  await browser.close();
}
