// End-to-end VM diagnostic: run the *production* 5-second collector against
// a controlled foreground app and a real temporary SQLite database.
// No application names or private data are printed to CI logs.
mod store {
    include!("../store.rs");
}
include!("../collector.rs");

#[cfg(target_os = "macos")]
#[link(name = "AppKit", kind = "framework")]
unsafe extern "C" {
    fn NSApplicationLoad() -> bool;
}

fn main() {
    #[cfg(target_os = "macos")]
    unsafe {
        NSApplicationLoad();
    }

    let expected = std::env::args()
        .nth(1)
        .expect("usage: sampling_probe <expected-foreground-app>");
    let path = std::env::temp_dir().join(format!(
        "vibefriend-vm-sampling-{}-{}.sqlite",
        std::process::id(),
        chrono::Utc::now().timestamp_nanos_opt().unwrap_or_default()
    ));
    let state = Arc::new(store::AppState::new(path.clone()).expect("create SQLite"));
    assert!(!state.is_tracking(), "tracking must be opt-in on startup");
    spawn_collector(state.clone());

    // Prove a live collector cannot write anything before explicit consent.
    thread::sleep(Duration::from_secs(7));
    assert!(state.timeline().expect("read default-off timeline").is_empty());
    assert!(state.activity().expect("read default-off totals").is_empty());

    assert!(user_is_active(), "OS idle detection reports inactive; cannot validate live collection on this VM");
    state.set_tracking(true).expect("explicitly enable collection");

    // The collector intentionally skips the first tick after Resume to avoid
    // crediting time before consent. Wait for a subsequent real 5-second tick.
    let deadline = Instant::now() + Duration::from_secs(35);
    let mut captured = false;
    while Instant::now() < deadline {
        let events = state.timeline().expect("read captured events");
        if events.iter().any(|event| event.app.eq_ignore_ascii_case(&expected)) {
            captured = true;
            break;
        }
        thread::sleep(Duration::from_secs(1));
    }
    assert!(captured, "live collector did not persist the expected foreground application within 35 seconds");
    let before_pause = state.timeline().expect("timeline before pause");
    assert!(!before_pause.is_empty());
    assert!(before_pause.iter().all(|event| event.app.eq_ignore_ascii_case(&expected)),
        "collector recorded an unexpected foreground application");
    let total_before: i64 = before_pause.iter().map(|event| event.seconds).sum();
    assert!(total_before >= 5);

    state.set_tracking(false).expect("pause tracking");
    let generation_after_pause = state.generation();
    // This spans at least one collector tick. Paused samples must not leak in.
    thread::sleep(Duration::from_secs(7));
    assert_eq!(state.generation(), generation_after_pause);
    assert_eq!(state.timeline().expect("timeline after pause").len(), before_pause.len());
    assert_eq!(state.activity().expect("totals after pause").iter().map(|r| r.seconds).sum::<i64>(), total_before);

    // A separate SQLite connection must see committed samples (persistence).
    let reopened = store::AppState::new(path).expect("reopen persisted database");
    assert!(!reopened.is_tracking(), "reopening must not restore tracking consent");
    assert_eq!(reopened.timeline().expect("reopened timeline").len(), before_pause.len());
    assert_eq!(reopened.activity().expect("reopened totals").iter().map(|r| r.seconds).sum::<i64>(), total_before);

    reopened.clear_data().expect("delete persisted data");
    assert!(!reopened.is_tracking());
    assert!(reopened.timeline().expect("deleted timeline").is_empty());
    assert!(reopened.activity().expect("deleted totals").is_empty());
    assert!(state.timeline().expect("original connection after deletion").is_empty());

    println!("PASS: opt-in, real foreground sampling to SQLite, pause stability, reopen persistence and deletion");

    // Verify the *real OS idle signal* crosses the production 60-second threshold.
    // No synthetic input is sent during this phase. If a runner generates input
    // in the background, fail as inconclusive instead of claiming idle coverage.
    let idle_deadline = Instant::now() + Duration::from_secs(110);
    loop {
        if idle_duration().is_some_and(|idle| idle >= Duration::from_secs(IDLE_THRESHOLD_SECONDS)) {
            break;
        }
        assert!(
            Instant::now() < idle_deadline,
            "VM never reached 60s OS-reported idle; idle smoke inconclusive"
        );
        thread::sleep(Duration::from_secs(2));
    }
    assert!(!user_is_active(), "idle gate must be closed after 60s without input");

    // Reset any samples recorded while waiting for idle, then enable tracking.
    // The collector must not write new samples while the OS remains idle.
    state.clear_data().expect("clear before idle phase");
    state.set_tracking(true).expect("enable while OS is idle");
    thread::sleep(Duration::from_secs(12));
    assert!(!user_is_active(), "unexpected VM input during idle phase");
    assert!(state.timeline().expect("idle timeline").is_empty());
    assert!(state.activity().expect("idle totals").is_empty());
    state.set_tracking(false).expect("pause after idle phase");
    println!("PASS: real OS 60s idle gate prevents collector SQLite writes");
}
