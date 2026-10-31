#!/usr/bin/env bash
# Makes the checked-out fork build typecheck: resolves the conflicts of an in-progress `git merge`
# with Claude Code, typechecks, lets Claude fix what the typecheck reports, then commits.
# fork-release.yml runs it on every build (merge started with --no-commit, or nothing to merge);
# the result only feeds that build, collin/main itself is still synced by hand or by the daily T3
# task. Needs vp, and for Claude the claude CLI and ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN.
# Exit 1 = not buildable, nothing committed.
set -euo pipefail

mapfile -t files < <(git diff --name-only --diff-filter=U)
# `vp install` rewrites the lockfile: upstream's when it conflicts, plus what the fork's
# package.json files add.
fixable=(pnpm-lock.yaml)

# Everything outside the files Claude may edit must stay exactly as the merge left it.
excludes=()
for file in "${files[@]}" "${fixable[@]}"; do excludes+=(":(exclude,literal)$file"); done
outside() { git status --porcelain --untracked-files=all -- . "${excludes[@]}"; }
before=$(outside)

# Files Claude may edit later drop out of `outside`, so they drop out of the snapshot as well.
check_outside() {
  local expected
  expected=$(awk 'NR == FNR { allowed[$0]; next } !(substr($0, 4) in allowed)' \
    <(printf '%s\n' "${files[@]}" "${fixable[@]}") <(echo "$before"))
  if [[ "$(outside)" != "$expected" ]]; then
    echo "::error::Claude changed files it was not given:"
    diff <(echo "$expected") <(outside) || true
    exit 1
  fi
}

claude_run() {
  if [[ -n "${GITHUB_ACTIONS:-}" && -z "${ANTHROPIC_API_KEY:-}${CLAUDE_CODE_OAUTH_TOKEN:-}" ]]; then
    echo "::error::this build needs Claude, but neither ANTHROPIC_API_KEY nor CLAUDE_CODE_OAUTH_TOKEN is set; sync collin/main by hand"
    exit 1
  fi
  claude -p "$1" \
    --model "${CLAUDE_MODEL:-opus}" \
    --max-budget-usd "${CLAUDE_MAX_BUDGET_USD:-5}" \
    --allowedTools Read Grep Glob Edit \
    "Bash(git diff:*)" "Bash(git log:*)" "Bash(git show:*)" "Bash(git status:*)" "Bash(git rm:*)"
}

claude_files=()
for file in "${files[@]}"; do
  if [[ "$file" == pnpm-lock.yaml ]]; then
    git checkout -q --theirs -- pnpm-lock.yaml
  else
    claude_files+=("$file")
  fi
done

if [[ ${#claude_files[@]} -gt 0 ]]; then
  list=$(printf -- '- %s\n' "${claude_files[@]}")
  claude_run "This repository is a personal fork of pingdotgg/t3code (see FORK.md): the fork's own features
on top of upstream. A \`git merge\` of a new upstream commit into the fork stopped with conflicts in:

$list
Resolve every conflict so the result keeps upstream's new behavior AND the fork's features. Read
both sides, and the commits that touched the lines (git log -p / git show, :2:<path> is the fork,
:3:<path> upstream), so you understand what each side meant. Adapt the fork's code to upstream's
renames and API changes rather than reverting them.

Only edit the files listed above, and remove every conflict marker in them. For a modify/delete
conflict, keep the file if the fork still needs it, otherwise delete it with git rm. Do not stage,
commit, check out, or touch any other file. If you cannot tell what one side intended, leave that
conflict's markers in place and say why; an unresolved file is better than a wrong guess.

End with one line per file: the file, and how you resolved it."
  check_outside
fi

unresolved=()
for file in "${files[@]}"; do
  if [[ -f "$file" ]] && grep -qE '^(<<<<<<<|\|\|\|\|\|\|\||>>>>>>>)( |$)' "$file"; then
    unresolved+=("$file")
  fi
done
if [[ ${#unresolved[@]} -gt 0 ]]; then
  printf '::error::still conflicted: %s\n' "${unresolved[@]}"
  exit 1
fi

# Without the repository's commit hooks: they would lint the whole merge on the commit below.
VP_GIT_HOOKS=0 vp install

# A clean textual merge can still break the build: one side calls what the other renamed or
# stopped importing, in a file git merged without a conflict. And collin/main itself may not
# typecheck. Claude fixes what the typecheck reports, in the files it names. Same apps as the
# desktop build bundles.
broken=()
# The tracked files a typecheck log blames, from the repository root. tsc paths are relative to the
# app, and the layout depends on the tool and on whether it prints to a terminal:
# src/x.ts(12,5): error TS... or src/x.ts:12:5 - error TS...
# A layout nothing here knows must still reach Claude, so any path on an error line counts.
blamed_files() {
  local app=$1 log_file=$2 text paths path
  text=$(sed 's/\x1b\[[0-9;]*m//g' "$log_file")
  paths=$(grep -oE '^[^ :(]+\.[cm]?tsx?(\([0-9]+,[0-9]+\):|:[0-9]+:[0-9]+ -) error' <<<"$text" |
    sed -E 's/[(:].*$//' || true)
  if [[ -z "$paths" ]]; then
    paths=$(grep -E 'error TS[0-9]+' <<<"$text" | grep -oE '[^ :(]+\.[cm]?tsx?' || true)
  fi
  for path in $(sort -u <<<"$paths"); do
    path=$(realpath -m --relative-to=. "apps/$app/$path")
    if git ls-files --error-unmatch -- "$path" > /dev/null 2>&1; then
      echo "$path"
    fi
  done
}

typecheck() {
  local app status=0
  broken=()
  : > "$log"
  for app in server desktop web; do
    if ! (cd "apps/$app" && vp run typecheck) > "$log.$app" 2>&1; then
      status=1
      mapfile -t -O "${#broken[@]}" broken < <(blamed_files "$app" "$log.$app")
    fi
    cat "$log.$app" >> "$log"
  done
  return $status
}

if git rev-parse -q --verify MERGE_HEAD > /dev/null; then
  sides="A \`git merge\` of a new upstream commit into the fork is in progress (HEAD is the fork,
MERGE_HEAD upstream); its conflicts are resolved,"
else
  sides="The fork's branch (HEAD)"
fi
log="${RUNNER_TEMP:-/tmp}/resolve-typecheck.log"
for round in 1 2; do
  if typecheck; then
    break
  fi
  if [[ ${#broken[@]} -eq 0 ]]; then
    echo "::error::typecheck failed without naming a file"
    cat "$log"
    exit 1
  fi
  fixable+=("${broken[@]}")
  for file in "${broken[@]}"; do excludes+=(":(exclude,literal)$file"); done
  echo "Typecheck round $round failed in: ${broken[*]}"
  claude_run "This repository is a personal fork of pingdotgg/t3code (see FORK.md): the fork's own features
on top of upstream. $sides but the result does not typecheck.
Typical cause: one side renamed, moved, or stopped importing something the other side's new code
still uses, in a file git merged without a conflict. Read both sides and git log -p to see why each
changed, and fix each error so upstream's new behavior and the fork's features both stay. Where
the fork deliberately replaced a helper, new upstream code should use the fork's replacement. Do
not silence errors with casts, any, or ts-ignore, and do not delete a feature to make it compile.

Only edit these files: $(printf '%s ' "${broken[@]}")
Do not stage, commit, or check out anything. Do not run the typecheck; this script runs it again
after you finish.

The typecheck output:

$(tail -c 60000 "$log")"
  check_outside
done
if ! typecheck; then
  echo "::error::the build still does not typecheck"
  cat "$log"
  exit 1
fi

# git rm already staged a deleted conflict file, and git add refuses a path that is gone.
for file in "${files[@]}" "${fixable[@]}"; do
  if [[ -e "$file" ]] || git ls-files --error-unmatch -- "$file" > /dev/null 2>&1; then
    git add -A -- "$file"
  fi
done
if git rev-parse -q --verify MERGE_HEAD > /dev/null; then
  git commit -q --no-edit
elif ! git diff --cached --quiet; then
  git commit -q -m "Fix type errors for the build"
fi
echo "Build commit: $(git rev-parse HEAD)"
