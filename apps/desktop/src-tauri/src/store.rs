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

#[derive(Debug, Serialize)]
pub struct ActivityEvent {
    pub started_at: String,
    pub ended_at: String,
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
                CREATE INDEX IF NOT EXISTS idx_activity_day ON activity(day);
                CREATE TABLE IF NOT EXISTS activity_events (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    started_at TEXT NOT NULL,
                    ended_at TEXT NOT NULL,
                    app TEXT NOT NULL,
                    seconds INTEGER NOT NULL CHECK(seconds > 0)
                );
                CREATE INDEX IF NOT EXISTS idx_activity_events_end ON activity_events(ended_at);",
            )
            .map_err(|error| error.to_string())?;

        Ok(Self {
            db: Mutex::new(connection),
            tracking: AtomicBool::new(false),
        })
    }

    pub fn is_tracking(&self) -> bool {
        self.tracking.load(Ordering::Relaxed)
    }

    pub fn set_tracking(&self, enabled: bool) {
        self.tracking.store(enabled, Ordering::Relaxed);
    }

    pub fn record(&self, app: &str, seconds: i64) -> Result<(), String> {
        if seconds <= 0 || app.trim().is_empty() {
            return Err("activity requires an application and positive duration".to_string());
        }
        let now = Utc::now();
        let day = Local::now().format("%Y-%m-%d").to_string();
        let ended_at = now.to_rfc3339();
        let started_at = (now - chrono::Duration::seconds(seconds)).to_rfc3339();
        let mut db = self.db.lock().map_err(|_| "database lock poisoned".to_string())?;
        // Recheck while holding the database lock so a paused/cleared collector
        // cannot insert a stale sample after the user has disabled tracking.
        if !self.is_tracking() {
            return Ok(());
        }
        let tx = db.transaction().map_err(|error| error.to_string())?;
        tx.execute(
            "INSERT INTO activity(day, app, seconds, updated_at)
             VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT(day, app) DO UPDATE SET
               seconds = seconds + excluded.seconds,
               updated_at = excluded.updated_at",
            params![day, app, seconds, ended_at],
        ).map_err(|error| error.to_string())?;
        tx.execute(
            "INSERT INTO activity_events(started_at, ended_at, app, seconds)
             VALUES (?1, ?2, ?3, ?4)",
            params![started_at, ended_at, app, seconds],
        ).map_err(|error| error.to_string())?;
        tx.commit().map_err(|error| error.to_string())
    }

    pub fn timeline(&self) -> Result<Vec<ActivityEvent>, String> {
        let db = self.db.lock().map_err(|_| "database lock poisoned".to_string())?;
        let mut statement = db
            .prepare("SELECT started_at, ended_at, app, seconds
                      FROM activity_events ORDER BY id DESC LIMIT 200")
            .map_err(|error| error.to_string())?;
        let rows = statement.query_map([], |row| {
            Ok(ActivityEvent {
                started_at: row.get(0)?,
                ended_at: row.get(1)?,
                app: row.get(2)?,
                seconds: row.get(3)?,
            })
        }).map_err(|error| error.to_string())?;
        rows.collect::<Result<Vec<_>, _>>().map_err(|error| error.to_string())
    }

    pub fn clear_data(&self) -> Result<(), String> {
        self.set_tracking(false);
        let db = self.db.lock().map_err(|_| "database lock poisoned".to_string())?;
        db.execute_batch("DELETE FROM activity_events; DELETE FROM activity;")
            .map_err(|error| error.to_string())
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
            let app = if row.app.chars().next().is_some_and(|ch| matches!(ch, '=' | '+' | '-' | '@' | '\t' | '\r')) {
                format!("'{}", row.app)
            } else {
                row.app
            };
            let escaped = app.replace('"', "\"\"");
            output.push_str(&format!("{},\"{}\",{}\n", row.day, escaped, row.seconds));
        }
        Ok(output)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn collection_requires_explicit_opt_in() {
        let state = AppState::new(PathBuf::from(":memory:")).expect("database");
        assert!(!state.is_tracking());
        state.set_tracking(true);
        assert!(state.is_tracking());
        state.set_tracking(false);
        assert!(!state.is_tracking());
    }

    #[test]
    fn csv_escapes_quotes_and_spreadsheet_formulas() {
        let state = AppState::new(PathBuf::from(":memory:")).expect("database");
        state.set_tracking(true);
        state.record("=HYPERLINK(\"x\")", 5).expect("sample");
        assert!(state.csv().expect("csv").contains("\"'=HYPERLINK(\"\"x\"\")\""));
        assert!(state.record("Browser", 0).is_err());
    }

    #[test]
    fn sqlite_round_trip() {
        let state = AppState::new(PathBuf::from(":memory:")).expect("database");
        state.set_tracking(true);
        state.record("Browser", 5).expect("first sample");
        state.record("Browser", 5).expect("second sample");
        let rows = state.activity().expect("rows");
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].app, "Browser");
        assert_eq!(rows[0].seconds, 10);
        let events = state.timeline().expect("events");
        assert_eq!(events.len(), 2);
        assert_eq!(events[0].seconds, 5);
        state.clear_data().expect("clear");
        assert!(!state.is_tracking());
        assert!(state.activity().expect("empty daily").is_empty());
        assert!(state.timeline().expect("empty timeline").is_empty());
        state.record("Browser", 5).expect("stale collector sample ignored");
        assert!(state.timeline().expect("still empty").is_empty());
    }
}
