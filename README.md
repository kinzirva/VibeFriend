# VibeFriend

Native macOS application usage tracker inspired by [Weft](https://github.com/tiann/weft).

## MVP
- Local app usage tracking (application names and elapsed time)
- Pause/resume and CSV export
- No screenshots, keystrokes or cloud uploads

Requires macOS 14+ and Swift 6. Run `swift test` and `swift build -c release`.

GitHub Actions produces an **unsigned** DMG for testing. Public distribution requires Developer ID signing and Apple notarization.

Roadmap: window/browser tracking, timeline, focus sessions, weekly review, signed releases.

This is an independent implementation, not a copy of Weft source.
