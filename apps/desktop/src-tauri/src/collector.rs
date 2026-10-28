use std::process::Command;
use std::sync::Arc;
use std::thread;
use std::time::Duration;

use crate::store::AppState;

const SAMPLE_SECONDS: i64 = 5;

#[cfg(target_os = "macos")]
fn foreground_application() -> Option<String> {
    let output = Command::new("osascript")
        .args([
            "-e",
            "tell application \"System Events\" to get name of first application process whose frontmost is true",
        ])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let name = String::from_utf8_lossy(&output.stdout).trim().to_string();
    (!name.is_empty()).then_some(name)
}

#[cfg(target_os = "windows")]
fn foreground_application() -> Option<String> {
    let script = r#"
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class VibeFriendWin32 {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
}
"@
$handle = [VibeFriendWin32]::GetForegroundWindow()
$processId = 0
[void][VibeFriendWin32]::GetWindowThreadProcessId($handle, [ref]$processId)
if ($processId -gt 0) { (Get-Process -Id $processId -ErrorAction SilentlyContinue).ProcessName }
"#;
    let output = Command::new("powershell.exe")
        .args(["-NoProfile", "-NonInteractive", "-Command", script])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let name = String::from_utf8_lossy(&output.stdout).trim().to_string();
    (!name.is_empty()).then_some(name)
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
fn foreground_application() -> Option<String> {
    None
}

pub fn spawn_collector(state: Arc<AppState>) {
    thread::spawn(move || loop {
        if state.is_tracking() {
            if let Some(app) = foreground_application() {
                if app != "VibeFriend" {
                    let _ = state.record(&app, SAMPLE_SECONDS);
                }
            }
        }
        thread::sleep(Duration::from_secs(SAMPLE_SECONDS as u64));
    });
}
