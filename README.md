# VibeFriend

Privacy-first, local-first activity and time tracking for **Windows, macOS and the Web**.

VibeFriend is inspired by [Weft](https://github.com/tiann/weft), but the cross-platform implementation is independently written.

## Product

- Windows + macOS desktop collector
- Shared React dashboard
- Local SQLite storage
- Opt-in start/pause tracking (off by default each time the desktop app starts)
- Today, current-week and all-time app usage summaries
- CSV export on desktop; CSV import/export in the browser dashboard
- No screenshots, keystrokes or mandatory cloud account
- Chrome/Edge site tracking planned after the P0 desktop + web release

## Architecture

- `apps/web` — React + TypeScript + Vite dashboard; also deployed as the public web UI.
- `apps/desktop` — Tauri 2 desktop shell.
- `apps/desktop/src-tauri` — Rust collector, SQLite store and desktop commands.
- Legacy Swift prototype remains in the repository while cross-platform replacement is validated.

## Development

Requires Node.js 20+, Rust stable, and the platform prerequisites for Tauri 2.

```bash
npm install
npm run typecheck
npm run build:web
npm run icon --workspace @vibefriend/desktop
npm run tauri --workspace @vibefriend/desktop -- build
```

Rust tests:

```bash
cd apps/desktop/src-tauri
cargo test
```

## Distribution

GitHub Actions builds:

- Windows NSIS installer
- macOS DMG
- Web dashboard artifact
- GitHub Pages deployment from `main` (requires Pages to be enabled with **GitHub Actions** as its source in repository Settings → Pages)
- Automated prerelease installers after verified CI builds on `main`

Preview installers are **unsigned** until Developer ID / Windows code-signing credentials are configured. CI success is not the same as real-device install verification.

## Privacy and accuracy

Desktop tracking starts **disabled** and only collects after the user presses Resume. Activity is stored in the local SQLite database, not uploaded to a VibeFriend server. The app does not capture screenshots, keystrokes, document contents, window titles or browser URLs. The browser dashboard cannot access OS-level activity; it displays only CSV data the user imports and stores that import in the current browser's local storage until cleared. Desktop CSV import is not supported yet.

Foreground app sampling is an approximation of elapsed time, not proof of active keyboard/mouse use. A background or idle session may be counted if an application stays foreground. This is a known P0 accuracy gap pending OS-specific idle detection, and the current daily records are **aggregates, not a chronological event timeline**. Tracking consent resets to off on each desktop launch.

## Release acceptance

- CI builds Windows NSIS and macOS DMG, but CI does not verify installer launch on real devices.
- Unsigned installers may trigger Windows SmartScreen or macOS Gatekeeper warnings. Apple Developer ID signing/notarization and Windows code signing require authorized credentials.
- Enable GitHub Pages manually in repository Settings → Pages, choose **GitHub Actions**, then rerun the Web dashboard workflow. The GitHub Actions token cannot necessarily create a Pages site.
- Real-device installation, foreground collector accuracy, pause/resume, CSV export, and privacy verification are required before declaring P0 complete.

See [ATTRIBUTION.md](./ATTRIBUTION.md).
