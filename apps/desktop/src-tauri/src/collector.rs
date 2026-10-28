#[cfg(target_os = "windows")]
use std::process::Command;
use std::sync::Arc;
use std::thread;
use std::time::{Duration, Instant};

use crate::store::AppState;

const SAMPLE_SECONDS: u64 = 5;
const IDLE_THRESHOLD_SECONDS: u64 = 60;

// Fail closed if OS input-idle status is unavailable: no activity is recorded.
#[cfg(target_os = "macos")]
fn idle_duration() -> Option<Duration> {
    #[link(name = "ApplicationServices", kind = "framework")]
    unsafe extern "C" {
        fn CGEventSourceSecondsSinceLastEventType(state_id: u32, event_type: u32) -> f64;
    }
    let seconds = unsafe { CGEventSourceSecondsSinceLastEventType(0, u32::MAX) };
    (seconds.is_finite() && seconds >= 0.0).then(|| Duration::from_secs_f64(seconds))
}

#[cfg(target_os = "windows")]
fn idle_duration() -> Option<Duration> {
    #[repr(C)]
    struct LastInputInfo {
        cb_size: u32,
        dw_time: u32,
    }
    #[link(name = "user32")]
    unsafe extern "system" {
        fn GetLastInputInfo(info: *mut LastInputInfo) -> i32;
    }
    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn GetTickCount() -> u32;
    }
    let mut info = LastInputInfo {
        cb_size: std::mem::size_of::<LastInputInfo>() as u32,
        dw_time: 0,
    };
    if unsafe { GetLastInputInfo(&mut info) } == 0 {
        return None;
    }
    // 32-bit ticks wrap; wrapping subtraction handles rollover.
    let idle_ms = unsafe { GetTickCount() }.wrapping_sub(info.dw_time);
    Some(Duration::from_millis(u64::from(idle_ms)))
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
fn idle_duration() -> Option<Duration> {
    None
}

fn user_is_active() -> bool {
    idle_duration().is_some_and(|idle| idle < Duration::from_secs(IDLE_THRESHOLD_SECONDS))
}

#[cfg(target_os = "macos")]
fn foreground_application() -> Option<String> {
    use objc::rc::autoreleasepool;
    use objc::runtime::Object;
    use objc::{class, msg_send, sel, sel_impl};
    use std::ffi::CStr;

    // NSWorkspace.frontmostApplication reads process metadata without AppleScript
    // or System Events Automation permission. No window title or document data.
    autoreleasepool(|| unsafe {
        let workspace: *mut Object = msg_send![class!(NSWorkspace), sharedWorkspace];
        if workspace.is_null() {
            return None;
        }
        let application: *mut Object = msg_send![workspace, frontmostApplication];
        if application.is_null() {
            return None;
        }
        let name: *mut Object = msg_send![application, localizedName];
        if name.is_null() {
            return None;
        }
        let utf8: *const std::os::raw::c_char = msg_send![name, UTF8String];
        if utf8.is_null() {
            return None;
        }
        let value = CStr::from_ptr(utf8).to_str().ok()?.trim().to_string();
        (!value.is_empty()).then_some(value)
    })
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
    thread::spawn(move || {
        let mut last_tick = Instant::now();
        let mut last_generation = state.generation();
        loop {
            thread::sleep(Duration::from_secs(SAMPLE_SECONDS));
            let now = Instant::now();
            let elapsed = now.duration_since(last_tick);
            last_tick = now;

            let generation = state.generation();
            if generation != last_generation {
                // Never credit time before Resume or spanning Pause/Delete.
                last_generation = generation;
                continue;
            }
            if !state.is_tracking()
                || elapsed > Duration::from_secs(SAMPLE_SECONDS * 2)
                || !user_is_active()
            {
                continue;
            }

            let seconds = elapsed.as_secs().min(SAMPLE_SECONDS) as i64;
            if seconds == 0 {
                continue;
            }
            if let Some(app) = foreground_application() {
                if !app.eq_ignore_ascii_case("VibeFriend") {
                    let _ = state.record(&app, seconds, generation);
                }
            }
        }
    });
}
