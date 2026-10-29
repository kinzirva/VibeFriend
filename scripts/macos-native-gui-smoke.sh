#!/usr/bin/env bash
# Required GitHub-hosted macOS 15 acceptance of the installed *real*
# Tauri/WKWebView UI -> native IPC -> SQLite collector path.
# This gates publishing, but does not substitute for physical-Mac testing or signing.
set -euo pipefail

dmg="$(find native-release -maxdepth 1 -name '*.dmg' -type f -print -quit)"
test -n "$dmg" || { echo "::error::macOS DMG artifact missing"; exit 1; }
mount_point=""
app_pid=""
cleanup() {
  if [ -n "$app_pid" ]; then kill "$app_pid" 2>/dev/null || true; fi
  if [ -n "$mount_point" ]; then hdiutil detach "$mount_point" -quiet || true; fi
}
trap cleanup EXIT

attach_output="$(hdiutil attach "$dmg" -nobrowse -readonly)"
mount_point="$(printf '%s\n' "$attach_output" | awk '/\/Volumes\// {sub(/^.*\t/,""); print; exit}')"
test -d "$mount_point"
app="$(find "$mount_point" -maxdepth 2 -type d -name '*.app' -print -quit)"
test -n "$app"
mkdir -p "$RUNNER_TEMP/Applications"
cp -R "$app" "$RUNNER_TEMP/Applications/"
installed="$RUNNER_TEMP/Applications/$(basename "$app")"
xattr -dr com.apple.quarantine "$installed" 2>/dev/null || true
bin_name="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleExecutable' "$installed/Contents/Info.plist")"
bin="$installed/Contents/MacOS/$bin_name"
test -x "$bin"

"$bin" > "$RUNNER_TEMP/macos-native-gui.log" 2>&1 &
app_pid=$!
sleep 8
kill -0 "$app_pid" || { cat "$RUNNER_TEMP/macos-native-gui.log"; exit 1; }
echo "Installed macOS app launched: PID=$app_pid"

# A real AXPress on a WKWebView button is required. Never inject mock IPC or
# write synthetic SQLite rows. TCC denial must fail visibly, not be skipped.
ui_button() {
  local label="$1" operation="$2" output=""
  # WKWebView accessibility exposure may lag behind process startup. Retry,
  # but never turn an inaccessible/absent button into a passing result.
  for attempt in $(seq 1 8); do
    if output="$(osascript - "$app_pid" "$label" "$operation" 2>&1 <<'APPLESCRIPT'
on run argv
  set targetPid to (item 1 of argv) as integer
  set targetLabel to item 2 of argv
  set operation to item 3 of argv
  tell application "System Events"
    set targetProcess to first application process whose unix id is targetPid
    set frontmost of targetProcess to true
    delay 1
    set windowCount to count of windows of targetProcess
    set elementList to entire contents of targetProcess
    set buttonSummary to ""
    set buttonCount to 0
    repeat with elementRef in elementList
      try
        set elementRole to (role of elementRef) as text
        if elementRole is "AXButton" then
          set buttonCount to buttonCount + 1
          set buttonName to (name of elementRef) as text
          if length of buttonSummary < 600 then set buttonSummary to buttonSummary & " [" & buttonName & "]"
          if buttonName is targetLabel then
            if operation is "click" then perform action "AXPress" of elementRef
            return "Found native WKWebView button: " & targetLabel
          end if
        end if
      end try
    end repeat
    error "WKWebView button '" & targetLabel & "' absent: windows=" & windowCount & ", AX elements=" & (count of elementList) & ", buttons=" & buttonCount & ", names=" & buttonSummary
  end tell
end run
APPLESCRIPT
)"; then
      echo "$output"
      return 0
    fi
    echo "macOS AX probe $attempt/8 ($label): $output" >&2
    if [ "$attempt" -lt 8 ]; then sleep 3; fi
  done
  echo "::error::macOS native AX button '$label' inaccessible after retries; real GUI/IPC remains UNVERIFIED" >&2
  return 1
}

# The UI must actually render, expose its Resume control and dispatch the
# native Tauri set_tracking command before any foreground samples are accepted.
ui_button "Resume" "click"
sleep 3
ui_button "Pause" "check"

db=""
for attempt in $(seq 1 20); do
  db="$(find "$HOME/Library/Application Support" -name 'vibefriend.sqlite3' -type f -print -quit 2>/dev/null || true)"
  [ -n "$db" ] && break
  sleep 1
done
test -n "$db" || { echo "::error::Native Tauri SQLite database missing"; exit 1; }
echo "Production SQLite opened under user Application Support"
test "$(sqlite3 "$db" 'SELECT count(*) FROM sqlite_master WHERE type="table" AND name IN ("activity","activity_events");')" = 2

open -a TextEdit
osascript -e 'tell application "TextEdit" to activate'
# This harmless key event resets the production 60-second idle gate.
osascript -e 'tell application "System Events" to key code 113'
count_textedit() {
  sqlite3 "$db" "SELECT count(*) FROM activity_events WHERE lower(app)='textedit';"
}
samples=0
for attempt in $(seq 1 8); do
  sleep 5
  samples="$(count_textedit)"
  [ "$samples" -gt 0 ] && break
done
test "$samples" -gt 0 || { echo "::error::Resume did not produce real TextEdit samples via native IPC"; exit 1; }
echo "Native GUI Resume -> real TextEdit foreground -> SQLite activity_events: $samples sample(s)"

ui_button "Pause" "click"
sleep 2
ui_button "Resume" "check"

# AX queries focus ActivityTracker, which is deliberately excluded by the
# collector. A count-only Pause check with the tracker in foreground would be
# a false positive even if native collection never stopped. Restore a known
# recordable foreground app, keep the idle gate active and verify its identity.
osascript -e 'tell application "TextEdit" to activate'
osascript -e 'tell application "System Events" to key code 113'
frontmost="$(osascript -e 'tell application "System Events" to get name of first application process whose frontmost is true')"
test "$frontmost" = "TextEdit" || { echo "::error::Pause probe foreground is '$frontmost', expected TextEdit"; exit 1; }
before="$(count_textedit)"
sleep 15
after="$(count_textedit)"
test "$before" = "$after" || { echo "::error::Native GUI Pause failed: real TextEdit samples grew ($before -> $after)"; exit 1; }
echo "Native GUI Pause: TextEdit foreground confirmed; no new samples for 15s"

# Positive control: the same TextEdit fixture must produce NEW native SQLite
# samples after Resume. This rejects false green from a dead collector, lost
# permissions or an ineligible OS session during the Pause observation.
ui_button "Resume" "click"
sleep 2
ui_button "Pause" "check"
osascript -e 'tell application "TextEdit" to activate'
osascript -e 'tell application "System Events" to key code 113'
frontmost="$(osascript -e 'tell application "System Events" to get name of first application process whose frontmost is true')"
test "$frontmost" = "TextEdit" || { echo "::error::Resume control foreground is '$frontmost', expected TextEdit"; exit 1; }
resumed="$after"
for attempt in $(seq 1 8); do
  sleep 5
  resumed="$(count_textedit)"
  [ "$resumed" -gt "$after" ] && break
done
test "$resumed" -gt "$after" || { echo "::error::Resume did not restart real TextEdit sampling ($after -> $resumed)"; exit 1; }
# Re-pause via the installed WKWebView UI to take a stable production DB
# snapshot. Compare *all* daily report seconds to the complete event ledger,
# not just the recent (200-row-limited) UI timeline. No synthetic rows.
ui_button "Pause" "click"
sleep 2
ui_button "Resume" "check"
daily_seconds="$(sqlite3 "$db" 'SELECT COALESCE(SUM(seconds),0) FROM activity;')"
event_seconds="$(sqlite3 "$db" 'SELECT COALESCE(SUM(seconds),0) FROM activity_events;')"
textedit_daily="$(sqlite3 "$db" "SELECT COALESCE(SUM(seconds),0) FROM activity WHERE lower(app)='textedit';")"
textedit_events="$(sqlite3 "$db" "SELECT COALESCE(SUM(seconds),0) FROM activity_events WHERE lower(app)='textedit';")"
test "$daily_seconds" -gt 0 || { echo "::error::No real daily report seconds"; exit 1; }
test "$daily_seconds" = "$event_seconds" || { echo "::error::Daily report/event mismatch: $daily_seconds vs $event_seconds"; exit 1; }
test "$textedit_daily" -gt 0 || { echo "::error::No TextEdit daily report seconds"; exit 1; }
test "$textedit_daily" = "$textedit_events" || { echo "::error::TextEdit daily/event mismatch: $textedit_daily vs $textedit_events"; exit 1; }

# The tracker must never record itself, even when the AX automation brought
# its own window to the foreground for Resume/Pause/report interactions.
self_rows="$(sqlite3 "$db" "SELECT count(*) FROM activity_events WHERE lower(app) IN ('activitytracker','vibefriend');")"
test "$self_rows" = 0 || { echo "::error::Tracker recorded its own foreground samples: $self_rows"; exit 1; }
echo "PASS: macOS real SQLite daily totals == event ledger ($daily_seconds seconds; TextEdit $textedit_daily seconds); self-tracking events=0"

# Exercise the installed WKWebView period controls, not a browser fixture.
# These AX button actions are native GUI checks; the SQLite assertions above
# verify the underlying report data rather than claiming AX text accuracy.
ui_button "All time" "click"
ui_button "Today" "click"
ui_button "This week" "click"
echo "PASS: macOS installed WKWebView All time/Today/This week report controls accessible via AXPress (hosted VM only)"
echo "PASS: installed macOS WKWebView Resume -> native IPC -> real TextEdit SQLite -> Pause stable 15s with TextEdit foreground -> Resume produces new samples (hosted VM only)"
