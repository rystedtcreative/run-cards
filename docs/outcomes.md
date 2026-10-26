# How BLOCKED and CANCELLED are detected

[← Back to the README](../README.md)

A headless run can exit 0 without having done the work. Example: Grok Build without `--always-approve` reaches a tool that needs approval, can't ask anyone, cancels the turn (`stopReason: "cancelled"`) and exits 0 after a few turns with nothing written. Those runs don't get **PASSED**:

| Status | Pill | When (exit 0 only) |
|--------|------|--------------------|
| `blocked` | orange **BLOCKED** | a permission / approval was denied or cancelled and no file edit got through: Claude `permission_denials` on an edit tool, a failed tool result such as "User cancelled the execution for tool …" or "Claude requested permissions to …, but you haven't granted it yet", an approval message on stderr; also a `refusal` stop reason |
| `cancelled` | grey **CANCELLED** | the turn stop reason is `cancelled` (Grok `json` `stopReason`, streaming `end.stopReason`, `result.stop_reason`), or the run stopped at the max-turns limit (`error_max_turns`, `max_turn_requests`, `max_turns_reached`) |

- The card's output then starts with `[run-cards] <status>: <reason>` (in `close.md` it's the `Why:` line), e.g. `stop reason "cancelled" (headless runs cancel when a tool needs approval)` or `… — no file edits`.
- File edits are counted when the output format shows tool calls (Grok `streaming-json` / `streaming-messages-json`, Claude `stream-json`): Grok `search_replace` / `write` and ACP `edit` / `delete` / `move` kinds, Claude `Edit` / `Write` / `MultiEdit` / `NotebookEdit`. Plain text and single-object `json` can't show edits, so `edits` is `null` there.
- Zero edits on its own does **not** change a pass (review and question prompts legitimately edit nothing); it only adds "no file edits" to a cancelled/blocked reason. A permission denial that didn't stop edits from landing also stays a pass.
- Non-zero exits stay **FAILED** and timeouts stay **TIMED OUT**. The wrapper's exit code is always the CLI's own, so scripts that check `$?` behave as before; check `run.json` `status` (or the card) to tell a real pass from a cancelled one.
- For Grok in headless mode, pass `--always-approve` (or `--allow` rules) when the run needs to edit files or run commands.
