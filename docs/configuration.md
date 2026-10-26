# Configuration

[← Back to the README](../README.md)

| Variable | Default | Purpose |
|----------|---------|---------|
| `CLI_RUN_CARDS_DIR` | `~/.cli-run-cards` | Root directory for `runs/` and `latest.json` |
| `CLI_RUN_CARDS_RUN_ID` | generated | Run dir name under `runs/`; see [Choosing the run id](cards.md#choosing-the-run-id). Invalid or existing → exit 2, CLI not started |
| `CLI_RUN_CARDS_DISABLED` | unset | `1` = escape hatch: plain passthrough, no cards, no files, no path lines |
| `CLI_RUN_CARDS_QUIET` | unset | `1` = don't print the `run-cards: open-card/open-md/close-card/close-md/run-json` path lines |
| `CLI_RUN_CARDS_TIMEOUT_MS` | `3600000` headless; none interactive | Kill the CLI after N ms → TIMED OUT card, exit 124. `0` disables |
| `CLI_RUN_CARDS_KILL_GRACE_MS` | `5000` | Time between SIGTERM and SIGKILL on timeout |
| `CLI_RUN_CARDS_SUMMARY_LINES` | `12` | Output lines on the closing card |
| `CLI_RUN_CARDS_VERBOSE` | unset | Deprecated, no effect (paths are announced by default) |
| `GROK_BIN` | discovered | Path to the real `grok` (else first `grok` on PATH that isn't this wrapper) |
| `CLAUDE_BIN` | discovered | Path to the real `claude` (else first `claude` on PATH that isn't this wrapper) |
| `ANTHROPIC_MODEL` / `CLAUDE_CONFIG_DIR` | unset | Read (never set) by the Claude adapter to fill the Model / Effort rows when no flag is given |
