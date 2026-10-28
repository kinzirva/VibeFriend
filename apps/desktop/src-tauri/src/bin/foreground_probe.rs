// Compile the production OS collector into a standalone diagnostic binary.
// This exercises the same foreground_application() code as the desktop app,
// without starting tracking, reading SQLite or collecting private user data.
mod store {
    include!("../store.rs");
}
include!("../collector.rs");

// The Tauri app links AppKit via its windowing runtime. The standalone
// diagnostic must explicitly load AppKit before objc::class!(NSWorkspace).
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
        .expect("usage: cargo run --bin foreground_probe -- <expected-app-name>");
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(20);
    let mut attempts = 0;
    while std::time::Instant::now() < deadline {
        attempts += 1;
        if let Some(app) = foreground_application() {
            if app.eq_ignore_ascii_case(&expected) {
                println!("PASS: production collector identified expected foreground application after {attempts} checks");
                return;
            }
        }
        std::thread::sleep(std::time::Duration::from_secs(1));
    }
    // Do not print the names of other foreground apps to CI logs.
    eprintln!("FAIL: production collector did not identify expected foreground application in 20 seconds");
    std::process::exit(1);
}
