#!/usr/bin/env bash
# Release notes of a fork build: the notes of every upstream nightly since the previous fork
# release, then the fork's own pull requests since then. The app's update popup and the GitHub
# release page both show this body. A trailing HTML comment, invisible in both, records what was
# built for fork-release.yml and the watcher.
#
# Env: REPO (owner/name), TAG (new release tag), TARGET (fork commit), UPSTREAM_TAG,
# UPSTREAM_SHA, PREVIOUS_TAG (the fork's latest release before this one, may be empty).
set -euo pipefail

# Only the bullet list of a GitHub "What's Changed" body; the app stops reading at
# "New Contributors" and "Full Changelog", so neither may appear before the fork's list.
changes() {
  sed -e '/^## New Contributors/,$d' -e '/^\*\*Full Changelog\*\*/,$d' | grep -E '^[*-] ' || true
}

previous_upstream=""
if [[ -n "$PREVIOUS_TAG" ]]; then
  previous_body=$(gh release view "$PREVIOUS_TAG" --repo "$REPO" --json body --jq .body)
  previous_upstream=$(grep -oE 'upstream-tag=[^ ]+|builds of upstream [^ ]+' <<<"$previous_body" | head -n 1 | sed -E 's/.*[= ]//' || true)
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

fork_changes=""
if [[ -n "$PREVIOUS_TAG" ]]; then
  fork_changes=$(gh api "repos/$REPO/releases/generate-notes" -f tag_name="$TAG" \
    -f target_commitish="$TARGET" -f previous_tag_name="$PREVIOUS_TAG" --jq .body | changes)
fi

if [[ -n "${upstream_changes//[[:space:]]/}" ]]; then
  printf '## T3 Code\n%s\n' "$upstream_changes"
fi
if [[ -n "$fork_changes" ]]; then
  printf '## Fork\n%s\n\n' "$fork_changes"
fi
printf '<!-- fork-release fork=%s upstream=%s upstream-tag=%s -->\n' "$TARGET" "$UPSTREAM_SHA" "$UPSTREAM_TAG"
