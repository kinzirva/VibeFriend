#!/usr/bin/env bash
# Required P0: installed macOS 15 WKWebView delete confirmation -> real
# Tauri clear_data -> production SQLite both tables empty and remain empty.
# Runs AFTER real collector and restart gates; hosted VM, not physical Mac.
set -euo pipefail

app="$(find "$RUNNER_TEMP/Applications" -maxdepth 1 -type d -name '*.app' -print -quit)"
test -n "$app" || { echo '::error::Installed macOS app missing'; exit 1; }
bin_name="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleExecutable' "$app/Contents/Info.plist")"
bin="$app/Contents/MacOS/$bin_name"
db="$(find "$HOME/Library/Application Support" -name 'vibefriend.sqlite3' -type f -print -quit 2>/dev/null || true)"
test -x "$bin" && test -n "$db"
daily="$(sqlite3 "$db" 'SELECT count(*) FROM activity;')"
events="$(sqlite3 "$db" 'SELECT count(*) FROM activity_events;')"
test "$daily" -gt 0 && test "$events" -gt 0 || {
  echo "::error::Missing real native samples before Delete (daily=$daily events=$events)"; exit 1;
}

"$bin" > "$RUNNER_TEMP/macos-native-delete.log" 2>&1 &
app_pid=$!
trap 'kill "$app_pid" 2>/dev/null || true' EXIT
sleep 8
kill -0 "$app_pid" || { cat "$RUNNER_TEMP/macos-native-delete.log"; exit 1; }

# Click the actual installed WKWebView control. Fail if AX is inaccessible;
# never substitute a direct SQLite DELETE or mock IPC.
pressed=0
for attempt in $(seq 1 8); do
  if output="$(osascript - "$app_pid" 2>&1 <<'APPLESCRIPT'
on run argv
  set targetPid to (item 1 of argv) as integer
  tell application "System Events"
    set p to first application process whose unix id is targetPid
    set frontmost of p to true
    delay 1
    set elements to entire contents of p
    repeat with e in elements
      try
        if (role of e as text) is "AXButton" and (name of e as text) is "Delete local data" then
          perform action "AXPress" of e
          return "Pressed installed WKWebView Delete local data"
        end if
      end try
    end repeat
    error "Delete local data AXButton absent; elements=" & (count of elements)
  end tell
end run
APPLESCRIPT
)"; then echo "$output"; pressed=1; break; fi
  echo "macOS native Delete AX attempt $attempt/8: $output" >&2
  if [ "$attempt" -lt 8 ]; then sleep 3; fi
done
test "$pressed" -eq 1 || { echo '::error::Native Delete UI inaccessible'; exit 1; }

# window.confirm is an OS modal in WKWebView. Accept via a real keyboard
# Return on the same GUI session; then require a database-side effect.
sleep 2
osascript -e 'tell application "System Events" to key code 36'
cleared=0
for attempt in $(seq 1 10); do
  daily_after="$(sqlite3 "$db" 'SELECT count(*) FROM activity;')"
  events_after="$(sqlite3 "$db" 'SELECT count(*) FROM activity_events;')"
  if [ "$daily_after" = 0 ] && [ "$events_after" = 0 ]; then cleared=1; break; fi
  echo "Delete pending: daily=$daily_after events=$events_after attempt=$attempt/10"
  sleep 2
done
test "$cleared" -eq 1 || {
  echo "::error::Real native Delete UI did not clear both tables; daily=$daily_after events=$events_after"; exit 1;
}
test "$(sqlite3 "$db" 'PRAGMA integrity_check;')" = ok
echo "PASS: installed macOS WKWebView Delete confirmation cleared production SQLite activity and activity_events ($daily/$events -> 0/0)"

# With TextEdit in front and a fresh input event, no sampling may resume.
osascript -e 'tell application "TextEdit" to activate'
osascript -e 'tell application "System Events" to key code 113'
frontmost="$(osascript -e 'tell application "System Events" to get name of first application process whose frontmost is true')"
test "$frontmost" = TextEdit || { echo "::error::Expected TextEdit foreground after Delete, got $frontmost"; exit 1; }
sleep 15
test "$(sqlite3 "$db" 'SELECT count(*) FROM activity;')" = 0
test "$(sqlite3 "$db" 'SELECT count(*) FROM activity_events;')" = 0
echo "PASS: installed macOS Delete automatically paused tracking; both production tables remain empty for 15s with TextEdit foreground (hosted VM only)"
