// P0 experimental GitHub-hosted Windows 2025 OS lock transition probe.
// Real installed WebView2 -> Tauri IPC -> Notepad foreground -> SQLite.
// Unlike sample_eligible unit tests, this calls LockWorkStation and verifies
// the OS input desktop switched away from Default. No synthetic DB writes.
// A hosted VM lock is NOT a physical-machine lock/unlock or sleep/wake test.
import { chromium, expect } from "@playwright/test";
import { execFileSync } from "node:child_process";

const endpoint = "http://127.0.0.1:9222";
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let browser;
for (let attempt = 0; attempt < 30; attempt++) {
  try {
    browser = await chromium.connectOverCDP(endpoint, { timeout: 5000 });
    break;
  } catch {
    await wait(1000);
  }
}
if (!browser) throw new Error("Installed Windows WebView2 CDP unavailable");

try {
  let page;
  for (let attempt = 0; attempt < 30 && !page; attempt++) {
    for (const candidate of browser.contexts().flatMap((context) => context.pages())) {
      if (await candidate.locator(".shell").count().catch(() => 0)) {
        page = candidate;
        break;
      }
    }
    if (!page) await wait(1000);
  }
  if (!page) throw new Error("Installed production WebView2 UI unavailable");

  const invoke = (name) => page.evaluate((command) => {
    if (!window.__TAURI_INTERNALS__?.invoke) throw new Error("Production Tauri IPC missing");
    return window.__TAURI_INTERNALS__.invoke(command);
  }, name);
  const tracking = () => invoke("get_tracking");
  const timeline = () => invoke("get_timeline");
  const notepadCount = async () => (await timeline())
    .filter((event) => event.app.toLowerCase() === "notepad").length;

  // The preceding installed native test deletes all data and pauses.
  expect(await tracking()).toBe(false);
  expect(await notepadCount()).toBe(0);
  await page.getByRole("button", { name: "Resume", exact: true }).click();
  await expect.poll(tracking).toBe(true);

  const activate = [
    "$ErrorActionPreference = 'Stop'",
    "$p = Start-Process notepad.exe -PassThru",
    "Start-Sleep -Seconds 3",
    "$p.Refresh()",
    "if ($p.HasExited) { throw 'Notepad exited' }",
    "if (-not (New-Object -ComObject WScript.Shell).AppActivate($p.Id)) { throw 'Notepad foreground activation failed' }",
    "Add-Type -AssemblyName System.Windows.Forms",
    "[System.Windows.Forms.SendKeys]::SendWait('{F15}')",
    "Write-Host ('Notepad fixture PID=' + $p.Id)",
  ].join("; ");
  console.log(execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", activate], {
    encoding: "utf8", timeout: 20000,
  }).trim());

  await expect.poll(notepadCount, { timeout: 60000, intervals: [3000, 5000] })
    .toBeGreaterThan(0);
  const before = await notepadCount();
  console.log(`Positive control: real Notepad SQLite samples before lock=${before}`);

  // Explicitly inspect the Win32 input desktop before and after the actual
  // LockWorkStation call. A normal active session must be on "Default".
  // After lock it should be Winlogon or inaccessible to this user process.
  const lockScript = `
$ErrorActionPreference = 'Stop'
$source = @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class DesktopLockProbe {
  [DllImport("user32.dll", SetLastError=true)]
  public static extern bool LockWorkStation();
  [DllImport("user32.dll", SetLastError=true)]
  public static extern IntPtr OpenInputDesktop(uint flags, bool inherit, uint access);
  [DllImport("user32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  public static extern bool GetUserObjectInformation(IntPtr obj, int index, StringBuilder buffer, uint length, ref uint needed);
  [DllImport("user32.dll")]
  public static extern bool CloseDesktop(IntPtr desktop);
  public static string InputDesktopName() {
    IntPtr desktop = OpenInputDesktop(0, false, 1);
    if (desktop == IntPtr.Zero) return "INACCESSIBLE";
    try {
      var name = new StringBuilder(128);
      uint needed = 0;
      if (!GetUserObjectInformation(desktop, 2, name, 256, ref needed)) return "UNREADABLE";
      return name.ToString();
    } finally { CloseDesktop(desktop); }
  }
}
'@
Add-Type -TypeDefinition $source
$before = [DesktopLockProbe]::InputDesktopName()
Write-Host "Input desktop before lock: $before"
if ($before -ne 'Default') { throw "No interactive Default desktop before lock" }
if (-not [DesktopLockProbe]::LockWorkStation()) { throw "LockWorkStation returned false" }
Start-Sleep -Seconds 3
$after = [DesktopLockProbe]::InputDesktopName()
Write-Host "Input desktop after lock: $after"
if ($after -eq 'Default') { throw "LockWorkStation did not switch input desktop" }
Write-Host "PASS: real Windows OS input desktop switched away from Default"
`;
  const lockOutput = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", lockScript], {
    encoding: "utf8", timeout: 20000,
  });
  console.log(lockOutput.trim());
  if (!lockOutput.includes("PASS: real Windows OS input desktop switched")) {
    throw new Error("OS lock transition not independently confirmed");
  }

  // Require the *entire* production activity_events timeline to stop growing,
  // not just Notepad attribution: a broken collector could record Winlogon or
  // another process while the workstation is locked.
  expect(await tracking()).toBe(true);
  const lockedBaseline = await timeline();
  const baselineTotal = lockedBaseline.length;
  const baselineNotepad = lockedBaseline.filter((event) => event.app.toLowerCase() === "notepad").length;
  expect(baselineNotepad).toBeGreaterThanOrEqual(before);
  await wait(15000);
  expect(await tracking()).toBe(true);
  const lockedAfter = await timeline();
  const after = lockedAfter.filter((event) => event.app.toLowerCase() === "notepad").length;
  expect(lockedAfter.length).toBe(baselineTotal);
  expect(after).toBe(baselineNotepad);
  console.log(`PASS: actual Windows LockWorkStation transition -> no activity_events SQLite growth for 15s (all apps ${baselineTotal} -> ${lockedAfter.length}; Notepad ${baselineNotepad} -> ${after}; tracking remains enabled) (hosted VM only)`);
} finally {
  await browser.close();
}
