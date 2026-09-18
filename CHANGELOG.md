# Changelog

All notable changes to Hack Replay are documented here.
This project follows [Semantic Versioning](https://semver.org/).

## [1.0.0] - 2026-09-18

First public release.

### Added

- Commit graph of any local branch, with lanes, merge connectors, conventional-commit type
  badges and per-commit file counts.
- Selection-driven queue: clicking a commit cues it, shift-click extends a range.
- Per-commit control of the commit timestamp (original / now / custom) and the push time
  (immediately / after the previous push / at a set time), as two independent settings.
- **Commit author** choice: keep each commit's original author, use your own git identity, or
  enter any name and email.
- Drag-to-reorder queue, stagger action, pause, cancel and per-commit retry.
- Scheduled pushes with a persisted queue that survives a window reload, and a prompt rather
  than a silent push when something came due while VS Code was closed.
- Status bar indicator while pushes are armed or live.
- GitHub sign-in through VS Code's built-in authentication, with repository picker and
  repository creation.

### Notes

- Merge commits replay as single-parent commits carrying the merged snapshot.
- Your local repository is never modified; snapshots are extracted into a temporary directory.
