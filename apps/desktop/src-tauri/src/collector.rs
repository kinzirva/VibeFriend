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

// Lock-screen and secure-desktop detection is separate from the 60s idle
// threshold: input during login/unlock must never count as application usage.
// A missing/unreadable OS session signal fails closed.
#[cfg(target_os = "windows")]
fn session_is_unlocked() -> bool {
    use std::ffi::c_void;

    #[link(name = "user32")]
    unsafe extern "system" {
        fn OpenInputDesktop(flags: u32, inherit: i32, access: u32) -> *mut c_void;
        fn GetUserObjectInformationW(
            object: *mut c_void,
            index: i32,
            info: *mut c_void,
            length: u32,
            needed: *mut u32,
        ) -> i32;
        fn CloseDesktop(desktop: *mut c_void) -> i32;
    }

    // The input desktop is "Default" in a normal interactive session.
    // Lock, secure UAC and login use Winlogon/other secure desktops. A
    // non-elevated process generally cannot open those: deny collection.
    const DESKTOP_READOBJECTS: u32 = 0x0001;
    const UOI_NAME: i32 = 2;
    let desktop = unsafe { OpenInputDesktop(0, 0, DESKTOP_READOBJECTS) };
    if desktop.is_null() {
        return false;
    }
    let mut name = [0u16; 64];
    let mut needed = 0u32;
    let ok = unsafe {
        GetUserObjectInformationW(
            desktop,
            UOI_NAME,
            name.as_mut_ptr().cast(),
            std::mem::size_of_val(&name) as u32,
            &mut needed,
        )
    };
    unsafe { CloseDesktop(desktop) };
    if ok == 0 {
        return false;
    }
    let end = name.iter().position(|ch| *ch == 0).unwrap_or(name.len());
    String::from_utf16(&name[..end])
        .is_ok_and(|value| value.eq_ignore_ascii_case("Default"))
}

#[cfg(target_os = "macos")]
fn session_is_unlocked() -> bool {
    use objc::runtime::Object;
    use objc::{class, msg_send, sel, sel_impl};

    #[link(name = "CoreGraphics", kind = "framework")]
    unsafe extern "C" {
        fn CGSessionCopyCurrentDictionary() -> *mut Object;
    }

    unsafe {
        let session = CGSessionCopyCurrentDictionary();
        if session.is_null() {
            return false;
        }
        // The screen-locked key is absent when unlocked, but present/true
        // while locked. Also require the current session to own the console.
        let console_key: *mut Object =
            // The public constant kCGSessionOnConsoleKey has the dictionary
            // string value "kCGSSessionOnConsoleKey" (note the extra S).
            msg_send![class!(NSString), stringWithUTF8String: c"kCGSSessionOnConsoleKey".as_ptr()];
        let locked_key: *mut Object =
            msg_send![class!(NSString), stringWithUTF8String: c"CGSSessionScreenIsLocked".as_ptr()];
        let console_value: *mut Object = msg_send![session, objectForKey: console_key];
        let locked_value: *mut Object = msg_send![session, objectForKey: locked_key];
        let on_console = if console_value.is_null() {
            false
        } else {
            let value: i8 = msg_send![console_value, boolValue];
            value != 0
        };
        let locked = if locked_value.is_null() {
            false
        } else {
            let value: i8 = msg_send![locked_value, boolValue];
            value != 0
        };
        let _: () = msg_send![session, release];
        on_console && !locked
    }
}

#[cfg(not(any(target_os = "windows", target_os = "macos")))]
fn session_is_unlocked() -> bool {
    false
}

fn user_is_active() -> bool {
    session_is_unlocked()
        && idle_duration().is_some_and(|idle| idle < Duration::from_secs(IDLE_THRESHOLD_SECONDS))
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
    use std::ffi::c_void;

    #[link(name = "user32")]
    unsafe extern "system" {
        fn GetForegroundWindow() -> *mut c_void;
        fn GetWindowThreadProcessId(hwnd: *mut c_void, process_id: *mut u32) -> u32;
    }
    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn OpenProcess(access: u32, inherit: i32, process_id: u32) -> *mut c_void;
        fn QueryFullProcessImageNameW(
            process: *mut c_void,
            flags: u32,
            filename: *mut u16,
            size: *mut u32,
        ) -> i32;
        fn CloseHandle(handle: *mut c_void) -> i32;
    }

    let window = unsafe { GetForegroundWindow() };
    if window.is_null() {
        return None;
    }
    let mut process_id = 0;
    unsafe { GetWindowThreadProcessId(window, &mut process_id) };
    if process_id == 0 {
        return None;
    }

    // PROCESS_QUERY_LIMITED_INFORMATION: no elevated permissions or window text.
    let process = unsafe { OpenProcess(0x1000, 0, process_id) };
    if process.is_null() {
        return None;
    }
    let mut filename = vec![0u16; 32768];
    let mut length = filename.len() as u32;
    let found = unsafe {
        QueryFullProcessImageNameW(process, 0, filename.as_mut_ptr(), &mut length)
    };
    unsafe { CloseHandle(process) };
    if found == 0 || length == 0 {
        return None;
    }

    // Only the executable basename is recorded. Never persist its full path,
    // window title, browser URL or any document contents.
    let path = String::from_utf16(&filename[..length as usize]).ok()?;
    let app = std::path::Path::new(&path)
        .file_stem()?
        .to_str()?
        .trim()
        .to_string();
    (!app.is_empty()).then_some(app)
}

#[cfg(all(test, target_os = "windows"))]
mod windows_foreground_tests {
    #[test]
    fn win32_process_name_is_only_executable_basename() {
        let path = std::path::Path::new(r"C:\Users\Test\Documents\notepad.exe");
        assert_eq!(path.file_stem().and_then(|s| s.to_str()), Some("notepad"));
    }
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
fn foreground_application() -> Option<String> {
    None
}

// Pure eligibility gate: fail closed on missing OS idle data, on >=60s idle,
// or after an oversized tick (e.g. laptop sleep or a suspended process).
fn sample_eligible(
    tracking: bool,
    elapsed: Duration,
    idle: Option<Duration>,
    session_unlocked: bool,
) -> bool {
    tracking
        && session_unlocked
        && elapsed <= Duration::from_secs(SAMPLE_SECONDS * 2)
        && idle.is_some_and(|duration| duration < Duration::from_secs(IDLE_THRESHOLD_SECONDS))
}

#[cfg(test)]
mod sample_gate_tests {
    use super::*;

    #[test]
    fn idle_boundary_and_missing_os_signal_fail_closed() {
        let tick = Duration::from_secs(SAMPLE_SECONDS);
        assert!(sample_eligible(true, tick, Some(Duration::from_millis(59_999)), true));
        assert!(!sample_eligible(true, tick, Some(Duration::from_secs(60)), true));
        assert!(!sample_eligible(true, tick, Some(Duration::from_secs(61)), true));
        assert!(!sample_eligible(true, tick, None, true));
        assert!(!sample_eligible(false, tick, Some(Duration::ZERO), true));
    }

    #[test]
    fn locked_or_unavailable_session_never_credits_activity() {
        let tick = Duration::from_secs(SAMPLE_SECONDS);
        assert!(!sample_eligible(true, tick, Some(Duration::ZERO), false));
        assert!(sample_eligible(true, tick, Some(Duration::ZERO), true));
    }

    #[test]
    fn suspended_or_slept_ticks_cannot_credit_elapsed_time() {
        assert!(sample_eligible(true, Duration::from_secs(10), Some(Duration::ZERO), true));
        assert!(!sample_eligible(true, Duration::from_secs(11), Some(Duration::ZERO), true));
        assert!(!sample_eligible(true, Duration::from_secs(120), Some(Duration::ZERO), true));
    }
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
            if !sample_eligible(state.is_tracking(), elapsed, idle_duration(), session_is_unlocked()) {
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
