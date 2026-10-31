# Fork: collissimo/t3code

Personal fork of [pingdotgg/t3code](https://github.com/pingdotgg/t3code). Upstream is
(mostly) not accepting contributions, so changes live here long-term.

## Branches

- `main`: pristine mirror of `upstream/main`. Never commit here; fast-forward only.
- `collin/main`: `main` + own changes. Work branches start here, PRs target here.
- Upstream nightly builds are just `v*-nightly.*` tags on upstream `main`, not a separate repo.
  The fork publishes its own (see Desktop builds).

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

## Desktop builds

The installed app is a fork build, so the update button stays on the fork. The desktop app looks
for updates in the repository it was built in (`app-update.yml`, from `GITHUB_REPOSITORY`); an
official Nightly would update to upstream and lose the fork features.

`.github/workflows/fork-release.yml` runs when upstream publishes a nightly, on every push to
`collin/main`, every 6 hours as a fallback, and on dispatch. GitHub cannot notify a fork of
upstream releases and its cron fires hours late in a fork, so the Cloudflare Worker in
`fork/upstream-nightly-watcher/` checks every minute and sends one `repository_dispatch` per new
upstream nightly (a failed build is retried by the 6-hour cron, not redispatched).
A Worker failure is silent on Cloudflare, so the 6-hour run's `watchdog` job fails (and GitHub
mails the owner) when an upstream nightly over an hour old was never dispatched.

Each run merges the commit of upstream's newest nightly into `collin/main` for the build only, skips when the last release already has both commits, builds
Windows x64 (NSIS, `nightly.yml`) and Linux x64 (AppImage, `nightly-linux.yml`) side by side, and
publishes both in one prerelease `v<x.y.z>-nightly.<date>.<10000 + run>`. The version scheme is
upstream's (the offset sorts a fork build above an upstream nightly of the same day), so the app's
nightly channel takes it, and a fork client and fork server on the other OS stay on the same
version. `-f force=true` builds without new commits.

`vp pack` does not typecheck, so every build typechecks the merge first
(`fork/resolve-merge.sh`): Claude Code (Opus, at most $5 per call) resolves merge conflicts, then
gets up to two calls to fix whatever the typecheck reports, also in files git merged cleanly (one
side calls what the other renamed) or broken on `collin/main` itself. Fixes go into the build
only. It needs the repository secret `CLAUDE_CODE_OAUTH_TOKEN` (from `claude setup-token`; bills
the subscription's monthly Agent SDK credit) or `ANTHROPIC_API_KEY` (Console API credits; wins
when both are set). Each fork/upstream pair is checked once and cached, so retries cost nothing.
When Claude cannot make it typecheck, the run fails. The T3 scheduled task "Fork repair" looks for
a red `Fork release` or `Fork check` on `collin/main` every four hours, fixes the cause in a pull
request and merges it once `Fork check` is green; it needs the machine with T3 Code running. By
hand: sync `collin/main`, then `gh workflow run fork-release.yml` (`-f force=true` asks Claude
again instead).

Pull requests into `collin/main` and pushes to it run `.github/workflows/fork-check.yml` (frozen
install and the same typecheck). Upstream's CI needs Blacksmith runners a fork does not have; its
workflows are disabled in this repository (Actions settings), otherwise their checks stay queued.

Watcher setup (once, or after the token expires), from `fork/upstream-nightly-watcher/`:
`npx wrangler deploy`, then copy a fine-grained token for `collissimo/t3code` (Contents: read and
write, Actions: read) and run `Get-Clipboard | npx wrangler secret put GITHUB_TOKEN`. `npx wrangler tail` shows each
check.

- Every machine must run a fork build once (installed by hand); from then on the update button,
  including "update everything" for connected servers, stays on the fork. A desktop app on the
  other feed (an official build) is never offered a server update from a fork client: it could
  not reach the fork version.
- Unsigned (SmartScreen warns on the first Windows install; updates do not verify a publisher),
  without the WSL runtime upstream bundles into the Windows app.
- T3 Connect needs the public relay and Clerk values that upstream bakes in. They are repository
  variables here: `T3CODE_RELAY_URL`, `T3CODE_CLERK_PUBLISHABLE_KEY`, `T3CODE_CLERK_JWT_TEMPLATE`,
  `T3CODE_CLERK_CLI_OAUTH_CLIENT_ID`. Upstream's telemetry tokens are deliberately not copied.
- The tag sits on the `collin/main` commit. The release notes (`fork/release-notes.sh`) are
  upstream's notes for every nightly since the previous fork build, then the fork's pull
  requests and direct commits since the commit that build built; the update popup shows them. A hidden comment at the end records the fork
  and upstream commits, which the skip check, the watcher and the watchdog read.

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

- **Shift+F9** (or the arrow beside the mic) opens the history of everything dictated: Enter or
  the arrow button inserts an entry, a click shows it in full. A structured prompt keeps its plain
  transcript as the entry before it. The newest 10,000 stay in this client's IndexedDB.
- Dictated text starts with `[STT]`, once per prompt, so you and agents can tell it was spoken.
  Thread titles leave it out. The iPhone dictation does the same; the t3-voice app does not.
- Dictation expects German. The arrow beside the mic button switches the language
  (English, French, Spanish, Italian, Dutch, Polish). The choice is kept per client.
- The desktop app transcribes on its own computer, also for threads on a remote environment
  and with the local environment turned off: it starts `t3 dictation-worker` from the server
  package it ships, a process that only receives the audio and reads the model (no server,
  agents, files or terminals). A browser transcribes on the server it is served from. Both use
  [transcribe.cpp](https://github.com/handy-computer/transcribe.cpp) (`transcribe-cpp` npm
  package). Nothing is downloaded; the best `.gguf` found is used, from
  `~/.t3/dictation/models` (`$T3CODE_HOME/dictation/models`; not `--home-dir`), Scrawl (`%LOCALAPPDATA%\Scrawl\models`) or Hex
  (`%APPDATA%\voice-control\models`). Best first: Canary 1B v2, Parakeet TDT 0.6b v3, Cohere
  Transcribe 03-2026. On real German dictation all three get about 13% of the words wrong; Canary
  invents the least in thinking pauses.
  `T3CODE_DICTATION_MODEL=<path to .gguf>` picks one. Without Scrawl or Hex,
  `fork/install-parakeet.ps1` downloads Parakeet into Scrawl's folder; the others come from
  [huggingface.co/handy-computer](https://huggingface.co/handy-computer) (the `Q8_0` file).
- Thinking pauses never reach the speech model when `silero-vad-v6.2-F32.gguf` lies in one of
  those folders ([download](https://huggingface.co/handy-computer/silero-vad-v6.2-gguf)): only
  what Silero marks as speech is transcribed. Without it the log says so and pauses go through.
- It runs on the GPU when there is one (Vulkan; the log says `loaded … on Vulkan0`), about five
  times faster than the CPU. `T3CODE_DICTATION_BACKEND=cpu` keeps it on the CPU.
- Long recordings are transcribed in pieces of at most 35 seconds, cut at pauses.
- The model (1 to 2.5 GB) loads on the first chunk of a recording and is let go after 15
  minutes without one.
- Structuring calls `claude --print --model haiku` on the thread's server; it needs a logged-in
  Claude Code. The instructions are built in; a file at `<T3 home>/dictation/structure-prompt.md`
  replaces them and is read on every rewrite.
- The browser only hands out the microphone on https:// or localhost, so a web client on a
  plain `http://<LAN IP>` cannot dictate. Mobile keeps its own on-device dictation.
- Code: `apps/server/src/dictation/`, `apps/desktop/src/dictation/`, `apps/web/src/dictation/`,
  `apps/web/src/components/chat/ComposerDictationButton.tsx`, `packages/contracts/src/dictation.ts`.
  The standalone app for every other program is [collissimo/t3-voice](https://github.com/collissimo/t3-voice);
  it leaves F9 to T3 Code while T3 Code is in front.

### Screen capture (Scrawl, built in)

**Alt+Shift+S** anywhere, or the screen button in the composer, records the monitor under the
mouse, also while another program is in front. Talk, click, hold **Shift** and move the mouse to
draw red ink (it fades 5 seconds after Shift is let go). Alt+Shift+S again finishes: the text and
the contact sheet land in the composer on screen. Esc in T3 Code discards a capture.

- Desktop app only: a browser cannot see the whole screen, and mobile has no such thing. Clicks and
  ink need Windows; elsewhere a capture has voice and video.
- While the Scrawl app runs it holds Alt+Shift+S. T3 Code logs that and takes the shortcut within
  15 seconds of Scrawl closing. The composer button works either way.
- Speech and pointing do not run in step, so sentences are never cut at a click: whole sentences
  own a keyframe, click bursts fold into one (`clicked ×3`), and clicks the screen did not answer
  read as `pointed`. On 32 real captures this took cuts through sentences from 59 of 127 lines to 1.
- Uses the dictation model above, with word times mapped back across the pauses it cuts out.
- The recording pill in the corner shows in the video and keyframes; `setContentProtection` does
  not keep it out on Windows 10 22H2.
- Bundles are in `<T3 home>/scrawl/captures` in Scrawl's format, so the Scrawl skill and the
  `scrawl` CLI (`inspect`, `zoom`, `frames`) read them. Video and audio are deleted after 7 days.
- Code: `apps/desktop/src/scrawl/`, `apps/web/src/scrawl/`, `packages/contracts/src/scrawl.ts`.
