# Secrets and data handling

[← Back to the README](../README.md)

Before anything lands on a card, in `run.json` or in `latest.json`, the wrapper masks:

- vendor keys: `sk-ant-…`, `sk-…`, `xai-…`, `ghp_/gho_/…`, `github_pat_…`, `glpat-…`, `xox?-…`, Stripe, `AIza…`, AWS `AKIA/ASIA…`, `npm_…`, `hf_…`
- JWTs, `Bearer/Basic/Token …` headers, `scheme://user:pass@host` credentials, PEM private key blocks
- `key=value` / `"key": "value"` where the key looks secret (`api_key`, `token`, `secret`, `password`, `credential`, `private_key`, `access_key`, `authorization`, …)
- long high-entropy blobs (hex SHAs are left alone)
- the literal value of any env var whose **name** contains KEY / TOKEN / SECRET / PASSWORD / CREDENTIAL / AUTH

**The live passthrough is never masked.** The bot sees exactly what the CLI printed. Masking only applies to the artifacts the wrapper creates.

Masking is best-effort. Prompts and output can still contain client data, so **treat the run directory as sensitive**: it's created `0700` with `0600` files and stays on the bot's machine. Don't post `run.json` to chat. Cards are designed to be shareable, but check them anyway.
