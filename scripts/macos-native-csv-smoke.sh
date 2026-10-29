#!/usr/bin/env bash
# Hosted macOS 15 only: installed WKWebView Export CSV UI -> production IPC
# -> actual downloaded file matching real SQLite daily records. No mock data.
set -euo pipefail

app="$(find "$RUNNER_TEMP/Applications" -maxdepth 1 -type d -name '*.app' -print -quit)"
test -n "$app" || { echo '::error::Installed macOS app missing'; exit 1; }
exe="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleExecutable' "$app/Contents/Info.plist")"
bin="$app/Contents/MacOS/$exe"
test -x "$bin"
db="$(find "$HOME/Library/Application Support" -name vibefriend.sqlite3 -type f -print -quit 2>/dev/null || true)"
test -n "$db"
rows="$(sqlite3 "$db" 'SELECT count(*) FROM activity;')"
events="$(sqlite3 "$db" 'SELECT count(*) FROM activity_events;')"
test "$rows" -gt 0 && test "$events" -gt 0 || { echo '::error::No real samples before native CSV export'; exit 1; }

mkdir -p "$HOME/Downloads"
# This ephemeral hosted runner has no personal downloads; reject any stale
# artifact from an earlier test rather than treating it as a fresh export.
find "$HOME/Downloads" -maxdepth 1 -type f -name 'activitytracker-activity*.csv' -delete
"$bin" > "$RUNNER_TEMP/macos-native-csv.log" 2>&1 &
app_pid=$!
trap 'kill "$app_pid" 2>/dev/null || true' EXIT
sleep 8
kill -0 "$app_pid" || { cat "$RUNNER_TEMP/macos-native-csv.log"; exit 1; }

clicked=0
for attempt in $(seq 1 8); do
  if output="$(osascript - "$app_pid" 2>&1 <<'APPLESCRIPT'
on run argv
  set targetPid to (item 1 of argv) as integer
  tell application "System Events"
    set p to first application process whose unix id is targetPid
    set frontmost of p to true
    delay 1
    set allElements to entire contents of p
    repeat with e in allElements
      try
        if (role of e as text) is "AXButton" and (name of e as text) is "Export CSV" then
          perform action "AXPress" of e
          return "Pressed installed WKWebView Export CSV"
        end if
      end try
    end repeat
    error "Export CSV AXButton absent, elements=" & (count of allElements)
  end tell
end run
APPLESCRIPT
)"; then echo "$output"; clicked=1; break; fi
  echo "macOS native Export CSV AX attempt $attempt/8: $output" >&2
  if [ "$attempt" -lt 8 ]; then sleep 3; fi
done
test "$clicked" -eq 1 || { echo '::error::Installed Export CSV UI inaccessible'; exit 1; }

# Some WKWebView versions show a native Save panel. Confirm only when both
# Save and Cancel buttons are visible; never blindly press Return.
for attempt in $(seq 1 5); do
  [ -n "$(find "$HOME/Downloads" -maxdepth 1 -type f -name 'activitytracker-activity*.csv' -print -quit)" ] && break
  output="$(osascript - "$app_pid" 2>&1 <<'APPLESCRIPT'
on run argv
  set targetPid to (item 1 of argv) as integer
  tell application "System Events"
    set p to first application process whose unix id is targetPid
    set elements to entire contents of p
    set saveButton to missing value
    set cancelVisible to false
    set names to ""
    repeat with e in elements
      try
        if (role of e as text) is "AXButton" then
          set n to (name of e) as text
          if length of names < 800 then set names to names & " [" & n & "]"
          if n is "Save" then set saveButton to e
          if n is "Cancel" then set cancelVisible to true
        end if
      end try
    end repeat
    if cancelVisible and saveButton is not missing value then
      perform action "AXPress" of saveButton
      return "Pressed native Save panel (paired Cancel visible)"
    end if
    return "No native Save panel yet; buttons=" & names
  end tell
end run
APPLESCRIPT
)" || true
  echo "$output"
  sleep 3
done

exported=""
for attempt in $(seq 1 10); do
  exported="$(find "$HOME/Downloads" -maxdepth 1 -type f -name 'activitytracker-activity*.csv' -print -quit)"
  [ -n "$exported" ] && [ -s "$exported" ] && break
  sleep 2
done
test -n "$exported" && test -s "$exported" || {
  echo '::error::Native Export CSV click did not produce a real file in Downloads';
  cat "$RUNNER_TEMP/macos-native-csv.log" || true
  exit 1
}

python3 - "$db" "$exported" <<'PY'
import csv
import sqlite3
import sys
from pathlib import Path

conn = sqlite3.connect(sys.argv[1])
expected = conn.execute('SELECT day, app, seconds FROM activity ORDER BY day DESC, seconds DESC').fetchall()
assert expected, 'missing real collected SQLite rows'
with Path(sys.argv[2]).open(newline='', encoding='utf-8-sig') as file:
    reader = csv.reader(file, strict=True)
    assert next(reader) == ['day', 'app', 'seconds'], 'unexpected CSV header'
    actual = [(day, app, int(seconds)) for day, app, seconds in reader]
normalized = [(day, "'" + app if app.startswith(('=', '+', '-', '@', '\t', '\r')) else app, seconds)
              for day, app, seconds in expected]
assert actual == normalized, f'CSV differs from production SQLite: expected {normalized!r}, got {actual!r}'
print(f'PASS: real installed macOS WKWebView Export CSV downloaded {len(actual)} rows matching production SQLite (hosted VM only)')
PY
