#!/usr/bin/env bash
# Experimental GitHub-hosted macOS 15 acceptance of the installed *real*
# Tauri/WKWebView UI -> native IPC -> SQLite collector path.
# Not a physical Mac test. Do not turn this into a release gate until green.
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
  local label="$1" operation="$2"
  osascript - "$app_pid" "$label" "$operation" <<'APPLESCRIPT'
on run argv
  set targetPid to (item 1 of argv) as integer
  set targetLabel to item 2 of argv
  set operation to item 3 of argv
  tell application "System Events"
    set targetProcess to first application process whose unix id is targetPid
    set frontmost of targetProcess to true
    delay 1
    repeat with elementRef in (entire contents of targetProcess)
      try
        if (role of elementRef as text) is "AXButton" then
          if (name of elementRef as text) is targetLabel then
            if operation is "click" then
              perform action "AXPress" of elementRef
            end if
            return "Found native WKWebView button: " & targetLabel
          end if
        end if
      end try
    end repeat
  end tell
  error "Native WKWebView accessibility button not found: " & targetLabel
end run
APPLESCRIPT
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
before="$(sqlite3 "$db" 'SELECT count(*) FROM activity_events;')"
sleep 12
after="$(sqlite3 "$db" 'SELECT count(*) FROM activity_events;')"
test "$before" = "$after" || { echo "::error::Native GUI Pause failed to stop SQLite growth ($before -> $after)"; exit 1; }
echo "PASS: installed macOS WKWebView Resume -> native IPC -> real TextEdit collector -> SQLite -> Pause stable 12s (hosted VM only)"
