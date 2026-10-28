mod collector;
mod store;

use std::sync::Arc;

use store::{ActivityRow, AppState};
use tauri::{Manager, State};

#[tauri::command]
fn get_activity(state: State<'_, Arc<AppState>>) -> Result<Vec<ActivityRow>, String> {
    state.activity()
}

#[tauri::command]
fn set_tracking(enabled: bool, state: State<'_, Arc<AppState>>) {
    state.set_tracking(enabled);
}

#[tauri::command]
fn export_csv(state: State<'_, Arc<AppState>>) -> Result<String, String> {
    state.csv()
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
        .invoke_handler(tauri::generate_handler![get_activity, set_tracking, export_csv])
        .run(tauri::generate_context!())
        .expect("error while running VibeFriend");
}
