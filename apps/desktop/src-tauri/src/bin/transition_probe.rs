// GitHub-hosted VM acceptance: exercise the production foreground collector
// while switching between two real, controllable GUI applications.
// Tests persisted SQLite samples, not just foreground process detection.
// No window titles, document text, screenshots, or URLs are accessed.
mod store {
    include!("../store.rs");
}
include!("../collector.rs");

#[cfg(target_os = "macos")]
#[link(name = "AppKit", kind = "framework")]
unsafe extern "C" {
    fn NSApplicationLoad() -> bool;
}

fn wait_for_foreground(expected: &str, timeout: Duration) {
    let deadline = Instant::now() + timeout;
    let mut last_observed = None;
    while Instant::now() < deadline {
        last_observed = foreground_application();
        if last_observed
            .as_deref()
            .is_some_and(|name| name.eq_ignore_ascii_case(expected))
        {
            return;
        }
        thread::sleep(Duration::from_millis(500));
    }
    panic!(
        "expected foreground application {expected:?}, last observed {last_observed:?} after {timeout:?}"
    );
}

fn wait_for_record(state: &store::AppState, expected: &str, timeout: Duration) {
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        if state.timeline().expect("read SQLite events").iter()
            .any(|event| event.app.eq_ignore_ascii_case(expected))
        {
            return;
        }
        thread::sleep(Duration::from_secs(1));
    }
    panic!("production collector did not persist the expected application within the deadline");
}

#[cfg(target_os = "windows")]
fn activate_second_app() {
    let script = r#"$ErrorActionPreference = 'Stop'
$p = Start-Process taskmgr.exe -PassThru
Start-Sleep -Seconds 3
$p.Refresh()
if ($p.HasExited) { throw 'Task Manager exited before activation' }
$shell = New-Object -ComObject WScript.Shell
if (-not $shell.AppActivate($p.Id)) { throw 'Task Manager activation failed' }
Add-Type -AssemblyName System.Windows.Forms
[System.Windows.Forms.SendKeys]::SendWait('{F15}')
"#;
    let result = std::process::Command::new("powershell.exe")
        .args(["-NoProfile", "-NonInteractive", "-Command", script])
        .status()
        .expect("run Windows fixture");
    assert!(result.success(), "Windows second-app fixture failed");
}

#[cfg(target_os = "macos")]
fn activate_second_app() {
    // Launch Calculator through Launch Services, then request foreground
    // activation explicitly. The macOS `open` tool has no `--activate` flag.
    let result = std::process::Command::new("open")
        .args(["-a", "Calculator"])
        .status()
        .expect("launch and activate Calculator");
    assert!(result.success(), "Calculator did not launch");
    let result = std::process::Command::new("osascript")
        .args(["-e", "tell application \"Calculator\" to activate"])
        .status()
        .expect("activate Calculator");
    assert!(result.success(), "Calculator did not activate");
    // A hosted GUI may accept the AppleScript activate command without
    // transferring foreground focus. Try an explicit process activation,
    // but keep the real NSWorkspace foreground assertion mandatory.
    let result = std::process::Command::new("osascript")
        .args([
            "-e",
            "tell application \"System Events\" to set frontmost of process \"Calculator\" to true",
        ])
        .status()
        .expect("request Calculator process foreground");
    if !result.success() {
        eprintln!("System Events foreground request unavailable; trying NSRunningApplication");
    }

    // macOS may accept AppleScript activation while keeping TextEdit frontmost
    // (observed on the hosted macOS 15 VM). Ask AppKit to activate the real
    // Calculator process directly. Never fake the foreground detector result.
    use objc::rc::autoreleasepool;
    use objc::runtime::Object;
    use objc::{class, msg_send, sel, sel_impl};
    autoreleasepool(|| unsafe {
        let bundle_id: *mut Object = msg_send![
            class!(NSString),
            stringWithUTF8String: c"com.apple.calculator".as_ptr()
        ];
        let running: *mut Object = msg_send![
            class!(NSRunningApplication),
            runningApplicationsWithBundleIdentifier: bundle_id
        ];
        if !running.is_null() {
            let count: usize = msg_send![running, count];
            if count > 0 {
                let app: *mut Object = msg_send![running, objectAtIndex: 0usize];
                let activated: i8 = msg_send![app, activateWithOptions: 2usize];
                println!("NSRunningApplication Calculator activation returned {}", activated != 0);
            } else {
                eprintln!("Calculator is not yet visible in NSRunningApplication");
            }
        }
    });
}

#[cfg(not(any(target_os = "windows", target_os = "macos")))]
fn activate_second_app() {
    panic!("transition probe requires Windows or macOS");
}

fn main() {
    #[cfg(target_os = "macos")]
    unsafe {
        NSApplicationLoad();
    }

    let mut args = std::env::args().skip(1);
    let first = args.next().expect("usage: transition_probe <first-app> <second-app>");
    let second = args.next().expect("usage: transition_probe <first-app> <second-app>");
    assert!(args.next().is_none(), "unexpected extra arguments");
    assert!(!first.eq_ignore_ascii_case(&second), "fixture applications must differ");

    wait_for_foreground(&first, Duration::from_secs(15));
    assert!(user_is_active(), "real OS idle/lock gate is closed before transition test");

    let path = std::env::temp_dir().join(format!(
        "vibefriend-transition-{}-{}.sqlite",
        std::process::id(),
        chrono::Utc::now().timestamp_nanos_opt().unwrap_or_default()
    ));
    let state = Arc::new(store::AppState::new(path.clone()).expect("create temporary SQLite"));
    assert!(!state.is_tracking(), "tracking must default to off");
    spawn_collector(state.clone());
    thread::sleep(Duration::from_secs(7));
    assert!(state.timeline().expect("default-off timeline").is_empty());

    state.set_tracking(true).expect("opt in");
    wait_for_record(&state, &first, Duration::from_secs(35));
    assert!(state.timeline().expect("first app events").iter()
        .all(|event| event.app.eq_ignore_ascii_case(&first)));

    activate_second_app();
    wait_for_foreground(&second, Duration::from_secs(20));
    assert!(user_is_active(), "OS session became inactive during fixture switch");

    // A new foreground application cannot be credited on the first
    // ambiguous polling tick. A second stable reading is required.
    thread::sleep(Duration::from_secs(2));
    assert!(!state.timeline().expect("early transition events").iter()
        .any(|event| event.app.eq_ignore_ascii_case(&second)),
        "collector incorrectly credited the ambiguous app-switch interval");

    wait_for_record(&state, &second, Duration::from_secs(35));
    let events = state.timeline().expect("two-app SQLite events");
    assert!(events.iter().any(|event| event.app.eq_ignore_ascii_case(&first)));
    assert!(events.iter().any(|event| event.app.eq_ignore_ascii_case(&second)));
    assert!(events.iter().all(|event|
        (event.app.eq_ignore_ascii_case(&first) || event.app.eq_ignore_ascii_case(&second))
            && (1..=5).contains(&event.seconds)
    ), "unexpected application or duration in real collector events");

    let first_total: i64 = events.iter()
        .filter(|event| event.app.eq_ignore_ascii_case(&first))
        .map(|event| event.seconds).sum();
    thread::sleep(Duration::from_secs(7));
    let first_total_later: i64 = state.timeline().expect("post-switch events").iter()
        .filter(|event| event.app.eq_ignore_ascii_case(&first))
        .map(|event| event.seconds).sum();
    assert_eq!(first_total, first_total_later,
        "old foreground app kept receiving time after the switch");

    state.set_tracking(false).expect("pause");
    let paused_count = state.timeline().expect("paused events").len();
    thread::sleep(Duration::from_secs(7));
    assert_eq!(state.timeline().expect("stable paused events").len(), paused_count,
        "collector kept writing after pause");

    let reopened = store::AppState::new(path.clone()).expect("reopen SQLite");
    assert!(!reopened.is_tracking(), "restart must not restore tracking consent");
    assert_eq!(reopened.timeline().expect("reopened events").len(), paused_count);
    reopened.clear_data().expect("delete all data");
    assert!(reopened.timeline().expect("deleted events").is_empty());
    assert!(reopened.activity().expect("deleted totals").is_empty());
    drop(reopened);
    drop(state);
    let _ = std::fs::remove_file(path);
    println!("PASS: real two-app VM foreground switch, stable-only SQLite attribution, pause, persistence and delete");
}
