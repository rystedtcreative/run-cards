# Install

[← Back to the README](../README.md)

## Requirements

- Node.js ≥ 18.17 (tested on 20.x)
- The real CLI installed, e.g. `grok` at `~/.grok/bin/grok` and/or `claude` (Claude Code ≥ 2.1)

## Install

### Manually

```bash
git clone https://github.com/rystedtcreative/run-cards.git ~/src/run-cards
cd ~/src/run-cards
npm test            # optional, no deps to install
```

Then put `run-cards` on your PATH using **one** of these:

```bash
# a) symlink into a dir already on PATH
ln -s ~/src/run-cards/bin/run-cards ~/.local/bin/run-cards

# b) add the repo's bin/ to PATH (~/.bashrc / ~/.zshrc)
export PATH="$HOME/src/run-cards/bin:$PATH"

# c) npm link (creates the global `run-cards` bin)
npm link
```

Check it:

```bash
run-cards --help
run-cards grok --version     # runs the real grok, writes two cards
run-cards claude --version   # runs the real claude, writes two cards
```

### Optional: transparent `grok` / `claude` aliases

If the wrapper is invoked through a symlink named after an adapter, it behaves like `run-cards <adapter>`:

```bash
ln -s ~/src/run-cards/bin/run-cards ~/.local/bin/grok     # must come BEFORE ~/.grok/bin on PATH
ln -s ~/src/run-cards/bin/run-cards ~/.local/bin/claude   # must come BEFORE the real claude on PATH
grok -p "fix the bug"        # == run-cards grok -p "fix the bug"
claude -p "fix the bug"      # == run-cards claude -p "fix the bug"
```

Binary discovery always skips the wrapper itself, so it finds the real binary further down PATH. It skips both the symlink (by realpath) and any shim script that contains the marker `cli-run-cards:wrapper` in its first 4 KiB. If discovery gets confused, set `GROK_BIN` / `CLAUDE_BIN`.

### With `scripts/install.sh`

```bash
scripts/install.sh --dry-run     # print the commands, change nothing (same as DRY_RUN=1)
scripts/install.sh
```

It keeps a stable checkout of `main` and links the wrapper onto PATH:

1. clones `$CLI_RUN_CARDS_REPO` into `$CLI_RUN_CARDS_SRC` if it's missing, otherwise `git fetch`, `git checkout main`, `git pull --ff-only` (refuses to touch a non-empty `$CLI_RUN_CARDS_SRC` that isn't a git checkout)
2. `mkdir -p "$CLI_RUN_CARDS_BIN_DIR"` and `ln -sfn "$CLI_RUN_CARDS_SRC/bin/run-cards" "$CLI_RUN_CARDS_BIN_DIR/run-cards"`
3. verifies with `run-cards --version` (skipped in dry-run)

| Variable | Default |
|----------|---------|
| `CLI_RUN_CARDS_REPO` | `https://github.com/rystedtcreative/run-cards.git` |
| `CLI_RUN_CARDS_SRC` | `$HOME/src/run-cards` |
| `CLI_RUN_CARDS_BIN_DIR` | `$HOME/.local/bin` |

It's idempotent, so re-run it to update. It **never** creates `grok` / `claude` alias symlinks; add those by hand if you want them (see below).
