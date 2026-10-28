export type ActivityRow = {
  day: string;
  app: string;
  seconds: number;
};

export function csvApp(value: string): string {
  const safe = /^[=+\-@\t\r]/.test(value) ? "'" + value : value;
  return '"' + safe.replace(/"/g, '""') + '"';
}

export function parseCsv(text: string): ActivityRow[] {
  const records: string[][] = [];
  let record: string[] = [];
  let field = "";
  let quoted = false;
  let closedQuote = false;

  const pushField = () => {
    record.push(field);
    field = "";
    closedQuote = false;
  };
  const pushRecord = () => {
    pushField();
    if (record.some((value) => value !== "")) records.push(record);
    record = [];
  };

  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (quoted) {
      if (char === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (char === '"') {
        quoted = false;
        closedQuote = true;
      } else {
        field += char;
      }
    } else if (char === "," || char === "\n" || char === "\r") {
      if (char === ",") {
        pushField();
      } else {
        if (char === "\r" && text[i + 1] === "\n") i++;
        pushRecord();
      }
    } else if (closedQuote) {
      throw new Error("Unexpected text after closing CSV quote.");
    } else if (char === '"') {
      if (field !== "") throw new Error("Invalid CSV quotation.");
      quoted = true;
    } else {
      field += char;
    }
  }
  if (quoted) throw new Error("Unclosed CSV quotation.");
  if (field !== "" || record.length > 0 || closedQuote) pushRecord();

  const header = records.shift()?.map((value) => value.trim().toLowerCase());
  if (header?.join(",") !== "day,app,seconds") {
    throw new Error("CSV columns must be day,app,seconds.");
  }
  if (records.length > 100000) throw new Error("CSV contains too many records.");

  return records.map((columns, index) => {
    if (columns.length !== 3) throw new Error("Invalid column count at CSV row " + (index + 2) + ".");
    const [day, app, rawSeconds] = columns;
    const date = /^\d{4}-\d{2}-\d{2}$/.test(day) ? new Date(day + "T00:00:00Z") : new Date(NaN);
    const seconds = Number(rawSeconds);
    if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== day ||
        !app.trim() || !/^\d+$/.test(rawSeconds) ||
        !Number.isSafeInteger(seconds) || seconds <= 0 || seconds > 86400) {
      throw new Error("Invalid activity at CSV row " + (index + 2) + ".");
    }
    return { day, app, seconds };
  });
}
