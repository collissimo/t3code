#!/usr/bin/env bash
# Release notes of a fork build: the notes of every upstream nightly since the previous fork
# release, then the fork's own changes since the commit that release built. The app's update
# popup and the GitHub release page both show this body. A trailing HTML comment, invisible in
# both, records what was built for fork-release.yml and the watcher.
#
# Env: REPO (owner/name), TARGET (fork commit), UPSTREAM_TAG, UPSTREAM_SHA, PREVIOUS_TAG (the
# fork's latest release before this one, may be empty).
set -euo pipefail

# Only the bullet list of a GitHub "What's Changed" body; the app stops reading at
# "New Contributors" and "Full Changelog", so neither may appear before the fork's list.
changes() {
  sed -e '/^## New Contributors/,$d' -e '/^\*\*Full Changelog\*\*/,$d' | grep -E '^[*-] ' || true
}

previous_upstream=""
previous_fork=""
if [[ -n "$PREVIOUS_TAG" ]]; then
  previous_body=$(gh release view "$PREVIOUS_TAG" --repo "$REPO" --json body --jq .body)
  previous_upstream=$(grep -oE 'upstream-tag=[^ ]+|builds of upstream [^ ]+' <<<"$previous_body" | head -n 1 | sed -E 's/.*[= ]//' || true)
  previous_fork=$(grep -oE 'fork=[0-9a-f]+|Fork: [0-9a-f]+' <<<"$previous_body" | head -n 1 | sed -E 's/.*[= ]//' || true)
fi

# Upstream nightlies after the previous build's, up to this build's, oldest first: the app
# shows the last items of a body first, so the newest nightly sits right above the fork's list.
nightlies=$(gh release list --repo pingdotgg/t3code --limit 50 --exclude-drafts --json tagName,publishedAt \
  --jq "[.[] | select(.tagName | contains(\"-nightly.\"))] | sort_by(.publishedAt) | map(.tagName)
    | (index(\"$UPSTREAM_TAG\")) as \$to | (index(\"$previous_upstream\") // ((\$to // 0) - 1)) as \$from
    | if \$to == null then [\"$UPSTREAM_TAG\"] else .[(\$from + 1):(\$to + 1)] end | .[]")

upstream_changes=""
for nightly in $nightlies; do
  upstream_changes+=$(gh release view "$nightly" --repo pingdotgg/t3code --json body --jq .body | changes)
  upstream_changes+=$'\n'
done

# Between the built commits, not the release tags: a tag lands on the branch head at publish
# time, which can already hold changes the build did not. First-parent commits of collin/main
# are its pull request merges, direct commits and upstream syncs; the syncs are left out.
fork_changes=""
if [[ -n "$previous_fork" ]]; then
  git_dir=$(mktemp -d)
  git -C "$git_dir" init -q
  git -C "$git_dir" fetch -q --filter=tree:0 --no-tags "https://github.com/$REPO.git" "$TARGET" "$previous_fork"
  while read -r commit; do
    subject=$(git -C "$git_dir" log -1 --format=%s "$commit")
    if [[ "$subject" =~ ^Merge\ pull\ request\ \#([0-9]+) ]]; then
      title=$(git -C "$git_dir" log -1 --format=%b "$commit" | head -n 1)
      fork_changes+="* ${title:-$subject} in https://github.com/$REPO/pull/${BASH_REMATCH[1]}"$'\n'
    elif [[ $(git -C "$git_dir" rev-list --parents -n 1 "$commit" | wc -w) -eq 2 ]]; then
      fork_changes+="* $subject"$'\n'
    fi
  done < <(git -C "$git_dir" rev-list --first-parent --reverse "$previous_fork..$TARGET")
  rm -rf "$git_dir"
fi

if [[ -n "${upstream_changes//[[:space:]]/}" ]]; then
  printf '## T3 Code\n%s\n' "$upstream_changes"
fi
if [[ -n "$fork_changes" ]]; then
  printf '## Fork\n%s\n' "$fork_changes"
fi
printf '<!-- fork-release fork=%s upstream=%s upstream-tag=%s -->\n' "$TARGET" "$UPSTREAM_SHA" "$UPSTREAM_TAG"
