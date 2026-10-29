import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";

test.use({ timezoneId: "UTC" });

// This is a UI-to-IPC contract test with a deterministic fake Tauri bridge.
// It does NOT replace native Tauri IPC or physical-device validation.
test("desktop dashboard calls consent, timeline, export and delete IPC commands", async ({ page }) => {
  await page.addInitScript(() => {
    const state = {
      tracking: false,
      rows: [{ day: "2026-10-28", app: "Editor", seconds: 5 }],
      events: [{
        started_at: "2026-10-28T12:00:00Z",
        ended_at: "2026-10-28T12:00:05Z",
        app: "Editor",
        seconds: 5,
      }],
      calls: [] as string[],
    };
    Object.defineProperty(window, "__VF_TEST_BRIDGE__", { value: state });
    Object.defineProperty(window, "__TAURI_INTERNALS__", {
      value: {
        invoke: async (command: string, args?: { enabled?: boolean }) => {
          state.calls.push(command);
          switch (command) {
            case "get_tracking": return state.tracking;
            case "get_activity": return [...state.rows];
            case "get_timeline": return [...state.events];
            case "set_tracking":
              state.tracking = args?.enabled === true;
              return null;
            case "export_csv":
              return 'day,app,seconds\n2026-10-28,"Editor",5\n';
            case "clear_data":
              state.tracking = false;
              state.rows = [];
              state.events = [];
              return null;
            default: throw new Error("Unexpected desktop IPC command: " + command);
          }
        },
      },
    });
  });

  await page.goto("/");
  await expect(page.getByText("Desktop collector")).toBeVisible();
  await expect(page.getByText("Tracking paused. Local SQLite data is retained until deleted.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Resume", exact: true })).toBeEnabled();
  await expect(page.getByRole("button", { name: "Import CSV" })).toHaveCount(0);
  await page.getByRole("button", { name: "All time" }).click();
  await expect(page.locator(".metrics article").nth(1).locator("strong")).toHaveText("1");
  await expect(page.locator(".panel.timeline").last().getByText("Editor")).toBeVisible();

  await page.getByRole("button", { name: "Resume", exact: true }).click();
  await expect(page.getByRole("button", { name: "Pause", exact: true })).toBeVisible();
  expect(await page.evaluate(() => Reflect.get(window, "__VF_TEST_BRIDGE__").tracking)).toBe(true);

  await page.getByRole("button", { name: "Pause", exact: true }).click();
  await expect(page.getByRole("button", { name: "Resume", exact: true })).toBeVisible();
  expect(await page.evaluate(() => Reflect.get(window, "__VF_TEST_BRIDGE__").tracking)).toBe(false);

  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export CSV" }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe("activitytracker-activity.csv");
  expect(await readFile(await download.path(), "utf8"))
    .toBe('day,app,seconds\n2026-10-28,"Editor",5\n');

  page.once("dialog", (dialog) => dialog.dismiss());
  await page.getByRole("button", { name: "Delete local data" }).click();
  expect(await page.evaluate(() => Reflect.get(window, "__VF_TEST_BRIDGE__").rows.length)).toBe(1);

  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Delete local data" }).click();
  await expect(page.getByText("All local desktop activity records deleted. Tracking paused.")).toBeVisible();
  await expect(page.locator(".metrics article").nth(1).locator("strong")).toHaveText("0");
  await expect(page.locator(".panel.timeline").last().getByText("No activity samples yet. Press Resume to start tracking.")).toBeVisible();

  const state = await page.evaluate(() => Reflect.get(window, "__VF_TEST_BRIDGE__"));
  expect(state.tracking).toBe(false);
  expect(state.rows).toHaveLength(0);
  expect(state.events).toHaveLength(0);
  expect(state.calls).toEqual(expect.arrayContaining([
    "get_activity", "get_tracking", "get_timeline", "set_tracking", "export_csv", "clear_data",
  ]));
  expect(state.calls.filter((command: string) => command === "clear_data")).toHaveLength(1);
});

test("late desktop poll cannot resurrect data after confirmed deletion", async ({ page }) => {
  await page.addInitScript(() => {
    const state = {
      tracking: false,
      rows: [{ day: "2026-10-28", app: "Private editor", seconds: 5 }],
      events: [{ started_at: "2026-10-28T12:00:00Z", ended_at: "2026-10-28T12:00:05Z", app: "Private editor", seconds: 5 }],
      firstRead: true,
      resolveFirstRead: null as null | (() => void),
    };
    Object.defineProperty(window, "__VF_TEST_BRIDGE__", { value: state });
    Object.defineProperty(window, "__TAURI_INTERNALS__", {
      value: {
        invoke: async (command: string) => {
          switch (command) {
            case "get_activity":
              if (state.firstRead) {
                state.firstRead = false;
                const snapshot = [...state.rows];
                return new Promise((resolve) => { state.resolveFirstRead = () => resolve(snapshot); });
              }
              return [...state.rows];
            case "get_tracking": return state.tracking;
            case "get_timeline": return [...state.events];
            case "clear_data":
              state.tracking = false;
              state.rows = [];
              state.events = [];
              return null;
            default: throw new Error("Unexpected desktop IPC command: " + command);
          }
        },
      },
    });
  });

  await page.goto("/");
  await expect.poll(() => page.evaluate(() => Boolean(Reflect.get(window, "__VF_TEST_BRIDGE__").resolveFirstRead))).toBe(true);
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Delete local data" }).click();
  await expect(page.getByText("All local desktop activity records deleted. Tracking paused.")).toBeVisible();

  // The earlier IPC query returns a snapshot taken BEFORE deletion.
  await page.evaluate(() => Reflect.get(window, "__VF_TEST_BRIDGE__").resolveFirstRead());
  await page.waitForTimeout(50);
  await expect(page.getByText("All local desktop activity records deleted. Tracking paused.")).toBeVisible();
  await expect(page.locator(".metrics article").nth(1).locator("strong")).toHaveText("0");
  await expect(page.locator(".panel.timeline").last().getByText("Private editor")).toHaveCount(0);
});


test("late desktop CSV export cannot download private rows after deletion", async ({ page }) => {
  await page.addInitScript(() => {
    const state = {
      tracking: false,
      rows: [{ day: "2026-10-28", app: "Private editor", seconds: 5 }],
      events: [],
      resolveExport: null as null | (() => void),
    };
    Object.defineProperty(window, "__VF_TEST_BRIDGE__", { value: state });
    Object.defineProperty(window, "__TAURI_INTERNALS__", {
      value: {
        invoke: async (command: string) => {
          switch (command) {
            case "get_activity": return [...state.rows];
            case "get_tracking": return state.tracking;
            case "get_timeline": return [...state.events];
            case "export_csv": {
              // Simulate a backend response prepared before deletion, but
              // delivered only after clear_data has finished.
              const staleCsv = 'day,app,seconds\n2026-10-28,"Private editor",5\n';
              return new Promise((resolve) => {
                state.resolveExport = () => resolve(staleCsv);
              });
            }
            case "clear_data":
              state.rows = [];
              state.events = [];
              state.tracking = false;
              return null;
            default: throw new Error("Unexpected desktop IPC command: " + command);
          }
        },
      },
    });
  });

  await page.goto("/");
  await expect(page.getByText("Tracking paused. Local SQLite data is retained until deleted.")).toBeVisible();
  const downloads: string[] = [];
  page.on("download", (download) => downloads.push(download.suggestedFilename()));
  await page.getByRole("button", { name: "Export CSV" }).click();
  await expect.poll(() => page.evaluate(() =>
    Boolean(Reflect.get(window, "__VF_TEST_BRIDGE__").resolveExport)
  )).toBe(true);

  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Delete local data" }).click();
  await expect(page.getByText("All local desktop activity records deleted. Tracking paused.")).toBeVisible();

  await page.evaluate(() => Reflect.get(window, "__VF_TEST_BRIDGE__").resolveExport());
  await page.waitForTimeout(100);
  expect(downloads).toEqual([]);
  await expect(page.locator(".metrics article").nth(1).locator("strong")).toHaveText("0");
});
