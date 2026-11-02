---
name: grok-build-and-claude-code
description: >-
  use this when a coding task should go to Grok Build or Claude Code: big tickets
  (many files, new features, refactors, more than a few minutes of work) run
  headless through run-cards, with the opening and closing cards posted in the
  chat; small edits are done directly
---
# Coding runs with Grok Build and Claude Code

Hand big coding work to a coding CLI, run it through `run-cards`, and post both run cards so the person in the chat can see what each run did and how it really ended.

## When to use a coding CLI
- **Big tickets go to a CLI.** Multi-file work (about 10 or more edits), a new feature, a refactor, or anything over about 5 minutes. The CLI keeps the large working context out of your own turns, and you stay responsive.
- **Small edits stay direct.** 1 or 2 files and a few focused changes: make them yourself with your own shell and edit tools. Each CLI run costs roughly 18k to 34k tokens just to start up, so it isn't worth it for small jobs.
- Read-only research (reading code, planning) doesn't need a CLI either.

## Which CLI
1. **Grok Build (`grok -p`) is the default** for big tickets: back end, APIs, scripts, tests, infrastructure.
2. **Claude Code (`claude -p`) is preferred for front-end work**: UI, CSS, layouts, components, templates and visual design.
3. If a ticket mixes both, use the CLI that fits most of the work, or split it into a back-end run and a front-end run.

Always run headless (`-p`). Don't drive a CLI through its interactive TUI or by screenshots unless the user asks for a live session.

## Steps
1. **Pick a run id** so you know where the cards will land before the run starts:
   ```bash
   RID=$(date +%Y%m%d-%H%M%S)-<your-bot-name>-$RANDOM
   ```
   The id must match `^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$` and its folder must not exist yet, or `run-cards` exits 2 without starting the CLI. Files go to `~/.cli-run-cards/runs/$RID/` (or `$CLI_RUN_CARDS_DIR/runs/$RID/`): `open.png`, `open.md`, `close.png`, `close.md`, `run.json`.
2. **Start the run in the background** with `run-cards` in front of the CLI. `grok` and `claude` are not wrapped automatically, so call `run-cards grok ...` or `run-cards claude ...` explicitly:
   ```bash
   # Grok Build (default). --always-approve lets a headless run edit files and run commands.
   CLI_RUN_CARDS_RUN_ID=$RID run-cards grok -p "<prompt>" --output-format json --always-approve

   # Claude Code (front end)
   CLI_RUN_CARDS_RUN_ID=$RID run-cards claude -p "<prompt>" --output-format json < /dev/null
   ```
   `--output-format json` puts token counts on the closing card. Add `-m <model> --effort <level>` (Grok) or `--model <model> --effort <level>` (Claude) to pick the model and effort for the run. For a long prompt, Grok also takes `--prompt-file <file>`. Everything after `grok` or `claude` is passed to the real CLI unchanged.
3. **Post the opening card as soon as it exists.** It is written before the CLI starts, and `run-cards` prints its path on stderr:
   ```
   run-cards: open-card <abs path>/open.png
   ```
   Attach `open.png` in the chat the task came from, with one short line such as "Starting a Grok Build run on `<repo>`." Don't end your turn here.
4. **Stay in the turn until the run finishes.** Keep checking the background command (and its output) until it exits, even if that takes a long time. If a wait times out, check again. Never end your turn between the two cards. When it ends, stderr has:
   ```
   run-cards: close-card <abs path>/close.png
   run-cards: close-md <abs path>/close.md
   run-cards: run-json <abs path>/run.json
   ```
   All path lines match `^run-cards: (open-card|open-md|close-card|close-md|run-json) /\S.*$`.
5. **Post the closing card** in the same chat: attach `close.png` with one result line (the status, plus what changed or what's next). In a text-only chat, paste the contents of `open.md` / `close.md` instead of the images. Never paste a path in place of a card.

## Reading the status honestly
The closing card shows one of: **PASSED**, **FAILED**, **TIMED OUT**, **CANCELLED**, **BLOCKED**.
- Only **PASSED** counts as passed. FAILED, TIMED OUT, CANCELLED and BLOCKED are not passes. Say so plainly.
- **CANCELLED** or **BLOCKED** means the CLI exited 0 but didn't finish the work (a cancelled turn, the max-turns limit, or a denied permission or approval). Use the card's `Why:` line, or `status` and `reason` in `run.json`, to say what stopped it.
- Fix the cause and rerun. For a Grok run that was blocked on approvals, rerun with `--always-approve` (or `--allow` rules).
- Exit code 124 means the run timed out (`CLI_RUN_CARDS_TIMEOUT_MS`, 1 hour by default for headless runs). The closing card is still written, so post it.
- Each rerun gets its own pair of cards. Post every pair.

## After a pass
A PASSED card only means the CLI finished cleanly. Before calling the ticket done:
1. Review the diff yourself (`git diff`, `git status`).
2. Run the project's tests yourself and confirm they pass.
3. Commit on a branch (`<branch>`) and open a pull request on `<repo>`. Don't push straight to `main`.

## Rules
- Cards show the prompt and the start of the output. Never put secrets in a prompt. `run-cards` masks common secrets, but if a card still shows one, don't post it; say so instead.
- Housekeeping commands (`--version`, `login`, `models`) don't need the wrapper.
- Don't set `CLI_RUN_CARDS_QUIET=1` (it hides the path lines) or `CLI_RUN_CARDS_DISABLED=1` (it turns cards off) unless the user asks.
- If `run-cards` itself fails (a card is missing, or it exits 2 on the run id), fix the id and retry once. If it still fails, run the CLI directly and tell the user the cards didn't work.

## Install
You need Node.js 18.17 or newer.

**run-cards** (from [rystedtcreative/run-cards](https://github.com/rystedtcreative/run-cards)):
```bash
git clone https://github.com/rystedtcreative/run-cards.git ~/src/run-cards
ln -s ~/src/run-cards/bin/run-cards ~/.local/bin/run-cards
run-cards --help
```
See the repo's [install docs](https://github.com/rystedtcreative/run-cards/blob/main/docs/install.md) for other options.

**Grok Build:** follow the official docs at [docs.x.ai/build/overview](https://docs.x.ai/build/overview). Check it with `grok --version`.

**Claude Code:** follow the official setup guide at [code.claude.com/docs/en/setup](https://code.claude.com/docs/en/setup). Check it with `claude --version`.

Sign in to each CLI the way its docs describe. Never ask the user to paste an API key or token into chat.

## Success
Big tickets went through `run-cards` with the right CLI (Grok Build by default, Claude Code for front end), small edits were made directly, both cards were posted for every run in the same turn, non-passing runs were reported honestly and fixed or rerun, and passing runs were reviewed and tested before a pull request was opened.
