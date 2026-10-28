import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";

test.use({ timezoneId: "UTC" });

const sample = [
  "day,app,seconds",
  '2026-10-28,"Browser, ""Private""",5',
  "2026-10-27,Editor,15",
  "",
].join("\n");

test("browser-only dashboard imports, persists, exports and clears local CSV", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Your time, without surveillance." })).toBeVisible();
  await expect(page.getByRole("button", { name: "Resume", exact: true })).toBeDisabled();
  await expect(page.getByText("Browser pages cannot read operating-system app usage.")).toBeVisible();

  await page.locator('input[type="file"]').setInputFiles({
    name: "activity.csv",
    mimeType: "text/csv",
    buffer: Buffer.from(sample),
  });
  await expect(page.getByText(/Imported 2 rows into this browser only/)).toBeVisible();
  await page.getByRole("button", { name: "All time" }).click();
  await expect(page.locator(".metrics article").nth(1).locator("strong")).toHaveText("2");
  await expect(page.locator(".tableRow").filter({ hasText: 'Browser, "Private"' })).toHaveCount(1);

  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export CSV" }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe("vibefriend-activity.csv");
  const content = await readFile(await download.path(), "utf8");
  expect(content).toContain('2026-10-28,"Browser, ""Private""",5');
  expect(content).toContain("2026-10-27,\"Editor\",15");

  await page.reload();
  await page.getByRole("button", { name: "All time" }).click();
  await expect(page.locator(".metrics article").nth(1).locator("strong")).toHaveText("2");
  await page.getByRole("button", { name: "Clear data" }).click();
  await expect(page.locator(".metrics article").nth(1).locator("strong")).toHaveText("0");
  expect(await page.evaluate(() => localStorage.getItem("vibefriend-web-import-v1"))).toBeNull();
});

test("invalid CSV is rejected without replacing previously imported data", async ({ page }) => {
  await page.goto("/");
  const picker = page.locator('input[type="file"]');
  await picker.setInputFiles({ name: "good.csv", mimeType: "text/csv", buffer: Buffer.from(sample) });
  await expect(page.getByText(/Imported 2 rows/)).toBeVisible();
  await picker.setInputFiles({
    name: "invalid.csv",
    mimeType: "text/csv",
    buffer: Buffer.from("day,app,seconds\n2026-02-30,Editor,5\n"),
  });
  await expect(page.getByText(/CSV import failed:.*Invalid activity/)).toBeVisible();
  await page.getByRole("button", { name: "All time" }).click();
  await expect(page.locator(".metrics article").nth(1).locator("strong")).toHaveText("2");
});

test("web mode does not invoke desktop APIs or send activity to remote services", async ({ page }) => {
  const externalRequests: string[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (!["127.0.0.1", "localhost"].includes(url.hostname)) externalRequests.push(url.href);
  });
  await page.goto("/");
  expect(await page.evaluate(() => "__TAURI_INTERNALS__" in window)).toBe(false);
  await expect(page.getByRole("button", { name: "Resume", exact: true })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Import CSV" })).toBeVisible();
  await expect(page.locator(".privacy").getByText("No screenshots")).toBeVisible();
  expect(externalRequests).toEqual([]);
});

test("today/week/all reports respect Monday boundary and exclude future days", async ({ page }) => {
  await page.clock.setFixedTime(new Date("2026-10-28T12:00:00Z"));
  await page.goto("/");
  const report = [
    "day,app,seconds",
    "2026-10-25,PreviousWeek,5",
    "2026-10-26,Monday,10",
    "2026-10-28,Today,15",
    "2026-10-29,Future,20",
    "",
  ].join("\n");
  await page.locator('input[type="file"]').setInputFiles({
    name: "boundary.csv",
    mimeType: "text/csv",
    buffer: Buffer.from(report),
  });
  const activeApps = page.locator(".metrics article").nth(1).locator("strong");
  await expect(activeApps).toHaveText("1");
  await page.getByRole("button", { name: "This week" }).click();
  await expect(activeApps).toHaveText("2");
  await expect(page.locator(".tableRow").filter({ hasText: "PreviousWeek" })).toHaveCount(0);
  await expect(page.locator(".tableRow").filter({ hasText: "Future" })).toHaveCount(0);
  await page.getByRole("button", { name: "All time" }).click();
  await expect(activeApps).toHaveText("4");
});

test("focus countdown start, pause, resume and reset never enables tracking", async ({ page }) => {
  await page.clock.install({ time: new Date("2026-10-28T12:00:00Z") });
  await page.goto("/");
  await expect(page.getByRole("timer", { name: "Time remaining" })).toHaveText("25:00");
  await page.getByRole("button", { name: "Start focus" }).click();
  await expect(page.getByRole("button", { name: "Pause focus" })).toBeVisible();
  await page.clock.fastForward(10_000);
  await expect(page.getByRole("timer", { name: "Time remaining" })).toHaveText("24:50");
  await page.getByRole("button", { name: "Pause focus" }).click();
  await expect(page.getByRole("button", { name: "Resume focus" })).toBeVisible();
  await page.clock.fastForward(10_000);
  await expect(page.getByRole("timer", { name: "Time remaining" })).toHaveText("24:50");
  await page.getByRole("button", { name: "Resume focus" }).click();
  await expect(page.getByRole("button", { name: "Pause focus" })).toBeVisible();
  await page.getByRole("button", { name: "Reset", exact: true }).click();
  await expect(page.getByRole("timer", { name: "Time remaining" })).toHaveText("25:00");
  await page.getByRole("button", { name: "50 min" }).click();
  await expect(page.getByRole("timer", { name: "Time remaining" })).toHaveText("50:00");
  await expect(page.getByRole("button", { name: "Resume", exact: true })).toBeDisabled();
});

test("dashboard updates Today and This week after midnight without a reload", async ({ page }) => {
  await page.clock.install({ time: new Date("2026-11-01T23:59:30Z") });
  await page.goto("/");
  const report = [
    "day,app,seconds",
    "2026-11-01,SundayApp,120",
    "2026-11-02,MondayApp,180",
    "",
  ].join("\n");
  await page.locator('input[type="file"]').setInputFiles({
    name: "rollover.csv",
    mimeType: "text/csv",
    buffer: Buffer.from(report),
  });
  await expect(page.getByText(/Imported 2 rows/)).toBeVisible();

  await page.getByRole("button", { name: "This week" }).click();
  await expect(page.locator(".barRow").getByText("SundayApp")).toBeVisible();
  await expect(page.locator(".barRow").getByText("MondayApp")).toHaveCount(0);

  // Cross the Sunday -> Monday boundary while leaving the page open.
  await page.clock.fastForward(60_000);
  await expect(page.locator(".barRow").getByText("MondayApp")).toBeVisible();
  await expect(page.locator(".barRow").getByText("SundayApp")).toHaveCount(0);

  await page.getByRole("button", { name: "Today" }).click();
  await expect(page.locator(".barRow").getByText("MondayApp")).toBeVisible();
  await expect(page.locator(".barRow").getByText("SundayApp")).toHaveCount(0);
});
