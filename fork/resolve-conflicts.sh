#!/usr/bin/env bash
# Resolves the conflicts of an in-progress `git merge` with Claude Code, then commits the merge.
# fork-release.yml runs it when upstream no longer merges cleanly into collin/main; the result only
# feeds that build, collin/main itself is still synced by hand or by the daily T3 task.
# Needs the claude CLI and ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN.
# Exit 1 = not resolved, nothing committed.
set -euo pipefail

mapfile -t files < <(git diff --name-only --diff-filter=U)
if [[ ${#files[@]} -eq 0 ]]; then
  echo "no merge conflicts to resolve" >&2
  exit 1
fi

# Everything outside the conflicted files must stay exactly as the merge left it.
excludes=()
for file in "${files[@]}"; do excludes+=(":(exclude,literal)$file"); done
outside() { git status --porcelain --untracked-files=all -- . "${excludes[@]}"; }
before=$(outside)

list=$(printf -- '- %s\n' "${files[@]}")
prompt="This repository is a personal fork of pingdotgg/t3code (see FORK.md): the fork's own features
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

claude -p "$prompt" \
  --model "${CLAUDE_MODEL:-opus}" \
  --max-budget-usd "${CLAUDE_MAX_BUDGET_USD:-5}" \
  --allowedTools Read Grep Glob Edit \
  "Bash(git diff:*)" "Bash(git log:*)" "Bash(git show:*)" "Bash(git status:*)" "Bash(git rm:*)"

if [[ "$(outside)" != "$before" ]]; then
  echo "::error::Claude changed files outside the conflicts:"
  diff <(echo "$before") <(outside) || true
  exit 1
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

git add -A -- "${files[@]}"
git commit -q --no-edit
echo "Resolved ${#files[@]} conflicted file(s): $(git rev-parse HEAD)"
