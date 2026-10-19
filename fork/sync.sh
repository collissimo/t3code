#!/usr/bin/env sh
# Fork sync: main <- upstream/main (fast-forward), collin/main <- merge upstream/main.
# Merges with plumbing (merge-tree + commit-tree), so no working tree is touched and
# it can run from any checkout, including one with a dev server running.
# Exit 0 = synced or up to date, 1 = merge conflict (nothing pushed), other = error.
set -eu

FORK_BRANCH=${FORK_BRANCH:-collin/main}

git fetch --quiet --tags upstream
git fetch --quiet origin

up=$(git rev-parse upstream/main)

# Server rejects non-fast-forward, so a diverged main fails loudly instead of being clobbered.
git push --quiet origin "$up:refs/heads/main"
git fetch --quiet . "upstream/main:main" 2>/dev/null || echo "note: local main not updated (checked out or diverged)"

old=$(git rev-parse "origin/$FORK_BRANCH")
if git merge-base --is-ancestor "$up" "$old"; then
  echo "$FORK_BRANCH already contains upstream/main ($(git rev-parse --short "$up"))"
  new=$old
else
  if out=$(git merge-tree --write-tree --name-only --no-messages "$old" "$up"); then
    new=$(git commit-tree "$out" -p "$old" -p "$up" -m "Merge upstream/main into $FORK_BRANCH")
    git push --quiet origin "$new:refs/heads/$FORK_BRANCH"
    echo "merged upstream/main ($(git rev-parse --short "$up")) into $FORK_BRANCH ($(git rev-parse --short "$new"))"
  else
    echo "CONFLICT merging upstream/main into $FORK_BRANCH. Nothing pushed. Conflicted files:"
    printf '%s\n' "$out" | tail -n +2
    exit 1
  fi
fi

# Fast-forward the local branch wherever it lives, but never touch a dirty checkout.
wt=$(git worktree list --porcelain | awk -v b="branch refs/heads/$FORK_BRANCH" '/^worktree /{p=substr($0,10)} $0==b{print p}')
if [ -z "$wt" ]; then
  git fetch --quiet . "origin/$FORK_BRANCH:$FORK_BRANCH" 2>/dev/null || echo "note: local $FORK_BRANCH not updated (diverged)"
elif [ -n "$(git -C "$wt" status --porcelain --untracked-files=no)" ]; then
  echo "note: $wt has uncommitted changes; run 'git merge --ff-only origin/$FORK_BRANCH' there yourself"
elif ! git -C "$wt" merge --ff-only --quiet "origin/$FORK_BRANCH"; then
  echo "note: local $FORK_BRANCH in $wt has unpushed commits; push or merge them"
fi

if [ "$old" != "$new" ] && ! git diff --quiet "$old" "$new" -- pnpm-lock.yaml; then
  echo "note: pnpm-lock.yaml changed, run 'vp i' in your checkouts"
fi
