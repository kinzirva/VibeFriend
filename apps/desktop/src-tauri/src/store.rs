use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

use chrono::{Local, Utc};
use rusqlite::{params, Connection};
use serde::Serialize;

#[derive(Debug, Serialize)]
pub struct ActivityRow {
    pub day: String,
    pub app: String,
    pub seconds: i64,
}

pub struct AppState {
    db: Mutex<Connection>,
    tracking: AtomicBool,
}

impl AppState {
    pub fn new(path: PathBuf) -> Result<Self, String> {
        let connection = Connection::open(path).map_err(|error| error.to_string())?;
        connection
            .execute_batch(
                "CREATE TABLE IF NOT EXISTS activity (
                    day TEXT NOT NULL,
                    app TEXT NOT NULL,
                    seconds INTEGER NOT NULL DEFAULT 0,
                    updated_at TEXT NOT NULL,
                    PRIMARY KEY (day, app)
                );
                CREATE INDEX IF NOT EXISTS idx_activity_day ON activity(day);",
            )
            .map_err(|error| error.to_string())?;

        Ok(Self {
            db: Mutex::new(connection),
            tracking: AtomicBool::new(true),
        })
    }

    pub fn is_tracking(&self) -> bool {
        self.tracking.load(Ordering::Relaxed)
    }

    pub fn set_tracking(&self, enabled: bool) {
        self.tracking.store(enabled, Ordering::Relaxed);
    }

    pub fn record(&self, app: &str, seconds: i64) -> Result<(), String> {
        let day = Local::now().format("%Y-%m-%d").to_string();
        let updated_at = Utc::now().to_rfc3339();
        let db = self.db.lock().map_err(|_| "database lock poisoned".to_string())?;
        db.execute(
            "INSERT INTO activity(day, app, seconds, updated_at)
             VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT(day, app) DO UPDATE SET
               seconds = seconds + excluded.seconds,
               updated_at = excluded.updated_at",
            params![day, app, seconds, updated_at],
        )
        .map_err(|error| error.to_string())?;
        Ok(())
    }

    pub fn activity(&self) -> Result<Vec<ActivityRow>, String> {
        let db = self.db.lock().map_err(|_| "database lock poisoned".to_string())?;
        let mut statement = db
            .prepare("SELECT day, app, seconds FROM activity ORDER BY day DESC, seconds DESC LIMIT 500")
            .map_err(|error| error.to_string())?;
        let rows = statement
            .query_map([], |row| {
                Ok(ActivityRow {
                    day: row.get(0)?,
                    app: row.get(1)?,
                    seconds: row.get(2)?,
                })
            })
            .map_err(|error| error.to_string())?;

        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|error| error.to_string())
    }

    pub fn csv(&self) -> Result<String, String> {
        let rows = self.activity()?;
        let mut output = String::from("day,app,seconds\n");
        for row in rows {
            let escaped = row.app.replace('"', "\"\"");
            output.push_str(&format!("{},\"{}\",{}\n", row.day, escaped, row.seconds));
        }
        Ok(output)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sqlite_round_trip() {
        let state = AppState::new(PathBuf::from(":memory:")).expect("database");
        state.record("Browser", 5).expect("first sample");
        state.record("Browser", 5).expect("second sample");
        let rows = state.activity().expect("rows");
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].app, "Browser");
        assert_eq!(rows[0].seconds, 10);
    }
}
