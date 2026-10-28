mod collector;
mod store;

use std::sync::Arc;

use store::{ActivityEvent, ActivityRow, AppState};
use tauri::{Manager, State};

#[tauri::command]
fn get_activity(state: State<'_, Arc<AppState>>) -> Result<Vec<ActivityRow>, String> {
    state.activity()
}

#[tauri::command]
fn get_tracking(state: State<'_, Arc<AppState>>) -> bool {
    state.is_tracking()
}

#[tauri::command]
fn set_tracking(enabled: bool, state: State<'_, Arc<AppState>>) -> Result<(), String> {
    state.set_tracking(enabled)
}

#[tauri::command]
fn export_csv(state: State<'_, Arc<AppState>>) -> Result<String, String> {
    state.csv()
}

#[tauri::command]
fn get_timeline(state: State<'_, Arc<AppState>>) -> Result<Vec<ActivityEvent>, String> {
    state.timeline()
}

#[tauri::command]
fn clear_data(state: State<'_, Arc<AppState>>) -> Result<(), String> {
    state.clear_data()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            let data_dir = app
                .path()
                .app_data_dir()
                .map_err(|error| Box::<dyn std::error::Error>::from(error))?;
            std::fs::create_dir_all(&data_dir)?;
            let state = Arc::new(
                AppState::new(data_dir.join("vibefriend.sqlite3"))
                    .map_err(std::io::Error::other)?,
            );
            collector::spawn_collector(state.clone());
            app.manage(state);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![get_activity, get_tracking, set_tracking, export_csv, get_timeline, clear_data])
        .run(tauri::generate_context!())
        .expect("error while running VibeFriend");
}


#[cfg(all(test, target_os = "macos"))]
mod native_ipc_tests {
    use super::*;
    use serde_json::{json, Value};
    use tauri::test::{get_ipc_response, mock_builder, mock_context, noop_assets, MockRuntime};

    // Unlike the Playwright bridge fixture, this passes real serialized
    // InvokeRequest messages through Tauri's native Rust command dispatcher.
    // MockRuntime does not create a real OS webview: it is an IPC/backend
    // contract test, not physical-device or desktop GUI automation.
    fn invoke(webview: &tauri::WebviewWindow<MockRuntime>, command: &str, args: Value) -> Value {
        let response = get_ipc_response(
            webview,
            tauri::webview::InvokeRequest {
                cmd: command.into(),
                callback: tauri::ipc::CallbackFn(0),
                error: tauri::ipc::CallbackFn(1),
                url: if cfg!(windows) {
                    "http://tauri.localhost"
                } else {
                    "tauri://localhost"
                }
                .parse()
                .expect("IPC origin"),
                body: tauri::ipc::InvokeBody::Json(args),
                headers: Default::default(),
                invoke_key: tauri::test::INVOKE_KEY.to_string(),
            },
        )
        .unwrap_or_else(|error| panic!("native IPC command {command} failed: {error}"));
        response.deserialize::<Value>().expect("JSON IPC response")
    }

    #[test]
    fn registered_ipc_commands_enforce_opt_in_and_sqlite_lifecycle() {
        let app = mock_builder()
            .invoke_handler(tauri::generate_handler![
                get_activity,
                get_tracking,
                set_tracking,
                export_csv,
                get_timeline,
                clear_data
            ])
            .build(mock_context(noop_assets()))
            .expect("mock Tauri application");
        let state = Arc::new(AppState::new(":memory:".into()).expect("SQLite database"));
        app.manage(state.clone());
        let webview = tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
            .build()
            .expect("mock webview");

        assert_eq!(invoke(&webview, "get_tracking", json!({})), json!(false));
        assert_eq!(invoke(&webview, "get_activity", json!({})), json!([]));
        assert_eq!(invoke(&webview, "get_timeline", json!({})), json!([]));

        assert_eq!(invoke(&webview, "set_tracking", json!({"enabled": true})), Value::Null);
        assert_eq!(invoke(&webview, "get_tracking", json!({})), json!(true));
        state.record("Editor", 5, state.generation()).expect("production SQLite sample");

        let rows = invoke(&webview, "get_activity", json!({}));
        assert_eq!(rows.as_array().expect("activity array").len(), 1);
        assert_eq!(rows[0]["app"], "Editor");
        assert_eq!(rows[0]["seconds"], 5);

        let timeline = invoke(&webview, "get_timeline", json!({}));
        assert_eq!(timeline.as_array().expect("timeline array").len(), 1);
        assert_eq!(timeline[0]["app"], "Editor");
        assert_eq!(timeline[0]["seconds"], 5);

        let csv = invoke(&webview, "export_csv", json!({}));
        assert!(csv.as_str().expect("CSV text").contains(",\"Editor\",5"));

        assert_eq!(invoke(&webview, "clear_data", json!({})), Value::Null);
        assert_eq!(invoke(&webview, "get_tracking", json!({})), json!(false));
        assert_eq!(invoke(&webview, "get_activity", json!({})), json!([]));
        assert_eq!(invoke(&webview, "get_timeline", json!({})), json!([]));
        state.record("Editor", 5, state.generation()).expect("ignored paused sample");
        assert_eq!(invoke(&webview, "get_activity", json!({})), json!([]));
    }
}
