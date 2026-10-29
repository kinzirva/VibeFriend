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

# P0 negative control: clicking Cancel in the *installed* WKWebView must
# preserve every production row. Browser mocks cannot prove native AX/IPC
# cancellation. Both actions must be visible before we press Cancel.
cancelled=0
for attempt in $(seq 1 8); do
  if output="$(osascript - "$app_pid" 2>&1 <<'APPLESCRIPT'
on run argv
  set targetPid to (item 1 of argv) as integer
  tell application "System Events"
    set p to first application process whose unix id is targetPid
    set frontmost of p to true
    delay 1
    set elements to entire contents of p
    set cancelButton to missing value
    set hasDelete to false
    repeat with e in elements
      try
        if (role of e as text) is "AXButton" then
          set n to (name of e) as text
          if n is "Cancel" then set cancelButton to e
          if n is "Delete all data" then set hasDelete to true
        end if
      end try
    end repeat
    if hasDelete and cancelButton is not missing value then
      perform action "AXPress" of cancelButton
      return "Pressed installed WKWebView in-app Cancel (Delete all data also visible)"
    end if
    error "Cancel/Delete all data buttons not both accessible"
  end tell
end run
APPLESCRIPT
)"; then echo "$output"; cancelled=1; break; fi
  echo "macOS native Cancel AX attempt $attempt/8: $output" >&2
  if [ "$attempt" -lt 8 ]; then sleep 2; fi
done
test "$cancelled" -eq 1 || { echo '::error::Could not cancel installed WKWebView Delete dialog'; exit 1; }
sleep 2
daily_cancel="$(sqlite3 "$db" 'SELECT count(*) FROM activity;')"
events_cancel="$(sqlite3 "$db" 'SELECT count(*) FROM activity_events;')"
test "$daily_cancel" = "$daily" && test "$events_cancel" = "$events" || {
  echo "::error::Cancel unexpectedly modified production SQLite ($daily/$events -> $daily_cancel/$events_cancel)"; exit 1;
}
echo "PASS: installed macOS WKWebView Delete Cancel preserved production SQLite ($daily daily / $events events)"

# Reopen the actual Delete dialog after Cancel. The following affirmative
# confirmation must be a separate user action, not a lingering stale dialog.
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
          return "Reopened installed WKWebView Delete local data after Cancel"
        end if
      end try
    end repeat
    error "Delete local data AXButton absent after Cancel"
  end tell
end run
APPLESCRIPT
)"; then echo "$output"; pressed=1; break; fi
  echo "macOS native reopen Delete AX attempt $attempt/8: $output" >&2
  if [ "$attempt" -lt 8 ]; then sleep 2; fi
done
test "$pressed" -eq 1 || { echo '::error::Cannot reopen native Delete after Cancel'; exit 1; }

# Use the app's explicit accessible confirmation rather than WKWebView's
# JavaScript window.confirm (whose buttons are not exposed reliably in macOS
# hosted VMs). Require BOTH affirmative and Cancel buttons in the real UI;
# never bypass the user-facing consent confirmation or delete via direct SQL.
confirmed=0
for attempt in $(seq 1 8); do
  if output="$(osascript - "$app_pid" 2>&1 <<'APPLESCRIPT'
on run argv
  set targetPid to (item 1 of argv) as integer
  tell application "System Events"
    set p to first application process whose unix id is targetPid
    set frontmost of p to true
    delay 1
    set elements to entire contents of p
    set buttonNames to ""
    set confirmButton to missing value
    set hasCancel to false
    repeat with e in elements
      try
        if (role of e as text) is "AXButton" then
          set n to (name of e) as text
          if length of buttonNames < 1200 then set buttonNames to buttonNames & " [" & n & "]"
          if n is "Cancel" then set hasCancel to true
          if n is "Delete all data" then set confirmButton to e
        end if
      end try
    end repeat
    if hasCancel and confirmButton is not missing value then
      perform action "AXPress" of confirmButton
      return "Pressed installed WKWebView in-app Delete all data (paired Cancel visible)"
    end if
    error "In-app confirmation unavailable; windows=" & (count of windows of p) & ", buttons=" & buttonNames
  end tell
end run
APPLESCRIPT
)"; then echo "$output"; confirmed=1; break; fi
  echo "macOS in-app confirmation AX attempt $attempt/8: $output" >&2
  if [ "$attempt" -lt 8 ]; then sleep 2; fi
done
test "$confirmed" -eq 1 || { echo '::error::Could not explicitly confirm installed WKWebView Delete dialog'; exit 1; }
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
