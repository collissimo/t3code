# Fork: collissimo/t3code

Personal fork of [pingdotgg/t3code](https://github.com/pingdotgg/t3code). Upstream is
(mostly) not accepting contributions, so changes live here long-term.

## Branches

- `main`: pristine mirror of `upstream/main`. Never commit here; fast-forward only.
- `collin/main`: `main` + own changes. Work branches start here, PRs target here.
- Nightly builds are just `v*-nightly.*` tags on upstream `main`, not a separate repo.

## Remotes

- `origin` = `collissimo/t3code` (push here)
- `upstream` = `pingdotgg/t3code` (fetch only, push URL set to `DISABLED`)
- `gh repo set-default collissimo/t3code` is set, so `gh pr create` targets the fork.
  New clones must run it again, otherwise PRs default to pingdotgg.

## Sync with upstream

`sh fork/sync.sh` (from any checkout). It fast-forwards `main` to `upstream/main`, merges
`upstream/main` into `collin/main` without touching a working tree, pushes both, then
fast-forwards the local `collin/main` checkout if it is clean. Exit 1 = merge conflict, nothing
pushed; resolve by hand in a clean `collin/main` checkout:

```sh
git fetch upstream --tags
git merge upstream/main     # resolve conflicts, run checks
git push origin collin/main
```

A daily T3 scheduled task runs the script and handles conflicts.

To sync only up to a nightly instead of upstream tip, merge the tag:
`git merge v0.1.1-nightly.YYYYMMDD.NNNN`.

Merge, not rebase: history stays stable, no force-push needed.

`fork/pre-push` blocks any push to `main` that is not exactly `upstream/main`. Hooks are not
versioned; install per clone: `cp fork/pre-push "$(git rev-parse --git-common-dir)/hooks/pre-push"`.

## Keeping changes mergeable

- Prefer additive changes: new files, new modules, settings/flags. Avoid editing
  hot upstream files (AGENTS.md, shared configs) when a separate file works.
- Keep edits to existing upstream files small and isolated.
- Sync often; small merges are easier than large ones.

## Fork features

### Dictation

Mic button in the composer (next to "Attach files"), **F9** to start and stop, **F8** (or
shift-click, or ending with the word "Reinschrift") to get a structured prompt, **Esc** to
cancel a recording or to insert the plain transcript while it is being rewritten. Both keys
can be rebound in Settings → Keybindings ("Composer: Dictate").

- Speech recognition runs on the server's machine: Parakeet TDT 0.6b v3 through
  [transcribe.cpp](https://github.com/handy-computer/transcribe.cpp) (`transcribe-cpp` npm
  package). Nothing is downloaded; the `.gguf` model Scrawl
  (`%LOCALAPPDATA%\Scrawl\models`) or Hex (`%APPDATA%\voice-control\models`) installed is used.
  `T3CODE_DICTATION_MODEL=<path to .gguf>` picks another one.
- The model (~1.1 GB) loads on the first chunk of a recording and is let go after 15 minutes
  without one.
- Structuring calls `claude --print --model haiku` on the server; it needs a logged-in
  Claude Code. The instructions are built in; a file at `<T3 home>/dictation/structure-prompt.md`
  replaces them and is read on every rewrite.
- The browser only hands out the microphone on https:// or localhost, so a web client on a
  plain `http://<LAN IP>` cannot dictate. Mobile keeps its own on-device dictation.
- Code: `apps/server/src/dictation/`, `apps/web/src/dictation/`,
  `apps/web/src/components/chat/ComposerDictationButton.tsx`, `packages/contracts/src/dictation.ts`.
  The standalone app for every other program is [collissimo/t3-voice](https://github.com/collissimo/t3-voice);
  it leaves F9 to T3 Code while T3 Code is in front.
