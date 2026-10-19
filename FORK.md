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

```sh
git fetch upstream --tags
git switch main && git merge --ff-only upstream/main && git push origin main
git switch collin/main && git merge main     # resolve conflicts, run checks
git push origin collin/main
```

To sync only up to a nightly instead of upstream tip, merge the tag:
`git merge v0.1.1-nightly.YYYYMMDD.NNNN`.

Merge, not rebase: history stays stable, no force-push needed.

## Keeping changes mergeable

- Prefer additive changes: new files, new modules, settings/flags. Avoid editing
  hot upstream files (AGENTS.md, shared configs) when a separate file works.
- Keep edits to existing upstream files small and isolated.
- Sync often; small merges are easier than large ones.
