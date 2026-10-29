#!/usr/bin/env bash
# Resolves the conflicts of an in-progress `git merge` with Claude Code, then commits the merge.
# fork-release.yml runs it when upstream no longer merges cleanly into collin/main; the result only
# feeds that build, collin/main itself is still synced by hand or by the daily T3 task.
# Needs the claude CLI, vp, and ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN.
# Exit 1 = not resolved, nothing committed.
set -euo pipefail

mapfile -t files < <(git diff --name-only --diff-filter=U)
if [[ ${#files[@]} -eq 0 ]]; then
  echo "no merge conflicts to resolve" >&2
  exit 1
fi

# Everything outside the files Claude may edit must stay exactly as the merge left it.
excludes=()
for file in "${files[@]}"; do excludes+=(":(exclude,literal)$file"); done
outside() { git status --porcelain --untracked-files=all -- . "${excludes[@]}"; }
before=$(outside)

# A lockfile is regenerated, not merged by hand: upstream's, plus what the fork's package.json
# files add, which `vp install` writes back.
claude_files=()
for file in "${files[@]}"; do
  if [[ "$file" == pnpm-lock.yaml ]]; then
    git checkout -q --theirs -- pnpm-lock.yaml
  else
    claude_files+=("$file")
  fi
done

fixable=()
claude_run() {
  claude -p "$1" \
    --model "${CLAUDE_MODEL:-opus}" \
    --max-budget-usd "${CLAUDE_MAX_BUDGET_USD:-5}" \
    --allowedTools Read Grep Glob Edit \
    "Bash(git diff:*)" "Bash(git log:*)" "Bash(git show:*)" "Bash(git status:*)" "Bash(git rm:*)"
}

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
fi

check_outside
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
# stopped importing, in a file git merged without a conflict. The typecheck job would only stop
# the release, so Claude fixes what it reports, in whichever files it names. Same apps as that job.
broken=()
typecheck() {
  local app status=0
  broken=()
  : > "$log"
  for app in server desktop web; do
    if ! (cd "apps/$app" && vp run typecheck) > "$log.$app" 2>&1; then
      status=1
      # tsc prints paths relative to the app: src/x.ts:12:5 - error TS...
      mapfile -t -O "${#broken[@]}" broken < <(sed 's/\x1b\[[0-9;]*m//g' "$log.$app" |
        grep -oE '^[^ :(]+\.[cm]?tsx?:[0-9]+:[0-9]+ - error' |
        cut -d: -f1 | sort -u | sed "s|^|apps/$app/|")
    fi
    cat "$log.$app" >> "$log"
  done
  return $status
}

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
  claude_run "This repository is a personal fork of pingdotgg/t3code (see FORK.md). A \`git merge\` of a new
upstream commit into the fork has had its conflicts resolved, but the result does not typecheck.
Typical cause: one side renamed, moved, or stopped importing something the other side's new code
still uses, in a file git merged without a conflict. Compare both sides (git show HEAD:<path> is the
fork, MERGE_HEAD:<path> upstream, git log -p to see why each changed) and fix each error so both
upstream's new behavior and the fork's features stay. Do not silence errors with casts, any, or
ts-ignore, and do not delete either side's feature to make it compile.

Only edit these files: $(printf '%s ' "${broken[@]}")
Do not stage, commit, or check out anything. Do not run the typecheck; this script runs it again
after you finish.

The typecheck output:

$(tail -c 60000 "$log")"
  check_outside
done
if ! typecheck; then
  echo "::error::the resolved merge still does not typecheck"
  cat "$log"
  exit 1
fi

git add -A -- "${files[@]}" "${fixable[@]}"
git commit -q --no-edit
echo "Resolved ${#files[@]} conflicted file(s): $(git rev-parse HEAD)"
