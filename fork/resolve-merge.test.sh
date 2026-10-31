#!/usr/bin/env bash
# Runs fork/resolve-merge.sh against throwaway repositories with stubbed vp and claude. Its repair
# path only runs when a release is already broken, so a regression there stays silent until then.
set -euo pipefail

script=$(realpath "$(dirname "$0")/resolve-merge.sh")
root=$(mktemp -d)
trap 'rm -rf "$root"' EXIT
failed=0

mkdir "$root/bin"
# Reports whatever $TSC_LINE says while the file it names (relative to the app) holds BROKEN.
cat > "$root/bin/vp" <<'STUB'
#!/usr/bin/env bash
[[ "$1" == run && "$(basename "$PWD")" == server ]] || exit 0
if grep -rqs BROKEN src ../../packages; then
  printf '~/apps/server$ tsc --noEmit\n%b\n' "$TSC_LINE"
  exit 2
fi
STUB
cat > "$root/bin/claude" <<'STUB'
#!/usr/bin/env bash
for file in $(git diff --name-only --diff-filter=U); do git rm -q -f -- "$file"; done
grep -rl BROKEN apps packages | xargs -r sed -i 's/BROKEN/fixed/'
STUB
chmod +x "$root/bin/vp" "$root/bin/claude"
export PATH="$root/bin:$PATH" CLAUDE_CODE_OAUTH_TOKEN=test

new_repo() {
  git init -q -b base "$1"
  git -C "$1" config user.name test
  git -C "$1" config user.email test@example.com
  mkdir -p "$1"/apps/{server,desktop,web}/src "$1/packages/shared/src"
  touch "$1/pnpm-lock.yaml" "$1"/apps/{server,desktop,web}/src/keep.ts
}

report() {
  if [[ "$2" == 0 ]]; then
    echo "ok: $1"
  else
    echo "FAILED: $1"
    cat "$root/output" || true
    failed=1
  fi
}

check_repair() {
  local name=$1 path=$2 line=$3 repo status=0
  repo="$root/repo$RANDOM"
  new_repo "$repo"
  echo "const x = BROKEN;" > "$repo/$path"
  git -C "$repo" add -A
  git -C "$repo" commit -qm base
  (cd "$repo" && RUNNER_TEMP="$root" TSC_LINE="$line" bash "$script") > "$root/output" 2>&1 || status=1
  if [[ $status == 0 && "$(git -C "$repo" show "HEAD:$path")" != "const x = fixed;" ]]; then
    status=1
  fi
  grep -qxF "Typecheck round 1 failed in: $path" "$root/output" || status=1
  report "$name" "$status"
}

# Names a second file, so only the path at the start of the line may count.
error="error TS2304: Cannot find name 'BROKEN' from src/keep.ts."
check_repair "parenthesized errors reach Claude" apps/server/src/a.ts "src/a.ts(1,11): $error"
check_repair "pretty errors reach Claude" apps/server/src/a.ts "\033[96msrc/a.ts\033[0m:1:11 - $error"
check_repair "errors in a package reach Claude" packages/shared/src/a.ts "../../packages/shared/src/a.ts(1,11): $error"
check_repair "an unknown layout still reaches Claude" apps/server/src/a.ts "error TS2304 in src/a.ts"

# A modify/delete conflict Claude settles with git rm must not break the commit.
repo="$root/deleted"
new_repo "$repo"
echo one > "$repo/apps/web/src/gone.ts"
git -C "$repo" add -A
git -C "$repo" commit -qm base
git -C "$repo" checkout -qb upstream
git -C "$repo" rm -q apps/web/src/gone.ts
git -C "$repo" commit -qm "upstream deletes"
git -C "$repo" checkout -q base
echo two > "$repo/apps/web/src/gone.ts"
git -C "$repo" commit -qam "fork edits"
git -C "$repo" merge -q --no-commit --no-ff upstream > /dev/null 2>&1 || true
status=0
(cd "$repo" && RUNNER_TEMP="$root" TSC_LINE="" bash "$script") > "$root/output" 2>&1 || status=1
if [[ $status == 0 && "$(git -C "$repo" rev-list --parents -n 1 HEAD | wc -w)" != 3 ]]; then
  status=1
fi
report "a conflict settled with git rm commits the merge" "$status"

exit "$failed"
