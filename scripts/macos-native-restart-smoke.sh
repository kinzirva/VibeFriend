#!/usr/bin/env bash
# Hosted macOS 15 VM, installed production app: SQLite data survives a real
# process restart, but tracking consent does not. No seeded DB or mock IPC.
set -euo pipefail

app="$(find "$RUNNER_TEMP/Applications" -maxdepth 1 -type d -name '*.app' -print -quit)"
test -n "$app" || { echo '::error::Installed macOS app from native GUI smoke missing'; exit 1; }
bin_name="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleExecutable' "$app/Contents/Info.plist")"
bin="$app/Contents/MacOS/$bin_name"
test -x "$bin"

db="$(find "$HOME/Library/Application Support" -name 'vibefriend.sqlite3' -type f -print -quit 2>/dev/null || true)"
test -n "$db" || { echo '::error::Production SQLite missing after first native GUI process'; exit 1; }

snapshot() {
  # Compare full rows, not merely counts or sums. Stable ordering ensures a
  # changed sample or updated timestamp is detected after the restart.
  { sqlite3 -separator '|' "$db" 'SELECT day,app,seconds,updated_at FROM activity ORDER BY day,app;';
    sqlite3 -separator '|' "$db" 'SELECT id,started_at,ended_at,app,seconds FROM activity_events ORDER BY id;'; } | shasum -a 256 | awk '{print $1}'
}
daily="$(sqlite3 "$db" 'SELECT count(*) FROM activity;')"
events="$(sqlite3 "$db" 'SELECT count(*) FROM activity_events;')"
test "$daily" -gt 0 && test "$events" -gt 0 || { echo "::error::Missing real samples from prior native GUI smoke (daily=$daily events=$events)"; exit 1; }
before="$(snapshot)"

# The preceding step's native GUI smoke kills its installed process on exit.
# Starting the actual installed binary again constructs a fresh AppState.
"$bin" > "$RUNNER_TEMP/macos-native-restart.log" 2>&1 &
app_pid=$!
trap 'kill "$app_pid" 2>/dev/null || true' EXIT
sleep 8
kill -0 "$app_pid" || { cat "$RUNNER_TEMP/macos-native-restart.log"; echo '::error::Restarted installed app exited'; exit 1; }
echo "Restarted installed app PID=$app_pid bundle=$(basename "$app")"
ps -p "$app_pid" -o pid,ppid,stat,command

# A real WKWebView AX Resume button proves the newly launched UI is opted out.
# The native UI switches to Pause when consent is enabled. Never accept a
# missing accessibility tree or an OS automation permission failure as PASS.
found=0
for attempt in $(seq 1 8); do
  if output="$(osascript - "$app_pid" 2>&1 <<'APPLESCRIPT'
on run argv
  set targetPid to (item 1 of argv) as integer
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
          set elementName to (name of elementRef) as text
          if length of buttonSummary < 600 then set buttonSummary to buttonSummary & " [" & elementName & "]
          if elementName is "Resume" then
            return "PASS: restarted installed WKWebView exposes Resume (tracking off)"
          end if
        end if
      end try
    end repeat
    error "Restarted WKWebView has no Resume: windows=" & windowCount & ", AX elements=" & (count of elementList) & ", buttons=" & buttonCount & ", names=" & buttonSummary
  end tell
end run
APPLESCRIPT
)"; then echo "$output"; found=1; break; fi
  echo "macOS restart AX probe $attempt/8: $output" >&2
  if [ "$attempt" -lt 8 ]; then sleep 3; fi
done
test "$found" -eq 1 || { echo '::error::Restarted native GUI did not show opt-out Resume'; exit 1; }

# Keep a known collectable application foreground with a fresh input event.
# If consent were incorrectly retained, the production collector would write
# new samples within this 15-second window.
osascript -e 'tell application "TextEdit" to activate'
osascript -e 'tell application "System Events" to key code 113'
frontmost="$(osascript -e 'tell application "System Events" to get name of first application process whose frontmost is true')"
test "$frontmost" = 'TextEdit' || { echo "::error::Expected TextEdit foreground, got $frontmost"; exit 1; }
sleep 15
after="$(snapshot)"
test "$before" = "$after" || { echo "::error::SQLite changed after restart without Resume: $before -> $after"; exit 1; }
test "$(sqlite3 "$db" 'SELECT count(*) FROM activity;')" = "$daily"
test "$(sqlite3 "$db" 'SELECT count(*) FROM activity_events;')" = "$events"
echo "PASS: installed macOS app real restart retains $daily daily rows / $events events, tracking defaults OFF and SQLite unchanged for 15s with TextEdit foreground (hosted VM only)"
