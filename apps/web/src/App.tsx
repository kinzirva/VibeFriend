import { ChangeEvent, useEffect, useMemo, useState } from "react";

type ActivityRow = {
  day: string;
  app: string;
  seconds: number;
};

const storageKey = "vibefriend-web-import-v1";

function localDay(date: Date) {
  return [date.getFullYear(), String(date.getMonth() + 1).padStart(2, "0"), String(date.getDate()).padStart(2, "0")].join("-");
}

function csvApp(value: string) {
  const safe = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return `"${safe.replace(/"/g, '""')}"`;
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

function parseCsv(text: string): ActivityRow[] {
  const records: string[][] = [];
  let record: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (char === '"') {
      if (quoted && text[i + 1] === '"') { field += '"'; i++; }
      else if (quoted) quoted = false;
      else if (field === "") quoted = true;
      else throw new Error("Invalid CSV quotation.");
    } else if (char === "," && !quoted) {
      record.push(field); field = "";
    } else if ((char === "\n" || char === "\r") && !quoted) {
      if (char === "\r" && text[i + 1] === "\n") i++;
      record.push(field);
      if (record.some((value) => value !== "")) records.push(record);
      record = []; field = "";
    } else {
      field += char;
    }
  }
  if (quoted) throw new Error("Unclosed CSV quotation.");
  if (field || record.length) { record.push(field); records.push(record); }
  const header = records.shift()?.map((value) => value.trim().toLowerCase());
  if (header?.join(",") !== "day,app,seconds") throw new Error("CSV columns must be day,app,seconds.");
  if (records.length > 100000) throw new Error("CSV contains too many records.");
  return records.map(([day, app, rawSeconds], index) => {
    const seconds = Number(rawSeconds);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day ?? "") || !app?.trim() ||
        !Number.isFinite(seconds) || seconds <= 0 || seconds > 86400) {
      throw new Error(`Invalid activity at CSV row ${index + 2}.`);
    }
    return { day, app, seconds };
  });
}

export default function App() {
  const [rows, setRows] = useState<ActivityRow[]>(() => {
    if (isDesktop()) return [];
    try {
      const saved = localStorage.getItem(storageKey);
      return saved ? parseCsv(saved) : [];
    } catch { return []; }
  });
  const [tracking, setTracking] = useState(false);
  const [period, setPeriod] = useState<"today" | "week" | "all">("today");
  const [mode, setMode] = useState<"desktop" | "web">(isDesktop() ? "desktop" : "web");
  const [status, setStatus] = useState("Tracking is off until you explicitly start it. Data stays local.");

  const refresh = async () => {
    if (!isDesktop()) return;
    try {
      const [latest, enabled] = await Promise.all([
        invokeDesktop<ActivityRow[]>("get_activity"),
        invokeDesktop<boolean>("get_tracking")
      ]);
      setRows(latest);
      setTracking(enabled);
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

  const today = localDay(new Date());
  const monday = new Date();
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
    if (!isDesktop()) return;
    const next = !tracking;
    try {
      await invokeDesktop("set_tracking", { enabled: next });
      setTracking(next);
      setStatus(next ? "Tracking enabled by you." : "Tracking paused.");
    } catch (error) {
      setStatus(`Unable to change tracking: ${String(error)}`);
    }
  };

  const exportCsv = async () => {
    try {
      const csv = isDesktop()
        ? await invokeDesktop<string>("export_csv")
        : ["day,app,seconds", ...rows.map((row) => `${row.day},${csvApp(row.app)},${row.seconds}`)].join("\n") + "\n";
      const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = "vibefriend-activity.csv";
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
    localStorage.removeItem(storageKey);
    setRows([]);
    setStatus("Imported browser data cleared.");
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
        <article><span>{period === "today" ? "Tracked today" : period === "week" ? "Tracked this week" : "Tracked total"}</span><strong>{formatDuration(totalSeconds)}</strong><small>{isDesktop() ? "Local SQLite data" : "Imported CSV data"}</small></article>
        <article><span>Active apps</span><strong>{totals.length}</strong><small>No screenshots</small></article>
        <article><span>Top activity</span><strong>{totals[0]?.[0] ?? "—"}</strong><small>{formatDuration(totals[0]?.[1] ?? 0)}</small></article>
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

      <footer>
        <span>{status}</span>
        {!isDesktop() && <span>Browser pages cannot read operating-system app usage. Import local data or install the desktop app.</span>}
      </footer>
    </main>
  );
}
