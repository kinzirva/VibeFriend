use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
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
    generation: AtomicU64,
}

impl AppState {
    pub fn new(path: PathBuf) -> Result<Self, String> {
        let connection = Connection::open(path).map_err(|error| error.to_string())?;
        connection
            .execute_batch(
                "PRAGMA secure_delete = ON;
                CREATE TABLE IF NOT EXISTS activity (
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
            generation: AtomicU64::new(0),
        })
    }

    pub fn is_tracking(&self) -> bool {
        self.tracking.load(Ordering::SeqCst)
    }

    pub fn generation(&self) -> u64 {
        self.generation.load(Ordering::SeqCst)
    }

    pub fn set_tracking(&self, enabled: bool) -> Result<(), String> {
        // Serialize consent changes with SQLite writes.
        let _db = self.db.lock().map_err(|_| "database lock poisoned".to_string())?;
        self.generation.fetch_add(1, Ordering::SeqCst);
        self.tracking.store(enabled, Ordering::SeqCst);
        Ok(())
    }

    pub fn record(&self, app: &str, seconds: i64, generation: u64) -> Result<(), String> {
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
        if !self.is_tracking() || self.generation() != generation {
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
        let mut db = self.db.lock().map_err(|_| "database lock poisoned".to_string())?;
        // Block new samples before removing anything. Consent and writes share this lock.
        self.generation.fetch_add(1, Ordering::SeqCst);
        self.tracking.store(false, Ordering::SeqCst);
        let tx = db.transaction().map_err(|error| error.to_string())?;
        tx.execute("DELETE FROM activity_events", [])
            .map_err(|error| error.to_string())?;
        tx.execute("DELETE FROM activity", [])
            .map_err(|error| error.to_string())?;
        tx.commit().map_err(|error| error.to_string())?;
        // Rebuild the database so freed pages from older versions are not retained.
        // This does not erase external backups, snapshots or SSD wear-level copies.
        db.execute_batch("VACUUM").map_err(|error| error.to_string())
    }

    pub fn activity(&self) -> Result<Vec<ActivityRow>, String> {
        let db = self.db.lock().map_err(|_| "database lock poisoned".to_string())?;
        let mut statement = db
            .prepare("SELECT day, app, seconds FROM activity ORDER BY day DESC, seconds DESC")
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
        state.set_tracking(true).expect("enable tracking");
        assert!(state.is_tracking());
        state.set_tracking(false).expect("disable tracking");
        assert!(!state.is_tracking());
    }

    #[test]
    fn csv_escapes_quotes_and_spreadsheet_formulas() {
        let state = AppState::new(PathBuf::from(":memory:")).expect("database");
        state.set_tracking(true).expect("enable tracking");
        state.record("=HYPERLINK(\"x\")", 5, state.generation()).expect("sample");
        assert!(state.csv().expect("csv").contains("\"'=HYPERLINK(\"\"x\"\")\""));
        assert!(state.record("Browser", 0, state.generation()).is_err());
    }

    #[test]
    fn sqlite_round_trip() {
        let state = AppState::new(PathBuf::from(":memory:")).expect("database");
        state.set_tracking(true).expect("enable tracking");
        state.record("Browser", 5, state.generation()).expect("first sample");
        state.record("Browser", 5, state.generation()).expect("second sample");
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
        state.record("Browser", 5, state.generation()).expect("stale collector sample ignored");
        assert!(state.timeline().expect("still empty").is_empty());
    }
    #[test]
    fn stale_samples_cannot_cross_pause_resume_or_clear() {
        let state = AppState::new(PathBuf::from(":memory:")).expect("database");
        state.set_tracking(true).expect("start");
        let old_generation = state.generation();
        state.set_tracking(false).expect("pause");
        state.set_tracking(true).expect("resume");
        state.record("Old app", 5, old_generation).expect("ignore stale");
        assert!(state.timeline().expect("timeline").is_empty());

        state.record("Current app", 5, state.generation()).expect("current");
        assert_eq!(state.timeline().expect("timeline").len(), 1);
        let before_clear = state.generation();
        state.clear_data().expect("clear");
        state.set_tracking(true).expect("resume after clear");
        state.record("Old app", 5, before_clear).expect("ignore pre-clear");
        assert!(state.timeline().expect("timeline").is_empty());
    }

    #[test]
    fn cleared_activity_stays_deleted_after_reopen() {
        let path = std::env::temp_dir().join(format!(
            "vibefriend-delete-{}-{}.sqlite",
            std::process::id(),
            Utc::now().timestamp_nanos_opt().unwrap_or_default()
        ));
        {
            let state = AppState::new(path.clone()).expect("create database");
            state.set_tracking(true).expect("start");
            state.record("Private app", 5, state.generation()).expect("record");
            assert_eq!(state.timeline().expect("timeline").len(), 1);
            state.clear_data().expect("delete");
            assert!(!state.is_tracking());
        }
        {
            let reopened = AppState::new(path.clone()).expect("reopen database");
            assert!(!reopened.is_tracking());
            assert!(reopened.activity().expect("daily records").is_empty());
            assert!(reopened.timeline().expect("events").is_empty());
        }
        std::fs::remove_file(path).expect("remove test database");
    }

    #[test]
    fn csv_export_is_not_truncated_to_500_activity_rows() {
        let state = AppState::new(PathBuf::from(":memory:")).expect("database");
        state.set_tracking(true).expect("start");
        for index in 0..505 {
            state.record(&format!("App-{index}"), 5, state.generation()).expect("sample");
        }
        assert_eq!(state.activity().expect("all rows").len(), 505);
        assert_eq!(state.csv().expect("csv").lines().count(), 506);
    }

    #[test]
    fn records_survive_reopen_but_tracking_consent_does_not() {
        let path = std::env::temp_dir().join(format!(
            "vibefriend-reopen-{}-{}.sqlite",
            std::process::id(),
            Utc::now().timestamp_nanos_opt().unwrap_or_default()
        ));
        {
            let state = AppState::new(path.clone()).expect("create database");
            assert!(!state.is_tracking(), "new installs must be opted out");
            state.set_tracking(true).expect("resume");
            let generation = state.generation();
            state.record("Browser", 5, generation).expect("sample one");
            state.record("Editor", 5, generation).expect("sample two");
            state.set_tracking(false).expect("pause");
            state.record("Browser", 5, generation).expect("stale sample is ignored");
            assert_eq!(state.timeline().expect("events").len(), 2);
        }
        {
            let reopened = AppState::new(path.clone()).expect("reopen database");
            assert!(!reopened.is_tracking(), "consent must reset on restart");
            let events = reopened.timeline().expect("persisted events");
            assert_eq!(events.len(), 2);
            assert_eq!(events[0].app, "Editor");
            assert_eq!(events[1].app, "Browser");
            let rows = reopened.activity().expect("persisted daily totals");
            assert_eq!(rows.len(), 2);
            assert_eq!(rows.iter().map(|row| row.seconds).sum::<i64>(), 10);
            reopened.record("No consent", 5, reopened.generation())
                .expect("disabled collector is ignored");
            assert_eq!(reopened.timeline().expect("unchanged events").len(), 2);
            reopened.set_tracking(true).expect("resume after restart");
            reopened.record("Browser", 5, reopened.generation()).expect("new sample");
            assert_eq!(reopened.timeline().expect("new event").len(), 3);
        }
        std::fs::remove_file(path).expect("remove test database");
    }

    #[test]
    fn csv_escapes_commas_newlines_quotes_and_formula_prefixes() {
        let state = AppState::new(PathBuf::from(":memory:")).expect("database");
        state.set_tracking(true).expect("resume");
        let generation = state.generation();
        state.record("Browser, \"Private\"\nTab", 5, generation).expect("quoted sample");
        state.record("@SUM(A1:A2)", 5, generation).expect("formula sample");
        let csv = state.csv().expect("csv");
        assert!(csv.starts_with("day,app,seconds\n"));
        assert!(csv.contains("\"Browser, \"\"Private\"\"\nTab\",5"));
        assert!(csv.contains("\"'@SUM(A1:A2)\",5"));
    }

}
