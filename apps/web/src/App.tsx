import { ChangeEvent, useEffect, useMemo, useState } from "react";

type ActivityRow = {
  day: string;
  app: string;
  seconds: number;
};

const demoRows: ActivityRow[] = [
  { day: new Date().toISOString().slice(0, 10), app: "VS Code", seconds: 7260 },
  { day: new Date().toISOString().slice(0, 10), app: "Chrome", seconds: 4320 },
  { day: new Date().toISOString().slice(0, 10), app: "Slack", seconds: 1860 },
  { day: new Date().toISOString().slice(0, 10), app: "Terminal", seconds: 1440 }
];

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

function parseCsv(text: string): ActivityRow[] {
  return text
    .trim()
    .split(/\r?\n/)
    .slice(1)
    .map((line) => {
      const [day, app, seconds] = line.split(",");
      return { day: day?.trim() || "", app: app?.replace(/^"|"$/g, "").trim() || "Unknown", seconds: Number(seconds) || 0 };
    })
    .filter((row) => row.day && row.app);
}

export default function App() {
  const [rows, setRows] = useState<ActivityRow[]>(demoRows);
  const [tracking, setTracking] = useState(true);
  const [mode, setMode] = useState<"desktop" | "web">(isDesktop() ? "desktop" : "web");
  const [status, setStatus] = useState("Local-first. Nothing is uploaded.");

  const refresh = async () => {
    if (!isDesktop()) return;
    try {
      const latest = await invokeDesktop<ActivityRow[]>("get_activity");
      setRows(latest);
      setMode("desktop");
      setStatus("Live desktop data from the local SQLite database.");
    } catch (error) {
      setStatus(`Desktop bridge unavailable: ${String(error)}`);
    }
  };

  useEffect(() => {
    void refresh();
    if (!isDesktop()) return;
    const timer = window.setInterval(() => void refresh(), 5000);
    return () => window.clearInterval(timer);
  }, []);

  const totals = useMemo(() => {
    const byApp = new Map<string, number>();
    for (const row of rows) byApp.set(row.app, (byApp.get(row.app) ?? 0) + row.seconds);
    return [...byApp.entries()].sort((a, b) => b[1] - a[1]);
  }, [rows]);

  const totalSeconds = totals.reduce((sum, [, seconds]) => sum + seconds, 0);
  const topSeconds = Math.max(1, totals[0]?.[1] ?? 1);

  const toggleTracking = async () => {
    const next = !tracking;
    setTracking(next);
    if (isDesktop()) {
      await invokeDesktop("set_tracking", { enabled: next });
      setStatus(next ? "Tracking resumed." : "Tracking paused.");
    }
  };

  const exportCsv = async () => {
    let csv: string;
    if (isDesktop()) {
      csv = await invokeDesktop<string>("export_csv");
    } else {
      csv = ["day,app,seconds", ...rows.map((row) => `${row.day},"${row.app.replace(/\"/g, '\"\"')}",${row.seconds}`)].join("\n");
    }
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "vibefriend-activity.csv";
    link.click();
    URL.revokeObjectURL(url);
  };

  const importCsv = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    const parsed = parseCsv(await file.text());
    setRows(parsed);
    setMode("web");
    setStatus(`Loaded ${parsed.length} local rows from ${file.name}.`);
  };

  return (
    <main className="shell">
      <header className="topbar">
        <div>
          <div className="eyebrow">VIBEFRIEND / {mode.toUpperCase()}</div>
          <h1>Your time, without surveillance.</h1>
          <p>Private activity tracking for Windows and macOS, with a reusable web dashboard.</p>
        </div>
        <div className="statusDot"><span />{isDesktop() ? "Desktop collector" : "Web dashboard"}</div>
      </header>

      <section className="metrics">
        <article><span>Tracked today</span><strong>{formatDuration(totalSeconds)}</strong><small>Local device data</small></article>
        <article><span>Active apps</span><strong>{totals.length}</strong><small>No screenshots</small></article>
        <article><span>Top activity</span><strong>{totals[0]?.[0] ?? "—"}</strong><small>{formatDuration(totals[0]?.[1] ?? 0)}</small></article>
      </section>

      <section className="grid">
        <article className="panel">
          <div className="panelHead">
            <div><span className="eyebrow">TODAY</span><h2>Attention map</h2></div>
            <button className={tracking ? "secondary" : "primary"} onClick={() => void toggleTracking()} disabled={!isDesktop()}>
              {tracking ? "Pause" : "Resume"}
            </button>
          </div>
          <div className="bars">
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
          <p>VibeFriend stores activity in SQLite on your device. The collector records application names and elapsed time only.</p>
          <ul>
            <li>No screenshots</li>
            <li>No keystrokes</li>
            <li>No mandatory account</li>
            <li>No cloud upload in P0</li>
          </ul>
        </aside>
      </section>

      <section className="panel timeline">
        <div className="panelHead">
          <div><span className="eyebrow">DATA</span><h2>Activity timeline</h2></div>
          <div className="actions">
            <label className="secondary fileButton">Import CSV<input type="file" accept=".csv,text/csv" onChange={(event) => void importCsv(event)} /></label>
            <button className="primary" onClick={() => void exportCsv()}>Export CSV</button>
          </div>
        </div>
        <div className="table">
          <div className="tableRow tableHead"><span>Date</span><span>Application</span><span>Duration</span></div>
          {rows.slice(0, 12).map((row, index) => (
            <div className="tableRow" key={`${row.day}-${row.app}-${index}`}>
              <span>{row.day}</span><span>{row.app}</span><span>{formatDuration(row.seconds)}</span>
            </div>
          ))}
        </div>
      </section>

      <footer>
        <span>{status}</span>
        {!isDesktop() && <span>Browser pages cannot read operating-system app usage. Import local data or install the desktop app.</span>}
      </footer>
    </main>
  );
}
