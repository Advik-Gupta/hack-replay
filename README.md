# Hack Replay

**Push a local git history to GitHub commit by commit — with the dates, authors and timing you choose.**

You built something locally over days or weeks with a real commit history, never pushed it, and
you don't want it to land on GitHub as one giant "initial commit." Hack Replay shows your history
as a graph, lets you pick the commits you want, and recreates each one on a GitHub repository as a
separate commit.

Your local repository is never modified.

## How it works

1. **REEL** — open the panel on a repo and click the commits you want. Each click cues one.
2. **QUEUE** — set, per commit, what date it carries and when it gets pushed.
3. **SETUP** — choose the target repository and who the commits are authored by.
4. **ON AIR** — Hack Replay pushes them, on schedule, and reports what happened.

## Two independent time settings

These are separate on purpose, so you can push right now but stamp the commit with any date.

| Setting | What it controls | Options |
| --- | --- | --- |
| **Commit timestamp** | the date recorded on the commit | its original date · the moment it's pushed · a date you pick |
| **Push time** | when `git push` actually runs | immediately · a set number of minutes after the previous push · a specific time |

Pushes are spaced by however many minutes you choose, so a long history can arrive gradually
instead of all at once.

## Commit author

Set once on the SETUP tab, applied to every replayed commit:

| Option | Result |
| --- | --- |
| **ORIGINAL** | each commit keeps the name and email it already has locally |
| **ME** | your own git identity (`git config user.name` / `user.email`) |
| **SOMEONE** | any name and email you type |

The author and committer are always the same person, so GitHub shows one name per commit and
never the name of this tool. GitHub links a commit to an account by email address; an address it
doesn't recognise still shows the name, just without an avatar or profile link.

## What each commit state means

The same six words appear in the graph, the queue, the status bar and the log.

| State | Meaning |
| --- | --- |
| `idle` | in your history, not cued |
| `queued` | cued, no push time yet |
| `armed` | waiting on a timer |
| `live` | pushing right now |
| `sent` | on the remote |
| `failed` | the push failed; it can be retried |

## Safety

- **Your repository is never touched.** No branches, rewrites, or working-directory changes.
  Each commit's files are extracted into a temporary folder that is deleted afterwards.
- **Only committed files are pushed.** Uncommitted and gitignored files never travel.
- **No tokens to paste.** GitHub access uses VS Code's built-in sign-in. The token is held in
  memory for a single git command and is never written to disk.
- **Nothing pushes unannounced.** Starting a run names the exact repository, branch, commit count
  and time window first.
- **A failed push stops the run** instead of pushing on regardless. Fix it, then resume.

## Scheduled pushes need VS Code open

Pushes are timed by the extension, not by a background service. The queue is saved continuously,
so reloading the window or restarting VS Code keeps it intact. If a push came due while VS Code
was closed, Hack Replay asks what to do on the next launch rather than pushing on its own. A
status bar item shows how many pushes are waiting.

## Requirements

- git on your `PATH`
- a GitHub account with push access to the target repository
- VS Code 1.85 or newer

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `hackReplay.maxCommits` | `500` | How many commits to read from history. |
| `hackReplay.defaultCommitDateMode` | `now` | Default timestamp for newly cued commits. |
| `hackReplay.authorMode` | `original` | `original`, `self`, or `custom`. |
| `hackReplay.customAuthorName` | — | Author name when the mode is `custom`. |
| `hackReplay.customAuthorEmail` | — | Author email when the mode is `custom`. |
| `hackReplay.defaultStaggerMinutes` | `30` | Minutes between pushes. |
| `hackReplay.keepTempOnFailure` | `true` | Keep the temp folder after a failure for inspection. |
| `hackReplay.targetBranch` | — | Branch to push to. Empty uses the remote's default. |

## Commands

- **Hack Replay: Open** — open the panel
- **Hack Replay: Cancel Scheduled Pushes** — clear everything waiting
- **Hack Replay: Show Queue Status** — reveal the panel from the status bar

## Known limitations

- Merge commits replay as ordinary single-parent commits carrying the merged snapshot.
- A push to a branch that has moved ahead is rejected rather than merged.
- This is not a general git client.

## Development

```bash
npm install
npm run build     # npm run watch to rebuild on save
npm run check     # type check
npm run package   # build a .vsix
```

Press <kbd>F5</kbd> for an Extension Development Host, then run **Hack Replay: Open**.

```
src/
  extension.ts       activation, commands, status bar, missed-push recovery
  types.ts           shared types and the webview message protocol
  git/
    readHistory.ts   git log and per-commit file lists (read-only)
    replayCommit.ts  snapshot extraction, commit, push
    queue.ts         scheduling, persistence, sequential execution
  auth/github.ts     VS Code GitHub session and REST calls
  webview/panel.ts   panel lifecycle and message routing
media/webview/       panel UI (main.ts, styles.css)
```

All git and network work happens in the extension host; the webview only renders and posts
messages. Two constraints worth knowing before editing the UI:

- The webview's content security policy has no `unsafe-inline` for styles, so a `style` attribute
  is dropped. Styles set from script go through `element.style.setProperty`.
- Nothing is inserted with `innerHTML`; commit messages and author names reach the DOM as text
  nodes so they cannot inject markup.

## License

MIT — see [LICENSE.md](LICENSE.md).
