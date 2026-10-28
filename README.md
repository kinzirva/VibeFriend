# VibeFriend

Privacy-first, local-first activity and time tracking for **Windows, macOS and the Web**.

VibeFriend is inspired by [Weft](https://github.com/tiann/weft), but the cross-platform implementation is independently written.

## Product

- Windows + macOS desktop collector
- Shared React dashboard
- Local SQLite storage
- Start/pause tracking
- Daily app usage totals
- CSV import/export
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
- GitHub Pages deployment from `main`
- Automated prerelease installers after verified CI builds on `main`

Preview installers are **unsigned** until Developer ID / Windows code-signing credentials are configured. CI success is not the same as real-device install verification.

## Privacy

P0 stores collected application names and elapsed time in the user's local SQLite database. It does not capture screenshots or keystrokes and does not upload activity data to a VibeFriend server.

See [ATTRIBUTION.md](./ATTRIBUTION.md).
