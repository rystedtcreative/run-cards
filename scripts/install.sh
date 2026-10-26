#!/usr/bin/env bash
# Install or update run-cards: a stable checkout of `main` plus a
# $BIN_DIR/run-cards symlink. Safe to re-run (idempotent).
# Deliberately never creates `grok` / `claude` alias symlinks; see the README if you want those.
set -euo pipefail

REPO="${CLI_RUN_CARDS_REPO:-https://github.com/rystedtcreative/run-cards.git}"
SRC="${CLI_RUN_CARDS_SRC:-$HOME/src/run-cards}"
BIN_DIR="${CLI_RUN_CARDS_BIN_DIR:-$HOME/.local/bin}"
BRANCH=main

case "${DRY_RUN:-0}" in
  1 | true | yes) DRY_RUN=1 ;;
  *) DRY_RUN=0 ;;
esac

usage() {
  cat <<EOF
Usage: scripts/install.sh [--dry-run] [--help]

Clones (or fast-forwards) a stable checkout of run-cards on branch ${BRANCH}, then
symlinks run-cards into a bin dir. Never creates grok/claude symlinks.

Options:
  -n, --dry-run   print the commands that would run, execute nothing (same as DRY_RUN=1)
  -h, --help      show this help

Environment:
  CLI_RUN_CARDS_REPO     git URL      (default https://github.com/rystedtcreative/run-cards.git)
  CLI_RUN_CARDS_SRC      checkout dir (default \$HOME/src/run-cards)
  CLI_RUN_CARDS_BIN_DIR  symlink dir  (default \$HOME/.local/bin)
EOF
}

for arg in "$@"; do
  case "$arg" in
    -n | --dry-run) DRY_RUN=1 ;;
    -h | --help)
      usage
      exit 0
      ;;
    *)
      echo "install: unknown argument: $arg" >&2
      usage >&2
      exit 2
      ;;
  esac
done

# Print each command (shell-quoted); run it unless dry-running.
run() {
  printf '+'
  printf ' %q' "$@"
  printf '\n'
  if [[ "$DRY_RUN" != 1 ]]; then "$@"; fi
}

if [[ -d "$SRC/.git" ]]; then
  run git -C "$SRC" fetch origin
  run git -C "$SRC" checkout "$BRANCH"
  run git -C "$SRC" pull --ff-only origin "$BRANCH"
elif [[ -e "$SRC" && -n "$(ls -A "$SRC" 2>/dev/null)" ]]; then
  echo "install: $SRC exists but is not a git checkout; refusing to touch it" >&2
  exit 1
else
  run mkdir -p "$(dirname "$SRC")"
  run git clone --branch "$BRANCH" "$REPO" "$SRC"
fi

run mkdir -p "$BIN_DIR"
run ln -sfn "$SRC/bin/run-cards" "$BIN_DIR/run-cards"

if [[ "$DRY_RUN" == 1 ]]; then
  echo "install: dry run, nothing changed"
else
  "$BIN_DIR/run-cards" --version
  case ":$PATH:" in
    *":$BIN_DIR:"*) ;;
    *) echo "install: note: $BIN_DIR is not on PATH" >&2 ;;
  esac
fi
