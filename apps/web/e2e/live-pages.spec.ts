// This test opens the PUBLIC GitHub Pages deployment in a real Chromium browser.
// It does not use localhost, a mocked Tauri bridge, or a production-code fixture.
// Unlike asset SHA checks, it verifies the live app's rendered interactions.
import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";

test.skip(!process.env.LIVE_PAGES_URL, "Requires an actual published HTTPS Pages URL");
test.use({ timezoneId: "UTC" });

test("public Pages: real browser CSV round-trip, persistence, deletion and privacy", async ({ page }) => {
  const liveUrl = process.env.LIVE_PAGES_URL!;
  const allowedOrigin = new URL(liveUrl).origin;
  expect(new URL(liveUrl).protocol).toBe("https:");

  const unexpectedRequests: string[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if ((url.protocol === "https:" || url.protocol === "http:") && url.origin !== allowedOrigin) {
      unexpectedRequests.push(request.url());
    }
  });

  const response = await page.goto(liveUrl, { waitUntil: "networkidle" });
  expect(response?.status()).toBe(200);
  await expect(page.getByRole("heading", { name: "Your time, without surveillance." })).toBeVisible();
  await expect(page.getByRole("button", { name: "Resume", exact: true })).toBeDisabled();
  await expect(page.getByText("Browser pages cannot read operating-system app usage.")).toBeVisible();
  expect(await page.evaluate(() => "__TAURI_INTERNALS__" in window)).toBe(false);

  const csv = [
    "day,app,seconds",
    '2026-10-28,"Browser, ""Private""",5',
    "2026-10-27,Editor,15",
    "",
  ].join("\n");
  const picker = page.locator('input[type="file"]');
  await picker.setInputFiles({ name: "sample.csv", mimeType: "text/csv", buffer: Buffer.from(csv) });
  await expect(page.getByText(/Imported 2 rows into this browser only/)).toBeVisible();
  await page.getByRole("button", { name: "All time" }).click();
  await expect(page.locator(".metrics article").nth(1).locator("strong")).toHaveText("2");
  await expect(page.locator(".tableRow").filter({ hasText: 'Browser, "Private"' })).toHaveCount(1);

  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export CSV" }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe("activitytracker-activity.csv");
  const exported = await readFile(await download.path(), "utf8");
  expect(exported).toContain('2026-10-28,"Browser, ""Private""",5');
  expect(exported).toContain('2026-10-27,"Editor",15');

  await page.reload({ waitUntil: "networkidle" });
  await page.getByRole("button", { name: "All time" }).click();
  await expect(page.locator(".metrics article").nth(1).locator("strong")).toHaveText("2");

  await picker.setInputFiles({
    name: "invalid.csv",
    mimeType: "text/csv",
    buffer: Buffer.from("day,app,seconds\n2026-02-30,Editor,5\n"),
  });
  await expect(page.getByText(/CSV import failed:.*Invalid activity/)).toBeVisible();
  await expect(page.locator(".metrics article").nth(1).locator("strong")).toHaveText("2");

  await page.getByRole("button", { name: "Clear data" }).click();
  await expect(page.locator(".metrics article").nth(1).locator("strong")).toHaveText("0");
  expect(await page.evaluate(() => localStorage.getItem("vibefriend-web-import-v1"))).toBeNull();
  await page.reload({ waitUntil: "networkidle" });
  await page.getByRole("button", { name: "All time" }).click();
  await expect(page.locator(".metrics article").nth(1).locator("strong")).toHaveText("0");

  expect(unexpectedRequests).toEqual([]);
  console.log("PASS: PUBLIC Pages Chromium UI + CSV import/export + invalid input + reload + clear + no OS bridge or external requests");
});
