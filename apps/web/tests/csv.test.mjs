import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import ts from "typescript";

// Compile the actual production TypeScript module in-memory. No duplicate parser.
const source = await readFile(new URL("../src/csv.ts", import.meta.url), "utf8");
const js = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.ESNext },
}).outputText;
const { parseCsv, csvApp } = await import(
  "data:text/javascript;base64," + Buffer.from(js).toString("base64")
);

test("CSV parses quoted commas, escaped quotes, embedded newlines and CRLF", () => {
  const rows = parseCsv(
    'day,app,seconds\r\n2026-10-28,"Browser, ""Private""",5\r\n' +
    '2026-10-27,"Editor\nTab",15\r\n'
  );
  assert.deepEqual(rows, [
    { day: "2026-10-28", app: 'Browser, "Private"', seconds: 5 },
    { day: "2026-10-27", app: "Editor\nTab", seconds: 15 },
  ]);
});

test("CSV exports dangerous spreadsheet prefixes as inert text", () => {
  for (const prefix of ["=", "+", "-", "@", "\t", "\r"]) {
    assert.equal(csvApp(prefix + "SUM(A1)"), '"' + "'" + prefix + 'SUM(A1)"');
  }
  assert.equal(csvApp('Browser, "Private"'), '"Browser, ""Private"""');
});

test("CSV export/import roundtrip preserves app names and durations", () => {
  const original = [
    { day: "2026-10-28", app: 'Browser, "Private"', seconds: 5 },
    { day: "2026-10-27", app: "Editor\nTab", seconds: 15 },
  ];
  const csv = ["day,app,seconds", ...original.map(
    (row) => row.day + "," + csvApp(row.app) + "," + row.seconds
  )].join("\n") + "\n";
  assert.deepEqual(parseCsv(csv), original);
});

test("CSV rejects missing or surplus columns", () => {
  for (const row of ["2026-10-28,Browser", "2026-10-28,Browser,5,ignored"]) {
    assert.throws(() => parseCsv("day,app,seconds\n" + row), /column count/i);
  }
});

test("CSV rejects malformed quotations and incorrect headers", () => {
  for (const csv of [
    'day,app,seconds\n2026-10-28,"Browser,5',
    'day,app,seconds\n2026-10-28,"Browser"junk,5',
    'day,app,seconds\n2026-10-28,Br"owser,5',
    'app,day,seconds\nBrowser,2026-10-28,5',
  ]) {
    assert.throws(() => parseCsv(csv));
  }
});

test("CSV rejects impossible dates and non-integer durations", () => {
  for (const row of [
    "2026-02-30,Browser,5",
    "2026-13-01,Browser,5",
    "2026-10-28,Browser,0",
    "2026-10-28,Browser,-1",
    "2026-10-28,Browser,1.5",
    "2026-10-28,Browser,Infinity",
    "2026-10-28,Browser,86401",
    "2026-10-28,,5",
  ]) {
    assert.throws(() => parseCsv("day,app,seconds\n" + row), /Invalid activity/);
  }
});

test("CSV neutralizes leading whitespace before formulas", () => {
  for (const app of [
    " =SUM(A1)",
    "\t =SUM(A1)",
    "\n+SUM(A1)",
    "\u00a0@SUM(A1)",
    "\r-1+2",
  ]) {
    assert.equal(csvApp(app), '"' + "'" + app + '"');
  }
  assert.equal(csvApp("  Editor"), '"  Editor"');
});
