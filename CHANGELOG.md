# Changelog

## [1.0.2] - 2026-09-18

- Documentation and screenshots for the Marketplace listing.

## [1.0.0] - 2026-09-18

First release.

- **Commit graph** of any local branch, with branch and merge lanes, commit type badges, file
  counts and per-commit file lists.
- **Click to cue.** Selecting a commit adds it to the replay queue; shift-click selects a range.
- **Commit timestamp per commit:** keep the original date, use the time it is pushed, or pick a
  custom date.
- **Push time per commit:** push immediately, a set number of minutes after the previous push, or
  at a specific time. Queue rows can be dragged to reorder.
- **Commit author:** keep each commit's original author, use your own git identity, or enter any
  name and email.
- **Scheduled pushes** that survive a window reload, with a prompt instead of a silent push when
  something came due while VS Code was closed.
- **GitHub sign-in** through VS Code, with a repository picker and repository creation.
- Your local repository is never modified. Commits are replayed from snapshots in a temporary
  folder, and a failed push pauses the run instead of continuing.

[1.0.2]: https://github.com/Advik-Gupta/hack-replay/releases/tag/v1.0.2
[1.0.0]: https://github.com/Advik-Gupta/hack-replay/releases/tag/v1.0.0
