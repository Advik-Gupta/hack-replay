# Changelog

All notable changes to **Hack Replay** are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Versions below 1.0.0 were internal development builds and were never published to the Marketplace.
They are recorded here because they explain how the current behaviour came about.

## [1.0.0] - 2026-09-18

First public release.

### Added

- **Choice of commit author.** A COMMIT AUTHOR card on the SETUP tab with three modes:
  - `ORIGINAL` - every commit keeps the author name and email it already has locally.
  - `ME` - every commit is authored by your own git identity (`git config user.name` / `user.email`).
  - `SOMEONE` - every commit is authored by a name and email you enter.

  The custom mode validates that both a name and a well-formed email are present. An incomplete
  entry is flagged inline, blocks the ON AIR button, and is refused by the replay engine, so a run
  cannot start and then fail partway through. A preview line shows exactly how commits will appear
  on GitHub, and a chip on the REEL tab's MISSION card keeps the choice visible while you work.

- New settings: `hackReplay.authorMode`, `hackReplay.customAuthorName`, `hackReplay.customAuthorEmail`.
- Marketplace packaging: extension icon, gallery banner, keywords, categories, changelog, license,
  and `capabilities` declaring that the extension requires a trusted, non-virtual workspace because
  it runs git against files on disk.
- The panel header now shows the installed extension version.

### Changed

- The whole codebase was cleaned up for release: comments removed, empty blocks tidied, and the
  build split so `npm run package` type-checks before producing a minified bundle. The published
  package contains no source, source maps or build configuration (11 files, ~65 KB).
- `hackReplay.preserveAuthor` (boolean) was **replaced** by `hackReplay.authorMode` (enum). If you
  used a pre-release build, set the author mode again on the SETUP tab.
- The persisted queue key moved to `hackReplay.run.v3`. Any queue from a pre-release build is
  discarded rather than misread; already-pushed commits on the remote are unaffected.
- README rewritten as full product documentation: quick start, concept guide, tab reference,
  scheduling behaviour, authorship and GitHub attribution, troubleshooting and FAQ.

### Fixed

- Replayed commits kept only the first line of a commit message. The complete original message,
  including its body and blank lines, is now preserved.

## [0.2.1] - 2026-09-17

### Fixed

- **Inline styles were silently dropped inside VS Code.** The webview's content security policy has
  no `unsafe-inline` for styles, so every `style` attribute written into markup was ignored. This
  blanked the timestamp toggle's selection highlight, the coloured queue-state tiles, the status
  legend swatches, the connection indicator, and the commit graph's lane column. Styles set from
  script now go through `element.style.setProperty`, which the policy allows. The local preview used
  for design review now enforces the same policy so this class of bug can't reappear unnoticed.
- **"Hack Replay" appeared as a co-author on GitHub.** Replayed commits set the author to the
  original author but left the committer as a placeholder identity, and GitHub displays both names
  when they differ. Author and committer are now always the same person.
- The selected option in a three-way toggle is now unmistakable: coloured fill, bold label, a filled
  marker, and dimmed alternatives.

### Changed

- The default commit timestamp is now **`now`** rather than `original`, so replayed commits are
  dated when they're pushed unless you ask otherwise.

## [0.2.0] - 2026-09-17

### Added

- **Complete visual redesign** as a handheld broadcast console: blue device frame, yellow control
  strip, cream screens, heavy outlines and hard offset shadows, with pixel display type for chrome
  and a grotesk for commit text.
- **Four tabs** replacing the single cramped view: REEL (commit graph), QUEUE (per-commit timing),
  SETUP (target, defaults, help) and LOG (what was pushed).
- Conventional-commit type badges (`FEAT`, `FIX`, `REFACTOR`, …) derived from commit messages.
- Per-commit file lists on demand, with added and removed line counts.
- Search and per-state filter chips on the REEL tab.
- Drag-to-reorder queue cards, an XP-style progress meter, and a status lamp that tracks the run.
- In-panel confirmation dialog naming the exact target, commit count and push window before a run.

### Changed

- **Selection is now the queue.** Clicking a commit cues it immediately; there is no separate "add
  to queue" step.
- The status vocabulary became `queued` / `armed` / `live` / `sent` / `failed`, used identically in
  the graph, the queue, the status bar and the log.
- **A failed push now pauses the rest of the run** instead of continuing, so a broken commit can't
  be buried under later ones. Resuming is an explicit action.

### Fixed

- **Reordering the queue could collapse the gaps between pushes.** The first row was being rewritten
  to "push immediately", so after a drag two commits could hold that setting and fire at once. The
  leading row is now anchored when push times are calculated, leaving each row's own setting intact.

## [0.1.0] - 2026-09-16

Initial working implementation.

### Added

- Commit graph of any local branch, read with `git log` into structured commits.
- Snapshot-based replay: a detached `git worktree` (falling back to `git archive`) materialises each
  commit's full file tree, which is committed and pushed through a temporary clone of the target.
- Decoupled commit timestamp and push time, with original / now / custom dates.
- A persisted scheduler with per-commit timers, chained across the ~24-day `setTimeout` ceiling, that
  re-arms after a window reload and prompts rather than firing pushes that came due while VS Code
  was closed.
- GitHub sign-in through VS Code's built-in authentication, with repository listing and creation.
  Tokens are held in memory and never written to disk.
- Status bar indicator while pushes are pending.

### Fixed

- **Every commit failed with "Use of GIT_EDITOR is not permitted".** Child git processes inherited
  the editor environment variables. They're now stripped, and terminal prompts are disabled so a bad
  credential fails fast instead of hanging a scheduled push on an invisible prompt.

[1.0.0]: https://github.com/hack-replay/hack-replay/releases/tag/v1.0.0
