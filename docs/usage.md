# Usage

[← Back to the README](../README.md)

```bash
run-cards grok -p "fix the failing test in tests/api" -m grok-4.6 --effort high
run-cards grok -p "summarise the repo" --output-format json        # token usage shows on the close card
run-cards grok --prompt-file task.md --always-approve
echo "context" | run-cards grok -p "use stdin"                     # stdin is passed through

run-cards claude -p "fix the failing test in tests/api" --model claude-opus-5-5 --effort high
run-cards claude -p "summarise the repo" --output-format json      # token usage shows on the close card
run-cards claude -p -- "--looks-like-a-flag is part of the prompt"
git diff | run-cards claude -p "review this diff"                   # prompt + stdin context
```

For Claude Code, `-p/--print` is a **switch**, not a flag that takes the prompt: the prompt is the positional argument (`claude -p "fix it"`). Variadic flags such as `--add-dir`, `--allowedTools` or `--mcp-config` swallow the following words, exactly as `claude` itself does, so put the prompt first or after `--`.

Everything after the adapter name is passed to the real CLI verbatim. The wrapper has no flags of its own after `<adapter>`; it's configured only through env vars.

### Running headless (scripts, CI, bots)

```bash
run-cards grok   -p "<prompt>" --output-format json [-m <model>] [--effort <level>]
run-cards claude -p "<prompt>" --output-format json [--model <model>] [--effort low|medium|high|xhigh|max]
```

Structured output makes the CLI report token usage: Grok's `--output-format json` (or `streaming-json` / `streaming-messages-json`), Claude's `--output-format json` (or `stream-json`). The wrapper then puts in/out/total on the closing card (input includes cache reads/writes), and the output summary becomes the response text (`text` / `result`) instead of raw JSON. Plain output still works, but the card shows no token row.

### Exit codes

| Code | Meaning |
|------|---------|
| *CLI's own* | passed through unchanged (0 = card shows **PASSED**, or **CANCELLED** / **BLOCKED** when the run didn't finish, see [Cancelled and blocked runs](outcomes.md); else **FAILED**) |
| 124 | wrapper timeout fired, child killed (card shows **TIMED OUT**) |
| 128+n | child died from signal *n* (e.g. 143 = SIGTERM) |
| 127 | real binary not found / couldn't start |
| 2 | usage error (unknown adapter, no adapter given, invalid or already-used `CLI_RUN_CARDS_RUN_ID`); the CLI is not started |

## Interactive vs headless

When stdin and stdout are both a TTY and there's no headless flag (Grok: `-p`, `--prompt-file`, `--prompt-json`, `--output-format`, a subcommand; Claude: `-p/--print`, `--output-format`, a subcommand such as `mcp` or `doctor`), the wrapper hands the terminal straight to the CLI so the TUI works. Cards are still written, but output isn't captured, so the close card says so, and no timeout applies unless you set one. Bots run without a TTY, so they always get the captured, tee'd mode.

Signals: SIGTERM, SIGHUP and SIGINT sent to the wrapper are forwarded to the CLI, and the closing card is still written. In a TTY, Ctrl-C reaches the CLI directly through the process group.
