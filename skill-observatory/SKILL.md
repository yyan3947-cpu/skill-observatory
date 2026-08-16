---
name: skill-observatory
description: Discover, verify, classify, visualize, and recommend locally installed Codex Skills. Use when the user asks to inventory installed Skills, check readiness, find a Skill for a task, open or synchronize the private Skill dashboard, or—after local matching fails—search GitHub for validated Skill candidates.
---

# Skill Observatory

Manage the private local Skill catalog through deterministic bundled scripts. Resolve every script from this Skill directory; never assume the current working directory or a source-repository path.

## Choose the operation

1. Run setup before the first start or after installing a new release:
   - Run `node scripts/setup.mjs --dry-run` first.
   - Explain the reported filesystem and dependency actions.
   - Obtain explicit approval before running `node scripts/setup.mjs` because it writes private state, runs `npm ci`, and installs the bundled `skill-radar`.
   - Add `--migrate-from "/absolute/legacy/state"` only when the user asks to preserve an earlier catalog. Private matching rules are separate: when present, also add `--migrate-overrides-from "/absolute/legacy/data/skill-overrides.json"`. Keep both sources unchanged.
2. Run `node scripts/start.mjs` to synchronize, start the loopback-only API and dashboard, and open the page.
3. Run `node scripts/sync.mjs` to refresh the catalog without opening the dashboard. Forward `--full` only when a full history rebuild is needed.
4. Run `node scripts/verify.mjs` for static and test verification. Add `--live` only when the dashboard is already running and the user wants live API/UI checks.
5. Run `node scripts/install-launcher.mjs --target "/absolute/directory"` only after the user explicitly requests a macOS launcher. Do not overwrite an existing launcher unless the user approves `--replace`.

## Match and discover Skills

Prefer the synchronized local matcher. Preserve status labels such as `可用`, `需配置`, `异常`, and `待检查` when reporting results.

When local matching returns no qualified result, show the GitHub search preview and wait for explicit user action before making the external request. Send only the displayed capability keywords. Treat repository Stars as repository-level metadata, not a Skill rating.

Return at most three structurally validated candidates with their repository, Skill subpath, Stars, update time, and source link. Never install, update, or execute a suggested third-party Skill automatically. Ask separately before any later installation.

## Safety boundaries

- Keep runtime state under `$CODEX_HOME/state/skill-observatory/`, or `~/.codex/state/skill-observatory/` when `CODEX_HOME` is unset. Accept only an absolute `SKILL_OBSERVATORY_DATA_DIR` override.
- Keep the service on `127.0.0.1`; do not expose it to the LAN or deploy it publicly.
- Never install Node.js, npm, Homebrew, GitHub CLI, or other system packages.
- Never read browser Cookies or persist `GITHUB_TOKEN`. Use an explicitly supplied token only from the server process environment.
- Preserve existing state and a customized `skill-radar` when a conflict is reported.
- Treat malformed, non-private, linked, or special-file private overrides as a blocking setup/sync error; never silently discard them.

Read [references/operations.md](references/operations.md) for exact commands, migration details, launcher behavior, and troubleshooting.
