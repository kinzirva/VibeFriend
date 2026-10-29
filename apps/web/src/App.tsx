import { ChangeEvent, useEffect, useMemo, useRef, useState } from "react";
import { csvApp, parseCsv, type ActivityRow } from "./csv";

type ActivityEvent = {
  started_at: string;
  ended_at: string;
  app: string;
  seconds: number;
};

const storageKey = "vibefriend-web-import-v1";

function localDay(date: Date) {
  return [date.getFullYear(), String(date.getMonth() + 1).padStart(2, "0"), String(date.getDate()).padStart(2, "0")].join("-");
}

const isDesktop = () => "__TAURI_INTERNALS__" in window;

async function invokeDesktop<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<T>(command, args);
}

function formatDuration(totalSeconds: number) {
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  if (hours === 0) return `${minutes}m`;
  return `${hours}h ${minutes}m`;
}

function formatCountdown(seconds: number) {
  const minutes = Math.floor(seconds / 60);
  return `${String(minutes).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}

export default function App() {
  const [rows, setRows] = useState<ActivityRow[]>(() => {
    if (isDesktop()) return [];
    try {
      const saved = localStorage.getItem(storageKey);
      return saved ? parseCsv(saved) : [];
    } catch { return []; }
  });
  const [timeline, setTimeline] = useState<ActivityEvent[]>([]);
  const [tracking, setTracking] = useState(false);
  const [period, setPeriod] = useState<"today" | "week" | "all">("today");
  const [mode, setMode] = useState<"desktop" | "web">(isDesktop() ? "desktop" : "web");
  const [status, setStatus] = useState("Tracking is off until you explicitly start it. Data stays local.");
  const [focusMinutes, setFocusMinutes] = useState<25 | 50>(25);
  const [focusSeconds, setFocusSeconds] = useState(25 * 60);
  const [focusStatus, setFocusStatus] = useState<"idle" | "running" | "paused" | "complete">("idle");
  const focusDeadline = useRef<number | null>(null);
  // Discard in-flight polling results when a privacy-sensitive mutation begins.
  const refreshRevision = useRef(0);
  const refreshRequest = useRef(0);
  const desktopMutationPending = useRef(false);

  useEffect(() => {
    if (focusStatus !== "running") return;
    const tick = () => {
      const remaining = Math.max(0, Math.ceil(((focusDeadline.current ?? performance.now()) - performance.now()) / 1000));
      setFocusSeconds(remaining);
      if (remaining === 0) setFocusStatus("complete");
    };
    tick();
    const timer = window.setInterval(tick, 500);
    return () => window.clearInterval(timer);
  }, [focusStatus]);

  const startFocus = () => {
    const remaining = focusStatus === "complete" ? focusMinutes * 60 : focusSeconds;
    setFocusSeconds(remaining);
    focusDeadline.current = performance.now() + remaining * 1000;
    setFocusStatus("running");
  };

  const pauseFocus = () => {
    if (focusStatus !== "running") return;
    setFocusSeconds(Math.max(0, Math.ceil(((focusDeadline.current ?? performance.now()) - performance.now()) / 1000)));
    focusDeadline.current = null;
    setFocusStatus("paused");
  };

  const resetFocus = (minutes: 25 | 50 = focusMinutes) => {
    focusDeadline.current = null;
    setFocusMinutes(minutes);
    setFocusSeconds(minutes * 60);
    setFocusStatus("idle");
  };


  const refresh = async () => {
    if (!isDesktop() || desktopMutationPending.current) return;
    const revision = refreshRevision.current;
    const request = ++refreshRequest.current;
    try {
      const [latest, enabled, events] = await Promise.all([
        invokeDesktop<ActivityRow[]>("get_activity"),
        invokeDesktop<boolean>("get_tracking"),
        invokeDesktop<ActivityEvent[]>("get_timeline")
      ]);
      if (revision !== refreshRevision.current || request !== refreshRequest.current || desktopMutationPending.current) return;
      setRows(latest);
      setTimeline(events);
      setTracking(enabled);
      setMode("desktop");
      setStatus(enabled ? "Tracking enabled. Activity is stored in local SQLite." : "Tracking paused. Local SQLite data is retained until deleted.");
    } catch (error) {
      if (revision !== refreshRevision.current || request !== refreshRequest.current || desktopMutationPending.current) return;
      setStatus(`Desktop bridge unavailable: ${String(error)}`);
    }
  };

  useEffect(() => {
    void refresh();
    if (!isDesktop()) return;
    const timer = window.setInterval(() => void refresh(), 5000);
    return () => window.clearInterval(timer);
  }, []);

  // Keep Today/This week accurate when the dashboard stays open past midnight.
  // The timer updates only the local calendar day, without collecting new data.
  const [today, setToday] = useState(() => localDay(new Date()));
  useEffect(() => {
    const timer = window.setInterval(() => setToday(localDay(new Date())), 15_000);
    return () => window.clearInterval(timer);
  }, []);
  const monday = new Date(`${today}T12:00:00`);
  monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7));
  const weekStart = localDay(monday);
  const filteredRows = useMemo(() => rows.filter((row) =>
    period === "all" || (period === "today" ? row.day === today : row.day >= weekStart && row.day <= today)
  ).sort((a, b) => b.day.localeCompare(a.day) || b.seconds - a.seconds), [rows, period, today, weekStart]);

  const totals = useMemo(() => {
    const byApp = new Map<string, number>();
    for (const row of filteredRows) byApp.set(row.app, (byApp.get(row.app) ?? 0) + row.seconds);
    return [...byApp.entries()].sort((a, b) => b[1] - a[1]);
  }, [filteredRows]);

  const totalSeconds = totals.reduce((sum, [, seconds]) => sum + seconds, 0);
  const topSeconds = Math.max(1, totals[0]?.[1] ?? 1);

  const toggleTracking = async () => {
    if (!isDesktop() || desktopMutationPending.current) return;
    desktopMutationPending.current = true;
    refreshRevision.current++;
    const next = !tracking;
    try {
      await invokeDesktop("set_tracking", { enabled: next });
      setTracking(next);
      setStatus(next ? "Tracking enabled by you." : "Tracking paused.");
    } catch (error) {
      setStatus(`Unable to change tracking: ${String(error)}`);
    } finally {
      desktopMutationPending.current = false;
      refreshRevision.current++;
    }
  };

  const exportCsv = async () => {
    const desktop = isDesktop();
    // An export started before Delete/Pause must not download stale private
    // data after the user changes consent or clears the SQLite database.
    const revision = refreshRevision.current;
    if (desktop && desktopMutationPending.current) return;
    try {
      const csv = desktop
        ? await invokeDesktop<string>("export_csv")
        : ["day,app,seconds", ...rows.map((row) => `${row.day},${csvApp(row.app)},${row.seconds}`)].join("\n") + "\n";
      if (desktop && (revision !== refreshRevision.current || desktopMutationPending.current)) return;
      const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = "activitytracker-activity.csv";
      link.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (error) {
      setStatus(`CSV export failed: ${String(error)}`);
    }
  };

  const importCsv = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file || isDesktop()) return;
    try {
      if (file.size > 10_000_000) throw new Error("CSV exceeds 10 MB.");
      const content = await file.text();
      const parsed = parseCsv(content);
      setRows(parsed);
      try {
        localStorage.setItem(storageKey, content);
        setStatus(`Imported ${parsed.length} rows into this browser only. Use Clear data to erase them.`);
      } catch {
        setStatus(`Imported ${parsed.length} rows for this session. Browser storage is unavailable.`);
      }
    } catch (error) {
      setStatus(`CSV import failed: ${String(error)}`);
    }
  };

  const clearWebData = () => {
    if (isDesktop()) return;
    try { localStorage.removeItem(storageKey); } catch { /* Browser storage may be disabled. */ }
    setRows([]);
    setStatus("Imported browser data cleared.");
  };

  const clearDesktopData = async () => {
    if (!isDesktop() || desktopMutationPending.current || !window.confirm("Permanently delete all local activity records and pause tracking?")) return;
    desktopMutationPending.current = true;
    refreshRevision.current++;
    try {
      await invokeDesktop("clear_data");
      setRows([]);
      setTimeline([]);
      setTracking(false);
      setStatus("All local desktop activity records deleted. Tracking paused.");
    } catch (error) {
      setStatus(`Could not delete local records: ${String(error)}`);
    } finally {
      desktopMutationPending.current = false;
      refreshRevision.current++;
    }
  };

  return (
    <main className="shell">
      <header className="topbar">
        <div>
          <div className="eyebrow">ACTIVITYTRACKER / {mode.toUpperCase()}</div>
          <h1>Your time, without surveillance.</h1>
          <p>Private activity tracking for Windows and macOS, with a reusable web dashboard.</p>
        </div>
        <div className="statusDot"><span />{isDesktop() ? "Desktop collector" : "Web dashboard"}</div>
      </header>

      <section className="metrics">
        <article><span>{period === "today" ? "Tracked today" : period === "week" ? "Tracked this week" : "Tracked total"}</span><strong>{formatDuration(totalSeconds)}</strong><small>{isDesktop() ? "Local SQLite data" : "Imported CSV data"}</small></article>
        <article><span>Active apps</span><strong>{totals.length}</strong><small>No screenshots</small></article>
        <article><span>Top activity</span><strong>{totals[0]?.[0] ?? "—"}</strong><small>{formatDuration(totals[0]?.[1] ?? 0)}</small></article>
      </section>

      <section className="panel focus">
        <div className="panelHead">
          <div>
            <span className="eyebrow">FOCUS SESSION</span>
            <h2>A little uninterrupted time.</h2>
            <p>Optional local countdown. No app blocking, monitoring or new data collection.</p>
          </div>
          <strong className="focusClock" role="timer" aria-label="Time remaining">{formatCountdown(focusSeconds)}</strong>
        </div>
        <div className="focusControls">
          <div className="periodTabs" aria-label="Focus duration">
            {([25, 50] as const).map((minutes) => (
              <button key={minutes} className={focusMinutes === minutes ? "primary" : "secondary"}
                disabled={focusStatus === "running"} onClick={() => resetFocus(minutes)}>{minutes} min</button>
            ))}
          </div>
          <div className="focusActions">
            {focusStatus === "running"
              ? <button className="primary" onClick={pauseFocus}>Pause focus</button>
              : <button className="primary" onClick={startFocus}>{focusStatus === "paused" ? "Resume focus" : "Start focus"}</button>}
            <button className="secondary" onClick={() => resetFocus()}>Reset</button>
          </div>
        </div>
        <small className="focusNote">
          {focusStatus === "complete" ? "Session complete. Start another whenever you like."
            : focusStatus === "paused" ? "Paused. Your remaining time is kept in this open tab."
            : focusStatus === "running" ? "Counting down locally. This does not change activity-tracking consent."
            : "Choose a duration and start when ready. Closing this page ends the timer."}
        </small>
      </section>

      <section className="grid">
        <article className="panel">
          <div className="panelHead">
            <div><span className="eyebrow">ACTIVITY</span><h2>Attention map</h2></div>
            <button className={tracking ? "secondary" : "primary"} onClick={() => void toggleTracking()} disabled={!isDesktop()}>
              {tracking ? "Pause" : "Resume"}
            </button>
          </div>
          <div className="periodTabs" aria-label="Report period">
            {(["today", "week", "all"] as const).map((value) => (
              <button key={value} className={period === value ? "primary" : "secondary"} onClick={() => setPeriod(value)}>
                {value === "today" ? "Today" : value === "week" ? "This week" : "All time"}
              </button>
            ))}
          </div>
          <div className="bars">
            {totals.length === 0 && <p>No recorded activity in this period.</p>}
            {totals.slice(0, 8).map(([app, seconds]) => (
              <div className="barRow" key={app}>
                <div className="barMeta"><span>{app}</span><b>{formatDuration(seconds)}</b></div>
                <div className="barTrack"><div style={{ width: `${Math.max(4, (seconds / topSeconds) * 100)}%` }} /></div>
              </div>
            ))}
          </div>
        </article>

        <aside className="panel privacy">
          <span className="eyebrow">PRIVACY MODEL</span>
          <h2>Local by default.</h2>
          <p>The desktop app records application names and elapsed time in local SQLite only after you press Resume. The web view uses CSV you choose to import, stored in this browser.</p>
          <ul>
            <li>No screenshots</li>
            <li>No keystrokes</li>
            <li>No mandatory account</li>
            <li>No cloud upload in P0</li>
            <li>Foreground time is not the same as active keyboard/mouse time</li>
          </ul>
        </aside>
      </section>

      <section className="panel timeline">
        <div className="panelHead">
          <div><span className="eyebrow">DATA</span><h2>Daily usage records</h2></div>
          <div className="actions">
            {!isDesktop() && <label className="secondary fileButton">Import CSV<input type="file" accept=".csv,text/csv" onChange={(event) => void importCsv(event)} /></label>}
            {!isDesktop() && <button className="secondary" onClick={clearWebData}>Clear data</button>}
            {isDesktop() && <button className="secondary" onClick={() => void clearDesktopData()}>Delete local data</button>}
            <button className="primary" onClick={() => void exportCsv()}>Export CSV</button>
          </div>
        </div>
        <div className="table">
          <div className="tableRow tableHead"><span>Date</span><span>Application</span><span>Duration</span></div>
          {filteredRows.slice(0, 12).map((row, index) => (
            <div className="tableRow" key={`${row.day}-${row.app}-${index}`}>
              <span>{row.day}</span><span>{row.app}</span><span>{formatDuration(row.seconds)}</span>
            </div>
          ))}
          {filteredRows.length === 0 && <p>No records for this period.</p>}
        </div>
      </section>

      {isDesktop() && <section className="panel timeline">
        <div className="panelHead">
          <div><span className="eyebrow">LOCAL SQLITE</span><h2>Recent activity timeline</h2></div>
        </div>
        <p>Approximate 5-second foreground samples. Historical daily totals recorded before this feature cannot be reconstructed as events.</p>
        <div className="table">
          <div className="tableRow tableHead"><span>Started</span><span>Application</span><span>Duration</span></div>
          {timeline.slice(0, 20).map((event, index) => (
            <div className="tableRow" key={`${event.started_at}-${event.app}-${index}`}>
              <span>{new Date(event.started_at).toLocaleString()}</span>
              <span>{event.app}</span>
              <span>{event.seconds}s</span>
            </div>
          ))}
          {timeline.length === 0 && <p>No activity samples yet. Press Resume to start tracking.</p>}
        </div>
      </section>}

      <footer>
        <span>{status}</span>
        {!isDesktop() && <span>Browser pages cannot read operating-system app usage. Import local data or install the desktop app.</span>}
      </footer>
    </main>
  );
}
