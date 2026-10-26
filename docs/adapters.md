# Adapters (adding another CLI)

[← Back to the README](../README.md)

Both adapters export the same interface (`src/adapters/grok.js`, `src/adapters/claude.js`):

```js
{
  id, displayName, implemented, binName, binEnv,
  findBinary({ env, selfPaths }) → '/abs/path/to/real/binary',
  parseArgs(args, { env })       → { model, effort, prompt, headless, outputFormat, subcommand },
  extractTokens(stdout, stderr)  → { input, output, total } | null,
  summaryText(stdout, stderr, { failed }) → string,
  detectOutcome(stdout, stderr)  → { status: 'cancelled'|'blocked'|null, reason, stopReason, edits, permissionDenials },
  workDir?(args)                 → dir the CLI works in, or null (Grok: --cwd); used for repo / branch / commit,
}
```

`detectOutcome` shares `src/outcome.js` (see [Cancelled and blocked runs](outcomes.md)). `extractTokens` / `summaryText` share `src/usage.js`, which understands Grok's `json` / `streaming-json` shapes and Claude's `json` / `stream-json` `result` line. To add another CLI, write an adapter with this shape, register it in `src/adapters/index.js`, add a theme in `src/cards/themes.js` and a logo in `assets/logos/`.
