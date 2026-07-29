#!/bin/zsh

set -eu
export GIT_TERMINAL_PROMPT=0

SCRIPT_DIR="${0:A:h}"
REPO_DIR="${SCRIPT_DIR:h}"
LOCK_DIR="/tmp/crow-oracle-beacon-sync.lock"

if ! /bin/mkdir "$LOCK_DIR" 2>/dev/null; then
  exit 0
fi
trap '/bin/rmdir "$LOCK_DIR" 2>/dev/null || true' EXIT

if [[ -n "${NODE_BIN:-}" ]]; then
  node_bin="$NODE_BIN"
elif [[ -x "$HOME/.local/bin/node" ]]; then
  node_bin="$HOME/.local/bin/node"
elif [[ -x "/opt/homebrew/bin/node" ]]; then
  node_bin="/opt/homebrew/bin/node"
else
  node_bin="$(command -v node)"
fi

cd "$REPO_DIR"

if [[ -n "$(/usr/bin/git status --porcelain --untracked-files=no)" ]]; then
  print -u2 "beacon sync refused a dirty tracked worktree"
  exit 1
fi

/usr/bin/git fetch --quiet origin main
if ! /usr/bin/git rebase origin/main; then
  /usr/bin/git rebase --abort >/dev/null 2>&1 || true
  print -u2 "beacon sync could not fast-forward or rebase"
  exit 1
fi

"$node_bin" "$SCRIPT_DIR/update-oracle-beacon.mjs"

if ! /usr/bin/git diff --quiet -- oracle.json .well-known/crow-oracle.json; then
  /usr/bin/git add -- oracle.json .well-known/crow-oracle.json
  /usr/bin/git diff --cached --check
  /usr/bin/git \
    -c user.name="crow-oracle-beacon[bot]" \
    -c user.email="actions@users.noreply.github.com" \
    commit --quiet -m "Update Crow Oracle discovery beacon"
fi

if [[ "$(/usr/bin/git rev-list --count origin/main..HEAD)" -gt 0 ]]; then
  /usr/bin/git push --quiet origin HEAD:main
fi
