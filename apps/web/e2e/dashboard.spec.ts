import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";

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
  await expect(page.getByRole("button", { name: "Import CSV" })).toHaveCount(0);
  await expect(page.locator(".privacy").getByText("No screenshots")).toBeVisible();
  expect(externalRequests).toEqual([]);
});
